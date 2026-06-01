'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const modules = require('../modules');
const fees    = require('../services/fees');

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title: locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error: null,
    ...locals
  });
}

function audit(adminId, action, details, ip) {
  db.prepare(`
    INSERT INTO audit_log (admin_id, action, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId || null, action, details || null, ip || null, Math.floor(Date.now() / 1000));
}

function flash(req, kind, msg) {
  if (!req.session) return;
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ kind, msg });
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}


// ── Combined Payments page (Options + Modules tabs) ──────────────────────────
router.get('/payments', requireAdmin, (req, res) => {
  const opts = db.prepare(`
    SELECT * FROM payment_options ORDER BY sort_order ASC, id ASC
  `).all();
  const mods = modules.listModules();
  // Build module → actions map for JS dropdowns, filtered by enabled_actions
  const allModuleActions = {};
  mods.forEach(m => {
    if (m.hasAdapter && m.actions) {
      const enabled = m.config.enabled_actions;
      // null/undefined = not yet configured → show all actions
      // array (even empty) = respect the saved selection
      const filtered = (Array.isArray(enabled))
        ? Object.fromEntries(Object.entries(m.actions).filter(([k]) => enabled.includes(k)))
        : m.actions;
      allModuleActions[m.id] = filtered;
    }
  });
  // Unfiltered actions for the Sync UI (needs to show inactive channels too)
  const allActionsRaw = {};
  mods.forEach(m => { if (m.hasAdapter && m.actions) allActionsRaw[m.id] = m.actions; });

  // PHASE1-PAYMENTSETTINGS-2026-06-01 — webhook base derived from public
  // domain (paywifi.net), NOT the captive IP, so the placeholder is real.
  const _dnRow = db.prepare("SELECT value FROM settings WHERE key='domain_name'").get();
  const _webhookBase = (_dnRow && _dnRow.value && _dnRow.value.trim())
    ? _dnRow.value.trim().replace(/\/$/, '')
    : ((req.protocol === 'https' ? 'https' : 'http') + '://' + (req.headers.host || 'paywifi.net'));

  // Mode hint: deduce test/live from secret_key prefix without exposing the key.
  const _moduleModes = {};
  for (const m of mods) {
    const k = (m.config && m.config.secret_key) || '';
    _moduleModes[m.slug] = k.startsWith('xnd_development_') ? 'test'
                        : k.startsWith('xnd_production_')  ? 'live'
                        : null;
  }

  render(res, 'payments', {
    title: 'Payments · PAYWIFI',
    active: 'payments',
    options: opts,
    modules: mods,
    allModuleActions,
    allActionsRaw,
    webhookBase: _webhookBase,
    moduleModes: _moduleModes,
  });
});

// Redirect old sub-URLs to the combined page with the right tab hash
router.get('/payment-options', requireAdmin, (req, res) => res.redirect('/admin/payments#options'));
router.get('/payment-modules', requireAdmin, (req, res) => res.redirect('/admin/payments#modules'));

// ── Payment Modules list (kept for POST routes below) ───────────────────────
router.get('/payment-modules-legacy', requireAdmin, (req, res) => {
  const mods = modules.listModules();
  render(res, 'payment_modules', {
    title: 'Payment Modules · PAYWIFI',
    active: 'payment-modules',
    modules: mods,
  });
});

// Toggle a module active/inactive
router.post('/payment-modules/:slug/toggle', requireAdmin, (req, res) => {
  const { slug } = req.params;
  const mod = db.prepare('SELECT * FROM payment_modules WHERE slug=?').get(slug);
  if (!mod) { flash(req, 'err', 'Module not found.'); return res.redirect('/admin/payments'); }
  const newVal = mod.is_active ? 0 : 1;
  db.prepare('UPDATE payment_modules SET is_active=? WHERE slug=?').run(newVal, slug);
  audit(req.admin?.id, 'payment_module_toggle', `slug=${slug} is_active=${newVal}`, req.clientIp);
  flash(req, 'ok', `"${mod.name}" ${newVal ? 'enabled' : 'disabled'}.`);
  res.redirect('/admin/payments#modules');
});

// Save module configuration
router.post('/payment-modules/:slug/configure', requireAdmin, (req, res) => {
  const { slug } = req.params;
  const mod = db.prepare('SELECT * FROM payment_modules WHERE slug=?').get(slug);
  if (!mod) { flash(req, 'err', 'Module not found.'); return res.redirect('/admin/payments'); }

  // Parse existing config, merge new values from form
  let existing = {};
  try { existing = JSON.parse(mod.config_json || '{}'); } catch (e) {}

  // Collect only known scalar fields
  const allowed = ['environment', 'secret_key', 'public_key', 'webhook_token', 'merchant_id', 'api_version', 'base_url', 'create_path', 'status_path'];
  const updated = { ...existing };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      const val = String(req.body[key] || '').trim();
      // Only overwrite if a real value was submitted; blank = keep existing, placeholder = keep existing
      if (val && val !== '••••••••') updated[key] = val;
    }
  }
  // enabled_actions_json is a hidden field pre-populated and kept current by JS.
  // It is always present and always reflects the exact checkbox state at submit time.
  if (req.body.enabled_actions_json !== undefined) {
    try {
      const parsed = JSON.parse(req.body.enabled_actions_json);
      if (Array.isArray(parsed)) updated.enabled_actions = parsed;
    } catch (e) { /* malformed JSON — leave enabled_actions unchanged */ }
  }

  modules.saveConfig(slug, updated);
  audit(req.admin?.id, 'payment_module_configure', `slug=${slug}`, req.clientIp);
  flash(req, 'ok', `${mod.name} configuration saved.`);
  res.redirect('/admin/payments#modules');
});



// ── Sync channel availability from gateway ───────────────────────────────────
router.get('/payment-modules/:slug/sync-channels', requireAdmin, async (req, res) => {
  const { slug } = req.params;
  const mod = modules.getModule(slug);
  if (!mod) return res.json({ ok: false, message: 'Module not found.' });
  if (!mod.adapter || typeof mod.adapter.syncChannels !== 'function') {
    return res.json({ ok: false, message: 'This module does not support channel sync.' });
  }
  try {
    const result = await mod.adapter.syncChannels(mod.config);
    // Auto-save channel statuses to config so they persist on page reload
    if (result.ok && result.channels) {
      let cfg = {};
      try { cfg = JSON.parse((db.prepare('SELECT config_json FROM payment_modules WHERE slug=?').get(slug) || {}).config_json || '{}'); } catch(e) {}
      cfg.channel_statuses = result.channels;
      modules.saveConfig(slug, cfg);
    }
    audit(req.admin?.id, 'payment_module_sync', `slug=${slug}`, req.clientIp);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ── Test module connection ───────────────────────────────────────────────────
router.get('/payment-modules/:slug/test', requireAdmin, async (req, res) => {
  const { slug } = req.params;
  const mod = modules.getModule(slug);
  if (!mod) return res.json({ ok: false, message: 'Module not found.' });
  if (!mod.adapter || typeof mod.adapter.testConnection !== 'function') {
    return res.json({ ok: false, message: 'This module does not support connection testing.' });
  }
  try {
    const result = await mod.adapter.testConnection(mod.config);
    audit(req.admin?.id, 'payment_module_test', `slug=${slug} ok=${result.ok}`, req.clientIp);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ── Payment fees (per-channel + global mode) ─────────────────────────────────
router.get('/payment-fees', requireAdmin, (req, res) => {
  const flashes = (req.session && req.session.flash) || [];
  if (req.session) req.session.flash = [];
  const report = db.prepare(`
    SELECT COALESCE(channel_name, module_action, 'Manual') AS channel,
           COUNT(*) AS cnt,
           COALESCE(SUM(amount),0) AS gross,
           COALESCE(SUM(fee_amount),0) AS fees,
           COALESCE(SUM(net_amount),0) AS net,
           COALESCE(SUM(settlement_amount),0) AS settled
    FROM pending_payments WHERE status='paid'
    GROUP BY channel ORDER BY gross DESC
  `).all();
  render(res, 'payment_fees', {
    title: 'Payment Fees · PAYWIFI Admin', active: 'payment-fees',
    feeList: fees.listFees(), feeCfg: fees.getFeeCfg(), report, flashes,
  });
});
router.post('/payment-fees/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  fees.saveFeeCfg({ pass: String(b.fee_pass) === '1', display: String(b.fee_display) === '1' });
  audit(req.admin?.id, 'payment_fee_config', `pass=${b.fee_pass} display=${b.fee_display}`, req.clientIp);
  flash(req, 'ok', 'Fee mode saved.');
  res.redirect('/admin/payment-fees');
});
router.post('/payment-fees/channels', requireAdmin, (req, res) => {
  const b = req.body || {};
  let n = 0;
  for (const row of fees.listFees()) {
    const a = row.channel_action;
    const pct = b['pct_' + a], fix = b['fix_' + a];
    if (pct !== undefined || fix !== undefined) {
      fees.saveChannelFee(a, pct !== undefined ? pct : row.fee_percent, fix !== undefined ? fix : row.fee_fixed);
      n++;
    }
  }
  audit(req.admin?.id, 'payment_fee_channels', `updated=${n}`, req.clientIp);
  flash(req, 'ok', `Saved fees for ${n} channel(s).`);
  res.redirect('/admin/payment-fees');
});

router.get('/payment-fees/report.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(channel_name, module_action, 'Manual') AS channel,
           COUNT(*) AS cnt,
           COALESCE(SUM(amount),0) AS gross,
           COALESCE(SUM(fee_amount),0) AS fees,
           COALESCE(SUM(net_amount),0) AS net,
           COALESCE(SUM(settlement_amount),0) AS settled
    FROM pending_payments WHERE status='paid'
    GROUP BY channel ORDER BY gross DESC
  `).all();
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  let csv = 'Channel,Transactions,Gross,Fees,Net,Settlement\n';
  for (const r of rows) csv += [r.channel, r.cnt, r.gross, r.fees, r.net, r.settled].map(esc).join(',') + '\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="paywifi-channel-report.csv"');
  res.send(csv);
});

module.exports = router;
