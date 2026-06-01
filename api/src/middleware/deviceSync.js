'use strict';
const sessionSvc = require('../services/session');

// Runs on every portal/auth/session request.
// P1: active session exists → touch + handle IP migration
// P2: no session + MAC in remembered_devices → instant re-auth (no 10s sessiond wait)
module.exports = function deviceSync(req, _res, next) {
  if (req.clientMac && req.clientIp) {
    try {
      const sess = sessionSvc.syncDeviceSession(req.clientMac, req.clientIp);
      if (sess) req.activeSession = sess;
    } catch (e) {
      console.error('[deviceSync]', e.message);
    }
  }
  next();
};
