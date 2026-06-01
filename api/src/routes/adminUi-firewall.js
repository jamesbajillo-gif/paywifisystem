'use strict';
const express      = require('express');
const router       = express.Router();
const db           = require('../db');
const { execFileSync } = require('child_process');
const dns          = require('dns');
const { promisify } = require('util');
const resolve4     = promisify(dns.resolve4);

// ── Module domain registry ─────────────────────────────────────────────────
// Domains/IPs each payment module may need in the walled garden so
// pre-auth clients can reach payment provider pages/CDNs.
const MODULE_DOMAINS = {
  xendit: {
    name: 'Xendit',
    entries: [
      { domain: 'api.xendit.co',           note: 'Xendit REST API (server→Xendit)',    server_only: true  },
      { domain: 'checkout.xendit.co',      note: 'Xendit hosted checkout pages',       server_only: false },
      { domain: 'js.xendit.co',            note: 'Xendit JS SDK / CDN assets',         server_only: false },
      { domain: 'checkout.paymaya.com',    note: 'Maya checkout redirect (PayMaya)',   server_only: false },
      { domain: 'pgw.paymaya.com',         note: 'Maya payment gateway',               server_only: false },
      { domain: 'payments.maya.ph',        note: 'Maya Payments PH',                  server_only: false },
      { domain: 'api.gcash.com',           note: 'GCash API (server→GCash)',           server_only: true  },
      { domain: 'gcash.com',               note: 'GCash app landing page',             server_only: false },
    ]
  }
};

const SYSTEM_IPS = new Set(['1.0.0.1','1.1.1.1','8.8.4.4','8.8.8.8','10.10.0.1']);
// ── SSH access helpers ─────────────────────────────────────────────────────

function getSshLanSetting() {
  const row = db.prepare("SELECT value FROM settings WHERE key='ssh_allow_lan'").get();
  return row ? row.value === '1' : false;
}

function applySshRule(allowLan) {
  const mode = allowLan ? 'wan-lan' : 'wan-only';
  execFileSync('sudo', ['/usr/local/sbin/paywifi-ssh-rule', mode], { timeout: 8000 });
  db.prepare("UPDATE settings SET value=?, updated_at=strftime('%s','now') WHERE key='ssh_allow_lan'")
    .run(allowLan ? '1' : '0');
}

// ── Admin UI ACL helpers ───────────────────────────────────────────────────
function getAdminLanSetting() {
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_allow_lan'").get();
  return row ? row.value === '1' : false;
}

function applyAdminAcl(allowLan) {
  const mode = allowLan ? 'lan-allowed' : 'mgmt-only';
  execFileSync('sudo', ['/usr/local/sbin/paywifi-admin-acl', mode], { timeout: 10000 });
  db.prepare("UPDATE settings SET value=?, updated_at=strftime('%s','now') WHERE key='admin_allow_lan'")
    .run(allowLan ? '1' : '0');
}




function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title: locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error: null,
    ...locals
  });
}

function flash(req, kind, msg) {
  if (!req.session) return;
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ kind, msg });
}

function runAuth(...args) {
  return execFileSync('sudo', ['/usr/local/sbin/paywifi-auth', ...args],
    { encoding: 'utf8', timeout: 5000 }).trim();
}

function getWalledIPs() {
  try {
    const out = runAuth('walled-list');
    const ips = [];
    for (const line of out.split('\n')) {
      const m = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g);
      if (m) ips.push(...m);
    }
    return [...new Set(ips)];
  } catch (e) { return []; }
}

// DB bootstrap
db.prepare(`CREATE TABLE IF NOT EXISTS firewall_whitelist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL UNIQUE,
  domain     TEXT,
  note       TEXT,
  source     TEXT DEFAULT 'manual',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`).run();

// ── GET /admin/firewall ────────────────────────────────────────────────────
router.get('/firewall', async (req, res) => {
  const walledIPs  = getWalledIPs();
  const persisted  = db.prepare('SELECT * FROM firewall_whitelist ORDER BY source, created_at').all();

  // Re-apply any persisted entries not yet active (e.g. after reboot)
  for (const row of persisted) {
    if (!walledIPs.includes(row.ip)) {
      try { runAuth('walled-add', row.ip); walledIPs.push(row.ip); } catch (e) {}
    }
  }

  // Enabled payment modules
  const modules = db.prepare('SELECT * FROM payment_modules WHERE is_active=1').all();

  // Build suggestions
  const suggestions = [];
  for (const mod of modules) {
    const def = MODULE_DOMAINS[mod.slug];
    if (!def) continue;
    for (const entry of def.entries) {
      let ips = [];
      try { ips = await resolve4(entry.domain); } catch (e) {}
      suggestions.push({
        module_name:  def.name,
        module_slug:  mod.slug,
        domain:       entry.domain,
        note:         entry.note,
        server_only:  entry.server_only || false,
        ips,
        all_active:   ips.length > 0 && ips.every(ip => walledIPs.includes(ip)),
        any_active:   ips.some(ip => walledIPs.includes(ip)),
      });
    }
  }

  // Annotate current IPs
  const ipDetails = walledIPs.map(ip => {
    const dbRow = persisted.find(r => r.ip === ip);
    return {
      ip,
      domain:     dbRow?.domain     || null,
      note:       dbRow?.note       || null,
      source:     dbRow?.source     || (SYSTEM_IPS.has(ip) ? 'system' : 'runtime'),
      created_at: dbRow?.created_at || null,
    };
  }).sort((a, b) => {
    const ord = { system: 0, manual: 1, runtime: 2 };
    const ao = a.source.startsWith('module:') ? 1 : ord[a.source] ?? 3;
    const bo = b.source.startsWith('module:') ? 1 : ord[b.source] ?? 3;
    return ao !== bo ? ao - bo : a.ip.localeCompare(b.ip);
  });

  render(res, 'firewall', {
    title:          'Firewall · PAYWIFI',
    active:         'firewall',
    walledIPs, ipDetails, suggestions,
    modulesEnabled: modules.map(m => m.slug),
    sshAllowLan:    getSshLanSetting(),
    adminAllowLan:  getAdminLanSetting(),
  });
});

// ── POST /admin/firewall/whitelist/add ─────────────────────────────────────
router.post('/firewall/whitelist/add', async (req, res) => {
  let { ip, domain, note } = req.body || {};
  ip     = (ip     || '').trim();
  domain = (domain || '').trim();
  note   = (note   || '').trim();

  if (!ip && domain) {
    try {
      const ips = await resolve4(domain);
      ip = ips[0] || '';
    } catch (e) {
      flash(req, 'err', `Could not resolve "${domain}": ${e.message}`);
      return res.redirect('/admin/firewall');
    }
  }

  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    flash(req, 'err', 'Invalid IP address.');
    return res.redirect('/admin/firewall');
  }

  try {
    runAuth('walled-add', ip);
    db.prepare('INSERT OR REPLACE INTO firewall_whitelist (ip,domain,note,source) VALUES (?,?,?,?)')
      .run(ip, domain || null, note || null, 'manual');
    flash(req, 'ok', `Added ${ip}${domain ? ' ('+domain+')' : ''} to whitelist.`);
  } catch (e) {
    flash(req, 'err', 'Failed to add IP: ' + e.message);
  }
  return res.redirect('/admin/firewall');
});

// ── POST /admin/firewall/whitelist/auto-apply ──────────────────────────────
router.post('/firewall/whitelist/auto-apply', async (req, res) => {
  const { slug } = req.body || {};
  const mods = slug
    ? db.prepare('SELECT * FROM payment_modules WHERE slug=? AND enabled=1').all(slug)
    : db.prepare('SELECT * FROM payment_modules WHERE is_active=1').all();

  let added = 0;
  for (const mod of mods) {
    const def = MODULE_DOMAINS[mod.slug];
    if (!def) continue;
    for (const entry of def.entries) {
      let ips = [];
      try { ips = await resolve4(entry.domain); } catch (e) { continue; }
      for (const ip of ips) {
        try {
          runAuth('walled-add', ip);
          db.prepare('INSERT OR IGNORE INTO firewall_whitelist (ip,domain,note,source) VALUES (?,?,?,?)')
            .run(ip, entry.domain, entry.note, `module:${mod.slug}`);
          added++;
        } catch (e) {}
      }
    }
  }
  flash(req, 'ok', `Applied ${added} IP${added !== 1 ? 's' : ''} to whitelist.`);
  return res.redirect('/admin/firewall');
});

// ── POST /admin/firewall/whitelist/remove ──────────────────────────────────
router.post('/firewall/whitelist/remove', (req, res) => {
  const { ip } = req.body || {};
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip || '')) {
    flash(req, 'err', 'Invalid IP address.');
    return res.redirect('/admin/firewall');
  }
  if (SYSTEM_IPS.has(ip)) {
    flash(req, 'err', `${ip} is a system entry and cannot be removed.`);
    return res.redirect('/admin/firewall');
  }
  try {
    runAuth('walled-del', ip);
    db.prepare('DELETE FROM firewall_whitelist WHERE ip=?').run(ip);
    flash(req, 'ok', `Removed ${ip} from whitelist.`);
  } catch (e) {
    flash(req, 'err', 'Failed to remove IP: ' + e.message);
  }
  return res.redirect('/admin/firewall');
});

// ── POST /admin/firewall/ssh ───────────────────────────────────────────────
router.post('/firewall/ssh', (req, res) => {
  const allowLan = (req.body.ssh_allow_lan === '1');
  try {
    applySshRule(allowLan);
    const label = allowLan ? 'WAN + LAN' : 'WAN only';
    flash(req, 'ok', `SSH access set to ${label}. nftables reloaded.`);
    const action = allowLan ? 'ssh_lan_enabled' : 'ssh_lan_disabled';
    db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (?,?,?,?,strftime('%s','now'))")
      .run(req.admin.id, action, `ssh_allow_lan=${allowLan?1:0}`, req.clientIp || '');
  } catch (e) {
    flash(req, 'err', 'Failed to update SSH rule: ' + e.message);
  }
  return res.redirect('/admin/firewall');
});


// ── POST /admin/firewall/admin-acl ────────────────────────────────────────
router.post('/firewall/admin-acl', (req, res) => {
  const allowLan = (req.body.admin_allow_lan === '1');
  try {
    applyAdminAcl(allowLan);
    const label = allowLan ? 'Management + LAN' : 'Management only';
    flash(req, 'ok', `Admin UI access set to ${label}. nginx reloaded.`);
    const action = allowLan ? 'admin_acl_lan_enabled' : 'admin_acl_lan_disabled';
    db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (?,?,?,?,strftime('%s','now'))")
      .run(req.admin.id, action, `admin_allow_lan=${allowLan?1:0}`, req.clientIp || '');
  } catch (e) {
    flash(req, 'err', 'Failed to update Admin UI ACL: ' + e.message);
  }
  return res.redirect('/admin/firewall');
});


module.exports = router;
