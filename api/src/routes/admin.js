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

  // SYNC-04: remove remembered_devices for this voucher so devices can't auto-reconnect
  db.prepare('DELETE FROM remembered_devices WHERE voucher_id=?').run(id);

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
