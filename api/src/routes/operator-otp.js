'use strict';
// PAYWIFI-OPERATOR-OTP-2026-06-03 — mobile-OTP login + self-registration for operators.
// Replaces the legacy username/password flow. The /login screen has two paths:
//   1. Sign in — enter mobile, receive 6-digit code, enter code → session
//   2. Register — enter mobile + store name, receive 6-digit code, enter
//      code → operator row created (auto-approved or pending based on settings)
//
// All requests rate-limited at the server.js level.
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');

const OTP_TTL_SEC     = 5 * 60;     // 5 minutes
const OTP_MAX_ATTEMPTS = 5;
const SMS_TEMPLATE = 'PAYWIFI Operator code: {code}. Valid for 5 minutes. Do not share.';

// ─────────────────────────────────────────────────────────────
function audit(opId, action, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (admin_id, operator_id, action, details, ip_address, created_at) VALUES (NULL, ?, ?, ?, ?, ?)'
    ).run(opId || null, action, (details || '').slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}

function settingValue(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : fallback;
}

// 09xxxxxxxxx → 639xxxxxxxxx; 639xxxxxxxxx passes through; otherwise null
function normalizeMobile(input) {
  // Accept 09xxxxxxxxx, 639xxxxxxxxx, +639xxxxxxxxx, or 9xxxxxxxxx (no leading 0)
  // All normalize to 639xxxxxxxxx.
  const s = String(input || '').replace(/[^\d]/g, '');
  if (/^09\d{9}$/.test(s))   return '63' + s.slice(1);
  if (/^639\d{9}$/.test(s))  return s;
  if (/^9\d{9}$/.test(s))    return '63' + s;        // user dropped the leading 0
  return null;
}

function maskMobile(m639) {
  if (!m639 || m639.length !== 12) return m639 || '';
  return '+63 ' + m639.slice(2, 5) + ' xxx ' + m639.slice(9);
}

function generateCode() {
  // 6-digit numeric, leading-zero safe
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function uniqueSlug(base) {
  if (!base) base = 'store';
  let slug = base, n = 1;
  while (db.prepare("SELECT 1 FROM operators WHERE store_slug=?").get(slug)) {
    n += 1;
    slug = base + '-' + n;
    if (n > 999) { slug = base + '-' + Math.floor(Math.random() * 1e6); break; }
  }
  return slug;
}

async function sendOtpSms(mobile, code) {
  try {
    const sem = require('../services/semaphore');
    const k   = settingValue('semaphore_api_key', '');
    const sn  = settingValue('semaphore_sender_name', 'PAYWIFI');
    if (!k) return { ok: false, error: 'sms_not_configured' };
    const msg = SMS_TEMPLATE.replace('{code}', code);
    return await sem.sendSms(k, sn, mobile, msg, { kind: 'operator_otp' });
  } catch (e) {
    return { ok: false, error: e.message || 'sms_failed' };
  }
}

// Persist the OTP record (bcrypt the code) and return the inserted row id
function storeOtp(mobile, code, purpose, payload, ip) {
  const now  = Math.floor(Date.now() / 1000);
  const hash = bcrypt.hashSync(code, 8);
  // Invalidate any previous unused OTPs for this mobile + purpose
  db.prepare("UPDATE operator_otp SET consumed_at=? WHERE mobile=? AND purpose=? AND consumed_at IS NULL")
    .run(now, mobile, purpose);
  const r = db.prepare(
    "INSERT INTO operator_otp (mobile, code_hash, purpose, payload, created_at, expires_at, ip_address) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(mobile, hash, purpose, payload ? JSON.stringify(payload) : null, now, now + OTP_TTL_SEC, ip || null);
  return r.lastInsertRowid;
}

function findActiveOtp(mobile, purpose) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT * FROM operator_otp WHERE mobile=? AND purpose=? AND consumed_at IS NULL AND expires_at > ? " +
    "ORDER BY id DESC LIMIT 1"
  ).get(mobile, purpose, now);
}

// ─────────────────────────────────────────────────────────────
// Shared render helper (same view-engine convention as the rest of operator/)
function render(res, view, locals = {}) {
  res.render('operator/' + view, {
    title:  locals.title || 'PAYWIFI Operator',
    active: locals.active || '',
    error:  null,
    operator: locals.operator || (res.locals && res.locals.operator) || null,
    ...locals,
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: GET /operator/login — show 2-tab form (sign in / register)
router.get('/login', (req, res) => {
  if (req.operator) return res.redirect('/operator/');
  render(res, 'login', {
    title: 'Operator · sign in',
    active: 'login',
    flash: req.session.opLoginFlash || null,
    pendingMobile: req.session.opPendingMobile || null,
    pendingPurpose: req.session.opPendingPurpose || null,
    autoApprove: settingValue('operator_auto_approve', '1') === '1',
  });
  delete req.session.opLoginFlash;
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /operator/login — submit mobile → send OTP
router.post('/login', async (req, res) => {
  const mobile = normalizeMobile((req.body || {}).mobile);
  if (!mobile) {
    req.session.opLoginFlash = { kind: 'err', message: 'Please enter a valid Philippine mobile number (09xxxxxxxxx).' };
    return res.redirect('/operator/login');
  }

  const op = db.prepare("SELECT id, mobile, status FROM operators WHERE mobile=?").get(mobile);

  // To prevent enumeration: ALWAYS show the same screen + send to OTP page.
  // Only actually generate + send the SMS if the operator exists and is not
  // suspended/archived. The user-visible message is uniform.
  if (op && op.status === 'active') {
    const code = generateCode();
    const otpId = storeOtp(mobile, code, 'login', null, req.clientIp);
    const sms = await sendOtpSms(mobile, code);
    audit(op.id, 'otp_sent_login', 'otp_id=' + otpId + ' sms_ok=' + !!sms.ok, req.clientIp);
  } else if (op && (op.status === 'pending' || op.status === 'suspended' || op.status === 'archived')) {
    audit(op.id, 'otp_skipped_login', 'reason=' + op.status, req.clientIp);
  } else {
    audit(null, 'otp_skipped_login', 'reason=unknown_mobile mobile=' + mobile.slice(0, 5) + 'xxx', req.clientIp);
  }

  req.session.opPendingMobile  = mobile;
  req.session.opPendingPurpose = 'login';
  req.session.opLoginFlash = { kind: 'ok', message: 'If your mobile is registered, a 6-digit code was sent. Enter it below.' };
  res.redirect('/operator/login');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /operator/register — submit mobile + store name → send OTP
router.post('/register', async (req, res) => {
  const mobile    = normalizeMobile((req.body || {}).mobile);
  const storeName = String((req.body || {}).store_name || '').trim().slice(0, 80);

  if (!mobile) {
    req.session.opLoginFlash = { kind: 'err', message: 'Please enter a valid Philippine mobile number (09xxxxxxxxx).' };
    return res.redirect('/operator/login');
  }
  if (!storeName) {
    req.session.opLoginFlash = { kind: 'err', message: 'Store name is required for registration.' };
    return res.redirect('/operator/login');
  }

  const existing = db.prepare("SELECT id, status FROM operators WHERE mobile=?").get(mobile);
  if (existing) {
    // Mobile already used. Don't reveal — show generic OTP-sent message and let them
    // log in instead. Audit it for admin visibility.
    audit(existing.id, 'register_dup_attempt', 'store_name=' + storeName, req.clientIp);
    req.session.opPendingMobile  = mobile;
    req.session.opPendingPurpose = 'login';
    req.session.opLoginFlash = { kind: 'ok', message: 'This mobile is already registered. Use Sign in instead — a code will be sent if active.' };
    return res.redirect('/operator/login');
  }

  const code = generateCode();
  const otpId = storeOtp(mobile, code, 'register', { store_name: storeName }, req.clientIp);
  const sms = await sendOtpSms(mobile, code);
  audit(null, 'otp_sent_register', 'otp_id=' + otpId + ' store=' + storeName + ' sms_ok=' + !!sms.ok, req.clientIp);

  req.session.opPendingMobile  = mobile;
  req.session.opPendingPurpose = 'register';
  req.session.opPendingStoreName = storeName;
  req.session.opLoginFlash = { kind: 'ok', message: 'A 6-digit code was sent. Enter it below to finish registration.' };
  res.redirect('/operator/login');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /operator/verify — submit OTP code → consume + log in
router.post('/verify', (req, res) => {
  const mobile  = req.session.opPendingMobile;
  const purpose = req.session.opPendingPurpose;
  const code    = String((req.body || {}).code || '').replace(/[^\d]/g, '').slice(0, 6);

  if (!mobile || !purpose) {
    req.session.opLoginFlash = { kind: 'err', message: 'Session expired. Please start again.' };
    return res.redirect('/operator/login');
  }
  if (!/^\d{6}$/.test(code)) {
    req.session.opLoginFlash = { kind: 'err', message: 'Enter the 6-digit code.' };
    return res.redirect('/operator/login');
  }

  const otp = findActiveOtp(mobile, purpose);
  if (!otp) {
    audit(null, 'otp_verify_fail', 'reason=no_active_otp mobile=' + mobile.slice(0, 5) + 'xxx', req.clientIp);
    req.session.opLoginFlash = { kind: 'err', message: 'Code expired or invalid. Request a new one.' };
    return res.redirect('/operator/login');
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare("UPDATE operator_otp SET consumed_at=strftime('%s','now') WHERE id=?").run(otp.id);
    audit(null, 'otp_verify_fail', 'reason=too_many_attempts otp_id=' + otp.id, req.clientIp);
    req.session.opLoginFlash = { kind: 'err', message: 'Too many wrong attempts. Request a new code.' };
    return res.redirect('/operator/login');
  }

  const matches = bcrypt.compareSync(code, otp.code_hash);
  if (!matches) {
    db.prepare("UPDATE operator_otp SET attempts=attempts+1 WHERE id=?").run(otp.id);
    audit(null, 'otp_verify_fail', 'reason=wrong_code otp_id=' + otp.id + ' attempt=' + (otp.attempts + 1), req.clientIp);
    req.session.opLoginFlash = { kind: 'err', message: 'Incorrect code. ' + (OTP_MAX_ATTEMPTS - otp.attempts - 1) + ' attempts remaining.' };
    return res.redirect('/operator/login');
  }

  // SUCCESS — consume the OTP, then login-or-create the operator
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE operator_otp SET consumed_at=? WHERE id=?").run(now, otp.id);

  if (purpose === 'register') {
    const payload = otp.payload ? JSON.parse(otp.payload) : {};
    const storeName = payload.store_name || req.session.opPendingStoreName || 'My Store';
    const slug = uniqueSlug(slugify(storeName));
    const autoApprove = settingValue('operator_auto_approve', '1') === '1';
    const status = autoApprove ? 'active' : 'pending';
    const isActive = autoApprove ? 1 : 0;

    let opId;
    try {
      const r = db.prepare(
        "INSERT INTO operators (mobile, store_name, store_slug, status, is_active, created_at, updated_at, registered_via) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'self')"
      ).run(mobile, storeName, slug, status, isActive, now, now);
      opId = r.lastInsertRowid;
    } catch (e) {
      audit(null, 'register_fail', e.message.slice(0, 200), req.clientIp);
      req.session.opLoginFlash = { kind: 'err', message: 'Could not create account: ' + e.message };
      return res.redirect('/operator/login');
    }

    audit(opId, 'operator_self_register', 'store=' + storeName + ' status=' + status, req.clientIp);

    if (status === 'pending') {
      req.session.opPendingMobile = null;
      req.session.opPendingPurpose = null;
      req.session.opPendingStoreName = null;
      req.session.opLoginFlash = { kind: 'ok', message: 'Account created. Awaiting admin approval before you can sign in.' };
      return res.redirect('/operator/login');
    }
    // Auto-approved → fall through to login
    db.prepare("UPDATE operators SET last_login_at=?, last_login_ip=? WHERE id=?").run(now, req.clientIp || null, opId);
    if (req.session) {
      delete req.session.adminId;
      req.session.operatorId = opId;
      req.session.opPendingMobile = null;
      req.session.opPendingPurpose = null;
      req.session.opPendingStoreName = null;
    }
    audit(opId, 'login_ok', 'first_login=1', req.clientIp);
    return res.redirect('/operator/');
  }

  // purpose === 'login'
  const op = db.prepare("SELECT * FROM operators WHERE mobile=?").get(mobile);
  if (!op) {
    req.session.opLoginFlash = { kind: 'err', message: 'Account not found.' };
    return res.redirect('/operator/login');
  }
  if (op.status !== 'active') {
    audit(op.id, 'login_fail', 'reason=status_' + op.status, req.clientIp);
    req.session.opLoginFlash = { kind: 'err', message: 'Your account is ' + op.status + '. Contact the admin.' };
    return res.redirect('/operator/login');
  }

  db.prepare("UPDATE operators SET last_login_at=?, last_login_ip=? WHERE id=?").run(now, req.clientIp || null, op.id);
  if (req.session) {
    delete req.session.adminId;
    req.session.operatorId = op.id;
    req.session.opPendingMobile = null;
    req.session.opPendingPurpose = null;
  }
  audit(op.id, 'login_ok', null, req.clientIp);
  res.redirect('/operator/');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /operator/cancel — abandon a pending verification
router.post('/cancel', (req, res) => {
  if (req.session) {
    req.session.opPendingMobile = null;
    req.session.opPendingPurpose = null;
    req.session.opPendingStoreName = null;
    req.session.opLoginFlash = null;
  }
  res.redirect('/operator/login');
});

module.exports = router;
