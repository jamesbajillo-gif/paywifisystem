#!/usr/bin/env bash
# PAYWIFI connection monitor — ingests nginx captive-probe + portal hits and rebuilds
# device_status (per-device captive verdict) for /admin/devices. Batched + backlog-skip.
DB="/var/lib/paywifi/paywifi.db"
ACC="/var/log/paywifi/nginx-access.log"
LEASES="/var/lib/misc/paywifi-dnsmasq.leases"
OFF="/run/paywifi-conn-monitor.offset"
SQL(){ sqlite3 -cmd '.timeout 4000' "$DB" "$1" 2>/dev/null; }
esc(){ printf '%s' "${1//\'/\'\'}"; }
now=$(date +%s)

sz=$(stat -c%s "$ACC" 2>/dev/null || echo 0)
if [ ! -f "$OFF" ]; then echo "$sz" > "$OFF"; fi   # first run: skip backlog
off=$(cat "$OFF" 2>/dev/null || echo 0)
[ "$off" -gt "$sz" ] && off=0

if [ "$sz" -gt "$off" ]; then
  tmp=$(mktemp)
  echo "BEGIN;" > "$tmp"
  tail -c +$((off+1)) "$ACC" 2>/dev/null | head -5000 | awk '{ip=$1;st=$9;p=$7;ua=$0;sub(/^.*" "/,"",ua);gsub(/"$/,"",ua);print ip"\t"st"\t"p"\t"ua}' | while IFS=$'\t' read -r ip st path ua; do
    case "$ip" in 10.10.0.*) ;; *) continue;; esac
    case "$path" in
      /generate_204*|/gen_204*|/ncsi.txt*|/connecttest.txt*|/hotspot-detect.html*|/library/test/success.html*|/success.txt*|/redirect*) kind=probe;;
      /|/index.html|/api/session/status*|/api/portal/config*|/api/portal/session/restore*|/api/portal/captive-api*) kind=portal;;
      *) continue;;
    esac
    os=unknown
    case "$ua" in
      *Android*) os=Android;; *iPhone*|*iPad*|*CaptiveNetworkSupport*) os=iOS;;
      *"Windows NT"*) os=Windows;; *Macintosh*|*"Mac OS"*) os=macOS;; *CrOS*) os=ChromeOS;; *Linux*) os=Linux;;
    esac
    mac=$(awk -v ip="$ip" '$3==ip{print $2; exit}' "$LEASES" 2>/dev/null)
    printf "INSERT INTO device_events(ts,ip,mac,kind,path,status,os) VALUES(%d,'%s','%s','%s','%s','%s','%s');\n" \
      "$now" "$(esc "$ip")" "$(esc "$mac")" "$kind" "$(esc "$path")" "$(esc "$st")" "$os" >> "$tmp"
  done
  echo "COMMIT;" >> "$tmp"
  sqlite3 -cmd '.timeout 5000' "$DB" < "$tmp" 2>/dev/null
  rm -f "$tmp"
fi
echo "$sz" > "$OFF"

# rebuild device_status
AUTH=$(/usr/local/sbin/paywifi-auth list 2>/dev/null | grep -oE '10\.10\.0\.[0-9]+' | sort -u)
st=$(mktemp); echo "BEGIN; DELETE FROM device_status;" > "$st"
while read -r expy mac ip host rest; do
  case "$ip" in 10.10.0.*) ;; *) continue;; esac
  authorized=0; printf '%s\n' "$AUTH" | grep -qx "$ip" && authorized=1
  os=$(SQL "SELECT os FROM device_events WHERE ip='$(esc "$ip")' AND os!='unknown' ORDER BY ts DESC LIMIT 1;"); [ -z "$os" ] && os=unknown
  lpt=$(SQL "SELECT ts FROM device_events WHERE ip='$(esc "$ip")' AND kind='probe' ORDER BY ts DESC LIMIT 1;")
  lps=$(SQL "SELECT status FROM device_events WHERE ip='$(esc "$ip")' AND kind='probe' ORDER BY ts DESC LIMIT 1;")
  port=$(SQL "SELECT ts FROM device_events WHERE ip='$(esc "$ip")' AND kind='portal' ORDER BY ts DESC LIMIT 1;")
  sess=$(SQL "SELECT 1 FROM sessions WHERE mac_address='$(esc "$mac")' AND ended_at IS NULL LIMIT 1;")
  rp=0; [ -n "$lpt" ] && [ $((now-lpt)) -le 180 ] && rp=1
  rport=0; [ -n "$port" ] && [ $((now-port)) -le 180 ] && rport=1
  if [ "$authorized" = 1 ]; then v="Online (authorized)"
  elif [ -n "$sess" ]; then v="Has active session but NOT authorized - firewall/restore issue"
  elif [ "$rport" = 1 ]; then v="Gated; portal opened - awaiting sign-in/claim"
  elif [ "$rp" = 1 ]; then v="Gated; probing but portal not opened by OS (may need DHCP-114 / manual Sign in)"
  elif [ -n "$lpt" ]; then v="Gated; last probe $((now-lpt))s ago, no recent portal"
  else v="Gated; NO captive probe seen - device not re-checking (cached/no-internet)"
  fi
  printf "INSERT INTO device_status(ip,mac,hostname,os,authorized,has_session,last_probe_ts,last_probe_status,last_portal_ts,verdict,updated_at) VALUES('%s','%s','%s','%s',%d,%d,%d,'%s',%d,'%s',%d);\n" \
    "$(esc "$ip")" "$(esc "$mac")" "$(esc "$host")" "$os" "$authorized" "$([ -n "$sess" ]&&echo 1||echo 0)" "${lpt:-0}" "$(esc "$lps")" "${port:-0}" "$(esc "$v")" "$now" >> "$st"
done < "$LEASES"
echo "COMMIT;" >> "$st"
sqlite3 -cmd '.timeout 5000' "$DB" < "$st" 2>/dev/null; rm -f "$st"
SQL "DELETE FROM device_events WHERE ts < $((now-259200));"
exit 0
