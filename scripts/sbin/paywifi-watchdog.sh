#!/usr/bin/env bash
# PAYWIFI infrastructure watchdog — validate & self-heal IFB, tc, nft captive sets,
# LAN IP, default route, core services, captive reachability. Runs every 60s via
# paywifi-watchdog.timer. Heals only the failed layer; logs + records to DB;
# SMS-alerts admin on repeated failures (30-min cooldown).
# pipefail intentionally OFF: cmd|grep -q would SIGPIPE the producer and misreport
DB="/var/lib/paywifi/paywifi.db"
LOG="/var/log/paywifi/watchdog.log"
CFG="/etc/paywifi/config.json"
SHAPE_INIT="/usr/local/sbin/paywifi-shape-init"
IFB="ifb-paywifi"
RUN=/run

LAN=$(jq -r '.network.lan_iface' "$CFG" 2>/dev/null); { [ -z "$LAN" ] || [ "$LAN" = null ]; } && LAN=ens19
WAN=$(jq -r '.network.wan_iface' "$CFG" 2>/dev/null); { [ -z "$WAN" ] || [ "$WAN" = null ]; } && WAN=ens18
GW=$(jq -r '.network.lan_gateway' "$CFG" 2>/dev/null); { [ -z "$GW" ] || [ "$GW" = null ]; } && GW=10.10.0.1

ts(){ date -Is; }
log(){ echo "$(ts) $*" >> "$LOG"; }
rec(){ sqlite3 -cmd '.timeout 3000' "$DB" "INSERT INTO infra_events(ts,layer,status,detail) VALUES($(date +%s),'$1','$2','$(echo "$3" | sed "s/'/''/g")');" 2>/dev/null; }

HEALED=""; FAILED=""; REAPPLY=0
heal(){ HEALED="$HEALED $1"; log "HEAL $1: $2"; rec "$1" healed "$2"; local f="$RUN/paywifi-wd-$1.cnt"; local now; now=$(date +%s); echo "$now" >> "$f"; awk -v n="$now" '($1+600)>=n' "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"; }
fail(){ FAILED="$FAILED $1"; log "FAIL $1: $2"; rec "$1" failed "$2"; local f="$RUN/paywifi-wd-$1.cnt"; local now; now=$(date +%s); echo "$now" >> "$f"; awk -v n="$now" '($1+600)>=n' "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"; }

# 1) IFB device
if ! ip link show "$IFB" >/dev/null 2>&1; then
  modprobe ifb 2>/dev/null
  ip link add "$IFB" type ifb 2>/dev/null
  ip link set "$IFB" up 2>/dev/null
  "$SHAPE_INIT" >/dev/null 2>&1
  if ip link show "$IFB" >/dev/null 2>&1; then heal ifb "recreated missing IFB device + reapplied tc"; REAPPLY=1; else fail ifb "could not recreate IFB device"; fi
fi

# 2) tc base qdiscs
need_tc=0
tc qdisc show dev "$LAN" 2>/dev/null | grep -q 'htb 1:' || need_tc=1
tc qdisc show dev "$IFB" 2>/dev/null | grep -q 'htb 1:' || need_tc=1
tc qdisc show dev "$WAN" 2>/dev/null | grep -q 'ingress'  || need_tc=1
if [ "$need_tc" = 1 ]; then
  "$SHAPE_INIT" >/dev/null 2>&1
  if tc qdisc show dev "$IFB" 2>/dev/null | grep -q 'htb 1:'; then heal tc "reapplied tc base qdiscs"; REAPPLY=1; else fail tc "tc reapply incomplete"; fi
fi

# 3) nft captive sets (structure missing => ruleset gone)
if ! nft list set inet filter paywifi_auth >/dev/null 2>&1; then
  nft -f /etc/nftables.conf >/dev/null 2>&1
  if nft list set inet filter paywifi_auth >/dev/null 2>&1; then heal nft "reloaded nftables ruleset"; REAPPLY=1; else fail nft "nft ruleset reload failed"; fi
fi

# 4) LAN IP
if ! ip -4 addr show "$LAN" 2>/dev/null | grep -q "$GW/"; then
  ip addr add "$GW/24" dev "$LAN" 2>/dev/null
  ip link set "$LAN" up 2>/dev/null
  if ip -4 addr show "$LAN" 2>/dev/null | grep -q "$GW/"; then heal lan_ip "restored $GW on $LAN"; else fail lan_ip "could not restore LAN IP"; fi
fi

# 5) default route (detect only)
ip route 2>/dev/null | grep -q '^default' || fail wan_route "no default route (uplink down)"

# 6) core services
for svc in dnsmasq nginx nftables paywifi-api paywifi-sessiond paywifi-shape; do
  systemctl is-active --quiet "$svc" && continue
  systemctl restart "$svc" >/dev/null 2>&1; sleep 1
  if systemctl is-active --quiet "$svc"; then heal "svc_$svc" "restarted $svc"; else fail "svc_$svc" "restart failed"; fi
done

# After tc/IFB/nft heal, reapply per-session firewall+shaping via sessiond restart (restoreActiveSessions)
if [ "$REAPPLY" = 1 ]; then systemctl restart paywifi-sessiond >/dev/null 2>&1; log "REAPPLY: restarted sessiond to re-apply active-session fw+shape"; fi

# 7) captive portal reachability — skip if maintenance mode is on (302 to /maintenance.html is expected)
if [ ! -f /opt/paywifi/portal/.maint_all ]; then
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$GW/" 2>/dev/null)
  [ "$code" = 200 ] || fail captive "portal returned http ${code:-none} on http://$GW/"
fi

# heartbeat ok (throttled ~10 min) when nothing wrong
HB="$RUN/paywifi-wd.hb"; now=$(date +%s); last=$(cat "$HB" 2>/dev/null || echo 0)
if [ -z "$HEALED$FAILED" ] && [ $((now-last)) -ge 600 ]; then rec system ok "all checks passed"; echo "$now" > "$HB"; fi

# QUEUE-EVERYWHERE-2026-06-01: SMS alert DISABLED — log to DB only, no SMS.
ESCAL=""
for f in "$RUN"/paywifi-wd-*.cnt; do [ -e "$f" ] || continue; n=$(wc -l < "$f" 2>/dev/null | tr -d ' '); [ "${n:-0}" -ge 3 ] && ESCAL="$ESCAL $(basename "$f" .cnt | sed 's/^paywifi-wd-//')"; done
if [ -n "$ESCAL" ]; then
  log "ESCAL: $ESCAL (SMS disabled)"
fi
if false; then    # ── original SMS block disabled below ──
  STAMP="$RUN/paywifi-wd-alerted"; now=$(date +%s); last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now-last)) -ge 1800 ]; then
    ADMIN=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='admin_alert_phone';" 2>/dev/null | tr -d '[:space:]')
    KEY=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='semaphore_api_key';" 2>/dev/null | tr -d '[:space:]')
    SENDER=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='semaphore_sender_name';" 2>/dev/null); [ -z "$SENDER" ] && SENDER=PAYWIFI
    case "$ADMIN" in 0*) ADMIN="63${ADMIN#0}";; 9*) ADMIN="63${ADMIN}";; esac
    MSG="PAYWIFI infra: repeated recovery on:${ESCAL} (failed now:${FAILED:-none}) at $(ts)"
    if [ -n "$ADMIN" ] && [ -n "$KEY" ]; then
      curl -s -m 10 -X POST https://api.semaphore.co/api/v4/messages --data-urlencode "apikey=$KEY" --data-urlencode "number=$ADMIN" --data-urlencode "sendername=$SENDER" --data-urlencode "message=$MSG" >> "$LOG" 2>&1
      echo "$now" > "$STAMP"; log "ALERT SMS -> $ADMIN : $MSG"
    fi
  fi
fi
exit 0
