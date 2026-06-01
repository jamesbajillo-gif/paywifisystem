#!/usr/bin/env bash
# =============================================================================
#  paywifi-phase6-admin.sh
#  PAYWIFI — Phase 6: Admin Web UI
#    * EJS views layered onto paywifi-api Express app
#    * Cookie-based browser session + CSRF for forms
#    * Pages: dashboard, vouchers (+print), sessions, plans, audit, settings, login
#    * Tailwind via CDN, dark theme matching the portal
#    * nginx config update so /admin proxies to the API
# =============================================================================
#  Usage:  sudo bash paywifi-phase6-admin.sh
#  Prereq: phases 1-5 completed
# =============================================================================

set -o pipefail

CFG_FILE="/etc/paywifi/config.json"
APP_NAME="PAYWIFI"
PAYWIFI_HOME="/opt/paywifi"
PAYWIFI_USER="paywifi"

# ----- helpers ---------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'
  C_BLD=$'\e[1m';  C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_BLD=""; C_RST=""
fi
info()  { echo "${C_BLU}[INFO]${C_RST}  $*"; }
ok()    { echo "${C_GRN}[ OK ]${C_RST}  $*"; }
warn()  { echo "${C_YLW}[WARN]${C_RST}  $*"; }
err()   { echo "${C_RED}[FAIL]${C_RST}  $*" >&2; }
hr()    { echo "${C_BLD}--------------------------------------------------------------------${C_RST}"; }
title() { hr; echo "${C_BLD} $* ${C_RST}"; hr; }
die()   { err "$*"; exit 1; }
confirm() {
  local prompt="$1" default="${2:-Y}" hint="[Y/n]" reply
  [[ "$default" == "N" ]] && hint="[y/N]"
  read -r -p "${C_YLW}?${C_RST} ${prompt} ${hint} " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ----- preflight -------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
[[ -f "$CFG_FILE" ]] || die "Config not found — run earlier phases."
systemctl is-active --quiet paywifi-api || die "paywifi-api not running — run phase 4."

LAN_GW=$(jq -r '.network.lan_gateway' "$CFG_FILE")
API_PORT=$(jq -r '.api.port' "$CFG_FILE")

title "PAYWIFI Phase 6 — Admin Web UI"
info "Mounting admin UI at http://${LAN_GW}/admin"
info "Same Express process as the API (no extra service)"
echo
confirm "Install Phase 6?" || die "Aborted."

# ============================================================================
#  1) Add ejs + csurf + express-session to dependencies
# ============================================================================
title "1/5  Installing extra Node dependencies"

cd "$PAYWIFI_HOME/api"
sudo -u "$PAYWIFI_USER" npm install --omit=dev --silent \
  ejs@^3.1.10 \
  express-session@^1.18.0 \
  || die "npm install failed."
ok "Installed ejs + express-session."

# ============================================================================
#  2) Write EJS views + admin routes
# ============================================================================
title "2/5  Writing admin views + routes"

mkdir -p "$PAYWIFI_HOME/api/views/admin"

# ---- layout (shared shell) -------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/_layout.ejs" <<'EJS'
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title><%= title || 'PAYWIFI Admin' %></title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { darkMode: 'class', theme: { extend: {
    colors: { brand: { 50:'#f0f9ff',100:'#e0f2fe',400:'#38bdf8',500:'#0ea5e9',600:'#0284c7',700:'#0369a1' } }
  }}};
</script>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .code-cell { font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.05em; }
  @media print {
    .no-print { display: none !important; }
    body { background: white !important; color: black !important; }
  }
</style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">

<% if (admin) { %>
  <nav class="no-print bg-slate-800 border-b border-slate-700 px-6 py-3 flex items-center gap-6">
    <a href="/admin/" class="font-bold text-brand-400 text-lg">PAYWIFI</a>
    <a href="/admin/" class="text-sm <%= active === 'dash' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Dashboard</a>
    <a href="/admin/vouchers" class="text-sm <%= active === 'vouchers' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Vouchers</a>
    <a href="/admin/sessions" class="text-sm <%= active === 'sessions' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Sessions</a>
    <a href="/admin/plans" class="text-sm <%= active === 'plans' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Plans</a>
    <a href="/admin/audit" class="text-sm <%= active === 'audit' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Audit</a>
    <a href="/admin/settings" class="text-sm <%= active === 'settings' ? 'text-brand-400' : 'text-slate-400 hover:text-slate-100' %>">Settings</a>
    <span class="ml-auto text-xs text-slate-400">
      <%= admin.username %>
      <form method="POST" action="/admin/logout" class="inline ml-3">
        <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
        <button class="text-rose-400 hover:underline" type="submit">Logout</button>
      </form>
    </span>
  </nav>
<% } %>

<% if (flash && flash.length) { %>
  <div class="no-print px-6 pt-4">
    <% flash.forEach(function(f) { %>
      <div class="rounded px-4 py-2 mb-2 <%= f.kind === 'err' ? 'bg-rose-900 text-rose-200' : 'bg-emerald-900 text-emerald-200' %>">
        <%= f.msg %>
      </div>
    <% }) %>
  </div>
<% } %>

<main class="px-6 py-6 max-w-7xl mx-auto"><%- body %></main>

</body>
</html>
EJS

# ---- login -----------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/login.ejs" <<'EJS'
<div class="max-w-sm mx-auto mt-16 bg-slate-800 p-8 rounded-xl shadow-lg">
  <h1 class="text-2xl font-bold text-brand-400 mb-1">PAYWIFI Admin</h1>
  <p class="text-sm text-slate-400 mb-6">Sign in to continue.</p>
  <% if (error) { %>
    <div class="bg-rose-900 text-rose-200 rounded px-3 py-2 mb-4 text-sm"><%= error %></div>
  <% } %>
  <form method="POST" action="/admin/login">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
    <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Username</label>
    <input name="username" autofocus autocomplete="username"
           class="w-full mb-4 px-3 py-2 rounded bg-slate-900 border border-slate-700 focus:border-brand-500 focus:outline-none" />
    <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Password</label>
    <input name="password" type="password" autocomplete="current-password"
           class="w-full mb-6 px-3 py-2 rounded bg-slate-900 border border-slate-700 focus:border-brand-500 focus:outline-none" />
    <button class="w-full py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Sign in</button>
  </form>
</div>
EJS

# ---- dashboard --------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/dashboard.ejs" <<'EJS'
<h1 class="text-2xl font-bold mb-6">Dashboard</h1>

<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
  <div class="bg-slate-800 rounded-lg p-4">
    <div class="text-xs uppercase text-slate-400 tracking-wide">Active sessions</div>
    <div class="text-3xl font-semibold mt-1"><%= stats.sessions_active %></div>
  </div>
  <div class="bg-slate-800 rounded-lg p-4">
    <div class="text-xs uppercase text-slate-400 tracking-wide">Sessions (24h)</div>
    <div class="text-3xl font-semibold mt-1"><%= stats.sessions_24h %></div>
  </div>
  <div class="bg-slate-800 rounded-lg p-4">
    <div class="text-xs uppercase text-slate-400 tracking-wide">Data (24h, up + down)</div>
    <div class="text-3xl font-semibold mt-1"><%= fmtBytes(stats.bytes_24h) %></div>
  </div>
  <div class="bg-slate-800 rounded-lg p-4">
    <div class="text-xs uppercase text-slate-400 tracking-wide">Unused vouchers</div>
    <div class="text-3xl font-semibold mt-1"><%= stats.vouchers_unused %></div>
  </div>
</div>

<div class="grid md:grid-cols-2 gap-6">
  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">Vouchers by status</h2>
    <table class="w-full text-sm">
      <tbody>
        <% ['unused','active','expired','revoked'].forEach(function(k){ %>
          <tr class="border-t border-slate-700">
            <td class="py-2 text-slate-400 capitalize"><%= k %></td>
            <td class="py-2 text-right"><%= stats.vouchers[k] || 0 %></td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>

  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">Latest audit</h2>
    <ul class="text-sm divide-y divide-slate-700">
      <% audit.slice(0, 8).forEach(function(a){ %>
        <li class="py-2 flex">
          <div class="text-slate-400 text-xs w-32"><%= new Date(a.created_at*1000).toLocaleString() %></div>
          <div class="flex-1">
            <span class="text-brand-400"><%= a.username || '—' %></span>
            <span class="text-slate-300">  <%= a.action %></span>
            <% if (a.details) { %><span class="text-slate-500 text-xs">  <%= a.details %></span><% } %>
          </div>
        </li>
      <% }) %>
    </ul>
  </div>
</div>
EJS

# ---- vouchers list ---------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/vouchers.ejs" <<'EJS'
<div class="flex items-center mb-6">
  <h1 class="text-2xl font-bold">Vouchers</h1>
  <a href="/admin/vouchers/new" class="ml-auto px-4 py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold text-sm">+ Generate batch</a>
</div>

<form method="GET" action="/admin/vouchers" class="mb-4 flex gap-2 text-sm">
  <select name="status" class="bg-slate-800 border border-slate-700 rounded px-3 py-1.5">
    <option value="">All statuses</option>
    <% ['unused','active','expired','revoked'].forEach(function(s){ %>
      <option value="<%= s %>" <%= filter === s ? 'selected' : '' %>><%= s %></option>
    <% }) %>
  </select>
  <button class="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600">Filter</button>
</form>

<div class="bg-slate-800 rounded-lg overflow-hidden">
  <table class="w-full text-sm">
    <thead class="bg-slate-700 text-slate-300">
      <tr>
        <th class="px-3 py-2 text-left">Code</th>
        <th class="px-3 py-2 text-left">Status</th>
        <th class="px-3 py-2 text-left">Duration</th>
        <th class="px-3 py-2 text-left">Speed</th>
        <th class="px-3 py-2 text-left">Devices</th>
        <th class="px-3 py-2 text-left">Created</th>
        <th class="px-3 py-2 text-left">Expires</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <% vouchers.forEach(function(v){ %>
        <tr class="border-t border-slate-700">
          <td class="px-3 py-2 code-cell"><%= v.code %></td>
          <td class="px-3 py-2">
            <span class="px-2 py-0.5 text-xs rounded-full
              <%= v.status === 'unused'  ? 'bg-slate-700 text-slate-300' :
                  v.status === 'active'  ? 'bg-emerald-800 text-emerald-200' :
                  v.status === 'expired' ? 'bg-amber-900 text-amber-200' :
                                            'bg-rose-900 text-rose-200' %>"><%= v.status %></span>
          </td>
          <td class="px-3 py-2"><%= fmtDuration(v.duration_minutes) %></td>
          <td class="px-3 py-2"><%= (v.bandwidth_kbps/1024).toFixed(1) %> Mbps</td>
          <td class="px-3 py-2"><%= v.max_devices %></td>
          <td class="px-3 py-2 text-slate-400 text-xs"><%= new Date(v.created_at*1000).toLocaleString() %></td>
          <td class="px-3 py-2 text-slate-400 text-xs">
            <%= v.expires_at ? new Date(v.expires_at*1000).toLocaleString() : '—' %>
          </td>
          <td class="px-3 py-2">
            <% if (v.status !== 'revoked') { %>
              <form method="POST" action="/admin/vouchers/<%= v.id %>/revoke" class="inline">
                <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
                <button class="text-rose-400 hover:underline text-xs" onclick="return confirm('Revoke voucher <%= v.code %>?')">Revoke</button>
              </form>
            <% } %>
          </td>
        </tr>
      <% }) %>
      <% if (!vouchers.length) { %>
        <tr><td colspan="8" class="px-3 py-8 text-center text-slate-500">No vouchers.</td></tr>
      <% } %>
    </tbody>
  </table>
</div>
EJS

# ---- voucher generation -----------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/voucher_new.ejs" <<'EJS'
<h1 class="text-2xl font-bold mb-6">Generate vouchers</h1>

<div class="bg-slate-800 rounded-lg p-6 max-w-xl">
  <form method="POST" action="/admin/vouchers" class="space-y-4">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>" />

    <div>
      <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Plan (optional shortcut)</label>
      <select name="plan_id"
              class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
        <option value="">— Custom values below —</option>
        <% plans.forEach(function(p){ %>
          <option value="<%= p.id %>" data-dur="<%= p.duration_minutes %>" data-bw="<%= p.bandwidth_kbps %>" data-dev="<%= p.max_devices %>">
            <%= p.name %> (<%= fmtDuration(p.duration_minutes) %>, <%= (p.bandwidth_kbps/1024).toFixed(1) %> Mbps, <%= p.max_devices %> dev)
          </option>
        <% }) %>
      </select>
    </div>

    <div class="grid grid-cols-3 gap-4">
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Duration (min)</label>
        <input name="duration_minutes" id="dur" type="number" min="1" value="60" required
               class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Bandwidth (kbps)</label>
        <input name="bandwidth_kbps" id="bw" type="number" min="64" value="5120" required
               class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Max devices</label>
        <input name="max_devices" id="dev" type="number" min="1" value="1" required
               class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Count (1–500)</label>
        <input name="count" type="number" min="1" max="500" value="10" required
               class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Batch name (optional)</label>
        <input name="batch_name" placeholder="e.g. Lobby Reception May"
               class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
    </div>

    <div class="pt-4 flex gap-2">
      <button class="px-4 py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Generate</button>
      <a href="/admin/vouchers" class="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600">Cancel</a>
    </div>
  </form>
</div>

<script>
document.querySelector('select[name=plan_id]').addEventListener('change', function(e){
  const o = e.target.selectedOptions[0];
  if (!o || !o.dataset.dur) return;
  document.getElementById('dur').value = o.dataset.dur;
  document.getElementById('bw').value  = o.dataset.bw;
  document.getElementById('dev').value = o.dataset.dev;
});
</script>
EJS

# ---- print view (after generation) -----------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/voucher_print.ejs" <<'EJS'
<div class="no-print mb-6 flex items-center">
  <div>
    <h1 class="text-2xl font-bold">Generated <%= codes.length %> vouchers</h1>
    <p class="text-slate-400 text-sm"><%= fmtDuration(duration_minutes) %> · <%= (bandwidth_kbps/1024).toFixed(1) %> Mbps · <%= max_devices %> device(s)</p>
  </div>
  <div class="ml-auto flex gap-2">
    <button onclick="window.print()" class="px-4 py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Print</button>
    <a href="/admin/vouchers" class="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600">Done</a>
  </div>
</div>

<div class="grid grid-cols-2 md:grid-cols-4 gap-3 print:gap-2">
  <% codes.forEach(function(code){ %>
    <div class="bg-white text-slate-900 rounded-lg p-3 border border-slate-300 print:break-inside-avoid">
      <div class="text-xs text-slate-500 uppercase tracking-wider">PAYWIFI Voucher</div>
      <div class="code-cell text-2xl font-bold tracking-widest my-2"><%= code %></div>
      <div class="text-xs text-slate-600"><%= fmtDuration(duration_minutes) %> · <%= (bandwidth_kbps/1024).toFixed(1) %> Mbps</div>
    </div>
  <% }) %>
</div>
EJS

# ---- sessions ---------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/sessions.ejs" <<'EJS'
<h1 class="text-2xl font-bold mb-6">Sessions</h1>

<form method="GET" action="/admin/sessions" class="mb-4 flex gap-2 text-sm">
  <select name="active" class="bg-slate-800 border border-slate-700 rounded px-3 py-1.5">
    <option value="true"  <%= activeOnly ? 'selected' : '' %>>Active only</option>
    <option value="false" <%= !activeOnly ? 'selected' : '' %>>All (history)</option>
  </select>
  <button class="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600">Filter</button>
</form>

<div class="bg-slate-800 rounded-lg overflow-hidden">
  <table class="w-full text-sm">
    <thead class="bg-slate-700 text-slate-300">
      <tr>
        <th class="px-3 py-2 text-left">ID</th>
        <th class="px-3 py-2 text-left">Voucher</th>
        <th class="px-3 py-2 text-left">MAC</th>
        <th class="px-3 py-2 text-left">IP</th>
        <th class="px-3 py-2 text-left">Started</th>
        <th class="px-3 py-2 text-left">Last seen</th>
        <th class="px-3 py-2 text-right">Up</th>
        <th class="px-3 py-2 text-right">Down</th>
        <th class="px-3 py-2 text-left">Status</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <% sessions.forEach(function(s){ %>
        <tr class="border-t border-slate-700">
          <td class="px-3 py-2 text-slate-500">#<%= s.id %></td>
          <td class="px-3 py-2 code-cell"><%= s.voucher_code %></td>
          <td class="px-3 py-2 code-cell text-xs"><%= s.mac_address %></td>
          <td class="px-3 py-2 code-cell text-xs"><%= s.ip_address %></td>
          <td class="px-3 py-2 text-slate-400 text-xs"><%= new Date(s.started_at*1000).toLocaleString() %></td>
          <td class="px-3 py-2 text-slate-400 text-xs"><%= new Date(s.last_seen_at*1000).toLocaleString() %></td>
          <td class="px-3 py-2 text-right"><%= fmtBytes(s.bytes_in) %></td>
          <td class="px-3 py-2 text-right"><%= fmtBytes(s.bytes_out) %></td>
          <td class="px-3 py-2">
            <% if (s.ended_at) { %>
              <span class="text-xs text-slate-400"><%= s.end_reason || 'ended' %></span>
            <% } else { %>
              <span class="text-xs text-emerald-400">active</span>
            <% } %>
          </td>
          <td class="px-3 py-2">
            <% if (!s.ended_at) { %>
              <form method="POST" action="/admin/sessions/<%= s.id %>/kick" class="inline">
                <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
                <button class="text-rose-400 hover:underline text-xs" onclick="return confirm('Kick session #<%= s.id %>?')">Kick</button>
              </form>
            <% } %>
          </td>
        </tr>
      <% }) %>
      <% if (!sessions.length) { %>
        <tr><td colspan="10" class="px-3 py-8 text-center text-slate-500">No sessions.</td></tr>
      <% } %>
    </tbody>
  </table>
</div>
EJS

# ---- plans ------------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/plans.ejs" <<'EJS'
<div class="flex items-center mb-6">
  <h1 class="text-2xl font-bold">Plans</h1>
</div>

<div class="grid md:grid-cols-2 gap-6">
  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">Existing plans</h2>
    <table class="w-full text-sm">
      <thead class="text-slate-400 text-xs uppercase">
        <tr><th class="text-left py-2">Name</th><th class="text-left">Duration</th><th class="text-left">Speed</th><th class="text-left">Dev</th><th class="text-left">Price</th><th></th></tr>
      </thead>
      <tbody>
        <% plans.forEach(function(p){ %>
          <tr class="border-t border-slate-700">
            <td class="py-2"><%= p.name %></td>
            <td><%= fmtDuration(p.duration_minutes) %></td>
            <td><%= (p.bandwidth_kbps/1024).toFixed(1) %> Mbps</td>
            <td><%= p.max_devices %></td>
            <td><%= p.price %></td>
            <td>
              <form method="POST" action="/admin/plans/<%= p.id %>/delete" class="inline">
                <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
                <button class="text-rose-400 hover:underline text-xs" onclick="return confirm('Delete plan?')">×</button>
              </form>
            </td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>

  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">Add plan</h2>
    <form method="POST" action="/admin/plans" class="space-y-3 text-sm">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
      <input name="name" placeholder="Name (e.g. 2 Hours @ 8Mbps)" required class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      <div class="grid grid-cols-2 gap-3">
        <input name="duration_minutes" type="number" min="1" placeholder="Duration (min)" required class="px-3 py-2 rounded bg-slate-900 border border-slate-700">
        <input name="bandwidth_kbps" type="number" min="64" placeholder="Bandwidth (kbps)" required class="px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <input name="max_devices" type="number" min="1" value="1" placeholder="Max devices" required class="px-3 py-2 rounded bg-slate-900 border border-slate-700">
        <input name="price" type="number" min="0" step="0.01" value="0" placeholder="Price" required class="px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <button class="w-full py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Add plan</button>
    </form>
  </div>
</div>
EJS

# ---- audit ------------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/audit.ejs" <<'EJS'
<h1 class="text-2xl font-bold mb-6">Audit log</h1>

<div class="bg-slate-800 rounded-lg overflow-hidden">
  <table class="w-full text-sm">
    <thead class="bg-slate-700 text-slate-300">
      <tr>
        <th class="px-3 py-2 text-left">When</th>
        <th class="px-3 py-2 text-left">Admin</th>
        <th class="px-3 py-2 text-left">Action</th>
        <th class="px-3 py-2 text-left">Details</th>
        <th class="px-3 py-2 text-left">From IP</th>
      </tr>
    </thead>
    <tbody>
      <% entries.forEach(function(a){ %>
        <tr class="border-t border-slate-700">
          <td class="px-3 py-2 text-slate-400 text-xs"><%= new Date(a.created_at*1000).toLocaleString() %></td>
          <td class="px-3 py-2"><%= a.username || '—' %></td>
          <td class="px-3 py-2 text-brand-400"><%= a.action %></td>
          <td class="px-3 py-2 text-slate-400 text-xs"><%= a.details || '' %></td>
          <td class="px-3 py-2 code-cell text-xs"><%= a.ip_address || '' %></td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</div>
EJS

# ---- settings ---------------------------------------------------------------
cat >"$PAYWIFI_HOME/api/views/admin/settings.ejs" <<'EJS'
<h1 class="text-2xl font-bold mb-6">Settings</h1>

<div class="grid md:grid-cols-2 gap-6">
  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">System settings</h2>
    <form method="POST" action="/admin/settings" class="space-y-3 text-sm">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
      <% settings.forEach(function(s){ %>
        <div>
          <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1"><%= s.key %></label>
          <input name="<%= s.key %>" value="<%= s.value %>"
                 class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 code-cell">
        </div>
      <% }) %>
      <button class="w-full py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Save settings</button>
    </form>
  </div>

  <div class="bg-slate-800 rounded-lg p-4">
    <h2 class="font-semibold mb-3">Change admin password</h2>
    <form method="POST" action="/admin/password" class="space-y-3 text-sm">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Current password</label>
        <input name="current" type="password" required class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">New password (min 8)</label>
        <input name="next" type="password" required minlength="8" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Confirm new password</label>
        <input name="confirm" type="password" required minlength="8" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700">
      </div>
      <button class="w-full py-2 rounded bg-brand-500 hover:bg-brand-400 text-slate-900 font-semibold">Change password</button>
    </form>
  </div>
</div>
EJS

ok "EJS templates written."

# ============================================================================
#  3) Admin UI router
# ============================================================================

# Helper utilities used by the views
cat >"$PAYWIFI_HOME/api/src/utils/format.js" <<'JS'
'use strict';
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB','MB','GB','TB'];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + ' ' + u[i];
}
function fmtDuration(min) {
  min = Number(min) || 0;
  if (min < 60)    return min + ' min';
  if (min < 1440)  return (min / 60).toFixed(min % 60 ? 1 : 0) + ' h';
  return (min / 1440).toFixed(min % 1440 ? 1 : 0) + ' d';
}
module.exports = { fmtBytes, fmtDuration };
JS

mkdir -p "$PAYWIFI_HOME/api/src/utils"
# (Directory already exists for some files; mkdir before write would be safer)

# Simple CSRF without external deps — token bound to session
cat >"$PAYWIFI_HOME/api/src/middleware/csrf.js" <<'JS'
'use strict';
const crypto = require('crypto');

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

// Attach csrfToken to res.locals for every request, and verify on unsafe methods.
module.exports = function csrf(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token;

  const unsafe = ['POST','PUT','PATCH','DELETE'].includes(req.method);
  if (!unsafe) return next();

  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (!sent || sent !== token) {
    return res.status(403).send('CSRF token invalid. Reload the page and try again.');
  }
  next();
};
JS

# Cookie-session admin auth: looks up the admin from the session; falls back to login
cat >"$PAYWIFI_HOME/api/src/middleware/adminSession.js" <<'JS'
'use strict';
const db = require('../db');

module.exports = function adminSession(req, res, next) {
  if (req.session && req.session.adminId) {
    const u = db.prepare('SELECT id, username, role FROM admin_users WHERE id = ?').get(req.session.adminId);
    if (u) { req.admin = u; res.locals.admin = u; }
  }
  res.locals.admin = res.locals.admin || null;
  res.locals.flash = req.session?.flash || [];
  if (req.session) req.session.flash = [];
  next();
};
JS

# The router
cat >"$PAYWIFI_HOME/api/src/routes/adminUi.js" <<'JS'
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db');
const { fmtBytes, fmtDuration } = require('../utils/format');
const voucherSvc = require('../services/voucher');
const sessionSvc = require('../services/session');

function render(res, view, locals = {}) {
  res.render('admin/' + view, {
    title: locals.title || 'PAYWIFI Admin',
    active: locals.active || '',
    error: null,
    fmtBytes, fmtDuration,
    ...locals
  });
}

function audit(adminId, action, details, ip) {
  db.prepare(`
    INSERT INTO audit_log (admin_id, action, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId || null, action, details || null, ip || null, Math.floor(Date.now()/1000));
}

function flash(req, kind, msg) {
  if (!req.session) return;
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ kind, msg });
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.redirect('/admin/login');
  next();
}

// ---- Login -----------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin/');
  render(res, 'login', { title: 'Sign in · PAYWIFI', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return render(res, 'login', { title: 'Sign in · PAYWIFI', error: 'Invalid credentials.' });
  }
  req.session.adminId = u.id;
  db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(Math.floor(Date.now()/1000), u.id);
  audit(u.id, 'admin_login_ui', null, req.clientIp);
  res.redirect('/admin/');
});

router.post('/logout', (req, res) => {
  const adminId = req.admin?.id;
  req.session.destroy(() => {
    if (adminId) audit(adminId, 'admin_logout_ui', null, req.clientIp);
    res.redirect('/admin/login');
  });
});

// ---- Everything below requires login ---------------------------------------
router.use(requireAdmin);

// ---- Dashboard -------------------------------------------------------------
router.get('/', (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const since = now - 24 * 3600;

  const vRows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM vouchers GROUP BY status
  `).all();
  const vouchers = Object.fromEntries(vRows.map(r => [r.status, r.n]));

  const sActive = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL`).get().n;
  const s24 = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`).get(since).n;
  const bytes = db.prepare(`SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS n FROM sessions WHERE started_at >= ?`).get(since).n;

  const audit = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN admin_users u ON u.id = a.admin_id
    ORDER BY a.id DESC LIMIT 20
  `).all();

  render(res, 'dashboard', {
    title: 'Dashboard · PAYWIFI',
    active: 'dash',
    stats: {
      sessions_active: sActive,
      sessions_24h: s24,
      bytes_24h: bytes,
      vouchers_unused: vouchers.unused || 0,
      vouchers
    },
    audit
  });
});

// ---- Vouchers --------------------------------------------------------------
router.get('/vouchers', (req, res) => {
  const status = req.query.status || '';
  let vouchers;
  if (status) {
    vouchers = db.prepare(`SELECT * FROM vouchers WHERE status = ? ORDER BY id DESC LIMIT 500`).all(status);
  } else {
    vouchers = db.prepare(`SELECT * FROM vouchers ORDER BY id DESC LIMIT 500`).all();
  }
  render(res, 'vouchers', { title: 'Vouchers · PAYWIFI', active: 'vouchers', vouchers, filter: status });
});

router.get('/vouchers/new', (req, res) => {
  const plans = db.prepare(`SELECT * FROM voucher_plans WHERE is_active = 1 ORDER BY duration_minutes`).all();
  render(res, 'voucher_new', { title: 'Generate vouchers', active: 'vouchers', plans });
});

router.post('/vouchers', (req, res) => {
  const duration_minutes = parseInt(req.body.duration_minutes, 10);
  const bandwidth_kbps   = parseInt(req.body.bandwidth_kbps, 10);
  const max_devices      = Math.max(1, parseInt(req.body.max_devices || '1', 10));
  const count            = Math.min(500, Math.max(1, parseInt(req.body.count || '1', 10)));
  const batch_name       = (req.body.batch_name || '').trim() || null;

  if (!duration_minutes || !bandwidth_kbps) {
    flash(req, 'err', 'Duration and bandwidth required.');
    return res.redirect('/admin/vouchers/new');
  }

  const now = Math.floor(Date.now()/1000);
  let batchId = null;
  if (batch_name) {
    batchId = db.prepare(`INSERT INTO voucher_batches (name, created_by, created_at) VALUES (?,?,?)`)
      .run(batch_name, req.admin.id, now).lastInsertRowid;
  }

  const codeLen = parseInt(db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get()?.value || '8', 10);
  const ins = db.prepare(`
    INSERT INTO vouchers (code, batch_id, duration_minutes, bandwidth_kbps, max_devices, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'unused', ?)
  `);
  const codes = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 5; a++) {
        const code = voucherSvc.generateCode(codeLen);
        try { ins.run(code, batchId, duration_minutes, bandwidth_kbps, max_devices, now); codes.push(code); break; }
        catch (e) { if (a === 4) throw e; }
      }
    }
  })();

  audit(req.admin.id, 'voucher_create_ui', `n=${count} dur=${duration_minutes} bw=${bandwidth_kbps}`, req.clientIp);
  render(res, 'voucher_print', {
    title: 'Print vouchers',
    active: 'vouchers',
    codes, duration_minutes, bandwidth_kbps, max_devices
  });
});

router.post('/vouchers/:id/revoke', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(id);
  if (!v) { flash(req, 'err', 'Voucher not found.'); return res.redirect('/admin/vouchers'); }

  db.prepare("UPDATE vouchers SET status='revoked' WHERE id=?").run(id);
  const sessions = db.prepare("SELECT id FROM sessions WHERE voucher_id=? AND ended_at IS NULL").all(id);
  const now = Math.floor(Date.now()/1000);
  for (const s of sessions) sessionSvc.endSession(s.id, 'kicked', now);

  audit(req.admin.id, 'voucher_revoke_ui', `id=${id} code=${v.code}`, req.clientIp);
  flash(req, 'ok', `Voucher ${v.code} revoked.`);
  res.redirect('/admin/vouchers');
});

// ---- Sessions --------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const activeOnly = req.query.active !== 'false';
  const sql = `
    SELECT s.*, v.code AS voucher_code
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     ${activeOnly ? 'WHERE s.ended_at IS NULL' : ''}
     ORDER BY s.id DESC LIMIT 200
  `;
  render(res, 'sessions', {
    title: 'Sessions · PAYWIFI',
    active: 'sessions',
    sessions: db.prepare(sql).all(),
    activeOnly
  });
});

router.post('/sessions/:id/kick', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = sessionSvc.endSession(id, 'kicked', Math.floor(Date.now()/1000));
  if (ok) audit(req.admin.id, 'session_kick_ui', `id=${id}`, req.clientIp);
  flash(req, ok ? 'ok' : 'err', ok ? `Session #${id} kicked.` : `Session #${id} not found.`);
  res.redirect('/admin/sessions');
});

// ---- Plans -----------------------------------------------------------------
router.get('/plans', (req, res) => {
  const plans = db.prepare(`SELECT * FROM voucher_plans ORDER BY id`).all();
  render(res, 'plans', { title: 'Plans · PAYWIFI', active: 'plans', plans });
});

router.post('/plans', (req, res) => {
  const { name, duration_minutes, bandwidth_kbps, max_devices, price } = req.body || {};
  if (!name || !duration_minutes || !bandwidth_kbps) {
    flash(req, 'err', 'Name, duration and bandwidth required.');
    return res.redirect('/admin/plans');
  }
  try {
    db.prepare(`
      INSERT INTO voucher_plans (name, duration_minutes, bandwidth_kbps, max_devices, price, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(name, parseInt(duration_minutes,10), parseInt(bandwidth_kbps,10),
           Math.max(1,parseInt(max_devices||'1',10)), parseFloat(price||'0'),
           Math.floor(Date.now()/1000));
    audit(req.admin.id, 'plan_create_ui', name, req.clientIp);
    flash(req, 'ok', `Plan "${name}" added.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/plans');
});

router.post('/plans/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM voucher_plans WHERE id=?`).run(id);
  audit(req.admin.id, 'plan_delete_ui', `id=${id}`, req.clientIp);
  flash(req, 'ok', 'Plan deleted.');
  res.redirect('/admin/plans');
});

// ---- Audit -----------------------------------------------------------------
router.get('/audit', (req, res) => {
  const entries = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN admin_users u ON u.id = a.admin_id
    ORDER BY a.id DESC LIMIT 500
  `).all();
  render(res, 'audit', { title: 'Audit · PAYWIFI', active: 'audit', entries });
});

// ---- Settings --------------------------------------------------------------
router.get('/settings', (req, res) => {
  const settings = db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
  render(res, 'settings', { title: 'Settings · PAYWIFI', active: 'settings', settings });
});

router.post('/settings', (req, res) => {
  const upd = db.prepare(`UPDATE settings SET value=?, updated_at=? WHERE key=?`);
  const now = Math.floor(Date.now()/1000);
  const known = db.prepare(`SELECT key FROM settings`).all().map(r => r.key);
  for (const k of known) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) {
      upd.run(String(req.body[k]), now, k);
    }
  }
  audit(req.admin.id, 'settings_update_ui', null, req.clientIp);
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.post('/password', (req, res) => {
  const { current, next, confirm } = req.body || {};
  const u = db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.admin.id);
  if (!u || !bcrypt.compareSync(current || '', u.password_hash)) {
    flash(req, 'err', 'Current password incorrect.');
    return res.redirect('/admin/settings');
  }
  if (!next || next.length < 8) {
    flash(req, 'err', 'New password too short (min 8).');
    return res.redirect('/admin/settings');
  }
  if (next !== confirm) {
    flash(req, 'err', 'Passwords do not match.');
    return res.redirect('/admin/settings');
  }
  const hash = bcrypt.hashSync(next, 10);
  db.prepare(`UPDATE admin_users SET password_hash=? WHERE id=?`).run(hash, u.id);
  audit(u.id, 'admin_password_change', null, req.clientIp);
  flash(req, 'ok', 'Password changed.');
  res.redirect('/admin/settings');
});

module.exports = router;
JS

ok "Admin router written."

# ============================================================================
#  4) Update server.js to mount the admin UI
# ============================================================================
title "3/5  Updating server.js to mount /admin"

cat >"$PAYWIFI_HOME/api/src/server.js" <<'JS'
'use strict';
const path    = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const db      = require('./db');
const clientInfo  = require('./middleware/clientInfo');
const csrf        = require('./middleware/csrf');
const adminSession= require('./middleware/adminSession');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Custom layout: every render is wrapped by admin/_layout.ejs
const ejs = require('ejs');
app.engine('ejs', (filePath, options, callback) => {
  ejs.renderFile(filePath, options, (err, body) => {
    if (err) return callback(err);
    const layoutPath = path.join(__dirname, '..', 'views', 'admin', '_layout.ejs');
    ejs.renderFile(layoutPath, { ...options, body }, callback);
  });
});

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
app.use(session({
  name: 'paywifi.admin.sid',
  secret: db.cfg.api.jwt_secret,            // reuse the JWT secret as session secret
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 12 * 3600 * 1000 }
}));
app.use(clientInfo);

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} ip=${req.clientIp || '?'} mac=${req.clientMac || '?'}`);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, app: db.cfg.app.name, time: new Date().toISOString() }));

// ---- JSON API (Bearer JWT, no CSRF needed for /api/*) ---------------------
app.use('/portal',  require('./routes/portal'));
app.use('/auth',    require('./routes/auth'));
app.use('/session', require('./routes/session'));
app.use('/admin/api', require('./routes/admin'));   // keep JSON admin under /admin/api for clarity
// Backwards-compat: original /admin JSON endpoints (kept)
app.use('/admin-api', require('./routes/admin'));

// ---- Admin web UI (cookie session + CSRF) ---------------------------------
app.use('/admin', adminSession, csrf, require('./routes/adminUi'));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found.');
  res.status(404).json({ ok: false, error: 'Not found.' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('ERR', err);
  if (req.path.startsWith('/admin')) return res.status(500).send('Internal error: ' + (err.message || ''));
  res.status(500).json({ ok: false, error: err.message || 'Internal error.' });
});

const port = db.cfg.api.port || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`[PAYWIFI] API + Admin UI listening on 127.0.0.1:${port}`);
});
JS
ok "server.js updated (CSRF + sessions + EJS layout + admin UI mounted)."

# ============================================================================
#  5) nginx — proxy /admin to the API too
# ============================================================================
title "4/5  Updating nginx for /admin"

# Patch nginx: we previously only proxied /api/. Now we also proxy /admin/ to Node.
# Replace the existing PAYWIFI site config wholesale (it's idempotent).
cat >/etc/nginx/sites-available/paywifi <<EOF
# PAYWIFI portal + API + admin proxy
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root ${PAYWIFI_HOME}/portal;
    index index.html;

    access_log /var/log/paywifi/nginx-access.log;
    error_log  /var/log/paywifi/nginx-error.log warn;

    # OS captive-portal probes
    location = /hotspot-detect.html        { try_files /probes/apple.html =404; }
    location = /library/test/success.html  { try_files /probes/apple.html =404; }
    location = /generate_204               { return 302 http://\$host/; }
    location = /gen_204                    { return 302 http://\$host/; }
    location = /ncsi.txt                   { return 302 http://\$host/; }
    location = /connecttest.txt            { return 302 http://\$host/; }
    location = /redirect                   { return 302 http://\$host/; }

    # JSON API
    location /api/ {
        proxy_pass         http://127.0.0.1:${API_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # Admin web UI (HTML, served by Node)
    location /admin {
        proxy_pass         http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Cookie            \$http_cookie;
        proxy_read_timeout 30s;
    }

    # Portal static files
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

if nginx -t 2>&1 | grep -q "successful"; then
  ok "nginx config valid."
  systemctl reload nginx
else
  err "nginx config has errors:"
  nginx -t
  die "Fix nginx config and re-run."
fi

# ============================================================================
#  6) Restart API + smoke test
# ============================================================================
title "5/5  Restarting API + smoke testing"

chown -R "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_HOME/api"
systemctl restart paywifi-api.service
sleep 2

if ! systemctl is-active --quiet paywifi-api; then
  err "paywifi-api failed to restart."
  journalctl -u paywifi-api -n 40 --no-pager || true
  die "Inspect /var/log/paywifi/api.log."
fi
ok "paywifi-api restarted with admin UI."

# Smoke test: login page should return 200 + contain "Sign in"
if curl -fsS "http://127.0.0.1/admin/login" | grep -q "Sign in"; then
  ok "Admin login page reachable."
else
  warn "Admin login page didn't render as expected — check logs."
fi

# /admin/ without session should redirect (302) to /admin/login
status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1/admin/")
if [[ "$status" == "302" ]]; then
  ok "Admin dashboard correctly redirects unauthenticated requests."
else
  warn "Expected 302 on /admin/, got $status."
fi

# ============================================================================
#  Final summary
# ============================================================================
hr
echo "${C_GRN}${C_BLD} ${APP_NAME} Phase 6 complete — admin UI is live.${C_RST}"
hr
echo "Open in a browser (from any LAN client OR the VM itself):"
echo "   http://${LAN_GW}/admin/"
echo
echo "Sign in with the admin user you created in phase 1."
echo
echo "Pages available:"
echo "   /admin/login       — Sign in"
echo "   /admin/            — Dashboard (sessions/vouchers/data/audit)"
echo "   /admin/vouchers    — List + filter + revoke"
echo "   /admin/vouchers/new— Bulk generate (print-friendly view after)"
echo "   /admin/sessions    — Active + history + kick"
echo "   /admin/plans       — Voucher plan CRUD"
echo "   /admin/audit       — Audit log"
echo "   /admin/settings    — System settings + change password"
echo
echo "API endpoints (unchanged):"
echo "   /api/portal/config, /api/auth/voucher, /api/session/*"
echo "   /api/admin/login, /api/admin/vouchers, /api/admin/sessions, etc."
echo "   (JSON admin endpoints also reachable at /admin-api/* for Bearer-token clients)"
echo
echo "PAYWIFI v1 is now fully functional with self-service admin."
echo "Next steps when ready: swap the placeholder portal for your React build."
hr