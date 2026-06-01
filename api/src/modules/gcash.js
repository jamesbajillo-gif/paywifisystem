"use strict";
/**
 * GCash Native API adapter (config-driven scaffold).
 *
 * GCash merchant integrations are partner-gated: exact endpoints, auth, and
 * field names depend on YOUR GCash partner agreement (e.g. G-Xchange / GCash
 * Checkout). This adapter is fully config-driven so you can point it at your
 * real endpoint WITHOUT code changes. Config (set in Payment Modules admin):
 *   base_url      e.g. https://api.gcash.<partner>.com   (REQUIRED)
 *   create_path   default /payments/checkout
 *   status_path   default /payments/status
 *   secret_key    API key / bearer token  -> Authorization: Bearer
 *   public_key    client/app id           -> X-Client-Id
 *   merchant_id   your merchant id        -> X-Merchant-Id
 *   webhook_token shared secret echoed in x-callback-token / x-webhook-token
 *
 * Stays inactive until configured + enabled; /payment/create falls back to
 * manual while disabled. Confirmation works via webhook OR status-poll.
 */
const https = require("https");
const { URL } = require("url");

const ACTIONS = {
  gcash: { label: "GCash (Native)", description: "Direct GCash merchant checkout via your GCash partner API" },
};

function _request(cfg, method, path, body){
  return new Promise((resolve) => {
    let base;
    try { base = new URL(cfg.base_url); } catch(e){ return resolve({ status: 400, body: { error: "base_url not configured" } }); }
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (cfg.secret_key)  headers["Authorization"] = "Bearer " + cfg.secret_key;
    if (cfg.public_key)  headers["X-Client-Id"]   = cfg.public_key;
    if (cfg.merchant_id) headers["X-Merchant-Id"] = cfg.merchant_id;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const opts = {
      hostname: base.hostname, port: base.port || 443,
      path: base.pathname.replace(/\/$/, "") + path, method, headers,
    };
    const req = https.request(opts, res => {
      let data=""; res.on("data", ch => data += ch);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch(e){ resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", e => resolve({ status: 0, body: { error: e.message } }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function createPayment(cfg, action, opts){
  if (!cfg.base_url) return { status: 400, body: { error_code: "CHANNEL_NOT_ACTIVATED", error: "GCash native API base_url is not configured." } };
  const path = cfg.create_path || "/payments/checkout";
  const r = await _request(cfg, "POST", path, {
    merchant_id:  cfg.merchant_id || undefined,
    reference_id: opts.external_id,
    amount:       opts.amount,
    currency:     opts.currency || "PHP",
    description:  "PAYWIFI " + opts.external_id,
    redirect_url: opts.callback_url,
    callback_url: opts.callback_url,
    metadata:     opts.metadata || {},
  });
  const b = r.body || {};
  const checkout = b.checkout_url || b.redirectUrl || b.redirect_url
    || (b.data && (b.data.checkoutUrl || b.data.checkout_url || b.data.redirectUrl)) || null;
  const id = b.id || b.payment_id || (b.data && (b.data.id || b.data.payment_id)) || null;
  // normalise into the ewallet shape portal.js already understands
  if (checkout && !Array.isArray(b.actions)) b.actions = [{ url: checkout, url_type: "WEB", action: "AUTH" }];
  if (id && !b.id) b.id = id;
  if (checkout && !b.checkout_url) b.checkout_url = checkout;
  return { status: r.status, body: b };
}

function verifyWebhook(cfg, token){
  if (!cfg.webhook_token) return false;
  return token === cfg.webhook_token;
}

async function testConnection(cfg){
  if (!cfg.base_url)   return { ok:false, message:"base_url is not configured." };
  if (!cfg.secret_key) return { ok:false, message:"API key (secret_key) is not configured." };
  const r = await _request(cfg, "GET", cfg.status_path || "/payments/status");
  if (r.status === 0) return { ok:false, message:"Connection failed: " + ((r.body && r.body.error) || "unreachable") };
  if (r.status >= 200 && r.status < 500) return { ok:true, message:"Endpoint reachable (HTTP " + r.status + "). Confirm credentials with a live test payment." };
  return { ok:false, message:"HTTP " + r.status };
}

async function checkPaymentStatus(cfg, referenceId){
  if (!cfg.base_url) return { paid:false };
  const sp = cfg.status_path || "/payments/status";
  const sep = sp.includes("?") ? "&" : "?";
  const r = await _request(cfg, "GET", sp + sep + "reference_id=" + encodeURIComponent(referenceId));
  const b = r.body || {};
  const s = String(b.status || (b.data && b.data.status) || "").toUpperCase();
  return { paid: ["SUCCEEDED","PAID","COMPLETED","SUCCESS"].includes(s) };
}

module.exports = { ACTIONS, createPayment, verifyWebhook, testConnection, checkPaymentStatus };
