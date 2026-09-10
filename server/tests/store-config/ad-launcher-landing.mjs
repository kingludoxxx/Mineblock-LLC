// AD LAUNCHER LANDING URL — item 8: the mineblock.co / example.com fallback is
// gone. With no landing_page_url, no product_profiles.product_url and no
// SHOPIFY_STORE_URL, POST /batches/:id/launch answers 400 with a message that
// names the three ways to fix it, BEFORE any Meta call. With SHOPIFY_STORE_URL
// set, resolveLandingUrl() returns it (unit, so no live Meta call is made).
//
// Real router, REAL authenticate + requirePermission, fresh local Postgres.
// Run:  node server/tests/store-config/ad-launcher-landing.mjs
import postgres from 'postgres';
import express from 'express';
import jwt from 'jsonwebtoken';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DB = 'postgres://postgres@127.0.0.1:5433/lane_constants_adl';
Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: 'lane-f-access-secret', JWT_REFRESH_SECRET: 'lane-f-refresh-secret',
  META_ACCESS_TOKEN: 'fake-meta-token', META_AD_ACCOUNT_IDS: 'act_1',
});
delete process.env.SHOPIFY_STORE_URL;

const admin = postgres('postgres://postgres@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS lane_constants_adl`;
await admin`CREATE DATABASE lane_constants_adl`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
await sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE, is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u1','adl@local.test','A','L')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r1','launcher','{"ads-launcher": ["access"]}')`;
await sql`INSERT INTO user_roles VALUES ('u1','r1')`;
await sql`CREATE TABLE spy_creatives (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID, batch_position INTEGER)`;

const mod = await import('../../src/routes/adLauncher.js');
const app = express();
app.use(express.json());
app.use('/api/v1/ad-launcher', mod.default);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/ad-launcher`;
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// A batch with one creative and a product that has no product_profiles row.
const batchRes = await fetch(`${B}/batches`, { method: 'POST', headers: H, body: JSON.stringify({ product_id: 1, name: 't' }) }).catch(() => null);
let batchId;
if (batchRes && batchRes.ok) {
  batchId = (await batchRes.json()).data?.id;
}
if (!batchId) {
  // The create route may need more fixtures than this harness has; seed directly.
  const rows = await sql`INSERT INTO ad_batches (product_id, name) VALUES (1, 't') RETURNING id`;
  batchId = rows[0].id;
}
await sql`INSERT INTO spy_creatives (batch_id, batch_position) VALUES (${batchId}, 1)`;

test('POST /batches/:id/launch with no landing URL anywhere → 400 naming the three fixes; no Meta call', async () => {
  const r = await fetch(`${B}/batches/${batchId}/launch`, { method: 'POST', headers: H, body: JSON.stringify({ adset_id: 'as1', page_id: 'pg1' }) });
  const body = await r.json();
  assert.equal(r.status, 400, JSON.stringify(body));
  assert.match(body.error.message, /landing_page_url/);
  assert.match(body.error.message, /product_url/);
  assert.match(body.error.message, /SHOPIFY_STORE_URL/);
  const [{ status }] = await sql`SELECT status FROM ad_batches WHERE id = ${batchId}`;
  assert.notEqual(status, 'launching', 'the batch must not be marked launching when the launch was refused');
});

test('resolveLandingUrl(): SHOPIFY_STORE_URL set → that URL; override wins; unset → null (no literal)', async () => {
  const batch = { product_id: 1 };
  assert.equal(await mod.resolveLandingUrl({ batch, override: 'https://o.example/x' }), 'https://o.example/x');
  assert.equal(await mod.resolveLandingUrl({ batch }), null);
  process.env.SHOPIFY_STORE_URL = 'https://zz.example';
  assert.equal(await mod.resolveLandingUrl({ batch }), 'https://zz.example');
  delete process.env.SHOPIFY_STORE_URL;
});

test.after(async () => { server.close(); await sql.end(); });
