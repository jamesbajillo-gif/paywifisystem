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
// PUSH-FLOW-2026-06-02 — compare a couple of representative live files
// against the repo so the UI can show a 'live state differs from repo' hint.
const path = require('path');
function liveIsDirty() {
  const pairs = [
    ['/opt/paywifi/api/src/server.js',                 '/opt/paywifi-repo/api/src/server.js'],
    ['/opt/paywifi/api/src/routes/portal.js',          '/opt/paywifi-repo/api/src/routes/portal.js'],
    ['/opt/paywifi/api/src/routes/adminUi-updates.js', '/opt/paywifi-repo/api/src/routes/adminUi-updates.js'],
    ['/opt/paywifi/api/views/admin/updates.ejs',       '/opt/paywifi-repo/api/views/admin/updates.ejs'],
    ['/etc/nginx/sites-available/paywifi',             '/opt/paywifi-repo/ops/nginx/paywifi'],
  ];
  for (const [live, repo] of pairs) {
    try {
      const a = fs.readFileSync(live);
      const b = fs.readFileSync(repo);
      if (a.length !== b.length || !a.equals(b)) return true;
    } catch (e) { /* missing file on either side counts as 'unknown', not dirty */ }
  }
  return false;
}

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
  const pushState   = unitIsActive('paywifi-push.service');
  const deployLog   = readUnitLog('paywifi-update.service');
  const pushLog     = readUnitLog('paywifi-push.service');

  // PUSH-FLOW-2026-06-02 — quick "dirty" detector. mtimes only; cheap enough.
  const dirty = liveIsDirty();

  res.render('admin/updates', {
    title:  'Update Logs · PAYWIFI',
    active: 'updates',
    rows, cats, filter: cat,
    git, updateState, fetchState, pushState, deployLog, pushLog, dirty,
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

// POST /admin/updates/git/deploy — trigger paywifi-update (oneshot unit).
// AUTO-CHANGELOG-2026-06-02 — snapshot the git status before + after, and if
// the local HEAD actually changed (i.e. real new commits were pulled), append
// a row to update_logs summarizing what shipped. Manual changelog entries
// remain user-driven; this only fires on actual deploys.
router.post('/updates/git/deploy', (req, res) => {
  const pre = readGitStatus();
  try {
    execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-update.service'], { timeout: 120000 });
    audit(req.admin && req.admin.id, 'update_deploy', '', req.clientIp);
    // Refresh status so the page shows the new HEAD
    try {
      execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-git-status.service'], { timeout: 15000 });
    } catch (e) {}

    // AUTO-CHANGELOG-2026-06-02 — write a changelog entry if the SHA changed
    try {
      const post = readGitStatus();
      const preSha  = pre  && pre.local  && pre.local.sha;
      const postSha = post && post.local && post.local.sha;
      if (preSha && postSha && preSha !== postSha) {
        const commits = (pre && pre.commits) || [];
        // pre.commits is HEAD..origin BEFORE pull — these are exactly what got applied
        const applied = commits.filter(c => c && c.sha);
        const newest  = applied[applied.length - 1] || (post.local || {});
        const oldestShort = (applied[0] && applied[0].short) || preSha.slice(0, 7);
        const newestShort = (post.local && post.local.short) || postSha.slice(0, 7);
        const title = `Deployed ${applied.length || 1} commit${applied.length === 1 ? '' : 's'}: ${oldestShort} → ${newestShort}`;
        const lines = [];
        lines.push(`Pulled from origin/${(post && post.branch) || 'main'} via /admin/updates.`);
        lines.push('');
        if (applied.length) {
          lines.push('Commits applied (oldest → newest):');
          applied.forEach(c => lines.push(`• ${c.short}  ${c.msg}`));
        } else {
          // Shouldn't happen if SHA changed, but defensive fallback.
          lines.push(`Local HEAD moved ${preSha.slice(0,7)} → ${postSha.slice(0,7)}.`);
        }
        lines.push('');
        lines.push(`Triggered by ${(req.admin && req.admin.username) || 'admin'} at ${new Date().toISOString()}`);
        db.prepare(
          'INSERT INTO update_logs (title, body, category, author, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(title.slice(0, 200), lines.join('\n').slice(0, 20000),
              'deploy', (req.admin && req.admin.username) || 'admin', Math.floor(Date.now() / 1000));
        req.session.updateFlash = { kind: 'ok', message: `Deployed ${applied.length || 1} commits. Changelog entry added below.` };
      } else {
        req.session.updateFlash = { kind: 'ok', message: 'Re-synced — no new commits, no changelog entry written.' };
      }
    } catch (e) {
      req.session.updateFlash = { kind: 'ok', message: 'Update applied. (Changelog auto-write skipped: ' + String(e.message || e).slice(0, 100) + ')' };
    }
  } catch (e) {
    req.session.updateFlash = { kind: 'err', message: 'Deploy failed: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/updates');
});

// POST /admin/updates/git/push — mirror live gateway state into the repo,
// commit, and push to origin/main. The commit message comes from the form.
// PUSH-FLOW-2026-06-02
router.post('/updates/git/push', (req, res) => {
  const raw = (req.body && req.body.message || '').trim();
  const message = raw || ('Gateway snapshot — ' + new Date().toISOString());
  try {
    fs.writeFileSync('/var/lib/paywifi/push-message.txt', message.slice(0, 2000), { mode: 0o640 });
    try { fs.chmodSync('/var/lib/paywifi/push-message.txt', 0o640); } catch (e) {}
    execFileSync('sudo', ['-n', '/bin/systemctl', 'start', 'paywifi-push.service'], { timeout: 120000 });
    audit(req.admin && req.admin.id, 'update_push', message.slice(0, 200), req.clientIp);
    req.session.updateFlash = { kind: 'ok', message: 'Pushed to GitHub. See "Push log" for the result.' };
  } catch (e) {
    req.session.updateFlash = { kind: 'err', message: 'Push failed: ' + String(e.message || e).slice(0, 200) };
  }
  res.redirect('/admin/updates');
});

module.exports = router;
