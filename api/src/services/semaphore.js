'use strict';
const https       = require('https');
const querystring = require('querystring');
let smsLimiter = null;
try { smsLimiter = require('./smsLimiter'); } catch (e) { smsLimiter = null; }

/**
 * Send an SMS via Semaphore (PH). Rate-limited + logged via smsLimiter.
 * @param {object} [meta] { kind?:string, gate?:boolean }  gate=false bypasses the limiter
 * @returns {Promise<{ok:boolean, message_id?:string, error?:string, reason?:string, retry_after?:number}>}
 */
function sendSms(apiKey, senderName, phone, message, meta) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve({ ok: false, error: 'Semaphore API key not configured.' });

    // Normalize: accept 09XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX, or 9XXXXXXXXX
    let num = String(phone).replace(/\D/g, '');
    if (num.length === 12 && num.startsWith('63')) num = '0' + num.slice(2);
    else if (num.length === 10 && num.startsWith('9')) num = '0' + num;
    if (!/^09\d{9}$/.test(num)) return resolve({ ok: false, error: 'Invalid PH phone number.' });

    const kind = (meta && meta.kind) || 'generic';

    // ── Rate-limit gate ───────────────────────────────────────────────────────
    if (smsLimiter && !(meta && meta.gate === false)) {
      const chk = smsLimiter.smsAllowed(num, kind);
      if (!chk.ok) {
        smsLimiter.smsRecord(num, kind, false, null, 'rate_limited:' + chk.reason);
        return resolve({ ok: false, error: 'rate_limited', reason: chk.reason, retry_after: chk.retry_after });
      }
    }
    const rec = (ok, mid, err) => { if (smsLimiter) smsLimiter.smsRecord(num, kind, ok, mid, err); };

    const params = { apikey: apiKey, number: num, message: message };
    if (senderName && senderName.trim()) params.sendername = senderName.trim();
    const body = querystring.stringify(params);

    const options = {
      hostname: 'api.semaphore.co', path: '/api/v4/messages', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const first  = Array.isArray(parsed) ? parsed[0] : parsed;
          if (first && first.message_id) {
            rec(true, String(first.message_id), null);
            return resolve({ ok: true, message_id: String(first.message_id) });
          }
          if (first && typeof first === 'object') {
            const errMsg = Object.values(first).find(v => typeof v === 'string');
            if (errMsg) { rec(false, null, errMsg); return resolve({ ok: false, error: errMsg }); }
          }
          rec(false, null, 'unexpected_response');
          resolve({ ok: false, error: 'Unexpected Semaphore response: ' + data.slice(0, 120) });
        } catch (e) {
          rec(false, null, 'invalid_response');
          resolve({ ok: false, error: 'Invalid Semaphore response: ' + data.slice(0, 100) });
        }
      });
    });

    req.on('error', (e) => { rec(false, null, e.message); resolve({ ok: false, error: e.message }); });
    req.setTimeout(10000, () => { req.destroy(); rec(false, null, 'timeout'); resolve({ ok: false, error: 'Semaphore request timed out.' }); });
    req.write(body);
    req.end();
  });
}

module.exports = { sendSms };
