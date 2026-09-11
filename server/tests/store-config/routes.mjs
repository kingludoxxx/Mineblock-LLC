// STORE CONFIG ROUTES — GET /api/v1/store-config (session) and GET /api/v1/brand
// (public) through the REAL authenticate middleware against a fresh local
// Postgres database (lane_constants, port 5433).
//
// Asserts BY EXECUTION:
//   store-config: 401 without a session; 200 with one; the body carries NO
//                 token/secret value (every secret-ish env value set here is
//                 scanned for) and no secret-named key (A4).
//   brand:        200 with no session; six fields; null when env is unset;
//                 values when set; NO secret leaks.
//
// Run:  node server/tests/store-config/routes.mjs
import postgres from 'postgres';
import express from 'express';
import jwt from 'jsonwebtoken';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DB = 'postgres://postgres@127.0.0.1:5433/lane_constants';
Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: 'lane-f-access-secret', JWT_REFRESH_SECRET: 'lane-f-refresh-secret',
  // Secret-ish values this surface must NEVER echo. Each one is unique so the
  // scan below can name the leak.
  FRAMEIO_TOKEN: 'LEAK-frameio-token-a1b2', FRAME_IO_TOKEN: 'LEAK-frame-io-token-c3d4',
  SHOPIFY_ACCESS_TOKEN: 'LEAK-shopify-token-e5f6', META_ACCESS_TOKEN: 'LEAK-meta-token-g7h8',
  SLACK_BOT_TOKEN: 'LEAK-slack-token-i9j0', TRIPLEWHALE_API_KEY: 'LEAK-tw-key-k1l2',
  WHOP_API_TOKEN: 'LEAK-whop-token-m3n4', CLICKUP_API_TOKEN: 'LEAK-clickup-token-o5p6',
  SHOPIFY_WEBHOOK_SECRET: 'LEAK-shopify-webhook-q7r8', CRON_SECRET: 'LEAK-cron-s9t0',
  META_APP_SECRET: 'LEAK-meta-app-u1v2',
  // Non-secret store values. PRODUCT_CODES_JSON is REQUIRED (boot refuses
  // without it — boot-gate.mjs), so a running server always has one.
  PRODUCT_CODES_JSON: '{"ZZ":{"default":true,"clickup":{"videoListId":"901"},"frameio":{"projectId":"proj-zz"}}}',
  STORE_CODE: 'ZZ', BRAND_NAME: 'Acme Co', BRAND_SHORT_NAME: 'Acme',
  BRAND_LOGO_WHITE: '/w.png', BRAND_LOGO_SYMBOL: '/s.png', BRAND_LOGO_BLACK: '/b.svg',
  BRAND_EMAIL_DOMAIN: 'acme.example', SHOPIFY_STORE_DOMAIN: 'zz-store.myshopify.com',
  // W6: the hub block. HUB_SSO_SECRET is set here ON PURPOSE — it is the credential that signs hub tickets,
  // it is matched by the SECRET_VALUES filter below, and the scan must catch it if this surface ever echoes it.
  HUB_ORIGIN: 'https://hub.example.test', HUB_SSO_ENABLED: '1',
  HUB_SSO_SECRET: 'LEAK-hub-sso-secret-w6x1-at-least-32-bytes',
});
const SECRET_VALUES = Object.entries(process.env)
  .filter(([k]) => /TOKEN|SECRET|API_KEY|PASSWORD|DATABASE_URL/i.test(k))
  .map(([k, v]) => [k, v]);

// W6b: the list a hub session arrives with. Store identity is DATA (R5/R15): these codes live in this fixture
// and nowhere in engine code. PL is the can_hop=false row the sidebar greys.
const HUB_SID = '3f6c1b7e-2b21-4f6a-9d4e-5a1c8e0b7d42';
const HUB_LIST = [
  { code: 'ZZ', name: 'Acme Co', role: 'owner', can_hop: true },
  { code: 'QQ', name: 'Second Store', role: 'viewer', can_hop: true },
  { code: 'PL', name: 'Unarmed Store', role: 'owner', can_hop: false },
];

const admin = postgres('postgres://postgres@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS lane_constants`;
await admin`CREATE DATABASE lane_constants`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
await sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE, is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u1','sc@local.test','S','C')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r1','viewer','{}')`;
await sql`INSERT INTO user_roles VALUES ('u1','r1')`;
// W6b: the sessions row a hub-SSO token is checked against, with the switcher list migration 132 parks on it.
// This is the ONLY way to make /store-config answer with a non-empty list, which is what the scanner must scan.
await sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TIMESTAMPTZ, hub_stores JSONB)`;
await sql`INSERT INTO sessions (id, user_id, expires_at, hub_stores) VALUES
  (${HUB_SID}, 'u1', NOW() + INTERVAL '1 hour', ${sql.json(HUB_LIST)})`;
await sql.end();

const router = (await import('../../src/routes/storeConfig.js')).default;
const app = express();
app.use(express.json());
app.use('/api/v1', router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1`;
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const get = async (path, headers = {}) => {
  const r = await fetch(`${B}${path}`, { headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json, headers: r.headers };
};
const scan = (text, label) => {
  for (const [k, v] of SECRET_VALUES) assert.ok(!text.includes(v), `${label} leaks the value of ${k}`);
  const keys = [];
  (function walk(o) { for (const [k, v] of Object.entries(o || {})) { keys.push(k); if (v && typeof v === 'object') walk(v); } })(JSON.parse(text));
  const bad = keys.filter((k) => /token|secret|password|apikey|api_key/i.test(k));
  assert.deepEqual(bad, [], `${label} has secret-named keys: ${bad}`);
};

test('GET /store-config without a session → 401', async () => {
  const r = await get('/store-config');
  assert.equal(r.status, 401, r.text);
});

test('GET /store-config with a garbage bearer → 401', async () => {
  const r = await get('/store-config', { Authorization: 'Bearer not-a-jwt' });
  assert.equal(r.status, 401, r.text);
});

test('GET /store-config with a session → 200, non-secret snapshot, no leak (A4)', async () => {
  const r = await get('/store-config', { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.success, true);
  assert.equal(r.json.data.storeCode, 'ZZ');
  assert.equal(r.json.data.brand.name, 'Acme Co');
  assert.equal(r.json.data.shopify.storeDomain, 'zz-store.myshopify.com');
  scan(r.text, 'store-config');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});

test('W6: GET /store-config carries hub{origin,sso_enabled} and switcher{current,stores}, and no secret', async () => {
  const r = await get('/store-config', { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.hub, { origin: 'https://hub.example.test', sso_enabled: true });
  assert.deepEqual(r.json.data.switcher, { current: 'ZZ', stores: [] });
  scan(r.text, 'store-config with a hub');                       // catches HUB_SSO_SECRET if it ever leaks here
});

test('W6 R7: the hub block is read at REQUEST time, and the flag is only ever the string "1"', async () => {
  const saved = { o: process.env.HUB_ORIGIN, f: process.env.HUB_SSO_ENABLED };
  try {
    process.env.HUB_SSO_ENABLED = 'true';                        // the flag is "1" or it is off, like every other R7 flag
    assert.equal((await get('/store-config', { Authorization: `Bearer ${token}` })).json.data.hub.sso_enabled, false);
    delete process.env.HUB_ORIGIN;
    const off = await get('/store-config', { Authorization: `Bearer ${token}` });
    assert.deepEqual(off.json.data.hub, { origin: null, sso_enabled: false }, 'no hub configured: the client renders no switcher');
    assert.deepEqual(off.json.data.switcher.stores, []);
  } finally { process.env.HUB_ORIGIN = saved.o; process.env.HUB_SSO_ENABLED = saved.f; }
  const back = await get('/store-config', { Authorization: `Bearer ${token}` });
  assert.equal(back.json.data.hub.origin, 'https://hub.example.test', 'and back, on the next request, with no restart');
});

test('W6c P2-1: hub.origin is normalised to a BARE origin, and an unparseable one is null', async () => {
  // What this value is FOR is being concatenated with `/switch/<code>?next=…` in the browser. Anything after
  // the authority breaks every link in the dropdown SILENTLY: measured on the unnormalised value,
  // `https://hub.example.test#x` produced `https://hub.example.test#x/switch/MB?next=%2Fapp%2Fdashboard`,
  // which is the hub ROOT. A `?token=` pasted into HUB_ORIGIN reached the browser verbatim for the same reason.
  const saved = process.env.HUB_ORIGIN;
  const SECRET_IN_A_URL = 'https://hub.example.test/?token=LEAK-hub-sso-secret-w6x1-at-least-32-bytes';
  try {
    for (const [given, want] of [
      ['https://hub.example.test', 'https://hub.example.test'],
      ['https://hub.example.test/', 'https://hub.example.test'],
      ['https://hub.example.test///', 'https://hub.example.test'],
      ['https://hub.example.test/path', 'https://hub.example.test'],
      ['https://hub.example.test#x', 'https://hub.example.test'],
      ['https://hub.example.test/a?b=c#d', 'https://hub.example.test'],
      ['https://hub.example.test:8443/x', 'https://hub.example.test:8443'],      // a port IS part of the origin
      ['http://127.0.0.1:3000/x', 'http://127.0.0.1:3000'],
      [SECRET_IN_A_URL, 'https://hub.example.test'],
      ['javascript:alert(1)', null],
      ['not-a-url', null],
      ['ftp://hub.example.test', null],
    ]) {
      process.env.HUB_ORIGIN = given;
      const r = await get('/store-config', { Authorization: `Bearer ${token}` });
      assert.equal(r.json.data.hub.origin, want, `HUB_ORIGIN=${given}`);
    }
    // and the scanner's own point: a secret pasted into HUB_ORIGIN no longer reaches the browser at all.
    process.env.HUB_ORIGIN = SECRET_IN_A_URL;
    const leaky = await get('/store-config', { Authorization: `Bearer ${token}` });
    assert.equal(leaky.text.includes('LEAK-hub-sso-secret'), false, 'the query string a secret was pasted into is gone');
    scan(leaky.text, 'store-config with a secret pasted into HUB_ORIGIN');
  } finally { process.env.HUB_ORIGIN = saved; }
  const back = await get('/store-config', { Authorization: `Bearer ${token}` });
  assert.equal(back.json.data.hub.origin, 'https://hub.example.test', 'read at REQUEST time (R7): back on the next request');
});

test('W6: the store list is never taken from the client', async () => {
  const r = await get('/store-config?stores=%5B%7B%22code%22%3A%22XX%22%2C%22name%22%3A%22Injected%22%7D%5D', {
    Authorization: `Bearer ${token}`, 'x-hub-stores': '[{"code":"XX","name":"Injected"}]',
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.switcher.stores, []);
  assert.ok(!r.text.includes('Injected'), r.text);
});

test('W6b: switcher.stores passes role and can_hop through, and the scanner sees the richer answer', async () => {
  const hubToken = jwt.sign({ userId: 'u1', hub_sso: true, sid: HUB_SID }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const r = await get('/store-config', { Authorization: `Bearer ${hubToken}` });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.switcher.stores, HUB_LIST, 'exactly the session row\'s list, role and can_hop included');
  for (const entry of r.json.data.switcher.stores) assert.deepEqual(Object.keys(entry).sort(), ['can_hop', 'code', 'name', 'role']);
  assert.equal(r.json.data.switcher.stores.filter((x) => x.can_hop === false).length, 1, 'the greyed row is served, not hidden');
  scan(r.text, 'store-config with a hub session and a full switcher list');
});

test('W6b: a W6-shaped row ({code,name}) read back from a session gains the defaults, and still leaks nothing', async () => {
  const sid = '8b2d4c10-6a77-4f2b-8e39-0c5d7a1b9e64';
  const sql2 = postgres(DB, { ssl: false, onnotice: () => {} });
  await sql2`INSERT INTO sessions (id, user_id, expires_at, hub_stores) VALUES
    (${sid}, 'u1', NOW() + INTERVAL '1 hour', ${sql2.json([{ code: 'ZZ', name: 'Acme Co' }])})`;
  await sql2.end();
  const hubToken = jwt.sign({ userId: 'u1', hub_sso: true, sid }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const r = await get('/store-config', { Authorization: `Bearer ${hubToken}` });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.switcher.stores, [{ code: 'ZZ', name: 'Acme Co', role: '', can_hop: true }]);
  scan(r.text, 'store-config with a W6-shaped session row');
});

test('W6b NEGATIVE CONTROL: a role that carries the hub secret IS caught by the scanner', async () => {
  const sid = 'c1a9f4d3-70b6-4e58-9a2c-3d8f6b0e5217';
  const sql2 = postgres(DB, { ssl: false, onnotice: () => {} });
  await sql2`INSERT INTO sessions (id, user_id, expires_at, hub_stores) VALUES
    (${sid}, 'u1', NOW() + INTERVAL '1 hour', ${sql2.json([{ code: 'ZZ', name: 'Acme Co', role: process.env.HUB_SSO_SECRET, can_hop: true }])})`;
  await sql2.end();
  const hubToken = jwt.sign({ userId: 'u1', hub_sso: true, sid }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const r = await get('/store-config', { Authorization: `Bearer ${hubToken}` });
  assert.equal(r.status, 200, r.text);
  // The 24-character role cap is what stops a 42-character credential ever reaching a pill: the entry is
  // dropped whole on the way out, so the value is not in the answer at all.
  assert.ok(process.env.HUB_SSO_SECRET.length > 24, 'the planted value is longer than a role may be');
  assert.deepEqual(r.json.data.switcher.stores, [], 'a value long enough to hide a credential is not a role');
  assert.ok(!r.text.includes(process.env.HUB_SSO_SECRET), 'and it is nowhere in the answer');
  // and the scanner itself still bites on a planted leak, proving it is not asleep
  assert.throws(() => scan(JSON.stringify({ leak: process.env.HUB_SSO_SECRET }), 'planted'), /leaks the value of HUB_SSO_SECRET/);
});

test('GET /brand is public → 200, six fields, no leak', async () => {
  const r = await get('/brand');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data, {
    name: 'Acme Co', shortName: 'Acme', logoWhite: '/w.png', logoSymbol: '/s.png', logoBlack: '/b.svg', emailDomain: 'acme.example',
  });
  scan(r.text, 'brand');
});

test('GET /brand with BRAND_* unset → nulls (client keeps its build-time fallback)', async () => {
  const saved = {};
  for (const k of ['BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_LOGO_WHITE', 'BRAND_LOGO_SYMBOL', 'BRAND_LOGO_BLACK', 'BRAND_EMAIL_DOMAIN']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const r = await get('/brand');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, { name: null, shortName: null, logoWhite: null, logoSymbol: null, logoBlack: null, emailDomain: null });
  } finally { Object.assign(process.env, saved); }
});

test('NEGATIVE CONTROL: the scan itself catches a planted leak', () => {
  assert.throws(() => scan(JSON.stringify({ data: { x: process.env.FRAMEIO_TOKEN } }), 'planted'), /leaks the value of FRAMEIO_TOKEN/);
  assert.throws(() => scan(JSON.stringify({ data: { apiKey: 'x' } }), 'planted'), /secret-named keys/);
});

test.after(() => { server.close(); });
