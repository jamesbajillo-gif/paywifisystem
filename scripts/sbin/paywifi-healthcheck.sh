#!/usr/bin/env bash
# PAYWIFI service healthcheck (REC-05) — restart core services if down, SMS-alert admin (30min cooldown).
set -o pipefail
DB="/var/lib/paywifi/paywifi.db"
LOG="/var/log/paywifi/healthcheck.log"
STAMP="/run/paywifi-healthcheck-alerted"
COOLDOWN=1800

restarted=""
for svc in paywifi-api paywifi-sessiond; do
  if ! systemctl is-active --quiet "$svc"; then
    systemctl restart "$svc"
    restarted="$restarted $svc"
  fi
done

[ -z "$restarted" ] && exit 0
echo "$(date -Is) restarted:$restarted" >> "$LOG"

ADMIN=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='admin_alert_phone';" 2>/dev/null | tr -d '[:space:]')
KEY=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='semaphore_api_key';" 2>/dev/null | tr -d '[:space:]')
SENDER=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='semaphore_sender_name';" 2>/dev/null)
[ -z "$SENDER" ] && SENDER="PAYWIFI"
case "$ADMIN" in
  0*)  ADMIN="63${ADMIN#0}" ;;
  9*)  ADMIN="63${ADMIN}" ;;
esac

now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ -n "$ADMIN" ] && [ -n "$KEY" ] && [ $((now - last)) -ge "$COOLDOWN" ]; then
  curl -s -m 10 -X POST https://api.semaphore.co/api/v4/messages \
    --data-urlencode "apikey=$KEY" \
    --data-urlencode "number=$ADMIN" \
    --data-urlencode "sendername=$SENDER" \
    --data-urlencode "message=PAYWIFI ALERT: service down, restarted$restarted at $(date -Is)." >> "$LOG" 2>&1
  echo "$now" > "$STAMP"
  echo "$(date -Is) alert SMS -> $ADMIN" >> "$LOG"
fi
exit 0
