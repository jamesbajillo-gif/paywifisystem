'use strict';
const db = require('../db');
const fw = require('./firewall');
const shape = require('./shaping');

function startSession({ voucherId, mac, ip, expiresAt, bandwidthKbps, nowSec }) {
  const insert = db.prepare(`
    INSERT INTO sessions (voucher_id, mac_address, ip_address,
                          started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const r = insert.run(voucherId, mac, ip, nowSec, nowSec);
  const sessionId = r.lastInsertRowid;
  try { db.prepare("UPDATE vouchers SET lifecycle_state='active' WHERE id=?").run(voucherId); } catch (e) {}

  const timeoutSec = Math.max(60, expiresAt - nowSec);
  try {
    fw.authorize(ip, timeoutSec);
  } catch (e) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    throw new Error('Firewall authorize failed: ' + e.message);
  }

  // Apply bandwidth shaping (best effort — log but don't fail the session)
  if (bandwidthKbps && bandwidthKbps > 0) {
    try {
      shape.add(ip, bandwidthKbps);
    } catch (e) {
      console.error(`[session] shaping failed for ${ip}: ${e.message}`);
    }
  }

  // Trust-on-redemption: an eligible voucher actually used to start a session (lazy require avoids cycle)
  try { require('./nurturing').trustOnRedeem(voucherId, mac, ip, nowSec); } catch (e) {}

  return sessionId;
}

function findActiveByIp(ip) {
  return db.prepare(`
    SELECT s.*, v.code AS voucher_code, v.expires_at, v.duration_minutes,
           v.bandwidth_kbps
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ip_address = ? AND s.ended_at IS NULL
     ORDER BY s.id DESC
     LIMIT 1
  `).get(ip);
}

function findActiveByMac(mac) {
  return db.prepare(`
    SELECT s.*, v.code AS voucher_code, v.expires_at, v.bandwidth_kbps, v.duration_minutes
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.mac_address = ? AND s.ended_at IS NULL
     ORDER BY s.id DESC
     LIMIT 1
  `).get(mac);  // DATA-01: duration_minutes added to match findActiveByIp
}

function endSession(sessionId, reason, nowSec, { keepFirewall = false, keepShape = false } = {}) {  // STACK-07/12: opts for queue transitions
  const sess = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!sess || sess.ended_at) return false;

  db.prepare(`UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?`)
    .run(nowSec, reason, sessionId);
  try { db.prepare("UPDATE vouchers SET lifecycle_state='consumed' WHERE id=? AND lifecycle_state NOT IN ('cancelled','abuse_flagged')").run(sess.voucher_id); } catch (e) {}

  if (!keepFirewall) try { fw.revoke(sess.ip_address); } catch (e) { /* best effort */ }  // STACK-12
  if (!keepShape)    try { shape.del(sess.ip_address);  } catch (e) { /* best effort */ }  // STACK-08

  // SYNC-01: kicked sessions must not auto-reconnect via remembered_devices
  if (reason === 'kicked') {
    try {
      db.prepare('DELETE FROM remembered_devices WHERE mac_address=?').run(sess.mac_address);
    } catch (e) { /* best effort */ }
  }

  // Auto-login policy: on a real disconnect (not a queue handoff), optionally detach
  // AUTO device links so a shared device does not stay logged into a prior user.
  if (!keepFirewall) {
    try {
      if ((db.prepare("SELECT value FROM settings WHERE key='auto_login_unlink_on_session_end'").get()||{}).value === '1') {
        db.prepare("DELETE FROM device_user WHERE mac_address=? AND source='auto'").run(sess.mac_address);
      }
    } catch (e) { /* best effort */ }
  }

  return true;
}

function touchSession(sessionId, nowSec) {
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(nowSec, sessionId);
}


// ── Device detection priority ─────────────────────────────────────────────
// P1: Active session exists → touch it + migrate IP if changed
// P2: No session but MAC in remembered_devices (valid, voucher active) → instant re-auth
function syncDeviceSession(mac, ip) {
  if (!mac || !ip) return null;
  const now = Math.floor(Date.now() / 1000);

  // Priority 1: active session by MAC
  const sess = findActiveByMac(mac);
  if (sess) {
    touchSession(sess.id, now);
    if (sess.ip_address !== ip) {
      // IP changed (DHCP gave a different address) — migrate session in place
      console.log(`[session] IP migration ${mac}: ${sess.ip_address} → ${ip}`);
      db.prepare('UPDATE sessions SET ip_address=?, last_seen_at=? WHERE id=?').run(ip, now, sess.id);
      try { fw.revoke(sess.ip_address); } catch (e) {}
      const remaining = Math.max(60, (sess.expires_at || 0) - now);
      try { fw.authorize(ip, remaining); } catch (e) {}
      try { shape.del(sess.ip_address); } catch (e) {}
      if (sess.bandwidth_kbps && sess.bandwidth_kbps > 0) {
        try { shape.add(ip, sess.bandwidth_kbps); } catch (e) {}
      }
    }
    // Keep remembered_devices current while session is alive
    db.prepare(`
      INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mac_address) DO UPDATE SET
        voucher_id  = excluded.voucher_id,
        valid_until = excluded.valid_until
    `).run(mac, sess.voucher_id, sess.expires_at || 0, now);
    return findActiveByMac(mac);
  }

  // Priority 2: no active session — check remembered_devices
  const rd = db.prepare(`
    SELECT rd.voucher_id, rd.valid_until,
           v.status AS v_status, v.expires_at, v.bandwidth_kbps, v.max_devices
      FROM remembered_devices rd
      JOIN vouchers v ON v.id = rd.voucher_id
     WHERE rd.mac_address = ?
       AND rd.valid_until > ?
  `).get(mac, now);

  if (!rd || rd.v_status !== 'active' || !rd.expires_at || rd.expires_at <= now) return null;

  const devCount = db.prepare(
    'SELECT COUNT(*) n FROM sessions WHERE voucher_id=? AND ended_at IS NULL'
  ).get(rd.voucher_id).n;
  if (devCount >= rd.max_devices) return null;

  try {
    const sid = startSession({
      voucherId:     rd.voucher_id,
      mac,
      ip,
      expiresAt:     rd.expires_at,
      bandwidthKbps: rd.bandwidth_kbps,
      nowSec:        now,
    });
    console.log(`[session] instant re-auth ${mac}@${ip} → session ${sid}`);
    return findActiveByMac(mac);
  } catch (e) {
    console.error(`[session] re-auth failed ${mac}: ${e.message}`);
    return null;
  }
}


function findLastEndedByMac(mac) {
  if (!mac) return null;
  return db.prepare(`
    SELECT end_reason FROM sessions
     WHERE mac_address = ? AND ended_at IS NOT NULL
     ORDER BY id DESC
     LIMIT 1
  `).get(mac);  // FE-01: last ended session for session_state mapping
}


function getQueueForMac(mac) {
  // STACK-04/10: return ordered list of waiting queue entries for a MAC
  if (!mac) return [];
  return db.prepare(`
    SELECT vq.queue_position, vq.voucher_id, vq.queued_at,
           v.code AS voucher_code, v.duration_minutes, v.bandwidth_kbps
      FROM voucher_queue vq
      JOIN vouchers v ON v.id = vq.voucher_id
     WHERE vq.mac_address = ? AND vq.status = 'waiting'
     ORDER BY vq.queue_position ASC
  `).all(mac);
}

function getNextQueueEntry(mac) {
  // STACK-03: get the single next waiting entry for queue transitions
  if (!mac) return null;
  return db.prepare(`
    SELECT vq.id, vq.voucher_id, vq.queue_position,
           v.duration_minutes, v.bandwidth_kbps
      FROM voucher_queue vq
      JOIN vouchers v ON v.id = vq.voucher_id
     WHERE vq.mac_address = ? AND vq.status = 'waiting'
     ORDER BY vq.queue_position ASC
     LIMIT 1
  `).get(mac);
}

// P7: queue a freshly-created (paid) voucher if the device already has an active session
function enqueueVoucherIfActive(mac, voucherId, now){
  if(!mac || !voucherId) return { queued:false, queue_position:0 };
  const existing = findActiveByMac(mac);
  if(!existing || existing.voucher_id === voucherId) return { queued:false, queue_position:0 };
  const dup = db.prepare("SELECT queue_position FROM voucher_queue WHERE voucher_id=? AND status='waiting'").get(voucherId);
  if(dup) return { queued:true, queue_position:(dup.queue_position||0)+1 };
  try {
    const tx = db.transaction(()=>{
      const mp = db.prepare("SELECT COALESCE(MAX(queue_position),-1) mp FROM voucher_queue WHERE mac_address=? AND status='waiting'").get(mac);
      const pos = ((mp && mp.mp)!=null ? mp.mp : -1) + 1;
      db.prepare("UPDATE vouchers SET status='queued' WHERE id=? AND status='unused'").run(voucherId);
      db.prepare("INSERT INTO voucher_queue (mac_address,voucher_id,queue_position,queued_at) VALUES (?,?,?,?)").run(mac, voucherId, pos, now);
      return pos;
    });
    const pos = tx();
    return { queued:true, queue_position: pos+1 };
  } catch(e){ return { queued:false, queue_position:0, error:e.message }; }
}
function queueInfoForVoucher(voucherId){
  if(!voucherId) return { queued:false, queue_position:0 };
  const q = db.prepare("SELECT queue_position FROM voucher_queue WHERE voucher_id=? AND status IN ('waiting','active')").get(voucherId);
  return q ? { queued:true, queue_position:(q.queue_position||0)+1 } : { queued:false, queue_position:0 };
}

module.exports = { startSession, findActiveByIp, findActiveByMac, findLastEndedByMac, endSession, touchSession, syncDeviceSession, getQueueForMac, getNextQueueEntry, enqueueVoucherIfActive, queueInfoForVoucher };
