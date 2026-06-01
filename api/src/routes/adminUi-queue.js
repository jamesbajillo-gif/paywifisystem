'use strict';
const router = require('express').Router();
const db     = require('../db');

// GET /admin/queue — view all active queue entries grouped by MAC
router.get('/queue', (req, res) => {
  // Active sessions with their queued vouchers
  const activeSessions = db.prepare(`
    SELECT s.mac_address, s.ip_address, s.id AS session_id,
           v.code AS voucher_code, v.expires_at, v.bandwidth_kbps,
           s.bytes_in, s.bytes_out
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.ended_at IS NULL
     ORDER BY s.started_at DESC
  `).all();

  const queueRows = db.prepare(`
    SELECT vq.id, vq.mac_address, vq.voucher_id, vq.queue_position, vq.queued_at, vq.status,
           v.code AS voucher_code, v.duration_minutes, v.bandwidth_kbps
      FROM voucher_queue vq
      JOIN vouchers v ON v.id = vq.voucher_id
     WHERE vq.status IN ('waiting','active')
     ORDER BY vq.mac_address, vq.queue_position ASC
  `).all();

  // Group queue entries by mac
  const queueByMac = {};
  for (const row of queueRows) {
    if (!queueByMac[row.mac_address]) queueByMac[row.mac_address] = [];
    queueByMac[row.mac_address].push(row);
  }

  // Merge into display list
  const now = Math.floor(Date.now() / 1000);
  const rows = activeSessions.map(s => ({
    ...s,
    remaining: Math.max(0, (s.expires_at || 0) - now),
    queue: queueByMac[s.mac_address] || []
  }));

  // MACs with only queued (no active session) — waiting for reconnect
  const activeMacs = new Set(activeSessions.map(s => s.mac_address));
  for (const [mac, entries] of Object.entries(queueByMac)) {
    if (!activeMacs.has(mac)) {
      rows.push({ mac_address: mac, ip_address: '-', session_id: null,
        voucher_code: '-', expires_at: null, remaining: 0, queue: entries });
    }
  }

  res.render('admin/queue', { rows, now, title: 'Voucher Queue · PAYWIFI', active: 'queue', csrfToken: req.csrfToken?.() || '' });
});

// POST /admin/queue/remove — remove a single queue entry
router.post('/queue/remove', (req, res) => {
  const id = parseInt(req.body?.id, 10);
  if (!id) return res.redirect('/admin/queue');

  const entry = db.prepare('SELECT * FROM voucher_queue WHERE id=?').get(id);
  if (entry && entry.status === 'waiting') {
    db.prepare("UPDATE vouchers SET status='unused' WHERE id=?").run(entry.voucher_id);
    db.prepare('DELETE FROM voucher_queue WHERE id=?').run(id);
    db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (?,?,?,?,?)")
      .run(req.adminUser?.id || null, 'queue_remove',
           `voucher_id=${entry.voucher_id} mac=${entry.mac_address}`,
           req.ip, Math.floor(Date.now()/1000));
  }
  res.redirect('/admin/queue');
});

module.exports = router;
