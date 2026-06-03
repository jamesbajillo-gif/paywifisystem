'use strict';
// PAYWIFI-PARTNER-ADMIN-2026-06-02 — admin CRUD for operators.
// Routes:
//   GET  /admin/partners                  list + per-op metrics
//   GET  /admin/partners/new              create form
//   POST /admin/partners/create           insert
//   GET  /admin/partners/:id              edit form + activity
//   POST /admin/partners/:id/update       update fields
//   POST /admin/partners/:id/status       suspend/activate/archive
//   POST /admin/partners/:id/password     admin resets password
//   POST /admin/partners/:id/unlock       clear lockout/failed-counter
const router = require('express').Router();
const db     = require('../db');

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
     WHERE status='paid' AND partner_id=?`).get(opId);
  return r || { gross: 0, paid_count: 0, refunded: 0 };
}

// ── GET /admin/partners ────────────────────────────────────────────────────
router.get('/partners', requireAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT id, partner_name, partner_slug, mobile, email, status, commission_pct, " +
    "       failed_login_count, locked_until, last_login_at, last_login_ip, created_at, suspended_at " +
    "  FROM partners ORDER BY id ASC"
  ).all();

  const ops = rows.map(op => ({ ...op, stats: operatorStats(op.id) }));

  res.render('admin/partners', {
    title:  'Partners · PAYWIFI',
    active: 'partners',
    operators: ops,
    flash: req.session.prFlash || null,
  });
  delete req.session.prFlash;
});

// ── GET /admin/partners/new ────────────────────────────────────────────────
router.get('/partners/new', requireAdmin, (req, res) => {
  res.render('admin/partner-edit', {
    title:  'New partner · PAYWIFI',
    active: 'partners',
    isNew:  true,
    op: { commission_pct: 10, status: 'active' },
    err: req.session.prErr || null,
  });
  delete req.session.prErr;
});

// ── POST /admin/partners/create ────────────────────────────────────────────
router.post('/partners/create', requireAdmin, (req, res) => {
  const body = req.body || {};
      const storeName = String(body.partner_name || '').trim().slice(0, 80);
  let   slug      = String(body.partner_slug || '').trim().toLowerCase();
  const mobile    = normalizeMobile(body.mobile);
  const email     = String(body.email || '').trim().slice(0, 120) || null;
  const commission_pct = Math.max(0, Math.min(100, parseFloat(body.commission_pct || '10') || 10));
  const notes     = String(body.notes || '').trim().slice(0, 2000) || null;
  const status    = ['active','pending','suspended'].includes(body.status) ? body.status : 'active';

  const errs = [];
    if (!storeName) errs.push('Store name is required.');
  if (mobile === null) errs.push('Mobile is required (09xxxxxxxxx).');
  if (mobile === null && body.mobile)       errs.push('Mobile must be 09xxxxxxxxx or 639xxxxxxxxx.');
  if (!slug) slug = slugify(storeName);
  if (!/^[a-z0-9-]{2,32}$/.test(slug))      errs.push('Store slug must be 2-32 chars (a-z, 0-9, dash).');

  if (errs.length) {
    req.session.prErr = errs.join(' ');
    return res.redirect('/admin/partners/new');
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const r = db.prepare(
      "INSERT INTO partners " +
      "  (mobile, partner_name, partner_slug, email, status, commission_pct, " +
      "   notes, is_active, created_at, updated_at, created_by, registered_via) " +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,'admin')"
    ).run(
      mobile, storeName, slug, email, status, commission_pct,
      notes, status === 'active' ? 1 : 0, now, now, req.admin.id
    );
    audit(req.admin.id, 'partner_create', 'id=' + r.lastInsertRowid + '  status=' + status, req.clientIp);
    req.session.prFlash = { kind: 'ok', message: 'Operator "' + storeName + '" created.' };
    res.redirect('/admin/partners/' + r.lastInsertRowid);
  } catch (e) {
    const msg = /UNIQUE constraint failed: partners.mobile/.test(e.message)
      ? 'An operator with that mobile number already exists.'
      : /UNIQUE constraint failed: partners.partner_slug/.test(e.message)
      ? 'A store with that slug already exists.'
      : 'Could not create operator: ' + e.message;
    req.session.prErr = msg;
    res.redirect('/admin/partners/new');
  }
});

// ── GET /admin/partners/:id ────────────────────────────────────────────────
router.get('/partners/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const op = db.prepare(
    "SELECT id, partner_name, partner_slug, mobile, email, status, commission_pct, notes, " +
    "       failed_login_count, locked_until, last_login_at, last_login_ip, created_at, suspended_at, suspended_by, registered_via " +
    "  FROM partners WHERE id=?"
  ).get(id);
  if (!op) { req.session.prFlash = { kind: 'err', message: 'Operator not found.' }; return res.redirect('/admin/partners'); }

  const recent = db.prepare(
    "SELECT action, details, ip_address, created_at FROM audit_log " +
    " WHERE partner_id=? ORDER BY id DESC LIMIT 30"
  ).all(id);

  res.render('admin/partner-edit', {
    title:  op.partner_name + ' · PAYWIFI',
    active: 'partners',
    isNew:  false,
    op,
    stats: operatorStats(id),
    recent,
    flash: req.session.prFlash || null,
    err:   req.session.prErr || null,
  });
  delete req.session.prFlash;
  delete req.session.prErr;
});

// ── POST /admin/partners/:id/update ────────────────────────────────────────
router.post('/partners/:id/update', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/admin/partners');
  const op = db.prepare('SELECT * FROM partners WHERE id=?').get(id);
  if (!op) { req.session.prFlash = { kind: 'err', message: 'Operator not found.' }; return res.redirect('/admin/partners'); }

  const body = req.body || {};
  const storeName = String(body.partner_name || op.partner_name).trim().slice(0, 80);
  const mobileRaw = (body.mobile || '').trim();
  const mobile    = mobileRaw === '' ? null : normalizeMobile(mobileRaw);
  const email     = String(body.email || '').trim().slice(0, 120) || null;
  const commission_pct = Math.max(0, Math.min(100, parseFloat(body.commission_pct || op.commission_pct) || op.commission_pct));
  const notes     = String(body.notes || '').trim().slice(0, 2000) || null;

  const errs = [];
  if (!storeName) errs.push('Store name is required.');
  if (mobileRaw && mobile === null) errs.push('Mobile must be 09xxxxxxxxx or 639xxxxxxxxx.');
  if (errs.length) {
    req.session.prErr = errs.join(' ');
    return res.redirect('/admin/partners/' + id);
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE partners SET partner_name=?, mobile=?, email=?, commission_pct=?, notes=?, updated_at=? WHERE id=?"
  ).run(storeName, mobile, email, commission_pct, notes, now, id);

  audit(req.admin.id, 'partner_update', 'id=' + id + ' fields=name,mobile,email,commission,notes', req.clientIp);
  req.session.prFlash = { kind: 'ok', message: 'Saved.' };
  res.redirect('/admin/partners/' + id);
});

// ── POST /admin/partners/:id/status ────────────────────────────────────────
router.post('/partners/:id/status', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wanted = String((req.body || {}).status || '').toLowerCase();
  if (!['active','pending','suspended','archived'].includes(wanted)) {
    req.session.prFlash = { kind: 'err', message: 'Invalid status.' };
    return res.redirect('/admin/partners/' + id);
  }
  const op = db.prepare('SELECT * FROM partners WHERE id=?').get(id);
  if (!op) return res.redirect('/admin/partners');

  const now = Math.floor(Date.now() / 1000);
  const isActive = wanted === 'active' ? 1 : 0;
  const suspendedAt = wanted === 'suspended' ? now : null;
  const suspendedBy = wanted === 'suspended' ? req.admin.id : null;

  db.prepare(
    "UPDATE partners SET status=?, is_active=?, suspended_at=?, suspended_by=?, updated_at=? WHERE id=?"
  ).run(wanted, isActive, suspendedAt, suspendedBy, now, id);

  audit(req.admin.id, 'partner_status', 'id=' + id + ' from=' + op.status + ' to=' + wanted, req.clientIp);
  req.session.prFlash = { kind: 'ok', message: 'Status changed to ' + wanted + '.' };
  res.redirect('/admin/partners/' + id);
});

// password reset removed — login is OTP-only

// ── POST /admin/partners/:id/unlock ────────────────────────────────────────
router.post('/partners/:id/unlock', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE partners SET failed_login_count=0, locked_until=NULL, updated_at=? WHERE id=?')
    .run(Math.floor(Date.now()/1000), id);
  audit(req.admin.id, 'partner_unlock', 'id=' + id, req.clientIp);
  req.session.prFlash = { kind: 'ok', message: 'Account unlocked.' };
  res.redirect('/admin/partners/' + id);
});

module.exports = router;
