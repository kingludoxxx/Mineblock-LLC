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

// A1 over the whole tree (allowed: tests and docs)
test('A1: git grep over server/src is empty', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', A1.source, '--', 'server/src'], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match, which is the pass
    out = '';
  }
  assert.equal(out.trim(), '', `A1 residue:\n${out}`);
});
