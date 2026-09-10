// LANE F2 — the remaining review fixes (REVIEW-LANE-F.md P1-2, P2-1, P2-3).
//
//  P1-2  META_API_VERSION default is v23.0 (the newest version already in the
//        tree), and the three Graph pins staticsGeneration.js still carried
//        (v21.0 / v22.0 / v21.0) read the config value instead.
//  P2-1  adsControlCenter.sendSlackAlert() must SKIP the post when the P&L
//        channel is unset, not POST {"channel": null} (Slack answers
//        200 {ok:false}, which the .catch() never sees).
//  P2-3  env.PL.example marks PL's own entry default:true, so an unknown
//        product code resolves to the store's OWN pipeline instead of throwing
//        mid-request. MB stays default MB.
//
// Run:  node server/tests/store-config/review-fixes.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

// adsControlCenter imports the router and (only with TW + Meta creds) starts a
// scheduler — neither is set here, so nothing is scheduled.
delete process.env.TRIPLEWHALE_API_KEY;
delete process.env.META_ACCESS_TOKEN;
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
const sc = (await import('../../src/config/storeConfig.js')).default;
const acc = await import('../../src/routes/adsControlCenter.js');

// ── P1-2: one Meta version, default v23.0, no literal left in server/src ────
test('metaApiVersion(): default is v23.0 (newest already in the tree, not the oldest)', () => {
  delete process.env.META_API_VERSION;
  sc.resetWarnings();
  assert.equal(sc.metaApiVersion(), 'v23.0');
  assert.equal(sc.metaGraphUrl(), 'https://graph.facebook.com/v23.0');
  process.env.META_API_VERSION = 'v22.0';
  assert.equal(sc.metaGraphUrl(), 'https://graph.facebook.com/v22.0', 'per-store override still wins');
  delete process.env.META_API_VERSION;
});

test('no hardcoded Graph API version remains anywhere in server/src', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', 'graph\\.facebook\\.com/v[0-9]', '--', 'server/src'], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    out = e.status === 1 ? '' : (() => { throw e; })();
  }
  assert.equal(out.trim(), '', `hardcoded Graph versions still in server/src:\n${out}`);
});

test('env.{PL,MB}.example both pin META_API_VERSION=v23.0', () => {
  for (const store of ['PL', 'MB']) {
    const parsed = dotenv.parse(readFileSync(join(REPO, 'server/config', `env.${store}.example`), 'utf8'));
    assert.equal(parsed.META_API_VERSION, 'v23.0', store);
  }
});

// ── P2-1: Slack post skipped when the channel is unset ─────────────────────
function withFetchStub(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}

const LOG_ENTRY = { action: 'pause_ad', ad_name: 'ad-1', rule_name: 'r', account_name: 'a', reason: 'x', execution_status: 'ok' };

test('sendSlackAlert(): P&L channel unset → NO Slack call (never {"channel": null})', async () => {
  delete process.env.SLACK_PNL_CHANNEL;
  sc.resetWarnings();
  await withFetchStub(async (calls) => {
    await acc.sendSlackAlert(LOG_ENTRY);
    assert.deepEqual(calls, [], 'a post was made with no channel configured');
  });
});

test('sendSlackAlert(): P&L channel set → exactly one call carrying that channel', async () => {
  process.env.SLACK_PNL_CHANNEL = 'C0TESTCHAN';
  sc.resetWarnings();
  await withFetchStub(async (calls) => {
    await acc.sendSlackAlert(LOG_ENTRY);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /chat\.postMessage/);
    assert.equal(calls[0].body.channel, 'C0TESTCHAN');
  });
  delete process.env.SLACK_PNL_CHANNEL;
});

// ── P2-3: PL has its own default product entry ─────────────────────────────
const EXAMPLE_KEYS = ['PRODUCT_CODES_JSON', 'STORE_CODE'];
function loadExample(store) {
  const parsed = dotenv.parse(readFileSync(join(REPO, 'server/config', `env.${store}.example`), 'utf8'));
  for (const k of EXAMPLE_KEYS) delete process.env[k];
  process.env.PRODUCT_CODES_JSON = parsed.PRODUCT_CODES_JSON;
  sc.resetWarnings();
  return parsed;
}

test('env.PL.example: PL is its OWN default — an unknown code resolves to PL, never to another store', () => {
  loadExample('PL');
  const codes = sc.productCodes();
  const def = sc.defaultProduct();
  assert.ok(def, 'PL example has no default product entry');
  assert.equal(def.code, 'PL');
  assert.equal(sc.productFor('MR').code, 'PL', 'unknown code must resolve to the store\'s own pipeline');
  assert.equal(Object.values(codes).filter((p) => p.default).length, 1);
  assert.ok(!Object.keys(codes).includes('MB'), 'PL must never carry the other store\'s pipeline');
});

test('env.MB.example: MB stays the default there', () => {
  loadExample('MB');
  assert.equal(sc.defaultProduct().code, 'MB');
  assert.equal(sc.productFor('MR').code, 'MB');
});

// briefPipeline.js:491 pipelineForProduct() throws only when productFor()
// returns null; with PL's own default entry it never does. The module itself
// is not imported here: it schedules a queue worker at import time.
test('the briefPipeline throw path is unreachable on PL: productFor() never returns null', () => {
  loadExample('PL');
  for (const code of ['MR', '', undefined, 'ZZZ', 'p1']) {
    assert.ok(sc.productFor(code), `productFor(${JSON.stringify(code)}) returned null`);
  }
});
