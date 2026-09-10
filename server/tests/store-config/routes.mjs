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
  // Non-secret store values
  STORE_CODE: 'ZZ', BRAND_NAME: 'Acme Co', BRAND_SHORT_NAME: 'Acme',
  BRAND_LOGO_WHITE: '/w.png', BRAND_LOGO_SYMBOL: '/s.png', BRAND_LOGO_BLACK: '/b.svg',
  BRAND_EMAIL_DOMAIN: 'acme.example', SHOPIFY_STORE_DOMAIN: 'zz-store.myshopify.com',
});
const SECRET_VALUES = Object.entries(process.env)
  .filter(([k]) => /TOKEN|SECRET|API_KEY|PASSWORD|DATABASE_URL/i.test(k))
  .map(([k, v]) => [k, v]);

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
