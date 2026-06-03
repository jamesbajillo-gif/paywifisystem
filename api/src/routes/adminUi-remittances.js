'use strict';
// PAYWIFI-REMITTANCE-2026-06-02 — admin: review and approve remittances.
const router    = require('express').Router();
const db        = require('../db');
const { computeOwed } = require('../services/remittance');

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

// ── GET /admin/remittances ──────────────────────────────────────────────────
router.get('/remittances', requireAdmin, (req, res) => {
  const statusFilter = String(req.query.status || 'pending').toLowerCase();
  const where = ['pending','approved','rejected','all'].includes(statusFilter) ? statusFilter : 'pending';

  let rows;
  if (where === 'all') {
    rows = db.prepare(
      "SELECT r.*, o.store_name, o.username FROM remittances r " +
      "  JOIN operators o ON o.id = r.operator_id " +
      " ORDER BY r.created_at DESC LIMIT 200"
    ).all();
  } else {
    rows = db.prepare(
      "SELECT r.*, o.store_name, o.username FROM remittances r " +
      "  JOIN operators o ON o.id = r.operator_id " +
      " WHERE r.status=? ORDER BY r.created_at DESC LIMIT 200"
    ).all(where);
  }

  // Per-operator outstanding (helps admin see context next to each remittance)
  const ops = db.prepare("SELECT id, store_name, username, commission_pct FROM operators WHERE status='active'").all();
  const balances = ops.map(o => ({ ...o, balance: computeOwed(o.id) }));

  res.render('admin/remittances', {
    title:  'Remittances · PAYWIFI',
    active: 'remittances',
    rows,
    filter: where,
    balances,
    flash: req.session.remitFlash || null,
  });
  delete req.session.remitFlash;
});

// ── POST /admin/remittances/:id/approve ─────────────────────────────────────
router.post('/remittances/:id/approve', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare("UPDATE remittances SET status='approved', approved_at=?, approved_by=? WHERE id=? AND status='pending'")
    .run(now, req.admin.id, id);
  if (r.changes > 0) {
    audit(req.admin.id, 'remittance_approve', 'remit_id=' + id, req.clientIp);
    req.session.remitFlash = { kind: 'ok', message: 'Remittance #' + id + ' approved.' };
  } else {
    req.session.remitFlash = { kind: 'err', message: 'Remittance #' + id + ' not pending.' };
  }
  res.redirect('/admin/remittances');
});

// ── POST /admin/remittances/:id/reject ──────────────────────────────────────
router.post('/remittances/:id/reject', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = String((req.body || {}).reason || '').trim().slice(0, 240);
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(
    "UPDATE remittances SET status='rejected', rejected_at=?, rejected_by=?, rejected_reason=? WHERE id=? AND status='pending'"
  ).run(now, req.admin.id, reason || 'no reason given', id);
  if (r.changes > 0) {
    audit(req.admin.id, 'remittance_reject', 'remit_id=' + id + ' reason=' + (reason || '-'), req.clientIp);
    req.session.remitFlash = { kind: 'ok', message: 'Remittance #' + id + ' rejected.' };
  } else {
    req.session.remitFlash = { kind: 'err', message: 'Remittance #' + id + ' not pending.' };
  }
  res.redirect('/admin/remittances');
});

module.exports = router;
