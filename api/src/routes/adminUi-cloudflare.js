'use strict';
// PAYWIFI-CLOUDFLARED-2026-06-01 — admin UI for configuring the cloudflared
// tunnel token. SQLite settings table is the source of truth; saving here
// writes the row, then calls `sudo paywifi-cloudflared-apply` which
// regenerates /etc/paywifi/cloudflared.env, rewrites the systemd unit, and
// restarts the service.
const express      = require('express');
const router       = express.Router();
const db           = require('../db');
const { execFileSync, spawnSync } = require('child_process');

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title:  locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error:  null,
    flash:  null,
    ...locals
  });
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}

// ── settings helpers ────────────────────────────────────────────────────────
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run(key, value, now);
}

// Decode the `t` (tunnel id) and `a` (account id) from a Cloudflare tunnel token.
// The token is a base64-encoded JSON blob: { "a": "...", "t": "...", "s": "..." }
function decodeToken(tok) {
  if (!tok) return { tunnel_id: '', account_id: '', valid: false };
  try {
    const json = Buffer.from(tok, 'base64').toString('utf-8');
    const obj  = JSON.parse(json);
    return {
      tunnel_id:  obj.t || '',
      account_id: obj.a || '',
      valid: Boolean(obj.t && obj.a && obj.s)
    };
  } catch (e) {
    return { tunnel_id: '', account_id: '', valid: false };
  }
}

function maskToken(tok) {
  if (!tok || tok.length < 20) return '';
  return tok.slice(0, 8) + '…' + tok.slice(-6);
}

function systemctlActive() {
  const r = spawnSync('sudo', ['-n', '/bin/systemctl', 'is-active', 'cloudflared'], { encoding: 'utf-8' });
  return (r.stdout || '').trim() || 'unknown';
}

function readJournal() {
  try {
    const r = spawnSync(
      'journalctl',
      ['-u', 'cloudflared', '--no-pager', '-n', '10', '-o', 'short-iso'],
      { encoding: 'utf-8' }
    );
    if (r.status === 0) return (r.stdout || '').trim();
    return '(journalctl not accessible)';
  } catch (e) {
    return '(journalctl error)';
  }
}

function audit(adminId, action, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(adminId || null, action, details || '', ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}

// ── GET /admin/cloudflare ────────────────────────────────────────────────────
router.get('/cloudflare', requireAdmin, (req, res) => {
  const token = getSetting('cf_tunnel_token');
  const meta  = decodeToken(token);

  const ctx = {
    title:  'Cloudflare Tunnel · PAYWIFI',
    active: 'cloudflare',
    cf: {
      hasToken:       Boolean(token),
      tokenMasked:    maskToken(token),
      tokenLength:    token ? token.length : 0,
      tunnel_id:      getSetting('cf_tunnel_id')  || meta.tunnel_id,
      account_id:     getSetting('cf_account_id') || meta.account_id,
      hostname:       getSetting('cf_hostname', 'paywifi.net'),
      enabled:        getSetting('cf_enabled', '1') === '1',
      autoupdate:     getSetting('cf_autoupdate_enabled', '0') === '1',
      last_applied_at: parseInt(getSetting('cf_last_applied_at', '0'), 10) || 0,
      last_applied_by: getSetting('cf_last_applied_by', ''),
    },
    serviceState: systemctlActive(),
    journal: readJournal(),
    flash: req.session.cfFlash || null,
  };
  delete req.session.cfFlash;
  render(res, 'cloudflare', ctx);
});

// ── POST /admin/cloudflare/save  ─ update token / hostname / autoupdate ─────
router.post('/cloudflare/save', requireAdmin, (req, res) => {
  const newToken    = (req.body.token    || '').trim();
  const hostname    = (req.body.hostname || '').trim() || 'paywifi.net';
  const autoupdate  = req.body.autoupdate === '1' || req.body.autoupdate === 'on';

  const errors = [];
  let tokenChanged = false;

  if (newToken && newToken !== '__unchanged__') {
    const meta = decodeToken(newToken);
    if (!meta.valid) {
      errors.push('Token does not decode to a valid Cloudflare tunnel descriptor (expected JSON with a/t/s fields).');
    } else {
      setSetting('cf_tunnel_token', newToken);
      setSetting('cf_tunnel_id',    meta.tunnel_id);
      setSetting('cf_account_id',   meta.account_id);
      tokenChanged = true;
    }
  }

  if (!errors.length) {
    setSetting('cf_hostname',           hostname);
    setSetting('cf_autoupdate_enabled', autoupdate ? '1' : '0');

    const now = Math.floor(Date.now() / 1000);
    setSetting('cf_last_applied_at', String(now));
    setSetting('cf_last_applied_by', req.admin.username || 'admin');

    try {
      const out = execFileSync('sudo', ['-n', '/usr/local/sbin/paywifi-cloudflared-apply'], { encoding: 'utf-8', timeout: 15000 });
      audit(req.admin.id, 'cf_token_updated',
            (tokenChanged ? 'token_replaced ' : 'config_updated ') + 'host=' + hostname + ' autoupd=' + (autoupdate?1:0),
            req.clientIp);
      req.session.cfFlash = { kind: 'ok', message: 'Saved. ' + (out || '').trim() };
    } catch (e) {
      audit(req.admin.id, 'cf_apply_failed', String(e.message || e).slice(0, 240), req.clientIp);
      req.session.cfFlash = { kind: 'err', message: 'DB saved but apply failed: ' + String(e.message || e).slice(0, 200) };
    }
  } else {
    req.session.cfFlash = { kind: 'err', message: errors.join(' ') };
  }

  res.redirect('/admin/cloudflare');
});

// ── POST /admin/cloudflare/toggle  ─ enable / disable the service ──────────
router.post('/cloudflare/toggle', requireAdmin, (req, res) => {
  const want = req.body.enable === '1' || req.body.enable === 'on';
  setSetting('cf_enabled', want ? '1' : '0');
  setSetting('cf_last_applied_at', String(Math.floor(Date.now() / 1000)));
  setSetting('cf_last_applied_by', req.admin.username || 'admin');
  try {
    execFileSync('sudo', ['-n', '/usr/local/sbin/paywifi-cloudflared-apply'], { encoding: 'utf-8', timeout: 15000 });
    audit(req.admin.id, want ? 'cf_enabled' : 'cf_disabled', '', req.clientIp);
    req.session.cfFlash = { kind: 'ok', message: want ? 'Tunnel started.' : 'Tunnel stopped.' };
  } catch (e) {
    req.session.cfFlash = { kind: 'err', message: 'Toggle failed: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/cloudflare');
});

// ── POST /admin/cloudflare/restart ─ kick the service ──────────────────────
router.post('/cloudflare/restart', requireAdmin, (req, res) => {
  try {
    execFileSync('sudo', ['-n', '/bin/systemctl', 'restart', 'cloudflared'], { encoding: 'utf-8', timeout: 15000 });
    audit(req.admin.id, 'cf_restart', '', req.clientIp);
    req.session.cfFlash = { kind: 'ok', message: 'cloudflared restarted.' };
  } catch (e) {
    req.session.cfFlash = { kind: 'err', message: 'Restart failed: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/cloudflare');
});

module.exports = router;
