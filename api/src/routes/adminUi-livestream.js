'use strict';
// LIVE-STREAM-ADMIN-2026-06-04 — CRUD for live_stream_sources channel registry.
// All routes assume the admin session cookie + csrf middleware (mounted in
// server.js alongside the other admin routes).
const router = require('express').Router();
const db     = require('../db');

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ ok: false, error: 'admin auth required' });
  next();
}
function audit(adminId, action, details, ip) {
  try {
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (?,?,?,?,?)"
    ).run(adminId || null, action, (details || '').slice(0, 500), ip || null, Math.floor(Date.now() / 1000));
  } catch (e) {}
}
function safeKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 40);
}

// GET /admin/livestream/sources → JSON list (also surfaces cache state)
router.get('/livestream/sources', requireAdmin, (_req, res) => {
  const rows = db.prepare(
    "SELECT id, source_key, channel_url, title_pattern, channel_label, enabled, fetch_priority, created_at, updated_at " +
    "FROM live_stream_sources ORDER BY enabled DESC, fetch_priority DESC, id ASC"
  ).all();
  const cache = Object.fromEntries(
    db.prepare("SELECT source_key, live_status, video_id, display_title, fetched_at FROM live_stream_cache").all()
      .map(c => [c.source_key, c])
  );
  rows.forEach(r => { r.cache = cache[r.source_key] || null; });
  res.json({ ok: true, sources: rows });
});

// POST /admin/livestream/sources — add new channel
router.post('/livestream/sources', requireAdmin, (req, res) => {
  const b = req.body || {};
  const source_key   = safeKey(b.source_key);
  const channel_url  = String(b.channel_url || '').slice(0, 500);
  const title_pattern = String(b.title_pattern || '').slice(0, 500);
  const channel_label = String(b.channel_label || '').slice(0, 200);
  const enabled       = b.enabled === false ? 0 : 1;
  if (!source_key)   return res.status(400).json({ ok: false, error: 'source_key required (a-z, 0-9, _ only)' });
  if (!/^https?:\/\//i.test(channel_url)) return res.status(400).json({ ok: false, error: 'channel_url must be http(s)://' });
  if (!title_pattern) return res.status(400).json({ ok: false, error: 'title_pattern required' });
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO live_stream_sources (source_key, channel_url, title_pattern, channel_label, enabled, fetch_priority, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?)"
    ).run(source_key, channel_url, title_pattern, channel_label || null, enabled, 5, now, now);
    audit(req.admin.id, 'livestream_source_add', 'key=' + source_key + ' url=' + channel_url, req.clientIp);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// PATCH /admin/livestream/sources/:id — edit existing
router.post('/livestream/sources/:id/update', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
  const b = req.body || {};
  const fields = [];
  const args = [];
  if (typeof b.channel_url === 'string')   { fields.push('channel_url=?');   args.push(b.channel_url.slice(0, 500)); }
  if (typeof b.title_pattern === 'string') { fields.push('title_pattern=?'); args.push(b.title_pattern.slice(0, 500)); }
  if (typeof b.channel_label === 'string') { fields.push('channel_label=?'); args.push(b.channel_label.slice(0, 200)); }
  if (b.enabled !== undefined)             { fields.push('enabled=?');       args.push(b.enabled ? 1 : 0); }
  if (b.fetch_priority !== undefined)      { fields.push('fetch_priority=?');args.push(parseInt(b.fetch_priority, 10) || 0); }
  if (!fields.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
  fields.push("updated_at=strftime('%s','now')");
  args.push(id);
  db.prepare("UPDATE live_stream_sources SET " + fields.join(', ') + " WHERE id=?").run(...args);
  audit(req.admin.id, 'livestream_source_update', 'id=' + id + ' fields=' + Object.keys(b).join(','), req.clientIp);
  res.json({ ok: true });
});

// POST /admin/livestream/sources/:id/toggle — quick enable/disable
router.post('/livestream/sources/:id/toggle', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
  const cur = db.prepare("SELECT enabled FROM live_stream_sources WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
  const next = cur.enabled ? 0 : 1;
  db.prepare("UPDATE live_stream_sources SET enabled=?, updated_at=strftime('%s','now') WHERE id=?").run(next, id);
  audit(req.admin.id, 'livestream_source_toggle', 'id=' + id + ' -> enabled=' + next, req.clientIp);
  res.json({ ok: true, enabled: next });
});

// POST /admin/livestream/sources/:id/delete
router.post('/livestream/sources/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
  const cur = db.prepare("SELECT source_key FROM live_stream_sources WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
  db.prepare("DELETE FROM live_stream_sources WHERE id=?").run(id);
  db.prepare("DELETE FROM live_stream_cache   WHERE source_key=?").run(cur.source_key);
  audit(req.admin.id, 'livestream_source_delete', 'id=' + id + ' key=' + cur.source_key, req.clientIp);
  res.json({ ok: true });
});

module.exports = router;
