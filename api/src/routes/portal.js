'use strict';
// PATCHED: M1-INSERT-FIRST-2026-05-30, REMAINING-FIXES-2026-05-30, M1-M2-RETURN-QR-2026-05-30 (insert-first + partial UNIQUE)
const express = require('express');
const router = express.Router();
const crypto  = require('crypto');
function hashPhone(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
const db        = require('../db');
const nurturing = require('../services/nurturing');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) {}

const rl = require('../services/rateLimiter');
const fees = require('../services/fees');
const sessionSvc = require('../services/session');
const fw = require('../services/firewall');
const shape = require('../services/shaping');
const EWALLET_ACTIONS = ['gcash','grabpay','paymaya','shopeepay'];

// HARDEN-2026-05-31-JIT-GCASH — fire-and-forget walled-garden allowlist.
// Resolves wallet hostnames to IPv4 and adds them to paywifi_walled with a
// 15-min nft timeout so unauthenticated clients can reach the wallet
// checkout page during AUTO-REDIRECT navigation.
const _dns = require('dns').promises;
const { execFile: _execFile } = require('child_process');
const _JIT_HOSTS_BY_ACTION = {
  gcash:     ['payments.gcash.com', 'm.gcash.com', 'mb.gcash.com'],
  paymaya:   ['paymaya.com', 'www.paymaya.com', 'pg-pp.paymaya.com'],
  grabpay:   ['pay.grab.com', 'p.grabtaxi.com'],
  shopeepay: ['shopeepay.ph', 'wallet.shopee.ph'],
};
const _JIT_TIMEOUT_SEC = 900; // 15 min, covers GCash session window
function _jitWalledAllowFor(action, checkoutUrl) {
  try {
    const hosts = new Set(_JIT_HOSTS_BY_ACTION[action] || []);
    if (checkoutUrl) {
      try { hosts.add(new URL(checkoutUrl).hostname); } catch (e) {}
    }
    if (!hosts.size) return;
    for (const h of hosts) {
      _dns.resolve4(h).then(ips => {
        for (const ip of ips) {
          _execFile('sudo', ['-n', '/usr/local/sbin/paywifi-auth',
            'walled-add-temp', ip, String(_JIT_TIMEOUT_SEC)],
            { timeout: 4000 },
            (err) => {
              if (err) console.warn('[jit-walled]', h, ip, err.message);
              else    console.log('[jit-walled] +', h, '=>', ip,
                                  `(${_JIT_TIMEOUT_SEC}s)`);
            });
        }
      }).catch(e => console.warn('[jit-walled] dns', h, e.code || e.message));
    }
  } catch (e) { console.warn('[jit-walled] fatal', e.message); }
}


// PH mobile plausibility — rejects all-same-digit and obvious test/sequential numbers (expects 09XXXXXXXXX)
// SMS-PHONE-FIX-2026-06-01 — derive masked phone + whether an SMS has been
// sent in the last hour for that number. Used by /payment/status to surface
// SMS state to the success view.
function _smsInfoFor(buyerPhone639) {
  if (!buyerPhone639) return { masked: null, sent: false };
  // 639XXXXXXXXX -> 09XXXXXXXXX for sms_send_log lookup + masking
  const local = buyerPhone639.startsWith('63') ? ('0' + buyerPhone639.slice(2)) : buyerPhone639;
  let sent = false;
  try {
    const winStart = Math.floor(Date.now()/1000) - 3600;
    sent = !!db.prepare("SELECT 1 FROM sms_send_log WHERE phone=? AND ok=1 AND sent_at>? LIMIT 1").get(local, winStart);
  } catch (e) {}
  // Mask to "0917-XXX-4567" (digits 0-3 + XXX + last 4)
  let masked = local;
  if (/^09\d{9}$/.test(local)) masked = local.slice(0,4) + '-XXX-' + local.slice(7);
  return { masked, sent };
}

function isPlausiblePhone(local09){
  if(!/^09\d{9}$/.test(local09)) return false;
  const sub = local09.slice(2);
  if(/^(\d)\1{8}$/.test(sub)) return false;
  if(sub==='123456789'||sub==='987654321') return false;
  return true;
}

// ── Display helpers (stored at creation time) ────────────────────────────────
const CHANNEL_NAMES = {
  qr_code:     'QR Ph',
  gcash:       'GCash',
  grabpay:     'GrabPay',
  paymaya:     'PayMaya',
  shopeepay:   'ShopeePay',
  otc:         'Over-the-Counter',
  va:          'Virtual Account',
  credit_card: 'Credit Card',
};
const PAYMENT_API_URLS = {
  qr_code:     'POST https://api.xendit.co/payment_requests',
  gcash:       'POST https://api.xendit.co/ewallets/charges',
  grabpay:     'POST https://api.xendit.co/ewallets/charges',
  paymaya:     'POST https://api.xendit.co/payment_requests',
  shopeepay:   'POST https://api.xendit.co/ewallets/charges',
  otc:         'POST https://api.xendit.co/payment_codes',
  va:          'POST https://api.xendit.co/callback_virtual_accounts',
  credit_card: 'POST https://api.xendit.co/payment_requests',
};

function logEvent(ppId, type, source, name, statusBefore, statusAfter, payload, ip, now) {
  try {
    db.prepare(`INSERT INTO payment_events
      (pending_payment_id,event_type,event_source,event_name,status_before,status_after,payload,ip_address,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ppId, type, source, name, statusBefore, statusAfter,
           typeof payload === 'string' ? payload : JSON.stringify(payload), ip || null, now);
  } catch (e) { console.warn('[payment_event log]', e.message); }
}

// ── Default widgets (used when portal_widgets not yet set) ───────────────────
const DEFAULT_WIDGETS = [
  { id:'location',        type:'text',            enabled:true,  order:1, title:'Where to Buy',
    body:'Visit the counter or ask a staff member to purchase a voucher. Vouchers are available in multiple time and speed plans to suit your needs.' },
  { id:'reminder',        type:'text',            enabled:true,  order:2, title:'Reminder',
    body:'Your session starts the moment you enter the voucher code. Time continues to count down whether you are browsing or not. Reconnecting on the same device within your plan\'s validity will resume your session automatically.' },
  { id:'payment_options', type:'payment_options', enabled:true,  order:3, title:'Payment Options' },
  { id:'announcement',    type:'announcement',    enabled:false, order:0, title:'Notice',          body:'',  level:'info' },
  { id:'hours',           type:'hours',           enabled:false, order:4, title:'Business Hours',
    hours:{ mon:'', tue:'', wed:'', thu:'', fri:'', sat:'', sun:'' } },
  { id:'contact',         type:'contact',         enabled:false, order:5, title:'Contact Us',
    phone:'', email:'', facebook:'', instagram:'' },
  { id:'promo',           type:'promo',           enabled:false, order:6, title:'Promotion',       image_url:'', caption:'' },
  { id:'custom_html',     type:'html',            enabled:false, order:7, title:'Custom',          html:'' },
  // PORTAL-WIDGET-2026-06-03 — captive-portal sidebar tiles
  { id:'ads_card',        type:'ads_card',        enabled:true,  order:8, title:'Your Ads Here',    subtitle:'Submit to inquire', contact_email:'ads@example.com' },
  { id:'partner_cta',     type:'partner_cta',     enabled:true,  order:9, title:'Partner with Us',  subtitle:'',                  chip:'',                       rollout:'', contact_number:'', contact_email:'' },
  { id:'youtube',         type:'youtube',         enabled:true,  order:10, title:'Featured Video',  media_id:'auto', playlist_mode:'auto', playlist_ids:[], autoplay:true,  muted:false, loop:true, controls:true, allow_fullscreen:true, volume:1.0, click_to_play:false, skip_button:false, close_button:false, device_rule:'any' },
  { id:'live_news',       type:'live_news',       enabled:true,  order:11, title:'Live News', source_key:'gmanews2026', channel_url:'https://www.youtube.com/@gmanews2026/streams' },
];

// ── Portal config ────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let widgets = DEFAULT_WIDGETS;
  try { if (settings.portal_widgets) widgets = JSON.parse(settings.portal_widgets); } catch (e) {}
  // PORTAL-WIDGET-2026-06-03 — ensure singleton tiles exist; back-fill empty fields from legacy partner_* settings.
  (function ensureSingletonWidgets() {
    const have = new Set(widgets.map(w => w.type));
    if (!have.has('ads_card'))    widgets.push(DEFAULT_WIDGETS.find(w => w.type === 'ads_card'));
    if (!have.has('partner_cta')) widgets.push(DEFAULT_WIDGETS.find(w => w.type === 'partner_cta'));
    if (!have.has('youtube'))     widgets.push(DEFAULT_WIDGETS.find(w => w.type === 'youtube'));
    if (!have.has('live_news'))   widgets.push(DEFAULT_WIDGETS.find(w => w.type === 'live_news'));
    const pcw = widgets.find(w => w.type === 'partner_cta');
    if (pcw) {
      if (!pcw.subtitle)        pcw.subtitle        = settings.partner_cta_text             || '';
      if (!pcw.chip)            pcw.chip            = settings.partner_availability_status  || '';
      if (!pcw.rollout)         pcw.rollout         = settings.partner_rollout_message      || '';
      if (!pcw.contact_number)  pcw.contact_number  = settings.partner_contact_number       || '';
      if (!pcw.contact_email)   pcw.contact_email   = settings.partner_contact_email        || '';
    }
    // YOUTUBE-WIDGET-2026-06-03 — resolve media_id → media row so the portal can
    // render directly from cfg.widgets without a second fetch.
    const ytw = widgets.find(w => w.type === 'youtube');
    if (ytw) {
      // PORTAL-WIDGET-YT-2026-06-03 — modes (auto/single/playlist) + scheduling
      // + per-partner scoping. The resolved media row is injected as ytw.media
      // for the portal to play back without a second fetch.
      let media = null;
      const mode = ytw.playlist_mode || ((ytw.media_id && ytw.media_id !== 'auto') ? 'single' : 'auto');
      const now = Math.floor(Date.now() / 1000);
      // Optional per-partner scope (the captive portal's gateway IP doesn't
      // identify a partner — partner_id widget field future-proofs this for
      // multi-tenant deployments).
      const scopePartnerId = ytw.partner_id ? parseInt(ytw.partner_id, 10) : null;
      const ScopeClause = scopePartnerId
        ? " AND (partner_id IS NULL OR partner_id=" + scopePartnerId + ")"
        : "";
      const ScheduleClause =
        " AND (start_at IS NULL OR start_at<=" + now + ")" +
        " AND (end_at   IS NULL OR end_at  >=" + now + ")";
      const ReadyClause = " AND status='processed' AND visibility=1";
      try {
        if (mode === 'playlist' && Array.isArray(ytw.playlist_ids) && ytw.playlist_ids.length) {
          const ids = ytw.playlist_ids.map(x => parseInt(x, 10)).filter(Boolean);
          if (ids.length) {
            const placeholders = ids.map(() => '?').join(',');
            const candidates = db.prepare(
              "SELECT id, video_id, title, duration_sec, file_path, thumbnail_path, resolution " +
              "FROM media_assets WHERE id IN (" + placeholders + ")" + ReadyClause + ScheduleClause + ScopeClause
            ).all(...ids);
            if (candidates.length) media = candidates[Math.floor(Math.random() * candidates.length)];
          }
        } else if (mode === 'single') {
          const mid = parseInt(ytw.media_id, 10);
          if (mid) media = db.prepare(
            "SELECT id, video_id, title, duration_sec, file_path, thumbnail_path, resolution " +
            "FROM media_assets WHERE id=?" + ReadyClause + ScheduleClause + ScopeClause
          ).get(mid);
        } else {
          // auto — newest eligible
          media = db.prepare(
            "SELECT id, video_id, title, duration_sec, file_path, thumbnail_path, resolution " +
            "FROM media_assets WHERE 1=1" + ReadyClause + ScheduleClause + ScopeClause +
            " ORDER BY id DESC LIMIT 1"
          ).get();
        }
      } catch (e) {}
      ytw.media = media || null;
      ytw.playlist_mode = mode;
    }
    // LIVE-NEWS-2026-06-03 — attach cached stream metadata to the widget.
    const lnw = widgets.find(w => w.type === 'live_news');
    if (lnw) {
      try {
        const sk = lnw.source_key || 'gmanews2026';
        const row = db.prepare(
          "SELECT video_id, original_title, display_title, has_replay, live_status, " +
          "published_at, release_at, thumbnail_url, view_count, duration_sec, channel_name, " +
          "fetched_at, fetch_error FROM live_stream_cache WHERE source_key=?"
        ).get(sk);
        lnw.stream = row || null;
      } catch (e) { lnw.stream = null; }
    }
  })();
  // STORE-WIRE-2026-06-01 — derive partners from active operators
  // (cash payments are routed by partner_id → operator).
  let storePartners = [];
  try {
    // RESTRICTED-DROPDOWN-2026-06-03 — only show partners with status='active' (excludes restricted, suspended, pending, archived)
    storePartners = db.prepare(
      "SELECT id, partner_slug AS slug, partner_name AS name FROM partners WHERE status='active' ORDER BY id ASC"
    ).all();
  } catch (e) {}
  if (!storePartners.length) {
    try { if (settings.partners) storePartners = JSON.parse(settings.partners); } catch (e) {}
  }
  res.json({
    ok: true,
    app: db.cfg.app,
    branding: {
      portal_name:  settings.portal_name  || 'PAYWIFI',
      brand_color:  settings.portal_brand_color || '#0ea5e9',
      terms_url:    settings.portal_terms_url   || '/terms.html',
      domain:       settings.domain_name || ''
    },
    voucher: {
      length: parseInt(settings.voucher_code_length || '8', 10),
      format: settings.voucher_code_format || 'alnum_upper'
    },
    free_trial: {
      enabled: settings.free_trial_enabled !== '0'
    },
    maintenance: {
      enabled:          settings.maintenance_enabled           === '1',
      mode:             settings.maintenance_mode              || 'all',
      title:            settings.maintenance_title             || '',
      message:          settings.maintenance_message           || '',
      note:             settings.maintenance_note              || '',
      enabledAt:        settings.maintenance_enabled_at        || null,
      contact_email:    settings.maintenance_contact_email     || '',
      contact_messenger:settings.maintenance_contact_messenger || '',
    },
    widgets: widgets.filter(w => w.enabled || w.type==='status_bar' || w.type==='available_plans' || w.type==='ads_card' || w.type==='partner_cta' || w.type==='youtube' || w.type==='live_news').sort((a, b) => (a.order||0) - (b.order||0)),
    partners: storePartners,
    partner: {
      contact_number:      settings.partner_contact_number      || '',
      contact_email:       settings.partner_contact_email       || '',
      cta_text:            settings.partner_cta_text             || 'Become a PAYWIFI Partner Store',
      availability_status: settings.partner_availability_status  || 'Coming Soon',
      rollout_message:     settings.partner_rollout_message      || 'Interested in earning by selling WiFi access at your store? Setup is simple and fully managed for you.'
    }
  });
});

// ── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  const plans = db.prepare(`
    SELECT id, name, duration_minutes, bandwidth_kbps, max_devices, price
      FROM voucher_plans WHERE is_active = 1 AND name != 'Free Trial' ORDER BY price ASC
  `).all();
  res.json({
    ok: true,
    plans: plans.map(p => ({
      id: p.id, name: p.name,
      duration_minutes: p.duration_minutes, bandwidth_kbps: p.bandwidth_kbps,
      max_devices: p.max_devices, price: p.price,
      speed: p.bandwidth_kbps >= 1024
        ? (p.bandwidth_kbps / 1024).toFixed(p.bandwidth_kbps % 1024 === 0 ? 0 : 1) + ' Mbps'
        : p.bandwidth_kbps + ' Kbps',
      duration_label:
        p.duration_minutes >= 10080 ? Math.floor(p.duration_minutes/10080) + ' Week'  + (p.duration_minutes >= 20160 ? 's':'') :
        p.duration_minutes >= 1440  ? Math.floor(p.duration_minutes/1440)  + ' Day'   + (p.duration_minutes >= 2880  ? 's':'') :
        p.duration_minutes >= 60    ? Math.floor(p.duration_minutes/60)    + ' Hour'  + (p.duration_minutes >= 120   ? 's':'') :
        p.duration_minutes + ' min'
    }))
  });
});

// ── Payment options ──────────────────────────────────────────────────────────
router.get('/payment-options', (req, res) => {
  const opts = db.prepare(`
    SELECT id, name, icon_key, icon_url, badge, instructions, module_id, module_action, min_amount, max_amount
      FROM payment_options WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC
  `).all();
  // Phase 3: reflect synced Xendit channel availability. If a module-backed option's
  // channel was probed non-active by the last sync, surface it as 'Not Available'
  // (the portal greys it via optIsDisabled). Backward-compatible: if never synced
  // (no channel_statuses entry), the admin-set badge is left untouched.
  const _modCache = {};
  const out = opts.map(o => {
    let badge = o.badge;
    if (o.module_id && o.module_action) {
      if (!(o.module_id in _modCache)) {
        const m = db.prepare('SELECT config_json FROM payment_modules WHERE id=?').get(o.module_id);
        let cfg = {}; try { cfg = JSON.parse((m || {}).config_json || '{}'); } catch (e) {}
        _modCache[o.module_id] = cfg;
      }
      const st = (_modCache[o.module_id].channel_statuses || {})[o.module_action];
      if (st && st !== 'active') badge = 'Not Available';
    }
    const _cf = fees.getChannelFee(o.module_action);
    return { id: o.id, name: o.name, icon_key: o.icon_key, icon_url: o.icon_url, badge, instructions: o.instructions, min_amount: o.min_amount, max_amount: o.max_amount, fee_percent: _cf.percent, fee_fixed: _cf.fixed };
  });
  const _fc = fees.getFeeCfg();
  res.json({ ok: true, options: out, fee_pass: _fc.pass, fee_display: _fc.display });
});

// ── Rate-limit status (portal checks on load) ───────────────────────────────
router.get('/payment/rl-status', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  // If device has an active pending payment, return not-limited so they can resume
  const hasPending = db.prepare(
    `SELECT 1 FROM pending_payments WHERE status IN ('pending','manual') AND expires_at>? AND (client_mac=? OR client_ip=?) LIMIT 1`
  ).get(now, req.clientMac || '', req.clientIp || '');
  const cfg = rl.getRlCfg();
  if (hasPending) return res.json({ ok: true, limited: false, cancel_cooldown: cfg.cooldown, rl_gap_sec: cfg.gap, rl_max_attempts: cfg.max, rl_window_min: cfg.win_min });
  const chk = rl.rlCheck(req.clientMac || null, req.clientIp || '', now);
  res.json({ ok: true, limited: !chk.ok, reason: chk.reason || null, retry_after: chk.retry_after || 0, cancel_cooldown: cfg.cooldown, rl_gap_sec: cfg.gap, rl_max_attempts: cfg.max, rl_window_min: cfg.win_min });
});

// GET /payment/pending — active pending payment for this device (resume UX), or {pending:false}
router.get('/payment/pending', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(
    `SELECT p.*, vp.name AS vp_name, vp.price AS vp_price, vp.bandwidth_kbps AS vp_bw, vp.duration_minutes AS vp_dur
       FROM pending_payments p JOIN voucher_plans vp ON vp.id=p.plan_id
      WHERE p.status IN ('pending','manual') AND p.expires_at>? AND (p.client_mac=? OR p.client_ip=?)
      ORDER BY p.created_at DESC LIMIT 1`
  ).get(now, req.clientMac || '', req.clientIp || '');
  if (!row) return res.json({ ok: true, pending: false });
  const body = JSON.parse(row.gateway_response || '{}');
  const act  = row.module_action || '';
  const type = act === 'qr_code' ? 'qr_code'
    : EWALLET_ACTIONS.includes(act) ? 'ewallet' : 'manual';
  let qrImg = null;
  if (type === 'qr_code' && row.qr_string && QRCode) {
    try { qrImg = await QRCode.toDataURL(row.qr_string, {width:240,margin:2,color:{dark:'#1e293b',light:'#ffffff'}}); } catch(e) {}
  }
  const acts = Array.isArray(body.actions) ? body.actions : [];
  const checkout = type === 'ewallet'
    ? ((acts.find(a => a.url_type === 'WEB' || a.action === 'AUTH') || acts[0] || {}).url || body.actions?.desktop_web_checkout_url || body.checkout_url || null) : null;
  if (type === 'ewallet' && checkout && QRCode) {
    try { qrImg = await QRCode.toDataURL(checkout, {width:240,margin:2,color:{dark:'#1e293b',light:'#ffffff'}}); } catch(e) {}
  }
  const bw = row.vp_bw || 0;
  const speed = bw >= 1024 ? (bw/1024).toFixed(bw%1024===0?0:1)+' Mbps' : bw+' Kbps';
  const dur = row.vp_dur || 0;
  const durLabel = dur>=10080 ? Math.floor(dur/10080)+' Week'+(dur>=20160?'s':'')
    : dur>=1440 ? Math.floor(dur/1440)+' Day'+(dur>=2880?'s':'')
    : dur>=60   ? Math.floor(dur/60)+' Hour'+(dur>=120?'s':'')
    : dur+' min';
  res.json({
    ok: true, pending: true, payment_id: row.id, type,
    amount: row.amount, base_amount: row.base_amount, fee_amount: row.fee_amount, fee_mode: row.fee_mode, qr_image: qrImg, checkout_url: checkout,
    channel_name: row.channel_name, option_id: row.option_id, buyer_phone: row.buyer_phone || null,
    expires_in: row.expires_at - now,
    created_at: row.created_at,
    reference_no: String(row.id).padStart(6, '0').slice(-6),
    reference: row.external_id || ('PW-' + row.id),
    // STORE-RESTORE-FIX-2026-06-01 — surface partner_id so the captive
    // portal can re-bind state.selectedStoreId on refresh / resume.
    partner_id: row.partner_id || null,
    plan: { id: row.plan_id, name: row.vp_name, price: row.vp_price, speed, duration_label: durLabel }
  });
});

// POST /payment/set-phone — attach/update buyer phone on an existing pending payment (for Step-3 entry)
router.post('/payment/set-phone', (req, res) => {
  const id = parseInt((req.body || {}).payment_id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'payment_id required' });
  const row = db.prepare('SELECT id,status,client_ip,client_mac FROM pending_payments WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'We could not find that payment.' });
  const ipOwn  = row.client_ip  && req.clientIp  && row.client_ip  === req.clientIp;
  const macOwn = row.client_mac && req.clientMac && row.client_mac === req.clientMac;
  if (!ipOwn && !macOwn) return res.status(403).json({ ok: false, error: 'This payment is not linked to your device.' });
  // SMS-PHONE-FIX-2026-06-01 — accept all pre-completion statuses (cash
  // 'manual' was silently rejected before) AND handle the late-add SMS
  // case where the user typed the phone after the webhook already paid.
  if (!['reserving','pending','manual','paid'].includes(row.status))
    return res.json({ ok: true, note: 'final state, no change' });
  let phone = String((req.body || {}).phone || '').replace(/\D/g, '');
  if (phone) { if (phone.startsWith('0')) phone = '63' + phone.slice(1); if (!phone.startsWith('63')) phone = '63' + phone; }
  if (phone && !/^639\d{9}$/.test(phone)) return res.json({ ok: false, error: 'Please enter a valid mobile number (e.g. 09171234567).' });
  if (phone && !isPlausiblePhone('0' + phone.slice(2))) return res.json({ ok: false, error: 'Enter a valid mobile number.' });

  const _prevPhone = row.buyer_phone || null;
  db.prepare('UPDATE pending_payments SET buyer_phone=? WHERE id=?').run(phone || null, id);

  // Late SMS: if payment already paid + voucher already issued + no SMS sent
  // to THIS phone for THIS voucher, fire one off now.
  let _smsResult = null;
  if (phone && row.status === 'paid') {
    const pp = db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(id);
    if (pp && pp.voucher_id) {
      const v = db.prepare('SELECT code FROM vouchers WHERE id=?').get(pp.voucher_id);
      if (v && v.code) {
        // Dedup: have we already sent a successful SMS for this phone in the last hour?
        const winStart = Math.floor(Date.now()/1000) - 3600;
        const localPhoneForLog = phone.startsWith('63') ? '0' + phone.slice(2) : phone;
        const sent = db.prepare(
          "SELECT 1 FROM sms_send_log WHERE phone=? AND ok=1 AND sent_at>? LIMIT 1"
        ).get(localPhoneForLog, winStart);
        if (!sent) {
          try {
            const _sem = require('../modules').getModule ? require('../services/semaphore') : require('../services/semaphore');
            const _k = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get()||{}).value||'';
            const _sn = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get()||{}).value||'PAYWIFI';
            _sem.sendSms(_k, _sn, phone,
              'Your PAYWIFI voucher code: ' + v.code + '. Enjoy your WiFi!')
              .then(r => { _smsResult = r; }).catch(() => {});
          } catch (e) { /* swallow */ }
        }
      }
    }
  }
  res.json({ ok: true, phone_saved: !!phone, late_sms_attempted: !!(phone && row.status === 'paid') });
});

// ── Create a payment ─────────────────────────────────────────────────────────
router.post('/payment/create', async (req, res) => {
  const { plan_id, option_id } = req.body || {};
  const clientIp  = req.clientIp  || '';
  const clientMac = req.clientMac || null;
  const now       = Math.floor(Date.now() / 1000);

  // QUEUE-EVERYWHERE-2026-06-01 — M5 (ACTIVE_SESSION refusal) is REMOVED.
  // Users can buy additional plans while connected; the minted voucher is
  // auto-queued (sessionSvc.enqueueVoucherIfActive runs on every mint path)
  // and the queued duration adds onto /session/status.total_seconds for the
  // combined-time display.


  // Optional buyer phone (for "SMS my voucher") — normalize to 639XXXXXXXXX or null
  let buyerPhone = String((req.body || {}).phone || '').replace(/\D/g, '');
  if (buyerPhone) { if (buyerPhone.startsWith('0')) buyerPhone = '63' + buyerPhone.slice(1); if (!buyerPhone.startsWith('63')) buyerPhone = '63' + buyerPhone; }
  buyerPhone = /^639\d{9}$/.test(buyerPhone) ? buyerPhone : null;

  const plan   = db.prepare('SELECT * FROM voucher_plans   WHERE id=? AND is_active=1').get(parseInt(plan_id,   10));
  const option = db.prepare('SELECT * FROM payment_options WHERE id=? AND is_active=1').get(parseInt(option_id, 10));
  if (!plan)   return res.status(404).json({ ok: false, error: 'That plan is not available right now.' });
  if (!option) return res.status(404).json({ ok: false, error: 'That payment method is not available right now.' });

  // Cash payments bypass resume-check and rate limiting — always available
  const isCash = (option.icon_key || '').toLowerCase() === 'cash';

  // Status guard: Not Available / Offline options reject payment attempts server-side
  const badgeLower = (option.badge || '').toLowerCase();
  if (badgeLower === 'not available' || badgeLower === 'offline') {
    return res.status(403).json({ ok: false, error: 'This payment method is currently unavailable.' });
  }

  // STRICT-PENDING-2026-05-31 — pending-payment lock applies to BOTH cash
  // and digital. Status set extended to include 'manual' (cash awaiting
  // operator confirmation). User must finish or cancel the existing
  // payment before starting a new one — regardless of method.
  {
    const existingRow = db.prepare(
    `SELECT p.*, vp.name AS vp_name, vp.price AS vp_price,
            vp.bandwidth_kbps AS vp_bw, vp.duration_minutes AS vp_dur
     FROM pending_payments p JOIN voucher_plans vp ON vp.id=p.plan_id
     WHERE p.status IN ('reserving','pending','manual') AND p.expires_at>?
       AND (p.client_mac=? OR p.client_ip=?)
     ORDER BY p.created_at DESC LIMIT 1`
  ).get(now, clientMac || '', clientIp);
  if (existingRow) {
    // REM-2a (M4) — plan-mismatch refusal. If the user picked a different
    // plan than the one currently pending, do not silently return the old
    // plan's amount. Surface the conflict so the client can offer Resume
    // or Cancel via the existing pending screen.
    if (parseInt(existingRow.plan_id, 10) !== parseInt(plan.id, 10)) {
      return res.status(409).json({
        ok: false, code: 'PLAN_MISMATCH',
        existing: true, payment_id: existingRow.id,
        existing_plan_id: existingRow.plan_id,
        existing_amount: existingRow.amount,
        error: 'You have a pending payment for a different plan. Cancel it before switching plans.'
      });
    }
    // STRICT-PENDING-V2 — block method swap on an active pending payment.
    if (parseInt(existingRow.option_id, 10) !== parseInt(option.id, 10)) {
      return res.status(409).json({
        ok: false, code: 'METHOD_MISMATCH',
        existing: true, payment_id: existingRow.id,
        existing_option_id: existingRow.option_id,
        existing_channel_name: existingRow.channel_name,
        error: `You already have a pending ${existingRow.channel_name || 'payment'}. Cancel it before switching payment methods.`
      });
    }
    const exBody = JSON.parse(existingRow.gateway_response || '{}');
    const exAct  = existingRow.module_action || '';
    const exType = exAct === 'qr_code' ? 'qr_code'
      : EWALLET_ACTIONS.includes(exAct) ? 'ewallet' : 'manual';
    let exQrImg = null;
    if (exType === 'qr_code' && existingRow.qr_string && QRCode) {
      try { exQrImg = await QRCode.toDataURL(existingRow.qr_string,
        {width:240,margin:2,color:{dark:'#1e293b',light:'#ffffff'}}); } catch(e) {}
    }
    const exActs = Array.isArray(exBody.actions) ? exBody.actions : [];
    const exCheckout = exType === 'ewallet'
      ? ((exActs.find(a => a.url_type === 'WEB' || a.action === 'AUTH') || exActs[0] || {}).url || exBody.actions?.desktop_web_checkout_url || exBody.checkout_url || null) : null;
    if (exType === 'ewallet' && exCheckout && QRCode) {
      try { exQrImg = await QRCode.toDataURL(exCheckout,
        {width:240,margin:2,color:{dark:'#1e293b',light:'#ffffff'}}); } catch(e) {}
    }
    const bw = existingRow.vp_bw || 0;
    const exSpeed = bw >= 1024
      ? (bw/1024).toFixed(bw%1024===0?0:1)+' Mbps' : bw+' Kbps';
    const dur = existingRow.vp_dur || 0;
    const exDurLabel = dur>=10080 ? Math.floor(dur/10080)+' Week'+(dur>=20160?'s':'')
      : dur>=1440 ? Math.floor(dur/1440)+' Day'+(dur>=2880?'s':'')
      : dur>=60   ? Math.floor(dur/60)+' Hour'+(dur>=120?'s':'')
      : dur+' min';
    // ALREADY-PENDING-REFUSAL-2026-06-01 — refuse with 409 + ALREADY_PENDING
    // so the frontend's MISMATCH-LOCK routes the user to the existing pending
    // screen instead of treating this as a fresh payment.
    return res.status(409).json({
      ok: false, code: 'ALREADY_PENDING',
      existing: true, payment_id: existingRow.id,
      existing_option_id: existingRow.option_id,
      existing_channel_name: existingRow.channel_name,
      existing_amount: existingRow.amount,
      reference_no: String(existingRow.id).padStart(6, '0').slice(-6),
      error: `You already have a pending ${existingRow.channel_name || 'payment'} for ${existingRow.vp_name}. Tap Continue to finish, or Cancel to start a new one.`,
    });
  }
  }

    // ── Rate limit: only applies to NEW non-cash payment creation ──────────────
  // ── Phase 3: enforce module enabled_actions + synced channel availability ──
  if (!isCash && option.module_id && option.module_action) {
    const _mrow = db.prepare('SELECT config_json FROM payment_modules WHERE id=?').get(option.module_id);
    let _mcfg = {}; try { _mcfg = JSON.parse((_mrow || {}).config_json || '{}'); } catch (e) {}
    const _ea = Array.isArray(_mcfg.enabled_actions) ? _mcfg.enabled_actions : null;
    if (_ea && !_ea.includes(option.module_action)) {
      return res.status(403).json({ ok: false, error: 'This payment method is currently unavailable.' });
    }
    const _st = (_mcfg.channel_statuses || {})[option.module_action];
    if (_st && _st !== 'active') {
      return res.status(403).json({ ok: false, error: 'This payment method is currently unavailable.' });
    }
  }

  // ── Phase 4: per-channel amount availability (e.g. QR Ph >= P50, e-wallets <= P50) ──
  if (!isCash) {
    const _mn = (option.min_amount === null || option.min_amount === undefined) ? null : Number(option.min_amount);
    const _mx = (option.max_amount === null || option.max_amount === undefined) ? null : Number(option.max_amount);
    const _amt = plan.price || 0;
    if ((_mn !== null && _amt < _mn) || (_mx !== null && _amt > _mx)) {
      return res.status(403).json({ ok: false, error: 'This payment method is not available for this plan amount.' });
    }
  }

  // STRICT-PENDING-2026-05-31 — rate limit applies to ALL methods,
  // including cash. 3 attempts / 15-min window (configurable).
  {
    const rlChk = rl.rlCheck(clientMac, clientIp, now);
    if (!rlChk.ok) return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: 'You\'re making payment requests too quickly. Please wait a moment and try again.', reason: rlChk.reason, retry_after: rlChk.retry_after });
    rl.rlRecord(clientMac, clientIp, now);
  }

  const expiresAt = now + 15 * 60;
  const _isNoGw = isCash || !option.module_id || !option.module_action;
  const feeInfo = fees.computeFee(option.module_action, plan.price || 0, _isNoGw);
  const amount  = feeInfo.total;

  // ── Manual payment (no module) ────────────────────────────────────────────
  if (!option.module_id || !option.module_action) {
    const row = db.prepare(`
      INSERT INTO pending_payments
        (plan_id,option_id,client_ip,client_mac,amount,status,
         channel_name,gateway_name,created_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,'manual',?,?,?,?,?)
    `).run(plan.id, option.id, clientIp, clientMac, amount,
           option.name || 'Manual', 'Manual', now, expiresAt, now);
    if (buyerPhone) db.prepare('UPDATE pending_payments SET buyer_phone=? WHERE id=?').run(buyerPhone, row.lastInsertRowid);
    // STORE-WIRE-2026-06-01 — persist the store the customer picked in the
    // captive-portal dropdown. Only operators with this partner_id will see
    // the row on their /partner dashboard.
    const _storeId = parseInt((req.body || {}).partner_id, 10);
  // RESTRICTED-CREATE-2026-06-03 — refuse cash payments routed to restricted partner
  if (_storeId) {
    const _p = db.prepare("SELECT status FROM partners WHERE id=?").get(_storeId);
    if (_p && _p.status !== 'active') {
      return res.status(403).json({
        ok: false, code: 'PARTNER_NOT_ACTIVE',
        error: 'The selected store is currently unavailable. Please choose another store.'
      });
    }
  }
    if (Number.isFinite(_storeId) && _storeId > 0) {
      try { db.prepare('UPDATE pending_payments SET partner_id=? WHERE id=?').run(_storeId, row.lastInsertRowid); } catch (e) {}
    }
    db.prepare('UPDATE pending_payments SET base_amount=?,fee_amount=?,net_amount=?,fee_mode=?,channel_code=? WHERE id=?').run(feeInfo.base, feeInfo.fee, feeInfo.net, feeInfo.mode, option.module_action||null, row.lastInsertRowid);
    logEvent(row.lastInsertRowid, 'created', 'system', 'manual_payment_created',
             null, 'manual', { plan_id: plan.id, amount, partner_id: _storeId || null }, clientIp, now);
    // MULTI-FIX-CASH-2026-06-01 — cash response also needs reference_no.
    return res.json({ ok: true, payment_id: row.lastInsertRowid, type: 'manual', amount, base_amount: feeInfo.base, fee_amount: feeInfo.fee, fee_mode: feeInfo.mode,
      created_at: now,
      channel_name: option.name || null,
      expires_in: expiresAt - now,
      reference_no: String(row.lastInsertRowid).padStart(6, '0').slice(-6),
    });
  }

  // ── Module-backed payment ─────────────────────────────────────────────────
  const modRow = db.prepare('SELECT * FROM payment_modules WHERE id=?').get(option.module_id);
  if (!modRow || !modRow.is_active) {
    const row = db.prepare(`
      INSERT INTO pending_payments
        (plan_id,option_id,client_ip,client_mac,amount,status,
         channel_name,gateway_name,created_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,'manual',?,?,?,?,?)
    `).run(plan.id, option.id, clientIp, clientMac, amount,
           option.name || 'Manual', 'Manual (gateway inactive)', now, expiresAt, now);
    if (buyerPhone) db.prepare('UPDATE pending_payments SET buyer_phone=? WHERE id=?').run(buyerPhone, row.lastInsertRowid);
    db.prepare('UPDATE pending_payments SET base_amount=?,fee_amount=?,net_amount=?,fee_mode=?,channel_code=? WHERE id=?').run(feeInfo.base, feeInfo.fee, feeInfo.net, feeInfo.mode, option.module_action||null, row.lastInsertRowid);
    return res.json({ ok: true, payment_id: row.lastInsertRowid, type: 'manual', amount, base_amount: feeInfo.base, fee_amount: feeInfo.fee, fee_mode: feeInfo.mode,
      created_at: now,
      channel_name: option.name || null,
      expires_in: expiresAt - now,
      reference_no: String(row.lastInsertRowid).padStart(6, '0').slice(-6),
      note: 'Gateway unavailable. Manual fallback.' });
  }

  const moduleRegistry = require('../modules');
  const mod = moduleRegistry.getModule(modRow.slug);
  if (!mod || !mod.adapter) {
    return res.status(503).json({ ok: false, error: 'This payment method is temporarily unavailable. Please choose another.' });
  }

  const extId      = `PW-${now}-${Math.floor(Math.random()*99999).toString().padStart(5,'0')}`;
  const _dnRow  = db.prepare("SELECT value FROM settings WHERE key='domain_name'").get();
  // baseUrl = PUBLIC origin used for the server-to-server webhook callback
  // so Xendit can reach us from the open internet.
  const baseUrl = (_dnRow && _dnRow.value && _dnRow.value.trim())
                  ? _dnRow.value.trim().replace(/\/$/, '')
                  : (db.cfg.api.base_url || `http://${req.headers.host || '10.10.0.1'}`);
  // RETURN-URL-FIX-2026-05-31 — browserBaseUrl is what the USER'S device sees
  // post-redirect. On a captive portal that's the gateway IP, NOT the public
  // domain. Use the request's actual Host header (proxied unchanged by nginx
  // via `proxy_set_header Host $host`). Falls back to the public origin only
  // when we somehow have no Host (e.g. internal cron).
  const _xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const _scheme  = _xfProto || (req.secure ? 'https' : 'http');
  const browserBaseUrl = req.headers.host
    ? `${_scheme}://${req.headers.host}`.replace(/\/$/, '')
    : baseUrl;
  const callbackUrl = `${baseUrl}/api/webhooks/${modRow.slug}`;
  const apiUrl     = PAYMENT_API_URLS[option.module_action] || null;
  const channelName = CHANNEL_NAMES[option.module_action] || option.module_action || option.name;
  const gatewayName = modRow.name || modRow.slug;

  // M1: insert-first. Reserve the pending_payments row BEFORE calling
  // Xendit so the partial UNIQUE INDEX uq_pending_per_device (on client_mac,
  // client_ip WHERE status IN ('reserving','pending')) blocks concurrent
  // requests from creating two Xendit invoices for the same device.
  let reservedRowId;
  try {
    const r = db.prepare(`
      INSERT INTO pending_payments
        (plan_id,option_id,client_ip,client_mac,amount,status,module_slug,module_action,
         external_id,channel_name,gateway_name,webhook_url,payment_api_url,
         created_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,'reserving',?,?,?,?,?,?,?,?,?,?)
    `).run(
      plan.id, option.id, clientIp, clientMac, amount,
      modRow.slug, option.module_action, extId,
      channelName, gatewayName, callbackUrl, apiUrl,
      now, expiresAt, now
    );
    reservedRowId = r.lastInsertRowid;
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      const existing = db.prepare(`
        SELECT * FROM pending_payments
         WHERE status IN ('reserving','pending') AND expires_at>?
           AND (client_mac=? OR client_ip=?)
         ORDER BY created_at DESC LIMIT 1
      `).get(now, clientMac || '', clientIp);
      if (existing) {
        logEvent(existing.id, 'race_resume', modRow.slug, 'duplicate_create_collapsed',
          null, existing.status, { reason: 'unique_index_violation' }, clientIp, now);
        return res.status(429).json({
          ok: false, existing: true, payment_id: existing.id,
          error: 'Another payment is already being processed for this device. Please wait.'
        });
      }
      return res.status(429).json({ ok: false, error: 'Another payment is already being processed for this device.' });
    }
    throw e;
  }

  let payResult;
  try {
    // M1-RETURN-URL-2026-05-30: return_url is for browser redirect after
    // the user finishes paying. callback_url stays as the webhook (S2S).
    // CX-POLISH-2026-05-31 — distinct return URLs per outcome so the
    // frontend can route immediately on cancel without waiting for poll.
    // RETURN-URL-FIX-2026-05-31 — built from browserBaseUrl (captive host),
    // NOT the public domain.
    const returnUrl  = `${browserBaseUrl}/?return=xendit&pid=${reservedRowId}&status=success`;
    const failureUrl = `${browserBaseUrl}/?return=xendit&pid=${reservedRowId}&status=failure`;
    const cancelUrl  = `${browserBaseUrl}/?return=xendit&pid=${reservedRowId}&status=cancel`;
    payResult = await mod.adapter.createPayment(mod.config, option.module_action, {
      external_id: extId, amount, currency: 'PHP',
      callback_url: callbackUrl,
      return_url:           returnUrl,
      success_return_url:   returnUrl,
      failure_return_url:   failureUrl,
      cancel_return_url:    cancelUrl,
      name: 'PAYWIFI',
      metadata: { plan_id: plan.id, client_ip: clientIp }
    });
  } catch (e) {
    console.error('[payment/create] gateway error:', e.message);
    // M1: roll back the reservation so it doesn't block future attempts.
    db.prepare("UPDATE pending_payments SET status='cancelled', updated_at=? WHERE id=?").run(now, reservedRowId);
    return res.status(503).json({ ok: false, error: 'We could not reach the payment service. Please try again.' });
  }

  if ((payResult.status || 0) >= 400) {
    const errBody = payResult.body || {};
    const errCode = String(errBody.error_code || '').toUpperCase();
    let userMsg = 'Payment setup failed. Please try a different option.';
    if (errCode === 'CHANNEL_NOT_ACTIVATED') {
      userMsg = "This payment method isn't activated yet on our account. Please select a different option.";
    } else if (errCode === 'INVALID_API_KEY' || errCode === 'AUTHENTICATION_FAILED') {
      userMsg = 'We are having trouble with payments right now. Please try again later or contact support.';
    } else if (errBody.message) {
      userMsg = 'Payment setup did not go through. Please try a different option.';
    }
    console.warn('[payment/create] gateway rejected:', JSON.stringify(errBody).slice(0, 200));
    // M1: roll back the reservation.
    db.prepare("UPDATE pending_payments SET status='cancelled', updated_at=? WHERE id=?").run(now, reservedRowId);
    return res.status(422).json({ ok: false, error: userMsg, code: errCode });
  }

  // ── Extract response fields ───────────────────────────────────────────────
  const body             = payResult.body || {};
  const gatewayPaymentId = body.id || null;
  const action           = option.module_action;
  let type          = 'redirect';
  let qrImage       = null;
  let qrString      = null;
  let checkoutUrl   = null;
  let paymentCode   = null;
  let vaNumber      = null;

  if (action === 'qr_code') {
    type = 'qr_code';
    qrString = body.payment_method?.qr_code?.channel_properties?.qr_string
            || body.qr_string || body.qrString || null;
    if (QRCode && qrString) {
      try {
        qrImage = await QRCode.toDataURL(qrString, { width: 240, margin: 2,
          color: { dark: '#1e293b', light: '#ffffff' } });
      } catch (e) { console.warn('[qr render]', e.message); }
    }
  } else if (EWALLET_ACTIONS.includes(action)) {
    type = 'ewallet';
    const acts = Array.isArray(body.actions) ? body.actions : [];
    checkoutUrl = (acts.find(a => a.url_type === 'WEB' || a.action === 'AUTH') || acts[0] || {}).url
               || body.actions?.desktop_web_checkout_url
               || body.actions?.mobile_web_checkout_url
               || body.checkout_url || null;
    // M2-QRSTRING-2026-05-30: GCash embeds a proprietary QR string in the
    // checkout URL as ?qrcode=GCSHWPV2<bizNo>,<merchantid>. That value is
    // what GCash's in-app QR scanner is designed to read. Extract it so the
    // client encodes it locally — letting a friend scan with their GCash app.
    if (checkoutUrl && !qrString) {
      try {
        const u = new URL(checkoutUrl);
        const qs = u.hash && u.hash.includes('?') ? u.hash.split('?', 2)[1]
                 : u.search.replace(/^\?/, '');
        const v = new URLSearchParams(qs).get('qrcode');
        if (v) qrString = v;
      } catch (e) { /* malformed URL — fall back to image-only QR */ }
    }
    // Generate an inline QR fallback (data URL) from the qrString (preferred)
    // or checkout URL. Kept for graceful degradation when /qr.js fails to load.
    if (QRCode && (qrString || checkoutUrl)) {
      try {
        qrImage = await QRCode.toDataURL(qrString || checkoutUrl, { width: 240, margin: 2,
          color: { dark: '#1e293b', light: '#ffffff' } });
      } catch (e) { console.warn('[ewallet qr]', e.message); }
    }
    // HARDEN-2026-05-31-JIT-GCASH — open the wallet hostnames in the captive
    // walled garden for 15 min so the AUTO-REDIRECT navigation works
    // pre-auth. Async, never awaited.
    _jitWalledAllowFor(action, checkoutUrl);
  } else if (action === 'otc') {
    type = 'otc';
    paymentCode = body.payment_code || body.barcode || null;
  } else if (action === 'va') {
    type = 'va';
    vaNumber = body.account_number || body.virtual_account_number || null;
  } else {
    checkoutUrl = body.checkout_url || null;
  }

  // ── M1: UPDATE the reserved row with gateway response ────────────────────
  db.prepare(`
    UPDATE pending_payments SET
      status='pending', gateway_payment_id=?, gateway_response=?, qr_string=?, updated_at=?
    WHERE id=?
  `).run(gatewayPaymentId, JSON.stringify(body), qrString, now, reservedRowId);
  if (buyerPhone) db.prepare('UPDATE pending_payments SET buyer_phone=? WHERE id=?').run(buyerPhone, reservedRowId);
  // STORE-WIRE-2026-06-01 — persist partner_id on the reserved row as well so
  // digital flows associate with the store (operator can see digital sales).
  {
    const _sid = parseInt((req.body || {}).partner_id, 10);
    if (Number.isFinite(_sid) && _sid > 0) {
      try { db.prepare('UPDATE pending_payments SET partner_id=? WHERE id=?').run(_sid, reservedRowId); } catch (e) {}
    }
  }
  db.prepare('UPDATE pending_payments SET base_amount=?,fee_amount=?,net_amount=?,fee_mode=?,channel_code=? WHERE id=?').run(feeInfo.base, feeInfo.fee, feeInfo.net, feeInfo.mode, option.module_action||null, reservedRowId);

  // Log creation event
  logEvent(reservedRowId, 'created', modRow.slug, 'payment_created',
    null, 'pending',
    { external_id: extId, gateway_payment_id: gatewayPaymentId, amount,
      api_url: apiUrl, webhook_url: callbackUrl },
    clientIp, now);

  // PENDING-DETAILS-2026-05-31 — created_at + channel_name surfaced so the
  // frontend pending view can display "Generated at" and the method name
  // without a separate /payment/pending round-trip.
  res.json({
    ok: true, payment_id: reservedRowId, type, amount,
    base_amount: feeInfo.base, fee_amount: feeInfo.fee, fee_mode: feeInfo.mode,
    qr_image: qrImage, qr_string: qrString || null,
    checkout_url: checkoutUrl,
    payment_code: paymentCode, va_number: vaNumber,
    expires_in: expiresAt - now,
    created_at: now,
    channel_name: option.name || null,
    // MULTI-FIX-2026-06-01 — 6-digit numeric reference (rolls over after 999,999).
    reference_no: String(reservedRowId).padStart(6, '0').slice(-6),
  });
});

// ── Poll payment status ───────────────────────────────────────────────────────
router.get('/payment/status/:id', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM pending_payments WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });
  // CB-03: ownership check — only the originating client IP can poll this payment
  if (req.clientIp && row.client_ip && req.clientIp !== row.client_ip) {
    return res.status(404).json({ ok: false, error: 'Not found.' });
  }

  const now = Math.floor(Date.now() / 1000);

  if (row.status === 'pending' && now > row.expires_at) {
    db.prepare('UPDATE pending_payments SET status=?,updated_at=? WHERE id=?').run('expired', now, id);
    logEvent(id, 'expired', 'system', 'payment_expired', 'pending', 'expired', null, null, now);
    return res.json({ ok: true, status: 'expired' });
  }

  if (row.status === 'paid' && row.voucher_id) {
    const voucher = db.prepare('SELECT code FROM vouchers WHERE id=?').get(row.voucher_id);
    const _qi = sessionSvc.queueInfoForVoucher(row.voucher_id);
    // SMS-PHONE-FIX-2026-06-01 — surface SMS state to the success view.
    const _sms = _smsInfoFor(row.buyer_phone);
    return res.json({ ok: true, status: 'paid', voucher_code: voucher ? voucher.code : null, queued: _qi.queued, queue_position: _qi.queue_position, buyer_phone: row.buyer_phone || null, masked_phone: _sms.masked, sms_sent: _sms.sent });
  }

  // CB-02: 'processing' means webhook/poll race is in flight — return pending to client
  if (row.status === 'processing') {
    return res.json({ ok: true, status: 'pending' });
  }

  // ── Webhook fallback: poll gateway directly ───────────────────────────────
  if (row.status === 'pending' && row.module_slug && row.external_id) {
    try {
      const moduleRegistry = require('../modules');
      const mod = moduleRegistry.getActiveModule(row.module_slug);
      if (mod && mod.adapter && typeof mod.adapter.checkPaymentStatus === 'function') {
        const result = await mod.adapter.checkPaymentStatus(mod.config, row.external_id);

        // Log the poll result
        logEvent(id, 'api_poll', row.module_slug, 'status_checked',
          'pending', result.paid ? 'paid' : 'pending',
          { external_id: row.external_id, paid: result.paid },
          req.ip, now);

        if (result.paid) {
          const plan = db.prepare('SELECT * FROM voucher_plans WHERE id=?').get(row.plan_id);
          if (plan) {
            const voucherSvc = require('../services/voucher');
            const codeLen = parseInt(
              (db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get() || {}).value || '8', 10
            );
            // CB-02: atomic transaction — prevent double-voucher with concurrent webhook
            const issueTx = db.transaction(() => {
              const claim = db.prepare(
                'UPDATE pending_payments SET status=?,updated_at=? WHERE id=? AND status=?'
              ).run('processing', now, id, 'pending');
              if (claim.changes === 0) return null; // webhook already claimed it
              let code, voucherRow;
              for (let attempt = 0; attempt < 5; attempt++) {
                code = voucherSvc.generateCode(codeLen);
                try {
                  voucherRow = db.prepare(
                    "INSERT INTO vouchers (code,duration_minutes,bandwidth_kbps,max_devices,status,created_at) VALUES (?,?,?,?,'unused',?)"
                  ).run(code, plan.duration_minutes, plan.bandwidth_kbps, plan.max_devices || 1, now);
                  break;
                } catch (e) { if (attempt === 4) throw e; }
              }
              db.prepare('UPDATE pending_payments SET status=?,voucher_id=?,paid_at=?,updated_at=? WHERE id=?')
                .run('paid', voucherRow.lastInsertRowid, now, now, id);
              return code;
            });
            const code = issueTx();
            let _qres = { queued:false, queue_position:0 };
            if (code) {
              try { db.prepare("UPDATE lead_funnel SET converted_at=? WHERE mac_address=? AND converted_at IS NULL").run(now, row.client_mac || ''); } catch (e) {}
              try { const _vid=(db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(id)||{}).voucher_id; if(_vid) _qres=sessionSvc.enqueueVoucherIfActive(row.client_mac, _vid, now); } catch(e){}
              try { if (row.buyer_phone) { const _sem=require('../services/semaphore'); const _k=(db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get()||{}).value||''; const _sn=(db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get()||{}).value||'PAYWIFI'; _sem.sendSms(_k,_sn,row.buyer_phone,'Your PAYWIFI voucher code: '+code+'. Enjoy your WiFi!').catch(()=>{}); } } catch(e){}
              logEvent(id, 'voucher_issued', 'system', 'voucher_generated',
                'paid', 'paid', { voucher_code: code, issued_via: 'api_poll' }, req.ip, now);
              db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
                .run('payment_completed_poll', `ext=${row.external_id} voucher=${code} ip=${row.client_ip}`, req.ip||null, now);
              rl.rlClear(rl.rlKey(row.client_mac, row.client_ip), 'payment');
              console.log(`[payment/status] polled ${row.external_id} → voucher ${code}`);
              { const _sms = _smsInfoFor(row.buyer_phone); return res.json({ ok: true, status: 'paid', voucher_code: code, queued: _qres.queued, queue_position: _qres.queue_position, buyer_phone: row.buyer_phone || null, masked_phone: _sms.masked, sms_sent: _sms.sent }); }
            } else {
              // Webhook beat the poll — re-fetch the now-paid row and return the code
              const paid = db.prepare('SELECT pp.status, v.code FROM pending_payments pp LEFT JOIN vouchers v ON v.id=pp.voucher_id WHERE pp.id=?').get(id);
              if (paid && paid.code) { const _qi2 = sessionSvc.queueInfoForVoucher((db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(id)||{}).voucher_id); const _sms = _smsInfoFor(row.buyer_phone); return res.json({ ok: true, status: 'paid', voucher_code: paid.code, queued: _qi2.queued, queue_position: _qi2.queue_position, buyer_phone: row.buyer_phone || null, masked_phone: _sms.masked, sms_sent: _sms.sent }); }
              return res.json({ ok: true, status: 'pending' }); // processing, not yet committed
            }
          }
        }
      }
    } catch (e) {
      console.warn('[payment/status] gateway poll error:', e.message);
    }
  }

  res.json({ ok: true, status: row.status });
});

// ── Cancel a pending payment ──────────────────────────────────────────────────
router.post('/payment/cancel', async (req, res) => {
  // STRICT-PENDING-2026-05-31 — accept either `payment_id` (canonical) or
  // `id` (frontend legacy). The dumb-portal historically sent `id`; that
  // caused silent cancel failures because parseInt(undefined,10) = NaN.
  const id  = parseInt(((req.body || {}).payment_id || (req.body || {}).id), 10);
  if (!id) return res.status(400).json({ ok: false, error: 'payment_id required' });
  const row = db.prepare(
    'SELECT id,status,client_ip,client_mac,gateway_payment_id FROM pending_payments WHERE id=?'
  ).get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'We could not find that payment.' });
  // PAY-03: ownership check — only the client that created the payment may cancel it
  const ipOwn  = row.client_ip  && req.clientIp  && row.client_ip  === req.clientIp;
  const macOwn = row.client_mac && req.clientMac && row.client_mac === req.clientMac;
  if (!ipOwn && !macOwn) return res.status(403).json({ ok: false, error: 'This payment is not linked to your device.' });
  // STRICT-PENDING-V2 — cancel any in-flight status, not just 'pending'.
  // Cash payments live at 'manual'; reservation races at 'reserving'.
  if (!['pending','manual','reserving'].includes(row.status))
    return res.json({ ok: true, already: true });
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE pending_payments SET status='cancelled',updated_at=? WHERE id=?").run(now, id);
  logEvent(id,'cancelled','user','payment_cancelled',null,'cancelled',
    {reason:'user_cancelled'}, row.client_ip, now);
  // Cancel on Xendit to avoid leaving orphaned payment requests in their system
  if (row.gateway_payment_id) {
    try {
      const modRow = db.prepare(
        "SELECT config_json AS config FROM payment_modules WHERE slug='xendit' AND is_active=1"
      ).get();
      if (modRow) {
        const xendit = require('../modules/xendit');
        const cfg    = JSON.parse(modRow.config || '{}');
        await xendit.apiRequest(cfg, 'POST', '/payment_requests/' + row.gateway_payment_id + '/cancel');
      }
    } catch (e) { console.warn('[payment/cancel] Xendit cancel failed:', e.message); }
  }
  res.json({ ok: true });
});




// ── Free trial helpers ────────────────────────────────────────────────────────
function getDeviceState(mac, ip, campaignId) {
  const now = Math.floor(Date.now()/1000);
  // FT-04: scope claim checks to this campaign when available
  const cmpSql  = campaignId ? ' AND campaign_id=' + campaignId : '';
  return {
    hasSession:       mac ? !!db.prepare('SELECT 1 FROM sessions WHERE mac_address=? AND ended_at IS NULL LIMIT 1').get(mac) : false,
    hasMacRecord:     mac ? !!db.prepare('SELECT 1 FROM remembered_devices WHERE mac_address=? AND valid_until>? LIMIT 1').get(mac, now) : false,
    hasAccount:       mac ? !!db.prepare('SELECT 1 FROM device_user WHERE mac_address=? LIMIT 1').get(mac) : false,
    hasFtClaim:       mac ? !!db.prepare('SELECT 1 FROM free_trial_claims WHERE mac_address=?' + cmpSql + ' LIMIT 1').get(mac) : false,
    hasRedeemedTrial: mac ? !!db.prepare('SELECT 1 FROM free_trial_claims WHERE mac_address=?' + cmpSql + ' AND redeemed_at IS NOT NULL LIMIT 1').get(mac) : false,
  };
}

function checkTriggers(triggers, state) {
  if (!triggers || !triggers.length) return true; // no triggers = anyone
  return triggers.some(function(t) {
    if (t==='new_guest')      return !state.hasSession && !state.hasMacRecord;
    if (t==='no_session')     return !state.hasSession;
    if (t==='no_mac_record')  return !state.hasMacRecord;
    if (t==='first_visit')    return !state.hasRedeemedTrial; // only locked out after actual redemption
    if (t==='has_account')    return !!state.hasAccount;
    if (t==='no_account')     return !state.hasAccount;
    if (t==='phone_not_used') return !state.hasFtClaim; // CP-02: don't re-offer if device already claimed (phone dedup enforced at claim)
    return true; // unknown = allow
  });
}

function findEligibleCampaign(mac, ip, state) {
  const now = Math.floor(Date.now() / 1000);
  const campaigns = db.prepare("SELECT * FROM free_trial_campaigns WHERE status='enabled' AND portal_claimable=1 ORDER BY priority ASC, id ASC").all();
  for (const c of campaigns) {
    // Date range
    if (c.start_datetime && new Date(c.start_datetime).getTime()/1000 > now) continue;
    if (c.end_datetime   && new Date(c.end_datetime).getTime()/1000   < now) continue;
    // Daily window
    if (c.daily_start && c.daily_end) {
      const hhmm = new Date().toTimeString().slice(0, 5);
      if (hhmm < c.daily_start || hhmm > c.daily_end) continue;
    }
    // Triggers
    let triggers = [];
    try { triggers = JSON.parse(c.triggers || '[]'); } catch(e) {}
    if (!checkTriggers(triggers, state)) continue;
    // Cooldown check per device
    const cd = c.cooldown_minutes * 60;
    if (mac) {
      const cl = db.prepare('SELECT claimed_at FROM free_trial_claims WHERE campaign_id=? AND mac_address=? AND claimed_at>? LIMIT 1').get(c.id, mac, now - cd);
      if (cl) continue;
    } else if (ip) {
      const cl = db.prepare('SELECT claimed_at FROM free_trial_claims WHERE campaign_id=? AND ip_address=? AND claimed_at>? LIMIT 1').get(c.id, ip, now - cd);
      if (cl) continue;
    }
    // Daily cap
    if (c.max_claims_day > 0) {
      const todayCount = db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND claimed_at>=?').get(c.id, now - 86400).n;
      if (todayCount >= c.max_claims_day) continue;
    }
    // FT-01: Lifetime per-device cap
    if (c.max_claims_device > 0 && mac) {
      const devCount = db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND mac_address=?').get(c.id, mac).n;
      if (devCount >= c.max_claims_device) continue;
    }
    // FT-01: Lifetime per-IP cap
    if (c.max_claims_ip > 0 && ip) {
      const ipCount = db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND ip_address=?').get(c.id, ip).n;
      if (ipCount >= c.max_claims_ip) continue;
    }
    return c;
  }
  return null;
}

// ── Free trial status ─────────────────────────────────────────────────────────
router.get('/free-trial/status', (req, res) => {
  const mac = req.clientMac || null;
  const ip  = req.clientIp  || '';
  const now = Math.floor(Date.now() / 1000);
  const state = getDeviceState(mac, ip);
  const campaign = findEligibleCampaign(mac, ip, state);
  if (!campaign) {
    // Check if there's an active cooldown to report
    let retryAfter = 0;
    if (mac) {
      const cl = db.prepare('SELECT campaign_id, claimed_at FROM free_trial_claims WHERE mac_address=? ORDER BY claimed_at DESC LIMIT 1').get(mac);
      if (cl) {
        const c = db.prepare('SELECT cooldown_minutes FROM free_trial_campaigns WHERE id=?').get(cl.campaign_id);
        if (c) retryAfter = Math.max(0, (cl.claimed_at + c.cooldown_minutes * 60) - now);
      }
    }
    return res.json({ claimed: retryAfter > 0, available: false, retry_after: retryAfter });
  }
  let cp = {};
  try { cp = JSON.parse(campaign.claim_page_config || '{}'); } catch(e) {}
  res.json({
    claimed: false, available: true,
    campaign_id:      campaign.id,
    campaign_name:    campaign.name,
    duration:         campaign.duration_minutes,
    speed_down:       campaign.speed_down_mbps,
    cooldown_minutes: campaign.cooldown_minutes,
    claim_page: {
      header_text: cp.header_text || 'Get Your Free Trial',
      loading_msg: cp.loading_msg || 'Generating your voucher…',
      claim_btn:   cp.claim_btn   || 'Claim Free WiFi',
      success_msg: cp.success_msg || 'Your voucher has been sent via SMS!',
    },
  });
});

// ── Free trial claim ─────────────────────────────────────────────────────────
router.post('/free-trial/claim', async (req, res) => {
  const mac = req.clientMac || null;
  const ip  = req.clientIp  || '';
  const now = Math.floor(Date.now() / 1000);
  const { phone } = req.body || {};

  if (!phone) return res.status(400).json({ ok: false, error: 'Phone number is required.' });
  if (!mac)   return res.status(400).json({ ok: false, error: 'Device not detected. Please reconnect and try again.' });
  let normPhone = String(phone).replace(/\s+/g, '');
  if (normPhone.startsWith('+63')) normPhone = '0' + normPhone.slice(3);
  if (!/^09\d{9}$/.test(normPhone)) return res.status(400).json({ ok: false, error: 'Please enter a valid mobile number (e.g. 09171234567).' });
  normPhone = '63' + normPhone.slice(1); // Normalize to 63XXXXXXXXX for consistent DB/funnel storage
  if (req.body.consent !== true) return res.status(400).json({ ok: false, error: 'Please accept the Terms & consent to receive your voucher via SMS.' });
  if (!isPlausiblePhone('0' + normPhone.slice(2))) return res.status(400).json({ ok: false, error: 'Enter a valid mobile number.' });

  const state    = getDeviceState(mac, ip);
  const campaign = findEligibleCampaign(mac, ip, state);
  if (!campaign) return res.status(403).json({ ok: false, error: 'Free trial is currently unavailable.' });

  // FT-04: re-scope device state to this specific campaign
  const scopedState = getDeviceState(mac, ip, campaign.id);

  // FT-02: Parse security_config and enforce hard duplicate guards
  let sec = {};
  try { sec = JSON.parse(campaign.security_config || '{}'); } catch(e) {}
  if (sec.duplicate_mac !== false && mac) {
    const prevClaim = db.prepare('SELECT claimed_at FROM free_trial_claims WHERE campaign_id=? AND mac_address=? ORDER BY claimed_at DESC LIMIT 1').get(campaign.id, mac);
    if (prevClaim) {
      const retryAfter = Math.max(0, (prevClaim.claimed_at + campaign.cooldown_minutes * 60) - now);
      return res.status(429).json({ ok: false, code: 'FREE_TRIAL_CLAIMED', error: 'You\'ve already used your free trial recently. Please try again later or buy a plan.', retry_after: retryAfter });
    }
  }
  if (sec.duplicate_ip !== false && ip) {
    const ipCount = db.prepare('SELECT COUNT(*) n FROM free_trial_claims WHERE campaign_id=? AND ip_address=?').get(campaign.id, ip).n;
    const ipMax   = campaign.max_claims_ip > 0 ? campaign.max_claims_ip : 3;
    if (ipCount >= ipMax) {
      return res.status(429).json({ ok: false, code: 'FREE_TRIAL_CLAIMED', error: 'You\'ve already used your free trial. Buy a plan to keep connected.', retry_after: 0 });
    }
  }

  // Phone cooldown check
  const phHash = hashPhone(normPhone);
  const phCd   = campaign.cooldown_minutes * 60;
  const rPhone = db.prepare('SELECT claimed_at FROM free_trial_claims WHERE campaign_id=? AND phone_number=? AND claimed_at>? LIMIT 1').get(campaign.id, phHash, now - phCd);
  if (rPhone) return res.status(429).json({ ok: false, code: 'FREE_TRIAL_CLAIMED', error: 'This phone number has already claimed a free trial recently. Please try again later.', retry_after: (rPhone.claimed_at + phCd) - now });

  // Build or use voucher plan from campaign settings
  const bandwidthKbps = campaign.speed_down_mbps * 1024;
  let planId = campaign.plan_id || null;
  if (!planId) {
    let plan = db.prepare("SELECT id FROM voucher_plans WHERE name='Free Trial'").get();
    if (!plan) {
      plan = { id: db.prepare("INSERT INTO voucher_plans (name,duration_minutes,bandwidth_kbps,max_devices,price,is_active,created_at) VALUES ('Free Trial',?,?,1,0,1,?)").run(campaign.duration_minutes, bandwidthKbps, now).lastInsertRowid };
    }
    planId = plan.id;
  }
  const plan = db.prepare('SELECT * FROM voucher_plans WHERE id=?').get(planId);
  if (!plan) return res.status(500).json({ ok: false, error: 'That plan is not available right now.' });

  // Generate voucher
  const voucherSvc = require('../services/voucher');
  const codeLen    = parseInt((db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get()||{}).value||'8', 10);
  let code, vRow;
  for (let i = 0; i < 5; i++) {
    code = (campaign.voucher_prefix || 'FT') + voucherSvc.generateCode(Math.max(4, codeLen - (campaign.voucher_prefix||'FT').length));
    try {
      vRow = db.prepare("INSERT INTO vouchers (code,duration_minutes,bandwidth_kbps,max_devices,status,created_at) VALUES (?,?,?,?,'unused',?)")
        .run(code, plan.duration_minutes, plan.bandwidth_kbps, plan.max_devices||1, now);
      break;
    } catch(e) { if (i===4) return res.status(500).json({ ok: false, error: 'Something went wrong creating your voucher. Please try again.' }); }
  }

  // Record claim
  const claimRow = db.prepare('INSERT INTO free_trial_claims (campaign_id,mac_address,ip_address,voucher_id,claimed_at,phone_number,phone_plain,sms_status) VALUES (?,?,?,?,?,?,?,?)')
    .run(campaign.id, mac||'', ip, vRow.lastInsertRowid, now, phHash, normPhone, 'pending');
  const claimId = claimRow.lastInsertRowid;
  try { const _cv=(db.prepare("SELECT value FROM settings WHERE key='consent_version'").get()||{}).value||'1'; db.prepare('UPDATE free_trial_claims SET consent_version=?, consent_at=?, marketing_opt_in=? WHERE id=?').run(_cv, now, req.body.marketing===true?1:0, claimId); } catch(e){}

  // AU-03: record Stage 1 in lead_funnel for funnel analytics
  try {
    nurturing.upsertLead(normPhone, mac, {
      stage:            'trial_claimed',
      trial_claim_id:   claimId,
      trial_claimed_at: now,
    });
  } catch (e) { console.warn('[free-trial] upsertLead Stage 1:', e.message); }

  // Generation delay (non-blocking — client polls sms-status)
  const sendSms = async () => {
    const apiKey     = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get()||{}).value||'';
    const senderName = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get()||{}).value||'PAYWIFI';
    const tmpl = campaign.sms_template || 'Your PAYWIFI free trial voucher: {{code}}. One-time use.';
    const msg  = tmpl.replace('{{code}}', code)
      .replace('{{duration}}', plan.duration_minutes + 'min')
      .replace('{{speed}}', campaign.speed_down_mbps + 'Mbps')
      .replace('{{expiry}}', campaign.expiry_minutes + 'min');
    const semaphore = require('../services/semaphore');
    const smsResult = await semaphore.sendSms(apiKey, senderName, normPhone, msg, { kind: 'free_trial' });
    if (smsResult.ok) {
      db.prepare("UPDATE free_trial_claims SET sms_status='sent', sms_message_id=? WHERE id=?").run(smsResult.message_id, claimId);
      try { nurturing.ensureLinkedNumber(normPhone, mac, ip); nurturing.setVoucherLifecycle(vRow.lastInsertRowid, 'sms_sent'); } catch (e) {}
    } else {
      // SMS failed (delivery error or rate-limited): invalidate the just-generated
      // voucher and remove the claim so a bad/incorrect number isn't rewarded and the
      // device's one-claim allowance isn't burned. Per-number spam is throttled by the
      // SMS rate limiter; the portal shows a 'try again later' lockout.
      try { db.prepare('DELETE FROM vouchers WHERE id=?').run(vRow.lastInsertRowid); } catch (e) {}
      try { db.prepare('DELETE FROM free_trial_claims WHERE id=?').run(claimId); } catch (e) {}
      try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
              .run('free_trial_sms_failed', `claim=${claimId} code=${code} reason=${String(smsResult.error||'').slice(0,80)}`, ip, Math.floor(Date.now()/1000)); } catch (e) {}
    }
  };
  if (campaign.generation_delay_sec > 0) {
    setTimeout(sendSms, campaign.generation_delay_sec * 1000);
  } else {
    sendSms().catch(e => console.warn('[free-trial] SMS error:', e.message));
  }

  db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)").run('free_trial_claimed', `campaign=${campaign.id} mac=${mac} phone_hash=${phHash.slice(0,12)} code=${code}`, ip, now);
  res.json({ ok: true, claim_id: claimId, generation_delay: campaign.generation_delay_sec || 0 });
});

// ── Poll SMS delivery status ──────────────────────────────────────────────────
router.get('/free-trial/sms-status', (req, res) => {
  const claimId = parseInt(req.query.claim_id, 10);
  if (!claimId) return res.json({ ok: false, error: 'Missing claim_id' });
  const claim = db.prepare('SELECT sms_status, voucher_id, ip_address, mac_address FROM free_trial_claims WHERE id=?').get(claimId);
  if (!claim) return res.json({ ok: true, status: 'failed', code: null }); // voucher+claim were removed after SMS failure
  // CB-04: ownership check — only the originating client can poll this claim
  const ipMatch  = !req.clientIp || !claim.ip_address  || req.clientIp  === claim.ip_address;
  const macMatch = !req.clientMac || !claim.mac_address || req.clientMac === claim.mac_address;
  if (!ipMatch && !macMatch) {
    return res.json({ ok: false, error: 'Not found' });
  }
  // Always return the voucher code regardless of SMS delivery status.
  // If SMS failed, the portal displays the code directly so the user isn't stranded.
  const v    = db.prepare('SELECT code FROM vouchers WHERE id=?').get(claim.voucher_id);
  const code = v ? v.code : null;
  res.json({ ok: true, status: claim.sms_status, code });
});


// ── Portal Users / Alerts / Voucher History ──────────────────────────────────

function normalizePh(p){ return String(p||'').replace(/\D/g,'').replace(/^0/,'63'); }

// GET /api/portal/auth/me
router.get('/auth/me', (req, res) => {
  const mac = req.clientMac;
  if (!mac) return res.json({ user: null, history_count: 0, guest_phone: null });
  // ── Device-detection auto-login (recognition only; never grants rewards) ─────
  const _now = Math.floor(Date.now()/1000);
  const _paidOnly = ((db.prepare("SELECT value FROM settings WHERE key='auto_login_paid_only'").get()||{}).value === '1');
  const _trustedForDevice = (m) => {
    const s = db.prepare('SELECT id, voucher_id FROM sessions WHERE mac_address=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(m);
    if (!s || !s.voucher_id) return null;
    const norm = (p) => { p = String(p||'').replace(/\D/g,''); if (p.startsWith('0')) p = '63'+p.slice(1); if (p && !p.startsWith('63')) p = '63'+p; return p; };
    let cand=null, source=null, ref=null;
    const bp = db.prepare("SELECT id, buyer_phone FROM pending_payments WHERE client_mac=? AND voucher_id=? AND status='paid' AND buyer_phone IS NOT NULL ORDER BY paid_at DESC LIMIT 1").get(m, s.voucher_id);
    if (bp && bp.buyer_phone) { cand=bp.buyer_phone; source='paid_purchase'; ref='pp#'+bp.id; }
    if (!cand && !_paidOnly) {
      const ft = db.prepare("SELECT id, phone_plain, campaign_id FROM free_trial_claims WHERE mac_address=? AND voucher_id=? AND sms_status='sent' AND phone_plain IS NOT NULL ORDER BY claimed_at DESC LIMIT 1").get(m, s.voucher_id);
      if (ft && ft.phone_plain) { let _elig=true; if(ft.campaign_id){const _c=db.prepare('SELECT trust_eligible FROM free_trial_campaigns WHERE id=?').get(ft.campaign_id); if(_c) _elig=(_c.trust_eligible!==0);} if(_elig){ cand=ft.phone_plain; source='free_trial'; ref='ftc#'+ft.id; } }
    }
    if (!cand) return null;
    const ph = norm(cand);
    if (!/^639\d{9}$/.test(ph)) return null;
    let u = db.prepare('SELECT * FROM portal_users WHERE phone=?').get(ph);
    if (!u) { const _r = nurturing.ensureTrustedAccount(ph, m, req.clientIp || '', source, ref, s.voucher_id); if (_r && _r.userId) u = db.prepare('SELECT * FROM portal_users WHERE id=?').get(_r.userId); }
    return u ? { u, ph, source, ref, sess: s } : null;
  };

  let auto_linked = false;
  let user = null;
  const _existing = db.prepare('SELECT user_id, source FROM device_user WHERE mac_address=?').get(mac);
  if (_existing) {
    // Device handoff: only an AUTO link may be re-pointed to the current session owner.
    // Verified OTP/registration links are never re-pointed.
    if (_existing.source === 'auto') {
      const t = _trustedForDevice(mac);
      if (t && t.u.id !== _existing.user_id) {
        db.prepare("UPDATE device_user SET user_id=?, linked_at=?, source='auto' WHERE mac_address=?").run(t.u.id, _now, mac);
        user = t.u; auto_linked = true;
        try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
                .run('auto_login_repoint', `mac=${mac} session=${t.sess.id} voucher=${t.sess.voucher_id} from_user=${_existing.user_id} to_user=${t.u.id} phone=${t.ph} source=${t.source} ${t.ref}`, req.clientIp||null, _now); } catch(e){}
      }
    }
    if (!user) user = db.prepare('SELECT * FROM portal_users WHERE id=?').get(_existing.user_id) || null;
  } else {
    const t = _trustedForDevice(mac);
    if (t) {
      const linkedId = db.transaction(() => {
        const ex = db.prepare('SELECT user_id FROM device_user WHERE mac_address=?').get(mac);
        if (ex) return ex.user_id;
        db.prepare("INSERT INTO device_user(mac_address,user_id,linked_at,source) VALUES(?,?,?,'auto')").run(mac, t.u.id, _now);
        return t.u.id;
      })();
      user = db.prepare('SELECT * FROM portal_users WHERE id=?').get(linkedId) || t.u;
      auto_linked = (linkedId === t.u.id);
      if (auto_linked) {
        try { db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
                .run('auto_login_link', `mac=${mac} session=${t.sess.id} voucher=${t.sess.voucher_id} user=${t.u.id} phone=${t.ph} source=${t.source} ${t.ref}`, req.clientIp||null, _now); } catch(e){}
      }
    }
  }

  const history_count = db.prepare('SELECT COUNT(*) n FROM sessions WHERE mac_address=?').get(mac).n;
  // Guest verified mobile: number from this device's most recent free-trial claim (verified via SMS)
  let guest_phone = null;
  if (!user) {
    const g = db.prepare("SELECT phone_plain FROM free_trial_claims WHERE mac_address=? AND phone_plain IS NOT NULL ORDER BY claimed_at DESC LIMIT 1").get(mac);
    guest_phone = g ? g.phone_plain : null;
  }
  res.json({ user: user || null, history_count, guest_phone, auto_linked });
});

// POST /api/portal/auth/logout
router.post('/auth/logout', (req, res) => {
  const mac = req.clientMac;
  if (mac) db.prepare('DELETE FROM device_user WHERE mac_address=?').run(mac);
  res.json({ ok: true });
});

// GET /api/portal/alerts
router.get('/alerts', (req, res) => {
  const mac = req.clientMac||'';
  const ip  = req.clientIp||'';
  const now = Math.floor(Date.now()/1000);
  const g = k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
  const alerts = [];
  const isRead = k => !!db.prepare('SELECT 1 FROM alert_reads WHERE alert_key=? AND mac_address=?').get(k, mac);
  const hasSess    = !!db.prepare('SELECT 1 FROM sessions WHERE mac_address=? AND ended_at IS NULL LIMIT 1').get(mac);
  const hasDev     = !!db.prepare('SELECT 1 FROM remembered_devices WHERE mac_address=?').get(mac);
  const user       = mac ? db.prepare('SELECT pu.* FROM portal_users pu JOIN device_user du ON du.user_id=pu.id WHERE du.mac_address=?').get(mac) : null;
  const hasFtClaim = mac ? !!db.prepare('SELECT 1 FROM free_trial_claims WHERE mac_address=?').get(mac) : false;
  // Alert 1: Free trial promo — show if no active session (claimed if already used)
  const ftEnabled = (db.prepare("SELECT value FROM settings WHERE key='free_trial_enabled'").get()||{}).value !== '0';  // CP-01
  const p1cfg = db.prepare("SELECT alert_title, alert_body, alert_cta FROM lead_nurturing_config WHERE phase='new_user' AND enabled=1").get();
  const _ftElig = (ftEnabled && !hasSess) ? !!findEligibleCampaign(mac, ip, getDeviceState(mac, ip)) : false;
  if (ftEnabled && p1cfg && !hasSess && _ftElig) {
    alerts.push({ key:'new_guest', type:'promo', icon:'🎉',
      title:        p1cfg.alert_title || 'Welcome to Free WiFi!',
      message:      p1cfg.alert_body  || 'Free WiFi trial.',
      action:'claim_trial', action_label: p1cfg.alert_cta || 'Claim',
      is_read:false, claimed:false, delay:0 });
  }
  // Welcome voucher — claimable only once the number is validated/trusted (trusted-number lifecycle).
  if (user && user.trusted_at) {
    const _lf = db.prepare('SELECT signup_voucher_id FROM lead_funnel WHERE phone=? AND signup_voucher_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(user.phone);
    if (_lf && _lf.signup_voucher_id) {
      const _wv = db.prepare("SELECT status, duration_minutes FROM vouchers WHERE id=?").get(_lf.signup_voucher_id);
      if (_wv && _wv.status === 'unused') {
        const _hrs = Math.max(1, Math.round((_wv.duration_minutes||300)/60));
        alerts.push({ key:'welcome_claim', type:'success', icon:'\uD83C\uDF81',
          title:'Free ' + _hrs + '-Hour Bonus Access',
          message:'Tap claim and we add it to your time automatically.',
          action:'claim_welcome', action_label:'Claim',
          is_read:false, claimed:false, delay:0 });
      }
    }
  }
  // Stage 4 retention: 1-hour boost when a trusted session is almost out of time (smart cooldown)
  if (user && user.trusted_at && hasSess && g('retention_enabled') !== '0') {
    const _s = db.prepare("SELECT voucher_id FROM sessions WHERE mac_address=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(mac);
    const _v = _s ? db.prepare('SELECT expires_at FROM vouchers WHERE id=?').get(_s.voucher_id) : null;
    const _rem = _v ? (_v.expires_at - now) : 1e9;
    const _th = parseInt(g('retention_threshold_min') || '15', 10) * 60;
    if (_rem > 0 && _rem <= _th) {
      const _lf = db.prepare('SELECT last_retention_at FROM lead_funnel WHERE phone=?').get(user.phone) || {};
      const _last = _lf.last_retention_at || 0;
      const _cdH = parseInt(g('retention_cooldown_hours') || '24', 10);
      const _cdS = parseInt(g('retention_cooldown_sessions') || '3', 10);
      const _ss = db.prepare('SELECT COUNT(*) n FROM sessions s JOIN device_user du ON du.mac_address=s.mac_address WHERE du.user_id=? AND s.started_at>?').get(user.id, _last).n;
      const _ok = !_last || (now - _last >= _cdH * 3600) || (_ss >= _cdS);
      if (_ok) alerts.push({ key:'retention_boost', type:'promo', icon:'\u23F1', title:'Stay connected', message:'Stay Connected \u2014 Free 1 Hour', action:'claim_retention', action_label:'Claim', is_read:false, claimed:false, delay:0 });
    }
  }
  res.json({ ok:true, alerts, unread: alerts.filter(a=>!a.is_read).length });
});

// POST /api/portal/alerts/claim-welcome — claim the unused welcome voucher (activate/queue)
router.post('/alerts/claim-welcome', (req, res) => {
  try {
    const r = nurturing.claimWelcomeForDevice(req.clientMac || '', req.clientIp || '');
    return res.json(r);
  } catch (e) { return res.status(500).json({ ok: false, error: 'Could not claim your voucher. Please try again.' }); }
});

// POST /api/portal/alerts/claim-retention — Stage 4 near-expiry 1h boost (smart cooldown)
router.post('/alerts/claim-retention', (req, res) => {
  try {
    const r = nurturing.claimRetentionForDevice(req.clientMac || '', req.clientIp || '');
    return res.json(r);
  } catch (e) { return res.status(500).json({ ok: false, error: 'Could not add your bonus. Please try again.' }); }
});

// POST /api/portal/alerts/read
router.post('/alerts/read', (req, res) => {
  const mac = req.clientMac||'';
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  const now = Math.floor(Date.now()/1000);
  for (const k of keys) db.prepare('INSERT OR IGNORE INTO alert_reads(alert_key,mac_address,read_at) VALUES(?,?,?)').run(k, mac, now);
  res.json({ ok:true });
});

// GET /api/portal/my-vouchers — inbox: active, queued (incl. welcome gift), unredeemed, history (with codes)
router.get('/my-vouchers', (req, res) => {
  const mac = req.clientMac; const now = Math.floor(Date.now()/1000);
  if (!mac) return res.json({ ok:true, active:null, queued:[], unredeemed:[], history:[] });
  const a = db.prepare("SELECT v.code, v.bandwidth_kbps, v.expires_at FROM sessions s JOIN vouchers v ON v.id=s.voucher_id WHERE s.mac_address=? AND s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1").get(mac);
  const active = a ? { code:a.code, remaining_seconds:Math.max(0,(a.expires_at||0)-now), bandwidth_kbps:a.bandwidth_kbps } : null;
  const queued = db.prepare("SELECT vq.queue_position, v.code, v.duration_minutes, v.bandwidth_kbps FROM voucher_queue vq JOIN vouchers v ON v.id=vq.voucher_id WHERE vq.mac_address=? AND vq.status='waiting' ORDER BY vq.queue_position ASC").all(mac)
    .map(function(q){ return { code:q.code, duration_minutes:q.duration_minutes, bandwidth_kbps:q.bandwidth_kbps, position:q.queue_position+1 }; });
  const unredeemed = db.prepare("SELECT v.code, v.duration_minutes, v.bandwidth_kbps FROM free_trial_claims ftc JOIN vouchers v ON v.id=ftc.voucher_id WHERE ftc.mac_address=? AND v.status='unused' ORDER BY ftc.claimed_at DESC LIMIT 10").all(mac);
  const history = db.prepare("SELECT v.code, v.duration_minutes, s.started_at, s.ended_at, s.bytes_in, s.bytes_out FROM sessions s JOIN vouchers v ON v.id=s.voucher_id WHERE s.mac_address=? AND s.ended_at IS NOT NULL ORDER BY s.started_at DESC LIMIT 20").all(mac);
  res.json({ ok:true, active, queued, unredeemed, history });
});

// GET /api/portal/voucher-history
router.get('/voucher-history', (req, res) => {
  const mac = req.clientMac;
  if (!mac) return res.json({ ok:true, history:[] });
  // CB-05: v.plan_id and vp.duration_label don't exist in schema
  // Derive label from voucher's own duration_minutes; no plan JOIN needed
  const history = db.prepare(`
    SELECT v.code,
           v.duration_minutes,
           v.bandwidth_kbps,
           CASE
             WHEN v.duration_minutes >= 1440 THEN (v.duration_minutes/1440) || ' day(s)'
             WHEN v.duration_minutes >= 60   THEN (v.duration_minutes/60)   || ' hr(s)'
             ELSE v.duration_minutes || ' min'
           END AS duration_label,
           s.started_at, s.ended_at, s.bytes_in, s.bytes_out, s.end_reason
    FROM sessions s
    JOIN vouchers v ON v.id = s.voucher_id
    WHERE s.mac_address = ?
    ORDER BY s.started_at DESC LIMIT 30
  `).all(mac);
  res.json({ ok:true, history });
});

// POST /session/restore — portal-first reconnect: re-open the firewall for this
// device's EXISTING session (or start a remembered-device session) so the captive
// portal acts as the session-restoration layer. Safe/idempotent.
router.post('/session/restore', (req, res) => {
  const t = Math.floor(Date.now() / 1000);
  const mac = req.clientMac, ip = req.clientIp;
  if (!ip) return res.json({ ok: false, error: 'Device not detected.' });

  // 1) Active session for this device — re-authorize (migrate IP if it changed)
  let sess = (mac ? sessionSvc.findActiveByMac(mac) : null) || sessionSvc.findActiveByIp(ip);
  if (sess) {
    const remaining = Math.max(60, (sess.expires_at || 0) - t);
    if (sess.ip_address && sess.ip_address !== ip) {
      try { fw.revoke(sess.ip_address); } catch (e) {}
      try { shape.del(sess.ip_address); } catch (e) {}
      try { db.prepare('UPDATE sessions SET ip_address=?, last_seen_at=? WHERE id=?').run(ip, t, sess.id); } catch (e) {}
    }
    try { fw.authorize(ip, remaining); } catch (e) {}
    if (sess.bandwidth_kbps) { try { shape.add(ip, sess.bandwidth_kbps); } catch (e) {} }
    return res.json({ ok: true, state: 'active', remaining_seconds: remaining });
  }

  // 2) Remembered device with a still-valid active voucher — start its session
  if (mac) {
    const rd = db.prepare(`
      SELECT rd.voucher_id, v.status AS v_status, v.expires_at, v.bandwidth_kbps, v.max_devices
        FROM remembered_devices rd JOIN vouchers v ON v.id = rd.voucher_id
       WHERE rd.mac_address = ? AND rd.valid_until > ?`).get(mac, t);
    if (rd && rd.v_status === 'active' && rd.expires_at && rd.expires_at > t) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE voucher_id=? AND ended_at IS NULL').get(rd.voucher_id).n;
      if (used < rd.max_devices) {
        try {
          sessionSvc.startSession({ voucherId: rd.voucher_id, mac, ip, expiresAt: rd.expires_at, bandwidthKbps: rd.bandwidth_kbps, nowSec: t });
          return res.json({ ok: true, state: 'active', remaining_seconds: Math.max(60, rd.expires_at - t) });
        } catch (e) { return res.json({ ok: false, error: 'Could not restore session.' }); }
      }
    }
  }

  // 3) Queued voucher waiting — activate the next one (portal-first reconnect)
  if (mac) {
    const entry = sessionSvc.getNextQueueEntry(mac);
    if (entry) {
      const expiresAt = t + entry.duration_minutes * 60;
      try {
        const tx = db.transaction(() => {
          db.prepare("UPDATE vouchers SET status='active', first_used_at=?, expires_at=?, lifecycle_state='active' WHERE id=?").run(t, expiresAt, entry.voucher_id);
          db.prepare("UPDATE voucher_queue SET status='active', activated_at=? WHERE id=?").run(t, entry.id);
          db.prepare('INSERT INTO sessions (voucher_id, mac_address, ip_address, started_at, last_seen_at) VALUES (?,?,?,?,?)').run(entry.voucher_id, mac, ip, t, t);
        });
        tx();
        try { fw.authorize(ip, expiresAt - t); } catch (e) {}
        if (entry.bandwidth_kbps > 0) { try { shape.add(ip, entry.bandwidth_kbps); } catch (e) {} }
        try { db.prepare(`INSERT INTO remembered_devices (mac_address, voucher_id, valid_until, created_at) VALUES (?,?,?,?) ON CONFLICT(mac_address) DO UPDATE SET voucher_id=excluded.voucher_id, valid_until=excluded.valid_until`).run(mac, entry.voucher_id, expiresAt, t); } catch (e) {}
        return res.json({ ok: true, state: 'active', remaining_seconds: Math.max(60, expiresAt - t) });
      } catch (e) { return res.json({ ok: false, error: 'Could not start queued voucher.' }); }
    }
  }
  return res.json({ ok: true, state: 'none' });
});

// GET /captive-api — RFC 8910 Captive-Portal API (advertised via DHCP option 114).
// Android 11+/iOS 14+ query this and release captivity when captive=false.
router.get('/captive-api', (req, res) => {
  const mac = req.clientMac, ip = req.clientIp;
  let s = null;
  try { s = (mac ? sessionSvc.findActiveByMac(mac) : null) || sessionSvc.findActiveByIp(ip); } catch (e) {}
  const body = { captive: !s, 'user-portal-url': 'http://10.10.0.1/' };
  if (s && s.expires_at) body['seconds-remaining'] = Math.max(0, s.expires_at - Math.floor(Date.now()/1000));
  res.set('Cache-Control', 'no-store');
  res.type('application/captive+json');
  res.json(body);
});

// GET /cp — auth-aware captive probe responder (DNS-cache-proof captive release).
// nginx routes OS probe paths here with ?t=<type>. Authorized device -> OS-expected
// success so the captive assistant releases; gated -> 302 to portal (fail-closed).
router.get('/cp', (req, res) => {
  const mac = req.clientMac, ip = req.clientIp;
  let authed = false;
  try { authed = !!((mac ? sessionSvc.findActiveByMac(mac) : null) || sessionSvc.findActiveByIp(ip)); } catch (e) {}
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (!authed) return res.redirect(302, 'http://10.10.0.1/');
  const t = String(req.get('x-cp-type') || req.query.t || 'apple');
  if (t === '204')     return res.status(204).end();
  if (t === 'ncsi')    { res.type('text/plain'); return res.send('Microsoft NCSI'); }
  if (t === 'msft')    { res.type('text/plain'); return res.send('Microsoft Connect Test'); }
  if (t === 'firefox') { res.type('text/plain'); return res.send('success\n'); }
  res.type('text/html'); return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n');
});

// PAYWIFI-MEDIA-2026-06-03 — captive portal lists locally-cached videos.
router.get('/media', (req, res) => {
  const rows = db.prepare(
    "SELECT id, video_id, title, description, duration_sec, file_path, thumbnail_path, resolution, file_size " +
    "FROM media_assets WHERE status='processed' AND visibility=1 ORDER BY id DESC LIMIT 100"
  ).all();
  res.json({ ok: true, items: rows, source: 'paywifi_local' });
});

// PORTAL-MEDIA-TRACK-2026-06-03 — analytics events from the captive portal.
// Accepts beacons of shape { media_id, widget_id, event } and writes to media_events.
router.post('/media/track', express.json({ limit: '2kb' }), (req, res) => {
  try {
    const b = req.body || {};
    const mid = parseInt(b.media_id, 10);
    if (!mid) return res.status(400).json({ ok: false, error: 'media_id required' });
    const event = String(b.event || '').slice(0, 32);
    if (!/^(view_start|view_complete|skip|close|error|click)$/.test(event)) {
      return res.status(400).json({ ok: false, error: 'unknown event' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const isMobile = /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    db.prepare(
      "INSERT INTO media_events (media_id, widget_id, event, client_ip, client_mac, user_agent, device_kind, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(mid, String(b.widget_id || '').slice(0, 32), event, req.clientIp || null, req.clientMac || null, ua, isMobile ? 'mobile' : 'desktop', Math.floor(Date.now() / 1000));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'track failed' });
  }
});

// DEVICE-COOKIE-HANDSHAKE-2026-06-03 — proof-of-possession + session-bind check.
//
// The portal JS calls POST /api/portal/handshake on every page load.
// Behaviour:
//   - If a valid pw_device cookie is presented AND maps to a remembered_devices
//     row whose MAC matches the calling client's MAC, the row's TTL + handshake
//     timestamp are bumped and we return { ok:true, verified:true }.
//   - If no cookie OR cookie doesn't match the calling MAC, we return
//     { ok:true, verified:false }. The portal then knows it must show the
//     voucher form even if the MAC happens to be in paywifi_auth_mac.
//   - When `device_cookie_required_for_reauth=1`, sessiond consults this row
//     before granting MAC-only reauth; missing/stale handshake → no auto-reauth.
router.post('/handshake', express.json({ limit: '2kb' }), (req, res) => {
  try {
    const cookieRaw = (req.cookies && req.cookies['pw_device']) || req.headers['x-device-token'] || null;
    if (!cookieRaw) {
      return res.json({ ok: true, verified: false, reason: 'no_cookie' });
    }
    const tokenHash = crypto.createHash('sha256').update(String(cookieRaw)).digest('hex');
    const mac = req.clientMac;
    if (!mac) {
      return res.json({ ok: true, verified: false, reason: 'no_mac' });
    }
    const row = db.prepare(
      "SELECT id, mac_address, valid_until, voucher_id FROM remembered_devices WHERE device_token_hash=?"
    ).get(tokenHash);
    if (!row) {
      // Unknown cookie - audit but don't leak which case matched
      try {
        db.prepare(
          "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL,'voucher_handshake_unknown',?,?,?)"
        ).run('mac=' + mac.slice(0,8) + '???', req.clientIp || null, Math.floor(Date.now()/1000));
      } catch (e) {}
      return res.json({ ok: true, verified: false, reason: 'cookie_unknown' });
    }
    if (row.mac_address !== mac) {
      // Cookie binds to a different MAC — possible theft attempt
      try {
        db.prepare(
          "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL,'voucher_handshake_mac_mismatch',?,?,?)"
        ).run('cookie_mac=' + row.mac_address.slice(0,8) + '??? real_mac=' + mac.slice(0,8) + '???', req.clientIp || null, Math.floor(Date.now()/1000));
      } catch (e) {}
      return res.json({ ok: true, verified: false, reason: 'mac_mismatch' });
    }
    const now = Math.floor(Date.now() / 1000);
    if (row.valid_until > 0 && row.valid_until < now) {
      return res.json({ ok: true, verified: false, reason: 'remembered_expired' });
    }
    db.prepare("UPDATE remembered_devices SET last_handshake_at=? WHERE id=?").run(now, row.id);
    try {
      db.prepare(
        "INSERT INTO audit_log (admin_id, action, details, ip_address, created_at) VALUES (NULL,'voucher_handshake_ok',?,?,?)"
      ).run('mac=' + mac.slice(0,8) + '???', req.clientIp || null, now);
    } catch (e) {}
    res.json({ ok: true, verified: true, valid_until: row.valid_until });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'handshake_failed' });
  }
});

module.exports = router;
