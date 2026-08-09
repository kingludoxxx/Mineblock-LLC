// Verification harness for the split UI's PURE guard logic (splitApi.js):
// armLiveUrl's sink guards, utcDay's UTC-day derivation, the quick-create
// handle bounds, and the fraction→percent invariant. These run the REAL file —
// node cannot resolve Vite's extensionless `../../../services/api` import, so
// the file is loaded with that single import stubbed (the guards under test
// never touch it).
//
//   node scripts/verifySplitUiGuards.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SRC = new URL('../client/src/components/funnels/split/splitApi.js', import.meta.url);
const code = readFileSync(SRC, 'utf8');
const stubbed = code.replace("import api from '../../../services/api';", 'const api = {};');
if (stubbed === code) {
  console.error('FATAL: api import line not found — the stub no longer matches splitApi.js');
  process.exit(1);
}
const tmpFile = join(mkdtempSync(join(tmpdir(), 'splitapi-')), 'splitApi.mjs');
writeFileSync(tmpFile, stubbed);
const {
  armLiveUrl, isSafeSlug, isSafeDomain, utcDay, isoDay,
  quickHandleFromSlug, randSuffix4, assertPercentScale, HANDLE_RE,
} = await import(pathToFileURL(tmpFile).href);

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// ── armLiveUrl — every branch, hostile inputs included ──────────────────────
const cases = [
  ['entry + custom domain', armLiveUrl({ isEntry: true, handle: 'offer-ab', domain: 'shop.trypuure.co' }), 'https://shop.trypuure.co/offer-ab'],
  // The app origin serves the handle UNDER the funnel path — a bare /{handle}
  // would hit the SPA fallback and render the dashboard, not the split.
  ['entry, no domain → funnel-scoped app path', armLiveUrl({ isEntry: true, handle: 'offer-ab', domain: '', funnelSlug: 'puure-main' }), '/f/puure-main/offer-ab'],
  ['entry, no domain, NO funnel slug → null (disabled)', armLiveUrl({ isEntry: true, handle: 'offer-ab', domain: '' }), null],
  ['entry, bad handle → null', armLiveUrl({ isEntry: true, handle: '../etc', domain: 'shop.trypuure.co' }), null],
  ['entry, bad funnel slug → null', armLiveUrl({ isEntry: true, handle: 'offer-ab', domain: '', funnelSlug: 'x/../y' }), null],
  ['variant + custom domain', armLiveUrl({ isEntry: false, domain: 'shop.trypuure.co', pageSlug: '/lead-b' }), 'https://shop.trypuure.co/lead-b'],
  ['variant, root slug + domain', armLiveUrl({ isEntry: false, domain: 'shop.trypuure.co', pageSlug: '/' }), 'https://shop.trypuure.co/'],
  ['variant, no domain → app path', armLiveUrl({ isEntry: false, domain: '', funnelSlug: 'puure-main', pageSlug: '/lead-b' }), '/f/puure-main/lead-b'],
  ['variant, bad slug → null', armLiveUrl({ isEntry: false, domain: '', funnelSlug: 'puure-main', pageSlug: '/a b<script>' }), null],
  ['variant, bad domain falls back to app path', armLiveUrl({ isEntry: false, domain: 'evil.com/..', pageSlug: '/x', funnelSlug: 'f' }), '/f/f/x'],
  ['variant, bad domain + no funnel slug → null', armLiveUrl({ isEntry: false, domain: 'javascript:alert(1)', pageSlug: '/x', funnelSlug: null }), null],
];
for (const [name, got, want] of cases) ok(got === want, `armLiveUrl: ${name}`, JSON.stringify(got));
ok(isSafeSlug('/') && !isSafeSlug('//x') && !isSafeSlug('x'), 'isSafeSlug bounds');
ok(isSafeDomain('trypuure.co') && !isSafeDomain('a//b') && !isSafeDomain('-x.co'), 'isSafeDomain bounds');

// ── utcDay — the 23:50Z fixture ─────────────────────────────────────────────
const FIX = '2026-08-08T23:50:00.000Z';
ok(utcDay(FIX) === '2026-08-08', 'utcDay: 23:50Z stays on its UTC day', utcDay(FIX));
ok(utcDay(new Date(FIX)) === '2026-08-08', 'utcDay: accepts a Date too');
ok(utcDay('garbage') === '' && utcDay(null) === '', 'utcDay: invalid input → empty, never NaN-day');
// The divergence utcDay exists to prevent, proven live wherever the ambient
// zone is ahead of UTC (CEST): the LOCAL day of that instant is the 9th.
if (new Date(FIX).getTimezoneOffset() < 0) {
  ok(isoDay(new Date(FIX)) === '2026-08-09', 'fixture: local day IS the next day here — the bug utcDay prevents', isoDay(new Date(FIX)));
} else {
  console.log('SKIP  local-day divergence proof (ambient zone not ahead of UTC)');
}

// ── quick-create handle bounds ──────────────────────────────────────────────
const longSlug = `/${'a'.repeat(120)}`;
const base = quickHandleFromSlug(longSlug);
ok(base.length <= 59, 'quickHandle: base+-ab ≤ 59 for an over-long slug', String(base.length));
ok(HANDLE_RE.test(base), 'quickHandle: base passes the handle charset', base);
ok(`${base}-${randSuffix4()}`.length <= 64, 'quickHandle: retry form stays ≤ 64 (server bound)', String(`${base}-xxxx`.length));
ok(HANDLE_RE.test(`${base}-${randSuffix4()}`), 'quickHandle: retry form passes the handle charset');
ok(quickHandleFromSlug('/Lead Page!') === 'page-ab', 'quickHandle: unusable slug degrades to page-ab', quickHandleFromSlug('/Lead Page!'));
ok(quickHandleFromSlug('/lead') === 'lead-ab', 'quickHandle: normal slug → <segment>-ab');
{
  let bad = 0;
  for (let i = 0; i < 500; i += 1) {
    const s = randSuffix4();
    if (!/^[0-9a-f]{4}$/.test(s)) bad += 1;
  }
  ok(bad === 0, 'randSuffix4: 500 draws, every one exactly 4 hex chars', String(bad));
}

// ── the fraction→percent invariant ──────────────────────────────────────────
const failures = assertPercentScale();
ok(failures.length === 0, 'assertPercentScale: no scale failures', JSON.stringify(failures));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
