function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function renderWidget(w){
  if(w&&w.enabled===false)return '';
  var e=esc;
  if(w.type==='text'){
    var cls=w.id==='reminder'?'card slide-reminder':w.id==='location'?'card slide-location':'card';
    var ic=w.id==='reminder'
      ?'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
      :'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
    return '<div class="'+cls+'"><h2>'+ic+e(w.title)+'</h2><p class="slide-body">'+e(w.body||'')+'</p></div>';
  }
  if(w.type==='announcement'){
    var lvl=w.level||'info';
    var ic='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    return '<div class="card widget-ann-'+e(lvl)+'"><h2>'+ic+e(w.title)+'</h2><p class="slide-body">'+e(w.body||'')+'</p></div>';
  }
  if(w.type==='hours'){
    var days=['mon','tue','wed','thu','fri','sat','sun'];
    var dnames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    var hrs=w.hours||{};
    var rows=days.map(function(d,i){return hrs[d]?'<tr><td>'+dnames[i]+'</td><td>'+e(hrs[d])+'</td></tr>':''}).join('');
    if(!rows)return '';
    var ic='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    return '<div class="card"><h2>'+ic+e(w.title||'Business Hours')+'</h2><table class="hours-table">'+rows+'</table></div>';
  }
  if(w.type==='contact'){
    var ic='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.56 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    var parts=[];
    if(w.phone) parts.push('<a href="tel:'+e(w.phone)+'">📞 '+e(w.phone)+'</a>');
    if(w.email) parts.push('<a href="mailto:'+e(w.email)+'">✉️ '+e(w.email)+'</a>');
    if(w.facebook) parts.push('<a href="'+e(w.facebook)+'" target="_blank" rel="noopener">📘 Facebook</a>');
    if(w.instagram) parts.push('<a href="'+e(w.instagram)+'" target="_blank" rel="noopener">📸 Instagram</a>');
    if(!parts.length)return '';
    return '<div class="card"><h2>'+ic+e(w.title||'Contact Us')+'</h2><div class="contact-list">'+parts.join('')+'</div></div>';
  }
  if(w.type==='promo'){
    if(!w.image_url)return '';
    var ic='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    return '<div class="card widget-promo">'+(w.title?'<h2>'+ic+e(w.title)+'</h2>':'')+'<img src="'+e(w.image_url)+'" alt="'+e(w.caption||'')+'" loading="lazy">'+(w.caption?'<p class="slide-body">'+e(w.caption)+'</p>':'')+'</div>';
  }
  if(w.type==='html'){
    if(!w.html)return '';
    return '<div class="card">'+(w.title?'<h2>'+e(w.title)+'</h2>':'')+'<div class="slide-body">'+w.html+'</div></div>';
  }
  if(w.type==='payment_options'){
    var ic='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>';
    return '<div class="card"><h2>'+ic+e(w.title||'Payment Options')+'</h2><div class="pm-grid" id="pm-grid"><p style="color:var(--gray-400);font-size:.8rem;text-align:center;grid-column:1/-1;padding:.5rem 0">Loading…</p></div></div>';
  }
  if(w.type==='available_plans'&&w.sticky===false){var iw='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';return '<div class="card"><h2>'+iw+e(w.title||'Available Plans')+'</h2><div class="plans-grid" id="plans-grid-widget"></div></div>';}
  if(w.type==='available_plans'||w.type==='status_bar')return '';
  return '';
}
function renderWidgets(ws){
  var col=document.getElementById('col-info');if(!col)return;
  col.innerHTML=(ws||[]).map(renderWidget).join('');
  if(paymentOptions&&paymentOptions.length)renderPaymentOptions(paymentOptions);
  var apw=(ws||[]).find(w=>w.type==='available_plans')||{enabled:true,sticky:true};
  var sbw=(ws||[]).find(w=>w.type==='status_bar')||{enabled:true,sticky:true};
  var sh=document.getElementById('sheet'),cp=document.querySelector('.col-plans'),sb=document.querySelector('.statusbar');
  if(sh)sh.style.display=apw.enabled!==false&&apw.sticky!==false?'':'none';
  if(cp)cp.style.display=apw.enabled!==false&&apw.sticky!==false?'':'none';
  if(sb)sb.style.display=sbw.enabled!==false&&sbw.sticky!==false?'':'none';
}
function renderPaymentOptions(opts) {
  const grid = document.getElementById('pm-grid');
  if (!grid) return;
  if (!opts || !opts.length) { grid.innerHTML = ''; return; }
  grid.innerHTML = opts.map(o => {
    const key = (o.icon_key||'card').toLowerCase();
    const sOff=optIsDisabled(o),dis2=!sOff&&deviceRL.limited&&o.icon_key!=='cash',blk=sOff||dis2;
    const a=blk?'style="cursor:not-allowed;pointer-events:none" title="'+(sOff?(o.badge||'Unavailable'):'Online payments temporarily unavailable')+'"':'onclick="openWizardWithOption('+o.id+')" title="Pay with '+o.name+'"';
    const iconHtml=o.icon_url?'<img src="'+o.icon_url+'" alt="'+o.name+'" style="width:100%;height:auto;max-height:3rem;object-fit:contain'+(sOff?';opacity:.5':'')+'">':'<div class="pm-icon-wrap pm-icon-wrap-'+key+'"'+(sOff?' style="opacity:.5"':'')+'>'+  (PM_ICONS[key]||PM_ICONS.card)+'</div>';
    const badge=sOff?'<span class="pm-badge-pill '+optBadgeClass(o)+'"><span class="pm-badge-dot"></span>'+(o.badge||'Unavailable')+'</span>':dis2?'<span class="pm-badge-pill pm-badge-unavail"><span class="pm-badge-dot"></span>Unavailable</span>':'<span class="pm-badge-pill"><span class="pm-badge-dot"></span>'+(o.badge||'Payment Mode')+'</span>';
    const storeIcon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:1.75rem;height:1.75rem;color:#16a34a"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
    const cashIcon=o.icon_url?'<img src="'+o.icon_url+'" alt="'+o.name+'" style="width:2.75rem;height:2.75rem;object-fit:contain'+(sOff?';opacity:.5':'')+'">':'<div class="pm-icon-wrap pm-icon-wrap-cash"'+(sOff?' style="opacity:.5"':'')+'>'+storeIcon+'</div>';
    if(key==='cash'){
      var noPartner = typeof storePartners === 'undefined' || !storePartners || !storePartners.length;
      var cashBadge = noPartner
        ? '<span class="pm-badge-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa"><span class="pm-badge-dot" style="background:#f97316"></span>No Partner Available</span>'
        : badge;
      var cashAction = noPartner ? 'onclick="openPartnerInfoPanel()" style="cursor:pointer" title="Cash payment info"' : (blk ? a : a);
      var cashClass = 'pm-card pm-card-wide' + (!noPartner && sOff ? ' pm-card-status-off' : '');
      var cashSub = noPartner ? 'Partner stores coming soon.' : 'Bumili sa tindahan.';
      return '<div class="'+cashClass+'" '+cashAction+'>'+cashBadge+'<div class="pm-card-icon-wrap">'+cashIcon+'</div><div class="pm-card-text"><span class="pm-card-title">Cash Payment</span><span class="pm-card-sub">'+cashSub+'</span></div></div>';
    }
    return '<div class="pm-card'+(sOff?' pm-card-status-off':'')+'" '+a+'><div class="pm-card-icon-wrap">'+iconHtml+'</div><span class="pm-label">'+o.name+'</span>'+badge+'</div>';
  }).join('');
}

function closeCashInfo(){ var o=document.getElementById('cash-info-overlay'); if(o) o.remove(); }
function openPartnerInfoPanel() {
  closeCashInfo();
  var P=(window.PAYWIFI_PARTNER||{});
  var o=document.createElement('div'); o.id='cash-info-overlay'; o.className='overlay open';
  o.innerHTML =
    '<div class="modal">' +
      '<div class="modal-handle"><div class="handle-pill"></div></div>' +
      '<div class="modal-header"><div class="modal-header-left"><p>Payment Method</p>' +
        '<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap"><h2 style="margin:0">Cash Payment</h2></div></div>' +
        '<button class="btn-close" onclick="closeCashInfo()" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
      '<div class="ctx-banner"><div><div class="ctx-amount-lbl">Payment Method</div><div class="ctx-amount-val" style="font-size:1.05rem">Cash</div></div>' +
        '<div class="ctx-divider"></div><div style="text-align:right"><div class="ctx-method-lbl" style="color:#c2410c"><span style="width:.375rem;height:.375rem;border-radius:50%;background:#f97316;display:inline-block"></span>Availability</div><div class="ctx-method-name" style="color:#c2410c">'+(P.availability_status||'Coming Soon')+'</div></div></div>' +
      '<div class="modal-body">' +
        '<div class="pm-instructions" style="border-color:var(--gray-200)"><h3>Availability</h3>' +
          '<p style="font-size:.85rem;color:var(--gray-600);line-height:1.55;margin:0">Cash payment is not yet available in your area. We are currently expanding our partner-store network so you can pay in cash at a shop near you.</p></div>' +
        '<div class="pm-instructions" style="margin-top:.875rem"><h3>How cash payment will work</h3>' +
          '<ol>' +
            '<li><span class="num">1</span><span>Visit a nearby PAYWIFI partner store.</span></li>' +
            '<li><span class="num">2</span><span>Give your payment / session reference.</span></li>' +
            '<li><span class="num">3</span><span>Pay the amount in cash at the counter.</span></li>' +
            '<li><span class="num">4</span><span>Your voucher activates automatically.</span></li>' +
          '</ol></div>' +
        '<div style="margin-top:.875rem;background:var(--gray-50);border:1px solid var(--gray-100);border-radius:1rem;padding:1rem">' +
          '<p style="font-size:.85rem;font-weight:800;color:var(--gray-900);margin:0 0 .35rem">'+(P.cta_text||'Become a PAYWIFI Partner Store')+'</p>' +
          '<p style="font-size:.8rem;color:var(--gray-600);line-height:1.55;margin:0 0 .55rem">'+(P.rollout_message||'Interested in earning by selling WiFi access at your store? Setup is simple and fully managed for you.')+'</p>' +
          '<p style="font-size:.78rem;color:var(--gray-500);margin:0">Contact us: <strong>'+(P.contact_number||'')+'</strong>'+(P.contact_email?(' · <a href="mailto:'+P.contact_email+'" style="color:var(--orange-600);text-decoration:underline">'+P.contact_email+'</a>'):'')+'</p></div>' +
        '<p style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-400);margin:1rem 0 .5rem">Pay online instead</p>' +
        '<div class="wiz-pm-grid" id="cash-alt-grid"></div>' +
      '</div>' +
      '<div class="modal-footer"><button class="btn-confirm" onclick="closeCashInfo()">Got it</button></div>' +
    '</div>';
  o.addEventListener('click', function(e){ if(e.target===o) o.remove(); });
  document.body.appendChild(o);
  var grid=document.getElementById('cash-alt-grid');
  if(grid){
    var alts=(typeof paymentOptions!=='undefined'?paymentOptions:[]).filter(function(x){ return (x.icon_key||'')!=='cash' && x.module_action; });
    grid.innerHTML = alts.length ? alts.map(function(o2){
      var dis=(typeof optIsDisabled==='function' && optIsDisabled(o2));
      var icon=o2.icon_url
        ? '<img src="'+o2.icon_url+'" alt="'+o2.name+'" style="width:100%;height:auto;max-height:3rem;object-fit:contain'+(dis?';opacity:.5':'')+'">'
        : '<div class="pm-icon-wrap pm-icon-wrap-'+(o2.icon_key||'card')+'"'+(dis?' style="opacity:.5"':'')+'></div>';
      var badge=dis
        ? '<span class="pm-badge-pill pm-badge-unavail"><span class="pm-badge-dot"></span>Not Available</span>'
        : '<span class="pm-badge-pill"><span class="pm-badge-dot"></span>Available</span>';
      var act=dis?'disabled':('onclick="closeCashInfo();selectWizPayOption('+o2.id+')"');
      return '<button class="wiz-pm-card'+(dis?' rl-disabled':'')+'" '+act+'><div class="pm-card-icon-wrap">'+icon+'</div><span class="pm-label" style="font-size:.75rem">'+o2.name+'</span>'+badge+'</button>';
    }).join('') : '<p class="pw-empty" style="grid-column:1/-1">Online payment methods will appear here.</p>';
  }
}

/* ── Free trial button lock ─────────────────────────────────────────────── */
var ftCountdownTimer=null;

function ftLockBtn(retryAfterSecs){
  var btn=document.getElementById('header-trial-btn');
  if(!btn)return;
  btn.onclick=null;btn.style.opacity='0.45';btn.style.cursor='not-allowed';
  clearInterval(ftCountdownTimer);
  var secsLeft=Math.max(retryAfterSecs,0);
  function tick(){
    secsLeft--;
    if(secsLeft<=0){clearInterval(ftCountdownTimer);ftUnlockBtn();return;}
    var h=Math.floor(secsLeft/3600),m=Math.floor((secsLeft%3600)/60);
    btn.title='Already claimed — '+h+'h '+m+'m remaining';
  }
  ftCountdownTimer=setInterval(tick,1000);tick();
}

function ftUnlockBtn(){
  clearInterval(ftCountdownTimer);
  var btn=document.getElementById('header-trial-btn');
  if(!btn)return;
  btn.onclick=function(){openFtDialog();};btn.style.opacity='';btn.style.cursor='pointer';
  btn.title='Claim Free Trial';
}



function ftCheckStatus(){
  fetch('/api/portal/free-trial/status')
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.cooldown_minutes)ftStatusCache.cooldown_minutes=d.cooldown_minutes;
      if(d.claim_page&&typeof d.claim_page==='object')Object.assign(ftStatusCache.claim_page,d.claim_page);
      if(d.claimed&&d.retry_after>0)ftLockBtn(d.retry_after);
    })
    .catch(function(){});
}

/* ── Free WiFi — simple phone claim ──────────────────────────────────── */
var ftClaimId=null,ftPollTimer=null,ftPollCount=0,ftMaxPolls=15;
var ftStatusCache={cooldown_minutes:1440,claim_page:{header_text:'Enter your mobile number to claim.',claim_btn:'CLAIM',success_msg:'Voucher sent! Check your SMS.',loading_msg:'Sending voucher\u2026'}};

function openFtDialog(){
  var m=document.getElementById('ft-modal');
  if(!m)return;
  m.innerHTML=`
<div style="background:#fff;border-radius:1rem;width:calc(100% - 2rem);max-width:320px;padding:1.75rem 1.5rem;box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center;position:relative">
  <button onclick="closeFtModal()" style="position:absolute;top:.75rem;right:.75rem;background:none;border:none;font-size:1.25rem;color:#9ca3af;cursor:pointer;line-height:1;padding:0">&times;</button>
  <p style="font-size:.84rem;color:#6b7280;margin:0 0 1.25rem;line-height:1.5">${ftStatusCache.claim_page.header_text||'Enter your mobile number to claim.'}</p>
  <input id="ft-phone" type="tel" placeholder="09XXXXXXXXX" maxlength="13"
         oninput="this.value=this.value.replace(/[^0-9+]/g,'')"
         onkeydown="if(event.key==='Enter')submitFtPhone()"
         onfocus="this.style.borderColor='#f97316'" onblur="this.style.borderColor='#e5e7eb'"
         style="width:100%;box-sizing:border-box;height:2.75rem;border:1.5px solid #e5e7eb;border-radius:.625rem;padding:0 .875rem;font-size:1rem;outline:none;font-family:inherit;text-align:center"/>
  <div id="ft-error" style="display:none;color:#ef4444;font-size:.75rem;margin-top:.4rem"></div>
  <div style="text-align:left;margin-top:.75rem">
    <p style="font-size:.7rem;color:#6b7280;line-height:1.5;margin:0 0 .55rem">Your mobile number is required to receive your voucher code and internet-access notifications via SMS.</p>
    <label style="display:flex;gap:.5rem;align-items:flex-start;font-size:.69rem;color:#374151;line-height:1.45;cursor:pointer;margin-bottom:.5rem">
      <input type="checkbox" id="ft-consent" onchange="ftConsentChanged()" style="margin-top:.15rem;flex-shrink:0" />
      <span>I agree to the <a href="/terms.html" onclick="openLegalModal();return false" style="color:#f97316;text-decoration:underline">Terms, Privacy Policy</a> &amp; Fair Usage Policy, and consent to the use of my mobile number for voucher delivery, login code verification, access notifications, security validation, and PAYWIFI service communications.</span>
    </label>
    <label style="display:flex;gap:.5rem;align-items:flex-start;font-size:.69rem;color:#6b7280;line-height:1.45;cursor:pointer">
      <input type="checkbox" id="ft-marketing" style="margin-top:.15rem;flex-shrink:0" />
      <span>Optional: receive promotional offers and rewards from PAYWIFI.</span>
    </label>
    <p style="font-size:.63rem;color:#9ca3af;line-height:1.4;margin:.5rem 0 0">PAYWIFI collects your number and device/session info to deliver vouchers, prevent abuse, secure access, and improve service. Free trials are subject to fair-usage &amp; abuse-prevention policies.</p>
  </div>
  <button onclick="submitFtPhone()" id="ft-claim-btn" disabled style="width:100%;height:2.75rem;margin-top:.875rem;background:#f97316;color:#fff;border:none;border-radius:.75rem;font-size:1rem;font-weight:700;cursor:pointer;letter-spacing:.03em;opacity:.55">${ftStatusCache.claim_page.claim_btn||'CLAIM'}</button>

  <div id="ft-sending-view" style="display:none;padding:1rem 0 .25rem">
    <div style="width:2rem;height:2rem;border:3px solid #f3f4f6;border-top-color:#f97316;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto .5rem"></div>
    <p style="color:#6b7280;font-size:.82rem;margin:0">${ftStatusCache.claim_page.loading_msg||'Sending voucher…'}</p>
  </div>

  <div id="ft-success-view" style="display:none;padding:.75rem 0 .25rem">
    <div style="width:2.5rem;height:2.5rem;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto .625rem">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <p style="font-weight:700;color:#111827;font-size:.95rem;margin:0 0 .25rem">Voucher Sent!</p>
    <p id="ft-success-msg" style="color:#6b7280;font-size:.82rem;margin:0 0 1rem">Check your SMS for the voucher code.</p>
    <button onclick="ftUseVoucher()" style="width:100%;height:2.75rem;background:#f97316;color:#fff;border:none;border-radius:.75rem;font-size:.95rem;font-weight:700;cursor:pointer;margin-bottom:.5rem">Use Voucher</button>
    <button onclick="closeFtModal()" style="width:100%;height:2.5rem;background:#f3f4f6;color:#6b7280;border:none;border-radius:.75rem;font-size:.88rem;font-weight:600;cursor:pointer">Close</button>
  </div>
</div>`;
  m.style.display='flex';
  try{ if(window.savedNumber){ var _fp=m.querySelector('#ft-phone'); if(_fp && !_fp.value) _fp.value=window.savedNumber; } }catch(e){}
  setTimeout(function(){var p=m.querySelector('#ft-phone');if(p)p.focus();},80);
}

function ftLockout(sec){var btn=document.getElementById('ft-claim-btn');if(!btn)return;btn.disabled=true;btn.style.opacity='.55';var orig=ftStatusCache.claim_page.claim_btn||'CLAIM';var end=Date.now()+sec*1000;if(window._ftLT)clearInterval(window._ftLT);window._ftLT=setInterval(function(){var left=Math.ceil((end-Date.now())/1000);if(left<=0){clearInterval(window._ftLT);btn.textContent=orig;ftConsentChanged();return;}var mm=Math.floor(left/60),ss=left%60;btn.textContent='Try again in '+(mm>0?mm+'m ':'')+ss+'s';},500);}
function ftConsentChanged(){var cb=document.getElementById('ft-consent'),btn=document.getElementById('ft-claim-btn');if(btn){btn.disabled=!(cb&&cb.checked);btn.style.opacity=btn.disabled?'.55':'';}}
function submitFtPhone(){
  var phoneEl=document.getElementById('ft-phone');
  var errEl=document.getElementById('ft-error');
  var btn=document.getElementById('ft-claim-btn');
  var phone=(phoneEl?phoneEl.value:'').trim();
  if(errEl)errEl.style.display='none';
  if(!(/^(09\d{9}|\+639\d{9})$/.test(phone))){
    if(errEl){errEl.textContent='Enter a valid PH number (e.g. 09171234567).';errEl.style.display='block';}
    if(phoneEl)phoneEl.focus();
    return;
  }
  var consentEl=document.getElementById('ft-consent');
  if(!consentEl||!consentEl.checked){ if(errEl){errEl.textContent='Please accept the Terms & consent to continue.';errEl.style.display='block';} return; }
  if(btn)btn.disabled=true;
  if(phoneEl)phoneEl.disabled=true;
  var sv=document.getElementById('ft-sending-view');
  if(sv)sv.style.display='block';
  fetch('/api/portal/free-trial/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phone,consent:true,marketing:(document.getElementById('ft-marketing')||{}).checked===true})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.ok){
        ftClaimId=d.claim_id||null;
        ftMaxPolls=d.generation_delay>0?Math.ceil((d.generation_delay+10)/2):15;
        if(ftClaimId){ftPollCount=0;ftPollTimer=setInterval(ftPollStatus,2000);}
        else{showFtSuccess('Connected! Enjoy your free WiFi.');}
      } else {
        if(sv)sv.style.display='none';
        if(phoneEl)phoneEl.disabled=false;
        var msg=(d.error==='free_trial_claimed')?'You already claimed a free trial on this device. Please try again later.':(d.error||'Unable to send SMS right now. Please try again later.');
        if(d.retry_after&&d.retry_after>0){ ftLockout(d.retry_after); } else { if(btn)btn.disabled=false; }
        if(errEl){errEl.textContent=msg;errEl.style.display='block';}
      }
    })
    .catch(function(){
      if(sv)sv.style.display='none';
      if(btn)btn.disabled=false;
      if(phoneEl)phoneEl.disabled=false;
      if(errEl){errEl.textContent='Connection problem. Please try again.';errEl.style.display='block';}
    });
}

function ftPollStatus(){
  if(!ftClaimId){clearInterval(ftPollTimer);showFtSuccess('Connected!');return;}
  ftPollCount++;
  if(ftPollCount>ftMaxPolls){clearInterval(ftPollTimer);showFtSuccess(ftStatusCache.claim_page.success_msg||'Voucher sent — check your SMS.');return;}
  fetch('/api/portal/free-trial/sms-status?claim_id='+ftClaimId)
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.status==='sent'){clearInterval(ftPollTimer);showFtSuccess(ftStatusCache.claim_page.success_msg||'Voucher sent! Check your SMS.');}
      else if(d.status==='failed'||d.ok===false){clearInterval(ftPollTimer);showFtFailed(60);}
    })
    .catch(function(){});
}

function showFtFailed(sec){
  sec=sec||60;
  var sv=document.getElementById('ft-sending-view'); if(sv)sv.style.display='none';
  var phoneEl=document.getElementById('ft-phone'); if(phoneEl)phoneEl.disabled=true;
  var btn=document.getElementById('ft-claim-btn'); if(btn)btn.style.display='none';
  var m=document.getElementById('ft-modal'); if(!m)return;
  var card=m.firstElementChild||m.querySelector('div'); if(!card)return;
  Array.prototype.forEach.call(card.children,function(ch){ if(ch.id!=='ft-failed-view'){ ch.style.opacity='.4'; ch.style.pointerEvents='none'; } });
  var ex=document.getElementById('ft-failed-view');
  if(!ex){ ex=document.createElement('div'); ex.id='ft-failed-view'; ex.style.cssText='margin-top:1rem'; card.appendChild(ex); }
  ex.style.opacity=''; ex.style.pointerEvents='';
  var end=Date.now()+sec*1000;
  function rndr(){
    var left=Math.ceil((end-Date.now())/1000);
    ex.innerHTML='<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:.75rem;padding:1rem;text-align:center">'
      +'<div style="font-size:1.6rem;line-height:1">⚠️</div>'
      +'<p style="font-weight:800;color:#b91c1c;font-size:.92rem;margin:.35rem 0 .25rem">Could not send your code</p>'
      +'<p style="font-size:.78rem;color:#7f1d1d;line-height:1.45;margin:0 0 .7rem">We could not deliver an SMS to that number. Please double-check it and try again later.</p>'
      +(left>0
        ?'<button disabled style="width:100%;height:2.6rem;background:#fca5a5;color:#fff;border:none;border-radius:.65rem;font-weight:700;cursor:not-allowed">Try again in '+left+'s</button>'
        :'<button onclick="ftRetry()" style="width:100%;height:2.6rem;background:#f97316;color:#fff;border:none;border-radius:.65rem;font-weight:700;cursor:pointer">Try Again</button>');
  }
  rndr();
  if(window._ftFailT)clearInterval(window._ftFailT);
  window._ftFailT=setInterval(function(){ var left=Math.ceil((end-Date.now())/1000); rndr(); if(left<=0)clearInterval(window._ftFailT); },500);
}
function ftRetry(){ if(window._ftFailT)clearInterval(window._ftFailT); closeFtModal(); openFtDialog(); }

function showFtSuccess(msg){
  var sv=document.getElementById('ft-sending-view');
  var sucv=document.getElementById('ft-success-view');
  var sm=document.getElementById('ft-success-msg');
  var phoneEl=document.getElementById('ft-phone');
  var btn=document.getElementById('ft-claim-btn');
  if(sv)sv.style.display='none';
  if(phoneEl)phoneEl.style.display='none';
  if(btn)btn.style.display='none';
  if(sm)sm.textContent=msg||'Check your SMS for the voucher.';
  if(sucv)sucv.style.display='block';
  ftLockBtn(ftStatusCache.cooldown_minutes*60);
}

function ftUseVoucher(){
  closeFtModal();
  var inp=document.getElementById('voucher-input');
  if(!inp)return;
  inp.scrollIntoView({behavior:'smooth',block:'center'});
  inp.focus();
  inp.style.transition='box-shadow .2s';
  inp.style.boxShadow='0 0 0 3px #f97316';
  setTimeout(function(){inp.style.boxShadow='';},1800);
}

function closeFtModal(){clearInterval(ftPollTimer);var m=document.getElementById('ft-modal');if(m)m.style.display='none';}


/* ── Cash payment — store partner wizard helpers ───────────────────────── */
function renderStoreDropdown() {
  var sel = document.getElementById('wiz-store-select');
  if (!sel) return;
  var cur = wizState.selectedStore ? wizState.selectedStore.name : '';
  sel.innerHTML = '<option value="">— Choose nearest store —</option>' +
    storePartners.map(function(s) {
      return '<option value="' + esc(s.name) + '"' + (cur === s.name ? ' selected' : '') + '>' +
        esc(s.name) + (s.address ? ' · ' + esc(s.address) : '') + '</option>';
    }).join('');
}

function wizSelectStore(name) {
  wizState.selectedStore = storePartners.find(function(s) { return s.name === name; }) || null;
  var ov = document.getElementById('wiz-plans-overlay');
  if (ov) ov.style.display = wizState.selectedStore ? 'none' : 'flex';
  var hasPlan = !!wizState.plan, hasOpt = !!wizState.payOption;
  var isCash  = hasOpt && wizState.payOption.icon_key === 'cash';
  var hasStore = !!wizState.selectedStore;
  var canNext  = hasPlan && (!isCash || hasStore);
  var footer = document.getElementById('wiz-footer');
  if (footer) footer.innerHTML =
    '<button class="btn-cancel" onclick="closeWizard()">Cancel</button>' +
    '<button class="btn-confirm" onclick="wizConfirmPlan()" ' + (canNext ? '' : 'disabled') + '>' +
    (!hasPlan ? 'Select a plan' : isCash && !hasStore ? 'Select a store first' :
      hasOpt ? 'Pay ₱' + wizState.plan.price + ' →' : 'Next →') + '</button>';
}

function wizPickStoreInPay(name) {
  if (!name) return;
  wizState.selectedStore = storePartners.find(function(s) { return s.name === name; }) || null;
  if (!wizState.selectedStore) return;
  var txt = document.getElementById('wiz-manual-text');
  var amount = (wizState.payData && wizState.payData.amount)
    ? wizState.payData.amount : (wizState.plan ? wizState.plan.price : '—');
  if (txt) txt.innerHTML = buildCashInstructions(amount);
}

function buildCashInstructions(amount) {
  var store = wizState.selectedStore;
  if (!store) {
    var opts = storePartners.map(function(s) {
      return '<option value="' + esc(s.name) + '">' +
        esc(s.name) + (s.address ? ' · ' + esc(s.address) : '') + '</option>';
    }).join('');
    return '<div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:.75rem;padding:.875rem;margin-bottom:.875rem">' +
      '<p style="font-size:.82rem;font-weight:700;color:#92400e;margin:0 0 .5rem">📍 Which store are you going to?</p>' +
      (opts
        ? '<select id="wiz-pay-store-select" onchange="wizPickStoreInPay(this.value)" ' +
          'style="width:100%;height:2.5rem;border:1.5px solid #fed7aa;border-radius:.625rem;padding:0 .75rem;font-size:.85rem;font-family:inherit;color:#111827;background:#fffbf5;outline:none">' +
          '<option value="">— Select a store partner —</option>' + opts + '</select>'
        : '<p style="font-size:.82rem;color:#92400e;margin:0">No stores configured. Contact admin.</p>') +
      '</div><p style="font-size:.82rem;color:#6b7280;text-align:center;margin:0">Select a store above to see your instructions.</p>';
  }
  return '<div style="text-align:center;margin-bottom:1.125rem">' +
    '<div style="width:3rem;height:3rem;background:#f0fdf4;border-radius:50%;display:flex;align-items:center;' +
    'justify-content:center;margin:0 auto .5rem;font-size:1.5rem">🏪</div>' +
    '<div style="font-size:1rem;font-weight:700;color:#111827">' + esc(store.name) + '</div>' +
    (store.address ? '<div style="font-size:.78rem;color:#6b7280;margin-top:.25rem">📍 ' + esc(store.address) + '</div>' : '') +
    '</div>' +
    '<ol style="margin:0 0 .875rem;padding-left:1.375rem;line-height:2.1;font-size:.9rem;color:#374151">' +
    '<li>Go to <strong>' + esc(store.name) + '</strong></li>' +
    '<li>Tell the cashier: <strong>“I want a WiFi voucher”</strong></li>' +
    '<li>Pay <strong>₱' + amount + '</strong></li>' +
    '<li>They will give you a <strong>voucher code</strong></li>' +
    '<li>Come back here and tap <em>I Have My Code</em></li>' +
    '</ol>';
}

/* ═══ Header Panel System ══════════════════════════════════════════════════ */

var _alerts = [], _alertsLoaded = false, _alertsLoading = false, _alertFilter = 'all';

// ── Generic bottom sheet modal ──────────────────────────────────────────────

// ── Panel Sheet (matches .overlay/.modal system) ────────────────────────────
// ── Inline alerts + voucher history (header icons/modals removed) ────────────
function pwSheet(id, title, bodyHtml) {
  var ex = document.getElementById(id);
  if (ex) { ex.remove(); return null; }
  var closeId = id + '-close';
  var o = document.createElement('div');
  o.id = id; o.className = 'pw-overlay';
  o.innerHTML =
    '<div class="pw-modal">' +
      '<div class="pw-modal-handle"><div class="pw-handle-pill"></div></div>' +
      '<div class="pw-modal-header">' +
        '<span class="pw-modal-title">' + title + '</span>' +
        '<button id="' + closeId + '" class="pw-btn-close" aria-label="Close">' +
          '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>' +
        '</button>' +
      '</div>' +
      '<div id="' + id + '-body" class="pw-modal-body">' + bodyHtml + '</div>' +
    '</div>';
  o.addEventListener('click', function(e){ if (e.target === o) o.remove(); });
  document.getElementById(closeId) && document.getElementById(closeId).addEventListener('click', function(){ o.remove(); });
  document.body.appendChild(o);
  setTimeout(function(){ var el = document.getElementById(closeId); if (el) el.onclick = function(){ o.remove(); }; }, 0);
  return document.getElementById(id + '-body');
}
function pwSheetBody(id) { return document.getElementById(id + '-body'); }

function iaClaimTrial(){ if (typeof openFtDialog === 'function') openFtDialog(); }
function iaToast(msg){var t=document.createElement('div');t.textContent=msg;t.style.cssText='position:fixed;left:50%;bottom:3.2rem;transform:translateX(-50%);z-index:400;background:#16a34a;color:#fff;font-size:.82rem;font-weight:700;padding:.55rem .9rem;border-radius:.6rem;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center';document.body.appendChild(t);setTimeout(function(){if(t.parentElement)t.remove();},3500);}
function iaClaimWelcome(){ fetch('/api/portal/alerts/claim-welcome',{method:'POST'}).then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ var h=Math.round((d.minutes||300)/60); iaToast(h+' Hours Added Successfully'); } else if(d&&d.error){ iaToast(d.error); } if(typeof loadAlerts==='function') loadAlerts(); if(typeof initVoucherHistory==='function') initVoucherHistory(); }).catch(function(){}); }
function iaClaimRetention(){ fetch('/api/portal/alerts/claim-retention',{method:'POST'}).then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ var h=Math.round((d.minutes||60)/60); iaToast(h+' Hour'+(h>1?'s':'')+' Added — Stay Connected'); } else if(d&&d.error){ iaToast(d.error); } if(typeof loadAlerts==='function') loadAlerts(); if(typeof initVoucherHistory==='function') initVoucherHistory(); }).catch(function(){}); }

function loadAlerts(){
  fetch('/api/portal/alerts').then(function(r){return r.json();}).then(function(d){
    _alerts = (d && d.alerts) ? d.alerts : [];
    renderInlineAlerts();
  }).catch(function(){ renderInlineAlerts(); });
}

function renderInlineAlerts(){
  var boxes = [document.getElementById('inline-alerts'), document.getElementById('inline-alerts-header')].filter(Boolean);
  if(!boxes.length) return;
  fetch('/api/session/status').then(function(r){return r.json();}).catch(function(){return null;}).then(function(ss){
    var items = [];
    if (ss && ss.queue_count > 0) items.push({t:'info', ic:'⏳', m:'Your next voucher is ready and will activate automatically.'});
    (_alerts||[]).forEach(function(a){
      if (a.claimed) return;
      var t = a.type==='success' ? 'success' : (a.type==='promo' ? 'promo' : 'info');
      var btn = (a.action==='claim_trial') ? '<button class="ia-btn" onclick="iaClaimTrial()">'+esc(a.action_label||'Claim')+'</button>' : (a.action==='claim_welcome') ? '<button class="ia-btn" onclick="iaClaimWelcome()">'+esc(a.action_label||'Claim')+'</button>' : (a.action==='claim_retention') ? '<button class="ia-btn" onclick="iaClaimRetention()">'+esc(a.action_label||'Claim')+'</button>' : '';
      items.push({t:t, ic:a.icon||'🎁', m:a.message||'', btn:btn});
    });
    var html = items.map(function(it){
      return '<div class="ia-banner ia-'+it.t+'"><span class="ia-ic">'+it.ic+'</span><span class="ia-txt">'+esc(it.m)+(it.btn||'')+'</span></div>';
    }).join('');
    boxes.forEach(function(box){
      box.innerHTML = html;
      if (items.length) box.classList.add('has-alerts'); else box.classList.remove('has-alerts');
    });
  });
}

// Phone autofill helpers (used by init + payment flow)
function to09(p){p=String(p||'').replace(/\D/g,'');if(p.indexOf('63')===0&&p.length===12)return '0'+p.slice(2);if(p.length===10&&p.charAt(0)==='9')return '0'+p;return p;}
function applySavedNumber(num){ if(!num)return; window.savedNumber=num;
  ['buyer-phone-plan','buyer-phone-checkout','buyer-phone-pay'].forEach(function(id){var el=document.getElementById(id); if(el && !el.value) el.value=num;});
  var m=document.getElementById('buyer-phone-pay-msg'); if(m && num) m.textContent='Using saved mobile number ('+num+')';
}

// ── Inline voucher history (expandable plain-text, below Connect) ────────────
var _vhData = null;
function _vhDur(mm){ if(!mm)return '—'; return mm>=1440?Math.round(mm/1440)+' day(s)':mm>=60?Math.round(mm/60)+' hr(s)':mm+' min'; }
function _vhDate(ts){ if(!ts)return ''; var dt=new Date(ts*1000); return dt.toLocaleDateString()+' '+dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

function initVoucherHistory(){
  var tog=document.getElementById('vh-toggle'); if(!tog) return;
  fetch('/api/portal/my-vouchers').then(function(r){return r.json();}).then(function(d){
    _vhData = d || {};
    var any = (_vhData.active) || (_vhData.queued&&_vhData.queued.length) || (_vhData.unredeemed&&_vhData.unredeemed.length) || (_vhData.history&&_vhData.history.length);
    tog.hidden = !any;
  }).catch(function(){ tog.hidden = true; });
}

function renderVoucherHistory(){
  var body=document.getElementById('vh-body'); if(!body) return;
  var d=_vhData||{}; var rows=[];
  if (d.active){ var rs=d.active.remaining_seconds||0,h=Math.floor(rs/3600),m=Math.floor((rs%3600)/60);
    rows.push('<div class="vh-row"><span class="vh-code">'+esc(d.active.code||'—')+'</span> · '+_vhDur(d.active.duration_minutes)+' <span class="vh-state vh-active">● active'+((h||m)?' · '+(h?h+'h ':'')+m+'m left':'')+'</span></div>'); }
  if (d.queued) d.queued.forEach(function(q){ rows.push('<div class="vh-row"><span class="vh-code">'+esc(q.code||'—')+'</span> · '+_vhDur(q.duration_minutes)+' <span class="vh-state vh-queued">⏳ ready next</span></div>'); });
  if (d.unredeemed) d.unredeemed.forEach(function(u){ rows.push('<div class="vh-row"><span class="vh-code">'+esc(u.code||'—')+'</span> · '+_vhDur(u.duration_minutes)+' <span class="vh-state vh-ready">🎟 ready to use</span></div>'); });
  if (d.history) d.history.forEach(function(hh){ rows.push('<div class="vh-row"><span class="vh-code">'+esc(hh.code||'—')+'</span> · '+_vhDur(hh.duration_minutes)+' <span class="vh-state vh-used">used</span> <span class="vh-meta">'+_vhDate(hh.started_at)+'</span></div>'); });
  body.innerHTML = rows.length ? rows.join('') : '<p class="vh-empty">No vouchers yet.</p>';
}

function toggleVoucherHistory(){
  var panel=document.getElementById('vh-panel'), tog=document.getElementById('vh-toggle'); if(!panel) return;
  if (panel.hidden===false){ panel.hidden=true; if(tog)tog.setAttribute('aria-expanded','false'); }
  else { renderVoucherHistory(); panel.hidden=false; if(tog)tog.setAttribute('aria-expanded','true'); }
}

function showVoucherHistory(){
  var tog=document.getElementById('vh-toggle'); if(tog)tog.hidden=false;
  var panel=document.getElementById('vh-panel');
  if (panel && panel.hidden!==false) toggleVoucherHistory();
}


// ── Init ────────────────────────────────────────────────────────────────────
// Inject panel CSS immediately (no need to wait for window.load — document.head is always ready)
// and kick off the alerts fetch so data is in-cache before the user taps the bell.
function restoreSession(){
  try{
    fetch('/api/portal/session/restore',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
      if(!d||!d.ok) return;
      if(d.state==='active'){
        var ov=document.createElement('div');
        ov.id='pw-resume-ov';
        ov.style.cssText='position:fixed;inset:0;z-index:500;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.9rem;background:rgba(255,255,255,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);text-align:center;padding:1.5rem';
        var mins=Math.max(1,Math.round((d.remaining_seconds||0)/60));
        ov.innerHTML='<div style="width:2.75rem;height:2.75rem;border-radius:50%;border:3px solid #fde68a;border-top-color:#f97316;animation:pwspin 1s linear infinite"></div>'
          +'<div style="font-size:1.15rem;font-weight:900;color:#111827">Welcome back</div>'
          +'<div style="font-size:.85rem;color:#6b7280;max-width:18rem">Restoring your internet session\u2026<br/><span style="color:#f97316;font-weight:700">'+mins+' min remaining</span></div>';
        if(!document.getElementById('pw-resume-kf')){var st=document.createElement('style');st.id='pw-resume-kf';st.textContent='@keyframes pwspin{to{transform:rotate(360deg)}}';document.head.appendChild(st);}
        document.body.appendChild(ov);
        try{ if(typeof releaseCaptive==='function') releaseCaptive(); }catch(e){}
        setTimeout(function(){ try{loadAlerts();}catch(e){} if(typeof loadSessionStatus==='function'){try{loadSessionStatus();}catch(e){}} },1200);
        setTimeout(function(){ var o=document.getElementById('pw-resume-ov'); if(o){o.style.transition='opacity .4s';o.style.opacity='0';setTimeout(function(){if(o.parentElement)o.remove();},420);} },4000);
      }
    }).catch(function(){});
  }catch(e){}
}

(function(){
  var lnk = document.createElement('link');
  lnk.rel = 'stylesheet'; lnk.href = '/pw-panels.css';
  document.head.appendChild(lnk);
  // app.js is loaded at end of <body> so the DOM is already parsed; call directly
  restoreSession();
  loadAlerts();
  initVoucherHistory();
  // Restore saved number on page load/refresh (fixes header reverting to "Welcome Guest!")
  fetch('/api/portal/auth/me').then(function(r){return r.json();}).then(function(d){ if(!d)return; var _sv=d.user?d.user.phone:(d.guest_phone||''); if(_sv) applySavedNumber(to09(_sv)); }).catch(function(){});
})();
