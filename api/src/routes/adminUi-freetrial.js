'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Require an authenticated admin for all routes here. Exempt /login and /logout:
// this router is mounted at /admin ahead of the login router (adminUi.js), so an
// unexempted guard would redirect /admin/login to itself (infinite loop).
router.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (!req.admin) return res.redirect('/admin/login');
  next();
});

function render(res, view, locals) {
  const settings = db.prepare('SELECT key,value FROM settings').all();
  res.render('admin/' + view, Object.assign({ settings, admin: res.locals.admin, flash: res.locals.flash || [], csrfToken: res.locals.csrfToken }, locals));
}
function audit(adminId, action, details, ip) {
  db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (?,?,?,?,?)").run(adminId, action, details, ip, Math.floor(Date.now()/1000));
}
function campaignStats(id) {
  const now = Math.floor(Date.now()/1000);
  return {
    total:    db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=?').get(id).n,
    today:    db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND claimed_at>=?').get(id, now-86400).n,
    week:     db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND claimed_at>=?').get(id, now-604800).n,
    devices:  db.prepare('SELECT COUNT(DISTINCT mac_address) n FROM free_trial_claims WHERE campaign_id=?').get(id).n,
    sms_sent: db.prepare("SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND sms_status='sent'").get(id).n,
  };
}
const DEFAULT_SEC  = '{"otp_required":false,"duplicate_mac":true,"duplicate_ip":true,"duplicate_phone":true,"rate_limit":true,"vpn_block":false,"fraud_rules":false}';
const DEFAULT_CP   = '{"header_text":"Get Your Free Trial","loading_msg":"Generating your voucher…","claim_btn":"Claim Free WiFi","phone_prefill":false,"sms_consent":true,"success_msg":"Your voucher has been sent via SMS!","ad_type":"none","ad_content":"","ad_slot":""}';
const DEFAULT_TRIG = '["new_guest","no_session"]';

// GET /admin/free-trial
router.get('/free-trial', (req, res) => {
  const campaigns = db.prepare('SELECT * FROM free_trial_campaigns ORDER BY priority ASC, id DESC').all();
  const now       = Math.floor(Date.now()/1000);
  const overview  = {
    total:   db.prepare('SELECT COUNT(*) n FROM free_trial_claims').get().n,
    today:   db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE claimed_at>=?').get(now-86400).n,
    devices: db.prepare('SELECT COUNT(DISTINCT mac_address) n FROM free_trial_claims').get().n,
    week:    db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE claimed_at>=?').get(now-604800).n,
  };
  const plans = db.prepare('SELECT id,name FROM voucher_plans ORDER BY name').all();
  render(res, 'free-trial', {
    title: 'Free Trial', active: 'free-trial',
    campaigns: campaigns.map(c => ({ ...c, stats: campaignStats(c.id), triggers: JSON.parse(c.triggers||'[]') })),
    overview, plans
  });
});

// GET /admin/free-trial/new
router.get('/free-trial/new', (req, res) => {
  const plans = db.prepare('SELECT id,name,duration_minutes,bandwidth_kbps,is_active FROM voucher_plans ORDER BY name').all();
  render(res, 'free-trial-edit', {
    title: 'New Campaign', active: 'free-trial', isNew: true, plans,
    campaign: {
      id:null, name:'', description:'', status:'disabled', priority:0,
      start_datetime:null, end_datetime:null, daily_start:null, daily_end:null,
      max_claims_day:0, max_claims_user:1, max_claims_device:1, max_claims_ip:3, cooldown_minutes:1440, portal_claimable:1,
      plan_id:null, duration_minutes:120, speed_down_mbps:10, speed_up_mbps:5,
      expiry_minutes:240, voucher_prefix:'FT', generation_delay_sec:0,
      sms_enabled:1, sms_template:'Your PAYWIFI free trial voucher: {{code}}. Valid for {{duration}} at {{speed}}. One-time use.',
      triggers:DEFAULT_TRIG,
      alert_title:'Welcome! Get Free WiFi', alert_message:'Claim your free trial and experience high-speed WiFi.',
      alert_cta:'Claim Free Trial', alert_delay_sec:0, alert_dismiss_sec:0,
      claim_page_config:DEFAULT_CP, security_config:DEFAULT_SEC
    }, stats:null, claims:[]
  });
});

// GET /admin/free-trial/:id/edit
router.get('/free-trial/:id/edit', (req, res) => {
  const campaign = db.prepare('SELECT * FROM free_trial_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.redirect('/admin/free-trial');
  const plans  = db.prepare('SELECT id,name,duration_minutes,bandwidth_kbps,is_active FROM voucher_plans ORDER BY name').all();
  const claims = db.prepare('SELECT ftc.*, v.code FROM free_trial_claims ftc LEFT JOIN vouchers v ON v.id=ftc.voucher_id WHERE ftc.campaign_id=? ORDER BY ftc.claimed_at DESC LIMIT 100').all(campaign.id);
  render(res, 'free-trial-edit', { title:'Edit: '+campaign.name, active:'free-trial', isNew:false, campaign, plans, stats:campaignStats(campaign.id), claims });
});

// POST /admin/free-trial (create)
router.post('/free-trial', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const b   = req.body;
  if (!b || b._action === 'reset_today') {
    const result = db.prepare('DELETE FROM free_trial_claims WHERE claimed_at>=?').run(now-86400);
    audit(req.admin.id,'ft_reset_today',result.changes+' deleted',req.clientIp);
    return res.redirect('/admin/free-trial');
  }
  const id = db.prepare(`INSERT INTO free_trial_campaigns
    (name,description,status,priority,start_datetime,end_datetime,daily_start,daily_end,
     max_claims_day,max_claims_user,max_claims_device,max_claims_ip,cooldown_minutes,
     plan_id,duration_minutes,speed_down_mbps,speed_up_mbps,expiry_minutes,voucher_prefix,generation_delay_sec,
     sms_enabled,sms_template,triggers,alert_title,alert_message,alert_cta,alert_delay_sec,alert_dismiss_sec,
     claim_page_config,security_config,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name||'New Campaign', b.description||'', b.status||'disabled', parseInt(b.priority||0),
    b.start_datetime||null, b.end_datetime||null, b.daily_start||null, b.daily_end||null,
    parseInt(b.max_claims_day||0), parseInt(b.max_claims_user||1), parseInt(b.max_claims_device||1), parseInt(b.max_claims_ip||3), parseInt(b.cooldown_minutes||1440),
    b.plan_id||null, parseInt(b.duration_minutes||120), parseInt(b.speed_down_mbps||10), parseInt(b.speed_up_mbps||5),
    parseInt(b.expiry_minutes||240), b.voucher_prefix||'FT', parseInt(b.generation_delay_sec||0),
    b.sms_enabled==='1'?1:0, b.sms_template||'{{code}}',
    JSON.stringify((Array.isArray(b.triggers)?b.triggers:(b.triggers?[b.triggers]:[])).filter(Boolean)),
    b.alert_title||'', b.alert_message||'', b.alert_cta||'Claim Free Trial', parseInt(b.alert_delay_sec||0), parseInt(b.alert_dismiss_sec||0),
    buildCP(b), buildSec(b), now, now
  ).lastInsertRowid;
  db.prepare('UPDATE free_trial_campaigns SET portal_claimable=? WHERE id=?').run(b.portal_claimable==='1'?1:0, id);
  db.prepare('UPDATE free_trial_campaigns SET trust_eligible=? WHERE id=?').run(b.trust_eligible==='1'?1:0, id);
  audit(req.admin.id,'ft_campaign_create','id='+id,req.clientIp);
  res.redirect('/admin/free-trial/'+id+'/edit');
});

// POST /admin/free-trial/:id (update/delete/toggle/duplicate)
router.post('/free-trial/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const now = Math.floor(Date.now()/1000);
  const b   = req.body;
  if (!db.prepare('SELECT id FROM free_trial_campaigns WHERE id=?').get(id)) return res.redirect('/admin/free-trial');

  if (b._action === 'delete') {
    db.prepare('DELETE FROM free_trial_claims WHERE campaign_id=?').run(id); // must delete child records first (FK enforcement)
    db.prepare('DELETE FROM free_trial_campaigns WHERE id=?').run(id);
    audit(req.admin.id,'ft_campaign_delete','id='+id,req.clientIp);
    return res.redirect('/admin/free-trial');
  }
  if (b._action === 'toggle') {
    const cur = db.prepare('SELECT status FROM free_trial_campaigns WHERE id=?').get(id);
    const ns  = cur.status==='enabled'?'disabled':'enabled';
    db.prepare('UPDATE free_trial_campaigns SET status=?,updated_at=? WHERE id=?').run(ns,now,id);
    audit(req.admin.id,'ft_campaign_toggle','id='+id+' '+ns,req.clientIp);
    return res.redirect('/admin/free-trial');
  }
  if (b._action === 'duplicate') {
    const s = db.prepare('SELECT * FROM free_trial_campaigns WHERE id=?').get(id);
    const nid = db.prepare(`INSERT INTO free_trial_campaigns
      (name,description,status,priority,start_datetime,end_datetime,daily_start,daily_end,
       max_claims_day,max_claims_user,max_claims_device,max_claims_ip,cooldown_minutes,
       plan_id,duration_minutes,speed_down_mbps,speed_up_mbps,expiry_minutes,voucher_prefix,generation_delay_sec,
       sms_enabled,sms_template,triggers,alert_title,alert_message,alert_cta,alert_delay_sec,alert_dismiss_sec,
       claim_page_config,security_config,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'Copy of '+s.name,s.description,'disabled',s.priority,s.start_datetime,s.end_datetime,s.daily_start,s.daily_end,
      s.max_claims_day,s.max_claims_user,s.max_claims_device,s.max_claims_ip,s.cooldown_minutes,
      s.plan_id,s.duration_minutes,s.speed_down_mbps,s.speed_up_mbps,s.expiry_minutes,s.voucher_prefix,s.generation_delay_sec,
      s.sms_enabled,s.sms_template,s.triggers,s.alert_title,s.alert_message,s.alert_cta,s.alert_delay_sec,s.alert_dismiss_sec,
      s.claim_page_config,s.security_config,now,now
    ).lastInsertRowid;
    db.prepare('UPDATE free_trial_campaigns SET portal_claimable=? WHERE id=?').run(s.portal_claimable, nid);
    audit(req.admin.id,'ft_campaign_duplicate','src='+id+' new='+nid,req.clientIp);
    return res.redirect('/admin/free-trial/'+nid+'/edit');
  }
  if (b._action === 'reset_claims') {
    const r = db.prepare('DELETE FROM free_trial_claims WHERE campaign_id=?').run(id);
    audit(req.admin.id,'ft_campaign_reset_claims','id='+id+' deleted='+r.changes,req.clientIp);
    return res.redirect('/admin/free-trial/'+id+'/edit');
  }
  // Normal save
  const triggers = JSON.stringify((Array.isArray(b.triggers)?b.triggers:(b.triggers?[b.triggers]:[])).filter(Boolean));
  db.prepare(`UPDATE free_trial_campaigns SET
    name=?,description=?,status=?,priority=?,start_datetime=?,end_datetime=?,daily_start=?,daily_end=?,
    max_claims_day=?,max_claims_user=?,max_claims_device=?,max_claims_ip=?,cooldown_minutes=?,
    plan_id=?,duration_minutes=?,speed_down_mbps=?,speed_up_mbps=?,expiry_minutes=?,voucher_prefix=?,generation_delay_sec=?,
    sms_enabled=?,sms_template=?,triggers=?,
    alert_title=?,alert_message=?,alert_cta=?,alert_delay_sec=?,alert_dismiss_sec=?,
    claim_page_config=?,security_config=?,updated_at=? WHERE id=?`).run(
    b.name||'Campaign', b.description||'', b.status||'disabled', parseInt(b.priority||0),
    b.start_datetime||null, b.end_datetime||null, b.daily_start||null, b.daily_end||null,
    parseInt(b.max_claims_day||0), parseInt(b.max_claims_user||1), parseInt(b.max_claims_device||1), parseInt(b.max_claims_ip||3), parseInt(b.cooldown_minutes||1440),
    b.plan_id||null, parseInt(b.duration_minutes||120), parseInt(b.speed_down_mbps||10), parseInt(b.speed_up_mbps||5),
    parseInt(b.expiry_minutes||240), b.voucher_prefix||'FT', parseInt(b.generation_delay_sec||0),
    b.sms_enabled==='1'?1:0, b.sms_template||'{{code}}',
    triggers,
    b.alert_title||'', b.alert_message||'', b.alert_cta||'Claim Free Trial', parseInt(b.alert_delay_sec||0), parseInt(b.alert_dismiss_sec||0),
    buildCP(b), buildSec(b), now, id
  );
  db.prepare('UPDATE free_trial_campaigns SET portal_claimable=? WHERE id=?').run(b.portal_claimable==='1'?1:0, id);
  db.prepare('UPDATE free_trial_campaigns SET trust_eligible=? WHERE id=?').run(b.trust_eligible==='1'?1:0, id);
  audit(req.admin.id,'ft_campaign_update','id='+id,req.clientIp);
  res.redirect('/admin/free-trial/'+id+'/edit');
});

// POST /admin/free-trial/reset-all
router.post('/free-trial/reset-all', (req, res) => {
  const r = db.prepare('DELETE FROM free_trial_claims').run();
  audit(req.admin.id,'ft_reset_all',r.changes+' deleted',req.clientIp);
  res.redirect('/admin/free-trial');
});

// POST /admin/free-trial/reset-today (legacy compat)
router.post('/free-trial/reset-today', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const r = db.prepare('DELETE FROM free_trial_claims WHERE claimed_at>=?').run(now-86400);
  audit(req.admin.id,'ft_reset_today',r.changes+' deleted',req.clientIp);
  res.redirect('/admin/free-trial');
});

function buildCP(b) {
  return JSON.stringify({
    header_text: b.cp_header||'Get Your Free Trial',
    loading_msg: b.cp_loading||'Generating your voucher…',
    claim_btn:   b.cp_claim_btn||'Claim Free WiFi',
    phone_prefill: b.cp_phone_prefill==='1',
    sms_consent:   b.cp_sms_consent!=='0',
    success_msg:   b.cp_success||'Your voucher has been sent via SMS!',
    ad_type:    b.cp_ad_type||'none',
    ad_content: b.cp_ad_content||'',
    ad_slot:    b.cp_ad_slot||''
  });
}
function buildSec(b) {
  return JSON.stringify({
    otp_required:    b.sec_otp==='1',
    duplicate_mac:   b.sec_mac!=='0',
    duplicate_ip:    b.sec_ip!=='0',
    duplicate_phone: b.sec_phone!=='0',
    rate_limit:      b.sec_rl!=='0',
    vpn_block:       b.sec_vpn==='1',
    fraud_rules:     b.sec_fraud==='1'
  });
}

module.exports = router;
