'use strict';
// PAYWIFI-PUBLIC-HOST-BLOCK-2026-06-01 — refuse payment-initiation requests
// whose Host header matches a configured public hostname (e.g. paywifi.net).
// LAN clients hit the gateway by IP (10.10.0.1) or the captive redirect, so
// their Host is 10.10.0.1 — they pass through. Requests proxied in through
// the Cloudflare tunnel carry the public hostname and get a 403.
//
// The blocklist comes from the `payment_blocked_hosts` row in `settings`
// (comma-separated). Edit it via /admin/settings.
const db = require('../db');

let cache = { ts: 0, hosts: new Set() };

function loadHosts() {
  const now = Date.now();
  if (now - cache.ts < 5000) return cache.hosts;          // tiny TTL — pick up admin edits fast
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='payment_blocked_hosts'").get();
    const csv = (row && row.value) || '';
    cache = { ts: now, hosts: new Set(csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) };
  } catch (e) {
    cache = { ts: now, hosts: new Set() };
  }
  return cache.hosts;
}

module.exports = function blockPublicPayments(req, res, next) {
  const raw = String(req.headers.host || '').toLowerCase();
  // Host header may include port (e.g. "paywifi.net:443") — strip it for comparison.
  const host = raw.split(':')[0];
  if (!host) return next();

  const hosts = loadHosts();
  if (hosts.has(host)) {
    return res.status(403).json({
      ok: false,
      code: 'NON_LAN_HOST',
      error: 'public_host_blocked',
      message: 'Payments must be made on the PAYWIFI hotspot network. Connect to the hotspot Wi-Fi and try again.'
    });
  }
  next();
};
# touched-by-push-test-1780333933
