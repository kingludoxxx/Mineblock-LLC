// BOOT GATE — PRODUCT_CODES_JSON fails CLOSED at boot (Lane F2, review P1-1).
//
// Baseline (Lane F): PRODUCT_CODES_JSON unset made productCodes() return {}
// with one warning, and clickupWebhook then took its `else` branch — a P1 card
// got a Frame.io folder inside PUURE's project and the PL reconciler issued a
// live `PUT /task/:id` rename. That is fail-OPEN into another product.
//
// Now: an unset or malformed PRODUCT_CODES_JSON is a boot refusal. There is no
// silent empty catalogue: productCodes() THROWS, so every downstream path
// (productForTask → ownFrameParent → handleEditingStatusChange /
// create-frame-folder / reconcilePlName) refuses instead of falling through.
//
// Run:  node server/tests/store-config/boot-gate.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const SERVER_JS = path.join(REPO, 'server/src/server.js');

const mod = await import('../../src/config/storeConfig.js');
const sc = mod.default;

const VALID = JSON.stringify({
  AA: { default: true, clickup: { videoListId: '111', initialStatus: 'edit queue' }, frameio: { projectId: 'proj-aa', editingFolderId: 'fold-aa' } },
});

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PRODUCT_CODES_JSON');
  const prev = process.env.PRODUCT_CODES_JSON;
  if (value === undefined) delete process.env.PRODUCT_CODES_JSON;
  else process.env.PRODUCT_CODES_JSON = value;
  sc.resetWarnings();
  try { return fn(); } finally {
    if (had) process.env.PRODUCT_CODES_JSON = prev; else delete process.env.PRODUCT_CODES_JSON;
  }
}

// ── the module contract ─────────────────────────────────────────────────────
test('productCodes(): unset THROWS — no silent empty catalogue', () => {
  withEnv(undefined, () => {
    assert.throws(() => sc.productCodes(), (e) => e instanceof mod.StoreConfigError && /PRODUCT_CODES_JSON/.test(e.message) && /not set/i.test(e.message));
  });
});

test('productCodes(): malformed THROWS, one clear message naming the key and the reason', () => {
  // '{}' and a blank value are the two that used to slip through: both parse
  // (or read as unset) into an empty catalogue without a word.
  for (const bad of ['{nope', '[]', '{}', '   ', '{"aa": "x"}', '{"AA": {"clickup": "111"}}', '{"AA": {"default": true}, "BB": {"default": true}}']) {
    withEnv(bad, () => {
      assert.throws(() => sc.productCodes(), (e) => e instanceof mod.StoreConfigError && /PRODUCT_CODES_JSON/.test(e.message), bad);
    });
  }
});

test('productCodes(): valid → entries, no throw', () => {
  withEnv(VALID, () => assert.equal(sc.productCodes().AA.code, 'AA'));
});

test('the wrong-product fall-through is unreachable: every product lookup refuses when the catalogue is absent', () => {
  withEnv(undefined, () => {
    // clickupWebhook: productForTask → productForClickupProductRef.
    // Baseline returned null here, which sent a P1 card down the PL branch.
    assert.throws(() => sc.productForClickupProductRef({ id: '123yxuahe91', name: 'P1' }), mod.StoreConfigError);
    // briefPipeline: pipelineForProduct → productFor.
    assert.throws(() => sc.productFor('MR'), mod.StoreConfigError);
    assert.throws(() => sc.defaultProduct(), mod.StoreConfigError);
    assert.throws(() => sc.snapshot(), mod.StoreConfigError);
  });
});

test('assertBootConfig(): throws on unset/malformed, returns on valid', () => {
  withEnv(undefined, () => assert.throws(() => sc.assertBootConfig(), (e) => /PRODUCT_CODES_JSON/.test(e.message)));
  withEnv('{nope', () => assert.throws(() => sc.assertBootConfig(), (e) => /PRODUCT_CODES_JSON/.test(e.message)));
  withEnv(VALID, () => assert.doesNotThrow(() => sc.assertBootConfig()));
});

// ── the real boot ───────────────────────────────────────────────────────────
// server.js is spawned for real. No DB / Redis is needed: both failures are
// warnings on this code path, and the store-config gate runs before them.
// The process is killed as soon as it either exits or reaches `listen`.
function boot(extraEnv, { timeout = 40000 } = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    PORT: String(extraEnv.PORT || 39751),
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/postgres',
    REDIS_URL: 'redis://127.0.0.1:6399',
    SKIP_STATICS_QUEUE_WORKER: '1',
    ...extraEnv,
  };
  if (extraEnv.PRODUCT_CODES_JSON === undefined) delete env.PRODUCT_CODES_JSON;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER_JS], { cwd: REPO, env });
    let out = '';
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch { /* already gone */ } resolve({ code, out }); };
    const onData = (b) => {
      out += b.toString();
      if (/Server running on port/.test(out)) finish('LISTENING');
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => finish(code));
    const t = setTimeout(() => finish('TIMEOUT'), timeout);
  });
}

test('boot refuses with a clear error when PRODUCT_CODES_JSON is unset', async () => {
  const r = await boot({});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PRODUCT_CODES_JSON/);
  assert.match(r.out, /refus/i);
  assert.doesNotMatch(r.out, /Server running on port/);
});

test('boot refuses when PRODUCT_CODES_JSON is malformed', async () => {
  const r = await boot({ PRODUCT_CODES_JSON: '{nope' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PRODUCT_CODES_JSON/);
});

test('boot proceeds past the gate and listens with a valid PRODUCT_CODES_JSON', async () => {
  const r = await boot({ PRODUCT_CODES_JSON: VALID });
  assert.equal(r.code, 'LISTENING', r.out);
  assert.match(r.out, /store config OK/i, r.out);
  assert.doesNotMatch(r.out, /refusing to start/i);
});
