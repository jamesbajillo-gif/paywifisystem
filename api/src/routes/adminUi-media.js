'use strict';
// PAYWIFI-MEDIA-2026-06-03 — admin CRUD for media_assets.
const router      = require('express').Router();
const db          = require('../db');
const { spawn, execFileSync } = require('child_process');
const multer      = require('multer');
const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');

const MEDIA_VIDEO_DIR = '/opt/paywifi/portal/media/videos';
const MEDIA_THUMB_DIR = '/opt/paywifi/portal/media/thumbs';
try { fs.mkdirSync(MEDIA_VIDEO_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(MEDIA_THUMB_DIR, { recursive: true }); } catch (e) {}

// Multer config — temp staging, then move into place after ffprobe.
const uploadStaging = '/tmp/paywifi-upload';
try { fs.mkdirSync(uploadStaging, { recursive: true }); } catch (e) {}
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadStaging,
    filename: function (_req, file, cb) {
      const ext = (file.originalname || '').toLowerCase().match(/\.(mp4|webm|m4v|mov)$/) || ['.mp4'];
      cb(null, 'pw-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext[0]);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB cap
  fileFilter: function (_req, file, cb) {
    const okMime = /^(video\/(mp4|webm|x-m4v|quicktime))$/.test(file.mimetype || '');
    const okExt  = /\.(mp4|webm|m4v|mov)$/i.test(file.originalname || '');
    if (okMime || okExt) cb(null, true);
    else cb(new Error('Unsupported video format. Use mp4, webm, m4v, or mov.'));
  }
});


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

// ── POST /admin/media/upload ─ direct file upload ──────────────────────────
router.post('/media/upload', requireAdmin, upload.single('file'), (req, res) => {
  // multer landed the file in /tmp; now probe with ffprobe, move into place,
  // generate a thumbnail, write the row.
  const f = req.file;
  if (!f) {
    req.session.mediaFlash = { kind: 'err', message: 'No file uploaded.' };
    return res.redirect('/admin/widgets');
  }
  try {
    // ffprobe for metadata
    const ffp = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', f.path
    ], { timeout: 60000 }).toString());
    const vstream = (ffp.streams || []).find(x => x.codec_type === 'video');
    if (!vstream) throw new Error('No video stream found in file.');
    const dur = Math.round(parseFloat(ffp.format && ffp.format.duration || 0)) || 0;
    const maxDur = parseInt((db.prepare("SELECT value FROM settings WHERE key='media_max_duration_sec'").get() || {}).value || '1800', 10);
    if (dur > maxDur) {
      try { fs.unlinkSync(f.path); } catch (e) {}
      req.session.mediaFlash = { kind: 'err', message: 'Video is ' + dur + 's; max ' + maxDur + 's.' };
      return res.redirect('/admin/widgets');
    }
    const width  = vstream.width  || 0;
    const height = vstream.height || 0;
    const resolution = (width && height) ? (width + 'x' + height) : null;
    // Build a stable id (sha256 prefix) — used as the on-disk filename so
    // duplicates collide on the UNIQUE(video_id) constraint.
    const buf = fs.readFileSync(f.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const vid = 'up_' + sha.slice(0, 16);
    const dup = db.prepare('SELECT id, status FROM media_assets WHERE video_id=?').get(vid);
    if (dup) {
      try { fs.unlinkSync(f.path); } catch (e) {}
      req.session.mediaFlash = { kind: 'err', message: 'Already uploaded (id=' + dup.id + ').' };
      return res.redirect('/admin/widgets');
    }
    // Move into place. If it's already mp4, just rename; otherwise remux.
    const targetMp4 = path.join(MEDIA_VIDEO_DIR, vid + '.mp4');
    if (/\.mp4$/i.test(f.path)) {
      try { fs.renameSync(f.path, targetMp4); }
      catch (renameErr) {
        // Cross-device link (EXDEV) — fallback to copy+unlink.
        fs.copyFileSync(f.path, targetMp4);
        try { fs.unlinkSync(f.path); } catch (e) {}
      }
    } else {
      try {
        execFileSync('ffmpeg', ['-y', '-i', f.path, '-c', 'copy', '-movflags', '+faststart', targetMp4], { timeout: 120000 });
        try { fs.unlinkSync(f.path); } catch (e) {}
      } catch (e) {
        // Couldn't remux — re-encode minimally
        execFileSync('ffmpeg', ['-y', '-i', f.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', targetMp4], { timeout: 600000 });
        try { fs.unlinkSync(f.path); } catch (e) {}
      }
    }
    // Generate thumbnail at 1s
    const targetThumb = path.join(MEDIA_THUMB_DIR, vid + '.jpg');
    try {
      execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', targetMp4, '-vframes', '1', '-vf', 'scale=320:-1', targetThumb], { timeout: 30000 });
    } catch (e) {}
    // Stats
    const stat = fs.statSync(targetMp4);
    const fileSha = crypto.createHash('sha256').update(fs.readFileSync(targetMp4)).digest('hex');
    try { fs.chownSync(targetMp4, 998, 998); } catch (e) {} // paywifi user — best-effort
    try { fs.chmodSync(targetMp4, 0o644); } catch (e) {}
    try { fs.chmodSync(targetThumb, 0o644); } catch (e) {}
    const now = Math.floor(Date.now() / 1000);
    const title = (req.body.title || f.originalname || 'Uploaded video').slice(0, 200);
    const ins = db.prepare(
      "INSERT INTO media_assets " +
      "(source_url, source_type, video_id, title, duration_sec, file_path, thumbnail_path, file_size, checksum, resolution, status, visibility, created_by, created_at, updated_at, processed_at) " +
      "VALUES (?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, 'processed', 1, ?, ?, ?, ?)"
    ).run(
      'upload://' + f.originalname,
      vid, title, dur,
      '/media/videos/' + vid + '.mp4',
      fs.existsSync(targetThumb) ? '/media/thumbs/' + vid + '.jpg' : null,
      stat.size, fileSha, resolution,
      req.admin.id, now, now, now
    );
    audit(req.admin.id, 'media_upload', 'id=' + ins.lastInsertRowid + ' size=' + stat.size + ' dur=' + dur, req.clientIp);
    req.session.mediaFlash = { kind: 'ok', message: 'Uploaded — ready to feature.' };
    res.redirect('/admin/widgets');
  } catch (e) {
    try { fs.unlinkSync(f.path); } catch (er) {}
    req.session.mediaFlash = { kind: 'err', message: 'Upload failed: ' + e.message.slice(0, 200) };
    res.redirect('/admin/widgets');
  }
});

// ── POST /admin/media/url-add ─ external MP4 URL ingest ────────────────────
router.post('/media/url-add', requireAdmin, (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//.test(url) || !/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url)) {
    req.session.mediaFlash = { kind: 'err', message: 'URL must be http(s) and end with .mp4/.webm/.m4v/.mov' };
    return res.redirect('/admin/widgets');
  }
  const vid = 'ext_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const dup = db.prepare('SELECT id, status FROM media_assets WHERE video_id=?').get(vid);
  if (dup) {
    req.session.mediaFlash = { kind: 'err', message: 'That URL is already in the library (id=' + dup.id + ').' };
    return res.redirect('/admin/widgets');
  }
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    "INSERT INTO media_assets (source_url, source_type, video_id, title, status, created_by, created_at, updated_at) " +
    "VALUES (?, 'url', ?, ?, 'pending', ?, ?, ?)"
  ).run(url, vid, url.split('/').pop().slice(0, 200), req.admin.id, now, now);
  const id = ins.lastInsertRowid;
  audit(req.admin.id, 'media_url_add', 'id=' + id + ' url=' + url.slice(0, 150), req.clientIp);
  // Fire-and-forget the ingestor
  try {
    const child = spawn('sudo', ['-n', '/usr/local/sbin/paywifi-media-ingest', String(id)], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {}
  req.session.mediaFlash = { kind: 'ok', message: 'Queued from URL — refresh in 30–60 seconds.' };
  res.redirect('/admin/widgets');
});

module.exports = router;
