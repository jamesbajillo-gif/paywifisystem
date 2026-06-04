'use strict';
// STREAM-PROXY-2026-06-04 — HMAC-gated HLS proxy.
//
// Flow:
//   1. Portal calls POST /api/portal/stream/start { source_key }
//      → server returns { playlist_url: "/api/portal/stream/playlist/<key>?t=<token>&e=<expire>" }
//   2. Browser HLS player loads that playlist URL
//      → server fetches the actual googlevideo manifest, REWRITES every URI
//        (variant playlists + segments + EXT-X-MAP) to point at /chunk endpoints
//      → all rewritten URIs carry their own HMAC tokens scoped to the client IP
//   3. hls.js requests segments; each chunk URL is validated by HMAC + IP match
//      before bytes are proxied through the gateway.
//
// Result: client only ever sees relative PAYWIFI URLs. View-source / devtools
// reveal no googlevideo.com endpoints. Token leak window is ≤ TTL_SEC.
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');

const TTL_SEC = 5 * 60;          // chunk token lifetime
const PROXY_TIMEOUT_MS = 30000;

function hmacSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key='live_news_hmac_secret'").get();
  return (row && row.value) || 'paywifi-default-insecure';
}
function sign(payload) {
  return crypto.createHmac('sha256', hmacSecret()).update(payload).digest('base64url');
}
function verify(payload, sig) {
  try {
    const want = Buffer.from(sign(payload), 'base64url');
    const got  = Buffer.from(String(sig || ''), 'base64url');
    if (want.length !== got.length) return false;
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
function clientIp(req) {
  return (req.clientIp || req.headers['x-real-ip'] || req.ip || '').replace(/^::ffff:/, '') || '0.0.0.0';
}
function makeChunkProxyUrl(req, originalUrl) {
  const ip = clientIp(req);
  const expire = Math.floor(Date.now() / 1000) + TTL_SEC;
  const u = Buffer.from(originalUrl, 'utf8').toString('base64url');
  const token = sign(ip + ':' + originalUrl + ':' + expire);
  return '/api/portal/stream/chunk?u=' + u + '&e=' + expire + '&t=' + token;
}
function auth(req, res, next) {
  // LS-02 — host gate. Strict LAN serving; paywifi.net never sees stream URLs.
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (/^paywifi\.net$|^www\.paywifi\.net$/.test(host)) {
    return res.status(403).json({ ok: false, code: 'PUBLIC_HOST', error: 'Streaming not available on this host.' });
  }
  if (!req.clientIp) return res.status(403).json({ ok: false, error: 'no_client_ip' });
  // Only LAN clients (LAN bootstrap on 10.10.0.0/24 OR mgmt 192.168.89.0/24) allowed.
  const ip = clientIp(req);
  if (!/^10\.10\.0\.|^192\.168\.89\./.test(ip)) {
    return res.status(403).json({ ok: false, code: 'NON_LAN', error: 'Streaming is LAN-only.' });
  }
  next();
}

// ─── /stream/start ─── issues a playlist token for the configured channel
router.post('/start', express.json({ limit: '1kb' }), auth, (req, res) => {
  const sk = String((req.body || {}).source_key || '').slice(0, 60);
  if (!sk) return res.status(400).json({ ok: false, error: 'source_key required' });

  // Only return streams for channels that are enabled + live.
  const row = db.prepare(
    "SELECT c.hls_url, c.live_status, c.channel_name FROM live_stream_cache c " +
    "JOIN live_stream_sources s ON s.source_key=c.source_key " +
    "WHERE c.source_key=? AND s.enabled=1"
  ).get(sk);
  if (!row || !row.hls_url) return res.status(404).json({ ok: false, error: 'stream_unavailable' });

  // LS-03 voucher gate
  try {
    const gate = (db.prepare("SELECT value FROM settings WHERE key='live_news_require_auth'").get() || {}).value === '1';
    if (gate) {
      const sess = db.prepare("SELECT id FROM sessions WHERE ip_address=? AND ended_at IS NULL LIMIT 1").get(req.clientIp);
      if (!sess) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'voucher required' });
    }
  } catch (e) {}

  // LS-04 audit
  try {
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL, 'stream_played', ?, ?, ?)"
    ).run('source=' + sk + ' mac=' + (req.clientMac || '?').slice(0,8) + '???', req.clientIp, Math.floor(Date.now() / 1000));
  } catch (e) {}

  const ip = clientIp(req);
  const expire = Math.floor(Date.now() / 1000) + TTL_SEC;
  const token = sign(ip + ':playlist:' + sk + ':' + expire);
  res.json({
    ok: true,
    playlist_url: '/api/portal/stream/playlist/' + encodeURIComponent(sk) + '?t=' + token + '&e=' + expire,
    channel_name: row.channel_name,
    live_status:  row.live_status
  });
});

// ─── /stream/playlist/:src ─── fetch + rewrite manifest
router.get('/playlist/:src', auth, async (req, res) => {
  const sk = String(req.params.src).slice(0, 60);
  const expire = parseInt(req.query.e, 10);
  const token  = String(req.query.t || '');
  const ip = clientIp(req);
  if (!expire || expire < Math.floor(Date.now()/1000)) return res.status(401).json({ ok: false, error: 'expired' });
  if (!verify(ip + ':playlist:' + sk + ':' + expire, token)) return res.status(403).json({ ok: false, error: 'bad_token' });

  const row = db.prepare(
    "SELECT c.hls_url FROM live_stream_cache c JOIN live_stream_sources s ON s.source_key=c.source_key " +
    "WHERE c.source_key=? AND s.enabled=1"
  ).get(sk);
  if (!row || !row.hls_url) return res.status(404).type('text/plain').send('# Stream unavailable');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    const r = await fetch(row.hls_url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).type('text/plain').send('# Upstream ' + r.status);
    const finalUrl = r.url || row.hls_url;
    const body = await r.text();

    // Rewrite every URI in the manifest. The "base" for relative resolution is
    // the URL we actually got (after any redirects).
    const out = rewriteManifest(body, finalUrl, (abs) => makeChunkProxyUrl(req, abs));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(out);
  } catch (e) {
    res.status(502).type('text/plain').send('# Proxy error');
  }
});

// ─── /stream/chunk ─── proxy a single chunk / sub-playlist
router.get('/chunk', auth, async (req, res) => {
  const expire = parseInt(req.query.e, 10);
  const token  = String(req.query.t || '');
  const uEnc   = String(req.query.u || '');
  const ip = clientIp(req);
  if (!expire || expire < Math.floor(Date.now()/1000)) return res.status(401).type('text/plain').send('expired');
  let originalUrl;
  try { originalUrl = Buffer.from(uEnc, 'base64url').toString('utf8'); }
  catch (e) { return res.status(400).type('text/plain').send('bad_u'); }
  if (!/^https?:\/\//.test(originalUrl)) return res.status(400).type('text/plain').send('bad_url');
  if (!verify(ip + ':' + originalUrl + ':' + expire, token)) return res.status(403).type('text/plain').send('bad_token');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    const upstream = await fetch(originalUrl, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', ct);
    // If the response is itself an m3u8 (variant playlist), rewrite recursively
    if (/mpegurl|vnd\.apple\.mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(originalUrl)) {
      const body = await upstream.text();
      const out = rewriteManifest(body, upstream.url || originalUrl, (abs) => makeChunkProxyUrl(req, abs));
      res.send(out);
    } else {
      // Stream bytes
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.status(502).end();
    else res.end();
  }
});

// HLS rewriter — handles bare URIs and URI="..." attribute lines.
function rewriteManifest(text, baseUrl, makeProxyUrl) {
  const lines = String(text).split(/\r?\n/);
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) { out[i] = raw; continue; }
    if (trimmed.startsWith('#')) {
      // Rewrite all URI="..." attributes
      out[i] = raw.replace(/URI="([^"]+)"/g, (_, uri) => {
        try {
          const abs = new URL(uri, baseUrl).toString();
          return 'URI="' + makeProxyUrl(abs) + '"';
        } catch (e) { return 'URI="' + uri + '"'; }
      });
    } else {
      // bare URL line
      try {
        const abs = new URL(trimmed, baseUrl).toString();
        out[i] = makeProxyUrl(abs);
      } catch (e) {
        out[i] = raw;
      }
    }
  }
  return out.join('\n');
}

module.exports = router;
