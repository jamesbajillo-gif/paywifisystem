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
