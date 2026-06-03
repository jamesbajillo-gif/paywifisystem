'use strict';
// PAYWIFI-PARTNER-COMPLIANCE-2026-06-03 — weekly remittance compliance engine.
//
// Business rules (DB-tunable via settings):
//   - Partners earn `partner_commission_pct_fixed` (default 30%)
//   - Partners must remit `partner_remit_pct_fixed` (default 70%)
//   - Cycle: weekly (Monday-Sunday Asia/Manila)
//   - Deadline: <dow> <hour>:00 Asia/Manila AFTER the week ends.
//     Default dow=1 (Mon) hour=23 → partners have until end of the Monday
//     after the week closes to remit ≥ 70% of that week's gross.
//   - When a week becomes delinquent and `partner_restriction_enabled='1'`,
//     the partner's status flips to 'restricted'. They can no longer accept
//     new cash payments. Existing pending payments still drain through.
//   - When the delinquent week's remittance is fully cleared (or admin grants
//     an override), the partner is automatically unrestricted.
const db = require('../db');

const MS_PER_SEC = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── settings access ─────────────────────────────────────────────────────────
function setting(key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function commissionPct()  { return parseFloat(setting('partner_commission_pct_fixed', '30')) || 30; }
function remitPct()       { return parseFloat(setting('partner_remit_pct_fixed',      '70')) || 70; }
function restrictEnabled(){ return setting('partner_restriction_enabled', '1') === '1'; }

// ── week boundaries (Asia/Manila = UTC+8, no DST) ──────────────────────────
// Returns { weekStart, weekEnd } unix seconds for the Mon-Sun week containing
// the given unix timestamp. PHT offset is hard-coded +8h (Philippines never
// observes DST).
function weekBoundsForUnix(ts) {
  const PHT_OFFSET_SEC = 8 * 3600;
  // shift to local
  const local = (ts + PHT_OFFSET_SEC) * MS_PER_SEC;
  const d = new Date(local);
  // JS getUTCDay() on a shifted timestamp gives us local weekday
  // 0=Sun, 1=Mon, … 6=Sat. We want Mon as start, so:
  const dow = d.getUTCDay();              // 0..6, Sun=0
  const daysSinceMon = (dow + 6) % 7;     // Mon=0, Tue=1, … Sun=6
  // Local midnight Monday
  const localMidnightMon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
                            - daysSinceMon * MS_PER_DAY;
  const weekStartUtc = Math.floor(localMidnightMon / MS_PER_SEC) - PHT_OFFSET_SEC;
  const weekEndUtc   = weekStartUtc + 7 * 86400 - 1;
  return { weekStart: weekStartUtc, weekEnd: weekEndUtc };
}

function previousWeekBounds() {
  const now = Math.floor(Date.now() / MS_PER_SEC);
  const thisWeek = weekBoundsForUnix(now);
  const prevTs = thisWeek.weekStart - 86400;  // any moment in the prev week
  return weekBoundsForUnix(prevTs);
}

function deadlineForWeek(weekEnd) {
  // weekEnd is Sunday 23:59:59 PHT. Deadline is Monday `hour` PHT after that.
  const dow  = parseInt(setting('partner_remit_deadline_dow',  '1'), 10);  // 1=Mon after week
  const hour = parseInt(setting('partner_remit_deadline_hour', '23'), 10);
  // deadline = (Monday after week) + hour hours
  // weekEnd is Sun 23:59:59 → +1s = Mon 00:00:00. Add (dow-1)*86400 + hour*3600 - 1
  const mondayMidnight = weekEnd + 1;
  return mondayMidnight + (dow - 1) * 86400 + hour * 3600 - 1;
}

// ── per-partner ledger ─────────────────────────────────────────────────────
function computeWeeklyForPartner(partnerId, weekBounds) {
  const { weekStart, weekEnd } = weekBounds;
  const gross = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s " +
    "FROM pending_payments " +
    "WHERE status='paid' AND partner_id=? AND paid_at >= ? AND paid_at <= ?"
  ).get(partnerId, weekStart, weekEnd).s;
  // Remitted "for this week" = approved remittances submitted between weekStart
  // and the partner's deadline (we use submission date, not the week the cash
  // came from — operationally simpler and matches the user's spec example).
  const remitted = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s " +
    "FROM remittances " +
    "WHERE partner_id=? AND status='approved' AND created_at >= ? AND created_at <= ?"
  ).get(partnerId, weekStart, deadlineForWeek(weekEnd)).s;
  const required = Math.round((gross * remitPct() / 100) * 100) / 100;
  return { gross, remitted, required };
}

function upsertWeeklyRow(partnerId, weekBounds, computed, status) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO partner_weekly_compliance (partner_id, week_start, week_end, gross_sales, required_remit, remitted, status, delinquent_since, evaluated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(partner_id, week_start) DO UPDATE SET " +
    "  gross_sales=excluded.gross_sales, required_remit=excluded.required_remit, " +
    "  remitted=excluded.remitted, status=excluded.status, " +
    "  delinquent_since=COALESCE(partner_weekly_compliance.delinquent_since, excluded.delinquent_since), " +
    "  evaluated_at=excluded.evaluated_at"
  ).run(partnerId, weekBounds.weekStart, weekBounds.weekEnd,
        computed.gross, computed.required, computed.remitted, status,
        status === 'delinquent' ? now : null, now);
}

// ── core: evaluate the previous week for every active partner ──────────────
function evaluatePreviousWeek() {
  if (!restrictEnabled()) return { evaluated: 0, restricted: 0, unrestricted: 0 };
  const prev = previousWeekBounds();
  const deadline = deadlineForWeek(prev.weekEnd);
  const now = Math.floor(Date.now() / 1000);
  const partners = db.prepare(
    "SELECT id, mobile, status, restriction_override_until FROM partners WHERE status IN ('active', 'restricted')"
  ).all();

  let restricted = 0, unrestricted = 0, evaluated = 0;
  for (const p of partners) {
    evaluated++;
    const c = computeWeeklyForPartner(p.id, prev);
    const isPastDeadline = now > deadline;
    let weeklyStatus;
    if (c.gross <= 0)                 weeklyStatus = 'compliant';        // nothing to remit
    else if (c.remitted >= c.required - 0.01) weeklyStatus = 'compliant';
    else if (isPastDeadline)          weeklyStatus = 'delinquent';
    else                              weeklyStatus = 'open';
    upsertWeeklyRow(p.id, prev, c, weeklyStatus);

    const hasActiveOverride = p.restriction_override_until && p.restriction_override_until > now;

    if (weeklyStatus === 'delinquent' && p.status !== 'restricted' && !hasActiveOverride) {
      // Restrict
      db.prepare("UPDATE partners SET status='restricted', restricted_at=?, restricted_reason=?, updated_at=? WHERE id=?")
        .run(now, 'Week of ' + new Date(prev.weekStart * 1000).toISOString().slice(0,10) +
                  ' — outstanding remittance ₱' + (c.required - c.remitted).toFixed(2), now, p.id);
      db.prepare(
        "INSERT INTO partner_restriction_log (partner_id, action, reason, by_system, week_start, created_at) " +
        "VALUES (?, 'restricted', ?, 1, ?, ?)"
      ).run(p.id, 'auto: weekly compliance missed', prev.weekStart, now);
      db.prepare("UPDATE partner_weekly_compliance SET enforced_at=? WHERE partner_id=? AND week_start=?")
        .run(now, p.id, prev.weekStart);
      restricted++;
      try {
        const sem = require('./semaphore');
        const k  = setting('semaphore_api_key', '');
        const sn = setting('semaphore_sender_name', 'PAYWIFI');
        const support = setting('partner_contact_number', '');
        if (k && p.mobile) {
          const msg = 'PAYWIFI: Account RESTRICTED. Last week outstanding ₱' + (c.required - c.remitted).toFixed(2) +
                     '. Remit now to restore access.' + (support ? ' Help: ' + support : '');
          sem.sendSms(k, sn, p.mobile, msg, { kind: 'partner_restricted' }).catch(() => {});
        }
      } catch (e) {}
    } else if (weeklyStatus === 'compliant' && p.status === 'restricted' && !p.restriction_override_until) {
      // Auto-unrestrict ONLY when the system restricted them (no admin override)
      // and the last restriction reason was the auto delinquency.
      const lastLog = db.prepare(
        "SELECT action FROM partner_restriction_log WHERE partner_id=? ORDER BY id DESC LIMIT 1"
      ).get(p.id);
      if (lastLog && lastLog.action === 'restricted') {
        db.prepare("UPDATE partners SET status='active', restricted_at=NULL, restricted_reason=NULL, updated_at=? WHERE id=?")
          .run(now, p.id);
        db.prepare(
          "INSERT INTO partner_restriction_log (partner_id, action, reason, by_system, week_start, created_at) " +
          "VALUES (?, 'unrestricted', 'auto: compliance restored', 1, ?, ?)"
        ).run(p.id, prev.weekStart, now);
        unrestricted++;
        try {
          const sem = require('./semaphore');
          const k  = setting('semaphore_api_key', '');
          const sn = setting('semaphore_sender_name', 'PAYWIFI');
          if (k && p.mobile) {
            const msg = 'PAYWIFI: Account REINSTATED. You can accept payments again. Thank you.';
            sem.sendSms(k, sn, p.mobile, msg, { kind: 'partner_unrestricted' }).catch(() => {});
          }
        } catch (e) {}
      }
    }
  }
  return { evaluated, restricted, unrestricted };
}

// ── dashboard ⇄ partner-facing read helpers ────────────────────────────────
function snapshotForPartner(partnerId) {
  const prev = previousWeekBounds();
  const now  = Math.floor(Date.now() / 1000);
  const c    = computeWeeklyForPartner(partnerId, prev);
  const deadline = deadlineForWeek(prev.weekEnd);
  const compliant = c.gross <= 0 || c.remitted >= c.required - 0.01;
  const isPastDeadline = now > deadline;
  return {
    weekStart: prev.weekStart, weekEnd: prev.weekEnd, deadline,
    gross_sales: Number(c.gross.toFixed(2)),
    required_remit: Number(c.required.toFixed(2)),
    remitted: Number(c.remitted.toFixed(2)),
    outstanding: Math.max(0, Number((c.required - c.remitted).toFixed(2))),
    compliant,
    delinquent: !compliant && isPastDeadline,
    open: !compliant && !isPastDeadline,
    commission_pct: commissionPct(),
    remit_pct: remitPct(),
  };
}

// Lifetime + current-week numbers for the dashboard cards
function partnerMetrics(partnerId) {
  const lifetimeRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS gross, COUNT(*) AS n FROM pending_payments WHERE status='paid' AND partner_id=?"
  ).get(partnerId);
  const remittedTotalRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM remittances WHERE partner_id=? AND status='approved'"
  ).get(partnerId);
  const pct = commissionPct();
  const remit = remitPct();
  const profit  = Number((lifetimeRow.gross * pct / 100).toFixed(2));
  const owed    = Number((lifetimeRow.gross * remit / 100).toFixed(2));
  const remittedTotal = Number(remittedTotalRow.s.toFixed(2));
  return {
    total_sales: Number(lifetimeRow.gross.toFixed(2)),
    paid_count:  lifetimeRow.n,
    partner_profit: profit,
    commission_pct: pct,
    remit_pct: remit,
    remitted_total: remittedTotal,
    remittance_balance: Math.max(0, Number((owed - remittedTotal).toFixed(2))),
  };
}

module.exports = {
  evaluatePreviousWeek,
  snapshotForPartner,
  partnerMetrics,
  previousWeekBounds,
  deadlineForWeek,
  computeWeeklyForPartner,
  commissionPct,
  remitPct,
  restrictEnabled,
};
