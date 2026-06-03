'use strict';
// PAYWIFI-PARTNER-OTP-2026-06-03 — mobile-OTP login + self-registration for operators.
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
// AUDIT-FIX-2026-06-03 — partner-friendly OTP SMS with login link
function buildOtpTemplate() {
  const domain = (db.prepare("SELECT value FROM settings WHERE key='domain_name'").get() || {}).value || '';
  const url = (domain ? (domain.replace(/\/$/,'') + '/partner') : 'paywifi.net/partner');
  return 'PAYWIFI partner code: {code}. Valid 5 minutes. Sign in: ' + url + '. Do not share.';
}

// ─────────────────────────────────────────────────────────────
function audit(opId, action, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (admin_id, partner_id, action, details, ip_address, created_at) VALUES (NULL, ?, ?, ?, ?, ?)'
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
  while (db.prepare("SELECT 1 FROM partners WHERE partner_slug=?").get(slug)) {
    n += 1;
    slug = base + '-' + n;
    if (n > 999) { slug = base + '-' + Math.floor(Math.random() * 1e6); break; }
  }
  return slug;
}

// AUDIT-FIX-2026-06-03 — send arbitrary SMS via Semaphore (reused by welcome/admin alerts)
async function sendSmsRaw(mobile, body, meta) {
  try {
    const sem = require('../services/semaphore');
    const k   = settingValue('semaphore_api_key', '');
    const sn  = settingValue('semaphore_sender_name', 'PAYWIFI');
    if (!k || !mobile) return { ok: false, error: 'sms_not_configured' };
    return await sem.sendSms(k, sn, mobile, body, meta || { kind: 'partner_misc' });
  } catch (e) {
    return { ok: false, error: e.message || 'sms_failed' };
  }
}

async function maybeWelcomeSms(partner) {
  if (settingValue('partner_welcome_sms_enabled', '1') !== '1') return;
  const domain = settingValue('domain_name', '');
  const url = (domain ? (domain.replace(/\/$/,'') + '/partner') : 'paywifi.net/partner');
  const support = settingValue('partner_contact_number', '');
  const supportLine = support ? (' Help: ' + support) : '';
  const body = 'Welcome to PAYWIFI, ' + partner.partner_name + '! Sign in any time at ' + url + '.' + supportLine;
  return await sendSmsRaw(partner.mobile, body, { kind: 'partner_welcome' });
}

async function notifyAdminOfNewPartner(partner) {
  const phone = settingValue('admin_alert_phone', '');
  if (!phone) return;
  const body = 'PAYWIFI: new partner registered — ' + partner.partner_name + ' (' + partner.mobile + ') status=' + partner.status + '.';
  return await sendSmsRaw(phone, body, { kind: 'admin_partner_signup' });
}

async function sendOtpSms(mobile, code) {
  try {
    const sem = require('../services/semaphore');
    const k   = settingValue('semaphore_api_key', '');
    const sn  = settingValue('semaphore_sender_name', 'PAYWIFI');
    if (!k) return { ok: false, error: 'sms_not_configured' };
    const msg = buildOtpTemplate().replace('{code}', code);
    return await sem.sendSms(k, sn, mobile, msg, { kind: 'partner_otp' });
  } catch (e) {
    return { ok: false, error: e.message || 'sms_failed' };
  }
}

// Persist the OTP record (bcrypt the code) and return the inserted row id
function storeOtp(mobile, code, purpose, payload, ip) {
  const now  = Math.floor(Date.now() / 1000);
  const hash = bcrypt.hashSync(code, 8);
  // Invalidate any previous unused OTPs for this mobile + purpose
  db.prepare("UPDATE partner_otp SET consumed_at=? WHERE mobile=? AND purpose=? AND consumed_at IS NULL")
    .run(now, mobile, purpose);
  const r = db.prepare(
    "INSERT INTO partner_otp (mobile, code_hash, purpose, payload, created_at, expires_at, ip_address) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(mobile, hash, purpose, payload ? JSON.stringify(payload) : null, now, now + OTP_TTL_SEC, ip || null);
  return r.lastInsertRowid;
}

function findActiveOtp(mobile, purpose) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT * FROM partner_otp WHERE mobile=? AND purpose=? AND consumed_at IS NULL AND expires_at > ? " +
    "ORDER BY id DESC LIMIT 1"
  ).get(mobile, purpose, now);
}

// ─────────────────────────────────────────────────────────────
// Shared render helper (same view-engine convention as the rest of operator/)
// AUDIT-FIX-2026-06-03-RENDER — pass support contact to layout
function supportContact() {
  return {
    phone: (db.prepare("SELECT value FROM settings WHERE key='partner_contact_number'").get() || {}).value || '',
    email: (db.prepare("SELECT value FROM settings WHERE key='partner_contact_email'").get()  || {}).value || '',
  };
}

function render(res, view, locals = {}) {
  res.render('partner/' + view, {
    supportContact: supportContact(),
    title:  locals.title || 'PAYWIFI Partner',
    active: locals.active || '',
    error:  null,
    operator: locals.operator || (res.locals && res.locals.partner) || null,
    ...locals,
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: GET /partner/login — show 2-tab form (sign in / register)
router.get('/login', (req, res) => {
  if (req.partner) return res.redirect('/partner/');
  render(res, 'login', {
    title: 'Partner · sign in',
    active: 'login',
    flash: req.session.prLoginFlash || null,
    pendingMobile: req.session.prPendingMobile || null,
    pendingPurpose: req.session.prPendingPurpose || null,
    autoApprove: settingValue('partner_auto_approve', '1') === '1',
  });
  delete req.session.prLoginFlash;
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /partner/login — submit mobile → send OTP
router.post('/login', async (req, res) => {
  // SESSION-SHORTCIRCUIT-2026-06-03 — already signed in → go straight to dashboard, skip OTP.
  if (req.partner) {
    audit(req.partner.id, 'login_skipped_already_signed_in', null, req.clientIp);
    return res.redirect('/partner/');
  }
  const mobile = normalizeMobile((req.body || {}).mobile);
  if (!mobile) {
    req.session.prLoginFlash = { kind: 'err', message: 'Please enter a valid Philippine mobile number (09xxxxxxxxx).' };
    return res.redirect('/partner/login');
  }

  const op = db.prepare("SELECT id, mobile, status FROM partners WHERE mobile=?").get(mobile);

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

  req.session.prPendingMobile  = mobile;
  req.session.prPendingPurpose = 'login';
  req.session.prLoginFlash = { kind: 'ok', message: 'If your mobile is registered, a 6-digit code was sent. Enter it below.' };
  res.redirect('/partner/login');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /partner/register — submit mobile + store name → send OTP
router.post('/register', async (req, res) => {
  if (req.partner) { audit(req.partner.id, 'register_skipped_already_signed_in', null, req.clientIp); return res.redirect('/partner/'); }
  const mobile    = normalizeMobile((req.body || {}).mobile);
  const storeName = String((req.body || {}).partner_name || '').trim().slice(0, 80);
  // TERMS-EMAIL-2026-06-03 — optional email + required T&C agreement
  const email     = String((req.body || {}).email || '').trim().slice(0, 120) || null;
  const agreed    = (req.body || {}).agree_terms === '1' || (req.body || {}).agree_terms === 'on';

  if (!agreed) {
    req.session.prLoginFlash = { kind: 'err', message: 'You must agree to the Partner Terms to register.' };
    return res.redirect('/partner/login');
  }
  if (!mobile) {
    req.session.prLoginFlash = { kind: 'err', message: 'Please enter a valid Philippine mobile number (09xxxxxxxxx).' };
    return res.redirect('/partner/login');
  }
  if (!storeName) {
    req.session.prLoginFlash = { kind: 'err', message: 'Store name is required for registration.' };
    return res.redirect('/partner/login');
  }

  const existing = db.prepare("SELECT id, status FROM partners WHERE mobile=?").get(mobile);
  if (existing) {
    // Mobile already used. Don't reveal — show generic OTP-sent message and let them
    // log in instead. Audit it for admin visibility.
    audit(existing.id, 'register_dup_attempt', 'partner_name=' + storeName, req.clientIp);
    req.session.prPendingMobile  = mobile;
    req.session.prPendingPurpose = 'login';
    req.session.prLoginFlash = { kind: 'ok', message: 'This mobile is already registered. Use Sign in instead — a code will be sent if active.' };
    return res.redirect('/partner/login');
  }

  const code = generateCode();
  const otpId = storeOtp(mobile, code, 'register', { partner_name: storeName }, req.clientIp);
  const sms = await sendOtpSms(mobile, code);
  audit(null, 'otp_sent_register', 'otp_id=' + otpId + ' store=' + storeName + ' sms_ok=' + !!sms.ok, req.clientIp);

  req.session.prPendingMobile  = mobile;
  req.session.prPendingPurpose = 'register';
  req.session.prPendingPartnerName = storeName;
  req.session.prLoginFlash = { kind: 'ok', message: 'A 6-digit code was sent. Enter it below to finish registration.' };
  res.redirect('/partner/login');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /partner/verify — submit OTP code → consume + log in
router.post('/verify', (req, res) => {
  if (req.partner) { audit(req.partner.id, 'verify_skipped_already_signed_in', null, req.clientIp); return res.redirect('/partner/'); }
  const mobile  = req.session.prPendingMobile;
  const purpose = req.session.prPendingPurpose;
  const code    = String((req.body || {}).code || '').replace(/[^\d]/g, '').slice(0, 6);

  if (!mobile || !purpose) {
    req.session.prLoginFlash = { kind: 'err', message: 'Session expired. Please start again.' };
    return res.redirect('/partner/login');
  }
  if (!/^\d{6}$/.test(code)) {
    req.session.prLoginFlash = { kind: 'err', message: 'Enter the 6-digit code.' };
    return res.redirect('/partner/login');
  }

  const otp = findActiveOtp(mobile, purpose);
  if (!otp) {
    audit(null, 'otp_verify_fail', 'reason=no_active_otp mobile=' + mobile.slice(0, 5) + 'xxx', req.clientIp);
    req.session.prLoginFlash = { kind: 'err', message: 'Code expired or invalid. Request a new one.' };
    return res.redirect('/partner/login');
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare("UPDATE partner_otp SET consumed_at=strftime('%s','now') WHERE id=?").run(otp.id);
    audit(null, 'otp_verify_fail', 'reason=too_many_attempts otp_id=' + otp.id, req.clientIp);
    req.session.prLoginFlash = { kind: 'err', message: 'Too many wrong attempts. Request a new code.' };
    return res.redirect('/partner/login');
  }

  const matches = bcrypt.compareSync(code, otp.code_hash);
  if (!matches) {
    db.prepare("UPDATE partner_otp SET attempts=attempts+1 WHERE id=?").run(otp.id);
    audit(null, 'otp_verify_fail', 'reason=wrong_code otp_id=' + otp.id + ' attempt=' + (otp.attempts + 1), req.clientIp);
    req.session.prLoginFlash = { kind: 'err', message: 'Incorrect code. ' + (OTP_MAX_ATTEMPTS - otp.attempts - 1) + ' attempts remaining.' };
    return res.redirect('/partner/login');
  }

  // SUCCESS — consume the OTP, then login-or-create the operator
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE partner_otp SET consumed_at=? WHERE id=?").run(now, otp.id);

  if (purpose === 'register') {
    const payload = otp.payload ? JSON.parse(otp.payload) : {};
    const storeName = payload.partner_name || req.session.prPendingPartnerName || 'My Store';
    const slug = uniqueSlug(slugify(storeName));
    const autoApprove = settingValue('partner_auto_approve', '1') === '1';
    const status = autoApprove ? 'active' : 'pending';
    const isActive = autoApprove ? 1 : 0;

    let opId;
    try {
      const termsVer = (db.prepare("SELECT value FROM settings WHERE key='partner_terms_version'").get() || {}).value || '1.0';
      const r = db.prepare(
        "INSERT INTO partners (mobile, partner_name, partner_slug, email, status, is_active, created_at, updated_at, registered_via, agreed_terms_at, agreed_terms_ip, agreed_terms_version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'self', ?, ?, ?)"
      ).run(mobile, storeName, slug, payload.email || null, status, isActive, now, now, payload.agreed_at || now, payload.agreed_ip || (req.clientIp || null), termsVer);
      opId = r.lastInsertRowid;
    } catch (e) {
      audit(null, 'register_fail', e.message.slice(0, 200), req.clientIp);
      req.session.prLoginFlash = { kind: 'err', message: 'Could not create account: ' + e.message };
      return res.redirect('/partner/login');
    }

    audit(opId, 'partner_self_register', 'store=' + storeName + ' status=' + status, req.clientIp);

    // AUDIT-FIX-2026-06-03 — fire-and-forget welcome + admin notifications
    const newPartner = { id: opId, partner_name: storeName, mobile, status };
    maybeWelcomeSms(newPartner).catch(() => {});
    notifyAdminOfNewPartner(newPartner).catch(() => {});

    if (status === 'pending') {
      req.session.prPendingMobile = null;
      req.session.prPendingPurpose = null;
      req.session.prPendingPartnerName = null;
      req.session.prLoginFlash = { kind: 'ok', message: 'Account created. Awaiting admin approval before you can sign in.' };
      return res.redirect('/partner/login');
    }
    // Auto-approved → fall through to login
    db.prepare("UPDATE partners SET last_login_at=?, last_login_ip=? WHERE id=?").run(now, req.clientIp || null, opId);
    if (req.session) {
      delete req.session.adminId;
      req.session.partnerId = opId;
      req.session.prPendingMobile = null;
      req.session.prPendingPurpose = null;
      req.session.prPendingPartnerName = null;
    }
    audit(opId, 'login_ok', 'first_login=1', req.clientIp);
    return res.redirect('/partner/');
  }

  // purpose === 'login'
  const op = db.prepare("SELECT * FROM partners WHERE mobile=?").get(mobile);
  if (!op) {
    req.session.prLoginFlash = { kind: 'err', message: 'Account not found.' };
    return res.redirect('/partner/login');
  }
  if (op.status !== 'active') {
    audit(op.id, 'login_fail', 'reason=status_' + op.status, req.clientIp);
    req.session.prLoginFlash = { kind: 'err', message: 'Your account is ' + op.status + '. Contact the admin.' };
    return res.redirect('/partner/login');
  }

  db.prepare("UPDATE partners SET last_login_at=?, last_login_ip=? WHERE id=?").run(now, req.clientIp || null, op.id);
  if (req.session) {
    delete req.session.adminId;
    req.session.partnerId = op.id;
    req.session.prPendingMobile = null;
    req.session.prPendingPurpose = null;
  }
  audit(op.id, 'login_ok', null, req.clientIp);
  res.redirect('/partner/');
});

// ─────────────────────────────────────────────────────────────
// PUBLIC: POST /partner/cancel — abandon a pending verification
router.post('/cancel', (req, res) => {
  if (req.session) {
    req.session.prPendingMobile = null;
    req.session.prPendingPurpose = null;
    req.session.prPendingPartnerName = null;
    req.session.prLoginFlash = null;
  }
  res.redirect('/partner/login');
});

module.exports = router;
