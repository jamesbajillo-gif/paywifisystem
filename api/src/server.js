'use strict';
const path    = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const db      = require('./db');
const clientInfo  = require('./middleware/clientInfo');
const csrf        = require('./middleware/csrf');
const adminSession= require('./middleware/adminSession');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Custom layout: every render is wrapped by admin/_layout.ejs
const ejs = require('ejs');
app.engine('ejs', (filePath, options, callback) => {
  ejs.renderFile(filePath, options, (err, body) => {
    if (err) return callback(err);
    // PARTNER-LAYOUT-DISPATCH-2026-06-01 — operator pages use their own layout.
    const isPartner = filePath.indexOf(path.sep + 'partner' + path.sep) !== -1;
    const layoutPath = path.join(__dirname, '..', 'views', isPartner ? 'partner' : 'admin', '_layout.ejs');
    ejs.renderFile(layoutPath, { ...options, body }, callback);
  });
});

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
// ---- Trust proxy: nginx is upstream, use X-Forwarded-For for real IPs ----
app.set('trust proxy', 1);   // nginx sets X-Forwarded-For

// ---- Rate limiting (R-03) -------------------------------------------------
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const rlKeyByIp = ipKeyGenerator;  // handles IPv6-mapped IPv4 correctly
// Admin login (UI + both API paths)
// PARTNER-LOGIN-RL-2026-06-02 — match adminLoginLimiter: 10 / 5 min per IP
const partnerLoginLimiter = rateLimit({ windowMs: 5*60*1000, max: 10, standardHeaders: true, skip: (r) => r.method !== 'POST', message: 'Too many sign-in attempts. Try again in 5 minutes.' });
const adminLoginLimiter = rateLimit({ windowMs: 5*60*1000, max: 10, standardHeaders: true, keyGenerator: rlKeyByIp, message: 'Too many attempts.' });
app.use('/admin/login',     adminLoginLimiter);
app.use('/admin-api/login', adminLoginLimiter);
app.use('/admin/api/login', adminLoginLimiter);   // was missing — primary JWT login path
app.use('/partner/login', partnerLoginLimiter);
// OTP rate limits: SMS-sending costs money — tighter caps.
const partnerOtpLimiter   = rateLimit({ windowMs: 60*1000,    max: 3,  standardHeaders: true, skip: (r) => r.method !== 'POST', message: 'Too many code requests. Wait a minute.' });
const partnerVerifyLimiter = rateLimit({ windowMs: 60*1000,   max: 15, standardHeaders: true, skip: (r) => r.method !== 'POST', message: 'Too many verification attempts. Wait a minute.' });
app.use('/partner/login',    partnerOtpLimiter);     // POST mobile → SMS
app.use('/partner/register', partnerOtpLimiter);     // POST mobile+store → SMS
app.use('/partner/verify',   partnerVerifyLimiter); 
// Portal endpoints
// PAYWIFI-PUBLIC-HOST-BLOCK-2026-06-01 — refuse payment endpoints from paywifi.net (public host)
const blockPublicPayments = require('./middleware/blockPublicPayments');
app.use('/portal/payment/create',  blockPublicPayments);
app.use('/auth/voucher',           blockPublicPayments);
app.use('/portal/auth/voucher',    blockPublicPayments);
// Audit extension 2026-06-03 — cover every payment-mutating endpoint
app.use('/portal/payment/cancel',  blockPublicPayments);
app.use('/portal/payment/status',  blockPublicPayments);
app.use('/portal/payment/pending', blockPublicPayments);
app.use('/portal/set-phone',       blockPublicPayments);
app.use('/portal/free-trial',      blockPublicPayments);
app.use('/auth/voucher',     rateLimit({ windowMs: 60*1000,     max: 20,  keyGenerator: rlKeyByIp, message: 'Too many voucher attempts.' }));
app.use('/portal/free-trial',rateLimit({ windowMs: 10*60*1000,  max: 5,   keyGenerator: rlKeyByIp, standardHeaders: true, message: JSON.stringify({ ok: false, error: 'Too many attempts. Try again in 10 minutes.' }) }));
app.use('/portal/payment/status', rateLimit({ windowMs: 60*1000, max: 60, keyGenerator: rlKeyByIp, message: JSON.stringify({ ok: false, error: 'Too many status requests.' }) }));
app.use('/portal/payment/cancel', rateLimit({ windowMs: 60*1000, max: 10, keyGenerator: rlKeyByIp, message: JSON.stringify({ ok: false, error: 'Too many cancel requests.' }) }));
// Webhooks — cap to prevent log flooding / fake-event spam
app.use('/webhooks', rateLimit({ windowMs: 60*1000, max: 120, keyGenerator: rlKeyByIp, message: JSON.stringify({ ok: false, error: 'Too many webhook requests.' }) }));
app.use(session({
  name: 'paywifi.admin.sid',
  secret: db.cfg.api.session_secret || db.cfg.api.jwt_secret,   // R-10: separate session secret
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.PAYWIFI_HTTPS === '1', maxAge: 12 * 3600 * 1000 }
}));
app.use(clientInfo);

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} ip=${req.clientIp || '?'} mac=${req.clientMac || '?'}`);
  next();
});

app.get('/health', (_req, res) => {
  // WAN-01: read WAN state from run-file written by sessiond
  let wan_online = true;
  try { wan_online = require('fs').readFileSync('/run/paywifi-wan-state', 'utf8').trim() === '1'; } catch (e) {}
  res.json({ ok: true, app: db.cfg.app.name, time: new Date().toISOString(), wan_online });
});

// ---- JSON API (Bearer JWT, no CSRF needed for /api/*) ---------------------
const deviceSync = require('./middleware/deviceSync');
app.use('/portal',  deviceSync, require('./routes/portal'));
app.use('/auth',    deviceSync, require('./routes/auth'));
app.use('/session', deviceSync, require('./routes/session'));
app.use('/admin/api', require('./routes/admin'));   // keep JSON admin under /admin/api for clarity
// Backwards-compat: original /admin JSON endpoints (kept)
app.use('/admin-api', require('./routes/admin'));

// ---- Admin web UI (cookie session + CSRF) ---------------------------------
app.use('/admin', adminSession, csrf, require('./routes/adminUi-nurturing'));  // lead nurturing
app.use('/admin', adminSession, csrf, require('./routes/adminUi-freetrial'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-payments'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-transactions'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-ratelimits'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-firewall'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-queue'));   // STACK-14
app.use('/admin', adminSession, csrf, require('./routes/adminUi-updates'));  // update logs
app.use('/admin', adminSession, csrf, require('./routes/adminUi-infra'));     // infrastructure health
app.use('/admin', adminSession, csrf, require('./routes/adminUi-devices'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-partners'));
app.use('/admin', adminSession, csrf, require('./routes/adminUi-remittances'));  // operator CRUD   // device diagnostics
app.use('/admin', adminSession, csrf, require('./routes/adminUi-cloudflare')); // PAYWIFI-CLOUDFLARED-2026-06-01 — Cloudflare tunnel admin

// PARTNER-ROUTE-MOUNT-2026-06-01 — cashier surface, static-password auth,
// completely scoped to /partner/* (the partner session has no /admin access).
app.use('/partner', csrf, require('./routes/partner'));

// ---- Webhooks (no auth — modules verify their own token) ------------------
app.use('/webhooks', require('./routes/webhooks'));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found.');
  res.status(404).json({ ok: false, error: 'Not found.' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('ERR', err);
  if (req.path.startsWith('/admin')) return res.status(500).send('Internal error: ' + (err.message || ''));
  res.status(500).json({ ok: false, error: err.message || 'Internal error.' });
});

const port = db.cfg.api.port || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`[PAYWIFI] API + Admin UI listening on 127.0.0.1:${port}`);
});
