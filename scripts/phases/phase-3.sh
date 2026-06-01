#!/usr/bin/env bash
# =============================================================================
#  paywifi-phase3-captive.sh
#  PAYWIFI — Phase 3: Captive Portal Gating
#    * nftables: HTTP redirect to portal, HTTPS drop, ipset-gated forwarding
#    * ipset:    paywifi_walled (walled garden), paywifi_auth (re-confirmed)
#    * nginx:    serves placeholder portal, reverse-proxy /api -> :3000
#    * CLI:      paywifi-auth helper (add/del/list)
#    * Portal:   placeholder HTML + OS captive-portal probe endpoints
# =============================================================================
#  Usage:  sudo bash paywifi-phase3-captive.sh
#  Prereq: phases 1 & 2 completed successfully
# =============================================================================

set -o pipefail

CFG_FILE="/etc/paywifi/config.json"
APP_NAME="PAYWIFI"
IPSET_AUTH="paywifi_auth"
IPSET_WALLED="paywifi_walled"

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
backup_if_exists() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local bak="${f}.paywifi-bak.$(date +%s)"
  cp -a "$f" "$bak" && ok "Backed up: $f -> $bak"
}

# ----- Preflight -------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
[[ -f "$CFG_FILE" ]] || die "Config not found at $CFG_FILE — run phase 1 first."

command -v jq      >/dev/null || die "jq missing."
command -v nft     >/dev/null || die "nftables missing."
command -v ipset   >/dev/null || die "ipset missing."
command -v dnsmasq >/dev/null || die "dnsmasq missing."
command -v nginx   >/dev/null || die "nginx missing."

# Confirm Phase 2 actually ran
ip link show "$(jq -r '.network.lan_iface' "$CFG_FILE")" >/dev/null 2>&1 \
  || die "LAN interface not configured — run phase 2 first."
ipset list -n 2>/dev/null | grep -qx "$IPSET_AUTH" \
  || die "ipset $IPSET_AUTH missing — run phase 2 first."

# ----- Load config -----------------------------------------------------------
WAN_IFACE=$(jq -r '.network.wan_iface'   "$CFG_FILE")
LAN_IFACE=$(jq -r '.network.lan_iface'   "$CFG_FILE")
LAN_SUBNET=$(jq -r '.network.lan_subnet' "$CFG_FILE")
LAN_GW=$(jq -r '.network.lan_gateway'    "$CFG_FILE")
API_PORT=$(jq -r '.api.port'             "$CFG_FILE")
PAYWIFI_HOME="/opt/paywifi"

title "PAYWIFI Phase 3 — Captive Portal Gating"
info "WAN iface     : $WAN_IFACE"
info "LAN iface     : $LAN_IFACE"
info "LAN subnet    : $LAN_SUBNET  (gw $LAN_GW)"
info "Auth ipset    : $IPSET_AUTH  (allowlist for authenticated clients)"
info "Walled ipset  : $IPSET_WALLED  (sites reachable pre-auth)"
info "Portal/API    : nginx :80, Node API on :${API_PORT} (proxied at /api)"
echo
confirm "Apply captive portal gating?" || die "Aborted."

# ============================================================================
#  1) Note: switching from legacy ipset(8) to native nft sets
# ============================================================================
title "1/5  Switching to native nft sets"
info "Phase 2 created legacy ipset '$IPSET_AUTH' for bootstrap purposes."
info "Phase 3 uses NATIVE nftables sets (managed via 'paywifi-auth' CLI),"
info "which are first-class objects defined inside each nft table."
info ""
info "The legacy ipset will be left in place (harmless) but no longer used."
info "Walled-garden + auth allowlist are now populated via 'nft add element'."

# Disable the old paywifi-ipset.service so it doesn't recreate the legacy set
# at boot (harmless if it does, but unnecessary).
if systemctl list-unit-files | grep -q '^paywifi-ipset.service'; then
  systemctl disable paywifi-ipset.service >/dev/null 2>&1 || true
  ok "Disabled paywifi-ipset.service (legacy ipset bootstrap)."
fi
ok "Ready to write nft-native ruleset."

# ============================================================================
#  2) Helper CLI: paywifi-auth  (add/del/list authenticated IPs)
# ============================================================================
title "2/5  Installing paywifi-auth CLI helper"
cat >/usr/local/sbin/paywifi-auth <<'HELPER'
#!/usr/bin/env bash
# paywifi-auth — manage the captive portal allowlist (native nft sets)
# Usage:
#   paywifi-auth add    <ip> [timeout-seconds]
#   paywifi-auth del    <ip>
#   paywifi-auth list
#   paywifi-auth flush
#   paywifi-auth walled-add <ip>
#   paywifi-auth walled-del <ip>
#   paywifi-auth walled-list

set -o pipefail
TABLE_FILTER="inet filter"
TABLE_CAPTIVE="inet captive"
TABLE_NAT="ip nat"
SET_AUTH="paywifi_auth"
SET_WALLED="paywifi_walled"

add_to_set() {
  local table="$1" set="$2" ip="$3" tmo="$4"
  if [[ -n "$tmo" ]]; then
    nft add element $table $set "{ $ip timeout ${tmo}s }" 2>/dev/null || \
    nft add element $table $set "{ $ip }"
  else
    nft add element $table $set "{ $ip }"
  fi
}

case "${1:-}" in
  add)
    [[ -n "$2" ]] || { echo "usage: paywifi-auth add <ip> [timeout-seconds]" >&2; exit 1; }
    add_to_set "$TABLE_FILTER"  "$SET_AUTH" "$2" "${3:-}"
    add_to_set "$TABLE_CAPTIVE" "$SET_AUTH" "$2" "${3:-}"
    echo "added: $2${3:+ (timeout ${3}s)}"
    ;;
  del)
    [[ -n "$2" ]] || { echo "usage: paywifi-auth del <ip>" >&2; exit 1; }
    nft delete element "$TABLE_FILTER"  "$SET_AUTH" "{ $2 }" 2>/dev/null || true
    nft delete element "$TABLE_CAPTIVE" "$SET_AUTH" "{ $2 }" 2>/dev/null || true
    echo "removed: $2"
    ;;
  list)
    echo "=== $SET_AUTH (filter table) ==="
    nft list set "$TABLE_FILTER" "$SET_AUTH" 2>/dev/null || echo "(empty)"
    ;;
  flush)
    nft flush set "$TABLE_FILTER"  "$SET_AUTH" 2>/dev/null || true
    nft flush set "$TABLE_CAPTIVE" "$SET_AUTH" 2>/dev/null || true
    echo "flushed."
    ;;
  walled-add)
    [[ -n "$2" ]] || { echo "usage: paywifi-auth walled-add <ip>" >&2; exit 1; }
    nft add element "$TABLE_FILTER"  "$SET_WALLED" "{ $2 }"
    nft add element "$TABLE_CAPTIVE" "$SET_WALLED" "{ $2 }"
    nft add element "$TABLE_NAT"     "$SET_WALLED" "{ $2 }" 2>/dev/null || true
    echo "walled-garden: added $2"
    ;;
  walled-del)
    [[ -n "$2" ]] || { echo "usage: paywifi-auth walled-del <ip>" >&2; exit 1; }
    nft delete element "$TABLE_FILTER"  "$SET_WALLED" "{ $2 }" 2>/dev/null || true
    nft delete element "$TABLE_CAPTIVE" "$SET_WALLED" "{ $2 }" 2>/dev/null || true
    nft delete element "$TABLE_NAT"     "$SET_WALLED" "{ $2 }" 2>/dev/null || true
    echo "walled-garden: removed $2"
    ;;
  walled-list)
    echo "=== $SET_WALLED ==="
    nft list set "$TABLE_FILTER" "$SET_WALLED" 2>/dev/null || echo "(empty)"
    ;;
  *)
    cat <<USAGE
paywifi-auth — manage captive portal allowlist & walled garden

Usage:
  paywifi-auth add <ip> [timeout-seconds]   # authorize an IP
  paywifi-auth del <ip>                     # remove an IP from allowlist
  paywifi-auth list                         # show authorized IPs
  paywifi-auth flush                        # clear all authorized IPs
  paywifi-auth walled-add <ip>              # add to walled garden
  paywifi-auth walled-del <ip>              # remove from walled garden
  paywifi-auth walled-list                  # show walled garden
USAGE
    ;;
esac
HELPER
chmod 750 /usr/local/sbin/paywifi-auth
ok "Installed /usr/local/sbin/paywifi-auth"

# ============================================================================
#  3) Write nftables ruleset (native nft sets in each table that needs them)
# ============================================================================
title "3/5  Writing /etc/nftables.conf with captive gating"
backup_if_exists /etc/nftables.conf
cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# =============================================================================
#  PAYWIFI nftables ruleset — Phase 3
#  Native nft sets (managed by /usr/local/sbin/paywifi-auth)
# =============================================================================

flush ruleset

define WAN_IF  = "${WAN_IFACE}"
define LAN_IF  = "${LAN_IFACE}"
define LAN_NET = ${LAN_SUBNET}
define LAN_GW  = ${LAN_GW}

# -----------------------------------------------------------------------------
#  inet filter — host firewall + LAN->WAN gating
# -----------------------------------------------------------------------------
table inet filter {
    set paywifi_auth   { type ipv4_addr; flags timeout; }
    set paywifi_walled {
        type ipv4_addr
        elements = { \$LAN_GW, 1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4 }
    }

    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept
        iif "lo" accept
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        tcp dport 22 accept                                           # SSH

        iifname \$LAN_IF udp dport { 53, 67 } accept                  # DHCP/DNS
        iifname \$LAN_IF tcp dport 53 accept
        iifname \$LAN_IF tcp dport { 80, 443, 3000, 8080 } accept     # Portal+API+Admin
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept

        iifname \$LAN_IF ip daddr @paywifi_walled accept
        iifname \$LAN_IF oifname \$WAN_IF ip saddr @paywifi_auth accept
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}

# -----------------------------------------------------------------------------
#  inet captive — drops unauthenticated HTTPS/QUIC quickly
# -----------------------------------------------------------------------------
table inet captive {
    set paywifi_auth   { type ipv4_addr; flags timeout; }
    set paywifi_walled {
        type ipv4_addr
        elements = { \$LAN_GW, 1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4 }
    }

    chain forward {
        type filter hook forward priority -10; policy accept;

        iifname \$LAN_IF ip saddr @paywifi_auth accept
        iifname \$LAN_IF ip daddr @paywifi_walled accept

        iifname \$LAN_IF tcp dport 443 reject with tcp reset
        iifname \$LAN_IF udp dport 443 drop
    }
}

# -----------------------------------------------------------------------------
#  ip nat — captive redirect + masquerade
# -----------------------------------------------------------------------------
table ip nat {
    set paywifi_auth   { type ipv4_addr; flags timeout; }
    set paywifi_walled {
        type ipv4_addr
        elements = { \$LAN_GW, 1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4 }
    }

    chain prerouting {
        type nat hook prerouting priority -100;

        iifname \$LAN_IF ip saddr @paywifi_auth return
        iifname \$LAN_IF ip daddr @paywifi_walled return
        iifname \$LAN_IF ip daddr \$LAN_GW return

        iifname \$LAN_IF tcp dport 80 dnat to \$LAN_GW:80
    }

    chain postrouting {
        type nat hook postrouting priority 100;
        oifname \$WAN_IF masquerade
    }
}
EOF

if nft -c -f /etc/nftables.conf; then
  ok "nftables ruleset syntax valid."
else
  die "nftables ruleset failed validation."
fi

# Apply the ruleset
nft -f /etc/nftables.conf
ok "nftables ruleset loaded (walled-garden defaults baked in)."

# ============================================================================
#  4) Placeholder portal + OS captive-portal probe endpoints
# ============================================================================
title "4/5  Installing placeholder portal"

mkdir -p "$PAYWIFI_HOME/portal"

# --- Landing page ------------------------------------------------------------
cat >"$PAYWIFI_HOME/portal/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PAYWIFI — Connect</title>
<style>
  :root { --brand:#0ea5e9; --bg:#0f172a; --fg:#e2e8f0; --card:#1e293b; --muted:#94a3b8; }
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:var(--bg);color:var(--fg);min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:var(--card);border-radius:16px;padding:2rem;max-width:420px;width:100%;
        box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{margin:0 0 .25rem;font-size:1.8rem;color:var(--brand)}
  p.tag{margin:0 0 1.5rem;color:var(--muted)}
  label{display:block;font-size:.85rem;color:var(--muted);margin:1rem 0 .35rem;text-transform:uppercase;letter-spacing:.05em}
  input{width:100%;padding:.85rem 1rem;font-size:1.1rem;border-radius:8px;border:1px solid #334155;
        background:#0f172a;color:var(--fg);font-family:ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}
  input:focus{outline:none;border-color:var(--brand)}
  button{width:100%;margin-top:1.25rem;padding:.85rem;background:var(--brand);color:#001220;
         border:none;border-radius:8px;font-size:1.05rem;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.1)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .msg{margin-top:1rem;padding:.75rem;border-radius:8px;font-size:.9rem;display:none}
  .msg.ok{display:block;background:#064e3b;color:#a7f3d0}
  .msg.err{display:block;background:#7f1d1d;color:#fecaca}
  footer{text-align:center;margin-top:1.5rem;font-size:.75rem;color:var(--muted)}
</style>
</head>
<body>
  <div class="card">
    <h1>PAYWIFI</h1>
    <p class="tag">Enter your voucher code to get online.</p>

    <label for="code">Voucher code</label>
    <input id="code" autocomplete="off" autocapitalize="characters" placeholder="XXXXXXXX" maxlength="16" />

    <button id="go">Connect</button>
    <div id="msg" class="msg"></div>

    <footer>Placeholder portal — React portal will replace this.</footer>
  </div>

<script>
const $ = (s)=>document.querySelector(s);
const msg = (text, kind)=>{ const m=$('#msg'); m.textContent=text; m.className='msg '+(kind||''); };

$('#go').addEventListener('click', async () => {
  const code = $('#code').value.trim().toUpperCase();
  if (!code) { msg('Enter a voucher code.', 'err'); return; }
  $('#go').disabled = true; msg('Connecting…', 'ok');
  try {
    const r = await fetch('/api/auth/voucher', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ code })
    });
    const j = await r.json().catch(()=>({}));
    if (r.ok && j.ok) {
      msg('Connected! Redirecting…', 'ok');
      setTimeout(()=>location.href='/status.html', 1000);
    } else {
      msg(j.error || 'Voucher invalid or expired.', 'err');
      $('#go').disabled = false;
    }
  } catch (e) {
    msg('Network error — API not reachable yet (Phase 4).', 'err');
    $('#go').disabled = false;
  }
});
$('#code').addEventListener('keydown', e => { if (e.key==='Enter') $('#go').click(); });
</script>
</body>
</html>
HTML

# --- Status page (post-auth) -------------------------------------------------
cat >"$PAYWIFI_HOME/portal/status.html" <<'HTML'
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAYWIFI — Connected</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
       min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#1e293b;border-radius:16px;padding:2rem;max-width:420px;text-align:center}
  h1{color:#10b981;margin:0 0 .5rem}
  .stat{margin:1rem 0;font-size:1.4rem}
  button{padding:.6rem 1.2rem;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer}
</style></head>
<body><div class="card">
  <h1>✓ Connected</h1>
  <div class="stat">Session active</div>
  <p>Time remaining and bandwidth info will appear here once the API is wired up (Phase 4).</p>
  <button onclick="fetch('/api/session/logout',{method:'POST'}).then(()=>location.href='/')">Disconnect</button>
</div></body></html>
HTML

# --- OS captive-portal probe endpoints ---------------------------------------
# These URLs are hit by Apple/Android/Windows to detect captive portals.
# Returning anything other than the expected magic string triggers the
# "Sign in to network" pop-up on the device.
mkdir -p "$PAYWIFI_HOME/portal/probes"

# Apple expects exactly: <HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>
# We deliberately return something else (302 to portal) so the popup fires.
cat >"$PAYWIFI_HOME/portal/probes/apple.html" <<'HTML'
<HTML><HEAD><TITLE>PAYWIFI</TITLE></HEAD><BODY>Login required.</BODY></HTML>
HTML

# Generic 204 endpoint (Android/Chrome use HTTP 204 No Content on success)
cat >"$PAYWIFI_HOME/portal/probes/generate_204.html" <<'HTML'
<html><body>Login required at PAYWIFI portal.</body></html>
HTML

ok "Portal files installed in $PAYWIFI_HOME/portal/"

# ============================================================================
#  5) nginx — serve portal + reverse-proxy /api to Node (Phase 4)
# ============================================================================
title "5/5  Configuring nginx"
backup_if_exists /etc/nginx/sites-available/paywifi
backup_if_exists /etc/nginx/sites-enabled/default

cat >/etc/nginx/sites-available/paywifi <<EOF
# PAYWIFI portal + API proxy
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root ${PAYWIFI_HOME}/portal;
    index index.html;

    access_log /var/log/paywifi/nginx-access.log;
    error_log  /var/log/paywifi/nginx-error.log warn;

    # ---- OS captive-portal probe endpoints ---------------------------------
    # Apple
    location = /hotspot-detect.html        { try_files /probes/apple.html =404; }
    location = /library/test/success.html  { try_files /probes/apple.html =404; }
    # Android / ChromeOS
    location = /generate_204               { return 302 http://\$host/; }
    location = /gen_204                    { return 302 http://\$host/; }
    # Microsoft / Windows
    location = /ncsi.txt                   { return 302 http://\$host/; }
    location = /connecttest.txt            { return 302 http://\$host/; }
    location = /redirect                   { return 302 http://\$host/; }

    # ---- API reverse proxy (Phase 4) ---------------------------------------
    location /api/ {
        proxy_pass         http://127.0.0.1:${API_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # ---- Portal static files -----------------------------------------------
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
ok "/etc/nginx/sites-available/paywifi written."

# Enable site, disable default
ln -sf /etc/nginx/sites-available/paywifi /etc/nginx/sites-enabled/paywifi
rm -f /etc/nginx/sites-enabled/default
ok "Enabled PAYWIFI nginx site, disabled default."

# Ensure log dir exists
mkdir -p /var/log/paywifi
touch /var/log/paywifi/nginx-access.log /var/log/paywifi/nginx-error.log
chown www-data:www-data /var/log/paywifi/nginx-*.log 2>/dev/null || true

# Validate + reload
if nginx -t 2>&1 | grep -q "successful"; then
  ok "nginx config valid."
  systemctl enable nginx >/dev/null
  systemctl restart nginx
  ok "nginx restarted."
else
  err "nginx config has errors:"
  nginx -t
  die "Fix nginx config and re-run."
fi

# ============================================================================
#  Final summary + smoke tests
# ============================================================================
hr
echo "${C_GRN}${C_BLD} ${APP_NAME} Phase 3 complete — captive portal is live.${C_RST}"
hr
echo "How it works now:"
echo
echo "  Unauthenticated client (any LAN IP not in paywifi_auth):"
echo "    HTTP    -> redirected to portal (http://${LAN_GW}/)"
echo "    HTTPS   -> TCP RST (browser fails fast, OS detects captive portal)"
echo "    DNS     -> works (via dnsmasq)"
echo "    Walled  -> reachable: $LAN_GW, 1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4"
echo
echo "  Authenticated client (IP added to paywifi_auth):"
echo "    full LAN -> WAN routing, no redirect"
echo
echo "Smoke tests:"
echo
echo "  # 1. Pop a real client (laptop/phone) onto the LAN — it should hit the portal."
echo "  # 2. From the Debian VM, simulate authorizing a client manually:"
echo "       paywifi-auth list                              # empty"
echo "       paywifi-auth add 10.10.0.100 3600              # add IP for 1 hour"
echo "       paywifi-auth list                              # see it"
echo "       paywifi-auth del 10.10.0.100                   # revoke"
echo
echo "  # 3. Watch nginx hits as clients land on the portal:"
echo "       tail -f /var/log/paywifi/nginx-access.log"
echo
echo "  # 4. Inspect live nft sets:"
echo "       nft list set inet filter paywifi_auth"
echo "       nft list set inet filter paywifi_walled"
echo
echo "  # 5. Test API stub from a client laptop:"
echo "       curl http://${LAN_GW}/api/auth/voucher -X POST \\"
echo "            -H 'Content-Type: application/json' -d '{\"code\":\"TEST\"}'"
echo "       (Should fail with 502 — API not running yet. That's Phase 4.)"
echo
echo "Next phase: Node.js API (voucher redemption -> calls paywifi-auth to allowlist)."
hr