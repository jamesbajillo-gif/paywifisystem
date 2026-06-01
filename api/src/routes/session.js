'use strict';
const router = require('express').Router();
const sessionSvc = require('../services/session');

// FE-01: map end_reason -> session_state for unauthenticated /status responses
function resolveSessionState(mac) {
  if (!mac) return 'none';
  const last = sessionSvc.findLastEndedByMac(mac);
  if (!last) return 'new_device';
  if (last.end_reason === 'kicked')                            return 'kicked';
  if (['expired', 'quota', 'idle'].includes(last.end_reason)) return 'expired';
  return 'none';
}

router.get('/status', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const s = (req.clientMac ? sessionSvc.findActiveByMac(req.clientMac) : null)
          || sessionSvc.findActiveByIp(req.clientIp);

  // STACK-04/10: always include queue info (empty when no session)
  const queued = sessionSvc.getQueueForMac(req.clientMac);
  const queue_seconds = queued.reduce((sum, v) => sum + v.duration_minutes * 60, 0);

  if (!s) return res.json({
    ok: true,
    authenticated: false,
    session_state: resolveSessionState(req.clientMac),
    queue_count:   queued.length,
    queue_seconds,
    queued_vouchers: queued.map(v => ({
      position:         v.queue_position + 1,
      voucher_code:     v.voucher_code,
      duration_minutes: v.duration_minutes,
      bandwidth_kbps:   v.bandwidth_kbps
    }))
  });

  const remaining = Math.max(0, (s.expires_at || 0) - now);
  // MULTI-FIX-2026-06-01 — derive plan labels for the connected view.
  const _bw  = s.bandwidth_kbps || 0;
  const _spd = _bw >= 1024
    ? (_bw / 1024).toFixed(_bw % 1024 === 0 ? 0 : 1) + ' Mbps'
    : _bw + ' Kbps';
  const _dur = s.duration_minutes || 0;
  const _durLabel = _dur >= 10080 ? Math.floor(_dur/10080) + ' Week' + (_dur >= 20160 ? 's' : '')
                  : _dur >= 1440  ? Math.floor(_dur/1440)  + ' Day'  + (_dur >= 2880  ? 's' : '')
                  : _dur >= 60    ? Math.floor(_dur/60)    + ' Hour' + (_dur >= 120   ? 's' : '')
                  : _dur + ' min';
  res.json({
    ok:                 true,
    authenticated:      true,
    session_state:      'active',
    voucher_code:       s.voucher_code,
    started_at:         s.started_at,
    expires_at:         s.expires_at,
    remaining_seconds:  remaining,
    bandwidth_kbps:     s.bandwidth_kbps,
    duration_minutes:   s.duration_minutes || 0,
    speed_label:        _spd,
    duration_label:     _durLabel,
    bytes_in:           s.bytes_in,
    bytes_out:          s.bytes_out,
    // STACK-04/10: combined time = active remaining + all queued durations
    queue_count:        queued.length,
    queue_seconds,
    total_seconds:      remaining + queue_seconds,
    queued_vouchers:    queued.map(v => ({
      position:         v.queue_position + 1,
      voucher_code:     v.voucher_code,
      duration_minutes: v.duration_minutes,
      bandwidth_kbps:   v.bandwidth_kbps
    }))
  });
});

router.post('/logout', (req, res) => {
  const s = (req.clientMac ? sessionSvc.findActiveByMac(req.clientMac) : null)
          || sessionSvc.findActiveByIp(req.clientIp);
  if (!s) return res.json({ ok: true, message: 'No active session.' });
  const now = Math.floor(Date.now() / 1000);
  sessionSvc.endSession(s.id, 'logout', now);
  res.json({ ok: true, message: 'Logged out.' });
});

module.exports = router;
