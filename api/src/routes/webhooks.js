'use strict';
/**
 * Webhook receiver — POST /webhooks/:slug
 * All incoming payloads are stored in payment_events regardless of token result.
 */
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const moduleRegistry = require('../modules');
const voucherSvc     = require('../services/voucher');
const rl             = require('../services/rateLimiter');
const fees           = require('../services/fees');
const sessionSvc     = require('../services/session');
const nurturing      = require('../services/nurturing');

// P8-1: webhook idempotency ledger
db.prepare(`CREATE TABLE IF NOT EXISTS webhook_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  slug TEXT,
  received_at INTEGER NOT NULL
)`).run();

router.use(express.json({ limit: '256kb' }));

function logEvent(ppId, type, source, name, statusBefore, statusAfter, payload, ip, now) {
  try {
    db.prepare(`INSERT INTO payment_events
      (pending_payment_id,event_type,event_source,event_name,status_before,status_after,payload,ip_address,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ppId || null, type, source, name, statusBefore, statusAfter,
           typeof payload === 'string' ? payload : JSON.stringify(payload), ip || null, now);
  } catch (e) { console.warn('[payment_event log]', e.message); }
}

// ── Semaphore SMS delivery reports ──────────────────────────────────────────
// Semaphore does not sign delivery webhooks; validate payload structure
// and verify the API key matches to reject unauthorized callers.
router.post('/semaphore', (req, res) => {
  const now     = Math.floor(Date.now() / 1000);

  // Structural validation: must have at least one report with message_id
  const body = req.body;
  const reports = Array.isArray(body) ? body : (body && typeof body === 'object' ? [body] : []);
  if (!reports.length || !reports[0].message_id) {
    console.warn('[semaphore webhook] malformed payload rejected');
    return res.status(400).json({ ok: false, error: 'Invalid payload.' });
  }

  // Optional: verify apikey query param matches stored key
  const storedKey = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get() || {}).value || '';
  const incomingKey = req.query.apikey || req.headers['x-api-key'] || '';
  if (storedKey && incomingKey && incomingKey !== storedKey) {
    console.warn('[semaphore webhook] apikey mismatch — rejected');
    db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)")
      .run('semaphore_webhook_auth_fail', `ip=${req.ip}`, req.ip || null, now);
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  for (const report of reports) {
    const msgId  = report.message_id ? String(report.message_id) : null;
    const status = String(report.status || '').toLowerCase();
    if (!msgId) continue;
    const dbStatus = status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'pending';
    db.prepare("UPDATE free_trial_claims SET sms_status=? WHERE sms_message_id=?").run(dbStatus, msgId);
    // SMS-LIVE-STATUS-2026-06-01 — also reflect status onto sms_send_log so
    // voucher SMSs (operator + digital payment paths) can show live status.
    try { db.prepare("UPDATE sms_send_log SET delivery_status=? WHERE message_id=?").run(dbStatus, msgId); }
    catch (e) { /* delivery_status column missing? swallow */ }
    console.log(`[semaphore webhook] message_id=${msgId} status=${dbStatus}`);
  }
  res.json({ ok: true });
});

router.post('/:slug', (req, res) => {
  const { slug } = req.params;
  const now = Math.floor(Date.now() / 1000);

  const mod = moduleRegistry.getModule(slug);
  if (!mod) {
    console.warn(`[webhook] unknown slug: ${slug}`);
    return res.status(404).json({ ok: false, error: 'Unknown module.' });
  }

  // ── Token verification ───────────────────────────────────────────────────
  const token = req.headers['x-callback-token'] || req.headers['x-webhook-token'] || '';
  console.log(`[webhook/${slug}] incoming token prefix: ${token.slice(0,12) || '(empty)'}`);

  if (mod.adapter && mod.adapter.verifyWebhook) {
    if (!mod.adapter.verifyWebhook(mod.config, token)) {
      console.warn(`[webhook] bad token for ${slug} (incoming=${token.slice(0,12)}, stored=${(mod.config.webhook_token||'').slice(0,12)})`);
      db.prepare(`INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)`)
        .run('webhook_auth_fail', `slug=${slug}`, req.ip||null, now);
      // Log the rejected webhook so it's visible in transaction history
      const body2 = req.body || {};
      const extId2 = body2.external_id || body2.reference_id
                  || (body2.data && (body2.data.external_id || body2.data.reference_id)) || null;
      const pending2 = extId2 ? db.prepare("SELECT id FROM pending_payments WHERE external_id=?").get(extId2) : null;
      logEvent(pending2?.id || null, 'webhook_rejected', slug, 'auth_failed',
        null, null, JSON.stringify(body2).slice(0, 2048), req.ip, now);
      return res.status(401).json({ ok: false, error: 'Invalid token.' });
    }
  }

  const body    = req.body || {};
  const summary = JSON.stringify(body).slice(0, 500);
  db.prepare(`INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)`)
    .run(`webhook_${slug}`, summary, req.ip||null, now);

  console.log(`[webhook/${slug}]`, JSON.stringify(body).slice(0, 200));

  // ── Xendit event processing ──────────────────────────────────────────────
  if (slug === 'xendit' || slug === 'gcash_native') {
    const eventType = body.event || '';
    const status    = body.status || (body.data && body.data.status) || '';
    const extId     = body.external_id || body.reference_id
                   || (body.data && (body.data.external_id || body.data.reference_id)) || '';

    const isPaid = eventType === 'payment.succeeded'
                || eventType === 'qr.succeeded'
                || eventType === 'ewallet.capture'
                || status === 'SUCCEEDED'
                || status === 'PAID'
                || status === 'COMPLETED';

    // REMIT-WEBHOOK-2026-06-03 — partner remittance branch
    // Recognize via external_id prefix REMIT- or query param kind=remit
    const isRemit = (extId && extId.startsWith('REMIT-')) || req.query.kind === 'remit';
    if (isRemit) {
      const remitId = parseInt(req.query.remit_id || 0, 10) ||
                      (db.prepare("SELECT id FROM remittances WHERE xendit_reference=?").get(extId) || {}).id;
      if (remitId) {
        const remit = db.prepare("SELECT * FROM remittances WHERE id=?").get(remitId);
        if (remit && remit.status !== 'approved') {
          if (isPaid) {
            db.prepare(
              "UPDATE remittances SET status='approved', confirmed_at=?, xendit_status='SUCCEEDED', webhook_payload=?, approved_at=? WHERE id=?"
            ).run(now, JSON.stringify(body).slice(0, 4096), now, remitId);
            db.prepare("INSERT INTO audit_log (admin_id, partner_id, action, details, created_at) VALUES (NULL, ?, 'remittance_auto_confirm', ?, ?)")
              .run(remit.partner_id, 'remit_id=' + remitId + ' amount=' + remit.amount + ' xendit_id=' + (body.id || ''), now);
            // Send confirmation SMS
            try {
              const partner = db.prepare("SELECT mobile, partner_name FROM partners WHERE id=?").get(remit.partner_id);
              if (partner && partner.mobile) {
                const sem = require('../services/semaphore');
                const k  = (db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get() || {}).value || '';
                const sn = (db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get() || {}).value || 'PAYWIFI';
                if (k) {
                  const msg = 'PAYWIFI: Remittance of P' + remit.amount + ' received. Your balance has been updated. Thank you!';
                  sem.sendSms(k, sn, partner.mobile, msg, { kind: 'remit_confirmed' }).catch(() => {});
                }
              }
            } catch (e) {}
          } else {
            db.prepare("UPDATE remittances SET xendit_status=?, webhook_payload=? WHERE id=?")
              .run(status || eventType || 'updated', JSON.stringify(body).slice(0, 4096), remitId);
          }
        }
      }
      return res.json({ ok: true, kind: 'remit', remit_id: remitId, paid: isPaid });
    }

    // Find the matching pending payment
    const pending = extId
      ? db.prepare("SELECT * FROM pending_payments WHERE external_id=?").get(extId)
      : null;

    // WEBHOOK-DEDUP-HARDEN-V2: when the gateway supplies a unique webhook
    // delivery id (body.id), use ONLY that as the dedup key so replays with
    // mutated event_type / status / data.status still dedup. Falls back to
    // slug|event|extId when no id is present (legacy or non-Xendit modules).
    if (eventType || extId || body.id) {
      const _evId = body.id || (body.data && body.data.id) || '';
      const _dk = _evId
        ? (slug + '|id|' + _evId)
        : (slug + '|' + (eventType || '') + '|' + (extId || ''));
      try { db.prepare('INSERT INTO webhook_dedup (dedup_key, slug, received_at) VALUES (?,?,?)').run(_dk, slug, now); }
      catch (e) { logEvent(pending?.id || null, 'webhook_duplicate', slug, 'duplicate_ignored', null, null, JSON.stringify(body).slice(0, 256), req.ip, now); return res.json({ ok: true, duplicate: true }); }
    }

    // Always store the raw webhook payload
    logEvent(
      pending?.id || null, 'webhook', slug,
      eventType || 'webhook_received',
      pending?.status || null, isPaid ? 'paid' : (pending?.status || null),
      JSON.stringify(body).slice(0, 4096), req.ip, now
    );

    // Update pending_payments.updated_at whenever we receive a webhook for it
    if (pending) {
      db.prepare('UPDATE pending_payments SET updated_at=? WHERE id=?').run(now, pending.id);
    }

    // P8-2: refund handling — record refund; revoke voucher if not yet used (don't cut active sessions)
    const isRefund = /refund/i.test(eventType) || status === 'REFUNDED' || (body.data && /refund/i.test(String(body.data.status||'')));
    if (isRefund && pending) {
      const ramt = (body.data && body.data.amount) || body.amount || pending.amount || null;
      const rid  = (body.data && body.data.id) || body.id || null;
      db.prepare("UPDATE pending_payments SET refunded_at=?, refund_amount=?, refund_id=?, status='refunded', updated_at=? WHERE id=?").run(now, ramt, rid ? String(rid) : null, now, pending.id);
      if (pending.voucher_id) {
        const v = db.prepare('SELECT status FROM vouchers WHERE id=?').get(pending.voucher_id);
        if (v && ['unused','queued'].includes(v.status)) {
          db.prepare("UPDATE vouchers SET status='revoked', lifecycle_state='cancelled' WHERE id=?").run(pending.voucher_id);
          db.prepare("DELETE FROM voucher_queue WHERE voucher_id=? AND status='waiting'").run(pending.voucher_id);
        }
      }
      logEvent(pending.id, 'refund', slug, 'payment_refunded', pending.status, 'refunded', { refund_id: rid, amount: ramt }, req.ip, now);
      db.prepare("INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)").run('payment_refunded', `ext=${extId} refund=${rid} amt=${ramt}`, req.ip||null, now);
    }

    if (isPaid && extId) {
      // CB-02: atomic transaction — prevent double-voucher with concurrent poll
      if (pending && pending.status === 'pending') {
        const plan = db.prepare('SELECT * FROM voucher_plans WHERE id=?').get(pending.plan_id);
        if (plan) {
          const codeLen = parseInt(
            (db.prepare("SELECT value FROM settings WHERE key='voucher_code_length'").get() || {}).value || '8', 10
          );
          const issueTx = db.transaction(() => {
            const claim = db.prepare(
              'UPDATE pending_payments SET status=?,updated_at=? WHERE id=? AND status=?'
            ).run('processing', now, pending.id, 'pending');
            if (claim.changes === 0) return null; // poll already claimed it
            let code, voucherRow;
            for (let attempt = 0; attempt < 5; attempt++) {
              code = voucherSvc.generateCode(codeLen);
              try {
                voucherRow = db.prepare(`
                  INSERT INTO vouchers (code,duration_minutes,bandwidth_kbps,max_devices,status,lifecycle_state,created_at)
                  VALUES (?,?,?,?,'unused','generated',?)
                `).run(code, plan.duration_minutes, plan.bandwidth_kbps, plan.max_devices||1, now);
                break;
              } catch (e) { if (attempt === 4) throw e; }
            }
            db.prepare('UPDATE pending_payments SET status=?,voucher_id=?,paid_at=?,updated_at=? WHERE id=?')
              .run('paid', voucherRow.lastInsertRowid, now, now, pending.id);
            return code;
          });
          const code = issueTx();
          if (code) {
            try { const _st=fees.parseSettlement(body); if(_st.fee!=null||_st.settlement!=null){ db.prepare('UPDATE pending_payments SET fee_amount=COALESCE(?,fee_amount), settlement_amount=COALESCE(?,settlement_amount), updated_at=? WHERE id=?').run(_st.fee,_st.settlement,now,pending.id); } } catch(e){}
            try { db.prepare("UPDATE lead_funnel SET converted_at=? WHERE mac_address=? AND converted_at IS NULL").run(now, pending.client_mac || ''); } catch (e) {}
            try { const _vid=(db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(pending.id)||{}).voucher_id; if(_vid) sessionSvc.enqueueVoucherIfActive(pending.client_mac, _vid, now); } catch(e){}
            try { if (pending.buyer_phone) { const _sem=require('../services/semaphore'); const _k=(db.prepare("SELECT value FROM settings WHERE key='semaphore_api_key'").get()||{}).value||''; const _sn=(db.prepare("SELECT value FROM settings WHERE key='semaphore_sender_name'").get()||{}).value||'PAYWIFI'; _sem.sendSms(_k,_sn,pending.buyer_phone,'Your PAYWIFI voucher code: '+code+'. Enjoy your WiFi!').catch(()=>{}); } } catch(e){}
            try { if (pending.buyer_phone) { const _pv=(db.prepare('SELECT voucher_id FROM pending_payments WHERE id=?').get(pending.id)||{}).voucher_id; nurturing.ensureTrustedAccount(pending.buyer_phone, pending.client_mac, req.ip, 'paid_purchase', 'pp#' + pending.id, _pv); } } catch (e) {}
            logEvent(pending.id, 'voucher_issued', 'system', 'voucher_generated',
              'paid', 'paid', { voucher_code: code, issued_via: 'webhook', event_type: eventType },
              req.ip, now);
            db.prepare(`INSERT INTO audit_log (admin_id,action,details,ip_address,created_at) VALUES (NULL,?,?,?,?)`)
              .run('payment_completed', `ext=${extId} voucher=${code} ip=${pending.client_ip}`, req.ip||null, now);
            rl.rlClear(rl.rlKey(pending.client_mac, pending.client_ip), 'payment');
            console.log(`[webhook/${slug}] ${extId} → voucher ${code} for ${pending.client_ip}`);
          } else {
            console.log(`[webhook/${slug}] ${extId} duplicate webhook ignored (already processing)`);
          }
        }
      }
    }
  }

  res.json({ ok: true });
});

module.exports = router;
