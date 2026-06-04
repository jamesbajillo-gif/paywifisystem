'use strict';
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');

// DEVICE-COOKIE-2026-06-03 — proof-of-possession cookie. Set at voucher
// redeem; verified at /api/portal/handshake. Cuts MAC-spoof + tethering
// abuse windows from hours to seconds.
const DEVICE_COOKIE = 'pw_device';
function newDeviceToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashDeviceToken(t) { return crypto.createHash('sha256').update(t || '').digest('hex'); }
function setDeviceCookie(req, res, token) {
  const maxAge = 30 * 24 * 3600 * 1000; // 30 days
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.PAYWIFI_HTTPS === '1',
    maxAge: maxAge,
    path: '/'
  });
}
function readDeviceCookie(req) {
  const fromCookie = req.cookies && req.cookies[DEVICE_COOKIE];
  if (fromCookie) return String(fromCookie);
  // Allow header fallback for testing / non-browser tooling
  const hdr = req.headers['x-device-token'];
  return hdr ? String(hdr) : null;
}
function rememberDeviceWithToken(mac, voucherId, validUntil, nowSec, tokenHash) {
  db.prepare(`
    INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at, device_token_hash, last_handshake_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mac_address) DO UPDATE SET
      voucher_id        = excluded.voucher_id,
      valid_until       = excluded.valid_until,
      device_token_hash = COALESCE(excluded.device_token_hash, remembered_devices.device_token_hash),
      last_handshake_at = excluded.last_handshake_at
  `).run(mac, voucherId, validUntil, nowSec, tokenHash || null, nowSec);
}

// VOUCHER-AUDIT-2026-06-03 — surface every redeem attempt to audit_log so
// security-relevant events survive log rotation (nginx logs roll weekly).
function auditVoucher(action, req, details) {
  try {
    const code = (req.body && req.body.code) ? String(req.body.code).toUpperCase().slice(0, 32) : '';
    const ip = req.clientIp || (req.headers['x-real-ip'] || '').toString().slice(0, 45);
    const mac = req.clientMac || '';
    const merged = (details || '') +
      ' ip=' + ip + ' mac=' + (mac ? mac.slice(0, 8) + '???' : '?') +
      (code ? ' code=' + code.slice(0,2) + '****' + code.slice(-2) : '');
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL, ?, ?, ?, ?)"
    ).run('voucher_' + action, merged.slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) { /* never block on audit */ }
}

// V-04: force-kick of existing sessions is privileged — honour it only for authenticated admins
function isAdminRequest(req) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.cookies && req.cookies.paywifi_admin);
  if (!token) return false;
  try { jwt.verify(token, db.cfg.api.jwt_secret); return true; } catch (e) { return false; }
}

function rememberDevice(mac, voucherId, validUntil, nowSec) {
  // legacy callers — pass through with no token; PoP not active for these paths
  return rememberDeviceWithToken(mac, voucherId, validUntil, nowSec, null);
}

function maskMac(mac) {
  if (!mac) return '??:??:??:??:??:??';
  const parts = mac.split(':');
  return parts.slice(0,3).concat(['??','??','??']).join(':');
}

router.post('/voucher', (req, res) => {
  const code  = String(req.body?.code  || '').toUpperCase().trim();
  const force = req.body?.force === true && isAdminRequest(req);  // V-04: admin-gated

  if (!code)          { auditVoucher('reject_empty', req, 'reason=empty_code'); return res.status(400).json({ ok: false, error: 'Please enter your voucher code.' }); }
  if (!req.clientIp)  { auditVoucher('reject_no_ip',  req, 'reason=no_client_ip');  return res.status(400).json({ ok: false, error: 'We could not detect your device. Please reconnect to the WiFi and try again.' }); }
  if (!req.clientMac) { auditVoucher('reject_no_mac', req, 'reason=no_client_mac'); return res.status(400).json({ ok: false, error: 'We could not detect your device. Please reconnect to the WiFi and try again.' }); }

  const voucher = voucherSvc.findByCode(code);
  if (!voucher) { auditVoucher('reject_unknown', req, 'reason=not_found'); return res.status(404).json({ ok: false, error: 'We could not find that voucher. Please check the code and try again.' }); }

  // Reject already-consumed voucher states
  if (!['unused', 'active', 'queued'].includes(voucher.status)) {
    auditVoucher('reject_consumed', req, 'reason=status_' + voucher.status);
    return res.status(400).json({ ok: false, error: 'This voucher cannot be used right now.' });
  }

  const now = Math.floor(Date.now() / 1000);

  // Same MAC already on this voucher — just touch it
  const existing = sessionSvc.findActiveByMac(req.clientMac);
  if (existing && existing.voucher_id === voucher.id) {
    sessionSvc.touchSession(existing.id, now);
    rememberDevice(req.clientMac, voucher.id, existing.expires_at || 0, now);
    const ftA = db.prepare('SELECT id FROM free_trial_claims WHERE voucher_id=? AND redeemed_at IS NULL LIMIT 1').get(voucher.id);
    if (ftA) db.prepare('UPDATE free_trial_claims SET redeemed_at=? WHERE id=?').run(now, ftA.id);
    auditVoucher('touch_existing', req, 'voucher_id=' + voucher.id + ' session_id=' + existing.id);
    // refresh device cookie if missing/different so the session is bound
    var _existingToken = readDeviceCookie(req);
    if (!_existingToken) {
      _existingToken = newDeviceToken();
      try {
        var _h = hashDeviceToken(_existingToken);
        db.prepare('UPDATE sessions SET device_token_hash=COALESCE(device_token_hash,?), device_first_seen=COALESCE(device_first_seen,?) WHERE id=?').run(_h, Math.floor(Date.now()/1000), existing.id);
        db.prepare('UPDATE remembered_devices SET device_token_hash=COALESCE(device_token_hash,?), last_handshake_at=? WHERE mac_address=?').run(_h, Math.floor(Date.now()/1000), req.clientMac);
      } catch (e) {}
      setDeviceCookie(req, res, _existingToken);
    }
    return res.json({ ok: true, session_id: existing.id, expires_at: existing.expires_at, message: 'Already connected.' });
  }

  // STACK-02/09/11: if session is active on a DIFFERENT voucher, queue instead of kill
  if (existing && existing.voucher_id !== voucher.id) {
    // Guard: already queued for THIS mac?
    const alreadyQueued = db.prepare(
      "SELECT id FROM voucher_queue WHERE mac_address=? AND voucher_id=? AND status='waiting'"
    ).get(req.clientMac, voucher.id);
    if (alreadyQueued) {
      return res.status(409).json({ ok: false, error: 'This voucher is already queued for your session.' });
    }
    // Guard: voucher already in queue for ANY mac?
    const ownedByOther = db.prepare(
      "SELECT id FROM voucher_queue WHERE voucher_id=? AND status='waiting'"
    ).get(voucher.id);
    if (ownedByOther) {
      return res.status(409).json({ ok: false, error: 'That voucher is already in use on another device.' });
    }

    // STACK-11: wrap queue insert in transaction to prevent race conditions
    const queueInsert = db.transaction(() => {
      const maxPos = db.prepare(
        "SELECT COALESCE(MAX(queue_position),-1) AS mp FROM voucher_queue WHERE mac_address=? AND status='waiting'"
      ).get(req.clientMac);
      const nextPos = (maxPos?.mp ?? -1) + 1;
      db.prepare("UPDATE vouchers SET status='queued' WHERE id=?").run(voucher.id);
      db.prepare(
        "INSERT INTO voucher_queue (mac_address, voucher_id, queue_position, queued_at) VALUES (?,?,?,?)"
      ).run(req.clientMac, voucher.id, nextPos, now);
      return nextPos;
    });

    let queuePos;
    try {
      queuePos = queueInsert();
    } catch (e) {
      auditVoucher('queue_fail', req, 'voucher_id=' + voucher.id + ' err=' + e.message.slice(0,80));
      return res.status(500).json({ ok: false, error: 'Something went wrong adding your voucher. Please try again.' });
    }
    auditVoucher('queued', req, 'voucher_id=' + voucher.id + ' pos=' + (queuePos+1));

    const remaining = Math.max(0, (existing.expires_at || 0) - now);
    // STACK-15: return queued:true with position
    return res.json({
      ok:              true,
      queued:          true,
      queue_position:  queuePos + 1,   // 1-based for display
      activates_after: remaining,
      duration_minutes: voucher.duration_minutes,
      bandwidth_kbps:  voucher.bandwidth_kbps,
      message:         `Voucher queued at position ${queuePos + 1}. Activates automatically when your current session ends.`
    });
  }

  // No active session — activate immediately (STACK-11: wrap in transaction)
  const doActivate = db.transaction(() => {
    // Check device limit
    const activeSessions = db.prepare(
      'SELECT id, ip_address, mac_address, started_at FROM sessions WHERE voucher_id=? AND ended_at IS NULL'
    ).all(voucher.id);

    if (activeSessions.length >= voucher.max_devices) {
      if (!force) return { conflict: true, activeSessions };
      for (const s of activeSessions) sessionSvc.endSession(s.id, 'kicked', now);
    }

    const activation = voucherSvc.activateVoucher(voucher, now);
    if (!activation.ok) return { failed: activation };

    // If this voucher was queued (waiting for reconnect), clean up the queue entry
    db.prepare("DELETE FROM voucher_queue WHERE voucher_id=? AND status='waiting'").run(voucher.id);

    const sid = sessionSvc.startSession({
      voucherId:     voucher.id,
      mac:           req.clientMac,
      ip:            req.clientIp,
      expiresAt:     activation.expiresAt,
      bandwidthKbps: voucher.bandwidth_kbps,
      nowSec:        now
    });
    rememberDevice(req.clientMac, voucher.id, activation.expiresAt, now);

    const ftB = db.prepare('SELECT id FROM free_trial_claims WHERE voucher_id=? AND redeemed_at IS NULL LIMIT 1').get(voucher.id);
    if (ftB) db.prepare('UPDATE free_trial_claims SET redeemed_at=? WHERE id=?').run(now, ftB.id);

    return { sid, expiresAt: activation.expiresAt };
  });

  let result;
  try {
    result = doActivate();
  } catch (e) {
    auditVoucher('activate_500', req, 'voucher_id=' + voucher.id + ' err=' + e.message.slice(0,80));
    return res.status(500).json({ ok: false, error: e.message });
  }

  if (result.conflict) {
    auditVoucher('reject_device_limit', req, 'voucher_id=' + voucher.id + ' active=' + result.activeSessions.length);
    return res.status(409).json({
      ok:          false,
      error:       'This voucher is already in use on another device.',
      code:        'DEVICE_LIMIT',
      max_devices: voucher.max_devices,
      sessions:    result.activeSessions.map(s => ({
        ip: s.ip_address, mac: maskMac(s.mac_address), started_at: s.started_at
      }))
    });
  }
  if (result.failed) { auditVoucher('reject_activation', req, 'voucher_id=' + voucher.id + ' err=' + (result.failed.error || 'unknown')); return res.status(400).json(result.failed); }

  auditVoucher('redeem_ok', req, 'voucher_id=' + voucher.id + ' session_id=' + result.sid);

  // Mint device cookie + persist hash on the session + the remembered_devices row.
  const dToken = newDeviceToken();
  const dHash  = hashDeviceToken(dToken);
  const dNow   = Math.floor(Date.now() / 1000);
  try {
    db.prepare('UPDATE sessions SET device_token_hash=?, device_first_seen=? WHERE id=?')
      .run(dHash, dNow, result.sid);
    db.prepare('UPDATE remembered_devices SET device_token_hash=?, last_handshake_at=? WHERE mac_address=?')
      .run(dHash, dNow, req.clientMac);
  } catch (e) { /* token persistence is best-effort */ }
  setDeviceCookie(req, res, dToken);

  res.json({
    ok:               true,
    session_id:       result.sid,
    expires_at:       result.expiresAt,
    duration_minutes: voucher.duration_minutes,
    bandwidth_kbps:   voucher.bandwidth_kbps
  });
});

module.exports = router;
