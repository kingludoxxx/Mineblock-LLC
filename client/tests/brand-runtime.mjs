// ITEM 12 — client/src/config/brand.js reads the brand at RUNTIME from
// GET /api/v1/brand, keeping the build-time (VITE_BRAND_*) value as the
// fallback for every field the server leaves null, and for a failed fetch.
//
// Runs under plain Node: import.meta.env is undefined here (Vite injects it),
// so the module must tolerate that; fetch is mocked per scenario.
//
// Run:  node client/tests/brand-runtime.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD = new URL('../src/config/brand.js', import.meta.url).href;
let n = 0;
const fresh = () => import(`${MOD}?v=${++n}`); // cache-bust so each scenario re-runs the module

test('no fetch / fetch rejects → build-time fallbacks stay (name, short, logos, email domain)', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const b = await fresh();
  await b.brandReady;
  assert.equal(b.BRAND_NAME, 'Mineblock LLC');
  assert.equal(b.BRAND_SHORT_NAME, 'Mineblock');
  assert.equal(b.BRAND_LOGO_WHITE, '/logo-white.png');
  assert.equal(b.BRAND_EMAIL_DOMAIN, 'mineblock.com');
  assert.equal(b.getBrand().name, 'Mineblock LLC');
  assert.equal(b.getBrand().source, 'build');
});

test('server answers → live bindings and getBrand() switch to the runtime values; null fields keep the fallback', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/v1\/brand$/);
    return { ok: true, json: async () => ({ success: true, data: { name: 'Acme Co', shortName: 'Acme', logoWhite: '/w.png', logoSymbol: null, logoBlack: '/b.svg', emailDomain: 'acme.example' } }) };
  };
  const b = await fresh();
  await b.brandReady;
  assert.equal(b.BRAND_NAME, 'Acme Co');
  assert.equal(b.BRAND_SHORT_NAME, 'Acme');
  assert.equal(b.BRAND_LOGO_WHITE, '/w.png');
  assert.equal(b.BRAND_LOGO_SYMBOL, '/logo-symbol-white.png', 'null from the server → build-time fallback');
  assert.equal(b.BRAND_LOGO_BLACK, '/b.svg');
  assert.equal(b.BRAND_EMAIL_DOMAIN, 'acme.example');
  assert.deepEqual(b.getBrand(), { name: 'Acme Co', shortName: 'Acme', logoWhite: '/w.png', logoSymbol: '/logo-symbol-white.png', logoBlack: '/b.svg', emailDomain: 'acme.example', source: 'runtime' });
});

test('non-200, malformed body, or a value that is not a string → fallbacks; nothing throws', async () => {
  for (const resp of [
    { ok: false, status: 500, json: async () => ({}) },
    { ok: true, json: async () => 'not-an-object' },
    { ok: true, json: async () => ({ success: true, data: { name: 42, shortName: ['x'], emailDomain: '' } }) },
  ]) {
    globalThis.fetch = async () => resp;
    const b = await fresh();
    await b.brandReady;
    assert.equal(b.BRAND_NAME, 'Mineblock LLC');
    assert.equal(b.BRAND_SHORT_NAME, 'Mineblock');
    assert.equal(b.BRAND_EMAIL_DOMAIN, 'mineblock.com');
  }
});

test('subscribers are notified once with the resolved brand — whether they subscribe before or after it resolved', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { name: 'Acme Co' } }) });
  const b = await fresh();
  const early = [];
  const offEarly = b.onBrand((brand) => early.push(brand.name));
  await b.brandReady;
  const late = [];
  const offLate = b.onBrand((brand) => late.push(brand.name));
  offEarly(); offLate();
  assert.deepEqual(early, ['Acme Co']);
  assert.deepEqual(late, ['Acme Co'], 'a late subscriber is replayed the resolved brand');
  assert.equal(b.getBrand().source, 'runtime');
});
