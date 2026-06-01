#!/usr/bin/env bash
# =============================================================================
#  paywifi-phase4-api.sh
#  PAYWIFI — Phase 4: Node.js API
#    * Express + better-sqlite3 + jsonwebtoken + bcryptjs
#    * Routes: portal, auth (voucher), session, admin
#    * Firewall service shells out to paywifi-auth CLI
#    * Sudoers entry: paywifi user can run paywifi-auth without password
#    * systemd unit: paywifi-api.service (runs as paywifi user)
# =============================================================================
#  Usage:  sudo bash paywifi-phase4-api.sh
#  Prereq: phases 1, 2, 3 completed
# =============================================================================

set -o pipefail

CFG_FILE="/etc/paywifi/config.json"
APP_NAME="PAYWIFI"
PAYWIFI_HOME="/opt/paywifi"
PAYWIFI_USER="paywifi"

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
[[ -f "$CFG_FILE" ]] || die "Config not found at $CFG_FILE — run phase 1."
command -v node     >/dev/null || die "Node.js missing — run phase 1."
command -v sqlite3  >/dev/null || die "sqlite3 missing — run phase 1."
[[ -x /usr/local/sbin/paywifi-auth ]] || die "paywifi-auth helper missing — run phase 3."
id "$PAYWIFI_USER" >/dev/null || die "User '$PAYWIFI_USER' missing — run phase 1."

API_PORT=$(jq -r '.api.port' "$CFG_FILE")

title "PAYWIFI Phase 4 — Node.js API"
info "App root  : $PAYWIFI_HOME/api"
info "Run as    : $PAYWIFI_USER"
info "Port      : $API_PORT (proxied at /api by nginx)"
echo
confirm "Install API now?" || die "Aborted."

# ============================================================================
#  1) package.json + npm install
# ============================================================================
title "1/6  Installing Node.js dependencies"

cat >"$PAYWIFI_HOME/api/package.json" <<'JSON'
{
  "name": "paywifi-api",
  "version": "1.0.0",
  "description": "PAYWIFI captive portal backend",
  "main": "src/server.js",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^11.3.0",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "cookie-parser": "^1.4.6"
  }
}
JSON
ok "Wrote package.json"

cd "$PAYWIFI_HOME/api"
sudo -u "$PAYWIFI_USER" npm install --omit=dev --silent \
  || die "npm install failed."
ok "Dependencies installed."

# ============================================================================
#  2) Source code
# ============================================================================
title "2/6  Writing API source"

# ---- src/db.js -------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/db.js" <<'JS'
'use strict';
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const cfg = JSON.parse(fs.readFileSync('/etc/paywifi/config.json', 'utf8'));
const db  = new Database(cfg.database.path);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
module.exports.cfg = cfg;
JS

# ---- src/services/mac.js ---------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/services/mac.js" <<'JS'
'use strict';
// Resolve a client IP to its MAC address using /proc/net/arp.
// If not present in ARP cache, attempt to ping it to populate.
const fs   = require('fs');
const { execSync } = require('child_process');

function readArp() {
  // Format: IP HWtype Flags HWaddress Mask Device
  const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
  const map = new Map();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [ip, , flags, mac] = cols;
    if (mac && mac !== '00:00:00:00:00:00' && flags !== '0x0') {
      map.set(ip, mac.toLowerCase());
    }
  }
  return map;
}

function macForIp(ip) {
  let arp = readArp();
  if (arp.has(ip)) return arp.get(ip);
  // try to poke the ARP cache
  try { execSync(`ping -c1 -W1 ${ip}`, { stdio: 'ignore' }); } catch (e) {}
  arp = readArp();
  return arp.get(ip) || null;
}

module.exports = { macForIp };
JS

# ---- src/services/firewall.js ----------------------------------------------
cat >"$PAYWIFI_HOME/api/src/services/firewall.js" <<'JS'
'use strict';
// Wrapper around the paywifi-auth CLI (which manages nft sets).
const { execFileSync } = require('child_process');

const AUTH_BIN = '/usr/local/sbin/paywifi-auth';

function run(args) {
  return execFileSync('sudo', ['-n', AUTH_BIN, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

exports.authorize = (ip, timeoutSeconds) => {
  const args = ['add', ip];
  if (timeoutSeconds) args.push(String(timeoutSeconds));
  return run(args);
};

exports.revoke = (ip) => run(['del', ip]);

exports.list = () => {
  try { return run(['list']); } catch (e) { return ''; }
};

exports.flush = () => run(['flush']);
JS

# ---- src/services/voucher.js -----------------------------------------------
cat >"$PAYWIFI_HOME/api/src/services/voucher.js" <<'JS'
'use strict';
const db = require('../db');
const crypto = require('crypto');

const VOUCHER_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1

function generateCode(length = 8) {
  let s = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    s += VOUCHER_CHARSET[bytes[i] % VOUCHER_CHARSET.length];
  }
  return s;
}

function findByCode(code) {
  return db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
}

function activateVoucher(voucher, nowSec) {
  if (voucher.status !== 'unused' && voucher.status !== 'active') {
    return { ok: false, error: `Voucher is ${voucher.status}.` };
  }

  // First use: lock in expiry
  let expiresAt = voucher.expires_at;
  if (voucher.status === 'unused') {
    expiresAt = nowSec + voucher.duration_minutes * 60;
    db.prepare(`
      UPDATE vouchers
         SET status='active', first_used_at=?, expires_at=?
       WHERE id=?
    `).run(nowSec, expiresAt, voucher.id);
  } else if (expiresAt && expiresAt < nowSec) {
    db.prepare("UPDATE vouchers SET status='expired' WHERE id=?").run(voucher.id);
    return { ok: false, error: 'Voucher expired.' };
  }

  // Check device cap
  const activeDevices = db.prepare(`
    SELECT COUNT(*) AS n FROM sessions
     WHERE voucher_id=? AND ended_at IS NULL
  `).get(voucher.id).n;

  if (activeDevices >= voucher.max_devices) {
    return { ok: false, error: `Device limit reached (${voucher.max_devices}).` };
  }

  return { ok: true, expiresAt };
}

module.exports = { generateCode, findByCode, activateVoucher };
JS

# ---- src/services/session.js -----------------------------------------------
cat >"$PAYWIFI_HOME/api/src/services/session.js" <<'JS'
'use strict';
const db = require('../db');
const fw = require('./firewall');

function startSession({ voucherId, mac, ip, expiresAt, nowSec }) {
  const insert = db.prepare(`
    INSERT INTO sessions (voucher_id, mac_address, ip_address,
                          started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const r = insert.run(voucherId, mac, ip, nowSec, nowSec);

  // Authorize at firewall — timeout in seconds until voucher expiry
  const timeoutSec = Math.max(60, expiresAt - nowSec);
  try {
    fw.authorize(ip, timeoutSec);
  } catch (e) {
    // rollback session row on firewall failure
    db.prepare('DELETE FROM sessions WHERE id=?').run(r.lastInsertRowid);
    throw new Error('Firewall authorize failed: ' + e.message);
  }

  return r.lastInsertRowid;
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

  db.prepare(`
    UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?
  `).run(nowSec, reason, sessionId);

  try { fw.revoke(sess.ip_address); } catch (e) { /* best effort */ }
  return true;
}

function touchSession(sessionId, nowSec) {
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(nowSec, sessionId);
}

module.exports = { startSession, findActiveByIp, findActiveByMac, endSession, touchSession };
JS

# ---- src/middleware/clientInfo.js ------------------------------------------
cat >"$PAYWIFI_HOME/api/src/middleware/clientInfo.js" <<'JS'
'use strict';
const { macForIp } = require('../services/mac');

// Resolve the client's real IP (nginx forwards via X-Real-IP) and MAC.
module.exports = function clientInfo(req, res, next) {
  const xri = req.headers['x-real-ip'];
  const xff = req.headers['x-forwarded-for'];
  const ip = (xri || (xff || '').split(',')[0].trim() || req.ip || '').replace(/^::ffff:/, '');
  req.clientIp = ip;
  req.clientMac = macForIp(ip);
  next();
};
JS

# ---- src/middleware/auth.js ------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/middleware/auth.js" <<'JS'
'use strict';
const jwt = require('jsonwebtoken');
const { cfg } = require('../db');

module.exports = function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.cookies?.paywifi_admin;
  if (!token) return res.status(401).json({ ok: false, error: 'Auth required.' });
  try {
    req.admin = jwt.verify(token, cfg.api.jwt_secret);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid token.' });
  }
};
JS

# ---- src/routes/portal.js --------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/routes/portal.js" <<'JS'
'use strict';
const router = require('express').Router();
const db = require('../db');

router.get('/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    ok: true,
    app: db.cfg.app,
    branding: {
      portal_name:  settings.portal_name  || 'PAYWIFI',
      brand_color:  settings.portal_brand_color || '#0ea5e9',
      terms_url:    settings.portal_terms_url   || '/terms.html'
    },
    voucher: {
      length: parseInt(settings.voucher_code_length || '8', 10),
      format: settings.voucher_code_format || 'alnum_upper'
    }
  });
});

module.exports = router;
JS

# ---- src/routes/auth.js ----------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/routes/auth.js" <<'JS'
'use strict';
const router = require('express').Router();
const db = require('../db');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');

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
      nowSec: now
    });
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

# ---- src/routes/session.js -------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/routes/session.js" <<'JS'
'use strict';
const router = require('express').Router();
const sessionSvc = require('../services/session');

router.get('/status', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const s = sessionSvc.findActiveByIp(req.clientIp);
  if (!s) return res.json({ ok: true, authenticated: false });

  const remaining = Math.max(0, (s.expires_at || 0) - now);
  res.json({
    ok: true,
    authenticated: true,
    voucher_code: s.voucher_code,
    started_at:   s.started_at,
    expires_at:   s.expires_at,
    remaining_seconds: remaining,
    bandwidth_kbps: s.bandwidth_kbps,
    bytes_in:  s.bytes_in,
    bytes_out: s.bytes_out
  });
});

router.post('/logout', (req, res) => {
  const s = sessionSvc.findActiveByIp(req.clientIp);
  if (!s) return res.json({ ok: true, message: 'No active session.' });
  const now = Math.floor(Date.now() / 1000);
  sessionSvc.endSession(s.id, 'logout', now);
  res.json({ ok: true, message: 'Logged out.' });
});

module.exports = router;
JS

# ---- src/routes/admin.js ---------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/routes/admin.js" <<'JS'
'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');
const requireAdmin = require('../middleware/auth');

const { cfg } = db;

function audit(adminId, action, details, ip) {
  db.prepare(`
    INSERT INTO audit_log (admin_id, action, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId || null, action, details || null, ip || null, Math.floor(Date.now()/1000));
}

// ---- Login (public) --------------------------------------------------------
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(now, user.id);

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    cfg.api.jwt_secret,
    { expiresIn: (cfg.api.jwt_expiry_hours || 12) + 'h' }
  );
  audit(user.id, 'admin_login', null, req.clientIp);
  res.json({ ok: true, token, expires_in_hours: cfg.api.jwt_expiry_hours || 12, user: { id: user.id, username: user.username, role: user.role } });
});

// ---- Everything below requires admin token ---------------------------------
router.use(requireAdmin);

// ---- Voucher plans ---------------------------------------------------------
router.get('/plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM voucher_plans WHERE is_active=1 ORDER BY duration_minutes').all();
  res.json({ ok: true, plans: rows });
});

// ---- Vouchers --------------------------------------------------------------
router.get('/vouchers', (req, res) => {
  const status = req.query.status;
  const limit  = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  let sql = 'SELECT * FROM vouchers';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  res.json({ ok: true, vouchers: db.prepare(sql).all(...params) });
});

router.post('/vouchers', (req, res) => {
  const { duration_minutes, bandwidth_kbps, max_devices = 1, count = 1, batch_name } = req.body || {};
  if (!duration_minutes || !bandwidth_kbps)
    return res.status(400).json({ ok: false, error: 'duration_minutes and bandwidth_kbps required.' });

  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 500);
  const now = Math.floor(Date.now() / 1000);

  let batchId = null;
  if (batch_name) {
    const b = db.prepare(`
      INSERT INTO voucher_batches (name, created_by, created_at) VALUES (?, ?, ?)
    `).run(batch_name, req.admin.sub, now);
    batchId = b.lastInsertRowid;
  }

  const codeLen = parseInt(db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get()?.value || '8', 10);
  const ins = db.prepare(`
    INSERT INTO vouchers (code, batch_id, duration_minutes, bandwidth_kbps, max_devices, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'unused', ?)
  `);

  const codes = [];
  const txn = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      // Retry on rare collision
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = voucherSvc.generateCode(codeLen);
        try {
          ins.run(code, batchId, duration_minutes, bandwidth_kbps, max_devices, now);
          codes.push(code);
          break;
        } catch (e) {
          if (attempt === 4) throw e;
        }
      }
    }
  });
  txn();

  audit(req.admin.sub, 'voucher_create', `count=${n} duration=${duration_minutes}min bw=${bandwidth_kbps}kbps`, req.clientIp);
  res.json({ ok: true, batch_id: batchId, count: codes.length, codes });
});

router.delete('/vouchers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(id);
  if (!v) return res.status(404).json({ ok: false, error: 'Not found.' });

  db.prepare("UPDATE vouchers SET status='revoked' WHERE id=?").run(id);

  // End any active sessions on this voucher
  const sessions = db.prepare("SELECT id FROM sessions WHERE voucher_id=? AND ended_at IS NULL").all(id);
  const now = Math.floor(Date.now() / 1000);
  for (const s of sessions) sessionSvc.endSession(s.id, 'kicked', now);

  audit(req.admin.sub, 'voucher_revoke', `id=${id} code=${v.code}`, req.clientIp);
  res.json({ ok: true });
});

// ---- Sessions --------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const active = req.query.active === 'false' ? false : true;
  const limit  = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  const sql = `
    SELECT s.*, v.code AS voucher_code, v.duration_minutes, v.bandwidth_kbps
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     ${active ? 'WHERE s.ended_at IS NULL' : ''}
     ORDER BY s.id DESC LIMIT ?
  `;
  res.json({ ok: true, sessions: db.prepare(sql).all(limit) });
});

router.delete('/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!sessionSvc.endSession(id, 'kicked', now))
    return res.status(404).json({ ok: false, error: 'Session not found or already ended.' });
  audit(req.admin.sub, 'session_kick', `id=${id}`, req.clientIp);
  res.json({ ok: true });
});

// ---- Reports ---------------------------------------------------------------
router.get('/reports/usage', (req, res) => {
  const sinceHours = parseInt(req.query.hours || '24', 10);
  const since = Math.floor(Date.now()/1000) - sinceHours * 3600;
  const r = db.prepare(`
    SELECT
      COUNT(*)                              AS total_sessions,
      SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS active_sessions,
      COALESCE(SUM(bytes_in), 0)            AS bytes_in,
      COALESCE(SUM(bytes_out), 0)           AS bytes_out
    FROM sessions
    WHERE started_at >= ?
  `).get(since);
  const v = db.prepare(`
    SELECT
      SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END)  AS unused,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END)  AS active,
      SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revoked
    FROM vouchers
  `).get();
  res.json({ ok: true, since_hours: sinceHours, sessions: r, vouchers: v });
});

// ---- Audit log -------------------------------------------------------------
router.get('/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  res.json({ ok: true, entries: db.prepare(`
    SELECT a.*, u.username
      FROM audit_log a LEFT JOIN admin_users u ON u.id = a.admin_id
     ORDER BY a.id DESC LIMIT ?
  `).all(limit) });
});

module.exports = router;
JS

# ---- src/server.js ---------------------------------------------------------
cat >"$PAYWIFI_HOME/api/src/server.js" <<'JS'
'use strict';
const express      = require('express');
const cookieParser = require('cookie-parser');
const db           = require('./db');
const clientInfo   = require('./middleware/clientInfo');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(clientInfo);

// Simple request log
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} ip=${req.clientIp || '?'} mac=${req.clientMac || '?'}`);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, app: db.cfg.app.name, time: new Date().toISOString() }));

app.use('/portal',  require('./routes/portal'));
app.use('/auth',    require('./routes/auth'));
app.use('/session', require('./routes/session'));
app.use('/admin',   require('./routes/admin'));

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('ERR', err);
  res.status(500).json({ ok: false, error: err.message || 'Internal error.' });
});

const port = db.cfg.api.port || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`[PAYWIFI] API listening on 127.0.0.1:${port}`);
});
JS

# Ownership
chown -R "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_HOME/api"
ok "Source files written and owned by $PAYWIFI_USER."

# ============================================================================
#  3) Sudoers — let paywifi run paywifi-auth without password
# ============================================================================
title "3/6  Configuring sudoers for paywifi-auth"
cat >/etc/sudoers.d/paywifi <<EOF
# PAYWIFI: allow the API service user to manage nft sets via the helper CLI.
$PAYWIFI_USER ALL=(root) NOPASSWD: /usr/local/sbin/paywifi-auth
Defaults!/usr/local/sbin/paywifi-auth !requiretty
EOF
chmod 440 /etc/sudoers.d/paywifi

if visudo -cf /etc/sudoers.d/paywifi >/dev/null; then
  ok "Sudoers entry validated."
else
  rm -f /etc/sudoers.d/paywifi
  die "Sudoers file failed validation — refusing to install."
fi

# ============================================================================
#  4) systemd unit
# ============================================================================
title "4/6  Installing systemd unit paywifi-api.service"

cat >/etc/systemd/system/paywifi-api.service <<EOF
[Unit]
Description=PAYWIFI API (Node.js)
After=network-online.target nftables.service
Wants=network-online.target

[Service]
Type=simple
User=$PAYWIFI_USER
Group=$PAYWIFI_USER
WorkingDirectory=$PAYWIFI_HOME/api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/paywifi/api.log
StandardError=append:/var/log/paywifi/api.log

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/paywifi /var/log/paywifi
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
ok "Unit written."

# Logrotate
cat >/etc/logrotate.d/paywifi <<'EOF'
/var/log/paywifi/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 0640 paywifi paywifi
    sharedscripts
    postrotate
        systemctl reload nginx >/dev/null 2>&1 || true
        systemctl kill -s USR1 paywifi-api.service >/dev/null 2>&1 || true
    endscript
}
EOF
ok "Logrotate configured."

systemctl daemon-reload
systemctl enable paywifi-api.service >/dev/null
systemctl restart paywifi-api.service
sleep 2

if systemctl is-active --quiet paywifi-api; then
  ok "paywifi-api.service is running."
else
  err "paywifi-api.service failed to start."
  warn "Recent log:"
  journalctl -u paywifi-api -n 30 --no-pager || true
  die "Inspect /var/log/paywifi/api.log and re-run."
fi

# ============================================================================
#  5) Smoke tests
# ============================================================================
title "5/6  Smoke testing"

LAN_GW=$(jq -r '.network.lan_gateway' "$CFG_FILE")

# Health check via nginx
if HEALTH=$(curl -fsS "http://127.0.0.1/api/health" 2>&1); then
  ok "Health endpoint: $HEALTH"
else
  warn "Health check failed via nginx; trying direct port..."
  curl -fsS "http://127.0.0.1:${API_PORT}/health" \
    && ok "Direct port reachable (nginx config issue?)" \
    || err "API not reachable on port $API_PORT either."
fi

# Portal config check
if CONF=$(curl -fsS "http://127.0.0.1/api/portal/config" 2>&1); then
  ok "Portal config: $(echo "$CONF" | jq -c '.branding')"
fi

# Voucher endpoint should reject without code
if RESP=$(curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1/api/auth/voucher" 2>&1); then
  warn "Empty voucher unexpectedly accepted: $RESP"
else
  ok "Voucher endpoint correctly rejected empty request."
fi

# ============================================================================
#  6) Final summary
# ============================================================================
hr
echo "${C_GRN}${C_BLD} ${APP_NAME} Phase 4 complete — API is live.${C_RST}"
hr
echo "Endpoints (via nginx at http://${LAN_GW}/):"
echo "   GET  /api/health"
echo "   GET  /api/portal/config"
echo "   POST /api/auth/voucher           {\"code\":\"XXXX\"}"
echo "   GET  /api/session/status"
echo "   POST /api/session/logout"
echo "   POST /api/admin/login            {\"username\":..., \"password\":...}"
echo "   GET  /api/admin/vouchers         (Bearer token)"
echo "   POST /api/admin/vouchers         (Bearer token)"
echo "   GET  /api/admin/sessions"
echo "   GET  /api/admin/reports/usage"
echo "   GET  /api/admin/audit"
echo
echo "Service control:"
echo "   systemctl status paywifi-api"
echo "   journalctl -u paywifi-api -f"
echo "   tail -f /var/log/paywifi/api.log"
echo
echo "End-to-end test from a LAN client:"
echo "   1. Connect device to LAN, get DHCP lease."
echo "   2. Open a browser to any HTTP site -> redirected to portal."
echo "   3. Enter one of the seeded voucher codes:"
echo "      sqlite3 /var/lib/paywifi/paywifi.db \\"
echo "        'SELECT code FROM vouchers WHERE status=\"unused\" LIMIT 3;'"
echo "   4. Hit Connect -> firewall opens for that IP -> client can browse."
echo "   5. Verify on the VM: paywifi-auth list"
echo
echo "Admin login test (from anywhere on LAN):"
echo "   curl -X POST http://${LAN_GW}/api/admin/login \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '{\"username\":\"admin\",\"password\":\"YOUR_PASSWORD\"}'"
echo
echo "Next phase: Bandwidth limiting (tc/HTB) + Session daemon (expiry, byte counting, MAC remembering)."
hr