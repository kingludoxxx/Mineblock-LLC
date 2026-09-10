// STORE CONFIG — unit tests for server/src/config/storeConfig.js.
//
// Every value is read at CALL time from process.env (R7), never at import, so
// each test sets the env it needs and calls the getter. Unset / malformed env
// fails CLOSED (null / [] / default) with ONE warning per key, never a
// wrong-store literal (R5, R15). Secrets never appear in snapshot().
//
// Run:  node server/tests/store-config/store-config.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../src/config/storeConfig.js');
const sc = mod.default;

const ENV_KEYS = [
  'STORE_CODE', 'BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_LOGO_WHITE', 'BRAND_LOGO_SYMBOL',
  'BRAND_LOGO_BLACK', 'BRAND_EMAIL_DOMAIN',
  'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_API_VERSION', 'WHOP_COMPANY_ID', 'TRIPLEWHALE_SHOP_ID',
  'META_API_VERSION', 'FRAMEIO_TOKEN', 'FRAME_IO_TOKEN', 'FRAMEIO_API_TOKEN', 'REPORT_TZ',
  'SHOPIFY_STORE_URL', 'META_AD_ACCOUNTS_JSON', 'SLACK_PNL_CHANNEL', 'SLACK_KPI_CHANNEL',
  'SLACK_REJECTION_CHANNEL', 'SLACK_EDITOR_CHANNELS_JSON', 'PRODUCT_CODES_JSON',
  'CLICKUP_MB_VIDEO_LIST_ID', 'CLICKUP_PUURE_VIDEO_LIST_ID', 'FRAMEIO_MB_PROJECT_ID',
  'FRAMEIO_MB_EDITING_FOLDER', 'FRAMEIO_PUURE_PROJECT_ID', 'FRAMEIO_PUURE_EDITING_FOLDER',
  'FRAMEIO_P1_PROJECT_ID', 'FRAMEIO_P1_EDITING_FOLDER', 'CLICKUP_P1_PRODUCT_ID',
];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  sc.resetWarnings();
}
function captureWarnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return seen;
}

// ── item 1: seam + brand + snapshot ─────────────────────────────────────────
test('reads at call time, not import time (R7)', () => {
  clearEnv();
  assert.equal(sc.brand().name, null);
  process.env.BRAND_NAME = 'Acme Co';
  assert.equal(sc.brand().name, 'Acme Co');
});

test('brand(): unset keys are null, never a literal default (R15)', () => {
  clearEnv();
  const b = sc.brand();
  assert.deepEqual(b, { name: null, shortName: null, logoWhite: null, logoSymbol: null, logoBlack: null, emailDomain: null });
});

test('brand(): all six BRAND_* keys map through', () => {
  clearEnv();
  Object.assign(process.env, {
    BRAND_NAME: 'Acme Co', BRAND_SHORT_NAME: 'Acme', BRAND_LOGO_WHITE: '/w.png',
    BRAND_LOGO_SYMBOL: '/s.png', BRAND_LOGO_BLACK: '/b.svg', BRAND_EMAIL_DOMAIN: 'acme.example',
  });
  assert.deepEqual(sc.brand(), {
    name: 'Acme Co', shortName: 'Acme', logoWhite: '/w.png', logoSymbol: '/s.png', logoBlack: '/b.svg', emailDomain: 'acme.example',
  });
});

test('manifest adapter seam overrides env per key and can be removed', () => {
  clearEnv();
  process.env.BRAND_NAME = 'From Env';
  sc.setStoreConfigSource((key) => (key === 'BRAND_NAME' ? 'From Manifest' : undefined));
  try {
    assert.equal(sc.brand().name, 'From Manifest');
  } finally {
    sc.setStoreConfigSource(null);
  }
  assert.equal(sc.brand().name, 'From Env');
});

test('setStoreConfigSource rejects a non-function', () => {
  assert.throws(() => sc.setStoreConfigSource('nope'), /function/);
});

test('snapshot(): contains no secret-named key and no secret value', () => {
  clearEnv();
  process.env.FRAMEIO_TOKEN = 'frameio-secret-value-123';
  process.env.BRAND_NAME = 'Acme Co';
  const snap = sc.snapshot();
  const text = JSON.stringify(snap);
  assert.ok(!/frameio-secret-value-123/.test(text), 'token value leaked into snapshot');
  const keys = [];
  (function walk(o) { for (const [k, v] of Object.entries(o || {})) { keys.push(k); if (v && typeof v === 'object') walk(v); } })(snap);
  const bad = keys.filter((k) => /token|secret|password|apikey|api_key/i.test(k));
  assert.deepEqual(bad, [], `secret-named keys in snapshot: ${bad}`);
  assert.equal(snap.brand.name, 'Acme Co');
  assert.equal(snap.storeCode, null);
});

test('storeCode(): STORE_CODE upper-cased, unset → null with one warning', () => {
  clearEnv();
  const w = captureWarnings(() => { sc.storeCode(); sc.storeCode(); });
  assert.equal(w.length, 1, `expected exactly one warning, got ${w.length}: ${w}`);
  assert.match(w[0], /STORE_CODE/);
  process.env.STORE_CODE = 'pl';
  assert.equal(sc.storeCode(), 'PL');
});

// ── the remaining items append their tests below as they land ────────────────

// ── item 2: Shopify domain / API version / Whop company id ──────────────────
test('shopifyStoreDomain(): unset → null with ONE warning; set → value', () => {
  clearEnv();
  const w = captureWarnings(() => { assert.equal(sc.shopifyStoreDomain(), null); sc.shopifyStoreDomain(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /SHOPIFY_STORE_DOMAIN/);
  process.env.SHOPIFY_STORE_DOMAIN = 'zz-store.myshopify.com';
  assert.equal(sc.shopifyStoreDomain(), 'zz-store.myshopify.com');
});

test('shopifyApiVersion(): the ONE default is 2024-01; malformed → default + one warning', () => {
  clearEnv();
  assert.equal(sc.shopifyApiVersion(), '2024-01');
  process.env.SHOPIFY_API_VERSION = '2025-07';
  assert.equal(sc.shopifyApiVersion(), '2025-07');
  // MALFORMED is a misconfiguration to REFUSE (null), never repaired into a
  // path — the shopify-import contract (clone-page/shopify-import.mjs n1).
  for (const bad of ['latest', '2024-1', '2024-01/../../orders', '../admin', '2024-01 ']) {
    process.env.SHOPIFY_API_VERSION = bad;
    assert.equal(sc.shopifyApiVersion(), null, JSON.stringify(bad));
  }
  sc.resetWarnings();
  process.env.SHOPIFY_API_VERSION = 'latest';
  const w = captureWarnings(() => { sc.shopifyApiVersion(); sc.shopifyApiVersion(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /SHOPIFY_API_VERSION/);
});

test('whopCompanyId(): unset → null with one warning; set → value', () => {
  clearEnv();
  const w = captureWarnings(() => { assert.equal(sc.whopCompanyId(), null); });
  assert.equal(w.length, 1, String(w));
  process.env.WHOP_COMPANY_ID = 'biz_test';
  assert.equal(sc.whopCompanyId(), 'biz_test');
});

test('snapshot() carries shopify.apiVersion and whop.companyId', () => {
  clearEnv();
  process.env.WHOP_COMPANY_ID = 'biz_test';
  const s = sc.snapshot();
  assert.equal(s.shopify.apiVersion, '2024-01');
  assert.equal(s.whop.companyId, 'biz_test');
});

// ── item 3: Triple Whale shop id ────────────────────────────────────────────
test('tripleWhaleShopId(): NO literal default; unset → null + ONE warning; set → value', () => {
  clearEnv();
  const w = captureWarnings(() => { assert.equal(sc.tripleWhaleShopId(), null); sc.tripleWhaleShopId(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /TRIPLEWHALE_SHOP_ID/);
  assert.match(w[0], /dormant/);
  process.env.TRIPLEWHALE_SHOP_ID = 'zz-store.myshopify.com';
  assert.equal(sc.tripleWhaleShopId(), 'zz-store.myshopify.com');
  assert.equal(sc.snapshot().tripleWhale.shopId, 'zz-store.myshopify.com');
});

// ── item 5: Meta Graph API version ──────────────────────────────────────────
test('metaApiVersion(): the ONE default is v21.0; malformed → default + one warning; metaGraphUrl() composes it', () => {
  clearEnv();
  assert.equal(sc.metaApiVersion(), 'v21.0');
  assert.equal(sc.metaGraphUrl(), 'https://graph.facebook.com/v21.0');
  process.env.META_API_VERSION = 'v23.0';
  assert.equal(sc.metaApiVersion(), 'v23.0');
  assert.equal(sc.metaGraphUrl(), 'https://graph.facebook.com/v23.0');
  assert.equal(sc.snapshot().meta.apiVersion, 'v23.0');
  process.env.META_API_VERSION = '23';
  const w = captureWarnings(() => { assert.equal(sc.metaApiVersion(), 'v21.0'); sc.metaApiVersion(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /META_API_VERSION/);
});

// ── item 6: Frame.io token — ONE read, legacy names accepted for one release ─
test('frameioToken(): FRAMEIO_TOKEN is canonical; unset → "" with one warning; never in snapshot', () => {
  clearEnv();
  const w = captureWarnings(() => { assert.equal(sc.frameioToken(), ''); sc.frameioToken(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /FRAMEIO_TOKEN/);
  process.env.FRAMEIO_TOKEN = 'tok-canonical';
  assert.equal(sc.frameioToken(), 'tok-canonical');
  assert.ok(!JSON.stringify(sc.snapshot()).includes('tok-canonical'));
});
test('frameioToken(): FRAME_IO_TOKEN / FRAMEIO_API_TOKEN still work, each with ONE deprecation warning; canonical wins', () => {
  clearEnv();
  process.env.FRAME_IO_TOKEN = 'tok-legacy-1';
  let w = captureWarnings(() => { assert.equal(sc.frameioToken(), 'tok-legacy-1'); sc.frameioToken(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /FRAME_IO_TOKEN.*deprecated/i);
  clearEnv();
  process.env.FRAMEIO_API_TOKEN = 'tok-legacy-2';
  w = captureWarnings(() => { assert.equal(sc.frameioToken(), 'tok-legacy-2'); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /FRAMEIO_API_TOKEN.*deprecated/i);
  process.env.FRAMEIO_TOKEN = 'tok-canonical';
  w = captureWarnings(() => { assert.equal(sc.frameioToken(), 'tok-canonical'); });
  assert.equal(w.length, 0, String(w));
});

// ── item 7: report timezone — the ONE read site ─────────────────────────────
test('timezone(): REPORT_TZ default Europe/Madrid; set → value; invalid IANA → throws naming the key (fail closed)', () => {
  clearEnv();
  assert.equal(sc.timezone(), 'Europe/Madrid');
  process.env.REPORT_TZ = ' America/New_York ';
  assert.equal(sc.timezone(), 'America/New_York');
  assert.equal(sc.snapshot().timezone, 'America/New_York');
  process.env.REPORT_TZ = 'Mars/Olympus';
  assert.throws(() => sc.timezone(), /REPORT_TZ 'Mars\/Olympus' is not a valid IANA timezone/);
});

// ── item 8: store public URL — no literal fallback ──────────────────────────
test('shopifyStoreUrl(): unset → null + one warning; set → value; snapshot carries it', () => {
  clearEnv();
  const w = captureWarnings(() => { assert.equal(sc.shopifyStoreUrl(), null); sc.shopifyStoreUrl(); });
  assert.equal(w.length, 1, String(w));
  assert.match(w[0], /SHOPIFY_STORE_URL/);
  process.env.SHOPIFY_STORE_URL = 'https://zz.example';
  assert.equal(sc.shopifyStoreUrl(), 'https://zz.example');
  assert.equal(sc.snapshot().shopify.storeUrl, 'https://zz.example');
});

// ── item 9: Meta ad accounts from META_AD_ACCOUNTS_JSON ─────────────────────
test('adAccounts(): unset → [] + one warning; malformed JSON → [] + one warning; wrong shape → [] + one warning', () => {
  clearEnv();
  let w = captureWarnings(() => { assert.deepEqual(sc.adAccounts(), []); sc.adAccounts(); });
  assert.equal(w.length, 1, String(w)); assert.match(w[0], /META_AD_ACCOUNTS_JSON/);
  clearEnv(); process.env.META_AD_ACCOUNTS_JSON = '{not json';
  w = captureWarnings(() => { assert.deepEqual(sc.adAccounts(), []); sc.adAccounts(); });
  assert.equal(w.length, 1, String(w)); assert.match(w[0], /META_AD_ACCOUNTS_JSON/);
  clearEnv(); process.env.META_AD_ACCOUNTS_JSON = '{"id":"act_1","name":"x"}'; // object, not array
  w = captureWarnings(() => { assert.deepEqual(sc.adAccounts(), []); });
  assert.equal(w.length, 1, String(w));
  clearEnv(); process.env.META_AD_ACCOUNTS_JSON = '[{"id":"1","name":"x"}]'; // id must be act_<digits>
  w = captureWarnings(() => { assert.deepEqual(sc.adAccounts(), []); });
  assert.equal(w.length, 1, String(w)); assert.match(w[0], /act_/);
});
test('adAccounts(): valid → [{id,name}] verbatim; adAccountNames() map; adAccountName() falls back to the id; snapshot carries them', () => {
  clearEnv();
  process.env.META_AD_ACCOUNTS_JSON = '[{"id":"act_11","name":"Store X8"},{"id":"act_22","name":"Store CC 4"}]';
  const w = captureWarnings(() => {
    assert.deepEqual(sc.adAccounts(), [{ id: 'act_11', name: 'Store X8' }, { id: 'act_22', name: 'Store CC 4' }]);
    assert.deepEqual(sc.adAccountNames(), { act_11: 'Store X8', act_22: 'Store CC 4' });
    assert.equal(sc.adAccountName('act_22'), 'Store CC 4');
    assert.equal(sc.adAccountName('act_99'), 'act_99');
  });
  assert.equal(w.length, 0, String(w));
  assert.deepEqual(sc.snapshot().meta.adAccounts, [{ id: 'act_11', name: 'Store X8' }, { id: 'act_22', name: 'Store CC 4' }]);
});

// ── item 10: Slack channels ─────────────────────────────────────────────────
test('slackChannels(): unset → nulls / {} with ONE warning per key; set → values; editors map validated', () => {
  clearEnv();
  let w = captureWarnings(() => {
    assert.deepEqual(sc.slackChannels(), { pnl: null, kpi: null, rejection: null, editors: {} });
    sc.slackChannels();
  });
  assert.equal(w.length, 4, String(w)); // one per key, once
  clearEnv();
  Object.assign(process.env, { SLACK_PNL_CHANNEL: 'C0PNL', SLACK_KPI_CHANNEL: 'C0KPI', SLACK_REJECTION_CHANNEL: 'C0REJ', SLACK_EDITOR_CHANNELS_JSON: '{"Ann":"C0ANN","Bob":"C0BOB"}' });
  w = captureWarnings(() => {
    assert.deepEqual(sc.slackChannels(), { pnl: 'C0PNL', kpi: 'C0KPI', rejection: 'C0REJ', editors: { Ann: 'C0ANN', Bob: 'C0BOB' } });
  });
  assert.equal(w.length, 0, String(w));
  assert.deepEqual(sc.snapshot().slack, { pnl: 'C0PNL', kpi: 'C0KPI', rejection: 'C0REJ', editors: { Ann: 'C0ANN', Bob: 'C0BOB' } });
  process.env.SLACK_EDITOR_CHANNELS_JSON = '["C0ANN"]'; // not an object of strings
  w = captureWarnings(() => { assert.deepEqual(sc.slackChannels().editors, {}); sc.slackChannels(); });
  assert.equal(w.length, 1, String(w)); assert.match(w[0], /SLACK_EDITOR_CHANNELS_JSON/);
  process.env.SLACK_EDITOR_CHANNELS_JSON = '{bad';
  sc.resetWarnings();
  w = captureWarnings(() => { assert.deepEqual(sc.slackChannels().editors, {}); });
  assert.equal(w.length, 1, String(w));
});
