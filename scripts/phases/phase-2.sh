#!/usr/bin/env bash
# =============================================================================
#  paywifi-phase2-network.sh
#  PAYWIFI — Phase 2: Network plumbing
#    * /etc/network/interfaces  (WAN dhcp + LAN static)
#    * dnsmasq                  (DHCP + DNS for LAN clients)
#    * ipset                    (paywifi_auth allowlist, empty for now)
#    * nftables                 (NAT + forwarding; gating added in Phase 3)
#    * systemd ordering         (ipset -> nftables -> dnsmasq)
# =============================================================================
#  Usage:  sudo bash paywifi-phase2-network.sh
#  Prereq: paywifi-bootstrap.sh has been run successfully
# =============================================================================

set -o pipefail

CFG_FILE="/etc/paywifi/config.json"
APP_NAME="PAYWIFI"
IPSET_NAME="paywifi_auth"

# ----- Colours / helpers -----------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'
  C_BLD=$'\e[1m';  C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_BLD=""; C_RST=""
fi
info()  { echo "${C_BLU}[INFO]${C_RST}  $*"; }
ok()    { echo "${C_GRN}[ OK ]${C_RST}  $*"; }
warn()  { echo "${C_YLW}[WARN]${C_RST}  $*"; }
err()   { echo "${C_RED}[FAIL]${C_RST}  $*" >&2; }
hr()    { echo "${C_BLD}--------------------------------------------------------------------${C_RST}"; }
title() { hr; echo "${C_BLD} $* ${C_RST}"; hr; }
die()   { err "$*"; exit 1; }
confirm() {
  local prompt="$1" default="${2:-Y}" hint="[Y/n]" reply
  [[ "$default" == "N" ]] && hint="[y/N]"
  read -r -p "${C_YLW}?${C_RST} ${prompt} ${hint} " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ----- Preflight -------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
[[ -f "$CFG_FILE" ]] || die "Config not found at $CFG_FILE — run paywifi-bootstrap.sh first."

command -v jq        >/dev/null || die "jq missing — run phase 1 bootstrap."
command -v nft       >/dev/null || die "nftables missing — run phase 1 bootstrap."
command -v ipset     >/dev/null || die "ipset missing — run phase 1 bootstrap."
command -v dnsmasq   >/dev/null || die "dnsmasq missing — run phase 1 bootstrap."

# ----- Load config -----------------------------------------------------------
WAN_IFACE=$(jq -r '.network.wan_iface'   "$CFG_FILE")
LAN_IFACE=$(jq -r '.network.lan_iface'   "$CFG_FILE")
LAN_SUBNET=$(jq -r '.network.lan_subnet' "$CFG_FILE")
LAN_GW=$(jq -r '.network.lan_gateway'    "$CFG_FILE")
DHCP_START=$(jq -r '.network.dhcp_start' "$CFG_FILE")
DHCP_END=$(jq -r '.network.dhcp_end'     "$CFG_FILE")

# derive netmask from CIDR (assumes /24 by default; computed properly below)
CIDR_BITS="${LAN_SUBNET##*/}"
case "$CIDR_BITS" in
  24) LAN_NETMASK="255.255.255.0" ;;
  16) LAN_NETMASK="255.255.0.0"   ;;
  8)  LAN_NETMASK="255.0.0.0"     ;;
  23) LAN_NETMASK="255.255.254.0" ;;
  25) LAN_NETMASK="255.255.255.128" ;;
  *)  LAN_NETMASK="255.255.255.0" ;;
esac

title "PAYWIFI Phase 2 — Network Plumbing"
info "WAN iface : $WAN_IFACE  (DHCP from upstream)"
info "LAN iface : $LAN_IFACE  ($LAN_GW / $LAN_NETMASK, subnet $LAN_SUBNET)"
info "DHCP pool : $DHCP_START – $DHCP_END"
info "ipset     : $IPSET_NAME (empty allowlist for now)"
echo
confirm "Apply this network configuration?" || die "Aborted."

# ----- Sanity: do the interfaces exist? --------------------------------------
for ifc in "$WAN_IFACE" "$LAN_IFACE"; do
  if ! ip link show "$ifc" >/dev/null 2>&1; then
    err "Interface '$ifc' does not exist on this host."
    info "Available:"
    ip -brief link show | grep -v '^lo' | awk '{print "   - " $1}'
    die "Fix the interface name in $CFG_FILE and re-run."
  fi
done
ok "Both interfaces present."

# ----- Backup helper ---------------------------------------------------------
backup_if_exists() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local bak="${f}.paywifi-bak.$(date +%s)"
  cp -a "$f" "$bak" && ok "Backed up: $f -> $bak"
}

# ============================================================================
#  1) /etc/network/interfaces
# ============================================================================
title "1/6  Writing /etc/network/interfaces"
backup_if_exists /etc/network/interfaces

cat >/etc/network/interfaces <<EOF
# Managed by PAYWIFI Phase 2 — $(date -Iseconds)
# Do not edit by hand; use /etc/paywifi/config.json + re-run the phase script.

source /etc/network/interfaces.d/*

auto lo
iface lo inet loopback

# ----- WAN ------------------------------------------------------------------
auto ${WAN_IFACE}
iface ${WAN_IFACE} inet dhcp

# ----- LAN (PAYWIFI client side) --------------------------------------------
auto ${LAN_IFACE}
iface ${LAN_IFACE} inet static
    address ${LAN_GW}
    netmask ${LAN_NETMASK}
EOF
ok "/etc/network/interfaces written."

# ============================================================================
#  2) IP forwarding (verify; bootstrap already wrote the file)
# ============================================================================
title "2/6  Ensuring IP forwarding is enabled"
echo "net.ipv4.ip_forward=1" >/etc/sysctl.d/99-paywifi.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null
ok "net.ipv4.ip_forward = 1 (runtime + persisted)"

# ============================================================================
#  3) dnsmasq — DHCP + DNS for LAN
# ============================================================================
title "3/6  Configuring dnsmasq (DHCP + DNS)"

# Stop dnsmasq from binding to WAN
backup_if_exists /etc/dnsmasq.conf
# Keep system dnsmasq.conf minimal; put our config in a drop-in
mkdir -p /etc/dnsmasq.d
cat >/etc/dnsmasq.d/paywifi.conf <<EOF
# PAYWIFI dnsmasq drop-in
# Bind only to the LAN interface — never serve DHCP/DNS on WAN
interface=${LAN_IFACE}
bind-interfaces
listen-address=${LAN_GW}
except-interface=${WAN_IFACE}

# DHCP pool for clients
dhcp-range=${DHCP_START},${DHCP_END},${LAN_NETMASK},12h
dhcp-option=option:router,${LAN_GW}
dhcp-option=option:dns-server,${LAN_GW}

# DNS upstream — use Cloudflare + Google by default; edit as needed
no-resolv
server=1.1.1.1
server=8.8.8.8
cache-size=1000

# Don't read /etc/hosts (gateway shouldn't leak its own hostnames to clients)
no-hosts

# Log queries to file (helpful for debugging; comment out in production)
log-facility=/var/log/paywifi/dnsmasq.log
log-queries
log-dhcp

# DHCP lease file
dhcp-leasefile=/var/lib/misc/paywifi-dnsmasq.leases

# Identify ourselves to clients
dhcp-option=15,paywifi.lan
domain=paywifi.lan
EOF
ok "/etc/dnsmasq.d/paywifi.conf written."

# Make sure log dir exists & is writable by dnsmasq
mkdir -p /var/log/paywifi
touch /var/log/paywifi/dnsmasq.log
chown dnsmasq:dnsmasq /var/log/paywifi/dnsmasq.log 2>/dev/null || true

# Disable systemd-resolved on port 53 conflict (common on Debian 12)
if systemctl is-active --quiet systemd-resolved; then
  warn "systemd-resolved is active and will conflict with dnsmasq on port 53."
  if confirm "Disable systemd-resolved stub listener?"; then
    mkdir -p /etc/systemd/resolved.conf.d
    cat >/etc/systemd/resolved.conf.d/paywifi.conf <<EOF
[Resolve]
DNSStubListener=no
EOF
    # ensure /etc/resolv.conf is not the stub symlink
    if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q stub-resolv; then
      rm -f /etc/resolv.conf
      echo "nameserver 1.1.1.1" >/etc/resolv.conf
      echo "nameserver 8.8.8.8" >>/etc/resolv.conf
      ok "Replaced /etc/resolv.conf with static upstreams."
    fi
    systemctl restart systemd-resolved
    ok "systemd-resolved stub listener disabled."
  fi
fi

# ============================================================================
#  4) ipset — allowlist set (empty for now, Phase 3 will populate it)
# ============================================================================
title "4/6  Setting up ipset allowlist"

# Create the set if it doesn't exist
if ! ipset list -n 2>/dev/null | grep -qx "$IPSET_NAME"; then
  ipset create "$IPSET_NAME" hash:ip family inet timeout 0 \
    || die "Failed to create ipset $IPSET_NAME"
  ok "Created ipset: $IPSET_NAME (hash:ip)"
else
  ok "ipset $IPSET_NAME already exists."
fi

# Persist the set so it survives reboot
mkdir -p /etc/paywifi
ipset save "$IPSET_NAME" >/etc/paywifi/ipset.rules
ok "Saved ipset to /etc/paywifi/ipset.rules"

# systemd unit to restore ipset on boot — must run BEFORE nftables
cat >/etc/systemd/system/paywifi-ipset.service <<'EOF'
[Unit]
Description=PAYWIFI ipset restore
DefaultDependencies=no
After=network-pre.target
Before=network-pre.target nftables.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ipset restore -exist -file /etc/paywifi/ipset.rules
ExecStop=/bin/sh -c '/sbin/ipset save paywifi_auth > /etc/paywifi/ipset.rules'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now paywifi-ipset.service >/dev/null
ok "paywifi-ipset.service enabled."

# ============================================================================
#  5) nftables — NAT + forwarding (no captive gating yet)
# ============================================================================
title "5/6  Writing /etc/nftables.conf"
backup_if_exists /etc/nftables.conf

cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# =============================================================================
#  PAYWIFI nftables ruleset — Phase 2 (NAT + forwarding only)
#  Phase 3 will add captive-portal redirect + ipset-based gating.
# =============================================================================

flush ruleset

define WAN_IF = "${WAN_IFACE}"
define LAN_IF = "${LAN_IFACE}"
define LAN_NET = ${LAN_SUBNET}

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept
        iif "lo" accept

        # Allow ICMP for diagnostics
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # SSH from anywhere (tighten in production)
        tcp dport 22 accept

        # DHCP + DNS from LAN
        iifname \$LAN_IF udp dport { 53, 67 } accept
        iifname \$LAN_IF tcp dport 53 accept

        # PAYWIFI portal + API from LAN
        iifname \$LAN_IF tcp dport { 80, 443, 3000 } accept

        # Admin UI from LAN (and optionally WAN if you front it differently)
        iifname \$LAN_IF tcp dport 8080 accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;

        ct state established,related accept

        # LAN -> WAN (Phase 2: wide open. Phase 3 will gate this with ipset.)
        iifname \$LAN_IF oifname \$WAN_IF accept
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}

table ip nat {
    chain prerouting {
        type nat hook prerouting priority -100;
        # Phase 3 will insert captive-portal redirect rules here.
    }

    chain postrouting {
        type nat hook postrouting priority 100;
        oifname \$WAN_IF masquerade
    }
}
EOF
ok "/etc/nftables.conf written."

# Validate the ruleset before enabling
if nft -c -f /etc/nftables.conf; then
  ok "nftables ruleset syntax valid."
else
  die "nftables ruleset has errors. Inspect /etc/nftables.conf"
fi

systemctl enable nftables.service >/dev/null
ok "nftables service enabled."

# ============================================================================
#  6) Apply everything + service ordering
# ============================================================================
title "6/6  Applying configuration"

warn "About to restart networking — if you are SSH'd in over $WAN_IFACE, you should be fine."
warn "If you are SSH'd over $LAN_IFACE, your session may drop and reconnect."
confirm "Apply network changes now?" || { warn "Skipped apply. Reboot to take effect."; exit 0; }

# Bring up LAN interface (idempotent)
ip addr flush dev "$LAN_IFACE" 2>/dev/null || true
ip addr add "${LAN_GW}/${CIDR_BITS}" dev "$LAN_IFACE"
ip link set "$LAN_IFACE" up
ok "$LAN_IFACE configured: ${LAN_GW}/${CIDR_BITS}"

# Reload nftables
nft -f /etc/nftables.conf && ok "nftables ruleset loaded."

# Restart dnsmasq
systemctl enable dnsmasq.service >/dev/null
systemctl restart dnsmasq.service
sleep 1
if systemctl is-active --quiet dnsmasq; then
  ok "dnsmasq is running."
else
  err "dnsmasq failed to start. Check: journalctl -u dnsmasq -n 50"
fi

# ============================================================================
#  Final summary + smoke tests
# ============================================================================
hr
echo "${C_GRN}${C_BLD} ${APP_NAME} Phase 2 complete.${C_RST}"
hr
echo "Smoke tests you can run now:"
echo
echo "  # On the Debian VM itself:"
echo "  ip addr show ${LAN_IFACE}              # should show ${LAN_GW}/${CIDR_BITS}"
echo "  ip route                                # default via WAN, ${LAN_SUBNET} on ${LAN_IFACE}"
echo "  systemctl status dnsmasq nftables paywifi-ipset"
echo "  nft list ruleset                        # verify rules loaded"
echo "  ipset list ${IPSET_NAME}                # empty set, ready for Phase 3"
echo
echo "  # From a client laptop plugged into ${LAN_IFACE} (via switch/AP):"
echo "  - should receive DHCP lease in ${DHCP_START}-${DHCP_END}"
echo "  - should be able to ping ${LAN_GW} and 1.1.1.1"
echo "  - should be able to browse the internet (NO portal yet — that's Phase 3)"
echo
echo "  # Watch DHCP / DNS activity live:"
echo "  tail -f /var/log/paywifi/dnsmasq.log"
echo
echo "Next phase: captive portal gating (nftables redirect + ipset enforcement)."
hr