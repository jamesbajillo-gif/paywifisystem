'use strict';
const db = require('../db');
const crypto = require('crypto');

const VOUCHER_CHARSET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789'; // MULTI-FIX-2026-06-01 — also exclude S, 5 (no 0/O/I/1/S/5)

function generateCode(length = 8) {
  let s = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    s += VOUCHER_CHARSET[bytes[i] % VOUCHER_CHARSET.length];
  }
  return s;
}

function findByCode(code) {
  return db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
}

function activateVoucher(voucher, nowSec) {
  if (voucher.status !== 'unused' && voucher.status !== 'active') {
    return { ok: false, error: `Voucher is ${voucher.status}.` };
  }

  // First use: lock in expiry
  let expiresAt = voucher.expires_at;
  if (voucher.status === 'unused') {
    expiresAt = nowSec + voucher.duration_minutes * 60;
    db.prepare(`
      UPDATE vouchers
         SET status='active', first_used_at=?, expires_at=?
       WHERE id=?
    `).run(nowSec, expiresAt, voucher.id);
  } else if (expiresAt && expiresAt < nowSec) {
    db.prepare("UPDATE vouchers SET status='expired' WHERE id=?").run(voucher.id);
    return { ok: false, error: 'Voucher expired.' };
  }

  // Check device cap
  const activeDevices = db.prepare(`
    SELECT COUNT(*) AS n FROM sessions
     WHERE voucher_id=? AND ended_at IS NULL
  `).get(voucher.id).n;

  if (activeDevices >= voucher.max_devices) {
    return { ok: false, error: `Device limit reached (${voucher.max_devices}).` };
  }

  return { ok: true, expiresAt };
}

module.exports = { generateCode, findByCode, activateVoucher };
