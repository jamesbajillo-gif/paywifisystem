'use strict';
// ── SMS send rate limiter + usage log ─────────────────────────────────────────
// Protects against number-spamming (random/incorrect numbers) and Semaphore
// credit drain. All thresholds live in the settings table (admin-configurable).
const db = require('../db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS sms_send_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT,
    kind       TEXT,
    sent_at    INTEGER NOT NULL,
    ok         INTEGER NOT NULL DEFAULT 0,
    message_id TEXT,
    error      TEXT
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_send_log(phone)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_sms_sent  ON sms_send_log(sent_at)`).run();

const _DEFS = { sms_rl_enabled: 1, sms_rl_phone_window_min: 60, sms_rl_phone_max: 8, sms_rl_global_daily_max: 2000 };
const _n0 = Math.floor(Date.now()/1000);
const _ins = db.prepare(`INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,?)`);
for (const [k,v] of Object.entries(_DEFS)) _ins.run(k, String(v), _n0);

function _g(key, def){ const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key); const n=r?parseInt(r.value,10):NaN; return isNaN(n)?def:n; }
function getSmsCfg(){
  return {
    enabled:          _g('sms_rl_enabled', _DEFS.sms_rl_enabled) ? 1 : 0,
    phone_window_min: Math.max(1, _g('sms_rl_phone_window_min', _DEFS.sms_rl_phone_window_min)),
    phone_max:        Math.max(1, _g('sms_rl_phone_max',        _DEFS.sms_rl_phone_max)),
    global_daily_max: Math.max(1, _g('sms_rl_global_daily_max', _DEFS.sms_rl_global_daily_max)),
  };
}
function saveSmsCfg(v){
  const ts=Math.floor(Date.now()/1000);
  const up=db.prepare(`INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)`);
  const cl=(x,lo,hi,d)=>{const n=parseInt(x,10);return isNaN(n)?d:Math.min(hi,Math.max(lo,n));};
  if(v.sms_rl_enabled!==undefined)          up.run('sms_rl_enabled', v.sms_rl_enabled?'1':'0', ts);
  if(v.sms_rl_phone_window_min!==undefined) up.run('sms_rl_phone_window_min', String(cl(v.sms_rl_phone_window_min,1,1440,_DEFS.sms_rl_phone_window_min)), ts);
  if(v.sms_rl_phone_max!==undefined)        up.run('sms_rl_phone_max',        String(cl(v.sms_rl_phone_max,1,100,_DEFS.sms_rl_phone_max)), ts);
  if(v.sms_rl_global_daily_max!==undefined) up.run('sms_rl_global_daily_max',  String(cl(v.sms_rl_global_daily_max,1,100000,_DEFS.sms_rl_global_daily_max)), ts);
}

// returns {ok:true} or {ok:false, reason, retry_after}
function smsAllowed(phone, kind){
  const cfg=getSmsCfg();
  if(!cfg.enabled) return {ok:true};
  const now=Math.floor(Date.now()/1000);
  const gCount=db.prepare('SELECT COUNT(*) n FROM sms_send_log WHERE sent_at>?').get(now-86400).n;
  if(gCount>=cfg.global_daily_max) return {ok:false, reason:'global_daily', retry_after:3600};
  if(phone){
    const winStart=now - cfg.phone_window_min*60;
    const rows=db.prepare('SELECT sent_at FROM sms_send_log WHERE phone=? AND sent_at>? ORDER BY sent_at ASC').all(phone, winStart);
    if(rows.length>=cfg.phone_max){
      const unlock=rows[rows.length-cfg.phone_max].sent_at + cfg.phone_window_min*60;
      if(unlock>now) return {ok:false, reason:'phone_window', retry_after:unlock-now};
    }
  }
  return {ok:true};
}
function smsRecord(phone, kind, ok, message_id, error){
  try{ db.prepare('INSERT INTO sms_send_log (phone,kind,sent_at,ok,message_id,error) VALUES (?,?,?,?,?,?)')
    .run(phone||null, kind||'generic', Math.floor(Date.now()/1000), ok?1:0, message_id||null, error?String(error).slice(0,200):null); }catch(e){}
}
function smsUsage(){
  const now=Math.floor(Date.now()/1000);
  const since=(s)=>{const r=db.prepare('SELECT COUNT(*) n, COALESCE(SUM(ok),0) ok FROM sms_send_log WHERE sent_at>?').get(now-s);return {total:r.n, ok:r.ok};};
  const topPhones=db.prepare(`SELECT phone, COUNT(*) n, MAX(sent_at) last FROM sms_send_log WHERE sent_at>? AND phone IS NOT NULL GROUP BY phone ORDER BY n DESC LIMIT 10`).all(now-86400);
  const byKind=db.prepare(`SELECT COALESCE(kind,'generic') kind, COUNT(*) n, COALESCE(SUM(ok),0) ok FROM sms_send_log WHERE sent_at>? GROUP BY kind ORDER BY n DESC`).all(now-86400);
  return { hour:since(3600), day:since(86400), week:since(604800), topPhones, byKind };
}
module.exports = { getSmsCfg, saveSmsCfg, smsAllowed, smsRecord, smsUsage };
