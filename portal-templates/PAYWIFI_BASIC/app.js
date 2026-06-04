/* PAYWIFI_BASIC — dumb-portal client logic (GCASH-CASH-SUBSTRING-FIX + CHECKOUT-FIXES-2026-05-30 + CREATE-RESP-SHAPE-2026-05-30 + IN-WIZARD-CTA-2026-05-30 + GCASH-MIRROR-CASH-2026-05-30 + PAY-INFLIGHT-LOCK-2026-05-30 + LOCAL-QR-2026-05-30 + RETURN-FIXES-2026-05-30 + DESIGN-B-2026-05-30 + REMAINING-FIXES-2026-05-30 + QR-FIRST-CLASS-2026-05-30 + QR-SCANNABLE-2026-05-30 + AUTO-REDIRECT-2026-05-30 + CONFIRM-LOCK-2026-05-31 + CONFIRM-LOCK-2026-05-31-ZERO + PLAN-CARD-2026-05-31 + ALREADY-PAID-LINK-2026-05-31 + PENDING-DETAILS-2026-05-31 + PHONE-HOIST-2026-05-31 + DROP-PAID-LINK-2026-05-31 + DROP-PHONE-WIDGET-2026-05-31 + CANCEL-FIELD-FIX-2026-05-31 + MISMATCH-LOCK-2026-05-31 + CX-CANCELLED-CONFIRM-2026-05-31 + CX-POLISH-2026-05-31 + ANDROID-INTENT-2026-05-31 + SMS-PHONE-FIX-2026-06-01 + MULTI-FIX-2026-06-01 + CASH-STORE-REDESIGN-2026-06-01)
 *
 * Vanilla JS that talks ONLY to /api/* on the same origin (proxied by
 * nginx to the existing PAYWIFI Node service on 127.0.0.1:3000). The HTML
 * layout mirrors templates/paywifi-theme-basic class-for-class; this file
 * is the wiring.
 */

const API = ""; // same-origin

/* ------------------------------ http helpers ------------------------------ */

async function apiGet(path) {
  const r = await fetch(`${API}/api${path}`, { credentials: "include" });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${API}/api${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

const $ = (id) => document.getElementById(id);

function show(viewId) {
  document.querySelectorAll(".view").forEach(el => el.classList.add("hidden"));
  const v = $(viewId);
  if (v) v.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ------------------------------ formatting ------------------------------ */

// Display format is XXXX-XXXX-XXXX (matches source visual). On submit we
// strip dashes — the existing backend stores 8-char alnum codes (see
// /api/portal/config.voucher).
function formatVoucherCode(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return clean.match(/.{1,4}/g)?.join("-") || "";
}
function rawVoucherCode(displayed) {
  return String(displayed || "").replace(/-/g, "");
}

function fmtPHP(n) { return `₱${Number(n).toFixed(0)}`; }

function humanBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

/* ------------------------------ state ------------------------------ */

const state = {
  config: null,
  plans: [],
  paymentOptions: [],
  storePartners: [],
  session: null,
  selectedPlan: null,
  selectedMethod: null,
  paymentId: null,
  paymentPollTimer: null,
};

/* ------------------------------ icon lookup ------------------------------ */

// Map an /api/portal/payment-options item to a lucide icon symbol id.
// `icon_key` comes from the backend (mobile/qr/wallet/cash). Fall back by
// name match.
function methodIconId(opt) {
  const k = String(opt.icon_key || "").toLowerCase();
  if (k === "mobile") return "icon-smartphone";
  if (k === "qr")     return "icon-qr-code";
  if (k === "wallet") return "icon-wallet";
  if (k === "cash" || k === "banknote") return "icon-banknote";
  const n = String(opt.name || "").toLowerCase();
  if (/\bcash\b/i.test(opt.name || "")) return "icon-banknote";
  if (n.includes("qr"))       return "icon-qr-code";
  if (n.includes("gcash") || n.includes("maya") || n.includes("pay")) return "icon-wallet";
  if (n.includes("card"))     return "icon-credit-card";
  return "icon-smartphone";
}

/* ------------------------------ branding ------------------------------ */

function findWidget(type) {
  var ws = (state.config && state.config.widgets) || [];
  for (var i = 0; i < ws.length; i++) if (ws[i].type === type) return ws[i];
  return null;
}

function hydratePortalSidebarWidgets() {
  // PORTAL-WIDGET-2026-06-03 — both 'Your Ads Here' and 'Partner with Us'
  // are managed in /admin/widgets. Enabled flag + all fields come from the
  // widget config; legacy partner_* settings remain a fallback.
  try {
    var ads = findWidget("ads_card");
    var adsBtn = $("ads-widget");
    if (adsBtn) {
      if (ads && ads.enabled === false) {
        adsBtn.classList.add("hidden");
      } else {
        adsBtn.classList.remove("hidden");
        var adsTitle = adsBtn.querySelector("p.text-lg");
        var adsSub   = adsBtn.querySelector("p.text-sm");
        if (ads && adsTitle) adsTitle.textContent = ads.title    || "Your Ads Here";
        if (ads && adsSub)   adsSub.textContent   = ads.subtitle || "Submit to inquire";
      }
    }

    var pcw = findWidget("partner_cta");
    var legacy = (state.config && state.config.partner) || {};
    var pBtn  = $("partner-widget");
    var pSub  = $("partner-widget-sub");
    var pChip = $("partner-widget-chip");
    if (pBtn) {
      if (pcw && pcw.enabled === false) {
        pBtn.classList.add("hidden");
      } else {
        pBtn.classList.remove("hidden");
        var pTitle = pBtn.querySelector("p.text-lg");
        var title    = (pcw && pcw.title)    || "Partner with Us";
        var subtitle = (pcw && pcw.subtitle) || legacy.cta_text             || "Become a PAYWIFI Partner";
        var chipTxt  = (pcw && pcw.chip)     || legacy.availability_status  || "";
        var rollout  = (pcw && pcw.rollout)  || legacy.rollout_message      || "";
        if (pTitle) pTitle.textContent = title;
        if (pSub)   pSub.textContent   = subtitle;
        if (pChip) {
          if (chipTxt) { pChip.textContent = chipTxt; pChip.classList.remove("hidden"); }
          else         { pChip.classList.add("hidden"); }
        }
        if (rollout) pBtn.setAttribute("aria-label", "Partner with us — " + rollout);
      }
    }

    // YOUTUBE-WIDGET-2026-06-03 — full playback surface (controls/fullscreen/
    // volume/click-to-play/skip/close) + error fallback. Hidden if disabled,
    // device-rule rejects, or media isn't resolved.
    var yt    = findWidget("youtube");
    var ytCard  = $("youtube-widget");
    var ytVid   = $("youtube-widget-video");
    var ytPlay  = $("youtube-widget-play");
    var ytSkip  = $("youtube-widget-skip");
    var ytClose = $("youtube-widget-close");
    var ytErr   = $("youtube-widget-error");
    var ytFrame = $("youtube-widget-frame");
    if (ytCard && ytVid) {
      var media = yt && yt.media;
      // Honour a per-session dismissal triggered by the close button.
      var dismissedKey = "pw_yt_dismiss_" + (media && media.id ? media.id : "any");
      var dismissed = false;
      try { dismissed = sessionStorage.getItem(dismissedKey) === "1"; } catch (e) {}
      // Device-rule check (mobile/desktop/any). UA-based — good enough for the
      // captive-portal use case where we don't need pixel-perfect detection.
      var isMobile = /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
      var deviceOk = !yt || !yt.device_rule || yt.device_rule === "any"
                     || (yt.device_rule === "mobile"  && isMobile)
                     || (yt.device_rule === "desktop" && !isMobile);
      var ok = yt && yt.enabled !== false && media && media.file_path && !dismissed && deviceOk;
      if (ok) {
        ytCard.classList.remove("hidden");
        if (media.thumbnail_path) ytVid.setAttribute("poster", media.thumbnail_path);
        ytVid.setAttribute("src", media.file_path);
        var wantClickToPlay = !!yt.click_to_play;
        var wantAutoplay    = !wantClickToPlay && (yt.autoplay !== false);
        // Browsers require muted for autoplay. If admin wants sound + autoplay,
        // mute on first load and unmute on the first user interaction.
        var wantMuted = (yt.muted === true) || (wantAutoplay && yt.muted !== false);
        ytVid.muted    = wantMuted;
        ytVid.loop     = !!yt.loop;
        ytVid.autoplay = wantAutoplay;
        ytVid.controls = (yt.controls !== false);
        if (yt.allow_fullscreen === false) {
          ytVid.setAttribute("controlslist", "nofullscreen nodownload");
          ytVid.setAttribute("disablepictureinpicture", "true");
        } else {
          ytVid.removeAttribute("controlslist");
          ytVid.removeAttribute("disablepictureinpicture");
        }
        // Volume — clamp 0..1
        var vol = (typeof yt.volume === "number") ? yt.volume : 1.0;
        ytVid.volume = Math.max(0, Math.min(1, vol));
        // Skip + Close overlay buttons
        if (ytSkip)  ytSkip.classList.toggle("hidden",  !yt.skip_button);
        if (ytClose) ytClose.classList.toggle("hidden", !yt.close_button);
        // Click-to-play overlay
        if (ytPlay) ytPlay.classList.toggle("hidden", !wantClickToPlay);
        if (ytErr)  ytErr.classList.add("hidden");
        // Autoplay kick
        if (wantAutoplay) {
          var tryPlay = function() { try { ytVid.play().catch(function(){}); } catch (e) {} };
          if (ytVid.readyState >= 2) tryPlay();
          else ytVid.addEventListener("loadedmetadata", tryPlay, { once: true });
        }
        // Click-to-play handler
        if (ytPlay && wantClickToPlay) {
          ytPlay.onclick = function() {
            ytPlay.classList.add("hidden");
            try { ytVid.muted = (yt.muted === true); ytVid.play().catch(function(){}); } catch (e) {}
          };
        }
        // Skip = stop + collapse the player (keeps the card visible if anything else needs it)
        if (ytSkip) ytSkip.onclick = function() {
          try { ytVid.pause(); } catch (e) {}
          ytCard.classList.add("hidden");
          ytTrack("skip");
        };
        // Close = dismiss for the session
        if (ytClose) ytClose.onclick = function() {
          try { ytVid.pause(); } catch (e) {}
          try { sessionStorage.setItem(dismissedKey, "1"); } catch (e) {}
          ytCard.classList.add("hidden");
          ytTrack("close");
        };
        // Sound-on-tap: if autoplay started muted but admin wants sound, unmute
        // the moment the user taps anywhere in the frame.
        if (wantAutoplay && yt.muted === false && wantMuted && ytFrame) {
          var unmuteOnce = function() {
            try { ytVid.muted = false; } catch (e) {}
            ytFrame.removeEventListener("click",   unmuteOnce);
            ytFrame.removeEventListener("touchstart", unmuteOnce);
          };
          ytFrame.addEventListener("click",      unmuteOnce, { once: true });
          ytFrame.addEventListener("touchstart", unmuteOnce, { once: true });
        }
        // Analytics event hooks (sendBeacon-backed; defined below)
        ytVid.addEventListener("playing", function() { ytTrack("view_start"); }, { once: true });
        ytVid.addEventListener("ended",   function() { ytTrack("view_complete"); });
        ytVid.addEventListener("error",   function() {
          console.warn("[yt-widget] video error", (ytVid.error && ytVid.error.code), "media=", media && media.id);
          if (ytErr) ytErr.classList.remove("hidden");
          ytTrack("error");
        });


        function ytTrack(event) {
          try {
            var body = JSON.stringify({ media_id: media && media.id, widget_id: yt && yt.id, event: event });
            if (navigator.sendBeacon) {
              var blob = new Blob([body], { type: "application/json" });
              navigator.sendBeacon("/api/portal/media/track", blob);
            } else {
              fetch("/api/portal/media/track", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" }, body: body, keepalive: true
              }).catch(function() {});
            }
          } catch (e) {}
        }
      } else {
        ytCard.classList.add("hidden");
      }
    }

    // LIVE-NEWS-2026-06-04 (NAV) — inline HLS player with overlay channel navigation.
    // The server picks an initial "best" stream; once the user navigates (arrows),
    // the choice locks for the session. The 30s status poll then refreshes only
    // the CURRENT channel's badge/title — never reshuffles.
    var ln = findWidget("live_news");
    var lnCard   = $("live-news-widget");
    var lnVid    = $("live-news-video");
    var lnThumb  = $("live-news-thumb");
    var lnStatus = $("live-news-status");
    var lnStatusText = $("live-news-status-text");
    var lnReplay = $("live-news-replay");
    var lnChannel= $("live-news-channel");
    var lnNow    = $("live-news-now");
    var lnUnmute = $("live-news-unmute");
    var lnPrev   = $("live-news-prev");
    var lnNext   = $("live-news-next");
    var lnError  = $("live-news-error");

    if (lnCard) {
      var sources = (ln && Array.isArray(ln.sources_full)) ? ln.sources_full : (ln && ln.stream ? [ln.stream] : []);
      // Only sources that we can actually play (need hls_url) are part of the nav cycle.
      var playable = sources.filter(function(s){ return s && s.hls_url; });
      // If no playable sources, fall back to the picked stream (metadata only).
      if (!playable.length && ln && ln.stream) playable = [ln.stream];
      if (ln && ln.enabled !== false && playable.length) {
        lnCard.classList.remove("hidden");
        // Lock-on-pick — once the user navigates, stay on that channel.
        if (state.liveNewsLocked && state.liveNewsCurrentKey) {
          var idxFromState = playable.findIndex(function(s){ return s.source_key === state.liveNewsCurrentKey; });
          if (idxFromState >= 0) state.liveNewsIdx = idxFromState;
          // else: the locked channel disappeared — fall through to picker default.
        }
        if (typeof state.liveNewsIdx !== "number" || state.liveNewsIdx >= playable.length) {
          state.liveNewsIdx = 0;
        }
        var paint = function() {
          var cur = playable[state.liveNewsIdx];
          if (!cur) return;
          state.liveNewsCurrentKey = cur.source_key;

          // Thumbnail (poster) — refreshes per channel switch
          if (lnThumb) {
            lnThumb.style.display = "";
            if (cur.thumbnail_url) {
              lnThumb.src = cur.thumbnail_url;
              lnThumb.onerror = function() {
                this.onerror = null;
                this.src = cur.video_id ? ("https://i.ytimg.com/vi/" + cur.video_id + "/hqdefault.jpg") : "";
              };
            }
          }

          if (lnChannel) lnChannel.textContent = cur.channel_name || cur.source_key || "Live Channel";

          // Status badge
          var status = String(cur.live_status || "").toLowerCase();
          var badgeText = "STREAM", badgeColor = "bg-slate-600 text-white", pulse = false;
          if (status === "is_live")          { badgeText = "LIVE";     badgeColor = "bg-rose-600 text-white"; pulse = true;  }
          else if (status === "is_upcoming") { badgeText = "UPCOMING"; badgeColor = "bg-sky-600 text-white";  pulse = false; }
          else if (status === "was_live" || status === "post_live") { badgeText = "REPLAY"; badgeColor = "bg-amber-500 text-black"; pulse = false; }
          if (lnStatus) {
            lnStatus.className =
              "absolute top-2 left-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider backdrop-blur " + badgeColor;
            var dot = lnStatus.querySelector("span:first-child");
            if (dot) dot.style.display = pulse ? "" : "none";
          }
          if (lnStatusText) lnStatusText.textContent = badgeText;

          // Replay badge (driven by original-title regex)
          if (lnReplay) {
            if (cur.has_replay) lnReplay.classList.remove("hidden");
            else                lnReplay.classList.add("hidden");
          }

          // (publish date removed per VIS-3)

          // Arrow visibility (only show if there is more than one channel to switch to)
          if (lnPrev) lnPrev.classList.toggle("hidden", playable.length < 2);
          if (lnNext) lnNext.classList.toggle("hidden", playable.length < 2);

          // Attach HLS
          if (lnError) lnError.classList.add("hidden");
          if (lnVid && cur.hls_url) {
            // SOUND-ON-DEFAULT-2026-06-04 — try unmuted autoplay first. If the
            // browser blocks it (no prior user gesture), fall back to muted + unmute overlay.
            var startMuted = !state.liveNewsUserInteracted;
            lnVid.muted = startMuted;
            lnVid.autoplay = true;
            lnVid.playsInline = true;
            lnVid.volume = 1.0;
            // Tear down previous hls.js instance before reattaching
            try { if (window.__pwHls) { window.__pwHls.destroy(); window.__pwHls = null; } } catch (e) {}

            function attachHlsFor(url) {
              // Native HLS path (Safari/iOS)
              if (lnVid.canPlayType("application/vnd.apple.mpegurl")) {
                lnVid.src = url;
                lnVid.play().catch(function(err){
                  // Autoplay-with-sound rejected → fall back to muted + show unmute overlay
                  try { lnVid.muted = true; lnVid.play().catch(function(){}); } catch (e) {}
                  if (lnUnmute) lnUnmute.classList.remove("hidden");
                });
                return;
              }
              function go() {
                try {
                  var hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true });
                  window.__pwHls = hls;
                  hls.loadSource(url);
                  hls.attachMedia(lnVid);
                  hls.on(window.Hls.Events.MANIFEST_PARSED, function(){
                    lnVid.play().catch(function(err){
                      // Autoplay-with-sound rejected → fall back to muted + show unmute overlay
                      try { lnVid.muted = true; lnVid.play().catch(function(){}); } catch (e) {}
                      if (lnUnmute) lnUnmute.classList.remove("hidden");
                    });
                  });
                  hls.on(window.Hls.Events.ERROR, function(_, data){
                    if (data && data.fatal) {
                      console.warn("[live-news] hls fatal", data.type, data.details);
                      if (lnError) lnError.classList.remove("hidden");
                    }
                  });
                } catch (e) {
                  if (lnError) lnError.classList.remove("hidden");
                }
              }
              if (window.Hls) { go(); }
              else {
                var hjs = document.createElement("script");
                hjs.src = "/hls.js"; hjs.async = true;
                hjs.onload = go;
                hjs.onerror = function(){ if (lnError) lnError.classList.remove("hidden"); };
                document.head.appendChild(hjs);
              }
            }
            attachHlsFor(cur.hls_url);
            // Hide thumbnail once playback starts
            lnVid.onplaying = function() { if (lnThumb) lnThumb.style.display = "none"; };
          }
        };
        paint();

        // Navigation
        function cycleBy(delta) {
          if (!playable.length) return;
          state.liveNewsIdx = ((state.liveNewsIdx + delta) % playable.length + playable.length) % playable.length;
          state.liveNewsLocked = true;
          // SOUND-ON-DEFAULT-2026-06-04 — prev/next click is a user gesture, so
          // we can autoplay with sound on the new channel. Mark the flag, repaint,
          // then explicitly unmute + play after the HLS attach has settled.
          state.liveNewsUserInteracted = true;
          paint();
          if (lnUnmute) lnUnmute.classList.add("hidden");
          // Force unmute on the freshly-attached video (paint() reset muted to false
          // already because userInteracted is now true, but this guarantees it).
          try {
            lnVid.muted = false;
            lnVid.volume = 1.0;
            var pp = lnVid.play();
            if (pp && pp.catch) pp.catch(function(){});
          } catch (e) {}
        }
        if (lnPrev) lnPrev.onclick = function(e){ e.preventDefault(); e.stopPropagation(); cycleBy(-1); };
        if (lnNext) lnNext.onclick = function(e){ e.preventDefault(); e.stopPropagation(); cycleBy(1); };

        // Tap-to-unmute (any first user gesture on the page) — same as before
        function unmuteNow() {
          state.liveNewsUserInteracted = true;
          try { lnVid.muted = false; lnVid.volume = 1.0; lnVid.play().catch(function(){}); } catch (e) {}
          if (lnUnmute) lnUnmute.classList.add("hidden");
          document.removeEventListener("click", unmuteOnce, true);
          document.removeEventListener("touchstart", unmuteOnce, true);
        }
        function unmuteOnce() { unmuteNow(); }
        if (lnUnmute) lnUnmute.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); unmuteNow(); });
        if (!state.__lnUnmuteHooked) {
          state.__lnUnmuteHooked = true;
          document.addEventListener("click", unmuteOnce, { capture: true, once: true });
          document.addEventListener("touchstart", unmuteOnce, { capture: true, once: true });
        }

        // Real-time clock — single global interval
        function pwLiveTick() {
          if (!lnNow) return;
          // VIS-3-2026-06-04 — show current time in Asia/Manila, 12-hour format.
          try {
            var s = new Date().toLocaleTimeString("en-US", {
              timeZone: "Asia/Manila",
              hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
            });
            lnNow.textContent = s + " Manila";
          } catch (e) {
            // Older browsers without timezone support — fall back to local 12-hour
            var n = new Date();
            var h = n.getHours();
            var ap = h >= 12 ? "PM" : "AM";
            h = ((h + 11) % 12) + 1;
            var mm = String(n.getMinutes()).padStart(2,"0");
            var ss = String(n.getSeconds()).padStart(2,"0");
            lnNow.textContent = h + ":" + mm + ":" + ss + " " + ap;
          }
        }
        pwLiveTick();
        if (!window.__pwLiveTickTimer) window.__pwLiveTickTimer = setInterval(pwLiveTick, 1000);

        // Status poll — refresh CURRENT channel data only; never reshuffle.
        if (!window.__pwLiveStatusPollTimer) {
          window.__pwLiveStatusPollTimer = setInterval(function(){
            fetch("/api/portal/config", { cache: "no-store" }).then(function(r){ return r.json(); }).then(function(cfg){
              if (!cfg || !cfg.widgets) return;
              var lnNew = null;
              for (var i=0;i<cfg.widgets.length;i++) {
                if (cfg.widgets[i].type === "live_news") { lnNew = cfg.widgets[i]; break; }
              }
              if (!lnNew) return;
              // Find the currently shown channel in the new list. If gone, keep showing the cached state.
              var newPlayable = (lnNew.sources_full || []).filter(function(s){ return s && s.hls_url; });
              if (!newPlayable.length) return;
              var keepIdx = -1;
              if (state.liveNewsCurrentKey) {
                keepIdx = newPlayable.findIndex(function(s){ return s.source_key === state.liveNewsCurrentKey; });
              }
              if (keepIdx >= 0) {
                // The channel is still alive. Update just its metadata (badge, publish, thumbnail).
                var cur = newPlayable[keepIdx];
                // Update badge
                var status = String(cur.live_status || "").toLowerCase();
                var bt = "STREAM", bc = "bg-slate-600 text-white", pl = false;
                if (status === "is_live")          { bt = "LIVE";     bc = "bg-rose-600 text-white"; pl = true;  }
                else if (status === "is_upcoming") { bt = "UPCOMING"; bc = "bg-sky-600 text-white";  pl = false; }
                else if (status === "was_live" || status === "post_live") { bt = "REPLAY"; bc = "bg-amber-500 text-black"; pl = false; }
                if (lnStatus) {
                  lnStatus.className =
                    "absolute top-2 left-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider backdrop-blur " + bc;
                  var dot = lnStatus.querySelector("span:first-child");
                  if (dot) dot.style.display = pl ? "" : "none";
                }
                if (lnStatusText) lnStatusText.textContent = bt;
                if (lnReplay) lnReplay.classList.toggle("hidden", !cur.has_replay);
                // Refresh the local playable list in case other channels' status changed,
                // but DO NOT reshuffle the current selection.
                playable = newPlayable;
                state.liveNewsIdx = keepIdx;
                if (lnPrev) lnPrev.classList.toggle("hidden", playable.length < 2);
                if (lnNext) lnNext.classList.toggle("hidden", playable.length < 2);
              }
            }).catch(function(){});
          }, 30000);
        }
      } else {
        lnCard.classList.add("hidden");
      }
    }
  } catch (e) { /* non-critical */ }
}

// Back-compat alias
function hydratePartnerWidget() { hydratePortalSidebarWidgets(); }

function applyBranding() {
  const c = state.config || {};
  const portalName = (c.branding && c.branding.portal_name) || (c.app && c.app.name) || "PAYWIFI";
  const brandColor = c.branding && c.branding.brand_color;
  const tagline = (c.app && c.app.tagline) || "Enter your voucher code";

  document.querySelectorAll(".brand-name").forEach(el => { el.textContent = portalName; });
  document.querySelectorAll(".brand-tagline").forEach(el => { el.textContent = tagline; });
  document.title = `${portalName} — Connect`;

  if (brandColor) {
    document.documentElement.style.setProperty("--primary", brandColor);
    document.documentElement.style.setProperty("--ring", brandColor);
  }

  // "No voucher? Plans from ₱X" — use the cheapest plan price.
  if (state.plans.length) {
    const cheapest = state.plans.reduce((m, p) => p.price < m.price ? p : m, state.plans[0]);
    const sub = $("no-voucher-sub");
    if (sub) sub.textContent = `Plans from ${fmtPHP(cheapest.price)}`;
  }
}

/* ------------------------------ skeletons ------------------------------ */

function renderPlansSkeleton() {
  const list = $("plans-list");
  list.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement("div");
    sk.setAttribute("aria-hidden", "true");
    sk.className = "w-full flex-1 rounded-2xl border-2 border-border bg-card animate-pulse p-5 flex items-center gap-3 min-w-0";
    sk.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="h-6 w-24 bg-muted rounded"></div>
        <div class="h-4 w-40 bg-muted rounded mt-2"></div>
      </div>
      <div class="h-8 w-16 bg-muted rounded shrink-0"></div>
    `;
    list.appendChild(sk);
  }
}

/* ------------------------------ views ------------------------------ */

function showHome() {
  stopHealthPolling();
  _stopLockoutTimer();
  show("view-home");
  const inp = $("voucher-input");
  if (inp) { inp.value = ""; setTimeout(() => inp.focus({ preventScroll: true }), 50); }
}

function showPlans() {
  show("view-plans");
  if (!state.plans.length) {
    renderPlansSkeleton();
  } else {
    renderPlansList();
  }
}

function renderPlansList() {
  const list = $("plans-list");
  list.innerHTML = "";
  if (!state.plans.length) {
    const empty = document.createElement("div");
    empty.className = "rounded-2xl border-2 border-border bg-card p-5 text-center text-muted-foreground";
    empty.textContent = "No plans available right now. Please try again later.";
    list.appendChild(empty);
    return;
  }
  for (const p of state.plans) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "w-full text-left rounded-2xl border-2 border-border bg-card hover:border-primary active:scale-[0.99] transition-all p-5 flex items-center gap-3 min-w-0";
    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-xl font-bold truncate">${escapeHtml(p.duration_label || p.name)}</p>
        <p class="text-xs text-muted-foreground mt-0.5 truncate">${escapeHtml(p.name)} · ${escapeHtml(p.speed || "")}</p>
      </div>
      <p class="text-xl font-bold text-primary shrink-0 tabular-nums">${fmtPHP(p.price)}</p>
    `;
    card.addEventListener("click", () => onPickPlan(p));
    list.appendChild(card);
  }
}

/* ─── REM-3/REM-4/REM-5 wire-ups for existing PAYWIFI endpoints ─── */

let _healthPollTimer = null;
let _payBtnLabelDefault = "Pay now";
async function pollHealthOnce() {
  const alertEl = $("checkout-alert");
  const alertTx = $("checkout-alert-text");
  const submit  = $("checkout-submit");
  let online = true;
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (j) online = j.ok !== false && j.wan_online !== false;
  } catch (_) { online = false; }
  if (!online) {
    if (alertEl) {
      alertEl.classList.remove("hidden");
      if (alertTx) alertTx.textContent = "Server is offline — payments and vouchers unavailable.";
    }
    if (submit) { submit.disabled = true; submit.textContent = "Reconnecting\u2026"; }
  } else {
    if (alertEl && alertEl.querySelector && !alertEl.dataset.kind) alertEl.classList.add("hidden");
    if (submit && submit.textContent === "Reconnecting\u2026") {
      submit.textContent = _payBtnLabelDefault;
      validateCheckout();
    }
  }
}
function startHealthPolling() {
  stopHealthPolling();
  _healthPollTimer = setInterval(pollHealthOnce, 10000);
  pollHealthOnce();
}
function stopHealthPolling() {
  if (_healthPollTimer) { clearInterval(_healthPollTimer); _healthPollTimer = null; }
}

let _lockoutTimer = null;
function _fmtMSS(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function _ensureLockoutBanner() {
  let b = $("checkout-lockout");
  if (b) return b;
  b = document.createElement("div");
  b.id = "checkout-lockout";
  b.className = "flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive hidden";
  b.innerHTML = `
    <svg class="h-3.5 w-3.5 shrink-0" aria-hidden="true"><use href="#icon-circle-alert"/></svg>
    <span data-lockout-text></span>
  `;
  const alertEl = $("checkout-alert");
  if (alertEl && alertEl.parentNode) alertEl.parentNode.insertBefore(b, alertEl.nextSibling);
  return b;
}
function _stopLockoutTimer() {
  if (_lockoutTimer) { clearInterval(_lockoutTimer); _lockoutTimer = null; }
}
async function bindLockoutBanner() {
  const banner = _ensureLockoutBanner();
  const submit = $("checkout-submit");
  try {
    const r = await apiGet("/portal/payment/rl-status");
    if (!r || !r.ok || !r.limited) { banner.classList.add("hidden"); _stopLockoutTimer(); return; }
    let secs = Math.max(0, r.retry_after || r.cancel_cooldown || 60);
    banner.classList.remove("hidden");
    const setLabel = () => {
      banner.querySelector("[data-lockout-text]").textContent =
        `Multiple payment attempts detected. Please try again in ${_fmtMSS(secs)}.`;
    };
    setLabel();
    if (submit) { submit.disabled = true; submit.textContent = `Locked \u00b7 ${_fmtMSS(secs)}`; }
    _stopLockoutTimer();
    _lockoutTimer = setInterval(() => {
      secs -= 1;
      if (secs <= 0) {
        _stopLockoutTimer();
        banner.classList.add("hidden");
        if (submit) { submit.textContent = _payBtnLabelDefault; validateCheckout(); }
        return;
      }
      setLabel();
      if (submit) submit.textContent = `Locked \u00b7 ${_fmtMSS(secs)}`;
    }, 1000);
  } catch (_) { banner.classList.add("hidden"); }
}

function _ensureResumeSlot() {
  let s = $("checkout-resume");
  if (s) return s;
  s = document.createElement("div");
  s.id = "checkout-resume";
  s.className = "hidden";
  const methods = $("methods-list");
  if (methods && methods.parentNode) methods.parentNode.insertBefore(s, methods);
  return s;
}
async function bindResumePending() {
  const slot = _ensureResumeSlot();
  slot.classList.add("hidden");
  slot.innerHTML = "";
  try {
    const r = await apiGet("/portal/payment/pending");
    if (!r || !r.ok || !r.pending) return;
    const p = r.payment || r;
    const amount = p.amount || p.vp_price || 0;
    const planName = p.vp_name || p.plan_name || "Plan";
    slot.classList.remove("hidden");
    slot.innerHTML = `
      <div class="rounded-2xl border-2 border-primary bg-primary/5 p-3 flex items-center gap-3 min-w-0">
        <svg class="h-5 w-5 text-primary shrink-0" aria-hidden="true"><use href="#icon-clock"/></svg>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-bold truncate">You have a pending payment</p>
          <p class="text-xs text-muted-foreground truncate">${escapeHtml(planName)} \u00b7 ${fmtPHP(amount)}</p>
        </div>
        <button type="button" data-action="resume"
          class="shrink-0 inline-flex items-center justify-center bg-primary text-primary-foreground hover:opacity-90 h-9 px-3 text-xs font-bold rounded-lg transition-opacity">Resume</button>
        <button type="button" data-action="cancel"
          class="shrink-0 inline-flex items-center justify-center bg-secondary hover:opacity-90 h-9 px-3 text-xs font-semibold rounded-lg border border-border text-muted-foreground transition-opacity">Cancel</button>
      </div>
    `;
    slot.querySelector('[data-action="resume"]').onclick = () => {
      state.paymentId = p.id;
      state.paymentReference = p.reference_no || p.external_id || p.reference || ("PW-" + p.id);
      showResult("pending", {
        reference: state.paymentReference,
        amount: amount, phone: p.buyer_phone || "",
        qr_image: p.qr_image_data_url || null,
        checkout_url: p.checkout_url || null,
        method_name: p.channel_name || "",
        is_cash: (p.module_slug == null || p.module_slug === ''),
      });
      startPaymentPolling(state.paymentId);
    };
    slot.querySelector('[data-action="cancel"]').onclick = async () => {
      // CX-CANCELLED-CONFIRM-2026-05-31 — confirm + cancelled-view closure.
      const _go2 = await confirmDialog({
        title: "Cancel this payment?",
        message: "No charges have been made yet.",
        yesLabel: "Yes, cancel", noLabel: "Keep it",
      });
      if (!_go2) return;
      const _cr = await apiPost("/portal/payment/cancel",
        { payment_id: p.id }).catch(() => ({ ok: false, error: "network" }));
      if (!_cr || _cr.ok !== true) {
        alert("We could not cancel that payment right now. Please try again.");
        return;
      }
      slot.classList.add("hidden");
      showResult("cancelled", { method_name: p.channel_name || "", amount: amount });
    };
  } catch (_) { /* graceful */ }
}

function showCheckout() {
  const p = state.selectedPlan;
  if (!p) return showPlans();

  $("checkout-plan-name").textContent = p.duration_label || p.name;
  const metaBits = [];
  if (p.duration_label) metaBits.push(p.duration_label);
  if (p.speed) metaBits.push(p.speed);
  $("checkout-plan-meta").textContent = metaBits.join(" · ") || "—";
  $("checkout-plan-price-line").textContent = fmtPHP(p.price);
  $("checkout-plan-price-total").textContent = fmtPHP(p.price);

  renderPaymentMethods();
  populateStores();
  state.selectedMethod = null;
  $("store-wrap").classList.add("hidden");
  $("checkout-submit").disabled = true;
  $("checkout-submit").textContent = "Pay now";
  hideAlert();
  show("view-checkout");
  // REM-3/4/5 — existing endpoints, no new backend.
  startHealthPolling();
  bindLockoutBanner();
  bindResumePending();
}

// Payment-method tile classes — extracted so onPickMethod() can re-apply
// them when selection changes. Layout intentionally mirrors the home
// "No voucher?" footer card and the plan-list rows so the whole flow
// shares one tile language.
const METHOD_TILE = {
  base:        "min-w-0 rounded-2xl border-2 p-4 flex flex-col items-center justify-center gap-2 transition-all active:scale-[0.99]",
  unselected:  "border-border bg-card hover:border-primary",
  selected:    "border-primary bg-primary/5",
  iconWrap:    "h-14 w-14 rounded-2xl flex items-center justify-center shrink-0",
  iconUnsel:   "bg-accent text-foreground",
  iconSel:     "bg-primary text-primary-foreground",
};

function methodSub(o) {
  // Short sub-line to the right of the name. Source uses something similar.
  const n = String(o.name || "").toLowerCase();
  if ((o.icon_key || "").toLowerCase() === "cash") return "Pay at the counter";
  if (o.fee_percent || o.fee_fixed) {
    const parts = [];
    if (o.fee_percent) parts.push(`${o.fee_percent}%`);
    if (o.fee_fixed)   parts.push(`₱${o.fee_fixed}`);
    return `Fee ${parts.join(" + ")}`;
  }
  return "Instant payment";
}

function renderPaymentMethods() {
  const list = $("methods-list");
  list.innerHTML = "";
  const opts = state.paymentOptions.filter(o => (o.badge || "Available") === "Available");
  if (!opts.length) {
    const div = document.createElement("div");
    div.className = "rounded-2xl border-2 border-border bg-card p-5 text-center text-muted-foreground";
    div.textContent = "No payment methods are available right now.";
    list.appendChild(div);
    return;
  }
  for (const o of opts) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.setAttribute("aria-disabled", "false");
    tile.dataset.optionId = String(o.id);
    tile.dataset.optionName = o.name;
    tile.className = `${METHOD_TILE.base} ${METHOD_TILE.unselected}`;
    tile.innerHTML = `
      <div class="${METHOD_TILE.iconWrap} ${METHOD_TILE.iconUnsel}" data-icon-wrap>
        <svg class="h-7 w-7" aria-hidden="true"><use href="#${methodIconId(o)}"/></svg>
      </div>
      <span class="text-sm font-bold truncate max-w-full text-center leading-tight">${escapeHtml(o.name)}</span>
    `;
    tile.addEventListener("click", () => onPickMethod(o, tile));
    list.appendChild(tile);
  }
}

function populateStores() {
  // PARTNER-LABEL-2026-06-03 — PAYWIFI exposes active partners as
  // /api/portal/config.partners (legacy alias: store_partners). Render whatever is there.
  const sel = $("store-select");
  // Wipe everything except the placeholder option.
  while (sel.options.length > 1) sel.remove(1);
  for (const s of (state.storePartners || [])) {
    const opt = document.createElement("option");
    opt.value = String(s.id || s.slug || s.name);
    opt.textContent = s.address ? `${s.name} — ${s.address}` : s.name;
    sel.appendChild(opt);
  }
}

function showValidating() {
  show("view-validate");
  $("validate-icon").innerHTML = '<div class="spinner"></div>';
  $("validate-headline").textContent = "Checking your code…";
  $("validate-sub").textContent = "This usually takes a second.";
  $("validate-actions").classList.add("hidden");
}

function showValidateFailed(status, message) {
  const COPY = {
    invalid: { headline: "Voucher not found", icon: "icon-x-circle", color: "var(--destructive)" },
    expired: { headline: "Voucher expired",   icon: "icon-clock",    color: "var(--destructive)" },
    used:    { headline: "Already used",      icon: "icon-ban",      color: "var(--destructive)" },
    offline: { headline: "You're offline",    icon: "icon-circle-alert", color: "var(--destructive)" },
  };
  const c = COPY[status] || COPY.invalid;
  $("validate-icon").innerHTML = `<svg class="h-10 w-10" style="color:${c.color}" aria-hidden="true"><use href="#${c.icon}"/></svg>`;
  $("validate-headline").textContent = c.headline;
  $("validate-sub").textContent = message || "Please try again or buy a plan.";
  $("validate-actions").classList.remove("hidden");
  $("validate-retry").onclick = showHome;
  $("validate-plans").onclick = showPlans;
  show("view-validate");
}

// showResult — kinds: "success" | "pending" | "failed" (alias: "error") | "cancelled"
// Each kind toggles one of the four sub-views inside #view-result and
// populates its dynamic slots. All actions wire to existing PAYWIFI
// endpoints — no new backend.
function showResult(kind, data = {}) {
  // CX-CANCELLED-CONFIRM-2026-05-31 — 'cancelled' added.
  ["result-success", "result-pending", "result-failed", "result-cancelled"].forEach(id => {
    const el = $(id);
    if (el) { el.classList.add("hidden"); el.classList.remove("flex"); }
  });
  const k = (kind === "error") ? "failed" : kind;
  if (k === "success")        populateSuccess(data);
  else if (k === "pending")   populatePending(data);
  else if (k === "cancelled") populateCancelled(data);
  else                        populateFailed(data);

  const target = $(`result-${k}`);
  if (target) { target.classList.remove("hidden"); target.classList.add("flex"); }
  show("view-result");
}

function populateSuccess(data) {
  const code = data.code ? formatVoucherCode(data.code) : "";
  $("success-code").textContent = code || "—";
  $("success-code-wrap").classList.toggle("hidden", !code);
  // SMS-PHONE-FIX-2026-06-01 — surface SMS state under the voucher code.
  let _smsEl = $("success-sms");
  if (!_smsEl) {
    const wrap = $("success-code-wrap");
    if (wrap) {
      _smsEl = document.createElement("p");
      _smsEl.id = "success-sms";
      _smsEl.className = "mt-3 text-xs text-muted-foreground";
      wrap.appendChild(_smsEl);
    }
  }
  if (_smsEl) {
    if (data.sms_sent && data.masked_phone) {
      _smsEl.innerHTML = '<svg class="inline h-3 w-3 mr-1 align-[-1px]" aria-hidden="true"><use href="#icon-message-square"/></svg>'
        + 'Voucher sent by SMS to <span class="font-bold text-foreground">' + escapeHtml(data.masked_phone) + '</span>';
      _smsEl.classList.remove("hidden");
    } else if (data.masked_phone) {
      _smsEl.textContent = "We tried to text " + data.masked_phone + " but the SMS didn't go through.";
      _smsEl.classList.remove("hidden");
    } else {
      _smsEl.classList.add("hidden");
    }
  }
  // CX-POLISH-2026-05-31 — show plan duration when known.
  const _dur = $("success-duration");
  const _plan = state.selectedPlan || {};
  const _label = _plan.duration_label
    || (_plan.duration_minutes
        ? (_plan.duration_minutes >= 1440
           ? Math.floor(_plan.duration_minutes/1440) + " day(s)"
           : _plan.duration_minutes >= 60
             ? Math.floor(_plan.duration_minutes/60) + " hour(s)"
             : _plan.duration_minutes + " min")
        : null);
  if (_dur) {
    if (_label) {
      _dur.textContent = `You have ${_label} of WiFi access.`;
      _dur.classList.remove("hidden");
    } else { _dur.classList.add("hidden"); }
  }
  $("success-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(code.replace(/-/g, "")); } catch (_) {}
    $("success-copy").innerHTML = `<svg class="h-4 w-4" aria-hidden="true"><use href="#icon-check-circle"/></svg> Copied`;
    setTimeout(() => {
      $("success-copy").innerHTML = `<svg class="h-4 w-4" aria-hidden="true"><use href="#icon-copy"/></svg> Copy`;
    }, 1500);
  };
  $("success-share").onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "PAYWIFI voucher", text: code }); } catch (_) {}
    } else {
      try { await navigator.clipboard.writeText(code.replace(/-/g, "")); } catch (_) {}
    }
  };
}

function populatePending(data) {
  const p = state.selectedPlan || {};
  const ref = (data.reference || data.code || state.paymentReference || "").toUpperCase();
  const isCash = !!data.is_cash;
  const checkoutUrl = data.checkout_url || "";
  const methodName = data.method_name || (state.selectedMethod && state.selectedMethod.name) || "your wallet";
  // PHONE-HOIST-2026-05-31 — hoisted to fix TDZ access in the digital
  // PENDING-DETAILS branch below.
  const phone = data.phone || state.checkoutPhone || "";

  // CASH-STORE-REDESIGN-2026-06-01 — headline incorporates the selected store name.
  // Look up the chosen store from the cached portal-config list.
  const _selectedStoreId = data.store_id || state.selectedStoreId || "";
  const _selectedStore   = (state.storePartners || []).find(s => String(s.id || s.slug) === String(_selectedStoreId)) || null;
  const _storeName       = (_selectedStore && _selectedStore.name) || "the counter";
  const headline = $("pending-headline");
  if (headline) headline.textContent = isCash ? ("Pay at " + _storeName) : "Confirm payment";

  // Amount card.
  $("pending-amount").textContent = fmtPHP(p.price || data.amount || 0);
  const amountSub = $("pending-amount-sub");
  if (amountSub) {
    amountSub.textContent = isCash
      ? "Pay this exact amount in cash at the counter"
      : `Pay this exact amount via ${methodName}`;
  }

  // Reference + QR card. Generate the QR locally from data.checkout_url
  // (the URL the wallet app opens) — see /qr.js (qrcode-generator UMD).
  // Falls back to the backend's pre-rendered data.qr_image when no
  // checkout_url is available (e.g. cash flow, QR Ph qr_code action which
  // carries a raw EMVCo string, or any digital channel where Xendit
  // returned no checkout URL).
  $("pending-ref").textContent = ref || "—";
  const qrEl = $("pending-qr");
  qrEl.setAttribute("aria-label", `Payment reference ${ref}`);
  qrEl.style.background = "transparent";
  qrEl.innerHTML = "";
  // PLAN-CARD-2026-05-31 — for digital flows, show the plan details card
  // instead of the QR card (which is only useful for cross-device scan).
  // The user can verify the plan they're about to pay for. Cash flow keeps
  // the existing QR/reference card unchanged.
  const _qrLabel  = $("pending-qr-label");
  const _qrNote   = $("pending-qr-note");
  const _qrCard   = $("pending-qr-card");
  const _planCard = $("pending-plan-card");
  if (isCash) {
    // CASH-STORE-REDESIGN-2026-06-01 — drop the QR, supersize the reference.
    if (_qrLabel) _qrLabel.textContent = "Reference number";
    if (_qrNote)  _qrNote.textContent  = "Show this at the counter to confirm your payment.";
    if (_qrCard)   _qrCard.classList.remove("hidden");

    // Hide the QR image div + its border wrapper, then size up #pending-ref.
    const _qrImg = $("pending-qr");
    if (_qrImg) {
      _qrImg.style.display = "none";
      // also drop the white frame wrapper so we don't leave an empty box
      const _frame = _qrImg.parentElement;
      if (_frame) _frame.style.display = "none";
    }
    const _ref = $("pending-ref");
    if (_ref) {
      _ref.classList.remove("text-lg");
      _ref.classList.add("text-5xl", "leading-none", "py-2");
    }

    // Build the "How to pay" instructions with the chosen store name baked in.
    const _howto = $("pending-howto");
    if (_howto) {
      _howto.classList.remove("hidden");
      const amtStr = fmtPHP(p.price || data.amount || 0);
      const refStr = (data.reference || state.paymentReference || "—");
      const s1 = $("pending-howto-step1"); if (s1) s1.textContent = `Go to ${_storeName}.`;
      const s2 = $("pending-howto-step2"); if (s2) s2.textContent = `Pay ${amtStr} in cash to the cashier.`;
      const s3 = $("pending-howto-step3");
      if (s3) {
        s3.innerHTML = `Show reference <span class="font-mono font-bold text-foreground">${escapeHtml(refStr)}</span>.`;
      }
      const s4 = $("pending-howto-step4");
      if (s4) s4.textContent = `Your voucher will appear on this screen automatically once ${_storeName} confirms.`;
    }

    // Reuse the Payment Details card for cash as well so plan + phone show.
    if (_planCard) {
      _planCard.classList.remove("hidden");
      const _pn  = $("pending-plan-name");
      const _ps  = $("pending-plan-speed");
      const _pd  = $("pending-plan-duration");
      const _pr  = $("pending-plan-ref");
      const _dm  = $("pending-detail-method");
      const _dg  = $("pending-detail-generated");
      const _dp  = $("pending-detail-phone");
      if (_pn) _pn.textContent = p.duration_label || p.name || "—";
      if (_ps) _ps.textContent = p.speed
        || (p.bandwidth_kbps ? (p.bandwidth_kbps >= 1024
              ? (p.bandwidth_kbps/1024).toFixed(p.bandwidth_kbps%1024===0?0:1) + " Mbps"
              : p.bandwidth_kbps + " Kbps")
            : "—");
      if (_pd) _pd.textContent = p.duration_label
        || (p.duration_minutes ? (p.duration_minutes >= 1440
              ? Math.floor(p.duration_minutes/1440) + " Day" + (p.duration_minutes>=2880?"s":"")
              : p.duration_minutes >= 60
                ? Math.floor(p.duration_minutes/60) + " Hour" + (p.duration_minutes>=120?"s":"")
                : p.duration_minutes + " min")
            : "—");
      if (_pr) _pr.textContent = ref || "—";
      if (_dm) _dm.textContent = "Cash · " + _storeName;
      if (_dg && data.created_at) {
        const _d = new Date(data.created_at * 1000);
        try { _dg.textContent = _d.toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }); }
        catch (e) { _dg.textContent = _d.toLocaleString(); }
      } else if (_dg) { _dg.textContent = "—"; }
      if (_dp) _dp.textContent = phone || "Not provided";
    }
  } else {
    if (_qrCard)   _qrCard.classList.add("hidden");
    // CASH-STORE-REDESIGN-2026-06-01 — restore QR image visibility + small ref
    // in case the user toggled cash→digital (rare but possible).
    const _qrImg = $("pending-qr");
    if (_qrImg) {
      _qrImg.style.display = "";
      const _frame = _qrImg.parentElement;
      if (_frame) _frame.style.display = "";
    }
    const _ref = $("pending-ref");
    if (_ref) {
      _ref.classList.remove("text-5xl", "leading-none", "py-2");
      _ref.classList.add("text-lg");
    }
    const _howto = $("pending-howto");
    if (_howto) _howto.classList.add("hidden");
    if (_planCard) {
      _planCard.classList.remove("hidden");
      const _pn = $("pending-plan-name");
      const _ps = $("pending-plan-speed");
      const _pd = $("pending-plan-duration");
      const _pr = $("pending-plan-ref");
      const _dm = $("pending-detail-method");
      const _dg = $("pending-detail-generated");
      const _dp = $("pending-detail-phone");
      if (_pn) _pn.textContent = p.duration_label || p.name || "—";
      if (_ps) _ps.textContent = p.speed
        || (p.bandwidth_kbps ? (p.bandwidth_kbps >= 1024
              ? (p.bandwidth_kbps/1024).toFixed(p.bandwidth_kbps%1024===0?0:1) + " Mbps"
              : p.bandwidth_kbps + " Kbps")
            : "—");
      if (_pd) _pd.textContent = p.duration_label
        || (p.duration_minutes ? (p.duration_minutes >= 1440
              ? Math.floor(p.duration_minutes/1440) + " Day" + (p.duration_minutes>=2880?"s":"")
              : p.duration_minutes >= 60
                ? Math.floor(p.duration_minutes/60) + " Hour" + (p.duration_minutes>=120?"s":"")
                : p.duration_minutes + " min")
            : "—");
      if (_pr) _pr.textContent = ref || "—";
      if (_dm) _dm.textContent = methodName || "—";
      if (_dg && data.created_at) {
        const _d = new Date(data.created_at * 1000);
        try {
          _dg.textContent = _d.toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
          });
        } catch (e) { _dg.textContent = _d.toLocaleString(); }
      } else if (_dg) { _dg.textContent = "—"; }
      if (_dp) _dp.textContent = phone
        || /* italic placeholder for empty */ "Not provided";
    }
  }

  // CX-CANCELLED-CONFIRM-2026-05-31 — instruction banner shown for BOTH
  // flows now; copy adapts. Closes a gap where cash users had no top-level
  // guidance on what to do next.
  const _instr     = $("pending-instruction");
  const _instrT    = $("pending-instruction-title");
  const _instrSub  = $("pending-instruction-sub");
  // CASH-INSTR-OFF-2026-06-01 — hide the top instruction banner on cash
  // (the in-card "How to pay" steps already explain the flow + reference).
  if (_instr) {
    if (isCash) {
      _instr.classList.add("hidden");
    } else {
      _instr.classList.remove("hidden");
      if (_instrT)   _instrT.textContent = `Tap "Continue to ${methodName}" to complete payment`;
      if (_instrSub) _instrSub.textContent =
        `Pay inside the ${methodName} app. This page will detect your payment automatically and issue your voucher.`;
    }
  }

  const encodeTarget = checkoutUrl || (typeof data.qr_string === "string" ? data.qr_string : "") || "";
  let qrRendered = false;
  if (encodeTarget && typeof window.qrcode === "function") {
    try {
      // QR-SCANNABLE-2026-05-30 — ECC level 'H' (30 % recovery) + 224 px slot.
      // High ECC adds modules so the resulting QR has more pixels per module
      // at the same physical size = far more reliable scanning on cheap
      // phone cameras and in low light.
      const QR_PX = 224;
      const qr = window.qrcode(0, "H");
      qr.addData(encodeTarget);
      qr.make();
      const modules = qr.getModuleCount();
      const cell = Math.max(3, Math.floor(QR_PX / (modules + 4)));
      qrEl.innerHTML = qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
      const svg = qrEl.querySelector("svg");
      if (svg) {
        svg.setAttribute("width",  String(QR_PX));
        svg.setAttribute("height", String(QR_PX));
        svg.style.display = "block";
      }
      qrRendered = true;
    } catch (e) {
      console.warn("[qr] local encode failed:", e && e.message);
    }
  }
  if (!qrRendered) {
    if (data.qr_image) {
      qrEl.innerHTML = `<img src="${data.qr_image}" alt="Payment QR" style="width:224px;height:224px;display:block">`;
    } else {
      qrEl.style.background = "repeating-conic-gradient(#0001 0 25%, transparent 0 50%) 50% / 12px 12px";
    }
  }

  // Store card — cash flow only.
  const storeId = data.store_id || state.selectedStoreId;
  const store = (state.storePartners || []).find(s => String(s.id || s.slug) === String(storeId));
  if (isCash && store) {
    $("pending-store").classList.remove("hidden");
    $("pending-store-name").textContent = store.name || "—";
    $("pending-store-addr").textContent = store.address || "";
  } else {
    $("pending-store").classList.add("hidden");
  }

  // DROP-PHONE-WIDGET-2026-05-31 — the standalone phone widget is gone.
  // Digital populates #pending-detail-phone inside the Payment Details card
  // (handled earlier in this function). Cash populates the same data into
  // an inline row at the bottom of the QR/reference card.
  if (isCash) {
    const _qrPhoneWrap = $("pending-qr-phone");
    const _qrPhoneVal  = $("pending-detail-phone-cash");
    if (_qrPhoneWrap) _qrPhoneWrap.classList.remove("hidden");
    if (_qrPhoneVal)  _qrPhoneVal.textContent = phone || "Not provided";
  } else {
    const _qrPhoneWrap = $("pending-qr-phone");
    if (_qrPhoneWrap) _qrPhoneWrap.classList.add("hidden");
  }

  // CONFIRM-LOCK-2026-05-31 — same-tab CTA so the wallet's return URL
  // lands back in this tab. If data.auto_redirect, run a 2s countdown
  // then auto-navigate; the user can override with the CTA or Cancel.
  const ctaWrap  = $("pending-checkout-btn");
  const ctaLabel = $("pending-checkout-label");
  if (window._cl_countdown) { clearInterval(window._cl_countdown); window._cl_countdown = null; }
  if (!isCash && checkoutUrl) {
    // ANDROID-INTENT-2026-05-31 — on Android with a known wallet package,
    // route through intent:// to force the app to launch. browser_fallback_url
    // catches devices without the app. iOS / desktop use the plain URL and
    // rely on Universal Links / browser respectively.
    const _navUrl = _buildAndroidIntentUrl(checkoutUrl, data.method_icon_key);
    ctaWrap.classList.remove("hidden");
    ctaWrap.setAttribute("href", _navUrl);
    ctaWrap.setAttribute("target", "_self");
    ctaWrap.removeAttribute("rel");
    const _baseLabel = `Continue to ${methodName} — pay ${fmtPHP(p.price || data.amount || 0)}`;
    if (ctaLabel) ctaLabel.textContent = _baseLabel;
    ctaWrap.onclick = () => {
      if (window._cl_countdown) { clearInterval(window._cl_countdown); window._cl_countdown = null; }
    };
    if (data.auto_redirect) {
      if (ctaLabel) ctaLabel.textContent = `Opening ${methodName}…`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try { window.location.assign(_navUrl); } catch (e) {}
      }));
    }
  } else if (ctaWrap) {
    ctaWrap.classList.add("hidden");
    ctaWrap.removeAttribute("href");
    ctaWrap.onclick = null;
  }

  // DROP-PAID-LINK-2026-05-31 — the big "I have paid — get my voucher"
  // footer button is CASH-ONLY now (cash depends on operator confirmation,
  // no webhook auto-detect). Digital flows rely entirely on the 4-second
  // /payment/status polling loop to auto-transition the lockout view to
  // success/error when the webhook fires — no manual button needed.
  const paidBtn = $("pending-paid");
  if (paidBtn) {
    if (isCash) paidBtn.classList.remove("hidden");
    else        paidBtn.classList.add("hidden");
  }

  // Footer subtext — same structure, copy adapts to flow.
  const subtext = $("pending-footer-note");
  if (subtext) {
    subtext.textContent = isCash
      ? "After paying, tap the button below — your voucher will appear here in a few seconds."
      : `We'll auto-detect your ${methodName} payment within seconds and unlock your WiFi.`;
  }

  // CX-POLISH-2026-05-31 — live expires-in countdown.
  startPendingCountdown(data.expires_in || 0);

  // Wire actions.
  $("pending-close").onclick = showHome;
  if (paidBtn) paidBtn.onclick = () => pollPaymentNow(state.paymentId);
  $("pending-cancel").onclick = async () => {
    // CONFIRM-LOCK-2026-05-31 — kill auto-redirect timer first.
    if (window._cl_countdown) { clearInterval(window._cl_countdown); window._cl_countdown = null; }
    if (!state.paymentId) return showHome();
    // CX-CANCELLED-CONFIRM-2026-05-31 — confirm before cancelling so a
    // mis-tap doesn't lose the in-flight payment.
    const _go1 = await confirmDialog({
      title: "Cancel this payment?",
      message: "No charges have been made yet. You can pick a different plan after.",
      yesLabel: "Yes, cancel", noLabel: "Keep it",
    });
    if (!_go1) return;
    const _cr = await apiPost("/portal/payment/cancel",
      { payment_id: state.paymentId, reference: ref }).catch(() => ({ ok: false, error: "network" }));
    if (!_cr || _cr.ok !== true) {
      alert("We could not cancel that payment right now. Please try again.");
      return;
    }
    stopPaymentPolling();
    state.paymentId = null;
    showResult("cancelled", {
      method_name: methodName,
      amount: data.amount || p.price || 0,
    });
  };
  // CX-POLISH-2026-05-31 — inline phone edit (DOM swap, no prompt() popup).
  const _digitalEdit  = $("pending-detail-edit-phone");
  const _phoneInput   = $("pending-detail-phone-input");
  const _phoneSave    = $("pending-detail-phone-save");
  const _phoneCancel  = $("pending-detail-phone-cancel");
  const _phoneSpan    = $("pending-detail-phone");
  const _enterEdit = () => {
    if (!_phoneInput) return;
    _phoneInput.value = phone || "";
    _phoneSpan?.classList.add("hidden");
    _digitalEdit?.classList.add("hidden");
    _phoneInput.classList.remove("hidden");
    _phoneSave?.classList.remove("hidden");
    _phoneCancel?.classList.remove("hidden");
    _phoneInput.focus();
    _phoneInput.select();
  };
  const _exitEdit = () => {
    _phoneSpan?.classList.remove("hidden");
    _digitalEdit?.classList.remove("hidden");
    _phoneInput?.classList.add("hidden");
    _phoneSave?.classList.add("hidden");
    _phoneCancel?.classList.add("hidden");
  };
  const _commitEdit = async () => {
    const clean = (_phoneInput?.value || "").trim();
    if (!clean) { _exitEdit(); return; }
    if (state.paymentId) {
      await apiPost("/portal/payment/set-phone", { payment_id: state.paymentId, phone: clean }).catch(() => null);
    }
    state.checkoutPhone = clean;
    _exitEdit();
    populatePending({ ...data, phone: clean });
  };
  if (_digitalEdit) _digitalEdit.onclick = _enterEdit;
  if (_phoneSave)   _phoneSave.onclick   = _commitEdit;
  if (_phoneCancel) _phoneCancel.onclick = _exitEdit;
  if (_phoneInput)  _phoneInput.onkeydown = (e) => {
    if (e.key === "Enter")  { e.preventDefault(); _commitEdit(); }
    if (e.key === "Escape") { e.preventDefault(); _exitEdit(); }
  };
  const _cashEdit = $("pending-detail-edit-phone-cash");
  if (_cashEdit) _cashEdit.onclick = async () => {
    const next = prompt("Mobile number for SMS receipt:", phone || "09");
    if (next == null) return;
    const clean = next.trim();
    if (!clean) return;
    if (state.paymentId) {
      await apiPost("/portal/payment/set-phone", { payment_id: state.paymentId, phone: clean }).catch(() => null);
    }
    state.checkoutPhone = clean;
    populatePending({ ...data, phone: clean });
  };
}

function populateFailed(data) {
  const methodName = (state.selectedMethod && state.selectedMethod.name) || data.method || "—";
  $("failed-method").textContent = methodName;
  $("failed-reason").textContent = data.error || "Something went wrong with the payment.";
  $("failed-close").onclick = showHome;
  $("failed-retry").onclick = () => state.selectedPlan ? showCheckout() : showPlans();
  $("failed-other-plan").onclick = showPlans;
  $("failed-home").onclick = showHome;
}

// CX-CANCELLED-CONFIRM-2026-05-31 — friendly closure for cancelled payments.
function populateCancelled(data) {
  const methodName = data.method_name
                  || (state.selectedMethod && state.selectedMethod.name) || "";
  const amount     = data.amount != null ? fmtPHP(data.amount) : "";
  const summary = $("cancelled-summary");
  if (methodName || amount) {
    if (summary) summary.classList.remove("hidden");
    const _m = $("cancelled-method"); if (_m) _m.textContent = methodName || "—";
    const _a = $("cancelled-amount"); if (_a) _a.textContent = amount ? `Amount: ${amount}` : "";
  } else if (summary) {
    summary.classList.add("hidden");
  }
  $("cancelled-close").onclick    = showHome;
  $("cancelled-home").onclick     = showHome;
  $("cancelled-new-plan").onclick = showPlans;
}

function showConnected() {
  // MULTI-FIX-2026-06-01 — surface plan + voucher + speed + duration so
  // returning users see the full session context, not just bytes.
  const s = state.session || {};
  // QUEUE-EVERYWHERE-2026-06-01 — total_seconds = remaining + sum of all
  // queued voucher durations. Use it so the user sees their combined balance.
  const totSec = s.total_seconds     != null ? Number(s.total_seconds)     : null;
  const remSec = s.remaining_seconds != null ? Number(s.remaining_seconds) : null;
  const useSec = totSec != null && totSec > 0 ? totSec : remSec;
  let timeLabel = "Active";
  if (useSec != null && useSec > 0) {
    const hrs = Math.floor(useSec / 3600);
    const min = Math.floor((useSec % 3600) / 60);
    timeLabel = hrs > 0
      ? `${hrs}h ${String(min).padStart(2,"0")}m left`
      : `${min} min left`;
  } else if (s.minutes_left != null) {
    timeLabel = `${s.minutes_left} min left`;
  }
  $("connected-time-left").textContent = timeLabel;

  // Queue sub-line: "+ N vouchers queued (X h Y m)" when applicable.
  const qCount = Number(s.queue_count   || 0);
  const qSec   = Number(s.queue_seconds || 0);
  const subEl  = $("connected-queue-sub");
  if (subEl) {
    if (qCount > 0) {
      const qHrs = Math.floor(qSec / 3600);
      const qMin = Math.floor((qSec % 3600) / 60);
      const dur  = qHrs > 0 ? (qHrs + "h " + qMin + "m") : (qMin + "m");
      subEl.textContent = "+ " + qCount + " voucher" + (qCount===1 ? "" : "s") + " queued (" + dur + ")";
      subEl.classList.remove("hidden");
    } else { subEl.classList.add("hidden"); }
  }

  // Speed + duration tiles (use server-supplied labels when present).
  const _bw = s.bandwidth_kbps || 0;
  const _spd = s.speed_label
    || (_bw >= 1024 ? (_bw/1024).toFixed(_bw%1024===0?0:1) + " Mbps" : _bw + " Kbps");
  const _spdEl = $("connected-speed");
  if (_spdEl) _spdEl.textContent = _bw ? _spd : "—";

  const _durEl = $("connected-duration");
  if (_durEl) _durEl.textContent = s.duration_label
    || (s.duration_minutes
        ? (s.duration_minutes >= 1440
           ? Math.floor(s.duration_minutes/1440) + " Day(s)"
           : s.duration_minutes >= 60
             ? Math.floor(s.duration_minutes/60) + " Hour(s)"
             : s.duration_minutes + " min")
        : "—");

  // Voucher + started-at + data counters.
  const _vEl = $("connected-voucher");
  if (_vEl) _vEl.textContent = s.voucher_code
    ? formatVoucherCode(s.voucher_code) : "—";

  const _stEl = $("connected-started");
  if (_stEl && s.started_at) {
    try {
      _stEl.textContent = new Date(s.started_at * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
    } catch (e) { _stEl.textContent = "—"; }
  } else if (_stEl) { _stEl.textContent = "—"; }

  $("connected-data").textContent = `↓ ${humanBytes(s.bytes_in ?? 0)} · ↑ ${humanBytes(s.bytes_out ?? 0)}`;
  show("view-connected");
}

/* ------------------------------ CX-POLISH-2026-05-31 helpers ------------------------------ */

// PENDING-DIALOG-2026-06-01 — informational dialog shown when /payment/create
// refuses a new payment because one is already in flight. Replaces the
// silent showAlert + auto-route. Returns one of:
//   "continue"        — open the existing pending lock screen
//   "cancel-and-new"  — cancel the existing pending, let user retry
//   "stay"            — close, no action
function showPendingPaymentDialog(res) {
  return new Promise((resolve) => {
    const channelName = res.existing_channel_name || "payment";
    const amount      = res.existing_amount != null ? fmtPHP(res.existing_amount) : "";
    const refNo       = res.reference_no || "";
    const isCash      = String(channelName || "").toLowerCase() === "cash";

    const overlay = document.createElement("div");
    overlay.id = "pending-payment-dialog";
    overlay.className = "fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:p-4";
    overlay.style.background = "rgba(15, 23, 42, 0.55)";
    overlay.innerHTML =
      '<div class="w-full max-w-md rounded-3xl border-2 p-6 shadow-2xl" style="background: var(--card); border-color: var(--border)">' +
        '<div class="flex items-start gap-3 mb-4">' +
          '<div class="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" ' +
               'style="background: color-mix(in oklab, var(--primary) 12%, var(--card)); color: var(--primary)">' +
            '<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>' +
            '</svg>' +
          '</div>' +
          '<div class="min-w-0 flex-1">' +
            '<h2 class="text-lg font-bold leading-tight">You have a payment in progress</h2>' +
            '<p class="text-xs mt-1 leading-snug" style="color: var(--muted-foreground)">' +
              'PAYWIFI allows one payment request at a time. You can finish this one, cancel it to start a new one, or come back later.' +
            '</p>' +
          '</div>' +
        '</div>' +

        '<div class="rounded-2xl border-2 p-4 mb-5" style="background: color-mix(in oklab, var(--primary) 4%, var(--card)); border-color: color-mix(in oklab, var(--primary) 25%, var(--border))">' +
          '<p class="text-[11px] font-bold uppercase tracking-wider" style="color: var(--primary)">Existing payment</p>' +
          '<p class="mt-1 text-base font-bold">' + escapeHtml(channelName) + (amount ? (' &middot; <span style="color: var(--primary)">' + amount + '</span>') : '') + '</p>' +
          (refNo ? ('<p class="text-xs mt-1.5 font-mono tracking-wider" style="color: var(--muted-foreground)">Reference: <span class="font-bold" style="color: var(--foreground)">' + escapeHtml(refNo) + '</span></p>') : '') +
          (isCash ? '<p class="text-xs mt-2 leading-snug" style="color: var(--muted-foreground)">Show this reference at the counter to pay.</p>' : '<p class="text-xs mt-2 leading-snug" style="color: var(--muted-foreground)">Continue to complete this payment in the wallet.</p>') +
        '</div>' +

        '<div class="flex flex-col gap-2">' +
          '<button id="ppd-continue" class="rounded-xl h-12 px-4 text-base font-bold transition-opacity hover:opacity-90" ' +
                  'style="background: var(--primary); color: var(--primary-foreground)">' +
            'Continue with current payment' +
          '</button>' +
          '<button id="ppd-cancel-and-new" class="rounded-xl h-11 px-4 text-sm font-semibold border-2 transition-colors" ' +
                  'style="border-color: color-mix(in oklab, var(--destructive) 35%, var(--border)); ' +
                         'color: var(--destructive); background: var(--card)">' +
            'Cancel current and start a new one' +
          '</button>' +
          '<button id="ppd-stay" class="rounded-xl h-10 px-4 text-sm font-semibold transition-colors" ' +
                  'style="color: var(--muted-foreground); background: transparent">' +
            'Not now' +
          '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const cleanup = (choice) => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.body.style.overflow = "";
      resolve(choice);
    };
    overlay.querySelector("#ppd-continue").onclick       = () => cleanup("continue");
    overlay.querySelector("#ppd-cancel-and-new").onclick = () => cleanup("cancel-and-new");
    overlay.querySelector("#ppd-stay").onclick           = () => cleanup("stay");
    // Click backdrop = stay
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup("stay"); });
  });
}

/* ------------------------------ CX-POLISH-2026-05-31 helpers ------------------------------ */

// ANDROID-INTENT-2026-05-31 — best-effort GCash app auto-launch on Android.
// iOS Universal Links handle this natively via plain same-tab nav (no code).
function _isAndroid() {
  return /Android/i.test(navigator.userAgent || "");
}
// Map of wallet icon_key -> Android Play Store package name. Only known-good
// packages here; others fall through to the plain URL.
const _WALLET_ANDROID_PACKAGES = {
  gcash:     "com.globe.gcash.android",
  // paymaya: "com.paymaya"                   // unverified; leave plain URL
  // grabpay: "com.grabtaxi.passenger"         // unverified
};
function _buildAndroidIntentUrl(httpsUrl, methodIconKey) {
  if (!_isAndroid() || !httpsUrl) return httpsUrl;
  const pkg = _WALLET_ANDROID_PACKAGES[(methodIconKey || "").toLowerCase()];
  if (!pkg) return httpsUrl;
  try {
    const u = new URL(httpsUrl);
    // Preserve the SPA hash fragment by URL-encoding it INTO the URI portion.
    // intent:// uses # as the params separator, so a raw # would break parsing.
    // GCash's handler decodes via Uri.parse(intent.getDataString()) on launch.
    let uri = u.host + u.pathname + u.search;
    if (u.hash) uri += encodeURIComponent(u.hash);
    const fallback = encodeURIComponent(httpsUrl);
    return `intent://${uri}#Intent;` +
           `scheme=${u.protocol.replace(":", "")};` +
           `package=${pkg};` +
           `S.browser_fallback_url=${fallback};` +
           `end`;
  } catch (e) {
    return httpsUrl;
  }
}

function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    if (!modal) return resolve(window.confirm(opts.message || "Are you sure?"));
    $("confirm-title").textContent   = opts.title    || "Are you sure?";
    $("confirm-message").textContent = opts.message  || "";
    $("confirm-yes").textContent     = opts.yesLabel || "Yes, continue";
    $("confirm-no").textContent      = opts.noLabel  || "Keep it";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    const cleanup = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      $("confirm-yes").onclick = null;
      $("confirm-no").onclick  = null;
    };
    $("confirm-yes").onclick = () => { cleanup(); resolve(true);  };
    $("confirm-no").onclick  = () => { cleanup(); resolve(false); };
  });
}

let _pendingCountdownTimer = null;
let _pendingCountdownExpiresAt = 0;
function startPendingCountdown(expiresInSec) {
  stopPendingCountdown();
  if (!expiresInSec || expiresInSec <= 0) return;
  _pendingCountdownExpiresAt = Math.floor(Date.now() / 1000) + Math.floor(expiresInSec);
  const wrap = $("pending-countdown");
  const text = $("pending-countdown-text");
  if (!wrap || !text) return;
  wrap.classList.remove("hidden");
  const tick = () => {
    const left = _pendingCountdownExpiresAt - Math.floor(Date.now() / 1000);
    if (left <= 0) { text.textContent = "Expired"; stopPendingCountdown(); return; }
    const m = Math.floor(left / 60);
    const s = left % 60;
    text.textContent = `Expires in ${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  _pendingCountdownTimer = setInterval(tick, 1000);
}
function stopPendingCountdown() {
  if (_pendingCountdownTimer) { clearInterval(_pendingCountdownTimer); _pendingCountdownTimer = null; }
  const wrap = $("pending-countdown");
  if (wrap) wrap.classList.add("hidden");
}

/* ------------------------------ alerts (checkout footer) ------------------------------ */

function showAlert(msg) {
  $("checkout-alert").classList.remove("hidden");
  $("checkout-alert-text").textContent = msg;
}
function hideAlert() {
  $("checkout-alert").classList.add("hidden");
  $("checkout-alert-text").textContent = "";
}

/* ------------------------------ flow handlers ------------------------------ */

async function onVoucherSubmit(e) {
  if (e) e.preventDefault();
  const code = rawVoucherCode($("voucher-input").value);
  if (!code) return;
  showValidating();
  const res = await apiPost("/auth/voucher", { code });
  if (res && res.ok) {
    state.session = res.session || null;
    showResult("success", { code });
  } else {
    // Map backend error to a status. The PAYWIFI backend returns generic
    // error strings; treat them all as "invalid" until backend gives us
    // typed statuses.
    const msg = res?.error || "Voucher invalid or already used.";
    showValidateFailed("invalid", msg);
  }
}

function onPickPlan(p) {
  state.selectedPlan = p;
  showCheckout();
}

function onPickMethod(o, tileEl) {
  state.selectedMethod = o;
  // Reset every tile, then mark the chosen one.
  document.querySelectorAll("#methods-list button").forEach(t => {
    t.className = `${METHOD_TILE.base} ${METHOD_TILE.unselected}`;
    const iw = t.querySelector("[data-icon-wrap]");
    if (iw) iw.className = `${METHOD_TILE.iconWrap} ${METHOD_TILE.iconUnsel}`;
  });
  tileEl.className = `${METHOD_TILE.base} ${METHOD_TILE.selected}`;
  const iw = tileEl.querySelector("[data-icon-wrap]");
  if (iw) iw.className = `${METHOD_TILE.iconWrap} ${METHOD_TILE.iconSel}`;

  // Cash → show store dropdown
  const isCash = (o.icon_key || "").toLowerCase() === "cash";
  $("store-wrap").classList.toggle("hidden", !isCash);
  validateCheckout();
}

function validateCheckout() {
  const ok = !!state.selectedPlan && !!state.selectedMethod
    && (!isCashMethod() || !!$("store-select").value);
  $("checkout-submit").disabled = !ok;
}
function isCashMethod() {
  return !!state.selectedMethod && (state.selectedMethod.icon_key || "").toLowerCase() === "cash";
}

// M2 PAY-INFLIGHT-LOCK-2026-05-30 — block concurrent /payment/create.
// Cleared by the response handler below or by a 5-second safety timer
// so a navigation/error path never deadlocks future attempts.
let _payInFlight = false;
async function onCheckoutSubmit(e) {
  if (e) e.preventDefault();
  if (_payInFlight) return;          // M2: duplicate submission guard
  _payInFlight = true;
  const _payLockTimer = setTimeout(() => { _payInFlight = false; }, 5000);
  const _releaseLock = () => { _payInFlight = false; clearTimeout(_payLockTimer); };
  const p = state.selectedPlan;
  const m = state.selectedMethod;
  if (!p || !m) return;
  const phone = $("checkout-phone").value.trim();
  const storeId = $("store-select").value;
  hideAlert();
  $("checkout-submit").disabled = true;
  $("checkout-submit").textContent = "Setting up payment…";
  const res = await apiPost("/portal/payment/create", {
    plan_id: p.id, option_id: m.id,
    phone: phone || undefined, store_id: storeId || undefined,
  });
  // Backend returns flat fields: payment_id, checkout_url, qr_image, etc.
  // (portal.js POST /payment/create — no nested `payment` object).
  if (res && res.ok && res.payment_id) {
    state.paymentId = res.payment_id;
    // MULTI-FIX-2026-06-01 — 6-digit numeric reference (preferred).
    state.paymentReference = res.reference_no || res.payment_code || ("PW-" + res.payment_id);
    state.checkoutPhone = phone || "";
    state.selectedStoreId = storeId || "";
    // CONFIRM-LOCK-2026-05-31 — render pending view FIRST, then auto-hand-
    // off to the wallet via a 2s countdown. The CTA stays visible the whole
    // time so the user can manually tap or cancel. If they come back without
    // completing, boot()'s /payment/pending check locks them back here.
    const _isCash    = !!(m && (m.icon_key || "").toLowerCase() === "cash");
    const _isDigital = !_isCash && res.checkout_url && res.type !== "manual";
    showResult("pending", {
      reference: state.paymentReference, phone, store_id: storeId,
      amount: res.amount || p.price,
      qr_image: res.qr_image || null,
      qr_string: res.qr_string || null,
      checkout_url: res.checkout_url || null,
      method_name: (m && m.name) || res.channel_name || "",
      method_icon_key: (m && m.icon_key) || "",
      is_cash: _isCash,
      auto_redirect: _isDigital,
      created_at: res.created_at || Math.floor(Date.now()/1000),
      // CX-POLISH-2026-05-31 — countdown remainder.
      expires_in: res.expires_in || (15 * 60),
    });
    startPaymentPolling(state.paymentId);
    _releaseLock();
  } else {
    _releaseLock();
    $("checkout-submit").disabled = false;
    $("checkout-submit").textContent = "Pay now";
    // MISMATCH-LOCK-2026-05-31 — if the backend says we already have a
    // pending payment (PLAN_MISMATCH or METHOD_MISMATCH), don't just
    // alert — pivot the UI to the existing pending lock so the user
    // can finish or cancel it. lockToPendingPayment() fetches the
    // full payment record from /payment/pending and renders the
    // pending view exactly like boot() does on cold-load.
    if (res && (res.code === "PLAN_MISMATCH" || res.code === "METHOD_MISMATCH" || res.code === "ALREADY_PENDING")) {
      // PENDING-DIALOG-2026-06-01 — show informational dialog (with details +
      // explicit choices) instead of silently routing the user away.
      const choice = await showPendingPaymentDialog(res);
      if (choice === "continue") {
        try { await lockToPendingPayment(); } catch (e) { /* graceful */ }
      } else if (choice === "cancel-and-new" && res.payment_id) {
        // Cancel the existing pending and let the user retry.
        const _cr = await apiPost("/portal/payment/cancel",
          { payment_id: res.payment_id }).catch(() => ({ ok: false, error: "network" }));
        if (_cr && _cr.ok === true) {
          showAlert("Previous payment cancelled. Tap Pay now to start over.");
        } else {
          showAlert("We could not cancel the previous payment. Please try again.");
        }
      }
      // "stay" → no action; user remains on checkout
      return;
    }
    // FRIENDLY-MSG-MAP-2026-06-02 — defensive map for code-only responses,
    // so even if the backend returns just a `code` the user sees plain language.
    var _FRIENDLY = {
      NON_LAN_HOST:        "Connect to the PAYWIFI hotspot WiFi first \u2014 payments can't be made from outside the network.",
      RATE_LIMITED:        "You're making payment requests too quickly. Please wait a moment and try again.",
      FREE_TRIAL_CLAIMED:  "You've already used your free trial recently. Please try again later or buy a plan.",
      PLAN_MISMATCH:       "You have a pending payment for a different plan. Cancel it before switching plans.",
      METHOD_MISMATCH:     "You already have a pending payment with a different method. Cancel it before switching.",
      ALREADY_PENDING:     "You already have a pending payment for this plan. Tap Continue to finish, or Cancel to start a new one.",
      not_your_store:      "This payment was routed to a different store.",
      wrong_state:         "This payment is no longer in a state where this action is allowed.",
      race_lost:           "Another action claimed this payment first.",
      already_paid:        "This payment was already confirmed.",
      public_host_blocked: "Connect to the PAYWIFI hotspot WiFi first \u2014 payments can't be made from outside the network."
    };
    var _msg = (res && res.error)
      || (res && res.code && _FRIENDLY[res.code])
      || "Could not start payment. Please try again.";
    showAlert(_msg);
  }
}

// MISMATCH-LOCK-2026-05-31 — extracted helper so both boot() and the
// onCheckoutSubmit mismatch branch can re-use the same locking logic.
async function lockToPendingPayment() {
  const _pp = await apiGet("/portal/payment/pending").catch(() => null);
  if (!_pp || !_pp.ok || !_pp.pending || !_pp.payment_id) return false;
  state.paymentId = _pp.payment_id;
  state.paymentReference = _pp.reference || ("PW-" + _pp.payment_id);
  if (_pp.plan) state.selectedPlan = {
    id: _pp.plan.id, name: _pp.plan.name, price: _pp.plan.price,
    speed: _pp.plan.speed, duration_label: _pp.plan.duration_label,
  };
  if (_pp.option_id && Array.isArray(state.paymentOptions)) {
    state.selectedMethod = state.paymentOptions.find(o => o.id === _pp.option_id) || null;
  }
  // STORE-RESTORE-FIX-2026-06-01 — re-bind the selected store so the
  // pending dialog headline reads "Pay at <Store>" after refresh.
  if (_pp.store_id) state.selectedStoreId = _pp.store_id;
  const _mname = (state.selectedMethod && state.selectedMethod.name)
              || _pp.channel_name || "your wallet";
  const _ikey  = (state.selectedMethod && state.selectedMethod.icon_key) || "";
  const _localPhone = (_pp.buyer_phone || "").replace(/^63/, "0");
  state.checkoutPhone = _localPhone;
  showResult("pending", {
    reference: state.paymentReference,
    phone: _localPhone,
    amount: _pp.amount,
    qr_image: _pp.qr_image || null,
    checkout_url: _pp.checkout_url || null,
    method_name: _mname,
    method_icon_key: _ikey,
    is_cash: (_ikey || "").toLowerCase() === "cash",
    auto_redirect: false,
    resumed: true,
    created_at: _pp.created_at || null,
    expires_in: _pp.expires_in || 0,
    // STORE-RESTORE-FIX-2026-06-01 — pass store_id through so the headline
    // resolves to "Pay at <store name>" instead of "Pay at the counter".
    store_id: _pp.store_id || null,
  });
  const _h = $("pending-headline");
  if (_h) _h.textContent = _pp.checkout_url ? "Resume your payment" : "Complete your payment";
  const _n = $("pending-footer-note");
  if (_n) _n.textContent = _pp.checkout_url
    ? `Tap "Continue to ${_mname}" to finish paying. We'll auto-detect when you're done.`
    : "Your voucher will appear here once payment is confirmed.";
  startPaymentPolling(_pp.payment_id);
  pollPaymentNow(_pp.payment_id);
  return true;
}

function startPaymentPolling(id) {
  stopPaymentPolling();
  state.paymentPollTimer = setInterval(() => pollPaymentNow(id), 4000);
}
function stopPaymentPolling() {
  if (state.paymentPollTimer) { clearInterval(state.paymentPollTimer); state.paymentPollTimer = null; }
}
async function pollPaymentNow(id) {
  const pid = id || state.paymentId;
  if (!pid) return;
  const res = await apiGet(`/portal/payment/status/${pid}`).catch(() => null);
  if (!res || !res.ok) return;
  const status = res.status || (res.payment && res.payment.status);
  if (status === "paid" || status === "completed" || status === "success") {
    stopPaymentPolling();
    stopPendingCountdown();
    const _code = res.voucher_code || res.code || (res.voucher && res.voucher.code) || "";
    if (_code) {
      try {
        const _r = await apiPost("/auth/voucher", { code: String(_code).replace(/-/g, "") });
        if (_r && _r.ok) state.session = _r.session || state.session || null;
        else console.warn("[auto-redeem] voucher response not ok:", _r && _r.error);
      } catch (e) { console.warn("[auto-redeem] failed:", e && e.message); }
    }
    if (!state.session) {
      const sess = await apiGet("/session/status").catch(() => null);
      state.session = (sess && sess.session) || null;
    }
    // SMS-PHONE-FIX-2026-06-01 — pass SMS info into the success view.
    showResult("success", {
      code:         _code,
      sms_sent:     !!res.sms_sent,
      masked_phone: res.masked_phone || null,
      buyer_phone:  res.buyer_phone  || null,
    });
  } else if (status === "cancelled") {
    stopPaymentPolling();
    stopPendingCountdown();
    // Server says the payment was cancelled (could be the user just hit
    // cancel in another tab, or sessiond's expiry sweep flipped it). Use
    // the friendly cancelled view rather than the failure red.
    showResult("cancelled", {
      method_name: (state.selectedMethod && state.selectedMethod.name) || "",
      amount: (state.selectedPlan && state.selectedPlan.price) || 0,
    });
  } else if (status === "failed" || status === "expired") {
    stopPaymentPolling();
    stopPendingCountdown();
    const _msg = status === "expired"
      ? "This payment expired before it was completed. You can start a new one anytime."
      : (res.error || "We couldn't complete this payment. Please try again.");
    showResult("error", { error: _msg });
  }
}

async function onLogout() {
  await apiPost("/session/logout").catch(() => null);
  state.session = null;
  showHome();
}

async function pasteVoucher() {
  try {
    const text = await navigator.clipboard.readText();
    $("voucher-input").value = formatVoucherCode(text);
  } catch { /* clipboard unavailable */ }
}

/* ------------------------------ boot ------------------------------ */

async function injectIcons() {
  try {
    const r = await fetch("/icons.svg", { cache: "force-cache" });
    if (!r.ok) return;
    const txt = await r.text();
    const host = $("icon-defs");
    if (host) host.innerHTML = txt;
  } catch (_) { /* graceful: icons missing but pages still render */ }
}

async function boot() {
  await injectIcons();
  try {
    const [cfg, plans, pos] = await Promise.all([
      apiGet("/portal/config").catch(() => null),
      apiGet("/portal/plans").catch(() => ({ plans: [] })),
      apiGet("/portal/payment-options").catch(() => ({ options: [] })),
    ]);
    state.config = cfg || {};
    state.plans = (plans && plans.plans) || [];
    // DEVICE-COOKIE-HANDSHAKE-2026-06-03 — auto-PoP. If a remembered device
    // is reconnecting, the server bumps its handshake timestamp here; if the
    // cookie is missing or mismatched, sessiond will require fresh voucher.
    try {
      fetch("/api/portal/handshake", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}", keepalive: true
      }).catch(function(){});
    } catch (e) {}
    state.paymentOptions = (pos && pos.options) || [];
    state.storePartners = (cfg && (cfg.partners || cfg.store_partners)) || [];
    applyBranding();
    hydratePartnerWidget();
  } catch (e) { console.warn("[boot] config load failed:", e); }

  // CONFIRM-LOCK-2026-05-31 — if the device has an active pending payment
  // (created earlier but never completed), lock the UI back to the pending
  // view so the user can resume. Covers: closed wallet without paying, hit
  // back, killed app, refreshed page. /payment/pending returns full restore.
  try {
    const _pp = await apiGet("/portal/payment/pending").catch(() => null);
    if (_pp && _pp.ok && _pp.pending && _pp.payment_id) {
      state.paymentId = _pp.payment_id;
      state.paymentReference = _pp.reference_no || _pp.reference || ("PW-" + _pp.payment_id);
      if (_pp.plan) state.selectedPlan = {
        id: _pp.plan.id, name: _pp.plan.name, price: _pp.plan.price,
        speed: _pp.plan.speed, duration_label: _pp.plan.duration_label,
      };
      if (_pp.option_id && Array.isArray(state.paymentOptions)) {
        state.selectedMethod = state.paymentOptions.find(o => o.id === _pp.option_id) || null;
      }
      const _mname = (state.selectedMethod && state.selectedMethod.name)
                  || _pp.channel_name || "your wallet";
      const _ikey  = (state.selectedMethod && state.selectedMethod.icon_key) || "";
      const _localPhone = (_pp.buyer_phone || "").replace(/^63/, "0");
      state.checkoutPhone = _localPhone;
      showResult("pending", {
        reference: state.paymentReference,
        phone: _localPhone,
        amount: _pp.amount,
        qr_image: _pp.qr_image || null,
        checkout_url: _pp.checkout_url || null,
        method_name: _mname,
        method_icon_key: _ikey,
        is_cash: (_ikey || "").toLowerCase() === "cash",
        auto_redirect: false,
        resumed: true,
        // PENDING-DETAILS-2026-05-31 — resume path uses the server's
        // recorded created_at so "Generated" reflects the original time.
        created_at: _pp.created_at || null,
      });
      const _h = $("pending-headline");
      if (_h) _h.textContent = _pp.checkout_url
        ? "Resume your payment" : "Complete your payment";
      const _n = $("pending-footer-note");
      if (_n) _n.textContent = _pp.checkout_url
        ? `Tap "Continue to ${_mname}" to finish paying. We'll auto-detect when you're done.`
        : "Your voucher will appear here once payment is confirmed.";
      startPaymentPolling(_pp.payment_id);
      pollPaymentNow(_pp.payment_id);
      return;
    }
  } catch (_) { /* no pending — fall through */ }

  // M1-RETURN-URL-2026-05-30 — post-Xendit-payment redirect.
  // Xendit's browser redirect lands here with ?return=xendit&pid=<payment_id>.
  // Show the pending screen as a holding state and poll immediately — the
  // webhook usually fires during the redirect round-trip, so the first poll
  // resolves to status='paid' and we swap to the success view.
  try {
    const _qp = new URLSearchParams(location.search);
    if (_qp.get("return") === "xendit") {
      const _pid = parseInt(_qp.get("pid") || "0", 10);
      const _retSt = (_qp.get("status") || "").toLowerCase();
      if (_pid) {
        history.replaceState(null, "", location.pathname);
        state.paymentId = _pid;
        if (_retSt === "cancel" || _retSt === "cancelled") {
          // CANCEL-ON-RETURN-2026-06-01 — wallet told us the user cancelled.
          // Fire-and-forget POST so the server row flips from 'pending' to
          // 'cancelled' immediately (was waiting on sessiond's 15-min sweep).
          try {
            apiPost("/portal/payment/cancel", { payment_id: _pid }).catch(() => {});
          } catch (e) { /* graceful */ }
          state.paymentId = null;
          showResult("cancelled", {});
          return;
        }
        showResult("pending", { reference: "PW-" + _pid });
        const _h = $("pending-headline"); if (_h) _h.textContent = "Verifying your payment…";
        const _n = $("pending-footer-note"); if (_n) _n.textContent =
          "We're checking with the gateway. Your voucher will appear here in a moment.";
        startPaymentPolling(_pid);
        pollPaymentNow(_pid);
        return;
      }
    }
  } catch (_) { /* no URLSearchParams or stripped query — fall through */ }

  const sess = await apiGet("/session/status").catch(() => null);
  // MULTI-FIX-2026-06-01 — /session/status returns FLAT fields (no nested .session).
  // Accept both shapes for backward-compat.
  if (sess && sess.authenticated && (sess.session?.active || sess.session_state === "active")) {
    state.session = sess.session || sess;
    return showConnected();
  }
  return showHome();
}

document.addEventListener("DOMContentLoaded", () => {
  $("voucher-form").addEventListener("submit", onVoucherSubmit);
  $("voucher-input").addEventListener("input", (e) => {
    e.target.value = formatVoucherCode(e.target.value);
  });
  $("paste-btn").addEventListener("click", pasteVoucher);
  $("no-voucher-btn").addEventListener("click", showPlans);
  $("ads-widget").addEventListener("click", () => {
    // PORTAL-WIDGET-2026-06-03 — pull email target from widget config
    var w = findWidget("ads_card") || {};
    var to = w.contact_email || "ads@example.com";
    window.location.href = "mailto:" + to + "?subject=Ad%20slot%20inquiry";
  });
  // PARTNER-WIDGET-2026-06-03 — prefer tel: to partner.contact_number, fall back to mailto.
  $("partner-widget").addEventListener("click", () => {
    var w = findWidget("partner_cta") || {};
    var legacy = (state.config && state.config.partner) || {};
    var phone  = String(w.contact_number || legacy.contact_number || "").replace(/[^\d+]/g, "");
    var email  = w.contact_email || legacy.contact_email || "";
    if (phone)      window.location.href = "tel:" + phone;
    else if (email) window.location.href = "mailto:" + email + "?subject=PAYWIFI%20Partner%20inquiry";
    else            window.location.href = "/partner/login";
  });
  $("plans-close").addEventListener("click", showHome);
  $("plans-back").addEventListener("click", (e) => { e.preventDefault(); showHome(); });
  $("checkout-close").addEventListener("click", showPlans);
  $("checkout-back").addEventListener("click", showPlans);
  $("checkout-form").addEventListener("submit", onCheckoutSubmit);
  $("store-select").addEventListener("change", validateCheckout);
  $("validate-close").addEventListener("click", showHome);
  $("logout-btn").addEventListener("click", onLogout);
  boot();
});
