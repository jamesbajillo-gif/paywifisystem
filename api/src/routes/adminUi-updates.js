'use strict';
const router = require('express').Router();
const db     = require('../db');

// GET /admin/updates — changelog / update logs
router.get('/updates', (req, res) => {
  const cat = (req.query.category || '').trim();
  const rows = cat
    ? db.prepare('SELECT * FROM update_logs WHERE category=? ORDER BY created_at DESC, id DESC').all(cat)
    : db.prepare('SELECT * FROM update_logs ORDER BY created_at DESC, id DESC').all();
  const cats = db.prepare('SELECT DISTINCT category FROM update_logs ORDER BY category').all().map(r => r.category);
  res.render('admin/updates', {
    title: 'Update Logs · PAYWIFI', active: 'updates',
    rows, cats, filter: cat, csrfToken: req.csrfToken ? req.csrfToken() : ''
  });
});

// POST /admin/updates/add — add a manual entry
router.post('/updates/add', (req, res) => {
  const title    = (req.body && req.body.title    || '').trim();
  const body     = (req.body && req.body.body     || '').trim();
  let   category = (req.body && req.body.category || 'update').trim() || 'update';
  category = category.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'update';
  if (title) {
    db.prepare('INSERT INTO update_logs (title, body, category, author, created_at) VALUES (?,?,?,?,?)')
      .run(title.slice(0, 200), body.slice(0, 20000), category,
           (req.admin && req.admin.username) || 'admin', Math.floor(Date.now() / 1000));
  }
  res.redirect('/admin/updates');
});

// POST /admin/updates/delete — remove an entry
router.post('/updates/delete', (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  if (id) db.prepare('DELETE FROM update_logs WHERE id=?').run(id);
  res.redirect('/admin/updates');
});

module.exports = router;
