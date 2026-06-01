#!/usr/bin/env bash
# =============================================================================
# paywifi-fix-admin-wan.sh
#
# Fix: PAYWIFI admin UI (/admin) not accessible from the WAN / management LAN.
#
# Cause: the nginx admin ACL hardcodes a specific subnet (e.g. 192.168.89.0/24).
#        On an installation whose WAN subnet is different, nginx returns
#        403 Forbidden to admins on the WAN.
#
# This script detects THIS machine's WAN subnet and adds an `allow` rule for it
# to every admin-protected nginx location, then reloads nginx. It is idempotent
# (safe to run repeatedly) and rolls back if the new config fails to test.
#
# Usage:
#   sudo ./paywifi-fix-admin-wan.sh [extra-allow ...]
#
#   extra-allow : optional additional IPs/CIDRs to allow into /admin
#                 e.g. sudo ./paywifi-fix-admin-wan.sh 203.0.113.10 10.8.0.0/24
#
# Run as root.
# =============================================================================
set -euo pipefail

CFG="/etc/paywifi/config.json"
# nginx site file (override by exporting SITE=... before running)
SITE="${SITE:-/etc/nginx/sites-available/paywifi}"

err() { echo "ERROR: $*" >&2; exit 1; }
info(){ echo "[fix-admin-wan] $*"; }

[ "$(id -u)" -eq 0 ] || err "must run as root (use sudo)."
[ -f "$SITE" ] || err "nginx site not found: $SITE  (set SITE=/path to override)"
command -v nginx >/dev/null 2>&1 || err "nginx not installed."

# --- 1. Detect WAN interface --------------------------------------------------
WAN=""
if [ -f "$CFG" ] && command -v jq >/dev/null 2>&1; then
  WAN="$(jq -r '.network.wan_iface // empty' "$CFG" 2>/dev/null || true)"
fi
# fallback: interface of the default route
[ -z "${WAN:-}" ] && WAN="$(ip route 2>/dev/null | awk '/^default/{print $5; exit}')"
[ -n "${WAN:-}" ] || err "could not determine WAN interface (set it in $CFG .network.wan_iface)."
info "WAN interface: $WAN"

# --- 2. Compute the WAN subnet (network/prefix) ------------------------------
IFCIDR="$(ip -o -4 addr show dev "$WAN" 2>/dev/null | awk '{print $4; exit}')"
[ -n "${IFCIDR:-}" ] || err "WAN interface $WAN has no IPv4 address."

NET=""
if command -v python3 >/dev/null 2>&1; then
  NET="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$IFCIDR" 2>/dev/null || true)"
fi
# fallback: trust nginx to mask host/prefix
[ -z "${NET:-}" ] && NET="$IFCIDR"
info "WAN subnet to allow: $NET"

# --- 3. Build the list of allow entries (WAN subnet + any extras) ------------
ALLOWS=("$NET" "$@")

# --- 4. Backup --------------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
BAK="/root/$(basename "$SITE").bak.$TS"
cp -a "$SITE" "$BAK"
info "backup: $BAK"

# --- 5. Insert each allow after every 'allow 127.0.0.1;' (admin blocks) ------
#     (idempotent: only inserts entries not already present in the file)
changed=0
for A in "${ALLOWS[@]}"; do
  [ -n "$A" ] || continue
  if grep -qE "allow[[:space:]]+${A//./\\.};" "$SITE"; then
    info "already allowed: $A  (skip)"
    continue
  fi
  # insert after each loopback allow line inside admin ACL blocks
  sed -i "s|\(allow 127\.0\.0\.1;\)|\1\n        allow ${A};|g" "$SITE"
  info "added: allow ${A};"
  changed=1
done

if [ "$changed" -eq 0 ]; then
  info "no changes needed — admin already reachable from $NET."
  exit 0
fi

# --- 6. Test + reload (rollback on failure) ----------------------------------
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  info "nginx config OK and reloaded. /admin is now reachable from: ${ALLOWS[*]}"
else
  info "nginx config test FAILED — rolling back."
  cp -a "$BAK" "$SITE"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  err "rolled back to $BAK (no changes applied)."
fi

# --- 7. Show the resulting admin ACL -----------------------------------------
echo
info "Current admin ACL (first block):"
awk '/location \/admin[ {]/{p=1} p{print "    "$0} p&&/deny/{exit}' "$SITE" | head -12
