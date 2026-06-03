/**
 * paywifi-sessiond — background worker
 *
 * Responsibilities (runs every POLL_MS):
 *   1. Expire sessions past expires_at (end + revoke + unshape)
 *   2. Idle-detect sessions (no last_seen_at update in N minutes)
 *   3. Read tc stats and update bytes_in/bytes_out per active session
 *   4. Watch dnsmasq leases for new clients with a remembered MAC -> auto-auth
 *   5. Update voucher.status when no devices remain
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const nurturing = require('./services/nurturing');
const db = require('./db');
const sessionSvc = require('./services/session');
const fw = require('./services/firewall');
const shape = require('./services/shaping');
const semaphore = require('./services/semaphore');

const POLL_MS = 10000;                                  // 10s loop
// SYNC-05: IDLE_MIN is read dynamically inside idleSweep() — no restart needed after setting change
const LEASE_FILE = '/var/lib/misc/paywifi-dnsmasq.leases';

function getSetting(key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}

function now() { return Math.floor(Date.now() / 1000); }

// --- 1. Expiry sweep --------------------------------------------------------
function expireOverdue() {
  const t = now();
  const rows = db.prepare(`
    SELECT s.id, s.ip_address, s.mac_address, s.voucher_id, v.expires_at
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ended_at IS NULL
       AND v.expires_at IS NOT NULL
       AND v.expires_at <= ?
  `).all(t);
  for (const r of rows) {
    console.log(`[sessiond] expire session ${r.id} ip=${r.ip_address}`);
    // STACK-03/12: pre-authorize next queued voucher BEFORE revoking current firewall entry
    const hasQueue = sessionSvc.getNextQueueEntry(r.mac_address);
    if (hasQueue) {
      // keepFirewall=true: activateNextInQueue already called fw.authorize; endSession skips fw.revoke
      sessionSvc.endSession(r.id, 'expired', t, { keepFirewall: true, keepShape: true });
      activateNextInQueue(r.mac_address, r.ip_address, t);
    } else {
      sessionSvc.endSession(r.id, 'expired', t);
    }
  }

  // Mark vouchers whose every active session is gone
  db.prepare(`
    UPDATE vouchers SET status='expired'
     WHERE status='active'
       AND expires_at IS NOT NULL
       AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM sessions WHERE voucher_id=vouchers.id AND ended_at IS NULL)
  `).run(t);
}

// --- 2. Idle detection ------------------------------------------------------
function idleSweep() {
  const t = now();
  const idleMin = parseInt(getSetting('idle_timeout_min', '10'), 10);  // SYNC-05: dynamic read
  const idleCutoff = t - idleMin * 60;
  const rows = db.prepare(`
    SELECT id, ip_address, mac_address FROM sessions
     WHERE ended_at IS NULL AND last_seen_at < ?
  `).all(idleCutoff);
  for (const r of rows) {
    console.log(`[sessiond] idle session ${r.id} ip=${r.ip_address} (>${idleMin}min)`);
    // QS-01: honour any queued voucher for this device when an idle session ends
    const hasQueue = sessionSvc.getNextQueueEntry(r.mac_address);
    if (hasQueue) {
      sessionSvc.endSession(r.id, 'idle', t, { keepFirewall: true, keepShape: true });
      activateNextInQueue(r.mac_address, r.ip_address, t);
    } else {
      sessionSvc.endSession(r.id, 'idle', t);
    }
  }
}

// --- 3. Byte counter sweep --------------------------------------------------
// Parse `tc -s class show dev <iface>` and pull (Sent X bytes) per classid.
function parseTcStats(iface) {
  let out = '';
  try {
    out = execFileSync('/usr/sbin/tc', ['-s', 'class', 'show', 'dev', iface], { encoding: 'utf8' });
  } catch (e) { return new Map(); }
  const stats = new Map();   // classid -> bytes
  const blocks = out.split(/\nclass /).map(b => 'class ' + b);
  for (const b of blocks) {
    const idMatch = b.match(/class htb (1:[0-9a-f]+)/);
    const byMatch = b.match(/Sent (\d+) bytes/);
    if (idMatch && byMatch) {
      stats.set(idMatch[1], parseInt(byMatch[1], 10));
    }
  }
  return stats;
}

function ipToClassid(ip) {
  const parts = ip.split('.');
  const minor = (parseInt(parts[2], 10) * 256 + parseInt(parts[3], 10)).toString(16);
  return `1:${minor}`;
}

let lastBytes = new Map();  // sessionId -> {up, down}

function byteSweep() {
  const cfg = db.cfg;
  const LAN = cfg.network.lan_iface;
  const IFB = 'ifb-paywifi';

  const upStats   = parseTcStats(LAN);   // egress from LAN = client uploads
  const downStats = parseTcStats(IFB);   // egress from IFB = client downloads

  const active = db.prepare(`
    SELECT id, ip_address, bytes_in, bytes_out FROM sessions WHERE ended_at IS NULL
  `).all();

  const upd = db.prepare(`UPDATE sessions SET bytes_in=?, bytes_out=?, last_seen_at=? WHERE id=?`);
  const t = now();

  for (const s of active) {
    const cid = ipToClassid(s.ip_address);
    const up   = upStats.get(cid)   || 0;   // bytes uploaded by client (in to us)
    const down = downStats.get(cid) || 0;   // bytes downloaded by client (out to client)

    if (up || down) {
      const prev = lastBytes.get(s.id) || { up: 0, down: 0 };
      // tc counters reset to 0 when class is removed — handle wrap
      const upDelta   = up   >= prev.up   ? up   - prev.up   : up;
      const downDelta = down >= prev.down ? down - prev.down : down;

      // bytes_in = client uploads received by gateway
      // bytes_out = client downloads sent by gateway
      const newIn  = (s.bytes_in  || 0) + upDelta;
      const newOut = (s.bytes_out || 0) + downDelta;

      if (upDelta || downDelta) {
        upd.run(newIn, newOut, t, s.id);
      }
      lastBytes.set(s.id, { up, down });
    }
  }
}

// --- 4. Dnsmasq lease watcher (MAC remembering auto-auth) -------------------
function readLeases() {
  // dnsmasq lease format: <expiry-epoch> <mac> <ip> <hostname> <client-id>
  try {
    return fs.readFileSync(LEASE_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(line => {
        const [exp, mac, ip, host] = line.split(' ');
        return { exp: parseInt(exp, 10), mac: mac.toLowerCase(), ip, host };
      });
  } catch (e) { return []; }
}

const seenLeases = new Set();  // "mac@ip" we've already evaluated
const parked = new Map();     // portal-first grace: "mac@ip" -> parkedSince (awaiting portal restore)

// Portal-first session resume (admin kill-switch). When ON, sessiond stops silently
// re-authorizing reconnecting devices; the captive portal restores them via
// POST /api/portal/session/restore, and a vanished lease revokes firewall access.
function resumeEnabled() {
  try { return (db.prepare("SELECT value FROM settings WHERE key='session_resume_enabled'").get() || {}).value !== '0'; }
  catch (e) { return false; }
}
function leaseSweep() {
  const t = now();
  const leases = readLeases();
  if (seenLeases.size > 2000) { seenLeases.clear(); parked.clear(); }   // SE-01: hard-cap safety
  for (const l of leases) {
    const key = `${l.mac}@${l.ip}`;
    const _parked = parked.has(key);
    if (seenLeases.has(key) && !_parked) continue;
    seenLeases.add(key);
    // Portal-first: park the reconnecting device (gated) so the captive portal shows
    // and restores it; if the portal does not acknowledge within the grace window,
    // auto-restore below so it never dead-ends at "connected, no internet".
    if (resumeEnabled()) {
      if (!_parked) { parked.set(key, t); continue; }
      const _g = parseInt((db.prepare("SELECT value FROM settings WHERE key='session_resume_grace_sec'").get()||{}).value||'25',10);
      if (t - parked.get(key) < _g) continue;
      parked.delete(key);
    }

    // Priority 1: already has an active session
    const existing = sessionSvc.findActiveByMac(l.mac);
    if (existing) {
      // If DHCP assigned a new IP, migrate the session in place
      if (existing.ip_address !== l.ip) {
        console.log(`[sessiond] IP migration ${l.mac}: ${existing.ip_address} → ${l.ip}`);
        db.prepare('UPDATE sessions SET ip_address=?, last_seen_at=? WHERE id=?').run(l.ip, t, existing.id);
        try { fw.revoke(existing.ip_address); } catch (e) {}
        const remaining = Math.max(60, (existing.expires_at || 0) - t);
        try { fw.authorize(l.ip, remaining); } catch (e) {}
        try { shape.del(existing.ip_address); } catch (e) {}
        if (existing.bandwidth_kbps) try { shape.add(l.ip, existing.bandwidth_kbps); } catch (e) {}
      }
      continue;
    }

    // Look up remembered device
    const rd = db.prepare(`
      SELECT rd.*, v.id AS voucher_id, v.status AS v_status, v.expires_at, v.bandwidth_kbps, v.max_devices
        FROM remembered_devices rd
        JOIN vouchers v ON v.id = rd.voucher_id
       WHERE rd.mac_address = ?
         AND rd.valid_until > ?
    `).get(l.mac, t);

    if (!rd) {
      // STACK-03 offline: no remembered_devices — check voucher_queue for waiting entry
      if (activateQueueEntryForReconnect(l.mac, l.ip, t)) continue;
      continue;
    }
    if (rd.v_status !== 'active') {
      // STACK-03 offline: remembered_devices points to expired/revoked voucher — try queue
      if (activateQueueEntryForReconnect(l.mac, l.ip, t)) continue;
      continue;
    }
    if (!rd.expires_at || rd.expires_at <= t) continue;

    // Check device cap
    const dev = db.prepare(`
      SELECT COUNT(*) AS n FROM sessions WHERE voucher_id=? AND ended_at IS NULL
    `).get(rd.voucher_id).n;
    if (dev >= rd.max_devices) continue;

    try {
      const sid = sessionSvc.startSession({
        voucherId: rd.voucher_id,
        mac: l.mac,
        ip: l.ip,
        expiresAt: rd.expires_at,
        bandwidthKbps: rd.bandwidth_kbps,
        nowSec: t
      });
      // Refresh remembered_devices to keep valid_until current
      db.prepare(`
        INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(mac_address) DO UPDATE SET
          voucher_id  = excluded.voucher_id,
          valid_until = excluded.valid_until
      `).run(l.mac, rd.voucher_id, rd.expires_at, t);
      console.log(`[sessiond] MAC re-auth: ${l.mac}@${l.ip} -> session ${sid} (voucher ${rd.voucher_id})`);
    } catch (e) {
      console.error(`[sessiond] re-auth failed for ${l.mac}: ${e.message}`);
    }
  }

  // Prune seenLeases when a lease disappears; revoke firewall so the returning
  // device hits the captive portal (portal-first). Session row is kept intact.
  const currentKeys = new Set(leases.map(l => `${l.mac}@${l.ip}`));
  const reOn = resumeEnabled();
  for (const k of seenLeases) if (!currentKeys.has(k)) {
    seenLeases.delete(k);
    parked.delete(k);
    if (reOn) { const gip = k.split('@')[1]; if (gip) { try { fw.revoke(gip); } catch (e) {} try { shape.del(gip); } catch (e) {} } }
  }
}

// --- 5. Pending payment expiry sweep (cancel orphaned Xendit requests) ------
async function pendingPaymentSweep() {
  // STRICT-PENDING-2026-05-31 — also expire stale 'manual' cash rows past
  // their expires_at so they stop blocking new cash payment creation.
  // Cash rows have no gateway_payment_id so the Xendit-cancel branch is a
  // no-op for them; the DB status flip is what matters.
  const t = now();
  try {
    const r = db.prepare(
      "UPDATE pending_payments SET status='expired', updated_at=? WHERE status='manual' AND expires_at <= ?"
    ).run(t, t);
    if (r.changes > 0) console.log(`[sessiond] STRICT-PENDING: expired ${r.changes} stale manual/cash payment(s)`);
  } catch (e) { console.warn('[pendingPaymentSweep manual]', e.message); }
  const rows = db.prepare(
    "SELECT id, gateway_payment_id FROM pending_payments WHERE status='pending' AND expires_at <= ?"
  ).all(t);
  if (!rows.length) return;
  let xenditMod = null;
  try {
    const modRow = db.prepare(
      "SELECT config_json AS config FROM payment_modules WHERE slug='xendit' AND is_active=1"
    ).get();
    if (modRow) {
      const cfg = JSON.parse(modRow.config || '{}');
      if (cfg.secret_key) xenditMod = { xendit: require('./modules/xendit'), cfg };
    }
  } catch (e) { /* xendit not configured */ }
  for (const r of rows) {
    if (r.gateway_payment_id && xenditMod) {
      try {
        await xenditMod.xendit.apiRequest(
          xenditMod.cfg, 'POST', '/payment_requests/' + r.gateway_payment_id + '/cancel'
        );
        console.log('[sessiond] cancelled Xendit pr=' + r.gateway_payment_id + ' pp_id=' + r.id);
      } catch (e) {
        console.warn('[sessiond] Xendit cancel failed pp_id=' + r.id + ': ' + e.message);
      }
    }
    db.prepare("UPDATE pending_payments SET status='expired',updated_at=? WHERE id=?").run(t, r.id);
  }
  if (rows.length) console.log('[sessiond] swept ' + rows.length + ' expired pending payment(s)');
}

// --- SYNC-02: Refresh nftables entries for sessions nearing their timeout ----
// Re-authorizes sessions whose remaining time is within REFRESH_THRESHOLD seconds.
// This ensures admin-extended vouchers keep internet access without waiting for
// a DHCP lease renewal to trigger re-auth.
const REFRESH_THRESHOLD = 600; // 10 minutes
function refreshNearExpirySessions() {
  const t = now();
  const rows = db.prepare(`
    SELECT s.id, s.ip_address, v.expires_at, v.bandwidth_kbps
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ended_at IS NULL
       AND v.expires_at IS NOT NULL
       AND v.expires_at > ?
       AND v.expires_at < ?
  `).all(t, t + REFRESH_THRESHOLD);
  // Portal-first: when resume is enabled, only refresh sessions whose device is
  // still present (has a live lease) — never re-open the firewall for an absent IP.
  const reOn = resumeEnabled();
  const liveIps = reOn ? new Set(readLeases().map(l => l.ip)) : null;
  for (const r of rows) {
    if (reOn && !liveIps.has(r.ip_address)) continue;
    const remaining = Math.max(120, r.expires_at - t);
    try {
      fw.authorize(r.ip_address, remaining);
    } catch (e) {
      console.warn(`[sessiond] SYNC-02: refresh fw failed ip=${r.ip_address}: ${e.message}`);
    }
  }
  if (rows.length > 0) {
    console.log(`[sessiond] SYNC-02: refreshed nftables for ${rows.length} near-expiry session(s)`);
  }
}

// --- FW-03: Load firewall_whitelist DB entries into nftables walled garden --
function loadFirewallWhitelist() {
  let rows = [];
  try {
    rows = db.prepare('SELECT ip FROM firewall_whitelist').all();
  } catch (e) {
    console.warn('[sessiond] FW-03: firewall_whitelist table not found:', e.message);
    return;
  }
  let loaded = 0;
  for (const r of rows) {
    if (!r.ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(r.ip)) continue;
    try {
      execFileSync('sudo', ['-n', '/usr/local/sbin/paywifi-auth', 'walled-add', r.ip],
        { stdio: 'ignore' });
      loaded++;
    } catch (e) {
      console.warn(`[sessiond] FW-03: walled-add failed ip=${r.ip}: ${e.message}`);
    }
  }
  if (loaded > 0) {
    console.log(`[sessiond] FW-03: loaded ${loaded} firewall_whitelist IP(s) into walled garden`);
  }
}

// --- BW-04: Restore active sessions into nftables + tc on startup ----------
function restoreActiveSessions() {
  const t = now();
  const rows = db.prepare(`
    SELECT s.id, s.ip_address, s.mac_address, v.expires_at, v.bandwidth_kbps
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ended_at IS NULL
       AND (v.expires_at IS NULL OR v.expires_at > ?)
  `).all(t);

  let restored = 0;
  for (const s of rows) {
    try {
      const remaining = s.expires_at ? Math.max(60, s.expires_at - t) : 86400;
      fw.authorize(s.ip_address, remaining);
    } catch (e) {
      console.warn(`[sessiond] restore fw failed ip=${s.ip_address}: ${e.message}`);
    }
    if (s.bandwidth_kbps) {
      try { shape.add(s.ip_address, s.bandwidth_kbps); } catch (e) {
        console.warn(`[sessiond] restore shape failed ip=${s.ip_address}: ${e.message}`);
      }
    }
    restored++;
  }
  if (restored > 0) {
    console.log(`[sessiond] BW-04: restored ${restored} active session(s) into nftables + tc`);
  }
}

// --- WAN-01: WAN connectivity health check ----------------------------------
let wanOnline = true;  // assume online at startup
let wanStateFile = '/run/paywifi-wan-state';  // shared with server.js via filesystem

function wanHealthCheck() {
  let online = false;
  try {
    execFileSync('ping', ['-c1', '-W2', '-q', '1.1.1.1'], { stdio: 'ignore' });
    online = true;
  } catch (e) {
    // also try 8.8.8.8 as fallback
    try {
      execFileSync('ping', ['-c1', '-W2', '-q', '8.8.8.8'], { stdio: 'ignore' });
      online = true;
    } catch (e2) { /* both failed — WAN down */ }
  }

  if (online !== wanOnline) {
    const t = now();
    const state = online ? 'up' : 'down';
    console.log(`[sessiond] WAN-01: WAN ${state}`);
    try {
      db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,NULL,?)")
        .run('wan_state_change', `wan=${state}`, t);
    } catch (e) { /* best effort */ }
    // Write state file so server.js /health can read it without DB query
    try {
      require('fs').writeFileSync(wanStateFile, online ? '1' : '0');
    } catch (e) { /* best effort */ }
    wanOnline = online;
  }
}

// Expose WAN state for external readers (used by server.js /health)
module.exports = { getWanState: () => wanOnline };

// --- Main loop --------------------------------------------------------------

// --- STACK-03/07/12: Activate next queued voucher for a MAC after expiry ----
// Called by expireOverdue when the old session ends with a waiting queue entry.
// Handles the fw.authorize BEFORE the old session's fw.revoke fires (STACK-12).
function activateNextInQueue(mac, ip, t) {
  const entry = sessionSvc.getNextQueueEntry(mac);
  if (!entry) return false;

  const expiresAt = t + entry.duration_minutes * 60;

  // STACK-12: Authorize new timeout on the SAME IP before old session revokes it.
  // nft add element with timeout refreshes an existing element — no access gap.
  try { fw.authorize(ip, expiresAt - t); } catch (e) {
    console.warn(`[sessiond] STACK-12: pre-authorize failed ip=${ip}: ${e.message}`);
  }

  // DB transition (atomic)
  const doTransition = db.transaction(() => {
    db.prepare("UPDATE vouchers SET status='active', first_used_at=?, expires_at=? WHERE id=?")
      .run(t, expiresAt, entry.voucher_id);
    db.prepare("UPDATE voucher_queue SET status='active', activated_at=? WHERE id=?")
      .run(t, entry.id);
    const r = db.prepare(
      'INSERT INTO sessions (voucher_id, mac_address, ip_address, started_at, last_seen_at) VALUES (?,?,?,?,?)'
    ).run(entry.voucher_id, mac, ip, t, t);
    return r.lastInsertRowid;
  });

  let newSid;
  try {
    newSid = doTransition();
  } catch (e) {
    console.error(`[sessiond] STACK-03: queue transition DB failed ${mac}: ${e.message}`);
    // Rollback fw pre-authorize so device doesn't get free access
    try { fw.revoke(ip); } catch (_) {}
    return false;
  }

  // STACK-08/13: update bandwidth shaping if changed
  try { shape.del(ip); } catch (_) {}
  if (entry.bandwidth_kbps > 0) {
    try { shape.add(ip, entry.bandwidth_kbps); } catch (e) {
      console.warn(`[sessiond] STACK-08: shaping failed ip=${ip}: ${e.message}`);
    }
  }

  // Keep remembered_devices pointing to the new voucher
  try {
    db.prepare(`
      INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mac_address) DO UPDATE SET
        voucher_id  = excluded.voucher_id,
        valid_until = excluded.valid_until
    `).run(mac, entry.voucher_id, expiresAt, t);
  } catch (_) {}

  console.log(`[sessiond] STACK-03: queue activated ${mac}@${ip} voucher=${entry.voucher_id} pos=${entry.queue_position} session=${newSid}`);
  return true;
}

// --- STACK-03 (offline path): activate queued voucher for a reconnecting device ----
// Called by leaseSweep when a device reconnects but has no active session.
// The previous voucher already expired while the device was offline.
function activateQueueEntryForReconnect(mac, ip, t) {
  const entry = sessionSvc.getNextQueueEntry(mac);
  if (!entry) return false;

  const expiresAt = t + entry.duration_minutes * 60;

  const doTransition = db.transaction(() => {
    db.prepare("UPDATE vouchers SET status='active', first_used_at=?, expires_at=? WHERE id=?")
      .run(t, expiresAt, entry.voucher_id);
    db.prepare("UPDATE voucher_queue SET status='active', activated_at=? WHERE id=?")
      .run(t, entry.id);
    const r = db.prepare(
      'INSERT INTO sessions (voucher_id, mac_address, ip_address, started_at, last_seen_at) VALUES (?,?,?,?,?)'
    ).run(entry.voucher_id, mac, ip, t, t);
    return r.lastInsertRowid;
  });

  let newSid;
  try {
    newSid = doTransition();
  } catch (e) {
    console.error(`[sessiond] STACK-03 reconnect: queue activate failed ${mac}: ${e.message}`);
    return false;
  }

  try { fw.authorize(ip, expiresAt - t); } catch (e) {}
  if (entry.bandwidth_kbps > 0) {
    try { shape.add(ip, entry.bandwidth_kbps); } catch (e) {}
  }
  try {
    db.prepare(`
      INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mac_address) DO UPDATE SET
        voucher_id  = excluded.voucher_id,
        valid_until = excluded.valid_until
    `).run(mac, entry.voucher_id, expiresAt, t);
  } catch (_) {}

  console.log(`[sessiond] STACK-03 reconnect: queue activated ${mac}@${ip} voucher=${entry.voucher_id} session=${newSid}`);
  return true;
}

function staleDeviceCleanup() {
  // DATA-02: remove remembered_devices rows that expired more than 24 h ago
  const cutoff = now() - 86400;
  const result = db.prepare('DELETE FROM remembered_devices WHERE valid_until < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[sessiond] staleDeviceCleanup: removed ${result.changes} stale remembered_devices row(s)`);
  }
}


// LATE-PENDING-2026-06-03 — SMS the partner if a manual pending has been
// sitting > partner_confirm_sla_min minutes. One-shot: each pending row is
// flagged via pending_payments.late_alert_sent so we don't spam.
function latePendingSweep() {
  try {
    const enabled = (db.prepare("SELECT value FROM settings WHERE key='partner_late_pending_sms_enabled'").get() || {}).value === '1';
    if (!enabled) return;
    const slaMin = parseInt((db.prepare("SELECT value FROM settings WHERE key='partner_confirm_sla_min'").get() || {}).value || '5', 10);
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - slaMin * 60;
    const rows = db.prepare(
      "SELECT pp.id, pp.amount, pp.partner_id, p.mobile, p.partner_name " +
      "FROM pending_payments pp " +
      "JOIN partners p ON p.id = pp.partner_id " +
      "WHERE pp.status='manual' " +
      "  AND pp.created_at <= ? " +
      "  AND pp.expires_at > ? " +
      "  AND p.status='active' " +
      "  AND (pp.late_alert_sent IS NULL OR pp.late_alert_sent = 0) " +
      "LIMIT 20"
    ).all(cutoff, now);
    if (!rows.length) return;
    const apiKey = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get()    || {}).value || '';
    const sender = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get() || {}).value || 'PAYWIFI';
    if (!apiKey) return;
    rows.forEach(r => {
      // Mark first to avoid duplicate sends in overlapping ticks
      try { db.prepare("UPDATE pending_payments SET late_alert_sent=1 WHERE id=?").run(r.id); } catch (e) {}
      const ref = String(r.id).padStart(6, '0').slice(-6);
      const msg = 'PAYWIFI: Cash payment #' + ref + ' (₱' + r.amount + ') has been waiting more than ' + slaMin + ' min. Please confirm or decline.';
      semaphore.sendSms(apiKey, sender, r.mobile, msg, { kind: 'partner_late_pending' })
        .catch(e => console.error('[sessiond] late-pending SMS:', e.message));
      console.log('[sessiond] late-pending alert -> partner ' + r.partner_id + ' pp=' + r.id);
    });
  } catch (e) { console.error('latePendingSweep:', e); }
}

function welcomeSmsSweep() {
  const t = now();
  const cfg = db.prepare("SELECT * FROM lead_nurturing_config WHERE phase='welcome_gift' AND enabled=1").get();
  if (!cfg || !cfg.sms_enabled) return;
  const rows = db.prepare("SELECT id, phone FROM lead_funnel WHERE welcome_voucher_id IS NOT NULL AND welcome_sms_sent=0 AND welcome_sms_due_at IS NOT NULL AND welcome_sms_due_at<=?").all(t);
  if (!rows.length) return;
  const apiKey = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get() || {}).value || '';
  const sender = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get() || {}).value || 'PAYWIFI';
  const m = cfg.duration_minutes || 0;
  const dur = m>=1440 ? Math.round(m/1440)+' day(s)' : m>=60 ? Math.round(m/60)+' hour(s)' : m+' min';
  for (const r of rows) {
    db.prepare("UPDATE lead_funnel SET welcome_sms_sent=1 WHERE id=?").run(r.id); // mark first (avoid dup on overlapping ticks)
    if (!r.phone) continue;
    const msg = (cfg.sms_template || 'Your PAYWIFI welcome gift is ready — check your inbox in the portal.').replace('{duration}', dur).replace('{code}','').replace('{name}','').trim();
    semaphore.sendSms(apiKey, sender, r.phone, msg).catch(e => console.error('[sessiond] welcome SMS:', e.message));
    console.log('[sessiond] delayed welcome-gift SMS -> lead ' + r.id);
  }
}

function autoLinkAgingSweep() {
  const days = parseInt((db.prepare("SELECT value FROM settings WHERE key='auto_login_link_max_days'").get()||{}).value||'0', 10);
  if (!days || days <= 0) return;
  const cutoff = Math.floor(Date.now()/1000) - days*86400;
  const stale = db.prepare("SELECT mac_address FROM device_user WHERE source='auto' AND linked_at < ?").all(cutoff);
  for (const r of stale) {
    const active = db.prepare('SELECT 1 FROM sessions WHERE mac_address=? AND ended_at IS NULL LIMIT 1').get(r.mac_address);
    if (!active) db.prepare("DELETE FROM device_user WHERE mac_address=? AND source='auto'").run(r.mac_address);
  }
}

function tick() {
  try { expireOverdue();              } catch (e) { console.error('expireOverdue:',              e); }
  try { idleSweep();                  } catch (e) { console.error('idleSweep:',                  e); }
  try { refreshNearExpirySessions();  } catch (e) { console.error('refreshNearExpirySessions:',  e); }
  try { welcomeSmsSweep();            } catch (e) { console.error('welcomeSmsSweep:',            e); }
  try { latePendingSweep();           } catch (e) { console.error('latePendingSweep:',           e); }
  // COMPLIANCE-SWEEP-2026-06-03 — evaluate weekly remittance compliance for all partners
  try {
    const compliance = require('./services/compliance');
    const r = compliance.evaluatePreviousWeek();
    if (r.restricted || r.unrestricted) {
      console.log('[sessiond] compliance: evaluated=' + r.evaluated + ' restricted=' + r.restricted + ' unrestricted=' + r.unrestricted);
    }
  } catch (e) { console.error('complianceSweep:', e); }
  try { byteSweep();                  } catch (e) { console.error('byteSweep:',                  e); }
  try { leaseSweep();                 } catch (e) { console.error('leaseSweep:',                 e); }
  try { autoLinkAgingSweep();         } catch (e) { console.error('autoLinkAgingSweep:',         e); }
  try { wanHealthCheck();             } catch (e) { console.error('wanHealthCheck:',             e); }
  try { staleDeviceCleanup();          } catch (e) { console.error('staleDeviceCleanup:',          e); }
  pendingPaymentSweep().catch(e => console.error('pendingPaymentSweep:', e));
}

console.log(`[PAYWIFI sessiond] starting (poll=${POLL_MS}ms idle=dynamic)`);
restoreActiveSessions();
loadFirewallWhitelist();
tick();
setInterval(tick, POLL_MS);

process.on('SIGTERM', () => { console.log('[sessiond] SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[sessiond] SIGINT');  process.exit(0); });
