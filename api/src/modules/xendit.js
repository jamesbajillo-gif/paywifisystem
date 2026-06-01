'use strict';
/**
 * Xendit payment adapter
 * Docs: https://developers.xendit.co/
 *
 * Supported actions (used as module_action on payment_options):
 *   qr_code    – QR Ph / InstaPay QR code (DYNAMIC)
 *   gcash      – GCash eWallet charge
 *   grabpay    – GrabPay eWallet charge
 *   paymaya    – PayMaya / Maya eWallet charge
 *   shopeepay  – ShopeePay eWallet charge
 *   credit_card– Credit / Debit Card
 *   va         – Virtual Account (bank transfer)
 *   otc        – Over-the-Counter (7-Eleven / Cebuana)
 */

const https = require('https');

// ── Action definitions (shown in admin UI dropdowns) ─────────────────────────
const ACTIONS = {
  qr_code:     { label: 'QR Ph / InstaPay (QR Code)',  description: 'Dynamic QR — guest scans with any QR Ph-enabled bank or e-wallet app' },
  gcash:       { label: 'GCash',                        description: 'GCash eWallet — redirects guest to GCash app to approve payment' },
  grabpay:     { label: 'GrabPay',                      description: 'GrabPay eWallet — redirects guest to Grab app to approve payment' },
  paymaya:     { label: 'Maya / PayMaya',               description: 'Maya eWallet — redirects guest to Maya app to approve payment' },
  shopeepay:   { label: 'ShopeePay',                    description: 'ShopeePay eWallet — redirects guest to Shopee app to approve payment' },
  credit_card: { label: 'Credit / Debit Card',          description: 'Visa, Mastercard, JCB — guest enters card details via Xendit-hosted page' },
  va:          { label: 'Virtual Account (Bank Transfer)', description: 'Guest transfers to a dedicated virtual account number (BDO, BPI, UnionBank, etc.)' },
  otc:         { label: 'Over-the-Counter (7-Eleven / Cebuana)', description: 'Guest pays cash at a convenience store or remittance center using a payment code' },
};

// ── Internal HTTP helper ─────────────────────────────────────────────────────
function apiRequest(cfg, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const host = 'api.xendit.co';
    const auth = Buffer.from((cfg.secret_key || '') + ':').toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: host,
      path,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(extraHeaders || {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── createPayment ─────────────────────────────────────────────────────────────
/**
 * Create a payment request.
 * @param {object} cfg      – module config (secret_key, public_key, environment, …)
 * @param {string} action   – one of the ACTIONS keys
 * @param {object} opts     – { external_id, amount, currency, callback_url, name, metadata }
 * @returns {Promise<{status,body}>}
 */
async function createPayment(cfg, action, opts) {
  const { external_id, amount, callback_url, name } = opts;
  switch (action) {
    case 'qr_code': {
      // Use v2 /payment_requests — legacy /qr_codes endpoint may not be activated
      // even when QR Ph is active in the Xendit dashboard.
      // Pass webhook-url header so Xendit delivers to our endpoint for this payment.
      const qrWebhookHdr = callback_url ? { 'webhook-url': callback_url } : {};
      return apiRequest(cfg, 'POST', '/payment_requests', {
        reference_id: external_id,
        currency:     opts.currency || 'PHP',
        amount,
        payment_method: {
          type:        'QR_CODE',
          reusability: 'ONE_TIME_USE',
          qr_code: {
            channel_code:       'QRPH',
            channel_properties: {},
          },
        },
        metadata: opts.metadata || {},
      }, qrWebhookHdr);
    }
    case 'gcash':
    case 'grabpay':
    case 'shopeepay':
    case 'paymaya': {
      const channelMap = { gcash: 'GCASH', grabpay: 'GRABPAY', shopeepay: 'SHOPEEPAY', paymaya: 'PAYMAYA' };
      const channel = channelMap[action];
      // M1-RETURN-URL-2026-05-30: return_url is the BROWSER redirect target
      // after the user completes/cancels payment. It must NOT be the same as
      // callback_url (which is the server-to-server webhook). Fall back to
      // callback_url only for back-compat with old callers.
      // CX-POLISH-2026-05-31 — accept distinct success/failure/cancel URLs.
      const browserReturn = opts.return_url || callback_url;
      const successUrl = opts.success_return_url || browserReturn;
      const failureUrl = opts.failure_return_url || browserReturn;
      const cancelUrl  = opts.cancel_return_url  || browserReturn;
      return apiRequest(cfg, 'POST', '/payment_requests', {
        reference_id: external_id,
        currency: opts.currency || 'PHP',
        amount,
        country: 'PH',
        payment_method: {
          type: 'EWALLET',
          ewallet: {
            channel_code: channel,
            channel_properties: {
              success_return_url: successUrl,
              failure_return_url: failureUrl,
              cancel_return_url:  cancelUrl,
            },
          },
          reusability: 'ONE_TIME_USE',
        },
        description: `PAYWIFI payment ${external_id}`,
        metadata: opts.metadata || {},
      });
    }
    case 'va': {
      return apiRequest(cfg, 'POST', '/callback_virtual_accounts', {
        external_id,
        bank_code: opts.bank_code || 'BDO',
        name: name || 'PAYWIFI',
        expected_amount: amount,
      });
    }
    case 'credit_card': {
      return { status: 501, body: { error: 'Credit card requires frontend integration. Use Xendit.js.' } };
    }
    case 'otc': {
      return apiRequest(cfg, 'POST', '/payment_codes', {
        external_id,
        retail_outlet_name: opts.retail_outlet || 'ALFAMART',
        name: name || 'PAYWIFI',
        expected_amount: amount,
      });
    }
    default:
      throw new Error(`Unknown Xendit action: ${action}`);
  }
}

// ── Webhook verification ──────────────────────────────────────────────────────
/**
 * Verify Xendit sends the x-callback-token header matching our stored token.
 */
function verifyWebhook(cfg, token) {
  if (!cfg.webhook_token) return false;
  return token === cfg.webhook_token;
}

// ── Connection test ───────────────────────────────────────────────────────────
/**
 * Verify credentials by hitting /balance (lightweight read-only call).
 */
async function testConnection(cfg) {
  if (!cfg.secret_key) {
    return { ok: false, message: 'Secret key is not configured.' };
  }
  try {
    const result = await apiRequest(cfg, 'GET', '/balance');
    if (result.status === 200) {
      const env = (cfg.environment || 'sandbox');
      const bal = result.body.balance !== undefined
        ? ` — Balance: PHP ${result.body.balance}`
        : '';
      return { ok: true, message: `Connected (${env})${bal}` };
    }
    const msg = (result.body && result.body.message) || `HTTP ${result.status}`;
    return { ok: false, message: `API error: ${msg}` };
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
}

// ── Channel availability sync ─────────────────────────────────────────────────
/**
 * Probe each Xendit channel using the v2 /payment_requests API.
 *
 * Classification logic (based on live API testing):
 *   201 / 202          → 'active'   (payment request accepted — cancelled immediately)
 *   403 CHANNEL_NOT_ACTIVATED → 'inactive'  (covers both "In Progress" and "Not Activated"
 *                                            — Xendit returns the same error for both states)
 *   400 where message mentions channel unsupported / not implemented → 'not_supported'
 *   400 other field-validation errors → 'active' (channel is recognised, just missing fields)
 *   Everything else    → 'inactive'
 *
 * NOTE: Xendit's API cannot distinguish "In Progress" (pending activation review) from
 * "Not Activated" (never applied). Both return 403 CHANNEL_NOT_ACTIVATED. The UI should
 * reflect this limitation.
 */
async function syncChannels(cfg) {
  if (!cfg.secret_key) {
    return { ok: false, message: 'Secret key is not configured. Save your API credentials first.' };
  }

  const results = {};
  const createdRequests = []; // IDs of payment requests created — cancelled at the end

  // ── Helper: classify a /payment_requests response ─────────────────────────
  function classifyPR(status, body) {
    if (status === 201 || status === 202) return 'active';

    const code = (body && body.error_code) ? String(body.error_code).toUpperCase() : '';
    const msg  = ((body && body.message)   ? String(body.message) : '').toLowerCase();

    if (status === 403) {
      // CHANNEL_NOT_ACTIVATED covers both "In Progress" and "Not Activated" on Xendit
      if (code === 'CHANNEL_NOT_ACTIVATED') return 'inactive';
      // Any other 403 (AUTH_ERROR, etc.) — treat as not_supported for this channel
      return 'not_supported';
    }

    if (status === 400) {
      // Channel not activated — Xendit returns this as 400 from legacy endpoints
      // (e.g. POST /qr_codes returns 400 CHANNEL_NOT_ACTIVATED, not 403)
      if (code === 'CHANNEL_NOT_ACTIVATED') return 'inactive';
      // Channel genuinely not supported / rejected on this account
      if (
        msg.includes('does not support channel') ||
        msg.includes('not implemented') ||
        msg.includes('not supported') ||
        msg.includes('not available') ||
        code === 'FEATURE_NOT_AVAILABLE' ||
        code === 'CHANNEL_NOT_SUPPORTED'
      ) {
        return 'not_supported';
      }
      // Field-level validation error — channel IS recognised, request just lacked required fields
      // (e.g. MISSING_REQUIRED_PARAMETER, API_VALIDATION_ERROR) → treat as active
      return 'active';
    }

    if (status === 401) return 'inactive'; // bad key — surface as inactive rather than crashing

    return 'inactive'; // unknown / network-level error
  }

  // ── Helper: probe a single channel via /payment_requests ──────────────────
  async function probePR(key, paymentMethodPayload) {
    try {
      const r = await apiRequest(cfg, 'POST', '/payment_requests', {
        currency: 'PHP',
        amount: 100,
        payment_method: {
          ...paymentMethodPayload,
          reusability: 'ONE_TIME_USE',
        },
      });
      const status = classifyPR(r.status, r.body);
      // If a payment request was actually created, note it for cancellation
      if ((r.status === 201 || r.status === 202) && r.body && r.body.id) {
        createdRequests.push(r.body.id);
      }
      results[key] = status;
    } catch (e) {
      results[key] = 'inactive';
    }
  }

  // ── eWallet channels ───────────────────────────────────────────────────────
  const ewallets = { gcash: 'GCASH', grabpay: 'GRABPAY', paymaya: 'PAYMAYA', shopeepay: 'SHOPEEPAY' };
  for (const [key, code] of Object.entries(ewallets)) {
    await probePR(key, {
      type: 'EWALLET',
      ewallet: {
        channel_code: code,
        channel_properties: {
          success_return_url: 'https://paywifi.test',
          failure_return_url: 'https://paywifi.test',
          cancel_return_url:  'https://paywifi.test',
        },
      },
    });
  }

  // ── QR Code (QRPH / InstaPay) ──────────────────────────────────────────────
  await probePR('qr_code', {
    type: 'QR_CODE',
    qr_code: {
      channel_code: 'QRPH',
      channel_properties: {},
    },
  });

  // ── Over-the-Counter ────────────────────────────────────────────────────────
  // Probe with Cebuana (activated for most PH accounts) to detect OTC support
  await probePR('otc', {
    type: 'OVER_THE_COUNTER',
    over_the_counter: {
      channel_code: 'CEBUANA',
      channel_properties: {
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  });

  // ── Virtual Account ────────────────────────────────────────────────────────
  // Use the dedicated endpoint — more reliable than probing /payment_requests for VA
  try {
    const r = await apiRequest(cfg, 'GET', '/available_virtual_account_banks');
    if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
      results.va = 'active';
    } else if (r.status === 403 || r.status === 404) {
      results.va = 'not_supported';
    } else {
      results.va = 'inactive';
    }
  } catch (e) {
    results.va = 'inactive';
  }

  // ── Credit Card ─────────────────────────────────────────────────────────────
  // Card tokenisation requires Xendit.js (frontend) — no lightweight server-side probe.
  // Use /balance as a proxy: connected credentials on a verified account have cards enabled.
  // The admin must verify card status in the Xendit dashboard directly.
  try {
    const r = await apiRequest(cfg, 'GET', '/balance');
    results.credit_card = r.status === 200 ? 'active' : 'inactive';
  } catch (e) {
    results.credit_card = 'inactive';
  }

  // ── Cancel any payment requests created during probing ─────────────────────
  for (const id of createdRequests) {
    try {
      await apiRequest(cfg, 'POST', `/payment_requests/${id}/cancel`);
    } catch (_) { /* ignore cancel errors — requests expire on their own */ }
  }

  return { ok: true, channels: results };
}


/**
 * Check if a payment request has been paid, by querying Xendit directly.
 * Used as a fallback when webhooks don't arrive.
 * @param {object} cfg       – module config (secret_key, …)
 * @param {string} referenceId – the external_id / reference_id we sent to Xendit
 * @returns {Promise<{paid: boolean}>}
 */
async function checkPaymentStatus(cfg, referenceId) {
  try {
    const enc = encodeURIComponent(referenceId);
    const result = await apiRequest(cfg, 'GET', `/payment_requests?reference_id=${enc}`);
    if ((result.status || 0) >= 400) return { paid: false };
    const items = (result.body && result.body.data) ? result.body.data : [];
    const item  = items[0];
    if (!item) return { paid: false };
    const s = (item.status || '').toUpperCase();
    return { paid: s === 'SUCCEEDED' || s === 'PAID' || s === 'COMPLETED' };
  } catch (e) {
    return { paid: false };
  }
}

module.exports = { ACTIONS, createPayment, verifyWebhook, testConnection, syncChannels, apiRequest, checkPaymentStatus };
