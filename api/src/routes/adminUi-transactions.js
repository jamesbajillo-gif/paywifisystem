'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title: locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error: null,
    ...locals
  });
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}

// ── GET /admin/transactions ──────────────────────────────────────────────────
router.get('/transactions', requireAdmin, (req, res) => {
  const statusFilter = req.query.status || '';
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit || '200', 10)));
  const baseUrl = db.cfg.api?.base_url || 'https://paywifi.net';

  let query = `
    SELECT pp.*,
           vp.name AS plan_name,
           po.name AS option_name,
           v.code  AS voucher_code
      FROM pending_payments pp
      LEFT JOIN voucher_plans   vp ON vp.id  = pp.plan_id
      LEFT JOIN payment_options po ON po.id  = pp.option_id
      LEFT JOIN vouchers         v ON v.id   = pp.voucher_id
  `;
  // SV-01: use parameterised query — never interpolate user input into SQL
  const queryParams = [];
  if (statusFilter) {
    query += ' WHERE pp.status = ?';
    queryParams.push(statusFilter);
  }
  query += ` ORDER BY pp.id DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all(...queryParams);

  // Fetch payment events for each transaction (batch query)
  const allIds = rows.map(r => r.id);
  let eventsMap = {};
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(',');
    const events = db.prepare(`
      SELECT * FROM payment_events
       WHERE pending_payment_id IN (${placeholders})
       ORDER BY created_at ASC
    `).all(...allIds);
    events.forEach(ev => {
      if (!eventsMap[ev.pending_payment_id]) eventsMap[ev.pending_payment_id] = [];
      eventsMap[ev.pending_payment_id].push(ev);
    });
  }

  // Attach events and derive display fallbacks for older rows (pre-migration)
  const CHANNEL_NAMES = {
    qr_code:'QR Ph', gcash:'GCash', grabpay:'GrabPay', paymaya:'PayMaya',
    shopeepay:'ShopeePay', otc:'Over-the-Counter', va:'Virtual Account', credit_card:'Credit Card'
  };
  const enriched = rows.map(row => ({
    ...row,
    channel_name:    row.channel_name    || CHANNEL_NAMES[row.module_action] || row.module_action || 'Manual',
    gateway_name:    row.gateway_name    || (row.module_slug ? row.module_slug.charAt(0).toUpperCase() + row.module_slug.slice(1) : 'Manual'),
    webhook_url:     row.webhook_url     || (row.module_slug ? `${baseUrl}/api/webhooks/${row.module_slug}` : null),
    payment_api_url: row.payment_api_url || null,
    events:          eventsMap[row.id]   || [],
  }));

  // Summary counts
  const countRows    = db.prepare(`SELECT status, COUNT(*) AS n FROM pending_payments GROUP BY status`).all();
  const summary      = Object.fromEntries(countRows.map(r => [r.status, r.n]));
  const totalAll     = countRows.reduce((s, r) => s + r.n, 0);
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM pending_payments WHERE status='paid'`).get().n;

  render(res, 'transactions', {
    title: 'Transaction History · PAYWIFI',
    active: 'transactions',
    rows: enriched,
    summary, totalAll, totalRevenue,
    filter: statusFilter, limit, baseUrl,
  });
});

// APPLY-CANCEL-RECS-2026-06-01-ADMCAN — admin can cancel a pending payment.
// Atomic UPDATE on the row's current status. Logs to payment_events + audit_log.
router.post('/transactions/:id/cancel', requireAdmin, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/admin/transactions');
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT id, status, amount, channel_name FROM pending_payments WHERE id=?').get(id);
  if (row && ['pending','manual','reserving'].includes(row.status)) {
    const r = db.prepare("UPDATE pending_payments SET status='cancelled', updated_at=? WHERE id=? AND status=?").run(now, id, row.status);
    if (r.changes > 0) {
      try {
        db.prepare(
          "INSERT INTO payment_events (pending_payment_id, event_type, event_source, event_name, status_before, status_after, payload, ip_address, created_at) " +
          "VALUES (?, 'cancelled', 'admin', 'admin_cancelled', ?, 'cancelled', ?, ?, ?)"
        ).run(id, row.status, JSON.stringify({ reason: 'admin_cancelled', admin_id: req.admin && req.admin.id || null, amount: row.amount, channel: row.channel_name }), req.clientIp || null, now);
      } catch (e) {}
      try {
        db.prepare("INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(req.admin && req.admin.id || null, 'payment_admin_cancel', 'pp=' + id + ' from=' + row.status + ' amount=' + row.amount, req.clientIp || null, now);
      } catch (e) {}
    }
  }
  res.redirect('/admin/transactions');
});

module.exports = router;