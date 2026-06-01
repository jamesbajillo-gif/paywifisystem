'use strict';
// PAYWIFI-UPDATE-ADMIN-2026-06-02 — /admin/updates: changelog + git sync card.
const router = require('express').Router();
const db     = require('../db');
const fs     = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const GIT_STATUS_FILE = '/var/lib/paywifi/git-status.json';

function audit(adminId, action, details, ip) {
  try {
    db.prepare('INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(adminId || null, action, (details || '').slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}

function readGitStatus() {
  try {
    const raw = fs.readFileSync(GIT_STATUS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'no_status_yet', fetched_at: 0 };
  }
}

// Pull the last 80 journal lines from a oneshot unit so admins can see deploy output.
function readUnitLog(unit) {
  try {
    const r = spawnSync('journalctl', ['-u', unit, '--no-pager', '-n', '80', '-o', 'short-iso'], { encoding: 'utf-8' });
    if (r.status === 0) return (r.stdout || '').trim();
    return '';
  } catch (e) { return ''; }
}

function unitIsActive(unit) {
  try {
    const r = spawnSync('sudo', ['-n', '/bin/systemctl', 'is-active', unit], { encoding: 'utf-8' });
    return (r.stdout || '').trim();   // 'active' | 'activating' | 'inactive' | 'failed'
  } catch (e) { return 'unknown'; }
}

// GET /admin/updates — changelog + git sync card
router.get('/updates', (req, res) => {
  const cat = (req.query.category || '').trim();
  const rows = cat
    ? db.prepare('SELECT * FROM update_logs WHERE category=? ORDER BY created_at DESC, id DESC').all(cat)
    : db.prepare('SELECT * FROM update_logs ORDER BY created_at DESC, id DESC').all();
  const cats = db.prepare('SELECT DISTINCT category FROM update_logs ORDER BY category').all().map(r => r.category);

  const git         = readGitStatus();
  const updateState = unitIsActive('paywifi-update.service');
  const fetchState  = unitIsActive('paywifi-git-status.service');
  const deployLog   = readUnitLog('paywifi-update.service');

  res.render('admin/updates', {
    title:  'Update Logs · PAYWIFI',
    active: 'updates',
    rows, cats, filter: cat,
    git, updateState, fetchState, deployLog,
    flash: req.session.updateFlash || null,
    
  });
  delete req.session.updateFlash;
});

// POST /admin/updates/add — manual changelog entry
router.post('/updates/add', (req, res) => {
  const title    = (req.body && req.body.title    || '').trim();
  const body     = (req.body && req.body.body     || '').trim();
  let   category = (req.body && req.body.category || 'update').trim() || 'update';
  category = category.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'update';
  if (title) {
    db.prepare('INSERT INTO update_logs (title, body, category, author, created_at) VALUES (?,?,?,?,?)')
      .run(title.slice(0, 200), body.slice(0, 20000), category,
           (req.admin && req.admin.username) || 'admin', Math.floor(Date.now() / 1000));
  }
  res.redirect('/admin/updates');
});

// POST /admin/updates/delete — remove an entry
router.post('/updates/delete', (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  if (id) db.prepare('DELETE FROM update_logs WHERE id=?').run(id);
  res.redirect('/admin/updates');
});

// POST /admin/updates/git/fetch — trigger git fetch (oneshot unit)
router.post('/updates/git/fetch', (req, res) => {
  try {
    execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-git-status.service'], { timeout: 30000 });
    audit(req.admin && req.admin.id, 'update_check', '', req.clientIp);
    req.session.updateFlash = { kind: 'ok', message: 'Checked for updates.' };
  } catch (e) {
    req.session.updateFlash = { kind: 'err', message: 'Failed to start git fetch: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/updates');
});

// POST /admin/updates/git/deploy — trigger paywifi-update (oneshot unit)
router.post('/updates/git/deploy', (req, res) => {
  try {
    execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-update.service'], { timeout: 120000 });
    audit(req.admin && req.admin.id, 'update_deploy', '', req.clientIp);
    // After deploy, refresh the git status file so the page shows the new HEAD
    try {
      execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-git-status.service'], { timeout: 15000 });
    } catch (e) {}
    req.session.updateFlash = { kind: 'ok', message: 'Update applied. Scroll to "Deploy log" for the result.' };
  } catch (e) {
    req.session.updateFlash = { kind: 'err', message: 'Deploy failed: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/updates');
});

module.exports = router;
