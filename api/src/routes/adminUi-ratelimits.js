'use strict';
const express = require('express');
const router  = express.Router();
const rl      = require('../services/rateLimiter');
const sms     = require('../services/smsLimiter');
const db      = require('../db');

function render(res, view, locals = {}) {
  res.render('admin/' + view, { title: locals.title || 'PAYWIFI Admin', active: locals.active || '', error: null, ...locals });
}
function flash(req, kind, msg) {
  if (!req.session) return;
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ kind, msg });
}
function requireAdmin(req, res, next) { if (!req.admin) return res.redirect('/admin/login'); next(); }
router.use(requireAdmin);

// ── GET /admin/rate-limits ────────────────────────────────────────────────────
router.get('/rate-limits', (req, res) => {
  const now     = Math.floor(Date.now() / 1000);
  const rlCfg   = rl.getRlCfg();
  const entries = rl.rlList(now);
  const flashes = (req.session && req.session.flash) || [];
  if (req.session) req.session.flash = [];

  // PHASE1-ATTEMPTS-2026-06-01 — port PaymentAttemptsCard counters.
  // "Failed attempts" = rl attempts that did NOT result in a paid pending row
  // for the same device key within the next 15 min. Heuristic that maps cleanly
  // to the rate-limit log without joining across user-id space.
  const _hourAgo = now - 3600;
  const _dayAgo  = now - 86400;
  const _failedHr = db.prepare(
    "SELECT COUNT(*) AS n FROM payment_rate_limit_log WHERE attempt_at > ? AND cleared_at IS NULL"
  ).get(_hourAgo).n;
  const _failedDay = db.prepare(
    "SELECT COUNT(*) AS n FROM payment_rate_limit_log WHERE attempt_at > ? AND cleared_at IS NULL"
  ).get(_dayAgo).n;
  // Per-plan: join pending_payments by client_mac/client_ip within the hour.
  const _perPlan = db.prepare(
    "SELECT vp.id AS plan_id, vp.name AS plan_name, " +
    "  SUM(CASE WHEN pp.status IN ('cancelled','expired') THEN 1 ELSE 0 END) AS failed_hr " +
    "FROM voucher_plans vp " +
    "LEFT JOIN pending_payments pp ON pp.plan_id = vp.id AND pp.created_at > ? " +
    "WHERE vp.is_active = 1 " +
    "GROUP BY vp.id, vp.name ORDER BY vp.id"
  ).all(_hourAgo);

  render(res, 'rate_limits', {
    title: 'Rate Limits · PAYWIFI Admin', active: 'rate-limits',
    entries, now, rlCfg, flashes,
    smsCfg: sms.getSmsCfg(), smsUsage: sms.smsUsage(),
    // PHASE1-ATTEMPTS:
    failedHr: _failedHr, failedDay: _failedDay, perPlan: _perPlan,
  });
});

// ── POST /admin/rate-limits/config — save RL configuration ───────────────────
router.post('/rate-limits/config', (req, res) => {
  const b = req.body || {};
  const win  = parseInt(b.rl_window_min,         10);
  const maxA = parseInt(b.rl_max_attempts,        10);
  const gap  = parseInt(b.rl_gap_sec,             10);
  const cool = parseInt(b.rl_cancel_cooldown_sec, 10);
  if (isNaN(win)  || win  < 1  || win  > 1440) { flash(req,'err','Window must be 1–1440 minutes.');        return res.redirect('/admin/rate-limits'); }
  if (isNaN(maxA) || maxA < 1  || maxA > 50  ) { flash(req,'err','Max attempts must be 1–50.');             return res.redirect('/admin/rate-limits'); }
  if (isNaN(gap)  || gap  < 0  || gap  > 3600) { flash(req,'err','Min gap must be 0–3600 seconds.');        return res.redirect('/admin/rate-limits'); }
  if (isNaN(cool) || cool < 0  || cool > 3600) { flash(req,'err','Cancel cooldown must be 0–3600 seconds.'); return res.redirect('/admin/rate-limits'); }
  rl.rlSaveCfg({ rl_window_min: win, rl_max_attempts: maxA, rl_gap_sec: gap, rl_cancel_cooldown_sec: cool });
  flash(req, 'ok', 'Rate limit configuration saved.');
  res.redirect('/admin/rate-limits');
});

// ── POST /admin/rate-limits/clear — remove one device ────────────────────────
router.post('/rate-limits/clear', (req, res) => {
  const key = (req.body || {}).key;
  if (!key) { flash(req, 'err', 'Device key required.'); return res.redirect('/admin/rate-limits'); }
  rl.rlClear(key, (req.admin || {}).username || 'admin');
  flash(req, 'ok', `Restriction removed for ${key}.`);
  res.redirect('/admin/rate-limits');
});

// ── POST /admin/rate-limits/clear-all — wipe all active restrictions ──────────
router.post('/rate-limits/clear-all', (req, res) => {
  rl.rlClearAll((req.admin || {}).username || 'admin');
  flash(req, 'ok', 'All payment restrictions cleared.');
  res.redirect('/admin/rate-limits');
});

// ── POST /admin/rate-limits/sms-config — save SMS limiter configuration ───────
router.post('/rate-limits/sms-config', (req, res) => {
  const b = req.body || {};
  sms.saveSmsCfg({
    sms_rl_enabled:          String(b.sms_rl_enabled) === '1',
    sms_rl_phone_window_min: b.sms_rl_phone_window_min,
    sms_rl_phone_max:        b.sms_rl_phone_max,
    sms_rl_global_daily_max: b.sms_rl_global_daily_max,
  });
  flash(req, 'ok', 'SMS rate limit configuration saved.');
  res.redirect('/admin/rate-limits');
});

module.exports = router;
