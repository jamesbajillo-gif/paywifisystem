'use strict';
const db = require('../db');

// ── Adapter registry ────────────────────────────────────────────────────────
// Add new adapters here as they are implemented.
const ADAPTERS = {};
try { ADAPTERS.xendit = require('./xendit'); } catch (e) {
  console.warn('[modules] xendit adapter load failed:', e.message);
}
try { ADAPTERS.gcash_native = require('./gcash'); } catch (e) {
  console.warn('[modules] gcash adapter load failed:', e.message);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Return a module by slug (active or not), with parsed config + adapter. */
function getModule(slug) {
  const row = db.prepare('SELECT * FROM payment_modules WHERE slug=?').get(slug);
  if (!row) return null;
  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
  return { ...row, config, adapter: ADAPTERS[row.slug] || null };
}

/** Like getModule but returns null if the module is disabled. */
function getActiveModule(slug) {
  const mod = getModule(slug);
  return (mod && mod.is_active) ? mod : null;
}

/** Return all modules with parsed config, adapter flag, and action definitions. */
function listModules() {
  return db.prepare('SELECT * FROM payment_modules ORDER BY id').all().map(row => {
    let config = {};
    try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
    const adapter = ADAPTERS[row.slug] || null;
    return {
      ...row,
      config,
      hasAdapter: !!adapter,
      actions: adapter ? (adapter.ACTIONS || null) : null,
    };
  });
}

/** Persist a module's config object to DB. */
function saveConfig(slug, configObj) {
  db.prepare('UPDATE payment_modules SET config_json=? WHERE slug=?')
    .run(JSON.stringify(configObj || {}), slug);
}

module.exports = { getModule, getActiveModule, listModules, saveConfig, ADAPTERS };
