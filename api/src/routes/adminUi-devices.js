'use strict';
const router = require('express').Router();
const db     = require('../db');

// GET /admin/devices — per-device captive diagnostics (from paywifi-conn-monitor)
router.get('/devices', (req, res) => {
  let rows = [], events = [], lastRun = null;
  try {
    rows   = db.prepare('SELECT * FROM device_status ORDER BY authorized ASC, ip').all();
    events = db.prepare('SELECT ts, ip, kind, path, status, os FROM device_events ORDER BY id DESC LIMIT 120').all();
    const r = db.prepare('SELECT MAX(updated_at) AS m FROM device_status').get();
    lastRun = r && r.m ? r.m : null;
  } catch (e) {}
  res.render('admin/devices', {
    title: 'Device Diagnostics · PAYWIFI', active: 'devices',
    rows, events, lastRun, csrfToken: req.csrfToken ? req.csrfToken() : ''
  });
});

module.exports = router;
