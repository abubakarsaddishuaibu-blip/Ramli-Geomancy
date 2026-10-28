/**
 * End-to-end API tests for the Ramli-Geomancy backend.
 * Uses in-process mock Supabase + mock Paystack servers (no real credentials).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

process.env.SUPABASE_URL = 'http://127.0.0.1:8791';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock';
process.env.PAYSTACK_BASE_URL = 'http://127.0.0.1:8792';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.APP_BASE_URL = 'http://127.0.0.1:8123';
process.env.PORT = '8123';

/* ----------------------------- mock Supabase ----------------------------- */

const db = {
  profiles: [],
  payments: [],
  ramli_history: []
};

function fakeJwt(uid, ttl = 3600) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: uid, exp: Math.floor(Date.now() / 1000) + ttl })}.sig`;
}

const users = []; // {id, email, password}

function filterRows(table, params, authToken) {
  let rows = db[table].slice();
  for (const [key, value] of params.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'returning') continue;
    if (value.startsWith('eq.')) {
      const expected = value.slice(3);
      rows = rows.filter((r) => String(r[key]) === expected);
    }
  }
  // Emulate RLS: a non-service token can only see its own rows.
  if (authToken && authToken !== 'service-test-key' && table === 'ramli_history') {
    const uid = decodeJwtSub(authToken);
    rows = rows.filter((r) => r.user_id === uid);
  }
  if (authToken && authToken !== 'service-test-key' && table === 'profiles') {
    const uid = decodeJwtSub(authToken);
    rows = rows.filter((r) => r.id === uid);
  }
  return rows;
}

function decodeJwtSub(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).sub;
  } catch { return null; }
}

const supabase = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const authHeader = (req.headers.authorization || '').replace('Bearer ', '');

  const send = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : null;

  // ----- auth endpoints -----
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
    const existing = users.find((u) => u.email === parsed.email);
    if (existing) return send(422, { msg: 'User already registered' });
    const id = 'uid-' + randomUUID().slice(0, 8);
    users.push({ id, email: parsed.email, password: parsed.password });
    db.profiles.push({
      id, email: parsed.email, full_name: parsed.user_metadata.full_name,
      payment_status: 'unpaid', registration_fee_kobo: 1500000, paid_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    return send(200, { id, email: parsed.email });
  }

  if (url.pathname === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const user = users.find((u) => u.email === parsed.email && u.password === parsed.password);
      if (!user) return send(400, { msg: 'Invalid login credentials' });
      return send(200, {
        access_token: fakeJwt(user.id), refresh_token: 'rt-' + user.id,
        user: { id: user.id, email: user.email }
      });
    }
    if (grant === 'refresh_token') {
      const uid = String(parsed.refresh_token).replace('rt-', '');
      if (!uid) return send(400, { msg: 'bad refresh token' });
      return send(200, { access_token: fakeJwt(uid), refresh_token: 'rt-' + uid });
    }
  }

  if (url.pathname === '/auth/v1/user') {
    const uid = decodeJwtSub(authHeader);
    const user = users.find((u) => u.id === uid);
    if (!user) return send(401, { msg: 'invalid token' });
    return send(200, { id: user.id, email: user.email, user_metadata: { full_name: 'Test User' } });
  }

  // ----- rest endpoints -----
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.slice('/rest/v1/'.length);
    if (!db[table]) return send(404, { msg: 'unknown table' });

    if (req.method === 'GET') {
      const rows = filterRows(table, url.searchParams, authHeader);
      const limit = Number(url.searchParams.get('limit') || rows.length);
      return send(200, rows.slice(0, limit));
    }
    if (req.method === 'POST') {
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const withIds = rows.map((r) => ({ id: r.id || 'row-' + randomUUID().slice(0, 8), ...r }));
      db[table].push(...withIds);
      return send(201, withIds);
    }
    if (req.method === 'PATCH') {
      const rows = filterRows(table, url.searchParams, authHeader);
      rows.forEach((r) => Object.assign(r, parsed));
      return send(200, url.searchParams.get('returning') === 'minimal' ? [] : rows);
    }
    if (req.method === 'DELETE') {
      const rows = filterRows(table, url.searchParams, authHeader);
      db[table] = db[table].filter((r) => !rows.includes(r));
      return send(200, []);
    }
  }

  send(404, { msg: 'not found' });
});

/* ------------------------------ mock Paystack ----------------------------- */

const paystack = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  let body = '';
  for await (const chunk of req) body += chunk;

  if (url.pathname === '/transaction/initialize' && req.method === 'POST') {
    const parsed = JSON.parse(body);
    if (!req.headers.authorization || !req.headers.authorization.includes('sk_test_mock')) {
      return send(401, { message: 'invalid key' });
    }
    return send(200, {
      status: true,
      data: { reference: parsed.reference, authorization_url: 'https://checkout.paystack.test/' + parsed.reference }
    });
  }
  if (url.pathname.startsWith('/transaction/verify/')) {
    const reference = url.pathname.split('/').pop();
    return send(200, {
      status: true,
      data: { reference, status: 'success', amount: 1500000, currency: 'NGN', paid_at: new Date().toISOString() }
    });
  }
  send(404, { message: 'not found' });
});

/* --------------------------------- runner --------------------------------- */

await new Promise((r) => supabase.listen(8791, '0.0.0.0', r));
await new Promise((r) => paystack.listen(8792, '0.0.0.0', r));

const { server } = await import('../server.js');
await new Promise((r) => server.once('listening', r));
const BASE = 'http://127.0.0.1:8123';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  -', name);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log('  FAIL -', name, '::', err.message);
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

console.log('\nRamli-Geomancy API tests\n');

await test('GET /api/config reports the ₦15,000 fee and no secrets', async () => {
  const { status, data } = await call('/api/config');
  assert.equal(status, 200);
  assert.equal(data.registration_fee_kobo, 1500000);
  const serialised = JSON.stringify(data);
  assert.ok(!serialised.includes('sk_test_mock'));
  assert.ok(!serialised.includes('service-test-key'));
});

await test('registration requires full name, email and password', async () => {
  let r = await call('/api/auth/register', { method: 'POST', body: { email: 'a@b.com', password: 'password123' } });
  assert.equal(r.status, 400);
  r = await call('/api/auth/register', { method: 'POST', body: { full_name: 'A B', email: 'not-an-email', password: 'password123' } });
  assert.equal(r.status, 400);
  r = await call('/api/auth/register', { method: 'POST', body: { full_name: 'A B', email: 'a@b.com', password: 'short' } });
  assert.equal(r.status, 400);
});

await test('registration creates a Supabase user and returns a session', async () => {
  const { status, data } = await call('/api/auth/register', {
    method: 'POST',
    body: { full_name: 'Musa Ibrahim', email: 'musa@example.com', password: 'strongpass123' }
  });
  assert.equal(status, 201);
  assert.ok(data.token);
  assert.equal(data.user.full_name, 'Musa Ibrahim');
  assert.equal(data.user.payment_status, 'unpaid');
  globalThis.userToken = data.token;
});

await test('duplicate email registration is rejected', async () => {
  const { status } = await call('/api/auth/register', {
    method: 'POST',
    body: { full_name: 'Musa Ibrahim', email: 'musa@example.com', password: 'strongpass123' }
  });
  assert.equal(status, 409);
});

await test('login works and wrong password is rejected', async () => {
  const { status, data } = await call('/api/auth/login', {
    method: 'POST', body: { email: 'musa@example.com', password: 'strongpass123' }
  });
  assert.equal(status, 200);
  assert.ok(data.token);
  const bad = await call('/api/auth/login', {
    method: 'POST', body: { email: 'musa@example.com', password: 'wrongpassword' }
  });
  assert.equal(bad.status, 401);
});

await test('history is blocked before payment', async () => {
  const { status, data } = await call('/api/history', { token: globalThis.userToken });
  assert.equal(status, 403);
  assert.equal(data.error, 'payment_required');
});

await test('payment initialisation returns a Paystack authorization URL', async () => {
  const { status, data } = await call('/api/payments/initialize', { method: 'POST', token: globalThis.userToken });
  assert.equal(status, 200);
  assert.ok(data.authorization_url.startsWith('https://checkout.paystack.test/'));
  assert.ok(data.reference);
  globalThis.reference = data.reference;
});

await test('payment verification unlocks the account (server-side)', async () => {
  const { status, data } = await call('/api/payments/verify', {
    method: 'POST', token: globalThis.userToken, body: { reference: globalThis.reference }
  });
  assert.equal(status, 200);
  assert.equal(data.status, 'paid');
  assert.equal(data.user.payment_status, 'paid');
});

await test('duplicate payment verification is idempotent (no double charge/processing)', async () => {
  const { status, data } = await call('/api/payments/verify', {
    method: 'POST', token: globalThis.userToken, body: { reference: globalThis.reference }
  });
  assert.equal(status, 200);
  assert.equal(data.status, 'paid');
  assert.equal(data.already_paid, true);
  const paid = db.payments.filter((p) => p.status === 'paid');
  assert.equal(paid.length, 1);
});

await test('initialising payment again for a paid user does not create a new charge', async () => {
  const { status, data } = await call('/api/payments/initialize', { method: 'POST', token: globalThis.userToken });
  assert.equal(status, 200);
  assert.equal(data.already_paid, true);
  assert.equal(db.payments.length, 1);
});

await test('history can be written and read back after payment', async () => {
  const write = await call('/api/history', {
    method: 'POST', token: globalThis.userToken,
    body: {
      kind: 'ramli', question: 'Shin zan samu aiki?',
      figures: [[1, 2, 1, 2]], interpretation: 'Alkawarin al', total_points: 97
    }
  });
  assert.equal(write.status, 201);
  const { status, data } = await call('/api/history', { token: globalThis.userToken });
  assert.equal(status, 200);
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].question, 'Shin zan samu aiki?');
});

await test('a second user cannot read the first user history', async () => {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { full_name: 'Hauwa Bello', email: 'hauwa@example.com', password: 'anotherpass123' }
  });
  assert.equal(reg.status, 201);
  const token = reg.data.token;
  // Second user pays, then tries to read history.
  const init = await call('/api/payments/initialize', { method: 'POST', token });
  await call('/api/payments/verify', { method: 'POST', token, body: { reference: init.data.reference } });
  const { status, data } = await call('/api/history', { token });
  assert.equal(status, 200);
  assert.equal(data.history.length, 0, 'second user must not see the first user entries');
  globalThis.user2Token = token;
});

await test('unauthenticated requests are rejected', async () => {
  const { status } = await call('/api/history');
  assert.equal(status, 401);
  const me = await call('/api/me');
  assert.equal(me.status, 401);
});

await test('a tampered session token is rejected', async () => {
  const tampered = globalThis.userToken.slice(0, -3) + 'abc';
  const { status } = await call('/api/me', { token: tampered });
  assert.equal(status, 401);
});

await test('the frontend bundle contains no secret keys and no credit system', async () => {
  const res = await fetch(BASE + '/geomancy_auth.js');
  const text = await res.text();
  assert.ok(!/sk_(live|test)_[A-Za-z0-9]+/.test(text));
  assert.ok(!/service_role/i.test(text));
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(!/credit system|kredi|coin balance/i.test(html));
});

server.close();
supabase.close();
paystack.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
