/**
 * Ramli-Geomancy backend.
 *
 * Responsibilities:
 *  - Supabase Auth registration / login (full name + email + password)
 *  - One-time N15,000 registration fee via Paystack, verified SERVER-SIDE only
 *  - Access to Ramli features is refused until payment is confirmed
 *  - Private per-user Ramli history backed by Supabase + Row Level Security
 *
 * No credit system and no per-question charges exist in this project.
 * Secret keys (Paystack, Supabase service role) are read from env vars only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config, missingConfig, supabaseConfigured, paystackConfigured } from './lib/config.js';
import { createSessionToken, readSessionToken, bearerFrom } from './lib/session.js';
import {
  adminCreateUser, signInWithPassword, refreshSession, getAuthUser,
  restSelect, restInsert, restUpdate, restDelete
} from './lib/supabase.js';
import {
  initializeTransaction, verifyTransaction, isSuccessfulPayment, verifyWebhookSignature
} from './lib/paystack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = {
  '/': 'geomancy_dream_app_gwaji.html',
  '/index.html': 'geomancy_dream_app_gwaji.html',
  '/geomancy_dream_app_gwaji.html': 'geomancy_dream_app_gwaji.html',
  '/geomancy_auth.js': 'geomancy_auth.js'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ----------------------------- helpers ----------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}

/** Very small in-memory rate limiter for sensitive endpoints. */
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.reset) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

// In-flight payment processing guard (prevents duplicate concurrent processing).
const processingPayments = new Set();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

/* --------------------------- session/auth -------------------------- */

function jwtExpiry(token) {
  try {
    const part = String(token).split('.')[1];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

/**
 * Resolve the current session from the Authorization header.
 * Refreshes the Supabase access token when it is about to expire.
 */
async function resolveSession(req) {
  const token = bearerFrom(req);
  const session = readSessionToken(token);
  if (!session) return { error: 'unauthorized', status: 401 };

  let sat = session.sat;
  let srt = session.srt;
  const exp = jwtExpiry(sat);
  if (exp && exp - Math.floor(Date.now() / 1000) < 60 && srt) {
    try {
      const refreshed = await refreshSession(srt);
      sat = refreshed.access_token;
      srt = refreshed.refresh_token;
    } catch {
      return { error: 'session_expired', status: 401 };
    }
  }
  const refreshedToken = createSessionToken({
    uid: session.uid, email: session.email, name: session.name, sat, srt
  });
  return { session: { ...session, sat, srt }, refreshedToken };
}

async function getProfile(uid) {
  const rows = await restSelect('profiles', { id: `eq.${uid}`, limit: '1' }, null, { service: true });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertProfile({ uid, email, fullName }) {
  const existing = await getProfile(uid);
  if (existing) return existing;
  try {
    const rows = await restInsert('profiles', {
      id: uid,
      email,
      full_name: fullName,
      payment_status: 'unpaid',
      registration_fee_kobo: config.registrationFeeKobo
    }, null, { service: true });
    return Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    const again = await getProfile(uid);
    if (again) return again;
    throw err;
  }
}

function userPayload(profile, session) {
  return {
    uid: session.uid,
    email: session.email,
    full_name: profile ? profile.full_name : session.name,
    payment_status: profile ? profile.payment_status : 'unpaid',
    paid_at: profile ? profile.paid_at : null,
    registration_fee_kobo: config.registrationFeeKobo,
    registration_fee_display: `₦${(config.registrationFeeKobo / 100).toLocaleString('en-NG')}`
  };
}

/* --------------------------- payments ------------------------------ */

function newReference(uid) {
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `ramli-${uid.slice(0, 8)}-${rand}`;
}

/**
 * Mark a payment as paid exactly once. Idempotent: safe to call repeatedly and
 * safe to call concurrently for the same reference.
 */
async function markPaymentPaid({ reference, transaction, userId }) {
  if (processingPayments.has(reference)) {
    return { status: 'processing' };
  }
  processingPayments.add(reference);
  try {
    const rows = await restUpdate('payments',
      { reference: `eq.${reference}`, status: `eq.pending` },
      { status: 'paid', paid_at: new Date().toISOString(), transaction },
      null, { service: true, returning: 'representation' });

    const marked = Array.isArray(rows) && rows.length > 0;

    // Only the owner of the payment may be unlocked.
    const paymentRows = await restSelect('payments',
      { reference: `eq.${reference}`, limit: '1' }, null, { service: true });
    const payment = Array.isArray(paymentRows) && paymentRows.length ? paymentRows[0] : null;

    if (payment && (!userId || payment.user_id === userId)) {
      await restUpdate('profiles',
        { id: `eq.${payment.user_id}`, payment_status: `eq.unpaid` },
        { payment_status: 'paid', paid_at: new Date().toISOString() },
        null, { service: true, returning: 'minimal' });
    }
    return { status: marked ? 'paid' : 'already_paid', payment };
  } finally {
    setTimeout(() => processingPayments.delete(reference), 5000);
  }
}

/* ------------------------------ routes ----------------------------- */

async function handleApi(req, res, url) {
  const route = url.pathname;

  // Public: configuration status (no secrets are returned).
  if (route === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      supabase_configured: supabaseConfigured(),
      paystack_configured: paystackConfigured(),
      registration_fee_kobo: config.registrationFeeKobo,
      registration_fee_display: `₦${(config.registrationFeeKobo / 100).toLocaleString('en-NG')}`,
      missing: missingConfig()
    });
  }

  // Public: Paystack webhook (signature verified server-side).
  if (route === '/api/payments/webhook' && req.method === 'POST') {
    const raw = await readBody(req);
    const signature = req.headers['x-paystack-signature'];
    if (!verifyWebhookSignature(raw, signature)) {
      return sendJson(res, 401, { ok: false, error: 'invalid_signature' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: 'invalid_json' }); }
    const data = event.data || {};
    const reference = data.reference;
    if (event.event === 'charge.success' && reference && isSuccessfulPayment({ status: true, data })) {
      await markPaymentPaid({ reference, transaction: data });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { ok: true, ignored: true });
  }

  if (!route.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not_found' });

  if (!supabaseConfigured()) {
    return sendJson(res, 503, {
      ok: false,
      error: 'service_not_configured',
      missing: missingConfig()
    });
  }

  /* ---- registration ---- */
  if (route === '/api/auth/register' && req.method === 'POST') {
    if (!rateLimit(`reg:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (fullName.length < 2) return sendJson(res, 400, { ok: false, error: 'full_name_required', message: 'Shigar da sunaye babba (mafi kyali harbi harbi).' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { ok: false, error: 'invalid_email' });
    if (password.length < 8) return sendJson(res, 400, { ok: false, error: 'weak_password', message: 'Kalmar sirri ya kashe 8 harfi ko sama.' });

    const existing = await restSelect('profiles', { email: `eq.${email}`, limit: '1' }, null, { service: true });
    if (Array.isArray(existing) && existing.length) {
      return sendJson(res, 409, { ok: false, error: 'email_exists', message: 'Wannan imail an riga an yi amfani da ita.' });
    }

    let authUser;
    try {
      authUser = await adminCreateUser({ email, password, fullName });
    } catch (err) {
      const msg = String(err.message || '');
      if (/already|registered|exists/i.test(msg)) {
        return sendJson(res, 409, { ok: false, error: 'email_exists', message: 'Wannan imail an riga an yi amfani da ita.' });
      }
      return sendJson(res, 400, { ok: false, error: 'registration_failed', message: msg });
    }

    const uid = authUser.id || (authUser.user && authUser.user.id);
    await upsertProfile({ uid, email, fullName });

    const session = await signInWithPassword({ email, password });
    const profile = await getProfile(uid);
    const token = createSessionToken({
      uid,
      email,
      name: fullName,
      sat: session.access_token,
      srt: session.refresh_token
    });
    return sendJson(res, 201, { ok: true, token, user: userPayload(profile, { uid, email, name: fullName }) });
  }

  /* ---- login ---- */
  if (route === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(`login:${clientIp(req)}`, 20, 15 * 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return sendJson(res, 400, { ok: false, error: 'credentials_required' });

    let session;
    try {
      session = await signInWithPassword({ email, password });
    } catch {
      return sendJson(res, 401, { ok: false, error: 'invalid_credentials', message: 'Imail ko kalmar sirri ba daidai ba.' });
    }
    const uid = session.user && session.user.id;
    let fullName = (session.user && session.user.user_metadata && session.user.user_metadata.full_name) || '';
    let profile = await getProfile(uid);
    if (!profile) {
      try {
        const authUser = await getAuthUser(session.access_token);
        fullName = (authUser.user_metadata && authUser.user_metadata.full_name) || fullName || email.split('@')[0];
      } catch { /* fall back to email local part */ }
      profile = await upsertProfile({ uid, email, fullName: fullName || email.split('@')[0] });
    }
    const token = createSessionToken({
      uid, email, name: profile.full_name || fullName,
      sat: session.access_token, srt: session.refresh_token
    });
    return sendJson(res, 200, { ok: true, token, user: userPayload(profile, { uid, email, name: fullName }) });
  }

  /* ---- everything below requires a session ---- */
  const auth = await resolveSession(req);
  if (auth.error) return sendJson(res, auth.status, { ok: false, error: auth.error });
  const { session } = auth;
  if (auth.refreshedToken) res.setHeader('X-Session-Token', auth.refreshedToken);

  if (route === '/api/me' && req.method === 'GET') {
    const profile = await getProfile(session.uid);
    return sendJson(res, 200, { ok: true, user: userPayload(profile, session) });
  }

  /* ---- payment initialisation ---- */
  if (route === '/api/payments/initialize' && req.method === 'POST') {
    if (!paystackConfigured()) {
      return sendJson(res, 503, { ok: false, error: 'payment_not_configured', message: 'Maƙarfoɗi ba a saita ba.' });
    }
    const profile = await getProfile(session.uid);
    if (!profile) return sendJson(res, 404, { ok: false, error: 'profile_missing' });
    if (profile.payment_status === 'paid') {
      return sendJson(res, 200, { ok: true, already_paid: true, authorization_url: null, user: userPayload(profile, session) });
    }
    // Re-use an existing pending transaction instead of creating duplicates.
    const pending = await restSelect('payments',
      { user_id: `eq.${session.uid}`, status: `eq.pending`, order: 'created_at.desc', limit: '1' },
      null, { service: true });
    if (Array.isArray(pending) && pending.length && pending[0].authorization_url) {
      return sendJson(res, 200, {
        ok: true, reused: true, reference: pending[0].reference,
        authorization_url: pending[0].authorization_url
      });
    }
    const reference = newReference(session.uid);
    const callbackUrl = `${config.appBaseUrl || ''}/?payment=return`;
    const tx = await initializeTransaction({
      email: profile.email,
      amount: config.registrationFeeKobo,
      reference,
      callbackUrl,
      metadata: { user_id: session.uid, purpose: 'ramli_registration' }
    });
    await restInsert('payments', {
      user_id: session.uid,
      reference,
      amount: config.registrationFeeKobo,
      currency: config.registrationFeeCurrency,
      status: 'pending',
      authorization_url: tx.authorization_url
    }, null, { service: true });
    return sendJson(res, 200, {
      ok: true, reference, authorization_url: tx.authorization_url
    });
  }

  /* ---- payment verification (server-side, idempotent) ---- */
  if (route === '/api/payments/verify' && req.method === 'POST') {
    if (!paystackConfigured()) {
      return sendJson(res, 503, { ok: false, error: 'payment_not_configured' });
    }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    const reference = String(body.reference || '').trim();
    if (!reference) return sendJson(res, 400, { ok: false, error: 'reference_required' });

    const rows = await restSelect('payments', { reference: `eq.${reference}`, limit: '1' }, null, { service: true });
    const payment = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!payment) return sendJson(res, 404, { ok: false, error: 'payment_not_found' });
    if (payment.user_id !== session.uid) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    if (payment.status === 'paid') {
      const profile = await getProfile(session.uid);
      return sendJson(res, 200, { ok: true, status: 'paid', already_paid: true, user: userPayload(profile, session) });
    }

    const transaction = await verifyTransaction(reference);
    if (!isSuccessfulPayment(transaction)) {
      const status = transaction && transaction.data && transaction.data.status ? transaction.data.status : 'unknown';
      return sendJson(res, 200, { ok: false, status, message: 'Ankar bai cika ba. Ka sake gwada.' });
    }
    await markPaymentPaid({ reference, transaction: transaction.data, userId: session.uid });
    const profile = await getProfile(session.uid);
    return sendJson(res, 200, { ok: true, status: 'paid', user: userPayload(profile, session) });
  }

  /* ---- private history (RLS enforced: users only see their own rows) ---- */
  if (route === '/api/history' && req.method === 'GET') {
    const profile = await getProfile(session.uid);
    if (!profile || profile.payment_status !== 'paid') {
      return sendJson(res, 403, { ok: false, error: 'payment_required', message: 'An sami bambancin rajista kafin amfani.' });
    }
    const rows = await restSelect('ramli_history', {
      user_id: `eq.${session.uid}`,
      select: 'id,user_id,kind,question,figures,interpretation,total_points,created_at',
      order: 'created_at.desc',
      limit: '100'
    }, session.sat);
    return sendJson(res, 200, { ok: true, history: Array.isArray(rows) ? rows : [] });
  }

  if (route === '/api/history' && req.method === 'POST') {
    const profile = await getProfile(session.uid);
    if (!profile || profile.payment_status !== 'paid') {
      return sendJson(res, 403, { ok: false, error: 'payment_required', message: 'An sami bambancin rajista kafin amfani.' });
    }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    const interpretation = String(body.interpretation || '').slice(0, 20000);
    const question = String(body.question || '').slice(0, 500);
    if (!interpretation) return sendJson(res, 400, { ok: false, error: 'interpretation_required' });
    const figures = Array.isArray(body.figures) ? body.figures.slice(0, 16) : null;
    const created = await restInsert('ramli_history', {
      user_id: session.uid,
      kind: String(body.kind || 'ramli'),
      question,
      figures,
      interpretation,
      total_points: Number.isFinite(Number(body.total_points)) ? Number(body.total_points) : null,
      created_at: new Date().toISOString()
    }, session.sat);
    return sendJson(res, 201, { ok: true, entry: Array.isArray(created) ? created[0] : created });
  }

  if (route === '/api/history' && req.method === 'DELETE') {
    const profile = await getProfile(session.uid);
    if (!profile || profile.payment_status !== 'paid') {
      return sendJson(res, 403, { ok: false, error: 'payment_required' });
    }
    const url2 = new URL(req.url, 'http://localhost');
    const id = url2.searchParams.get('id');
    if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' });
    await restDelete('ramli_history', { id: `eq.${id}`, user_id: `eq.${session.uid}` }, session.sat);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

/* ---------------------------- static files -------------------------- */

function serveStatic(req, res, url) {
  let rel = STATIC_FILES[url.pathname];
  if (!rel) {
    const publicDir = path.join(__dirname, 'public');
    const candidate = path.normalize(path.join(publicDir, url.pathname));
    if (candidate.startsWith(publicDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      rel = path.relative(__dirname, candidate);
    }
  }
  if (!rel) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const file = path.join(__dirname, rel);
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err && err.message);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'server_error', message: err && err.message ? err.message : 'unexpected error' });
    } else {
      res.end();
    }
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Ramli-Geomancy server listening on 0.0.0.0:${config.port}`);
  const missing = missingConfig();
  if (missing.length) {
    console.warn(`[config] Missing environment variables: ${missing.join(', ')}`);
    console.warn('[config] The app will run in limited/demo mode until these are set.');
  }
});

export { server };
