// A2 — with env set to today's PL and MB values (server/config/env.{PL,MB}.example)
// storeConfig.snapshot() equals the checked-in snapshot per store
// (server/tests/store-config/snapshots/{PL,MB}.json).
//
// The example files must carry NO secret (asserted), and the snapshot must
// carry none either (the routes test scans the same object over HTTP).
//
// Run:  node server/tests/store-config/snapshot.mjs           (compare)
//       node server/tests/store-config/snapshot.mjs --write   (regenerate, then review the diff)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const WRITE = process.argv.includes('--write');
const sc = (await import('../../src/config/storeConfig.js')).default;

const ALL_KEYS = ['STORE_CODE', 'BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_LOGO_WHITE', 'BRAND_LOGO_SYMBOL', 'BRAND_LOGO_BLACK', 'BRAND_EMAIL_DOMAIN',
  'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_STORE_URL', 'SHOPIFY_API_VERSION', 'WHOP_COMPANY_ID', 'TRIPLEWHALE_SHOP_ID', 'META_API_VERSION', 'META_AD_ACCOUNTS_JSON',
  'SLACK_PNL_CHANNEL', 'SLACK_KPI_CHANNEL', 'SLACK_REJECTION_CHANNEL', 'SLACK_EDITOR_CHANNELS_JSON', 'REPORT_TZ', 'PRODUCT_CODES_JSON',
  'FRAMEIO_TOKEN', 'FRAME_IO_TOKEN', 'FRAMEIO_API_TOKEN'];

for (const store of ['PL', 'MB']) {
  test(`A2 ${store}: env.${store}.example → snapshot equals snapshots/${store}.json and carries no secret`, () => {
    const text = readFileSync(join(REPO, 'server/config', `env.${store}.example`), 'utf8');
    const secretLines = text.split('\n').filter((l) => /^[A-Z_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z_]*=.+/.test(l));
    assert.deepEqual(secretLines, [], `env.${store}.example carries a secret value`);
    const parsed = dotenv.parse(text);
    for (const k of ALL_KEYS) delete process.env[k];
    Object.assign(process.env, parsed);
    sc.resetWarnings();
    const snap = sc.snapshot();
    assert.equal(snap.storeCode, store);
    const file = join(HERE, 'snapshots', `${store}.json`);
    if (WRITE) { writeFileSync(file, JSON.stringify(snap, null, 2) + '\n'); return; }
    const expected = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(snap, expected, `snapshot for ${store} drifted from snapshots/${store}.json`);
    // the two stores never share a store-identifying value
  });
}

test('A2: PL and MB snapshots do not share any store-identifying value', () => {
  const pl = JSON.parse(readFileSync(join(HERE, 'snapshots', 'PL.json'), 'utf8'));
  const mb = JSON.parse(readFileSync(join(HERE, 'snapshots', 'MB.json'), 'utf8'));
  assert.notEqual(pl.shopify.storeDomain, mb.shopify.storeDomain);
  assert.notEqual(pl.shopify.storeUrl, mb.shopify.storeUrl);
  assert.notEqual(pl.brand.name, mb.brand.name);
  assert.ok(pl.tripleWhale.shopId === null || pl.tripleWhale.shopId !== mb.tripleWhale.shopId);
  assert.ok(pl.slack.pnl === null || pl.slack.pnl !== mb.slack.pnl);
});
