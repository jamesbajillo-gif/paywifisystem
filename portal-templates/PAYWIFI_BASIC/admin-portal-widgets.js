
(function(){
var DEFAULT = [
  {id:'location',type:'text',enabled:true,order:1,title:'Where to Buy',body:'Visit the counter or ask a staff member to purchase a voucher. Vouchers are available in multiple time and speed plans to suit your needs.'},
  {id:'reminder',type:'text',enabled:true,order:2,title:'Reminder',body:"Your session starts the moment you enter the voucher code. Time continues to count down whether you are browsing or not. Reconnecting on the same device within your plan's validity will resume your session automatically."},
  {id:'payment_options',type:'payment_options',enabled:true,order:3,title:'Payment Options'},
  {id:'available_plans',type:'available_plans',enabled:true,order:4,title:'Available Plans',sticky:true},
  {id:'status_bar',type:'status_bar',enabled:true,order:5,title:'Status Bar',sticky:true},
  {id:'announcement',type:'announcement',enabled:false,order:0,title:'Notice',body:'',level:'info'},
  {id:'hours',type:'hours',enabled:false,order:6,title:'Business Hours',hours:{mon:'',tue:'',wed:'',thu:'',fri:'',sat:'',sun:''}},
  {id:'contact',type:'contact',enabled:false,order:7,title:'Contact Us',phone:'',email:'',facebook:'',instagram:''},
  {id:'promo',type:'promo',enabled:false,order:8,title:'Promotion',image_url:'',caption:''},
  {id:'custom_html',type:'html',enabled:false,order:9,title:'Custom',html:''},
  {id:'ads_card',type:'ads_card',enabled:true,order:10,title:'Your Ads Here',subtitle:'Submit to inquire',contact_email:'ads@example.com'},
  {id:'partner_cta',type:'partner_cta',enabled:true,order:11,title:'Partner with Us',subtitle:'',chip:'',rollout:'',contact_number:'',contact_email:''},
  {id:'youtube',type:'youtube',enabled:true,order:12,title:'Featured Video',media_id:'auto',playlist_mode:'auto',playlist_ids:[],autoplay:true,muted:false,loop:true,controls:true,allow_fullscreen:true,volume:1.0,click_to_play:false,skip_button:false,close_button:false,device_rule:'any'}
];
var raw = window.PW_WIDGETS_INIT;
var widgets = Array.isArray(raw) ? raw : DEFAULT;
// Inject any built-in widget types missing from a previously-saved list
if(Array.isArray(raw)){
  DEFAULT.forEach(function(d){
    if(!widgets.find(function(w){return w.type===d.type;})){
      widgets.push(JSON.parse(JSON.stringify(d)));
    }
  });
}
var editIdx = null, dragSrc = null;

function fmtUpdatedAt(ts){
  if(!ts) return '';
  var now=Math.floor(Date.now()/1000); var d=now-ts;
  if(d<60) return 'just now';
  if(d<3600) return Math.floor(d/60)+'m ago';
  if(d<86400) return Math.floor(d/3600)+'h ago';
  if(d<7*86400) return Math.floor(d/86400)+'d ago';
  return new Date(ts*1000).toLocaleDateString();
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
var TYPE_ICONS = {text:'\u{1F4DD}',announcement:'\u{1F4E2}',hours:'\u{1F550}',contact:'\u{1F4DE}',promo:'\u{1F5BC}\uFE0F',html:'</>',payment_options:'\u{1F4B3}',available_plans:'\u{1F4F6}',status_bar:'\u{1F4CA}',ads_card:'\u{1F4E3}',partner_cta:'\u{1F91D}',youtube:'\u{1F3AC}'};
var TYPE_LABELS = {text:'text',announcement:'announcement',hours:'hours',contact:'contact',promo:'promo',html:'html',payment_options:'payment options',available_plans:'available plans',status_bar:'status bar',ads_card:'ads card',partner_cta:'partner CTA',youtube:'YouTube'};

function render(){
  var sorted = widgets.slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
  document.getElementById('wl').innerHTML = sorted.map(function(w){
    var ri = widgets.indexOf(w);
    return '<div class="flex items-center gap-2 px-3 py-2 rounded bg-slate-900 border border-slate-700'+(w.enabled?'':' opacity-50')+'" draggable="true" data-idx="'+ri+'">'
      +'<span class="text-slate-600 cursor-grab select-none text-lg" title="Drag to reorder">⠇</span>'
      +'<span class="text-base leading-none">'+(TYPE_ICONS[w.type]||'\u{1F4E6}')+'</span>'
      +'<span class="flex-1 text-sm font-medium text-slate-200 truncate">'+esc(w.title||w.type)+'</span>'
      +'<span class="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded shrink-0">'+(TYPE_LABELS[w.type]||w.type)+'</span>'
      +(w.updated_at?'<span class="text-[10px] text-slate-500 shrink-0 hidden sm:inline" title="By '+esc(w.updated_by_name||'admin')+'">'+fmtUpdatedAt(w.updated_at)+'</span>':'')
      +'<div class="flex gap-1 shrink-0">'
        +'<button class="w-6 h-6 rounded bg-slate-800 text-slate-400 hover:text-white text-xs leading-none" onclick="wUp('+ri+')" title="Move up">▲</button>'
        +'<button class="w-6 h-6 rounded bg-slate-800 text-slate-400 hover:text-white text-xs leading-none" onclick="wDown('+ri+')" title="Move down">▼</button>'
        +'<button class="w-6 h-6 rounded bg-slate-800 text-slate-400 hover:text-white text-xs leading-none" onclick="wEdit('+ri+')" title="Edit">✏</button>'
      +'</div>'
      +'<label class="relative inline-flex items-center cursor-pointer shrink-0">'
        +'<input type="checkbox" class="sr-only" '+(w.enabled?'checked':'')+' onchange="wToggle('+ri+',this.checked)">'
        +'<div class="w-9 h-5 rounded-full '+(w.enabled?'bg-brand-500':'bg-slate-600')+' relative transition-colors">'
          +'<div class="absolute top-0.5 '+(w.enabled?'left-4':'left-0.5')+' w-4 h-4 bg-white rounded-full transition-all"></div>'
        +'</div>'
      +'</label>'
    +'</div>';
  }).join('');
  document.querySelectorAll('#wl [draggable]').forEach(function(el){
    el.addEventListener('dragstart',function(e){dragSrc=parseInt(el.dataset.idx);el.style.opacity='.4';});
    el.addEventListener('dragend',function(){el.style.opacity='';});
    el.addEventListener('dragover',function(e){e.preventDefault();el.style.background='#1e3a5f';});
    el.addEventListener('dragleave',function(){el.style.background='';});
    el.addEventListener('drop',function(e){
      e.preventDefault();el.style.background='';
      var ti=parseInt(el.dataset.idx);
      if(dragSrc!==null&&dragSrc!==ti){
        var ao=widgets[dragSrc].order,bo=widgets[ti].order;
        widgets[dragSrc].order=bo;widgets[ti].order=ao;render();
      }
      dragSrc=null;
    });
  });
  var ep=document.getElementById('wep');
  if(editIdx!==null&&widgets[editIdx]){
    ep.classList.remove('hidden');
    document.getElementById('wep-title').textContent='Editing: '+esc(widgets[editIdx].title||widgets[editIdx].type);
    document.getElementById('wef').innerHTML=buildForm(widgets[editIdx]);
    document.getElementById('btn-wep-delete').style.display=widgets[editIdx].id&&
      ['location','reminder','payment_options','available_plans','status_bar','ads_card','partner_cta','youtube'].includes(widgets[editIdx].id)?'none':'';
  } else {
    ep.classList.add('hidden');
    editIdx=null;
  }
}
function inp(name,val,label,placeholder){
  return '<div class="flex items-center gap-2 mb-2">'
    +'<label class="text-xs text-slate-400 w-24 shrink-0">'+label+'</label>'
    +'<input name="'+name+'" value="'+esc(val||'')+'" placeholder="'+esc(placeholder||'')+'" '
    +'class="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none focus:border-brand-500"></div>';
}
function ta(name,val,label){
  return '<div class="mb-2"><label class="block text-xs text-slate-400 mb-1">'+label+'</label>'
    +'<textarea name="'+name+'" rows="3" class="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none resize-y focus:border-brand-500">'+esc(val||'')+'</textarea></div>';
}
function buildForm(w){
  var h=inp('title',w.title,'Title','Widget heading');
  if(w.type==='text') h+=ta('body',w.body,'Body text');
  else if(w.type==='announcement'){
    h+='<div class="flex items-center gap-2 mb-2"><label class="text-xs text-slate-400 w-24 shrink-0">Level</label>'
      +'<select name="level" class="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none">'
      +'<option value="info"'+(w.level==='info'?' selected':'')+'>Info (blue)</option>'
      +'<option value="warning"'+(w.level==='warning'?' selected':'')+'>Warning (yellow)</option>'
      +'<option value="danger"'+(w.level==='danger'?' selected':'')+'>Danger (red)</option>'
      +'</select></div>';
    h+=ta('body',w.body,'Message');
  } else if(w.type==='hours'){
    var days=['mon','tue','wed','thu','fri','sat','sun'],dnames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],hrs=w.hours||{};
    days.forEach(function(d,i){h+=inp('hours_'+d,hrs[d],dnames[i],'e.g. 8:00 AM - 10:00 PM');});
  } else if(w.type==='contact'){
    h+=inp('phone',w.phone,'Phone','+63 912 345 6789');
    h+=inp('email',w.email,'Email','hello@example.com');
    h+=inp('facebook',w.facebook,'Facebook','https://fb.com/...');
    h+=inp('instagram',w.instagram,'Instagram','https://instagram.com/...');
  } else if(w.type==='promo'){
    h+=inp('image_url',w.image_url,'Image URL','https://...');
    h+=inp('caption',w.caption,'Caption','Optional caption');
  } else if(w.type==='html'){
    h+=ta('html',w.html,'HTML content (scripts are stripped on the portal)');
  } else if(w.type==='ads_card'){
    h+=inp('subtitle',w.subtitle,'Subtitle','Submit to inquire');
    h+=inp('contact_email',w.contact_email,'Inquiry email','ads@example.com');
  } else if(w.type==='partner_cta'){
    h+=inp('subtitle',w.subtitle,'CTA subtitle','Become a PAYWIFI Partner Store');
    h+=inp('chip',w.chip,'Chip / badge','Coming Soon');
    h+=ta('rollout',w.rollout,'Rollout message (accessibility / future use)');
    h+=inp('contact_number',w.contact_number,'Contact phone','09xx xxx xxxx');
    h+=inp('contact_email',w.contact_email,'Contact email','hello@example.com');
  } else if(w.type==='youtube'){
    var mode=w.playlist_mode||((w.media_id&&w.media_id!=='auto')?'single':'auto');
    var plist=Array.isArray(w.playlist_ids)?w.playlist_ids.map(String):[];
    h+='<div class="mb-2"><label class="text-xs text-slate-400">Selection mode</label>'
      +'<div class="flex gap-3 mt-1">'
        +'<label class="flex items-center gap-1.5 text-sm"><input type="radio" name="playlist_mode" value="auto" class="accent-brand-500"'+(mode==='auto'?' checked':'')+'> Auto (newest)</label>'
        +'<label class="flex items-center gap-1.5 text-sm"><input type="radio" name="playlist_mode" value="single" class="accent-brand-500"'+(mode==='single'?' checked':'')+'> Single video</label>'
        +'<label class="flex items-center gap-1.5 text-sm"><input type="radio" name="playlist_mode" value="playlist" class="accent-brand-500"'+(mode==='playlist'?' checked':'')+'> Playlist</label>'
      +'</div></div>';
    var sopts='<option value="auto">Auto - newest visible</option>';
    for(var ii=0;ii<MEDIA_ASSETS.length;ii++){
      var ma=MEDIA_ASSETS[ii]; if(ma.status!=='processed'||!ma.visibility) continue;
      var d=ma.duration_sec?' ('+Math.floor(ma.duration_sec/60)+':'+String(ma.duration_sec%60).padStart(2,'0')+')':'';
      sopts+='<option value="'+ma.id+'"'+(String(w.media_id)===String(ma.id)?' selected':'')+'>#'+ma.id+' '+esc(ma.title||ma.video_id)+d+'</option>';
    }
    h+='<div id="yt-single-row" class="flex items-center gap-2 mb-2" style="display:'+(mode==='single'?'flex':'none')+'">'
      +'<label class="text-xs text-slate-400 w-24 shrink-0">Video</label>'
      +'<select name="media_id" class="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none focus:border-brand-500">'+sopts+'</select></div>';
    // Add-video panel — three source types: YouTube, Upload, External URL
    h+='<div class="mb-2 rounded-lg border border-slate-700 bg-slate-950 p-3">'
      +'<div class="flex items-center justify-between mb-2">'
        +'<label class="text-xs font-semibold text-slate-300 flex items-center gap-1.5"><span>\u{1F4E5}</span> Add a video</label>'
        +'<span class="text-[10px] text-slate-500">cached locally · max 30 min</span>'
      +'</div>'
      +'<div class="flex gap-1 text-[10px] mb-2">'
        +'<button type="button" class="yt-src-tab px-2 py-1 rounded bg-brand-500 text-slate-900 font-bold" data-src="yt">YouTube</button>'
        +'<button type="button" class="yt-src-tab px-2 py-1 rounded bg-slate-800 text-slate-300" data-src="up">Upload</button>'
        +'<button type="button" class="yt-src-tab px-2 py-1 rounded bg-slate-800 text-slate-300" data-src="url">External URL</button>'
      +'</div>'
      // YouTube row
      +'<div data-src-pane="yt" class="flex gap-2">'
        +'<input type="text" id="yt-add-url" placeholder="Paste YouTube URL — watch / youtu.be / shorts / embed" class="flex-1 px-2.5 py-2 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none focus:border-brand-500">'
        +'<button type="button" onclick="ytAddVideo()" class="px-4 py-2 rounded bg-brand-500 text-slate-900 text-sm font-bold hover:bg-brand-400">Queue</button>'
      +'</div>'
      // Upload row
      +'<form data-src-pane="up" class="hidden" enctype="multipart/form-data" method="POST" action="/admin/media/upload?_csrf="+encodeURIComponent(CSRF)+">'
        +'<input type="hidden" name="_csrf" value="'+CSRF+'">'
        +'<input type="file" name="file" accept=".mp4,.webm,.m4v,.mov,video/mp4,video/webm,video/x-m4v,video/quicktime" required class="block w-full text-xs text-slate-300 file:mr-2 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-slate-700 file:text-slate-100 file:text-xs file:font-semibold hover:file:bg-slate-600 mb-1.5">'
        +'<div class="flex gap-2">'
          +'<input type="text" name="title" placeholder="Optional title" class="flex-1 px-2.5 py-2 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none focus:border-brand-500">'
          +'<button type="submit" class="px-4 py-2 rounded bg-brand-500 text-slate-900 text-sm font-bold hover:bg-brand-400">Upload</button>'
        +'</div>'
        +'<p class="text-[10px] text-slate-500 mt-1">mp4 / webm / m4v / mov · up to 200 MB · processed immediately</p>'
      +'</form>'
      // External URL row
      +'<form data-src-pane="url" class="hidden" method="POST" action="/admin/media/url-add?_csrf="+encodeURIComponent(CSRF)+">'
        +'<input type="hidden" name="_csrf" value="'+CSRF+'">'
        +'<div class="flex gap-2">'
          +'<input type="url" name="url" required placeholder="https://example.com/video.mp4" class="flex-1 px-2.5 py-2 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 outline-none focus:border-brand-500">'
          +'<button type="submit" class="px-4 py-2 rounded bg-brand-500 text-slate-900 text-sm font-bold hover:bg-brand-400">Fetch</button>'
        +'</div>'
        +'<p class="text-[10px] text-slate-500 mt-1">Must be a direct mp4 / webm / m4v / mov URL — downloaded and cached</p>'
      +'</form>'
      +'<p id="yt-add-msg" class="text-[11px] mt-1.5 hidden"></p>'
    +'</div>';
    // Library counters + filter pills + list
    var cAvail=0,cProg=0,cFail=0;
    MEDIA_ASSETS.forEach(function(m){
      if(m.status==='processed') cAvail++;
      else if(m.status==='failed') cFail++;
      else cProg++; // pending or downloading
    });
    h+='<div class="mb-1.5 flex items-center justify-between">'
      +'<label class="text-xs text-slate-400">Library</label>'
      +'<div class="flex gap-1.5 text-[10px]">'
        +'<span class="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-900" title="Processed and ready">'+cAvail+' ready</span>'
        +'<span class="px-1.5 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-900" title="Pending or downloading">'+cProg+' in progress</span>'
        +'<span class="px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-900" title="Failed — click Retry">'+cFail+' failed</span>'
      +'</div>'
    +'</div>';
    h+='<div class="flex gap-1 mb-1.5 text-[10px]">'
      +'<button type="button" class="yt-filter px-2 py-0.5 rounded bg-brand-500 text-slate-900 font-semibold" data-flt="all">All</button>'
      +'<button type="button" class="yt-filter px-2 py-0.5 rounded bg-slate-800 text-slate-300" data-flt="processed">Ready</button>'
      +'<button type="button" class="yt-filter px-2 py-0.5 rounded bg-slate-800 text-slate-300" data-flt="progress">In progress</button>'
      +'<button type="button" class="yt-filter px-2 py-0.5 rounded bg-slate-800 text-slate-300" data-flt="failed">Failed</button>'
    +'</div>';
    h+='<div id="yt-library" class="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1 mb-2">'
      +(MEDIA_ASSETS.length?MEDIA_ASSETS.map(function(m){return renderMediaRow(m,plist,mode);}).join(''):'<p class="text-xs text-slate-500 px-2 py-3 text-center">No videos yet — paste a YouTube URL above to add one.</p>')
    +'</div>';
    function ytTog(name,val,label,desc){
      return '<div class="flex items-start gap-3 mt-2.5">'
        +'<label class="pw-switch shrink-0 mt-0.5"><input type="checkbox" name="'+name+'" '+(val?' checked':'')+'><span class="pw-switch-track"><span class="pw-switch-thumb"></span></span></label>'
        +'<div class="min-w-0"><label class="block text-sm text-slate-200 font-medium">'+label+'</label>'
        +'<p class="text-[11px] text-slate-500 leading-snug">'+desc+'</p></div></div>';
    }
    h+='<div class="mt-3 pt-2 border-t border-slate-800"><label class="text-xs font-semibold text-slate-300">Playback</label></div>';
    h+=ytTog('autoplay', w.autoplay!==false, 'Autoplay',
      'Start the video automatically when the captive portal loads. Mobile browsers require muted autoplay.');
    h+=ytTog('loop', w.loop!==false, 'Loop',
      'Restart the video automatically each time it ends.');
    h+=ytTog('muted', w.muted===true, 'Muted by default',
      'Start the video silent. If Autoplay is on but Muted is off, the video starts muted then unmutes on the first tap.');
    h+=ytTog('controls', w.controls!==false, 'Show controls',
      'Show the play/pause/seek/volume controls overlay on the video.');
    h+=ytTog('allow_fullscreen', w.allow_fullscreen!==false, 'Allow fullscreen',
      'Let viewers expand the video to fullscreen. Disabling also removes the picture-in-picture button.');
    h+='<div class="flex items-start gap-3 mt-2.5">'
      +'<label class="pw-switch shrink-0 mt-0.5"><input type="checkbox" name="click_to_play" '+(w.click_to_play?' checked':'')+'><span class="pw-switch-track"><span class="pw-switch-thumb"></span></span></label>'
      +'<div class="min-w-0"><label class="block text-sm text-slate-200 font-medium">Click to play</label>'
      +'<p class="text-[11px] text-slate-500 leading-snug">Show a large play button overlay. Disables autoplay. Useful for high-bandwidth or sound-heavy promos.</p></div></div>';
    h+=ytTog('skip_button', !!w.skip_button, 'Show skip button',
      'A "Skip →" button in the corner that lets the viewer hide the video immediately.');
    h+=ytTog('close_button', !!w.close_button, 'Show close button',
      'An "×" in the corner that dismisses the video for this session.');
    var vol = (typeof w.volume === 'number') ? w.volume : 1.0;
    h+='<div class="mt-3"><label class="flex items-center justify-between text-sm text-slate-200"><span>Volume</span><span class="text-xs text-slate-500" id="yt-vol-out">'+Math.round(vol*100)+'%</span></label>'
      +'<input type="range" name="volume" min="0" max="100" step="5" value="'+Math.round(vol*100)+'" oninput="document.getElementById(\'yt-vol-out\').textContent=this.value+\'%\'" class="w-full accent-brand-500 mt-1">'
      +'<p class="text-[11px] text-slate-500">Default volume from 0 (silent) to 100. Has no effect when Muted is on.</p></div>';
    // Scheduling
    var sa = w.start_at ? new Date(w.start_at*1000).toISOString().slice(0,16) : '';
    var ea = w.end_at   ? new Date(w.end_at*1000  ).toISOString().slice(0,16) : '';
    h+='<div class="mt-3 pt-2 border-t border-slate-800"><label class="text-xs font-semibold text-slate-300">Schedule</label>'
      +'<p class="text-[11px] text-slate-500 mb-1.5">Outside this window the widget hides itself automatically. Leave blank for always-on.</p></div>';
    h+='<div class="grid grid-cols-2 gap-2"><div><label class="text-[11px] text-slate-400">Start</label><input type="datetime-local" name="start_at" value="'+sa+'" class="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200"></div>'
      +'<div><label class="text-[11px] text-slate-400">End</label><input type="datetime-local" name="end_at" value="'+ea+'" class="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200"></div></div>';
    // Device rule
    var dr = w.device_rule || 'any';
    h+='<div class="mt-3"><label class="text-xs font-semibold text-slate-300">Device rule</label>'
      +'<p class="text-[11px] text-slate-500 mb-1.5">Only show the video on these devices.</p>'
      +'<select name="device_rule" class="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200">'
      +'<option value="any"'    +(dr==='any'?' selected':'')    +'>Any device</option>'
      +'<option value="mobile"' +(dr==='mobile'?' selected':'') +'>Mobile only</option>'
      +'<option value="desktop"'+(dr==='desktop'?' selected':'')+'>Desktop only</option>'
      +'</select></div>';
    // Partner scope
    var pId = w.partner_id ? String(w.partner_id) : '';
    var pOpts = '<option value=""'+(pId===''?' selected':'')+'>All partners (global)</option>';
    (window.PARTNERS||[]).forEach(function(pp){
      pOpts += '<option value="'+pp.id+'"'+(pId===String(pp.id)?' selected':'')+'>'+esc(pp.partner_name)+'</option>';
    });
    h+='<div class="mt-3"><label class="text-xs font-semibold text-slate-300">Partner scope</label>'
      +'<p class="text-[11px] text-slate-500 mb-1.5">Limit the widget to a specific partner network (future multi-tenant use).</p>'
      +'<select name="partner_id" class="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200">'+pOpts+'</select></div>';
    setTimeout(function(){
      var rs=document.querySelectorAll('#wef [name="playlist_mode"]');
      rs.forEach(function(r){r.addEventListener('change',function(){
        var sr=document.getElementById('yt-single-row'); if(sr) sr.style.display=(r.value==='single'&&r.checked)?'flex':'none';
        document.querySelectorAll('#yt-library .yt-pl-row').forEach(function(el){
          el.style.display=(document.querySelector('#wef [name="playlist_mode"]:checked').value==='playlist')?'flex':'none';
        });
      });});
      // Filter pills — show/hide library rows by status group
      var pills=document.querySelectorAll('#wef .yt-filter');
      pills.forEach(function(b){b.addEventListener('click',function(){
        pills.forEach(function(x){x.classList.remove('bg-brand-500','text-slate-900','font-semibold'); x.classList.add('bg-slate-800','text-slate-300');});
        b.classList.remove('bg-slate-800','text-slate-300'); b.classList.add('bg-brand-500','text-slate-900','font-semibold');
        var flt=b.getAttribute('data-flt');
        document.querySelectorAll('#yt-library [data-mid]').forEach(function(row){
          var st=row.getAttribute('data-status')||'';
          var keep=(flt==='all')
            || (flt==='processed' && st==='processed')
            || (flt==='failed'    && st==='failed')
            || (flt==='progress'  && (st==='pending'||st==='downloading'));
          row.style.display=keep?'':'none';
        });
      });});
      // Tabs: YouTube / Upload / External URL
      var tabs=document.querySelectorAll('#wef .yt-src-tab');
      tabs.forEach(function(t){t.addEventListener('click',function(){
        tabs.forEach(function(x){x.classList.remove('bg-brand-500','text-slate-900','font-bold'); x.classList.add('bg-slate-800','text-slate-300');});
        t.classList.remove('bg-slate-800','text-slate-300'); t.classList.add('bg-brand-500','text-slate-900','font-bold');
        var src=t.getAttribute('data-src');
        document.querySelectorAll('#wef [data-src-pane]').forEach(function(p){
          p.classList.toggle('hidden', p.getAttribute('data-src-pane')!==src);
        });
      });});
    },0);
  }
  if(w.type==='available_plans'||w.type==='status_bar'){
    h+='<div class="flex items-center gap-3 mt-1">'
      +'<input type="checkbox" name="sticky" id="sticky-cb" class="w-4 h-4 accent-brand-500"'+(w.sticky!==false?' checked':'')+'>'
      +'<label for="sticky-cb" class="text-sm text-slate-200 cursor-pointer">Sticky footer <span class="text-slate-500 text-xs">(fixed to bottom of page)</span></label>'
      +'</div>';
  }
  return h;
}
function applyEdit(){
  var w=widgets[editIdx];
  var g=function(n){var el=document.querySelector('#wef [name="'+n+'"]');return el?el.value:'';};
  w.title=g('title');
  if(w.type==='available_plans'||w.type==='status_bar'){
    var scb=document.querySelector('#wef [name="sticky"]');w.sticky=scb?scb.checked:true;
  }
  if(w.type==='text')w.body=g('body');
  else if(w.type==='announcement'){w.body=g('body');w.level=g('level');}
  else if(w.type==='hours'){
    w.hours={};
    ['mon','tue','wed','thu','fri','sat','sun'].forEach(function(d){w.hours[d]=g('hours_'+d);});
  } else if(w.type==='contact'){
    ['phone','email','facebook','instagram'].forEach(function(k){w[k]=g(k);});
  } else if(w.type==='promo'){w.image_url=g('image_url');w.caption=g('caption');}
  else if(w.type==='html'){w.html=g('html');}
  else if(w.type==='ads_card'){w.subtitle=g('subtitle');w.contact_email=g('contact_email');}
  else if(w.type==='partner_cta'){w.subtitle=g('subtitle');w.chip=g('chip');w.rollout=g('rollout');w.contact_number=g('contact_number');w.contact_email=g('contact_email');}
  else if(w.type==='youtube'){
    var pmRb=document.querySelector('#wef [name="playlist_mode"]:checked'); w.playlist_mode=pmRb?pmRb.value:'auto';
    w.media_id=g('media_id')||'auto';
    var plCbs=document.querySelectorAll('#wef .yt-pl-cb:checked'); w.playlist_ids=[].map.call(plCbs,function(cb){return parseInt(cb.value,10);}).filter(Boolean);
    function gc(n){var el=document.querySelector('#wef [name="'+n+'"]'); return el?el.checked:false;}
    w.autoplay         = gc('autoplay');
    w.muted            = gc('muted');
    w.loop             = gc('loop');
    w.controls         = gc('controls');
    w.allow_fullscreen = gc('allow_fullscreen');
    w.click_to_play    = gc('click_to_play');
    w.skip_button      = gc('skip_button');
    w.close_button     = gc('close_button');
    var volEl = document.querySelector('#wef [name="volume"]');
    w.volume = volEl ? (parseInt(volEl.value,10)/100) : 1.0;
    var sa = (document.querySelector('#wef [name="start_at"]')||{}).value || '';
    var ea = (document.querySelector('#wef [name="end_at"]')  ||{}).value || '';
    w.start_at = sa ? Math.floor(new Date(sa).getTime()/1000) : null;
    w.end_at   = ea ? Math.floor(new Date(ea).getTime()/1000) : null;
    var drEl = document.querySelector('#wef [name="device_rule"]');
    w.device_rule = drEl ? drEl.value : 'any';
    var piEl = document.querySelector('#wef [name="partner_id"]');
    w.partner_id = (piEl && piEl.value) ? parseInt(piEl.value,10) : null;
  }
  editIdx=null; render();
}
window.wUp=function(i){
  var sorted=widgets.slice().sort(function(a,b){return a.order-b.order;});
  var pos=sorted.indexOf(widgets[i]);
  if(pos>0){var tmp=widgets[i].order;widgets[i].order=sorted[pos-1].order;sorted[pos-1].order=tmp;}
  render();
};
window.wDown=function(i){
  var sorted=widgets.slice().sort(function(a,b){return a.order-b.order;});
  var pos=sorted.indexOf(widgets[i]);
  if(pos<sorted.length-1){var tmp=widgets[i].order;widgets[i].order=sorted[pos+1].order;sorted[pos+1].order=tmp;}
  render();
};
window.wToggle=function(i,on){widgets[i].enabled=on;render();};
window.wEdit=function(i){editIdx=editIdx===i?null:i;render();};
document.getElementById('btn-wep-apply').addEventListener('click',function(){ applyEdit(); });
document.getElementById('btn-wep-publish').addEventListener('click',function(){
  if(editIdx==null) return;
  widgets[editIdx].enabled = true;
  applyEdit();
  // Auto-save the whole list after publish so the change goes live immediately
  document.getElementById('bsw').click();
});
document.getElementById('btn-wep-cancel').addEventListener('click',function(){editIdx=null;render();});
document.getElementById('btn-wep-delete').addEventListener('click',function(){
  if(editIdx!==null){widgets.splice(editIdx,1);editIdx=null;render();}
});
document.getElementById('btn-add-widget').addEventListener('click',function(){
  var type=document.getElementById('awt').value;
  if(!type)return;
  var maxOrd=widgets.reduce(function(m,w){return Math.max(m,w.order||0);},0);
  var uid=type+'_'+Date.now();
  var w={id:uid,type:type,enabled:true,order:maxOrd+1,title:''};
  if(type==='text')w.body='';
  else if(type==='announcement'){w.body='';w.level='info';}
  else if(type==='hours')w.hours={mon:'',tue:'',wed:'',thu:'',fri:'',sat:'',sun:''};
  else if(type==='contact'){w.phone='';w.email='';w.facebook='';w.instagram='';}
  else if(type==='promo'){w.image_url='';w.caption='';}
  else if(type==='html')w.html='';
  widgets.push(w);
  editIdx=widgets.length-1;
  document.getElementById('awt').value='';
  render();
});
document.getElementById('bsw').addEventListener('click',async function(){
  var btn=document.getElementById('bsw'),st=document.getElementById('wss');
  btn.disabled=true;btn.textContent='Saving...';
  try{
    var r=await fetch('/admin/widgets',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':CSRF},body:JSON.stringify(widgets)});
    var d=await r.json();
    if(d.ok && d.saved_at){
      // Stamp updated_at/by locally so the row meta refreshes without a reload
      widgets.forEach(function(w){ w.updated_at = d.saved_at; w.updated_by_name = d.saved_by || w.updated_by_name; });
      render();
    }
    st.className='text-xs text-center mt-2 '+(d.ok?'text-emerald-400':'text-rose-400');
    st.textContent=d.ok?('✓ Saved by '+(d.saved_by||'admin')):'Error: '+(d.error||'unknown');
  }catch(e){
    st.className='text-xs text-center mt-2 text-rose-400';
    st.textContent='Network error';
  }
  st.classList.remove('hidden');
  setTimeout(function(){st.classList.add('hidden');},4000);
  btn.disabled=false;btn.textContent='Save widget settings';
});

function renderMediaRow(m, plist, mode){
  var stColor={pending:'#94a3b8',downloading:'#0ea5e9',processed:'#10b981',failed:'#f43f5e',disabled:'#64748b'}[m.status]||'#94a3b8';
  var thumb=m.thumbnail_path?'<img src="'+esc(m.thumbnail_path)+'" alt="" style="width:64px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#0f172a">':'<div style="width:64px;height:36px;border-radius:4px;background:#0f172a;display:flex;align-items:center;justify-content:center;font-size:18px;color:#475569;flex-shrink:0">'+(m.status==='downloading'?'\u23F3':'\u2014')+'</div>';
  var dur=m.duration_sec?Math.floor(m.duration_sec/60)+':'+String(m.duration_sec%60).padStart(2,'0'):'';
  var sz=m.file_size?(m.file_size/1024/1024).toFixed(1)+'MB':'';
  var meta=[m.status,dur,sz].filter(Boolean).join(' \u00B7 ');
  var st=(window.MEDIA_STATS && window.MEDIA_STATS[m.id]) || {};
  var nView=st.view_start||0, nDone=st.view_complete||0, nSkip=st.skip||0;
  var statsChip = (nView||nDone||nSkip) ? '<span class="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5"><span title="Views">\u25B6\uFE0E'+nView+'</span> <span title="Completed">\u2713'+nDone+'</span>'+(nSkip?' <span title="Skips">skip:'+nSkip+'</span>':'')+'</span>' : '';
  var inPlist=plist.indexOf(String(m.id))>=0;
  var canPlay=m.status==='processed'&&m.visibility;
  var plCb='<label class="yt-pl-row flex items-center gap-1 text-[11px] text-slate-300" style="display:'+(mode==='playlist'?'flex':'none')+'"><input type="checkbox" class="yt-pl-cb w-3.5 h-3.5 accent-brand-500" value="'+m.id+'"'+(inPlist?' checked':'')+(canPlay?'':' disabled')+'>'+(canPlay?'in playlist':'not ready')+'</label>';
  var actions='';
  if(m.status==='processed') actions+='<button type="button" onclick="ytToggleVis('+m.id+','+(m.visibility?0:1)+',this)" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300" title="'+(m.visibility?'Hide':'Show')+'">'+(m.visibility?'Hide':'Show')+'</button>';
  if(m.status==='failed') actions+='<button type="button" onclick="ytRetry('+m.id+',this)" class="px-2 py-0.5 rounded bg-amber-900 hover:bg-amber-800 text-[10px] text-amber-200" title="Retry">Retry</button>';
  actions+='<button type="button" onclick="ytDelete('+m.id+',this)" class="px-2 py-0.5 rounded bg-rose-900 hover:bg-rose-800 text-[10px] text-rose-200" title="Delete">Delete</button>';
  return '<div class="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-900 border border-slate-800" data-mid="'+m.id+'" data-status="'+m.status+'">'
    +thumb
    +'<div class="flex-1 min-w-0">'
      +'<div class="text-xs text-slate-200 font-medium truncate" title="'+esc(m.title||m.video_id)+'">#'+m.id+' '+esc(m.title||m.video_id||'(no title)')+'</div>'
      +'<div class="text-[10px] flex items-center gap-1"><span style="color:'+stColor+'">'+esc(meta)+'</span>'+(m.error?'<span class="text-rose-400 truncate" title="'+esc(m.error)+'"> err</span>':'')+'</div>'
    +statsChip
    +'</div>'
    +plCb
    +'<div class="flex gap-1 shrink-0">'+actions+'</div>'
  +'</div>';
}
async function ytAddVideo(){
  var inp=document.getElementById('yt-add-url'), msg=document.getElementById('yt-add-msg');
  var url=(inp&&inp.value||'').trim();
  if(!url){ msg.className='text-[11px] mt-1.5 text-rose-400'; msg.textContent='Paste a YouTube URL first.'; msg.classList.remove('hidden'); return; }
  msg.className='text-[11px] mt-1.5 text-slate-400'; msg.textContent='Queueing...'; msg.classList.remove('hidden');
  try{
    var fd=new FormData(); fd.append('url',url); fd.append('_csrf',CSRF);
    var r=await fetch('/admin/media/add',{method:'POST',body:fd,credentials:'same-origin',redirect:'manual'});
    msg.className='text-[11px] mt-1.5 text-emerald-400'; msg.textContent='\u2713 Queued. Refresh the page in 30-60 sec to see it processed.';
    if(inp) inp.value='';
  }catch(e){
    msg.className='text-[11px] mt-1.5 text-rose-400'; msg.textContent='Network error: '+e.message;
  }
}
async function ytToggleVis(id, want, btn){
  try{
    var fd=new FormData(); fd.append('value',String(want)); fd.append('_csrf',CSRF);
    await fetch('/admin/media/'+id+'/visibility',{method:'POST',body:fd,credentials:'same-origin',redirect:'manual'});
    btn.textContent=want?'Hide':'Show';
    btn.setAttribute('onclick','ytToggleVis('+id+','+(want?0:1)+',this)');
  }catch(e){}
}
async function ytRetry(id, btn){
  try{
    var fd=new FormData(); fd.append('_csrf',CSRF);
    await fetch('/admin/media/'+id+'/retry',{method:'POST',body:fd,credentials:'same-origin',redirect:'manual'});
    btn.textContent='Queued';
    btn.disabled=true;
  }catch(e){}
}
async function ytDelete(id, btn){
  if(!confirm('Delete media #'+id+'? This removes the cached files too.'))return;
  try{
    var fd=new FormData(); fd.append('_csrf',CSRF);
    await fetch('/admin/media/'+id+'/delete',{method:'POST',body:fd,credentials:'same-origin',redirect:'manual'});
    var row=btn.closest('[data-mid]'); if(row) row.remove();
  }catch(e){}
}

render();
})();
