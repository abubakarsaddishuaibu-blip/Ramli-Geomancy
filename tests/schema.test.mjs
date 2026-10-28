/**
 * Static consistency check between db/schema.sql and the backend.
 *
 * This test does NOT need any credentials: it parses the SQL schema and the
 * server source and asserts that
 *   1. every table/column the backend writes to really exists in the schema,
 *   2. Row Level Security is enabled on every private table,
 *   3. every RLS policy is scoped to the `authenticated` role and to the
 *      row owner (auth.uid() = user_id / id),
 *   4. duplicate payments are prevented at the database level.
 *
 * Run with: node tests/schema.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  -', name);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log('  FAIL -', name, '::', err.message);
  }
}

/* ------------------------- schema parsing helpers ------------------------ */

/** Parse `create table ... ( ... );` blocks into { table: [columns] }. */
function parseTables(source) {
  const tables = {};
  const re = /create\s+table\s+if\s+not\s+exists\s+(?:public\.)?([a-z_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1].toLowerCase();
    // find the matching closing paren of the column list
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const body = source.slice(re.lastIndex, i - 1);
    const columns = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || /^(constraint|primary|unique|foreign|check)\b/i.test(line)) continue;
      const col = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (col) columns.push(col[1].toLowerCase());
    }
    tables[name] = columns;
  }
  return tables;
}

const tables = parseTables(sql);

/** Extract quoted keys of a JS object literal that starts right after `marker`. */
function objectKeys(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return [];
  const open = source.indexOf('{', start);
  if (open === -1) return [];
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = source.slice(open + 1, end);
  const keys = [];
  const re = /(?:^|[{,\s])'?([a-z_][a-z0-9_]*)'?\s*:/gi;
  let m;
  while ((m = re.exec(body))) keys.push(m[1].toLowerCase());
  return keys;
}

/* --------------------------------- tests --------------------------------- */

test('schema defines profiles, payments and ramli_history', () => {
  for (const t of ['profiles', 'payments', 'ramli_history']) {
    assert.ok(tables[t], `missing table ${t}`);
    assert.ok(tables[t].length > 0, `table ${t} has no columns`);
  }
});

test('every table used by the backend exists in the schema', () => {
  const used = [...serverSrc.matchAll(/rest(?:Select|Insert|Update|Delete)\(\s*'([a-z_]+)'/gi)]
    .map((m) => m[1].toLowerCase());
  assert.ok(used.length >= 5, 'expected the backend to query several tables');
  for (const t of new Set(used)) {
    assert.ok(tables[t], `backend queries table "${t}" which is not in db/schema.sql`);
  }
});

test('backend columns exist in the matching schema tables', () => {
  const checks = [
    ['restInsert(\'profiles\'', 'profiles'],
    ['restUpdate(\'profiles\'', 'profiles'],
    ['restInsert(\'payments\'', 'payments'],
    ['restUpdate(\'payments\'', 'payments'],
    ['restInsert(\'ramli_history\'', 'ramli_history']
  ];
  for (const [marker, table] of checks) {
    const keys = objectKeys(serverSrc, marker);
    assert.ok(keys.length > 0, `could not parse object literal after ${marker}`);
    for (const key of keys) {
      assert.ok(
        tables[table].includes(key),
        `backend writes "${key}" into ${table} but db/schema.sql has no such column`
      );
    }
  }
});

test('the history SELECT column list matches the ramli_history table', () => {
  const m = serverSrc.match(/select:\s*'([^']+)'/);
  assert.ok(m, 'history query does not use an explicit column list');
  for (const col of m[1].split(',').map((s) => s.trim().toLowerCase())) {
    assert.ok(tables.ramli_history.includes(col), `history selects unknown column "${col}"`);
  }
});

test('Row Level Security is enabled on every private table', () => {
  for (const t of ['profiles', 'payments', 'ramli_history']) {
    const re = new RegExp(`alter\\s+table\\s+(?:public\\.)?${t}\\s+enable\\s+row\\s+level\\s+security`, 'i');
    assert.ok(re.test(sql), `RLS is not enabled on ${t}`);
  }
});

test('every RLS policy is restricted to the authenticated role', () => {
  const policies = [...sql.matchAll(/create\s+policy\s+"?([a-z_]+)"?\s+on\s+(?:public\.)?([a-z_]+)\s+for\s+([a-z]+)\s+to\s+([a-z, ]+)/gi)];
  assert.ok(policies.length >= 7, `expected several policies, found ${policies.length}`);
  for (const p of policies) {
    const roles = p[4].split(',').map((r) => r.trim().toLowerCase());
    assert.ok(roles.includes('authenticated'), `policy "${p[1]}" is not limited to authenticated users`);
    assert.ok(!roles.includes('anon'), `policy "${p[1]}" is exposed to the anon role`);
  }
});

test('history policies are scoped to the row owner (auth.uid() = user_id)', () => {
  const historyPolicies = [...sql.matchAll(/create\s+policy\s+"?([a-z_]+)"?\s+on\s+(?:public\.)?ramli_history[\s\S]*?;/gi)]
    .map((m) => m[0]);
  assert.ok(historyPolicies.length >= 4, 'expected select/insert/update/delete policies on ramli_history');
  for (const p of historyPolicies) {
    assert.ok(/auth\.uid\(\)\s*=\s*user_id/.test(p), `history policy is not owner-scoped:\n${p}`);
  }
});

test('profiles and payments policies are scoped to their owner', () => {
  const own = [...sql.matchAll(/create\s+policy\s+"?([a-z_]+)"?\s+on\s+(?:public\.)?(profiles|payments)[\s\S]*?;/gi)]
    .map((m) => m[0]);
  assert.ok(own.length >= 3, 'expected owner-scoped policies on profiles/payments');
  for (const p of own) {
    assert.ok(/auth\.uid\(\)\s*=\s*(id|user_id)/.test(p), `policy is not owner-scoped:\n${p}`);
  }
});

test('duplicate payments are prevented at the database level', () => {
  assert.ok(
    /create\s+unique\s+index[\s\S]*?payments_one_paid_per_user[\s\S]*?on\s+public\.payments\s*\(\s*user_id\s*\)[\s\S]*?where\s+status\s*=\s*'paid'/i.test(sql),
    'missing the "one paid payment per user" unique index'
  );
  assert.ok(/reference\s+text\s+not\s+null\s+unique/i.test(sql), 'payments.reference must be unique');
});

test('a new auth user automatically gets an unpaid profile', () => {
  assert.ok(/handle_new_user/.test(sql), 'missing handle_new_user trigger function');
  assert.ok(/on_auth_user_created/.test(sql), 'missing on_auth_user_created trigger');
  assert.ok(/'unpaid'/.test(sql), 'new profiles must default to unpaid');
});

test('schema does not contain any secret key', () => {
  assert.ok(!/sk_(live|test)_[A-Za-z0-9]{6,}/.test(sql), 'schema contains a Paystack secret key');
  assert.ok(!/service_role[\s\S]{0,40}eyJ/.test(sql), 'schema contains a Supabase service key');
});

/* --------------------------------- summary -------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
