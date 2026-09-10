// WIRING — the A1 acceptance grep, per file, as a test. A literal that creeps
// back into server/src fails here before the reviewer's grep does. Each item's
// files are listed with the literals it removed; the final assertion runs the
// full A1 pattern over server/src (comments included — a comment that names a
// store domain still fails the reviewer's grep).
//
// Run:  node server/tests/store-config/wiring.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = (p) => readFileSync(join(REPO, 'server/src', p), 'utf8');
const A1 = /17cca0-2|9jn59g-x7|2024-01|act_[0-9]+|C0AF724MJPR|C0AN0BPN0NA|C0ANNMMPUCC|C0ARP2SBQ8J|mineblock\.co|123yxuahe91|b664289d|10abecc4/;

// item 2
test('kpiSystem.js reads store domain / API version / Whop company id from storeConfig', () => {
  const s = src('routes/kpiSystem.js');
  assert.match(s, /from '\.\.\/config\/storeConfig\.js'/);
  assert.doesNotMatch(s, /17cca0-2|biz_pkN7XmNrvouslh|'2024-01'/);
});
test('shopifyWebhook.js reads store domain / API version from storeConfig', () => {
  const s = src('routes/shopifyWebhook.js');
  assert.match(s, /from '\.\.\/config\/storeConfig\.js'/);
  assert.doesNotMatch(s, /17cca0-2|'2024-01'/);
});

// item 3
for (const f of ['config/env.js', 'routes/adsControlCenter.js', 'routes/adsReporting.js', 'routes/creativeAnalysis.js', 'routes/creativeIntel.js', 'routes/staticsGeneration.js']) {
  test(`${f}: Triple Whale shop id has no literal default and comes from storeConfig`, () => {
    const s = src(f);
    assert.doesNotMatch(s, /TRIPLEWHALE_SHOP_ID\s*\|\|/, 'legacy `TRIPLEWHALE_SHOP_ID || literal` read survives');
    assert.doesNotMatch(s, /17cca0-2/);
    if (f !== 'config/env.js') assert.match(s, /storeConfig\.tripleWhaleShopId\(\)/);
  });
}

// item 4
for (const f of ['routes/abandonedCheckouts.js', 'routes/funnelCommerce.js', 'routes/orders.js', 'routes/shopifyPages.js', 'routes/shopifyVariants.js', 'services/checkoutDiscount.js', 'services/checkoutPricing.js', 'services/mediaService.js', 'services/shopifyOrderCreate.js']) {
  test(`${f}: Shopify API version comes from storeConfig, no '2024-01' fallback`, () => {
    const s = src(f);
    assert.doesNotMatch(s, /SHOPIFY_API_VERSION\s*\|\|/, 'legacy `SHOPIFY_API_VERSION || literal` read survives');
    assert.doesNotMatch(s, /2024-01/);
    assert.match(s, /storeConfig\.shopifyApiVersion\(\)/);
  });
}
test('the Shopify API version default exists in exactly ONE place (storeConfig)', () => {
  let out = '';
  try { out = execFileSync('git', ['grep', '-n', "'2024-01'", '--', 'server/src'], { cwd: REPO, encoding: 'utf8' }); } catch (e) { if (e.status !== 1) throw e; }
  const lines = out.trim().split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['server/src/config/storeConfig.js'], out);
});

// item 5
for (const f of ['routes/adLauncher.js', 'routes/adRejectionMonitor.js', 'routes/adsControlCenter.js', 'routes/briefPipeline.js', 'routes/creativeAnalysis.js', 'routes/kpiSystem.js', 'routes/metaWebhook.js', 'routes/videoAdsLauncher.js', 'routes/adsReporting.js', 'services/funnelSpend.js', 'services/metaAdsApi.js']) {
  test(`${f}: no pinned graph.facebook.com/vNN literal; version comes from storeConfig`, () => {
    const s = src(f);
    assert.doesNotMatch(s, /graph\.facebook\.com\/v\d/);
    assert.match(s, /storeConfig\.metaGraphUrl\(\)/);
  });
}
test('routes/staticsGeneration.js:4592 (the v23.0 refresh) reads storeConfig; other pins are out of this lane', () => {
  const s = src('routes/staticsGeneration.js');
  assert.doesNotMatch(s, /graph\.facebook\.com\/v23/);
  assert.match(s, /storeConfig\.metaGraphUrl\(\)/);
});
test('the Meta Graph host+version literal exists in exactly ONE place (storeConfig)', () => {
  let out = '';
  try { out = execFileSync('git', ['grep', '-nE', 'graph\\.facebook\\.com/v[0-9]', '--', 'server/src'], { cwd: REPO, encoding: 'utf8' }); } catch (e) { if (e.status !== 1) throw e; }
  const files = [...new Set(out.trim().split('\n').filter(Boolean).map((l) => l.split(':')[0]))];
  // staticsGeneration.js keeps three pins outside this lane's line budget (7191, 9742, 10300) — see docs/lanes/lane-f.md
  assert.deepEqual(files.filter((f) => !f.endsWith('staticsGeneration.js')), [], out);
});

// item 6
test('clickupWebhook.js and videoAdsLauncher.js read the Frame.io token through storeConfig only', () => {
  for (const f of ['routes/clickupWebhook.js', 'routes/videoAdsLauncher.js']) {
    const s = src(f);
    assert.doesNotMatch(s, /process\.env\.FRAME_?IO_(API_)?TOKEN/, `${f} reads a Frame.io token env directly`);
    assert.match(s, /storeConfig\.frameioToken\(\)/, f);
  }
});

// item 7
test('REPORT_TZ is read in exactly ONE place (storeConfig); reportTz.js and funnelMetrics.js delegate', () => {
  let out = '';
  try { out = execFileSync('git', ['grep', '-n', 'process.env.REPORT_TZ', '--', 'server/src'], { cwd: REPO, encoding: 'utf8' }); } catch (e) { if (e.status !== 1) throw e; }
  const files = [...new Set(out.trim().split('\n').filter(Boolean).map((l) => l.split(':')[0]))];
  assert.deepEqual(files, [], out);
  assert.match(src('services/reportTz.js'), /storeConfig\.timezone\(\)/);
  assert.match(src('services/funnelMetrics.js'), /storeConfig\.timezone\(\)/);
});

// item 8
test('adLauncher.js has no store-URL literal fallback and reads storeConfig.shopifyStoreUrl()', () => {
  const s = src('routes/adLauncher.js');
  assert.doesNotMatch(s, /mineblock\.co|example\.com|SHOPIFY_STORE_URL\s*\|\|/);
  assert.match(s, /storeConfig\.shopifyStoreUrl\(\)/);
});

// item 9
for (const f of ['routes/adsControlCenter.js', 'routes/adRejectionMonitor.js', 'routes/metaWebhook.js']) {
  test(`${f}: ad-account map comes from storeConfig; no act_<id> or brand-named account literal`, () => {
    const s = src(f);
    assert.doesNotMatch(s, /act_[0-9]+|Luvora/);
    assert.match(s, /storeConfig\.adAccountNames\(\)/);
  });
}

// item 10
for (const f of ['routes/kpiSystem.js', 'routes/adsControlCenter.js', 'routes/briefAgent.js']) {
  test(`${f}: Slack channel ids come from storeConfig.slackChannels(); no C0… literal`, () => {
    const s = src(f);
    assert.doesNotMatch(s, /C0[A-Z0-9]{8,}/);
    assert.match(s, /storeConfig\.slackChannels\(\)/);
  });
}

// item 11
test('briefPipeline.js: CLICKUP_PIPELINES map is gone; pipelineForProduct() resolves through storeConfig.productFor()', () => {
  const s = src('routes/briefPipeline.js');
  assert.doesNotMatch(s, /const CLICKUP_PIPELINES\s*=|c === 'PUURE' \|\| c === 'PL'|fbPage: 'Puure'/);
  assert.match(s, /storeConfig\.productFor\(/);
});
test('clickupWebhook.js: no Frame.io / ClickUp id literal defaults; product routing through storeConfig.productForClickupProductRef()', () => {
  const s = src('routes/clickupWebhook.js');
  assert.doesNotMatch(s, /123yxuahe91|b664289d|10abecc4|=== 'P1'/);
  assert.doesNotMatch(s, /process\.env\.(FRAMEIO_P1_[A-Z_]+|CLICKUP_P1_PRODUCT_ID)/);
  assert.match(s, /storeConfig\.productForClickupProductRef\(/);
});

// A1 over the whole tree (allowed: tests and docs).
//
// SANCTIONED: the one Shopify API-version default that item 4 mandates must
// live in exactly one place — storeConfig.js. KNOWN OUT-OF-LANE residue (files
// the Lane F brief does not allow this lane to touch) is pinned here so the
// lead sees it and a NEW leak still fails; remove a line when it is fixed:
const A1_SANCTIONED = [/^server\/src\/config\/storeConfig\.js:\d+:export const SHOPIFY_API_VERSION_DEFAULT = '2024-01';$/];
const A1_KNOWN_OUT_OF_LANE = [
  /^server\/src\/routes\/staticsGeneration\.js:\d+:\s*\/\/ SHOPIFY_STORE_URL is a REQUIRED per-brand env var \(Mineblock: https:\/\/mineblock\.co,$/, // comment; lane budget = :9352 + :4592 only
  /^server\/src\/services\/domainHub\/validate\.js:\d+:\s*'mineblock\.com',$/, // BLOCKED_SUFFIXES deny-list; not a Lane F file
];
test('A1: git grep over server/src is empty apart from the sanctioned default and the pinned out-of-lane residue', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', A1.source, '--', 'server/src'], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match
    out = '';
  }
  const lines = out.trim().split('\n').filter(Boolean);
  const unexplained = lines.filter((l) => ![...A1_SANCTIONED, ...A1_KNOWN_OUT_OF_LANE].some((re) => re.test(l)));
  assert.deepEqual(unexplained, [], `A1 residue not sanctioned:\n${unexplained.join('\n')}`);
  const missing = A1_KNOWN_OUT_OF_LANE.filter((re) => !lines.some((l) => re.test(l)));
  assert.deepEqual(missing, [], 'a pinned out-of-lane residue is gone — remove it from A1_KNOWN_OUT_OF_LANE');
});
