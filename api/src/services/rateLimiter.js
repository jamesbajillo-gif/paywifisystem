'use strict';
// ── In-memory + DB-backed per-device payment rate limiter ─────────────────────
// All thresholds are stored in the settings table and configurable via admin UI.

const db = require('../db');

// ── Ensure DB table exists ────────────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS payment_rate_limit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_key TEXT    NOT NULL,
    client_mac TEXT,
    client_ip  TEXT,
    attempt_at INTEGER NOT NULL,
    cleared_at INTEGER,
    cleared_by TEXT
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_prl_key     ON payment_rate_limit_log(device_key)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_prl_attempt ON payment_rate_limit_log(attempt_at)`).run();

// ── Seed default config into settings if not present ─────────────────────────
const _RL_DEFS = { rl_window_min: 15, rl_max_attempts: 3, rl_gap_sec: 15, rl_cancel_cooldown_sec: 15 };
const _now = Math.floor(Date.now()/1000);
const _ins = db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
for (const [k, v] of Object.entries(_RL_DEFS)) _ins.run(k, String(v), _now);

// ── Dynamic config reader (reads DB on every call — cheap for SQLite) ─────────
function getRlCfg() {
  function _g(key, def) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    const n = row ? parseInt(row.value, 10) : NaN;
    return isNaN(n) || n < 0 ? def : n;
  }
  const win_min  = Math.max(1, _g('rl_window_min',          _RL_DEFS.rl_window_min));
  const max      = Math.max(1, _g('rl_max_attempts',         _RL_DEFS.rl_max_attempts));
  const gap      = _g('rl_gap_sec',              _RL_DEFS.rl_gap_sec);
  const cooldown = _g('rl_cancel_cooldown_sec',  _RL_DEFS.rl_cancel_cooldown_sec);
  return { win_sec: win_min * 60, win_min, max, gap, cooldown };
}

// ── Save config to settings table ────────────────────────────────────────────
function rlSaveCfg(vals) {
  const _ts  = Math.floor(Date.now() / 1000);
  const upd  = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
  const cl   = (v, lo, hi, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(hi, Math.max(lo, n)); };
  if (vals.rl_window_min          !== undefined) upd.run('rl_window_min',         String(cl(vals.rl_window_min,         1,  1440, _RL_DEFS.rl_window_min)),         _ts);
  if (vals.rl_max_attempts        !== undefined) upd.run('rl_max_attempts',        String(cl(vals.rl_max_attempts,       1,    50, _RL_DEFS.rl_max_attempts)),        _ts);
  if (vals.rl_gap_sec             !== undefined) upd.run('rl_gap_sec',             String(cl(vals.rl_gap_sec,            0,  3600, _RL_DEFS.rl_gap_sec)),             _ts);
  if (vals.rl_cancel_cooldown_sec !== undefined) upd.run('rl_cancel_cooldown_sec', String(cl(vals.rl_cancel_cooldown_sec,0,  3600, _RL_DEFS.rl_cancel_cooldown_sec)), _ts);
}

// ── In-memory attempt store ───────────────────────────────────────────────────
const _rl = new Map();

// Restore active in-memory state from DB on startup
(function _restore() {
  const cfg = getRlCfg();
  const win = Math.floor(Date.now() / 1000) - cfg.win_sec;
  const rows = db.prepare(
    'SELECT device_key, attempt_at FROM payment_rate_limit_log WHERE attempt_at > ? AND cleared_at IS NULL ORDER BY attempt_at ASC'
  ).all(win);
  for (const r of rows) {
    const h = _rl.get(r.device_key) || [];
    h.push(r.attempt_at);
    _rl.set(r.device_key, h);
  }
})();

// ── Core helpers ──────────────────────────────────────────────────────────────
function rlKey(mac, ip) { return mac || ip || null; }

function rlCheck(mac, ip, now) {
  const k = rlKey(mac, ip); if (!k) return { ok: true };
  const { win_sec, max, gap } = getRlCfg();
  const h = (_rl.get(k) || []).filter(t => t > now - win_sec);
  if (h.length >= max) {
    const s = [...h].sort((a, b) => a - b);
    const lu = s[s.length - max] + win_sec;
    if (lu > now) return { ok: false, reason: 'locked', retry_after: Math.ceil(lu - now) };
  }
  if (h.length > 0 && gap > 0) {
    const elapsed = now - Math.max(...h);
    if (elapsed < gap) return { ok: false, reason: 'too_soon', retry_after: Math.ceil(gap - elapsed) };
  }
  return { ok: true };
}

function rlRecord(mac, ip, now) {
  const k = rlKey(mac, ip); if (!k) return;
  const { win_sec } = getRlCfg();
  const h = (_rl.get(k) || []).filter(t => t > now - win_sec);
  h.push(now); _rl.set(k, h);
  try {
    db.prepare('INSERT INTO payment_rate_limit_log (device_key,client_mac,client_ip,attempt_at) VALUES (?,?,?,?)')
      .run(k, mac || null, ip || null, now);
  } catch (e) { /* non-fatal */ }
}

function rlClear(key, clearedBy) {
  _rl.delete(key);
  try {
    db.prepare('UPDATE payment_rate_limit_log SET cleared_at=?,cleared_by=? WHERE device_key=? AND cleared_at IS NULL')
      .run(Math.floor(Date.now() / 1000), clearedBy || 'admin', key);
  } catch (e) {}
}

function rlClearAll(clearedBy) {
  _rl.clear();
  try {
    db.prepare('UPDATE payment_rate_limit_log SET cleared_at=?,cleared_by=? WHERE cleared_at IS NULL')
      .run(Math.floor(Date.now() / 1000), clearedBy || 'admin');
  } catch (e) {}
}

function rlList(now) {
  const cfg = getRlCfg();
  const win = now - cfg.win_sec;
  const dbRows = db.prepare(`
    SELECT device_key,
           MAX(client_mac) AS client_mac,
           MAX(client_ip)  AS client_ip,
           COUNT(*)        AS attempts,
           MAX(attempt_at) AS last_attempt,
           MIN(attempt_at) AS oldest_attempt
    FROM payment_rate_limit_log
    WHERE attempt_at > ? AND cleared_at IS NULL
    GROUP BY device_key
    ORDER BY last_attempt DESC
  `).all(win);

  return dbRows.map(r => {
    const locked      = r.attempts >= cfg.max;
    const unlock_at   = locked ? r.oldest_attempt + cfg.win_sec : null;
    const retry_after = locked && unlock_at > now ? Math.ceil(unlock_at - now) : 0;
    const too_soon    = !locked && cfg.gap > 0 && (now - r.last_attempt) < cfg.gap;

    let last_payment = null;
    try {
      last_payment = db.prepare(`
        SELECT p.id, p.amount, p.status, p.created_at, p.channel_name,
               vp.name AS plan_name
        FROM pending_payments p
        JOIN voucher_plans vp ON vp.id = p.plan_id
        WHERE p.client_mac = ? OR p.client_ip = ?
        ORDER BY p.created_at DESC LIMIT 1
      `).get(r.client_mac || '__', r.client_ip || '__');
    } catch (e) {}

    return {
      key: r.device_key, client_mac: r.client_mac, client_ip: r.client_ip,
      attempts: r.attempts, locked, too_soon, unlock_at, retry_after,
      last_attempt: r.last_attempt, last_payment,
    };
  });
}

module.exports = { getRlCfg, rlSaveCfg, rlKey, rlCheck, rlRecord, rlClear, rlClearAll, rlList };
