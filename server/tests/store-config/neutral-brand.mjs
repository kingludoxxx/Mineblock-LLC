#!/usr/bin/env node
// W8a — A BRAND-NEW STORE MUST NOT WEAR ANOTHER STORE'S NAME OR LOGO.
//
// Found in a real browser on the Throwaway store (TW): the provisioner sets
// BRAND_NAME / BRAND_SHORT_NAME / BRAND_EMAIL_DOMAIN on the new dashboard
// service and no logo urls, so GET /api/v1/brand answers logoWhite:null — and
// client/src/config/brand.js then fell back, per field, to the build-time
// FALLBACK, whose defaults were one particular store's name and one particular
// store's bundled images. A store called "Throwaway" rendered Mineblock's
// wordmark in its own sidebar (R5/R15: store identity is data, not a build).
//
// This file is the regression test for BOTH halves of that:
//   B1  the build-time FALLBACK carries no store at all
//   B2  the runtime path still wins, and a runtime logo is still honoured
//   B3  the VITE_BRAND_* build path is intact (a store that HAS images keeps them)
//   B4  R15 grep over the three files the shell renders the brand from, with a
//       positive control that proves the grep can bite
//   B5  GET /api/v1/brand's contract is unchanged: the same six keys, all null
//       when the env is unset, no default invented on the server
//
// Run:  node server/tests/store-config/neutral-brand.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

// The files that decide what the shell paints as "this store".
const BRAND_FILES = [
  'client/src/config/brand.js',
  'client/src/components/layout/StoreSwitcher.jsx',
  'client/src/components/layout/Sidebar.jsx',
];

// Store-owned literals. Every one of these is a value that belongs in a
// store's OWN env, never in engine code: the two historical names and the two
// bundled image paths the FALLBACK pointed at.
const STORE_LITERALS = /Mineblock|mineblock|Puure|puure|\/logo-white\.png|\/logo-symbol-white\.png|\/logo-black\.svg/;

// brand.js runs a fetch('/api/v1/brand') at import. In node that relative url
// throws inside the module's own try/catch, so the import resolves with the
// build-time values and nothing leaves the machine (there is no server here).
const brand = await import(new URL('../../../client/src/config/brand.js', import.meta.url));

// ── B1 the build-time fallback names nobody ────────────────────────────────
test('B1: the build-time brand carries a neutral name and NO logo', () => {
  const b = brand.getBrand();
  assert.equal(b.source, 'build', 'the runtime read must not have succeeded in this process');
  assert.doesNotMatch(b.name, STORE_LITERALS, `FALLBACK.name is a store: ${b.name}`);
  assert.doesNotMatch(b.shortName, STORE_LITERALS, `FALLBACK.shortName is a store: ${b.shortName}`);
  assert.doesNotMatch(b.emailDomain, STORE_LITERALS, `FALLBACK.emailDomain is a store: ${b.emailDomain}`);
  assert.equal(b.logoWhite, null, `FALLBACK.logoWhite must be null, got ${b.logoWhite}`);
  assert.equal(b.logoSymbol, null, `FALLBACK.logoSymbol must be null, got ${b.logoSymbol}`);
  assert.equal(b.logoBlack, null, `FALLBACK.logoBlack must be null, got ${b.logoBlack}`);
  // the named exports are the live bindings the components read
  assert.equal(brand.BRAND_LOGO_WHITE, null);
  assert.equal(brand.BRAND_LOGO_SYMBOL, null);
  assert.doesNotMatch(brand.BRAND_SHORT_NAME, STORE_LITERALS);
});

test('B1b: the neutral name is a placeholder, not an empty string', () => {
  const b = brand.getBrand();
  assert.equal(typeof b.shortName, 'string');
  assert.ok(b.shortName.trim().length > 0, 'an empty short name would paint an empty wordmark');
});

// ── B2 the runtime answer still wins, per field ────────────────────────────
test('B2: a runtime brand with a logo is honoured; a null field keeps the neutral default', async () => {
  const mod = await import(`../../../client/src/config/brand.js?b2=${Date.now()}`);
  mod.applyBrand({ name: 'Throwaway Ltd', shortName: 'Throwaway', logoWhite: null, logoSymbol: null, logoBlack: null, emailDomain: 'throwaway.test' });
  assert.equal(mod.BRAND_SHORT_NAME, 'Throwaway');
  assert.equal(mod.BRAND_NAME, 'Throwaway Ltd');
  assert.equal(mod.BRAND_LOGO_WHITE, null, 'a store with no logo url must stay logo-less, never inherit one');

  mod.applyBrand({ name: 'Other Co', shortName: 'Other', logoWhite: '/x/other.png', logoSymbol: '/x/other-sym.png', logoBlack: null, emailDomain: null });
  assert.equal(mod.BRAND_LOGO_WHITE, '/x/other.png');
  assert.equal(mod.BRAND_LOGO_SYMBOL, '/x/other-sym.png');
  assert.equal(mod.BRAND_LOGO_BLACK, null);
  assert.equal(mod.getBrand().source, 'runtime');
});

// ── B3 the VITE_BRAND_* build path is still the way a store ships images ───
test('B3: every brand field still reads its VITE_BRAND_* build env before the neutral default', () => {
  const s = read('client/src/config/brand.js');
  for (const key of ['VITE_BRAND_NAME', 'VITE_BRAND_SHORT_NAME', 'VITE_BRAND_LOGO_WHITE', 'VITE_BRAND_LOGO_SYMBOL', 'VITE_BRAND_LOGO_BLACK', 'VITE_BRAND_EMAIL_DOMAIN']) {
    assert.match(s, new RegExp(`env\\.${key}\\s*\\|\\|`), `${key} is no longer read from the build env — mineblock-dashboard / puure-dashboard set these`);
  }
});

// ── B4 R15 over the three files the shell paints the brand from ────────────
test('B4: no store name or bundled logo path in the brand engine files', () => {
  const offenders = [];
  for (const f of BRAND_FILES) {
    read(f).split('\n').forEach((line, i) => {
      if (STORE_LITERALS.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `R15: a store literal survives in the brand engine files:\n${offenders.join('\n')}`);
});

test('B4b: POSITIVE CONTROL — the same grep bites on a line that does carry a store', () => {
  const bait = [
    "  logoWhite:   env.VITE_BRAND_LOGO_WHITE   || '/logo-white.png',",
    "  shortName:   env.VITE_BRAND_SHORT_NAME   || 'Mineblock',",
  ];
  const caught = bait.filter((l) => STORE_LITERALS.test(l));
  assert.equal(caught.length, bait.length, 'the R15 grep cannot see the very lines this lane removed — it proves nothing');
});

test('B4c: git grep agrees (the reviewer runs this, not the array above)', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', STORE_LITERALS.source, '--', ...BRAND_FILES], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;   // 1 = no match
    out = '';
  }
  assert.equal(out.trim(), '', `git grep found a store literal:\n${out}`);
});

// ── B5 the server contract is untouched ────────────────────────────────────
test('B5: GET /api/v1/brand answers the same six keys, all null with no env, no default invented server-side', async () => {
  for (const k of ['BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_LOGO_WHITE', 'BRAND_LOGO_SYMBOL', 'BRAND_LOGO_BLACK', 'BRAND_EMAIL_DOMAIN']) delete process.env[k];
  const storeConfig = await import('../../src/config/storeConfig.js');
  const b = storeConfig.brand();
  assert.deepEqual(Object.keys(b).sort(), ['emailDomain', 'logoBlack', 'logoSymbol', 'logoWhite', 'name', 'shortName']);
  assert.deepEqual(Object.values(b), [null, null, null, null, null, null], 'the server must invent no brand default (that would be a store literal in engine code)');
  process.env.BRAND_SHORT_NAME = 'Throwaway';
  process.env.BRAND_LOGO_WHITE = '/x/tw.png';
  assert.equal(storeConfig.brand().shortName, 'Throwaway', 'R7: read at request time');
  assert.equal(storeConfig.brand().logoWhite, '/x/tw.png');
  delete process.env.BRAND_SHORT_NAME; delete process.env.BRAND_LOGO_WHITE;
});
