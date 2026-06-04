'use strict';
// WIDGET-TYPES-2026-06-04 — single source of truth for widget types.
// Used by:
//   - portal.js (DEFAULT_WIDGETS, ensureSingletonWidgets, widgets.filter)
//   - adminUi.js (POST /widgets schema validation)
//   - portal-widgets.ejs (window.WIDGET_TYPES injection for admin JS)
//
// Each entry: type → { id, isSingleton, isProtected, alwaysVisible, defaults }
// - isSingleton  : ensure exactly one exists; auto-inject if missing
// - isProtected  : Remove button hidden in admin UI
// - alwaysVisible: include in /portal/config even when enabled=false
// - defaults     : shape the widget JSON starts with on first save

const TYPES = {
  text: {
    id: null, isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: '', body: '' }
  },
  announcement: {
    id: 'announcement', isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: 'Notice', body: '', level: 'info' }
  },
  hours: {
    id: 'hours', isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: 'Business Hours', hours: { mon:'',tue:'',wed:'',thu:'',fri:'',sat:'',sun:'' } }
  },
  contact: {
    id: 'contact', isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: 'Contact Us', phone:'', email:'', facebook:'', instagram:'' }
  },
  promo: {
    id: 'promo', isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: 'Promotion', image_url: '', caption: '' }
  },
  html: {
    id: 'custom_html', isSingleton: false, isProtected: false, alwaysVisible: false,
    defaults: { title: 'Custom', html: '' }
  },
  payment_options: {
    id: 'payment_options', isSingleton: true, isProtected: true, alwaysVisible: false,
    defaults: { title: 'Payment Options' }
  },
  available_plans: {
    id: 'available_plans', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: { title: 'Available Plans', sticky: true }
  },
  status_bar: {
    id: 'status_bar', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: { title: 'Status Bar', sticky: true }
  },
  ads_card: {
    id: 'ads_card', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: { title: 'Your Ads Here', subtitle: 'Submit to inquire', contact_email: 'ads@example.com' }
  },
  partner_cta: {
    id: 'partner_cta', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: {
      title: 'Partner with Us', subtitle: '', chip: '', rollout: '',
      contact_number: '', contact_email: ''
    }
  },
  youtube: {
    id: 'youtube', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: {
      title: 'Featured Video', media_id: 'auto', playlist_mode: 'auto', playlist_ids: [],
      autoplay: true, muted: false, loop: true, controls: true, allow_fullscreen: true,
      volume: 1.0, click_to_play: false, skip_button: false, close_button: false,
      device_rule: 'any'
    }
  },
  live_news: {
    id: 'live_news', isSingleton: true, isProtected: true, alwaysVisible: true,
    defaults: {
      title: 'Live News',
      source_key: 'gmanews2026',
      channel_url: 'https://www.youtube.com/@gmanews2026/streams'
    }
  }
};

function isKnownType(t) { return Object.prototype.hasOwnProperty.call(TYPES, t); }
function isProtected(typeOrId) {
  for (const [t, meta] of Object.entries(TYPES)) {
    if (t === typeOrId || meta.id === typeOrId) return !!meta.isProtected;
  }
  return false;
}
function singletonTypes() {
  return Object.entries(TYPES).filter(([,m]) => m.isSingleton).map(([t,m]) => ({ type: t, id: m.id, defaults: m.defaults }));
}
function alwaysVisibleTypes() {
  return Object.entries(TYPES).filter(([,m]) => m.alwaysVisible).map(([t]) => t);
}

module.exports = { TYPES, isKnownType, isProtected, singletonTypes, alwaysVisibleTypes };
