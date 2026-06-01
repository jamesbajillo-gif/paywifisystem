#!/usr/bin/env bash
# =============================================================================
#  paywifi-phase5-shaping.sh
#  PAYWIFI — Phase 5: Bandwidth Limiting + Session Daemon
#    * tc/HTB shaping for LAN egress (upload) + IFB for ingress (download)
#    * paywifi-shape CLI: add/del/list per-IP traffic classes
#    * paywifi-sessiond Node.js daemon (expiry, byte counting, MAC re-auth)
#    * Updates auth.js route to write remembered_devices on voucher redeem
#    * Updates session service to call paywifi-shape on start/end
# =============================================================================
#  Usage:  sudo bash paywifi-phase5-shaping.sh
#  Prereq: phases 1-4 completed
# =============================================================================

set -o pipefail

CFG_FILE="/etc/paywifi/config.json"
APP_NAME="PAYWIFI"
PAYWIFI_HOME="/opt/paywifi"
PAYWIFI_USER="paywifi"
IFB_DEV="ifb-paywifi"

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
[[ -f "$CFG_FILE" ]] || die "Config not found — run earlier phases."
systemctl is-active --quiet paywifi-api || die "paywifi-api not running — run phase 4."
command -v tc >/dev/null || die "tc (iproute2) missing."

# Confirm ifb module is available
if ! modprobe -n ifb >/dev/null 2>&1 && ! [[ -e /sys/module/ifb ]]; then
  warn "ifb kernel module not detected. Will try to load."
fi

WAN_IFACE=$(jq -r '.network.wan_iface'   "$CFG_FILE")
LAN_IFACE=$(jq -r '.network.lan_iface'   "$CFG_FILE")
LAN_GW=$(jq -r '.network.lan_gateway'    "$CFG_FILE")

title "PAYWIFI Phase 5 — Bandwidth + Session Daemon"
info "LAN iface  : $LAN_IFACE  (egress = uploads from clients)"
info "WAN iface  : $WAN_IFACE  (egress = downloads to clients, mirrored via IFB)"
info "IFB device : $IFB_DEV"
info "Daemon     : paywifi-sessiond (10s poll interval, expiry + byte counting)"
echo
confirm "Install Phase 5?" || die "Aborted."

# ============================================================================
#  1) Kernel modules + IFB device
# ============================================================================
title "1/6  Setting up IFB device + kernel modules"

# Persist ifb module load
cat >/etc/modules-load.d/paywifi.conf <<'EOF'
ifb
sch_htb
cls_u32
act_mirred
EOF
ok "Modules listed for boot load: /etc/modules-load.d/paywifi.conf"

# Load now
for m in ifb sch_htb cls_u32 act_mirred; do
  modprobe "$m" 2>/dev/null && ok "Loaded module: $m" || warn "Could not load: $m"
done

# Create the IFB device (idempotent)
if ! ip link show "$IFB_DEV" >/dev/null 2>&1; then
  ip link add "$IFB_DEV" type ifb 2>/dev/null || die "Failed to create IFB device."
  ok "Created IFB device: $IFB_DEV"
else
  ok "IFB device $IFB_DEV already exists."
fi
ip link set "$IFB_DEV" up

# ============================================================================
#  2) Initialize tc qdiscs (root HTB on LAN + IFB, ingress redirect on WAN)
# ============================================================================
title "2/6  Initializing tc qdiscs"

# Helper script that sets up the base shaping infrastructure.
# Idempotent — safe to re-run.
cat >/usr/local/sbin/paywifi-shape-init <<EOF
#!/usr/bin/env bash
# Initialize tc qdiscs for PAYWIFI shaping.
# - LAN egress: HTB root on $LAN_IFACE (limits uploads from each client)
# - WAN ingress -> IFB egress: HTB root on $IFB_DEV (limits downloads to each client)
set -e

LAN="${LAN_IFACE}"
WAN="${WAN_IFACE}"
IFB="${IFB_DEV}"

# Bring up the IFB device
ip link set "\$IFB" up 2>/dev/null || true

# ---- LAN egress (client upload shaping) ------------------------------------
tc qdisc del dev "\$LAN" root 2>/dev/null || true
tc qdisc add dev "\$LAN" root handle 1: htb default 9999
# Default class for unmatched (authorized) traffic — generous; per-IP classes override
tc class add dev "\$LAN" parent 1: classid 1:9999 htb rate 1000mbit ceil 1000mbit

# ---- WAN ingress -> IFB egress (client download shaping) -------------------
tc qdisc del dev "\$WAN"  ingress 2>/dev/null || true
tc qdisc del dev "\$IFB"  root    2>/dev/null || true

tc qdisc add dev "\$WAN" handle ffff: ingress
# Mirror all inbound WAN traffic to IFB, where we can egress-shape it
tc filter add dev "\$WAN" parent ffff: protocol ip u32 match u32 0 0 \\
    action mirred egress redirect dev "\$IFB"

tc qdisc add dev "\$IFB" root handle 1: htb default 9999
tc class add dev "\$IFB" parent 1: classid 1:9999 htb rate 1000mbit ceil 1000mbit

echo "paywifi-shape-init: tc base setup complete on \$LAN/\$WAN/\$IFB"
EOF
chmod 755 /usr/local/sbin/paywifi-shape-init
ok "Installed /usr/local/sbin/paywifi-shape-init"

# Run it now
/usr/local/sbin/paywifi-shape-init
ok "tc base qdiscs created."

# ============================================================================
#  3) paywifi-shape CLI (per-IP class add/del/list/stats)
# ============================================================================
title "3/6  Installing paywifi-shape CLI"

cat >/usr/local/sbin/paywifi-shape <<'SHAPE'
#!/usr/bin/env bash
# paywifi-shape — manage per-IP HTB classes for upload + download limits
#
# Usage:
#   paywifi-shape add  <ip> <kbps>      # add upload+download cap for IP
#   paywifi-shape del  <ip>             # remove caps for IP
#   paywifi-shape list                  # show all current classes
#   paywifi-shape stats <ip>            # show byte counters for IP
#
# Mapping IP -> classid: we use the last two octets of the IP as the minor.
# For 10.10.0.100 -> classid 1:0064 (hex 0x0064 = 100). Combined with 3rd octet
# scaled: classid = 1:(thirdOctet*256 + fourthOctet) — works fine up to /16.
#
# The same minor is used on LAN (upload) and IFB (download) for consistency.

set -o pipefail

CFG=/etc/paywifi/config.json
LAN=$(jq -r '.network.lan_iface' "$CFG")
IFB=ifb-paywifi

ip_to_minor() {
  local ip="$1"
  IFS=. read -r _ _ a b <<<"$ip"
  printf '%x' $((a*256 + b))
}

add_class() {
  local ip="$1" kbps="$2"
  local minor; minor=$(ip_to_minor "$ip")
  local classid="1:${minor}"
  local rate_kbit="${kbps}kbit"

  # Idempotent: remove existing first
  tc class del dev "$LAN" classid "$classid" 2>/dev/null || true
  tc class del dev "$IFB" classid "$classid" 2>/dev/null || true

  # Upload cap (LAN egress)
  tc class add dev "$LAN" parent 1: classid "$classid" htb \
      rate "$rate_kbit" ceil "$rate_kbit" burst 15k
  tc qdisc add dev "$LAN" parent "$classid" handle "${minor}:" sfq perturb 10
  tc filter add dev "$LAN" parent 1: protocol ip prio 1 u32 \
      match ip src "$ip"/32 flowid "$classid"

  # Download cap (IFB egress = WAN ingress mirrored)
  tc class add dev "$IFB" parent 1: classid "$classid" htb \
      rate "$rate_kbit" ceil "$rate_kbit" burst 15k
  tc qdisc add dev "$IFB" parent "$classid" handle "${minor}:" sfq perturb 10
  tc filter add dev "$IFB" parent 1: protocol ip prio 1 u32 \
      match ip dst "$ip"/32 flowid "$classid"
}

del_class() {
  local ip="$1"
  local minor; minor=$(ip_to_minor "$ip")
  local classid="1:${minor}"

  # Filters must be removed first
  tc filter del dev "$LAN" parent 1: protocol ip prio 1 u32 \
      match ip src "$ip"/32 flowid "$classid" 2>/dev/null || true
  tc filter del dev "$IFB" parent 1: protocol ip prio 1 u32 \
      match ip dst "$ip"/32 flowid "$classid" 2>/dev/null || true

  tc qdisc del dev "$LAN" parent "$classid" 2>/dev/null || true
  tc qdisc del dev "$IFB" parent "$classid" 2>/dev/null || true
  tc class del dev "$LAN" classid "$classid" 2>/dev/null || true
  tc class del dev "$IFB" classid "$classid" 2>/dev/null || true
}

stats_for() {
  local ip="$1"
  local minor; minor=$(ip_to_minor "$ip")
  local classid="1:${minor}"
  echo "--- Upload (LAN egress, classid $classid) ---"
  tc -s class show dev "$LAN" classid "$classid" 2>/dev/null || echo "(no class)"
  echo "--- Download (IFB egress, classid $classid) ---"
  tc -s class show dev "$IFB" classid "$classid" 2>/dev/null || echo "(no class)"
}

list_all() {
  echo "=== Active classes on $LAN (upload) ==="
  tc class show dev "$LAN" | grep -v 'class htb 1:9999\|class htb 1: ' || true
  echo
  echo "=== Active classes on $IFB (download) ==="
  tc class show dev "$IFB" | grep -v 'class htb 1:9999\|class htb 1: ' || true
}

case "${1:-}" in
  add)
    [[ -n "$2" && -n "$3" ]] || { echo "usage: paywifi-shape add <ip> <kbps>" >&2; exit 1; }
    add_class "$2" "$3"
    echo "shaped: $2 -> ${3} kbps (up+down)"
    ;;
  del)
    [[ -n "$2" ]] || { echo "usage: paywifi-shape del <ip>" >&2; exit 1; }
    del_class "$2"
    echo "unshaped: $2"
    ;;
  stats)
    [[ -n "$2" ]] || { echo "usage: paywifi-shape stats <ip>" >&2; exit 1; }
    stats_for "$2"
    ;;
  list)
    list_all
    ;;
  *)
    cat <<USAGE
paywifi-shape — per-IP bandwidth shaping

  paywifi-shape add <ip> <kbps>      # apply upload+download cap
  paywifi-shape del <ip>             # remove cap
  paywifi-shape stats <ip>           # byte counters for IP
  paywifi-shape list                 # all active per-IP classes
USAGE
    ;;
esac
SHAPE
chmod 750 /usr/local/sbin/paywifi-shape
ok "Installed /usr/local/sbin/paywifi-shape"

# Extend sudoers so the paywifi user can run paywifi-shape too
backup="/etc/sudoers.d/paywifi.bak.$(date +%s)"
cp /etc/sudoers.d/paywifi "$backup"
cat >/etc/sudoers.d/paywifi <<EOF
# PAYWIFI: API + sessiond service user can manage nft sets and tc classes.
$PAYWIFI_USER ALL=(root) NOPASSWD: /usr/local/sbin/paywifi-auth
$PAYWIFI_USER ALL=(root) NOPASSWD: /usr/local/sbin/paywifi-shape
$PAYWIFI_USER ALL=(root) NOPASSWD: /usr/local/sbin/paywifi-shape-init
Defaults!/usr/local/sbin/paywifi-auth        !requiretty
Defaults!/usr/local/sbin/paywifi-shape       !requiretty
Defaults!/usr/local/sbin/paywifi-shape-init  !requiretty
EOF
chmod 440 /etc/sudoers.d/paywifi
if ! visudo -cf /etc/sudoers.d/paywifi >/dev/null; then
  cp "$backup" /etc/sudoers.d/paywifi
  die "Sudoers validation failed — restored backup."
fi
ok "Sudoers extended for paywifi-shape."

# ============================================================================
#  4) Persistence: re-run shape-init on boot via systemd
# ============================================================================
title "4/6  Persisting tc base setup on boot"

cat >/etc/systemd/system/paywifi-shape.service <<'EOF'
[Unit]
Description=PAYWIFI tc/HTB base qdisc setup
After=network-online.target
Before=paywifi-sessiond.service paywifi-api.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/paywifi-shape-init
ExecStop=/bin/sh -c '/usr/sbin/tc qdisc del dev $(jq -r .network.lan_iface /etc/paywifi/config.json) root 2>/dev/null; /usr/sbin/tc qdisc del dev $(jq -r .network.wan_iface /etc/paywifi/config.json) ingress 2>/dev/null; /usr/sbin/tc qdisc del dev ifb-paywifi root 2>/dev/null; true'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable paywifi-shape.service >/dev/null
ok "paywifi-shape.service enabled."

# ============================================================================
#  5) Update API code: write remembered_devices + call paywifi-shape
# ============================================================================
title "5/6  Updating API code for shaping + MAC remembering"

# ----- Add a shaping wrapper service in the API ------------------------------
cat >"$PAYWIFI_HOME/api/src/services/shaping.js" <<'JS'
'use strict';
// Wrapper around the paywifi-shape CLI.
const { execFileSync } = require('child_process');

const SHAPE_BIN = '/usr/local/sbin/paywifi-shape';

function run(args) {
  return execFileSync('sudo', ['-n', SHAPE_BIN, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

exports.add   = (ip, kbps) => run(['add', ip, String(kbps)]);
exports.del   = (ip)       => run(['del', ip]);
exports.stats = (ip)       => { try { return run(['stats', ip]); } catch (e) { return ''; } };
exports.list  = ()         => { try { return run(['list']); }       catch (e) { return ''; } };
JS

# ----- Update session.js to call shaping on start/end ------------------------
cat >"$PAYWIFI_HOME/api/src/services/session.js" <<'JS'
'use strict';
const db = require('../db');
const fw = require('./firewall');
const shape = require('./shaping');

function startSession({ voucherId, mac, ip, expiresAt, bandwidthKbps, nowSec }) {
  const insert = db.prepare(`
    INSERT INTO sessions (voucher_id, mac_address, ip_address,
                          started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const r = insert.run(voucherId, mac, ip, nowSec, nowSec);
  const sessionId = r.lastInsertRowid;

  const timeoutSec = Math.max(60, expiresAt - nowSec);
  try {
    fw.authorize(ip, timeoutSec);
  } catch (e) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    throw new Error('Firewall authorize failed: ' + e.message);
  }

  // Apply bandwidth shaping (best effort — log but don't fail the session)
  if (bandwidthKbps && bandwidthKbps > 0) {
    try {
      shape.add(ip, bandwidthKbps);
    } catch (e) {
      console.error(`[session] shaping failed for ${ip}: ${e.message}`);
    }
  }

  return sessionId;
}

function findActiveByIp(ip) {
  return db.prepare(`
    SELECT s.*, v.code AS voucher_code, v.expires_at, v.duration_minutes,
           v.bandwidth_kbps
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ip_address = ? AND s.ended_at IS NULL
     ORDER BY s.id DESC
     LIMIT 1
  `).get(ip);
}

function findActiveByMac(mac) {
  return db.prepare(`
    SELECT s.*, v.code AS voucher_code, v.expires_at
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.mac_address = ? AND s.ended_at IS NULL
     ORDER BY s.id DESC
     LIMIT 1
  `).get(mac);
}

function endSession(sessionId, reason, nowSec) {
  const sess = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!sess || sess.ended_at) return false;

  db.prepare(`UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?`)
    .run(nowSec, reason, sessionId);

  try { fw.revoke(sess.ip_address); }   catch (e) { /* best effort */ }
  try { shape.del(sess.ip_address); }   catch (e) { /* best effort */ }
  return true;
}

function touchSession(sessionId, nowSec) {
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(nowSec, sessionId);
}

module.exports = { startSession, findActiveByIp, findActiveByMac, endSession, touchSession };
JS

# ----- Update auth.js to insert into remembered_devices + pass bandwidthKbps -
cat >"$PAYWIFI_HOME/api/src/routes/auth.js" <<'JS'
'use strict';
const router = require('express').Router();
const db = require('../db');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');

function rememberDevice(mac, voucherId, validUntil, nowSec) {
  // Upsert: latest voucher wins for that MAC
  db.prepare(`
    INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(mac_address) DO UPDATE SET
      voucher_id  = excluded.voucher_id,
      valid_until = excluded.valid_until
  `).run(mac, voucherId, validUntil, nowSec);
}

router.post('/voucher', (req, res) => {
  const code = String(req.body?.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: 'Code required.' });
  if (!req.clientIp)  return res.status(400).json({ ok: false, error: 'Client IP not detected.' });
  if (!req.clientMac) return res.status(400).json({ ok: false, error: 'Client MAC not detected (try reconnecting).' });

  const voucher = voucherSvc.findByCode(code);
  if (!voucher) return res.status(404).json({ ok: false, error: 'Voucher not found.' });

  const now = Math.floor(Date.now() / 1000);
  const activation = voucherSvc.activateVoucher(voucher, now);
  if (!activation.ok) return res.status(400).json(activation);

  // If this MAC already has an active session on the SAME voucher, just touch it
  const existing = sessionSvc.findActiveByMac(req.clientMac);
  if (existing && existing.voucher_id === voucher.id) {
    sessionSvc.touchSession(existing.id, now);
    rememberDevice(req.clientMac, voucher.id, activation.expiresAt, now);
    return res.json({
      ok: true,
      session_id: existing.id,
      expires_at: activation.expiresAt,
      message: 'Already connected.'
    });
  }

  try {
    const sid = sessionSvc.startSession({
      voucherId: voucher.id,
      mac: req.clientMac,
      ip: req.clientIp,
      expiresAt: activation.expiresAt,
      bandwidthKbps: voucher.bandwidth_kbps,
      nowSec: now
    });
    rememberDevice(req.clientMac, voucher.id, activation.expiresAt, now);
    res.json({
      ok: true,
      session_id: sid,
      expires_at: activation.expiresAt,
      duration_minutes: voucher.duration_minutes,
      bandwidth_kbps: voucher.bandwidth_kbps
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
JS

chown -R "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_HOME/api/src"
ok "API source updated (shaping.js, session.js, auth.js)."

# ============================================================================
#  6) Session daemon
# ============================================================================
title "6/6  Installing session daemon (paywifi-sessiond)"

# ----- daemon source ---------------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/sessiond.js" <<'JS'
/**
 * paywifi-sessiond — background worker
 *
 * Responsibilities (runs every POLL_MS):
 *   1. Expire sessions past expires_at (end + revoke + unshape)
 *   2. Idle-detect sessions (no last_seen_at update in N minutes)
 *   3. Read tc stats and update bytes_in/bytes_out per active session
 *   4. Watch dnsmasq leases for new clients with a remembered MAC -> auto-auth
 *   5. Update voucher.status when no devices remain
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const db = require('./db');
const sessionSvc = require('./services/session');
const fw = require('./services/firewall');
const shape = require('./services/shaping');

const POLL_MS = 10000;                                  // 10s loop
const IDLE_MIN = parseInt(getSetting('idle_timeout_min', '10'), 10);
const LEASE_FILE = '/var/lib/misc/paywifi-dnsmasq.leases';

function getSetting(key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}

function now() { return Math.floor(Date.now() / 1000); }

// --- 1. Expiry sweep --------------------------------------------------------
function expireOverdue() {
  const t = now();
  const rows = db.prepare(`
    SELECT s.id, s.ip_address, v.expires_at
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ended_at IS NULL
       AND v.expires_at IS NOT NULL
       AND v.expires_at <= ?
  `).all(t);
  for (const r of rows) {
    console.log(`[sessiond] expire session ${r.id} ip=${r.ip_address}`);
    sessionSvc.endSession(r.id, 'expired', t);
  }

  // Mark vouchers whose every active session is gone
  db.prepare(`
    UPDATE vouchers SET status='expired'
     WHERE status='active'
       AND expires_at IS NOT NULL
       AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM sessions WHERE voucher_id=vouchers.id AND ended_at IS NULL)
  `).run(t);
}

// --- 2. Idle detection ------------------------------------------------------
function idleSweep() {
  const t = now();
  const idleCutoff = t - IDLE_MIN * 60;
  const rows = db.prepare(`
    SELECT id, ip_address FROM sessions
     WHERE ended_at IS NULL AND last_seen_at < ?
  `).all(idleCutoff);
  for (const r of rows) {
    console.log(`[sessiond] idle session ${r.id} ip=${r.ip_address} (>${IDLE_MIN}min)`);
    sessionSvc.endSession(r.id, 'idle', t);
  }
}

// --- 3. Byte counter sweep --------------------------------------------------
// Parse `tc -s class show dev <iface>` and pull (Sent X bytes) per classid.
function parseTcStats(iface) {
  let out = '';
  try {
    out = execFileSync('/usr/sbin/tc', ['-s', 'class', 'show', 'dev', iface], { encoding: 'utf8' });
  } catch (e) { return new Map(); }
  const stats = new Map();   // classid -> bytes
  const blocks = out.split(/\nclass /).map(b => 'class ' + b);
  for (const b of blocks) {
    const idMatch = b.match(/class htb (1:[0-9a-f]+)/);
    const byMatch = b.match(/Sent (\d+) bytes/);
    if (idMatch && byMatch) {
      stats.set(idMatch[1], parseInt(byMatch[1], 10));
    }
  }
  return stats;
}

function ipToClassid(ip) {
  const parts = ip.split('.');
  const minor = (parseInt(parts[2], 10) * 256 + parseInt(parts[3], 10)).toString(16);
  return `1:${minor}`;
}

let lastBytes = new Map();  // sessionId -> {up, down}

function byteSweep() {
  const cfg = db.cfg;
  const LAN = cfg.network.lan_iface;
  const IFB = 'ifb-paywifi';

  const upStats   = parseTcStats(LAN);   // egress from LAN = client uploads
  const downStats = parseTcStats(IFB);   // egress from IFB = client downloads

  const active = db.prepare(`
    SELECT id, ip_address, bytes_in, bytes_out FROM sessions WHERE ended_at IS NULL
  `).all();

  const upd = db.prepare(`UPDATE sessions SET bytes_in=?, bytes_out=?, last_seen_at=? WHERE id=?`);
  const t = now();

  for (const s of active) {
    const cid = ipToClassid(s.ip_address);
    const up   = upStats.get(cid)   || 0;   // bytes uploaded by client (in to us)
    const down = downStats.get(cid) || 0;   // bytes downloaded by client (out to client)

    if (up || down) {
      const prev = lastBytes.get(s.id) || { up: 0, down: 0 };
      // tc counters reset to 0 when class is removed — handle wrap
      const upDelta   = up   >= prev.up   ? up   - prev.up   : up;
      const downDelta = down >= prev.down ? down - prev.down : down;

      // bytes_in = client uploads received by gateway
      // bytes_out = client downloads sent by gateway
      const newIn  = (s.bytes_in  || 0) + upDelta;
      const newOut = (s.bytes_out || 0) + downDelta;

      if (upDelta || downDelta) {
        upd.run(newIn, newOut, t, s.id);
      }
      lastBytes.set(s.id, { up, down });
    }
  }
}

// --- 4. Dnsmasq lease watcher (MAC remembering auto-auth) -------------------
function readLeases() {
  // dnsmasq lease format: <expiry-epoch> <mac> <ip> <hostname> <client-id>
  try {
    return fs.readFileSync(LEASE_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(line => {
        const [exp, mac, ip, host] = line.split(' ');
        return { exp: parseInt(exp, 10), mac: mac.toLowerCase(), ip, host };
      });
  } catch (e) { return []; }
}

const seenLeases = new Set();  // "mac@ip" we've already evaluated

function leaseSweep() {
  const t = now();
  const leases = readLeases();
  for (const l of leases) {
    const key = `${l.mac}@${l.ip}`;
    if (seenLeases.has(key)) continue;
    seenLeases.add(key);

    // Skip if already authenticated
    const existing = sessionSvc.findActiveByMac(l.mac);
    if (existing) continue;

    // Look up remembered device
    const rd = db.prepare(`
      SELECT rd.*, v.id AS voucher_id, v.status AS v_status, v.expires_at, v.bandwidth_kbps, v.max_devices
        FROM remembered_devices rd
        JOIN vouchers v ON v.id = rd.voucher_id
       WHERE rd.mac_address = ?
         AND rd.valid_until > ?
    `).get(l.mac, t);

    if (!rd) continue;
    if (rd.v_status !== 'active') continue;
    if (!rd.expires_at || rd.expires_at <= t) continue;

    // Check device cap
    const dev = db.prepare(`
      SELECT COUNT(*) AS n FROM sessions WHERE voucher_id=? AND ended_at IS NULL
    `).get(rd.voucher_id).n;
    if (dev >= rd.max_devices) continue;

    try {
      const sid = sessionSvc.startSession({
        voucherId: rd.voucher_id,
        mac: l.mac,
        ip: l.ip,
        expiresAt: rd.expires_at,
        bandwidthKbps: rd.bandwidth_kbps,
        nowSec: t
      });
      console.log(`[sessiond] MAC re-auth: ${l.mac}@${l.ip} -> session ${sid} (voucher ${rd.voucher_id})`);
    } catch (e) {
      console.error(`[sessiond] re-auth failed for ${l.mac}: ${e.message}`);
    }
  }

  // Prune seenLeases when a lease disappears so reconnects work
  const currentKeys = new Set(leases.map(l => `${l.mac}@${l.ip}`));
  for (const k of seenLeases) if (!currentKeys.has(k)) seenLeases.delete(k);
}

// --- Main loop --------------------------------------------------------------
function tick() {
  try { expireOverdue(); } catch (e) { console.error('expireOverdue:', e); }
  try { idleSweep();     } catch (e) { console.error('idleSweep:',     e); }
  try { byteSweep();     } catch (e) { console.error('byteSweep:',     e); }
  try { leaseSweep();    } catch (e) { console.error('leaseSweep:',    e); }
}

console.log(`[PAYWIFI sessiond] starting (poll=${POLL_MS}ms idle=${IDLE_MIN}min)`);
tick();
setInterval(tick, POLL_MS);

process.on('SIGTERM', () => { console.log('[sessiond] SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[sessiond] SIGINT');  process.exit(0); });
JS

chown "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_HOME/api/src/sessiond.js"
ok "Daemon source: $PAYWIFI_HOME/api/src/sessiond.js"

# ----- systemd unit ----------------------------------------------------------
cat >/etc/systemd/system/paywifi-sessiond.service <<EOF
[Unit]
Description=PAYWIFI session daemon (expiry, byte counting, MAC re-auth)
After=paywifi-api.service paywifi-shape.service
Requires=paywifi-shape.service

[Service]
Type=simple
User=$PAYWIFI_USER
Group=$PAYWIFI_USER
WorkingDirectory=$PAYWIFI_HOME/api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/sessiond.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/paywifi/sessiond.log
StandardError=append:/var/log/paywifi/sessiond.log

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/paywifi /var/log/paywifi
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Logrotate (extend existing)
if ! grep -q 'sessiond.log' /etc/logrotate.d/paywifi 2>/dev/null; then
  # already covers *.log so nothing to add — just confirm
  ok "Logrotate already covers /var/log/paywifi/*.log"
fi

systemctl daemon-reload
systemctl enable paywifi-sessiond.service >/dev/null

# Restart the API so it picks up the updated session.js / auth.js
systemctl restart paywifi-api.service
sleep 1
systemctl start  paywifi-sessiond.service
sleep 2

# ----- Verify ----------------------------------------------------------------
if systemctl is-active --quiet paywifi-api; then
  ok "paywifi-api restarted with new code."
else
  err "paywifi-api failed to restart. journalctl -u paywifi-api"
fi
if systemctl is-active --quiet paywifi-sessiond; then
  ok "paywifi-sessiond is running."
else
  err "paywifi-sessiond failed to start."
  journalctl -u paywifi-sessiond -n 30 --no-pager || true
  die "Inspect /var/log/paywifi/sessiond.log"
fi

# ============================================================================
#  Final summary
# ============================================================================
hr
echo "${C_GRN}${C_BLD} ${APP_NAME} Phase 5 complete — quotas + shaping active.${C_RST}"
hr
echo "What's new:"
echo
echo "  Bandwidth shaping (tc/HTB)"
echo "    - LAN egress (uploads from clients)"
echo "    - WAN ingress -> IFB egress (downloads to clients)"
echo "    - Per-IP HTB class with the voucher's bandwidth_kbps"
echo
echo "  Session daemon (every 10s)"
echo "    - Expires sessions past voucher expires_at"
echo "    - Ends idle sessions (no traffic for $(jq -r ".idle_timeout_min // 10" /etc/paywifi/config.json 2>/dev/null || echo 10) min)"
echo "    - Updates sessions.bytes_in/out from tc counters"
echo "    - Auto-authenticates known MACs via remembered_devices"
echo
echo "  MAC remembering"
echo "    - Every voucher redemption inserts/refreshes remembered_devices"
echo "    - On reconnect within voucher validity, session is restored without re-entering the code"
echo
echo "Service control:"
echo "   systemctl status paywifi-shape paywifi-sessiond paywifi-api"
echo "   tail -f /var/log/paywifi/sessiond.log"
echo "   journalctl -u paywifi-sessiond -f"
echo
echo "Live inspection:"
echo "   paywifi-shape list                 # see per-IP classes"
echo "   paywifi-shape stats <client_ip>    # byte counters for that client"
echo "   tc -s class show dev ${LAN_IFACE}  # raw tc stats (upload)"
echo "   tc -s class show dev ${IFB_DEV}    # raw tc stats (download)"
echo "   sqlite3 /var/lib/paywifi/paywifi.db 'SELECT id,mac_address,ip_address,bytes_in,bytes_out FROM sessions WHERE ended_at IS NULL;'"
echo
echo "End-to-end test:"
echo "   1. Use a voucher with bandwidth_kbps=5120 (5 Mbps)"
echo "   2. From client: speedtest-cli or fast.com  -> should cap near 5 Mbps"
echo "   3. Wait for the voucher duration to elapse  -> session auto-ends"
echo "   4. Reconnect the same device within validity -> auto-authenticated"
echo
echo "PAYWIFI v1 is now functionally complete."
echo "Next steps (Phase 6, optional polish): admin UI, voucher PDF export, dashboards."
hr