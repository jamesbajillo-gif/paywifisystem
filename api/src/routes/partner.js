'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PARTNER-ROUTE-2026-06-01 — Store-partner / cashier surface.
// Username+password auth against the `operators` table. Each operator
// owns a single store (immutable `partner_slug`, editable `partner_name`).
// Scope: /partner/* only. Operators have NO admin access.
//
// Cash payments routed to this operator's store (pending_payments.partner_id)
// appear on their dashboard. The operator confirms cash → mints voucher → SMS.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const voucherSvc = require('../services/voucher');

// ─── helpers ────────────────────────────────────────────────────────────────
// AUDIT-FIX-2026-06-03 — shared support-contact block for footer
function supportContact() {
  return {
    phone: (db.prepare("SELECT value FROM settings WHERE key='partner_contact_number'").get() || {}).value || '',
    email: (db.prepare("SELECT value FROM settings WHERE key='partner_contact_email'").get()  || {}).value || '',
  };
}

function render(res, view, locals = {}) {
  res.render('partner/' + view, {
    supportContact: supportContact(),
    title:   locals.title  || 'PAYWIFI Operator',
    active:  locals.active || '',
    error:   null,
    operator: locals.operator || (res.locals && res.locals.partner) || null,
    fmtPHP:  (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
    fmtVoucherCode: (s) => (s || '').replace(/(.{4})(?=.)/g, '$1-'),
    relTime: (ts) => {
      if (!ts) return '—';
      const secs = Math.floor(Date.now()/1000) - ts;
      if (secs < 60)    return secs + 's ago';
      if (secs < 3600)  return Math.floor(secs/60) + 'm ago';
      if (secs < 86400) return Math.floor(secs/3600) + 'h ago';
      return Math.floor(secs/86400) + 'd ago';
    },
    ...locals,
  });
}

// PARTNER-SECHARDEN-2026-06-02 — write a real partner_id column instead of
// the legacy 'operator#<id>:<action>' string hack. Falls back to NULL when id missing.
function audit(opId, action, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (admin_id, partner_id, action, details, ip_address, created_at) VALUES (NULL, ?, ?, ?, ?, ?)'
    ).run(opId || null, action, details || null, ip || null, Math.floor(Date.now()/1000));
  } catch (e) {}
}

function loadOperatorIntoReq(req, res, next) {
  if (req.session && req.session.partnerId) {
    // PARTNER-OTP-2026-06-03 — mobile is identity (no username column anymore).
    const op = db.prepare(
      "SELECT id, partner_name, partner_slug, is_active, status, mobile, email, " +
      "       commission_pct, last_login_ip, last_login_at " +
      "FROM partners WHERE id=? AND status='active'"
    ).get(req.session.partnerId);
    if (op) { req.partner = op; res.locals.partner = op; }
    else { delete req.session.partnerId; }
  }
  next();
}

function requireOperator(req, res, next) {
  if (req.partner) return next();
  if (req.path && req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'auth_required' });
  return res.redirect('/partner/login');
}

router.use(loadOperatorIntoReq);

// OTP-DELEGATION-2026-06-03 — /login, /register, /verify, /cancel now live
// in routes/operator-otp.js. Logout stays here.
router.use('/', require('./partner-otp'));

router.post('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.redirect('/partner/login'));
  else res.redirect('/partner/login');
});

// ─── everything below requires the partner session ─────────────────────────
router.use(requireOperator);

// ─── dashboard ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  // AUDIT-FIX-DASH-2026-06-03 — track lifecycle milestones
  try {
    const now = Math.floor(Date.now()/1000);
    db.prepare("UPDATE partners SET dashboard_visits=dashboard_visits+1 WHERE id=?").run(req.partner.id);
    // first_payment_at backfill (any paid pending for this partner)
    const fp = db.prepare(
      "SELECT MIN(paid_at) AS first FROM pending_payments WHERE status='paid' AND partner_id=?"
    ).get(req.partner.id);
    if (fp && fp.first) {
      db.prepare("UPDATE partners SET first_payment_at=COALESCE(first_payment_at, ?) WHERE id=?").run(fp.first, req.partner.id);
    }
  } catch (e) {}
  // PARTNER-COMMISSION-UI-2026-06-02 — show outstanding balance on dashboard.
  const now = Math.floor(Date.now()/1000);
  const sid = req.partner.id;

  const pending = db.prepare(
    "SELECT pp.id, pp.amount, pp.buyer_phone, pp.created_at, pp.expires_at, " +
    "  pp.client_mac, pp.client_ip, vp.id AS plan_id, vp.name AS plan_name, vp.price AS plan_price " +
    "FROM pending_payments pp JOIN voucher_plans vp ON vp.id = pp.plan_id " +
    "WHERE pp.status = 'manual' AND pp.expires_at > ? AND pp.partner_id = ? " +
    "ORDER BY pp.created_at DESC LIMIT 50"
  ).all(now, sid);

  const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return Math.floor(d.getTime()/1000); })();
  const todayRev = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM pending_payments WHERE status='paid' AND paid_at >= ? AND partner_id = ?"
  ).get(todayStart, sid).n;
  const todayCount = db.prepare(
    "SELECT COUNT(*) AS n FROM pending_payments WHERE status='paid' AND paid_at >= ? AND partner_id = ?"
  ).get(todayStart, sid).n;

  const balance = computeOwed(req.partner.id);
  const partnerLifecycle = db.prepare("SELECT dashboard_visits, onboarded_at, first_payment_at, first_remit_at FROM partners WHERE id=?").get(req.partner.id) || {};
  const slaMin = parseInt((db.prepare("SELECT value FROM settings WHERE key='partner_confirm_sla_min'").get() || {}).value || '5', 10);
  render(res, 'dashboard', { balance, partnerLifecycle, slaMin,
    title: 'Partner · Dashboard',
    active: 'dash',
    pending, todayRev, todayCount,
  });
});

// ─── sales ──────────────────────────────────────────────────────────────────
// PARTNER-COMMISSION-UI-2026-06-02 — date range + commission + CSV export.
function parseDateRange(req) {
  const q = req.query || {};
  const now = Math.floor(Date.now()/1000);
  const presets = {
    today: () => { const d = new Date(); d.setHours(0,0,0,0); return [Math.floor(d.getTime()/1000), now]; },
    '7d':  () => [now - 7  * 86400, now],
    '30d': () => [now - 30 * 86400, now],
    '90d': () => [now - 90 * 86400, now],
    all:   () => [0, now],
  };
  const preset = q.preset && presets[q.preset] ? q.preset : null;
  if (preset) {
    const [from, to] = presets[preset]();
    return { from, to, preset, label: preset };
  }
  if (q.from && q.to) {
    const from = Math.floor(new Date(q.from + 'T00:00:00').getTime() / 1000);
    const to   = Math.floor(new Date(q.to   + 'T23:59:59').getTime() / 1000);
    if (!isNaN(from) && !isNaN(to)) {
      return { from, to, preset: 'custom', label: q.from + ' to ' + q.to };
    }
  }
  // default: last 7 days
  const [from, to] = presets['7d']();
  return { from, to, preset: '7d', label: '7d' };
}

router.get('/sales', (req, res) => {
  const sid = req.partner.id;
  const range = parseDateRange(req);

  const rangeRev = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n, COUNT(*) AS c FROM pending_payments " +
    " WHERE status='paid' AND paid_at >= ? AND paid_at <= ? AND partner_id = ?"
  ).get(range.from, range.to, sid);

  const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return Math.floor(d.getTime()/1000); })();
  const todayRev = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM pending_payments WHERE status='paid' AND paid_at >= ? AND partner_id = ?"
  ).get(todayStart, sid).n;
  const todayCount = db.prepare(
    "SELECT COUNT(*) AS n FROM pending_payments WHERE status='paid' AND paid_at >= ? AND partner_id = ?"
  ).get(todayStart, sid).n;
  const lifetimeRev = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM pending_payments WHERE status='paid' AND partner_id = ?"
  ).get(sid).n;
  const lifetimeRefunds = db.prepare(
    "SELECT COALESCE(SUM(refund_amount), 0) AS n FROM pending_payments WHERE status='refunded' AND refund_amount IS NOT NULL AND partner_id = ?"
  ).get(sid).n;

  const recent = db.prepare(
    "SELECT v.id, v.code, v.created_at, v.status AS v_status, " +
    "  vp.name AS plan_name, vp.price AS plan_price, " +
    "  pp.amount, pp.channel_name, pp.refunded_at, pp.status AS pp_status, pp.paid_at " +
    "FROM pending_payments pp " +
    "JOIN vouchers v ON v.id = pp.voucher_id " +
    "LEFT JOIN voucher_plans vp ON vp.id = pp.plan_id " +
    "WHERE pp.partner_id = ? AND pp.paid_at >= ? AND pp.paid_at <= ? " +
    "ORDER BY pp.paid_at DESC LIMIT 200"
  ).all(sid, range.from, range.to);

  const balance = computeOwed(sid);
  const rangeCommission = (rangeRev.n || 0) * (balance.commission_pct || 0) / 100;

  render(res, 'sales', {
    title: 'Partner · Sales',
    active: 'sales',
    todayRev, todayCount, lifetimeRev, lifetimeRefunds, recent,
    range, rangeRev: rangeRev.n, rangeCount: rangeRev.c, rangeCommission,
    balance,
  });
});

router.get('/sales.csv', (req, res) => {
  const sid = req.partner.id;
  const range = parseDateRange(req);
  const rows = db.prepare(
    "SELECT pp.paid_at, pp.amount, pp.channel_name, vp.name AS plan_name, v.code " +
    "FROM pending_payments pp " +
    "LEFT JOIN voucher_plans vp ON vp.id = pp.plan_id " +
    "LEFT JOIN vouchers v ON v.id = pp.voucher_id " +
    "WHERE pp.status='paid' AND pp.partner_id = ? AND pp.paid_at >= ? AND pp.paid_at <= ? " +
    "ORDER BY pp.paid_at ASC"
  ).all(sid, range.from, range.to);
  const balance = computeOwed(sid);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sales-' + (range.label || 'all') + '.csv"');
  let csv = 'paid_at,amount,channel,plan,voucher_code,commission_pct\n';
  rows.forEach(r => {
    const date = r.paid_at ? new Date(r.paid_at * 1000).toISOString() : '';
    csv += [date, r.amount, r.channel_name || '', (r.plan_name || '').replace(/,/g, ' '), r.code || '', balance.commission_pct].join(',') + '\n';
  });
  res.send(csv);
});

// ─── settings: edit partner_name (NOT username) ──────────────────────────────
router.get('/settings', (req, res) => {
  render(res, 'settings', {
    title: 'Partner · Settings',
    active: 'settings',
    saved: req.query.saved === '1',
  });
});

// EMAIL-EDIT-2026-06-03 — partner self-serve email update
router.post('/settings/email', (req, res) => {
  const email = String((req.body || {}).email || '').trim().slice(0, 120) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect('/partner/settings?err=email');
  }
  db.prepare('UPDATE partners SET email=?, updated_at=? WHERE id=?')
    .run(email, Math.floor(Date.now()/1000), req.partner.id);
  audit(req.partner.id, 'partner_email_update', email ? 'set' : 'cleared', req.clientIp);
  res.redirect('/partner/settings?saved=1');
});

router.post('/settings/store-name', (req, res) => {
  const name = String((req.body || {}).partner_name || '').trim().slice(0, 80);
  if (!name) return res.redirect('/partner/settings?err=1');
  db.prepare('UPDATE partners SET partner_name=?, updated_at=? WHERE id=?')
    .run(name, Math.floor(Date.now()/1000), req.partner.id);
  audit(req.partner.id, 'rename_store', 'new=' + name, req.clientIp);
  res.redirect('/partner/settings?saved=1');
});

// settings/password removed — operator login is OTP-only.

// ─── JSON API ───────────────────────────────────────────────────────────────
router.get('/api/pending', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const sid = req.partner.id;
  const items = db.prepare(
    "SELECT pp.id, pp.amount, pp.buyer_phone, pp.created_at, pp.expires_at, " +
    "  vp.id AS plan_id, vp.name AS plan_name " +
    "FROM pending_payments pp JOIN voucher_plans vp ON vp.id = pp.plan_id " +
    "WHERE pp.status='manual' AND pp.expires_at > ? AND pp.partner_id = ? " +
    "ORDER BY pp.created_at DESC LIMIT 50"
  ).all(now, sid);
  res.json({ ok: true, items, server_time: now });
});

router.post('/api/confirm/:id', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });

  const now = Math.floor(Date.now()/1000);
  const row = db.prepare(
    "SELECT pp.*, vp.duration_minutes, vp.bandwidth_kbps, vp.max_devices, vp.name AS plan_name " +
    "FROM pending_payments pp JOIN voucher_plans vp ON vp.id = pp.plan_id WHERE pp.id = ?"
  ).get(id);
  if (!row)                              return res.status(404).json({ ok: false, error: 'not_found' });
  // Store-ownership: an operator can ONLY confirm payments routed to their store.
  if (row.partner_id !== req.partner.id)  return res.status(403).json({ ok: false, code: 'not_your_store', error: 'This payment was routed to a different store.' });
  if (row.status === 'paid')             return res.json({ ok: false, error: 'already_confirmed', voucher_id: row.voucher_id });
  if (row.status === 'cancelled')        return res.json({ ok: false, error: 'cancelled' });
  if (row.status === 'expired')          return res.json({ ok: false, error: 'expired' });
  if (row.status !== 'manual')           return res.json({ ok: false, code: 'wrong_state', error: 'This payment is no longer in a confirmable state.', state: row.status });
  if (row.expires_at && row.expires_at <= now) return res.json({ ok: false, error: 'expired' });

  const codeLen = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get() || {}).value || '8', 10
  );

  let issuedCode = null;
  try {
    const issueTx = db.transaction(() => {
      const claim = db.prepare(
        "UPDATE pending_payments SET status='processing', updated_at=? WHERE id=? AND status='manual'"
      ).run(now, id);
      if (claim.changes === 0) return null;

      let code, voucherRow;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = voucherSvc.generateCode(codeLen);
        try {
          voucherRow = db.prepare(
            "INSERT INTO vouchers (code, duration_minutes, bandwidth_kbps, max_devices, status, lifecycle_state, created_at) " +
            "VALUES (?, ?, ?, ?, 'unused', 'generated', ?)"
          ).run(code, row.duration_minutes, row.bandwidth_kbps, row.max_devices || 1, now);
          break;
        } catch (e) { if (attempt === 4) throw e; }
      }

      db.prepare(
        "UPDATE pending_payments SET status='paid', voucher_id=?, paid_at=?, updated_at=? WHERE id=?"
      ).run(voucherRow.lastInsertRowid, now, now, id);

      return code;
    });
    issuedCode = issueTx();
  } catch (e) {
    console.error('[operator/confirm]', e.message);
    return res.status(500).json({ ok: false, error: 'mint_failed', detail: e.message });
  }

  if (!issuedCode) {
    const paid = db.prepare(
      'SELECT pp.status, v.code FROM pending_payments pp LEFT JOIN vouchers v ON v.id = pp.voucher_id WHERE pp.id = ?'
    ).get(id);
    if (paid && paid.status === 'paid' && paid.code) {
      return res.json({ ok: true, code: paid.code, already_paid: true });
    }
    return res.status(409).json({ ok: false, code: 'race_lost', error: 'Another channel claimed this payment first.', state: paid ? paid.status : 'unknown' });
  }

  try {
    db.prepare(
      "INSERT INTO payment_events (pending_payment_id, event_type, event_source, event_name, status_before, status_after, payload, ip_address, created_at) " +
      "VALUES (?, 'manual_confirm', 'operator', 'voucher_generated', 'manual', 'paid', ?, ?, ?)"
    ).run(id, JSON.stringify({ voucher_code: issuedCode, issued_via: 'operator_ui', partner_id: req.partner.id, partner_slug: req.partner.partner_slug }), req.clientIp || null, now);
  } catch (e) {}

  audit(req.partner.id, 'payment_confirmed', 'pp=' + id + ' code=' + issuedCode + ' amount=' + row.amount, req.clientIp);

  // QUEUE-EVERYWHERE-2026-06-01 — if the device already has an active
  // session, queue this freshly-minted voucher (so cash mirrors what
  // digital paths do via enqueueVoucherIfActive on webhook/poll).
  let queueInfo = { queued: false, queue_position: 0 };
  try {
    const sessionSvc = require('../services/session');
    const voucherId = (db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(id) || {}).voucher_id;
    if (row.client_mac && voucherId) {
      queueInfo = sessionSvc.enqueueVoucherIfActive(row.client_mac, voucherId, now) || queueInfo;
    }
  } catch (e) { console.warn('[operator/confirm] queue:', e.message); }

  // SMS-LIVE-STATUS-2026-06-01 — await sendSms so we get the message_id back.
  let smsResult = null;
  if (row.buyer_phone) {
    try {
      const sem = require('../services/semaphore');
      const k  = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get() || {}).value || '';
      const sn = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get() || {}).value || 'PAYWIFI';
      smsResult = await sem.sendSms(k, sn, row.buyer_phone,
        'Your PAYWIFI voucher code: ' + issuedCode + '. Enjoy your WiFi!',
        { kind: 'voucher' });
    } catch (e) { smsResult = { ok: false, error: e.message }; }
    if (smsResult && smsResult.message_id) {
      try { db.prepare("UPDATE pending_payments SET sms_message_id=? WHERE id=?").run(smsResult.message_id, id); } catch (e) {}
    }
  }

  res.json({
    ok: true,
    code: issuedCode,
    queued: queueInfo.queued,
    queue_position: queueInfo.queue_position,
    masked_phone: row.buyer_phone
      ? (function() {
          const local = String(row.buyer_phone).replace(/^63/, '0');
          return /^09\d{9}$/.test(local) ? (local.slice(0,4) + '-XXX-' + local.slice(7)) : local;
        })()
      : null,
    sms_attempted: !!row.buyer_phone,
    sms: smsResult ? {
      ok: !!smsResult.ok,
      message_id: smsResult.message_id || null,
      status: smsResult.ok ? 'queued' : 'failed',
      error: smsResult.error || null,
    } : null,
    plan_name: row.plan_name,
    amount: row.amount,
  });
});

// APPLY-CANCEL-RECS-2026-06-01-OPCAN — operator can DECLINE a stale cash
// pending payment for their store. Race-safe atomic flip from 'manual' →
// 'cancelled'. Only affects rows where partner_id matches this operator.
router.post('/api/cancel/:id', (req, res) => {
  const id  = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT id, status, partner_id, channel_name, amount FROM pending_payments WHERE id=?').get(id);
  if (!row)                              return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.partner_id !== req.partner.id)  return res.status(403).json({ ok: false, error: 'not_your_store' });
  if (row.status === 'paid')             return res.json({ ok: false, code: 'already_paid', error: 'This payment was already confirmed and a voucher was issued.' });
  if (row.status === 'cancelled')        return res.json({ ok: true, already: true });
  if (!['pending','manual','reserving'].includes(row.status))
                                         return res.json({ ok: false, code: 'wrong_state', error: 'This payment is no longer in a state where it can be cancelled.', state: row.status });

  // Atomic claim: only one path can flip the row.
  const r = db.prepare("UPDATE pending_payments SET status='cancelled', updated_at=? WHERE id=? AND status=?").run(now, id, row.status);
  if (r.changes === 0) return res.status(409).json({ ok: false, code: 'race_lost', error: 'Another action claimed this payment first.' });

  try {
    db.prepare(
      "INSERT INTO payment_events (pending_payment_id, event_type, event_source, event_name, status_before, status_after, payload, ip_address, created_at) " +
      "VALUES (?, 'cancelled', 'operator', 'payment_declined', ?, 'cancelled', ?, ?, ?)"
    ).run(id, row.status, JSON.stringify({ reason: 'operator_declined', partner_id: req.partner.id, partner_slug: req.partner.partner_slug }), req.clientIp || null, now);
  } catch (e) {}

  audit(req.partner.id, 'payment_declined', 'pp=' + id + ' amount=' + row.amount + ' channel=' + (row.channel_name || ''), req.clientIp);

  res.json({ ok: true, id, amount: row.amount, channel_name: row.channel_name });
});

// SMS-LIVE-STATUS-2026-06-01 — poll the live Semaphore delivery status.
router.get('/api/sms-status/:msgId', (req, res) => {
  const msgId = String(req.params.msgId || '').trim();
  if (!msgId) return res.status(400).json({ ok: false, error: 'bad_id' });
  const row = db.prepare(
    "SELECT phone, kind, ok, message_id, error, delivery_status, sent_at " +
    "FROM sms_send_log WHERE message_id=?"
  ).get(msgId);
  if (!row) return res.json({ ok: true, status: 'unknown', message_id: msgId });
  res.json({
    ok: true,
    message_id: row.message_id,
    initial_ok: !!row.ok,
    status: row.delivery_status || (row.ok ? 'queued' : 'failed'),
    error:  row.error || null,
    sent_at: row.sent_at,
  });
});


// PAYWIFI-REMITTANCE-2026-06-02 — operator remittance flow
const { computeOwed } = require('../services/remittance');

router.get('/remit', (req, res) => {
  const opId = req.partner.id;
  const balance = computeOwed(opId);
  const history = db.prepare(
    "SELECT id, amount, method, reference_no, notes, status, created_at, approved_at, rejected_at, rejected_reason " +
    "  FROM remittances WHERE partner_id=? ORDER BY id DESC LIMIT 30"
  ).all(opId);
  render(res, 'remit', {
    title:  'Partner · Remit',
    active: 'remit',
    balance, history,
    flash: req.session.prRemitFlash || null,
  });
  delete req.session.prRemitFlash;
});

router.post('/remit/submit', (req, res) => {
  const body = req.body || {};
  const amount = parseFloat(body.amount);
  const method = ['cash','gcash','bank','other'].includes(body.method) ? body.method : null;
  const reference_no = String(body.reference_no || '').trim().slice(0, 64);
  const notes = String(body.notes || '').trim().slice(0, 500) || null;

  if (!amount || amount <= 0) {
    req.session.prRemitFlash = { kind: 'err', message: 'Amount must be greater than 0.' };
    return res.redirect('/partner/remit');
  }
  if (!method) {
    req.session.prRemitFlash = { kind: 'err', message: 'Choose a remittance method.' };
    return res.redirect('/partner/remit');
  }
  if (!reference_no) {
    req.session.prRemitFlash = { kind: 'err', message: 'Reference number is required.' };
    return res.redirect('/partner/remit');
  }

  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(
    "INSERT INTO remittances (partner_id, amount, reference_no, method, notes, status, created_at) " +
    "VALUES (?,?,?,?,?, 'pending', ?)"
  ).run(req.partner.id, amount, reference_no, method, notes, now);
  audit(req.partner.id, 'remittance_submit', 'remit_id=' + r.lastInsertRowid + ' amount=' + amount + ' method=' + method, req.clientIp);
  req.session.prRemitFlash = { kind: 'ok', message: 'Submitted for admin approval. You\'ll see it in the list below.' };
  res.redirect('/partner/remit');
});

// AUDIT-FIX-DASH-2026-06-03 — mark onboarding completed/dismissed
router.post('/onboarded', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  db.prepare("UPDATE partners SET onboarded_at=COALESCE(onboarded_at, ?), updated_at=? WHERE id=?").run(now, now, req.partner.id);
  audit(req.partner.id, 'partner_onboarded', null, req.clientIp);
  res.redirect('/partner/');
});

module.exports = router;
