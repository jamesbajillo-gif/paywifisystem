'use strict';
const jwt = require('jsonwebtoken');
const { cfg } = require('../db');

module.exports = function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.cookies?.paywifi_admin;
  if (!token) return res.status(401).json({ ok: false, error: 'Auth required.' });
  try {
    req.admin = jwt.verify(token, cfg.api.jwt_secret);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid token.' });
  }
};
