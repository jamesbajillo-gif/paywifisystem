'use strict';
const { macForIp } = require('../services/mac');

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

// Resolve the client's real IP (nginx forwards via X-Real-IP) and MAC.
module.exports = function clientInfo(req, res, next) {
  const xri = req.headers['x-real-ip'];
  const xff = req.headers['x-forwarded-for'];
  const raw = (xri || (xff || '').split(',')[0].trim() || req.ip || '').replace(/^::ffff:/, '');
  req.clientIp  = IPV4_RE.test(raw) ? raw : null;
  req.clientMac = req.clientIp ? macForIp(req.clientIp) : null;
  next();
};
