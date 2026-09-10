// S1-1 — DATABASE_SSL: a store must be bootable on its OWN Postgres.
//
// The TLS decision used to be inferred in three places from
// `DATABASE_URL.includes('render.com') || NODE_ENV === 'production'`, with no
// override. Booting a newborn store with its real production env against a
// Postgres that does not terminate TLS gave: /api/health 503 and login 500
// ("The server does not support SSL connections"), see PROOF-S1-1.md.
//
// Acceptance:
//   B1  unset  → the historical inference, unchanged (no deployment moves)
//   B2  '0'    → OFF even in production   ← the failure path that was unreachable
//   B3  '1'    → ON even in development
//   B4  garbage → THROWS, it is not silently treated as off
//   B5  the three pools read the helper, not their own copy of the inference
// Run:  node server/tests/sandbox/db-ssl.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbSslEnabled } from '../../src/config/dbSsl.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL = 'postgres://postgres@127.0.0.1:5433/sb_empty';
const RENDER = 'postgres://u:p@dpg-x.frankfurt-postgres.render.com/db';

test('B1 — unset keeps the historical inference', () => {
  assert.equal(dbSslEnabled({ DATABASE_URL: LOCAL, NODE_ENV: 'production' }), true);
  assert.equal(dbSslEnabled({ DATABASE_URL: RENDER, NODE_ENV: 'development' }), true);
  assert.equal(dbSslEnabled({ DATABASE_URL: LOCAL, NODE_ENV: 'development' }), false);
  assert.equal(dbSslEnabled({ DATABASE_URL: LOCAL, NODE_ENV: 'production', DATABASE_SSL: '' }), true);
});

test('B2 (failure path) — 0 turns TLS OFF in production', () => {
  for (const v of ['0', 'false', 'off', 'NO']) {
    assert.equal(dbSslEnabled({ DATABASE_URL: LOCAL, NODE_ENV: 'production', DATABASE_SSL: v }), false, v);
  }
  // even a render.com URL obeys an explicit 0 — explicit beats inferred
  assert.equal(dbSslEnabled({ DATABASE_URL: RENDER, NODE_ENV: 'production', DATABASE_SSL: '0' }), false);
});

test('B3 — 1 turns TLS ON in development', () => {
  for (const v of ['1', 'true', 'on', 'YES']) {
    assert.equal(dbSslEnabled({ DATABASE_URL: LOCAL, NODE_ENV: 'development', DATABASE_SSL: v }), true, v);
  }
});

test('B4 (failure path) — a malformed value throws, never silently off', () => {
  assert.throws(() => dbSslEnabled({ DATABASE_URL: LOCAL, DATABASE_SSL: 'maybe' }), /DATABASE_SSL must be 0 or 1/);
});

test('B5 — no pool keeps a private copy of the inference', () => {
  for (const f of ['server/src/config/db.js', 'server/src/db/pg.js', 'server/src/services/analyticsDb.js']) {
    const src = readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(src.includes('dbSslEnabled('), `${f} does not call dbSslEnabled()`);
    assert.ok(!/ssl:[^\n]*NODE_ENV === 'production'/.test(src), `${f} still infers ssl inline`);
  }
});
