'use strict';
const router = require('express').Router();
const db     = require('../db');

// GET /admin/infra — infrastructure health (watchdog events + per-layer status)
router.get('/infra', (req, res) => {
  let events = [], summary = [], lastRun = null;
  try {
    events = db.prepare('SELECT id, ts, layer, status, detail FROM infra_events ORDER BY id DESC LIMIT 150').all();
    summary = db.prepare(`
      SELECT layer, status, ts FROM infra_events e
       WHERE id = (SELECT MAX(id) FROM infra_events WHERE layer = e.layer)
       ORDER BY layer`).all();
    const r = db.prepare('SELECT MAX(ts) AS m FROM infra_events').get();
    lastRun = r && r.m ? r.m : null;
  } catch (e) {}
  res.render('admin/infra', {
    title: 'Infrastructure Health · PAYWIFI', active: 'infra',
    events, summary, lastRun, csrfToken: req.csrfToken ? req.csrfToken() : ''
  });
});

module.exports = router;
