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
