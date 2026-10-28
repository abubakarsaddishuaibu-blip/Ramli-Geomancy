import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Initialize a Paystack transaction. The Paystack SECRET key is only ever used
 * here on the server; the browser receives nothing but the authorization URL.
 */
export async function initializeTransaction({ email, amount, reference, callbackUrl, metadata }) {
  const res = await fetch(`${config.paystackBaseUrl}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.paystackSecretKey}`
    },
    body: JSON.stringify({
      email,
      amount,
      currency: config.registrationFeeCurrency,
      reference,
      callback_url: callbackUrl,
      metadata: metadata || {}
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) {
    const err = new Error(json.message || 'Paystack initialization failed');
    err.status = 502;
    throw err;
  }
  return json.data; // { authorization_url, reference, access_code, ... }
}

/** Server-side verification of a Paystack transaction reference. */
export async function verifyTransaction(reference) {
  const res = await fetch(`${config.paystackBaseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.paystackSecretKey}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || 'Paystack verification failed');
    err.status = 502;
    throw err;
  }
  return json;
}

/** HMAC-SHA512 signature used by Paystack webhooks. */
export function webhookSignature(rawBody) {
  return crypto.createHmac('sha512', config.paystackSecretKey).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = webhookSignature(rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Decides whether a verified Paystack transaction is an acceptable,
 * fully-paid registration payment for the expected fee.
 */
export function isSuccessfulPayment(transaction) {
  if (!transaction || transaction.status !== true) return false;
  const data = transaction.data || {};
  if (data.status !== 'success') return false;
  if (Number(data.amount) !== Number(config.registrationFeeKobo)) return false;
  if (String(data.currency || '').toUpperCase() !== config.registrationFeeCurrency.toUpperCase()) return false;
  return true;
}
