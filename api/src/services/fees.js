"use strict";
// Payment fee config + computation + settlement parsing.
const db = require("../db");

db.prepare(`
  CREATE TABLE IF NOT EXISTS payment_channel_fees (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_action TEXT UNIQUE NOT NULL,
    fee_percent    REAL NOT NULL DEFAULT 0,
    fee_fixed      REAL NOT NULL DEFAULT 0,
    updated_at     INTEGER
  )
`).run();

// Sensible Xendit-PH DEFAULTS — admin MUST verify against live Xendit pricing.
const _SEED = { qr_code:[1.5,0], gcash:[2.3,0], grabpay:[2.3,0], paymaya:[2.3,0], shopeepay:[2.3,0], va:[0,15], otc:[0,20], credit_card:[3.5,0] };
const _n0 = Math.floor(Date.now()/1000);
const _ins = db.prepare(`INSERT OR IGNORE INTO payment_channel_fees (channel_action,fee_percent,fee_fixed,updated_at) VALUES (?,?,?,?)`);
for (const [k,[p,f]] of Object.entries(_SEED)) _ins.run(k,p,f,_n0);
const _sins = db.prepare(`INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,?)`);
_sins.run("fee_pass_to_customer","0",_n0);
_sins.run("fee_display","1",_n0);

function getFeeCfg(){
  const g=(k,d)=>{const r=db.prepare("SELECT value FROM settings WHERE key=?").get(k);return r?r.value:d;};
  return { pass:g("fee_pass_to_customer","0")==="1", display:g("fee_display","1")==="1" };
}
function saveFeeCfg(v){
  const ts=Math.floor(Date.now()/1000);
  const up=db.prepare(`INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)`);
  if(v.pass!==undefined) up.run("fee_pass_to_customer", v.pass?"1":"0", ts);
  if(v.display!==undefined) up.run("fee_display", v.display?"1":"0", ts);
}
function getChannelFee(action){
  if(!action) return {percent:0,fixed:0};
  const r=db.prepare("SELECT fee_percent,fee_fixed FROM payment_channel_fees WHERE channel_action=?").get(action);
  return r?{percent:Number(r.fee_percent)||0,fixed:Number(r.fee_fixed)||0}:{percent:0,fixed:0};
}
function listFees(){ return db.prepare("SELECT channel_action,fee_percent,fee_fixed,updated_at FROM payment_channel_fees ORDER BY channel_action").all(); }
function saveChannelFee(action,percent,fixed){
  const p=Math.max(0,Math.min(100,Number(percent)||0)), f=Math.max(0,Number(fixed)||0);
  db.prepare(`INSERT INTO payment_channel_fees (channel_action,fee_percent,fee_fixed,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(channel_action) DO UPDATE SET fee_percent=excluded.fee_percent, fee_fixed=excluded.fee_fixed, updated_at=excluded.updated_at`)
    .run(action,p,f,Math.floor(Date.now()/1000));
}
function _r2(x){ return Math.round((Number(x)||0)*100)/100; }
function computeFee(action, base, noGateway){
  base=Number(base)||0;
  const cfg=getFeeCfg();
  if(noGateway || !action){ return {base, fee:0, total:base, net:base, mode:"none", pass:false}; }
  const f=getChannelFee(action);
  let fee=Math.round(base*(f.percent||0) + (f.fixed||0)*100)/100;
  if(fee<0) fee=0;
  if(cfg.pass){ return {base, fee, total:_r2(base+fee), net:base, mode:"pass_on", pass:true}; }
  return {base, fee, total:base, net:_r2(base-fee), mode:"absorbed", pass:false};
}
function parseSettlement(body){
  if(!body||typeof body!=="object") return {fee:null,settlement:null};
  const d=body.data||body;
  let fee=null, settlement=null;
  const cands=[d.fee,d.fees,d.charge_fee,d.payment_detail&&d.payment_detail.fee];
  for(const x of cands){ if(x==null)continue; if(typeof x==="number"){fee=x;break;} if(typeof x==="object"){const v=[x.value,x.xendit_fee,x.amount,x.fee].find(z=>z!=null); if(v!=null){fee=Number(v);break;}} }
  const sc=[d.settlement_amount,d.net_amount,d.amount_after_fee];
  for(const x of sc){ if(x!=null && !isNaN(Number(x))){settlement=Number(x);break;} }
  return {fee:(fee!=null&&!isNaN(fee))?fee:null, settlement:(settlement!=null&&!isNaN(settlement))?settlement:null};
}
module.exports = { getFeeCfg, saveFeeCfg, getChannelFee, listFees, saveChannelFee, computeFee, parseSettlement };
