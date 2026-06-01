'use strict';
const db         = require('../db');
const voucherSvc = require('./voucher');
const sessionSvc = require('./session');
const semaphore  = require('./semaphore');

function now() { return Math.floor(Date.now() / 1000); }

function fmtDuration(minutes) {
  if (!minutes) return '';
  if (minutes >= 1440) return Math.round(minutes / 1440) + ' day(s)';
  if (minutes >= 60)   return Math.round(minutes / 60) + ' hour(s)';
  return minutes + ' min';
}

function getPortalLink() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='domain_name'").get();
    return (r && r.value) ? r.value : 'http://10.10.0.1';
  } catch (e) { return 'http://10.10.0.1'; }
}

function getConfig(phase) {
  return db.prepare('SELECT * FROM lead_nurturing_config WHERE phase=? AND enabled=1').get(phase);
}

// Read Semaphore credentials from settings
function getSmsConfig() {
  try {
    const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('semaphore_api_key','semaphore_sender_name')").all();
    const cfg  = {};
    rows.forEach(r => { cfg[r.key] = r.value; });
    return { apiKey: cfg.semaphore_api_key || '', senderName: cfg.semaphore_sender_name || '' };
  } catch (e) {
    console.error('[nurturing] getSmsConfig error:', e.message);
    return { apiKey: '', senderName: '' };
  }
}

// Normalize phone to 63XXXXXXXXX international format
function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '63' + p.slice(1);
  if (!p.startsWith('63')) p = '63' + p;
  return p;
}

// Upsert a lead_funnel record by phone
function upsertLead(phone, mac, updates) {
  phone = normalizePhone(phone);
  const t = now();
  const existing = db.prepare('SELECT id FROM lead_funnel WHERE phone=?').get(phone);
  if (existing) {
    const entries = Object.assign({}, updates, { updated_at: t });
    const keys = Object.keys(entries);
    if (keys.length) {
      const sets = keys.map(k => k + '=?').join(',');
      db.prepare('UPDATE lead_funnel SET ' + sets + ' WHERE phone=?')
        .run(...keys.map(k => entries[k]), phone);
    }
    return existing.id;
  } else {
    const cols = ['phone', 'mac_address', 'created_at', 'updated_at'].concat(Object.keys(updates));
    const vals = [phone, mac || null, t, t].concat(Object.values(updates));
    const ph   = cols.map(() => '?').join(',');
    try {
      const r = db.prepare('INSERT OR IGNORE INTO lead_funnel(' + cols.join(',') + ') VALUES(' + ph + ')')
                  .run(...vals);
      return r.lastInsertRowid;
    } catch (e) {
      console.error('[nurturing] upsertLead error:', e.message);
      return null;
    }
  }
}

// Generate an auto-voucher from nurturing config
function genRewardVoucher(cfg) {
  const t    = now();
  const code = voucherSvc.generateCode();
  const r = db.prepare(
    "INSERT INTO vouchers(code,duration_minutes,bandwidth_kbps,max_devices,status,lifecycle_state,created_at) VALUES(?,?,?,?,'unused','generated',?)"
  ).run(code, cfg.duration_minutes, cfg.bandwidth_kbps, 1, t);
  return { id: r.lastInsertRowid, code };
}

// Activate voucher immediately if no active session, otherwise queue it
function activateOrQueue(voucherRow, mac, ip) {
  const t        = now();
  const existing = sessionSvc.findActiveByMac(mac);
  if (!existing) {
    const activation = voucherSvc.activateVoucher(voucherRow, t);
    if (!activation.ok) return { queued: false, failed: activation.error };
    sessionSvc.startSession({
      voucherId:     voucherRow.id,
      mac, ip,
      expiresAt:     activation.expiresAt,
      bandwidthKbps: voucherRow.bandwidth_kbps,
      nowSec:        t
    });
    db.prepare(
      'INSERT INTO remembered_devices(mac_address,voucher_id,valid_until,created_at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(mac_address) DO UPDATE SET voucher_id=excluded.voucher_id,valid_until=excluded.valid_until'
    ).run(mac, voucherRow.id, activation.expiresAt, t);
    return { queued: false };
  } else {
    return forceQueue(voucherRow, mac);
  }
}

// Always queue a voucher behind whatever is active/already queued
function forceQueue(voucherRow, mac) {
  const t      = now();
  const maxPos = db.prepare(
    "SELECT COALESCE(MAX(queue_position),-1) AS mp FROM voucher_queue WHERE mac_address=? AND status='waiting'"
  ).get(mac);
  const nextPos = ((maxPos && maxPos.mp !== undefined ? maxPos.mp : -1)) + 1;
  db.prepare("UPDATE vouchers SET status='queued', lifecycle_state='queued' WHERE id=?").run(voucherRow.id);
  db.prepare(
    "INSERT INTO voucher_queue(mac_address,voucher_id,queue_position,queued_at) VALUES(?,?,?,?)"
  ).run(mac, voucherRow.id, nextPos, t);
  return { queued: true, position: nextPos + 1 };
}

// Bonus engine: issues the automatic signup (5-hour) reward + welcome gift vouchers.
// Fired on trusted-voucher redemption (see ensureTrustedAccount). No manual registration.
async function issueBonusVouchers(mac, ip, phone, userId) {
  const t       = now();
  const results = { signupCode: null, welcomeCode: null, signupQueued: false, welcomeQueued: false };
  try {
    // 3a: Signup reward (activate or queue)
    const sigCfg = getConfig('signup_reward');
    if (sigCfg) {
      const { id: svId, code: signupCode } = genRewardVoucher(sigCfg);
      // 5-hour welcome reward is generated UNUSED and claimed by the user via the portal alert.
      results.signupCode   = signupCode;
      results.signupQueued = false;
      upsertLead(phone, mac, {
        stage: 'signup_rewarded', user_id: userId,
        signup_voucher_id: svId, registered_at: t, signup_reward_at: t, signup_sms_sent: 1
      });
      if (sigCfg.sms_enabled) {
        const msg = sigCfg.sms_template
          .replace('{duration}', fmtDuration(sigCfg.duration_minutes))
          .replace('{code}', signupCode)
          .replace('{name}', '').trim();
        const { apiKey, senderName } = getSmsConfig();
        semaphore.sendSms(apiKey, senderName, phone, msg)
          .catch(e => console.error('[nurturing] signup SMS error:', e.message));
      }
    }
    // 3b: Welcome gift (12h) — auto-queued behind the current session.
    const welCfg = getConfig('welcome_gift');
    if (welCfg) {
      const { id: wvId, code: welcomeCode } = genRewardVoucher(welCfg);
      const wRow = db.prepare('SELECT * FROM vouchers WHERE id=?').get(wvId);
      forceQueue(wRow, mac);
      results.welcomeCode   = welcomeCode;
      results.welcomeQueued = true;
      // Welcome-gift SMS is sent ~1h later by sessiond (welcomeSmsSweep). No code in SMS — user checks the in-portal inbox.
      upsertLead(phone, mac, {
        stage: 'welcome_rewarded', welcome_voucher_id: wvId,
        welcome_reward_at: t, welcome_sms_sent: 0, welcome_sms_due_at: t + 3600
      });
    }
  } catch (e) {
    console.error('[nurturing] issueBonusVouchers error:', e.message);
  }
  return results;
}

// Auto-create (or fetch) a portal_user for a TRUSTED phone and link the device.
// Trusted source = paid purchase, delivered free-trial SMS, or verified login code.
// Idempotent via portal_users.phone UNIQUE: account creation + the one-time signup/welcome
// reward fire exactly once per number. Never clobbers an existing device link.
// A LINKED number (SMS sent, not yet used) gets a provisional portal_user; rewards stay locked.
function ensureLinkedNumber(rawPhone, mac, ip) {
  let ph = String(rawPhone || '').replace(/\D/g, '');
  if (ph.startsWith('0')) ph = '63' + ph.slice(1);
  if (ph.length === 10 && ph[0] === '9') ph = '63' + ph;
  if (!/^639\d{9}$/.test(ph)) return null;
  const t = now(); let userId = null;
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO portal_users(phone,created_at,provisional) VALUES(?,?,1)').run(ph, t);
    const u = db.prepare('SELECT id FROM portal_users WHERE phone=?').get(ph); userId = u ? u.id : null;
    if (mac && userId) { const ex = db.prepare('SELECT user_id FROM device_user WHERE mac_address=?').get(mac);
      if (!ex) db.prepare("INSERT INTO device_user(mac_address,user_id,linked_at,source) VALUES(?,?,?,'linked')").run(mac, userId, t); }
  })();
  return userId ? { userId: userId, phone: ph } : null;
}

function setVoucherLifecycle(voucherId, state) { if (!voucherId) return; try { db.prepare('UPDATE vouchers SET lifecycle_state=? WHERE id=?').run(state, voucherId); } catch (e) {} }

// Trust = number TRANSITIONS to trusted (voucher actually used). Reward fires once on that transition.
function ensureTrustedAccount(rawPhone, mac, ip, source, ref, voucherId) {
  let ph = String(rawPhone || '').replace(/\D/g, '');
  if (ph.startsWith('0')) ph = '63' + ph.slice(1);
  if (ph.length === 10 && ph[0] === '9') ph = '63' + ph;
  if (!/^639\d{9}$/.test(ph)) return null;
  const t = now();
  let userId = null, becameTrusted = false;
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO portal_users(phone,created_at,provisional) VALUES(?,?,0)').run(ph, t);
    const u = db.prepare('SELECT id, trusted_at FROM portal_users WHERE phone=?').get(ph);
    if (!u) return;
    userId = u.id; becameTrusted = !u.trusted_at;
    try { const cv = (db.prepare("SELECT value FROM settings WHERE key='consent_version'").get() || {}).value || '1';
          db.prepare('UPDATE portal_users SET consent_version=COALESCE(consent_version,?), consent_at=COALESCE(consent_at,?) WHERE id=?').run(cv, t, userId); } catch (e) {}
    db.prepare('UPDATE portal_users SET trusted_at=COALESCE(trusted_at,?), trust_source=COALESCE(trust_source,?), trust_voucher_id=COALESCE(trust_voucher_id,?), provisional=0 WHERE id=?').run(t, source || 'voucher', voucherId || null, userId);
    if (mac) { const ex = db.prepare('SELECT user_id FROM device_user WHERE mac_address=?').get(mac);
      if (!ex) db.prepare("INSERT INTO device_user(mac_address,user_id,linked_at,source) VALUES(?,?,?,'auto')").run(mac, userId, t); }
  })();
  if (!userId) return null;
  if (becameTrusted) {
    try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
            .run('number_trusted', 'phone=' + ph + ' mac=' + (mac || '') + ' source=' + (source || '') + ' ' + (ref || '') + ' user=' + userId, ip || null, t); } catch (e) {}
    try { upsertLead(ph, mac, { stage: 'registered', user_id: userId, registered_at: t }); } catch (e) {}
    try { Promise.resolve().then(function () { return issueBonusVouchers(mac || '', ip || '', ph, userId); }).catch(function () {}); } catch (e) {}
  }
  return { userId: userId, createdNew: becameTrusted, phone: ph };
}

// Stage 4 retention: 1-hour boost for a trusted, near-expiry session, with smart cooldown.
function claimRetentionForDevice(mac, ip) {
  if (!mac) return { ok: false, error: 'Device not detected.' };
  const g = k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
  if (g('retention_enabled') === '0') return { ok: false, error: 'Not available right now.' };
  const user = db.prepare('SELECT pu.* FROM portal_users pu JOIN device_user du ON du.user_id=pu.id WHERE du.mac_address=?').get(mac);
  if (!user || !user.trusted_at) return { ok: false, error: 'Not eligible yet.' };
  const sess = sessionSvc.findActiveByMac(mac);
  if (!sess) return { ok: false, error: 'No active session.' };
  const v0 = db.prepare('SELECT expires_at FROM vouchers WHERE id=?').get(sess.voucher_id) || {};
  const remaining = (v0.expires_at || 0) - now();
  const threshold = parseInt(g('retention_threshold_min') || '15', 10) * 60;
  if (remaining > threshold) return { ok: false, error: 'Not yet — available when your time is almost up.' };
  const lf = db.prepare('SELECT last_retention_at, retention_count FROM lead_funnel WHERE phone=?').get(user.phone) || {};
  const last = lf.last_retention_at || 0;
  const cdH = parseInt(g('retention_cooldown_hours') || '24', 10);
  const cdS = parseInt(g('retention_cooldown_sessions') || '3', 10);
  const sessionsSince = db.prepare('SELECT COUNT(*) n FROM sessions s JOIN device_user du ON du.mac_address=s.mac_address WHERE du.user_id=? AND s.started_at>?').get(user.id, last).n;
  const cooldownOK = (now() - last >= cdH * 3600) || (sessionsSince >= cdS);
  if (last && !cooldownOK) return { ok: false, error: 'You can claim another boost later.' };
  const mins = parseInt(g('retention_bonus_minutes') || '60', 10);
  const bw = (getConfig('signup_reward') || {}).bandwidth_kbps || 10240;
  const gen = genRewardVoucher({ duration_minutes: mins, bandwidth_kbps: bw });
  const vr = db.prepare('SELECT * FROM vouchers WHERE id=?').get(gen.id);
  setVoucherLifecycle(gen.id, 'claimed');
  forceQueue(vr, mac);
  try { db.prepare('UPDATE lead_funnel SET last_retention_at=?, retention_count=COALESCE(retention_count,0)+1, updated_at=? WHERE phone=?').run(now(), now(), user.phone); } catch (e) {}
  try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)").run('retention_claimed', 'voucher=' + gen.id + ' mac=' + mac + ' user=' + user.id + ' mins=' + mins, ip || null, now()); } catch (e) {}
  return { ok: true, code: gen.code, minutes: mins, queued: true };
}

// Trust-on-redemption: when a TRUST-ELIGIBLE voucher is successfully redeemed (a session
// starts), create/recognize the account for the number tied to that voucher. Eligible types:
// free-trial (campaign.trust_eligible) and reward/bonus vouchers (settings.trust_reward_vouchers).
// Admin/manual/paid/unrelated vouchers are NOT trusted here (paid is trusted at payment).
// Idempotent via ensureTrustedAccount (one trust per number).
function trustOnRedeem(voucherId, mac, ip, when) {
  try {
    if (!voucherId) return;
    const ftc = db.prepare("SELECT id, phone_plain, campaign_id FROM free_trial_claims WHERE voucher_id=? AND phone_plain IS NOT NULL ORDER BY id DESC LIMIT 1").get(voucherId);
    if (ftc && ftc.phone_plain) {
      let eligible = true;
      if (ftc.campaign_id) { const camp = db.prepare('SELECT trust_eligible FROM free_trial_campaigns WHERE id=?').get(ftc.campaign_id); if (camp) eligible = (camp.trust_eligible !== 0); }
      if (eligible) ensureTrustedAccount(ftc.phone_plain, mac, ip, 'free_trial', 'ftc#' + ftc.id, voucherId);
      return;
    }
    const rewardOn = ((db.prepare("SELECT value FROM settings WHERE key='trust_reward_vouchers'").get() || {}).value !== '0');
    if (rewardOn) {
      const lf = db.prepare('SELECT phone FROM lead_funnel WHERE signup_voucher_id=? OR welcome_voucher_id=? LIMIT 1').get(voucherId, voucherId);
      if (lf && lf.phone) ensureTrustedAccount(lf.phone, mac, ip, 'reward_bonus', 'lf-v#' + voucherId, voucherId);
    }
  } catch (e) { console.warn('[trust] trustOnRedeem:', e.message); }
}

// Claim the (unused) welcome voucher for a device: activate now if idle, else queue behind current.
function claimWelcomeForDevice(mac, ip) {
  if (!mac) return { ok: false, error: 'Device not detected.' };
  const user = db.prepare('SELECT pu.* FROM portal_users pu JOIN device_user du ON du.user_id=pu.id WHERE du.mac_address=?').get(mac);
  if (!user) return { ok: false, error: 'No account on this device.' };
  const lf = db.prepare('SELECT signup_voucher_id FROM lead_funnel WHERE phone=? AND signup_voucher_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(user.phone);
  if (!lf || !lf.signup_voucher_id) return { ok: false, error: 'No welcome voucher available.' };
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(lf.signup_voucher_id);
  if (!v || v.status !== 'unused') return { ok: false, error: 'This voucher was already claimed.' };
  setVoucherLifecycle(v.id, 'claimed');
  const r = activateOrQueue(v, mac, ip || '');
  try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)").run('welcome_voucher_claimed', 'voucher=' + v.id + ' mac=' + mac + ' queued=' + (r.queued?1:0), ip || null, now()); } catch (e) {}
  return { ok: true, code: v.code, minutes: v.duration_minutes || 0, queued: !!r.queued };
}

module.exports = { issueBonusVouchers, claimWelcomeForDevice, claimRetentionForDevice, ensureLinkedNumber, setVoucherLifecycle, upsertLead, getConfig, fmtDuration, ensureTrustedAccount, trustOnRedeem };
