'use strict';
const { execFileSync } = require('child_process');
const router    = require('express').Router();
const db        = require('../db');
const nurturing = require('../services/nurturing');

// Require authenticated admin session for all routes in this file
router.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();  // never guard the login page (loop fix)
  if (!req.admin) return res.redirect('/admin/login');
  next();
});

function render(res, view, locals) {
  const settings = db.prepare('SELECT key,value FROM settings').all();
  res.render('admin/' + view, Object.assign({
    settings,
    admin: res.locals.admin,
    flash: res.locals.flash || [],
    csrfToken: res.locals.csrfToken
  }, locals));
}

function audit(adminId, action, detail, ip) {
  const t = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO audit_log(admin_id,action,details,ip_address,created_at) VALUES(?,?,?,?,?)')
    .run(adminId, action, detail, ip, t);
}

function flash(req, kind, msg) {
  if (!req.session) return;
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ kind, msg });
}

// GET /admin/nurturing
router.get('/nurturing', (req, res) => {
  const configs = db.prepare("SELECT * FROM lead_nurturing_config ORDER BY CASE phase WHEN 'new_user' THEN 0 WHEN 'signup_reward' THEN 1 WHEN 'welcome_gift' THEN 2 ELSE 9 END").all();
  const total     = db.prepare('SELECT COUNT(*) n FROM lead_funnel').get().n;
  const byStage   = db.prepare('SELECT stage, COUNT(*) n FROM lead_funnel GROUP BY stage ORDER BY n DESC').all();
  const paid      = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) revenue FROM pending_payments WHERE status='paid'").get();
  const converted = db.prepare('SELECT COUNT(*) n FROM lead_funnel WHERE converted_at IS NOT NULL').get().n;
  const recentLeads = db.prepare(
    'SELECT lf.*, pu.phone AS user_phone FROM lead_funnel lf LEFT JOIN portal_users pu ON pu.id=lf.user_id ORDER BY lf.updated_at DESC LIMIT 50'
  ).all();
  render(res, 'nurturing', { active: 'nurturing', title: 'Pipelines', configs, total, byStage, paid, converted, recentLeads });
});

// POST /admin/nurturing/phase/:phase
router.post('/nurturing/phase/:phase', (req, res) => {
  const { phase } = req.params;
  const b = req.body;
  const t = Math.floor(Date.now() / 1000);
  const valid = ['new_user', 'signup_reward', 'welcome_gift'];
  if (!valid.includes(phase)) return res.status(400).send('Invalid phase.');

  db.prepare(`
    UPDATE lead_nurturing_config SET
      enabled          = ?,
      duration_minutes = ?,
      bandwidth_kbps   = ?,
      alert_title      = ?,
      alert_body       = ?,
      alert_cta        = ?,
      sms_enabled      = ?,
      sms_template     = ?,
      updated_at       = ?
    WHERE phase = ?
  `).run(
    b.enabled === '1' ? 1 : 0,
    parseInt(b.duration_minutes, 10) || 0,
    parseInt(b.bandwidth_kbps,   10) || 0,
    (b.alert_title  || '').trim(),
    (b.alert_body   || '').trim(),
    (b.alert_cta    || '').trim(),
    b.sms_enabled === '1' ? 1 : 0,
    (b.sms_template || '').trim(),
    t,
    phase
  );
  audit(req.admin.id, 'nurturing_phase_update', 'phase=' + phase, req.clientIp);
  res.redirect('/admin/nurturing');
});

// POST /admin/nurturing/reset-all
// Kicks all active sessions, clears remembered devices, lead funnel, and voucher queue.
// Used to restart the nurture campaign from a clean slate.
router.post('/nurturing/reset-all', (req, res) => {
  const t = Math.floor(Date.now() / 1000);

  // 1. Collect active IPs for tc cleanup
  const activeSessions = db.prepare('SELECT ip_address FROM sessions WHERE ended_at IS NULL').all();

  // 2. End all active sessions
  const sessR = db.prepare(
    "UPDATE sessions SET ended_at=?, end_reason='nurture_reset' WHERE ended_at IS NULL"
  ).run(t);

  // 3. Clear remembered devices (prevent MAC-based auto-reconnect bypassing nurture)
  const remR  = db.prepare('DELETE FROM remembered_devices').run();

  // 4. Clear lead funnel records
  const leadR = db.prepare('DELETE FROM lead_funnel').run();

  // 5. Clear pending voucher queue (stacked rewards from the old cycle)
  const queueR = db.prepare('DELETE FROM voucher_queue').run();

  // 6. Flush nftables allowlist — kicks all devices off the internet
  try { execFileSync('paywifi-auth', ['flush'], { stdio: 'ignore' }); } catch (e) {}

  // 7. Remove tc shaping classes per IP
  for (const s of activeSessions) {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s.ip_address)) {
      try { execFileSync('paywifi-shape', ['del', s.ip_address], { stdio: 'ignore' }); } catch (e) {}
    }
  }

  audit(
    req.admin.id, 'nurturing_reset_all',
    `sessions=${sessR.changes} remembered=${remR.changes} leads=${leadR.changes} queued=${queueR.changes}`,
    req.clientIp
  );

  res.redirect('/admin/nurturing');
});

// POST /admin/nurturing/leads/clear
router.post('/nurturing/leads/clear', (req, res) => {
  const r = db.prepare('DELETE FROM lead_funnel').run();
  audit(req.admin.id, 'nurturing_leads_clear', r.changes + ' deleted', req.clientIp);
  res.redirect('/admin/nurturing');
});

module.exports = router;
