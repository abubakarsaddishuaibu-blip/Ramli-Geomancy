/**
 * REAL integration test — runs against a live Supabase project and a live
 * Paystack account. It is NOT part of `npm test` (which uses mocks only).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   PAYSTACK_SECRET_KEY=sk_test_... SESSION_SECRET=... \
 *   APP_BASE_URL=http://127.0.0.1:8124 PORT=8124 \
 *   node tests/integration.test.mjs
 *
 * It exits 0 with a SKIPPED notice when credentials are missing, so it can be
 * wired into CI without failing on a developer machine.
 *
 * IMPORTANT: it never completes a real charge. It initialises a Paystack
 * transaction and asserts that an UNPAID transaction does NOT unlock the
 * account, which is exactly the security property we care about.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYSTACK_SECRET_KEY', 'SESSION_SECRET'];
const missing = required.filter((k) => !process.env[k]);

if (missing.length) {
  console.log('SKIPPED: real integration test – missing env vars: ' + missing.join(', '));
  process.exit(0);
}

process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'http://127.0.0.1:8124';
process.env.PORT = process.env.PORT || '8124';

const { server } = await import('../server.js');
await new Promise((r) => server.once('listening', r));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || '8124');

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
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const email = `itest-${randomUUID().slice(0, 8)}@example.com`;
const password = 'IntegrationTest!42';

await test('GET /api/config reports the configured services', async () => {
  const { status, data } = await call('/api/config');
  assert.equal(status, 200);
  assert.equal(data.supabase_configured, true, 'Supabase is not configured: ' + JSON.stringify(data.missing));
  assert.equal(data.paystack_configured, true, 'Paystack is not configured');
  assert.equal(data.registration_fee_kobo, 1500000);
  assert.equal(data.missing.length, 0, 'missing config: ' + data.missing.join(','));
});

await test('registration creates a real Supabase user and profile', async () => {
  const { status, data } = await call('/api/auth/register', {
    method: 'POST', body: { full_name: 'Integration Tester', email, password }
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.ok(data.token, 'no session token returned');
  assert.equal(data.user.payment_status, 'unpaid');
});

let token = null;
await test('login works against real Supabase Auth', async () => {
  const { status, data } = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(status, 200, JSON.stringify(data));
  token = data.token;
  assert.ok(token);
});

await test('history is blocked before payment', async () => {
  const { status } = await call('/api/history', { token });
  assert.equal(status, 402, 'expected payment_required');
});

await test('Paystack initialises a real transaction', async () => {
  const { status, data } = await call('/api/payments/initialize', { method: 'POST', token });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.reference, 'no reference returned');
  assert.ok(data.authorization_url, 'no authorization_url returned');
  globalThis.__reference = data.reference;
});

await test('an UNPAID real transaction does not unlock the account', async () => {
  const { status, data } = await call('/api/payments/verify', {
    method: 'POST', token, body: { reference: globalThis.__reference }
  });
  // Paystack reports a pending transaction; the server must refuse to unlock.
  assert.ok(![200, 201].includes(status) || data.status !== 'paid', 'an unpaid transaction unlocked the account!');
  const me = await call('/api/me', { token });
  assert.notEqual(me.data.user.payment_status, 'paid', 'account was marked paid without money');
});

await test('history stays private: another user cannot read this user rows', async () => {
  const otherEmail = `itest-other-${randomUUID().slice(0, 8)}@example.com`;
  const reg = await call('/api/auth/register', {
    method: 'POST', body: { full_name: 'Other Tester', email: otherEmail, password }
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const otherToken = reg.data.token;
  // The second user writes nothing, but the API must never return foreign rows.
  const { data } = await call('/api/history', { token: otherToken });
  assert.ok(Array.isArray(data.history));
  assert.equal(data.history.length, 0, 'a new user saw rows belonging to another user');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
