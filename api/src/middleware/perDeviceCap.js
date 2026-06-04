'use strict';
// PER-DEVICE-CAP-2026-06-03 — when device_cookie_strict_per_session=1, an
// authenticated session's API calls must come from the SAME device cookie that
// was minted at voucher redeem. Subsequent devices behind the same NAT
// (tethering, second laptop on same hotspot) get 403.
const crypto = require('crypto');
const db = require('../db');

let cache = { ts: 0, strict: false };
function strictMode() {
  const now = Date.now();
  if (now - cache.ts < 5000) return cache.strict;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='device_cookie_strict_per_session'").get();
    cache = { ts: now, strict: row && row.value === '1' };
  } catch (e) {
    cache = { ts: now, strict: false };
  }
  return cache.strict;
}

module.exports = function perDeviceCap(req, res, next) {
  if (!strictMode()) return next();
  // Find the active session bound to this MAC (set by clientInfo)
  const mac = req.clientMac;
  if (!mac) return next(); // no MAC to enforce against — pass through
  const sess = db.prepare(
    "SELECT id, device_token_hash FROM sessions WHERE mac_address=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
  ).get(mac);
  if (!sess || !sess.device_token_hash) return next(); // no bound device → pre-strict session, allow
  const cookieRaw = (req.cookies && req.cookies['pw_device']) || req.headers['x-device-token'] || '';
  const presented = cookieRaw ? crypto.createHash('sha256').update(String(cookieRaw)).digest('hex') : null;
  if (presented === sess.device_token_hash) return next();
  // Mismatch — log + reject
  try {
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL,'voucher_device_cap_reject',?,?,?)"
    ).run('mac=' + mac.slice(0,8) + '??? session_id=' + sess.id, req.clientIp || null, Math.floor(Date.now()/1000));
  } catch (e) {}
  return res.status(403).json({
    ok: false,
    code: 'DEVICE_CAP',
    error: "This voucher is already in use by another device on the same connection."
  });
};
