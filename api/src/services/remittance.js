'use strict';
// PAYWIFI-REMITTANCE-2026-06-02 — shared logic used by operator + admin routes.
const db = require('../db');

// Outstanding balance owed by an operator =
//   (gross paid Cash revenue for the store) × (1 − commission_pct / 100)
//   − sum of approved remittances
function computeOwed(partnerId) {
  const op = db.prepare("SELECT commission_pct FROM partners WHERE id=?").get(partnerId);
  if (!op) return { gross: 0, commission: 0, owed_before_remit: 0, remitted: 0, outstanding: 0, commission_pct: 0 };
  const pct = op.commission_pct || 0;

  const r = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS gross, COUNT(*) AS paid_count " +
    "  FROM pending_payments " +
    " WHERE status='paid' AND channel_name='Cash' AND partner_id=?"
  ).get(partnerId);

  const commission        = (r.gross || 0) * pct / 100;
  const owed_before_remit = (r.gross || 0) * remitPct / 100;

  const remitted = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM remittances WHERE partner_id=? AND status='approved'"
  ).get(partnerId).s;

  return {
    gross:             Number(r.gross || 0),
    paid_count:        r.paid_count,
    commission_pct:    pct,
    remit_pct:         remitPct,
    commission:        Number(commission.toFixed(2)),
    owed_before_remit: Number(owed_before_remit.toFixed(2)),
    remitted:          Number(remitted || 0),
    outstanding:       Number((owed_before_remit - remitted).toFixed(2)),
  };
}

module.exports = { computeOwed };
