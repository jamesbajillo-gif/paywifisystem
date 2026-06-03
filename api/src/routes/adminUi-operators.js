'use strict';
// PAYWIFI-OPERATOR-ADMIN-2026-06-02 — admin CRUD for operators.
// Routes:
//   GET  /admin/operators                  list + per-op metrics
//   GET  /admin/operators/new              create form
//   POST /admin/operators/create           insert
//   GET  /admin/operators/:id              edit form + activity
//   POST /admin/operators/:id/update       update fields
//   POST /admin/operators/:id/status       suspend/activate/archive
//   POST /admin/operators/:id/password     admin resets password
//   POST /admin/operators/:id/unlock       clear lockout/failed-counter
const router = require('express').Router();
const db     = require('../db');
const bcrypt = require('bcryptjs');

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}

function audit(adminId, action, details, ip) {
  try {
    db.prepare('INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(adminId || null, action, (details || '').slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}

// 09xxxxxxxxx → 639xxxxxxxxx ; reject anything else
function normalizeMobile(input) {
  let s = String(input || '').replace(/[^\d]/g, '');
  if (/^09\d{9}$/.test(s)) return '63' + s.slice(1);
  if (/^639\d{9}$/.test(s)) return s;
  return null;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function operatorStats(opId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS gross,
           COUNT(*)                 AS paid_count,
           COALESCE(SUM(refund_amount),0) AS refunded
      FROM pending_payments
     WHERE status='paid' AND store_id=?`).get(opId);
  return r || { gross: 0, paid_count: 0, refunded: 0 };
}

// ── GET /admin/operators ────────────────────────────────────────────────────
router.get('/operators', requireAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT id, username, store_name, store_slug, mobile, email, status, commission_pct, " +
    "       failed_login_count, locked_until, last_login_at, last_login_ip, created_at, suspended_at " +
    "  FROM operators ORDER BY id ASC"
  ).all();

  const ops = rows.map(op => ({ ...op, stats: operatorStats(op.id) }));

  res.render('admin/operators', {
    title:  'Operators · PAYWIFI',
    active: 'operators',
    operators: ops,
    flash: req.session.opFlash || null,
  });
  delete req.session.opFlash;
});

// ── GET /admin/operators/new ────────────────────────────────────────────────
router.get('/operators/new', requireAdmin, (req, res) => {
  res.render('admin/operator-edit', {
    title:  'New operator · PAYWIFI',
    active: 'operators',
    isNew:  true,
    op: { commission_pct: 10, status: 'active' },
    err: req.session.opErr || null,
  });
  delete req.session.opErr;
});

// ── POST /admin/operators/create ────────────────────────────────────────────
router.post('/operators/create', requireAdmin, (req, res) => {
  const body = req.body || {};
  const username  = String(body.username || '').trim().toLowerCase();
  const password  = String(body.password || '');
  const storeName = String(body.store_name || '').trim().slice(0, 80);
  let   slug      = String(body.store_slug || '').trim().toLowerCase();
  const mobile    = normalizeMobile(body.mobile);
  const email     = String(body.email || '').trim().slice(0, 120) || null;
  const commission_pct = Math.max(0, Math.min(100, parseFloat(body.commission_pct || '10') || 10));
  const notes     = String(body.notes || '').trim().slice(0, 2000) || null;
  const status    = ['active','pending','suspended'].includes(body.status) ? body.status : 'active';

  const errs = [];
  if (!/^[a-z0-9_]{3,32}$/.test(username))  errs.push('Username must be 3-32 chars (a-z, 0-9, underscore).');
  if (password.length < 6)                  errs.push('Password must be at least 6 characters.');
  if (!storeName)                           errs.push('Store name is required.');
  if (mobile === null && body.mobile)       errs.push('Mobile must be 09xxxxxxxxx or 639xxxxxxxxx.');
  if (!slug) slug = slugify(storeName) || slugify(username);
  if (!/^[a-z0-9-]{2,32}$/.test(slug))      errs.push('Store slug must be 2-32 chars (a-z, 0-9, dash).');

  if (errs.length) {
    req.session.opErr = errs.join(' ');
    return res.redirect('/admin/operators/new');
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(
      "INSERT INTO operators " +
      "  (username, password_hash, store_name, store_slug, mobile, email, status, commission_pct, " +
      "   notes, is_active, created_at, updated_at, created_by) " +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      username, hash, storeName, slug, mobile, email, status, commission_pct,
      notes, status === 'active' ? 1 : 0, now, now, req.admin.id
    );
    audit(req.admin.id, 'operator_create', 'id=' + r.lastInsertRowid + ' username=' + username + ' status=' + status, req.clientIp);
    req.session.opFlash = { kind: 'ok', message: 'Operator "' + storeName + '" created.' };
    res.redirect('/admin/operators/' + r.lastInsertRowid);
  } catch (e) {
    const msg = /UNIQUE constraint failed: operators.username/.test(e.message)
      ? 'A user with that username already exists.'
      : /UNIQUE constraint failed: operators.store_slug/.test(e.message)
      ? 'A store with that slug already exists.'
      : 'Could not create operator: ' + e.message;
    req.session.opErr = msg;
    res.redirect('/admin/operators/new');
  }
});

// ── GET /admin/operators/:id ────────────────────────────────────────────────
router.get('/operators/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const op = db.prepare(
    "SELECT id, username, store_name, store_slug, mobile, email, status, commission_pct, notes, " +
    "       failed_login_count, locked_until, last_login_at, last_login_ip, created_at, suspended_at, suspended_by " +
    "  FROM operators WHERE id=?"
  ).get(id);
  if (!op) { req.session.opFlash = { kind: 'err', message: 'Operator not found.' }; return res.redirect('/admin/operators'); }

  const recent = db.prepare(
    "SELECT action, details, ip_address, created_at FROM audit_log " +
    " WHERE operator_id=? ORDER BY id DESC LIMIT 30"
  ).all(id);

  res.render('admin/operator-edit', {
    title:  op.store_name + ' · PAYWIFI',
    active: 'operators',
    isNew:  false,
    op,
    stats: operatorStats(id),
    recent,
    flash: req.session.opFlash || null,
    err:   req.session.opErr || null,
  });
  delete req.session.opFlash;
  delete req.session.opErr;
});

// ── POST /admin/operators/:id/update ────────────────────────────────────────
router.post('/operators/:id/update', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/admin/operators');
  const op = db.prepare('SELECT * FROM operators WHERE id=?').get(id);
  if (!op) { req.session.opFlash = { kind: 'err', message: 'Operator not found.' }; return res.redirect('/admin/operators'); }

  const body = req.body || {};
  const storeName = String(body.store_name || op.store_name).trim().slice(0, 80);
  const mobileRaw = (body.mobile || '').trim();
  const mobile    = mobileRaw === '' ? null : normalizeMobile(mobileRaw);
  const email     = String(body.email || '').trim().slice(0, 120) || null;
  const commission_pct = Math.max(0, Math.min(100, parseFloat(body.commission_pct || op.commission_pct) || op.commission_pct));
  const notes     = String(body.notes || '').trim().slice(0, 2000) || null;

  const errs = [];
  if (!storeName) errs.push('Store name is required.');
  if (mobileRaw && mobile === null) errs.push('Mobile must be 09xxxxxxxxx or 639xxxxxxxxx.');
  if (errs.length) {
    req.session.opErr = errs.join(' ');
    return res.redirect('/admin/operators/' + id);
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE operators SET store_name=?, mobile=?, email=?, commission_pct=?, notes=?, updated_at=? WHERE id=?"
  ).run(storeName, mobile, email, commission_pct, notes, now, id);

  audit(req.admin.id, 'operator_update', 'id=' + id + ' fields=name,mobile,email,commission,notes', req.clientIp);
  req.session.opFlash = { kind: 'ok', message: 'Saved.' };
  res.redirect('/admin/operators/' + id);
});

// ── POST /admin/operators/:id/status ────────────────────────────────────────
router.post('/operators/:id/status', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wanted = String((req.body || {}).status || '').toLowerCase();
  if (!['active','pending','suspended','archived'].includes(wanted)) {
    req.session.opFlash = { kind: 'err', message: 'Invalid status.' };
    return res.redirect('/admin/operators/' + id);
  }
  const op = db.prepare('SELECT * FROM operators WHERE id=?').get(id);
  if (!op) return res.redirect('/admin/operators');

  const now = Math.floor(Date.now() / 1000);
  const isActive = wanted === 'active' ? 1 : 0;
  const suspendedAt = wanted === 'suspended' ? now : null;
  const suspendedBy = wanted === 'suspended' ? req.admin.id : null;

  db.prepare(
    "UPDATE operators SET status=?, is_active=?, suspended_at=?, suspended_by=?, updated_at=? WHERE id=?"
  ).run(wanted, isActive, suspendedAt, suspendedBy, now, id);

  audit(req.admin.id, 'operator_status', 'id=' + id + ' from=' + op.status + ' to=' + wanted, req.clientIp);
  req.session.opFlash = { kind: 'ok', message: 'Status changed to ' + wanted + '.' };
  res.redirect('/admin/operators/' + id);
});

// ── POST /admin/operators/:id/password ──────────────────────────────────────
router.post('/operators/:id/password', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pw = String((req.body || {}).password || '');
  if (pw.length < 6) {
    req.session.opFlash = { kind: 'err', message: 'Password must be at least 6 chars.' };
    return res.redirect('/admin/operators/' + id);
  }
  const hash = bcrypt.hashSync(pw, 10);
  const now  = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE operators SET password_hash=?, failed_login_count=0, locked_until=NULL, updated_at=? WHERE id=?').run(hash, now, id);
  audit(req.admin.id, 'operator_password_reset', 'id=' + id, req.clientIp);
  req.session.opFlash = { kind: 'ok', message: 'Password reset.' };
  res.redirect('/admin/operators/' + id);
});

// ── POST /admin/operators/:id/unlock ────────────────────────────────────────
router.post('/operators/:id/unlock', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE operators SET failed_login_count=0, locked_until=NULL, updated_at=? WHERE id=?')
    .run(Math.floor(Date.now()/1000), id);
  audit(req.admin.id, 'operator_unlock', 'id=' + id, req.clientIp);
  req.session.opFlash = { kind: 'ok', message: 'Account unlocked.' };
  res.redirect('/admin/operators/' + id);
});

module.exports = router;
