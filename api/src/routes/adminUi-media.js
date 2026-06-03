'use strict';
// PAYWIFI-MEDIA-2026-06-03 — admin CRUD for media_assets (YouTube ingestion).
const router    = require('express').Router();
const db        = require('../db');
const { spawn } = require('child_process');

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}
function audit(adminId, action, details, ip) {
  try {
    db.prepare('INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(adminId || null, action, (details || '').slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}

// Extract YouTube video id from a URL
function extractYouTubeId(input) {
  const u = String(input || '').trim();
  if (!u) return null;
  let m;
  m = u.match(/[?&]v=([A-Za-z0-9_-]{6,15})/);          if (m) return m[1];
  m = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,15})/);     if (m) return m[1];
  m = u.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,15})/); if (m) return m[1];
  m = u.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,15})/); if (m) return m[1];
  if (/^[A-Za-z0-9_-]{6,15}$/.test(u)) return u;
  return null;
}

// ── GET /admin/media ────────────────────────────────────────────────────────
// MEDIA-MERGED-2026-06-03 — standalone page deprecated; library lives inside
// the YouTube widget edit panel in /admin/widgets. POST endpoints below stay
// (the widget edit panel calls them via fetch).
router.get('/media', requireAdmin, (req, res) => {
  return res.redirect('/admin/widgets');
});

// ── POST /admin/media/add ───────────────────────────────────────────────────
router.post('/media/add', requireAdmin, (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  const tags = String((req.body || {}).tags || '').trim().slice(0, 200) || null;
  if (!url) {
    req.session.mediaFlash = { kind: 'err', message: 'Paste a YouTube URL.' };
    return res.redirect('/admin/media');
  }
  if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/i.test(url)) {
    req.session.mediaFlash = { kind: 'err', message: 'Only YouTube URLs are accepted.' };
    return res.redirect('/admin/media');
  }
  const vid = extractYouTubeId(url);
  if (!vid) {
    req.session.mediaFlash = { kind: 'err', message: 'Could not parse a video id from that URL.' };
    return res.redirect('/admin/media');
  }

  // Dedup
  const dup = db.prepare("SELECT id, status FROM media_assets WHERE video_id=?").get(vid);
  if (dup) {
    req.session.mediaFlash = { kind: 'err', message: 'That video is already in the library (id=' + dup.id + ', status=' + dup.status + ').' };
    return res.redirect('/admin/media');
  }

  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    "INSERT INTO media_assets (source_url, source_type, video_id, tags, status, created_by, created_at, updated_at) " +
    "VALUES (?, 'youtube', ?, ?, 'pending', ?, ?, ?)"
  ).run(url, vid, tags, req.admin.id, now, now);
  const id = ins.lastInsertRowid;
  audit(req.admin.id, 'media_add', 'id=' + id + ' video_id=' + vid, req.clientIp);

  // Fire-and-forget the worker
  try {
    const child = spawn('sudo', ['-n', '/usr/local/sbin/paywifi-media-ingest', String(id)], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {}

  req.session.mediaFlash = { kind: 'ok', message: 'Queued — refresh in 30–60 seconds.' };
  res.redirect('/admin/media');
});

// ── POST /admin/media/:id/visibility ────────────────────────────────────────
router.post('/media/:id/visibility', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const want = req.body.value === '1' ? 1 : 0;
  db.prepare("UPDATE media_assets SET visibility=?, updated_at=? WHERE id=?")
    .run(want, Math.floor(Date.now() / 1000), id);
  audit(req.admin.id, 'media_visibility', 'id=' + id + ' visible=' + want, req.clientIp);
  res.redirect('/admin/media');
});

// ── POST /admin/media/:id/retry ─────────────────────────────────────────────
router.post('/media/:id/retry', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE media_assets SET status='pending', error=NULL, updated_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), id);
  try {
    const child = spawn('sudo', ['-n', '/usr/local/sbin/paywifi-media-ingest', String(id)], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {}
  audit(req.admin.id, 'media_retry', 'id=' + id, req.clientIp);
  req.session.mediaFlash = { kind: 'ok', message: 'Re-queued.' };
  res.redirect('/admin/media');
});

// ── POST /admin/media/:id/delete ────────────────────────────────────────────
router.post('/media/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT video_id FROM media_assets WHERE id=?').get(id);
  if (row && row.video_id) {
    try { require('fs').unlinkSync('/opt/paywifi/portal/media/videos/' + row.video_id + '.mp4'); } catch (e) {}
    try { require('fs').unlinkSync('/opt/paywifi/portal/media/thumbs/' + row.video_id + '.jpg'); } catch (e) {}
  }
  db.prepare('DELETE FROM media_assets WHERE id=?').run(id);
  audit(req.admin.id, 'media_delete', 'id=' + id + ' video_id=' + (row && row.video_id), req.clientIp);
  req.session.mediaFlash = { kind: 'ok', message: 'Deleted.' };
  res.redirect('/admin/media');
});

module.exports = router;
