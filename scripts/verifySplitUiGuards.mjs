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
  armLetter, DASH: API_DASH,
} = await import(pathToFileURL(tmpFile).href);

// splitUiCopy.js is imported DIRECTLY — it has no `services/api` import and no
// JSX, which is the whole reason the parity copy/option logic lives there.
const COPY_SRC = new URL('../client/src/components/funnels/split/splitUiCopy.js', import.meta.url);
const {
  splitNodeTitle, armLettersChip, fmtRate1, fmtCount, pageOptionLabel, pageOptionText,
  partitionArmPages, ineligibleCountsPhrase, nextSplitLetter, assertDashParity,
} = await import(COPY_SRC.href);

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

// ── splitUiCopy: canvas node copy ───────────────────────────────────────────
ok(splitNodeTitle('offer-ab') === 'offer-ab A/B', 'splitNodeTitle: "<handle> A/B", no leading slash', splitNodeTitle('offer-ab'));
ok(splitNodeTitle('/offer-ab') === 'offer-ab A/B', 'splitNodeTitle: strips a slash the caller left on');
ok(splitNodeTitle('') === 'split A/B' && splitNodeTitle(null) === 'split A/B' && splitNodeTitle(undefined) === 'split A/B',
  'splitNodeTitle: no handle degrades to "split A/B", never "undefined A/B"', splitNodeTitle(null));
ok(armLettersChip([{ letter: 'A' }, { letter: 'B' }]) === 'A/B', 'armLettersChip: two arms → A/B');
ok(armLettersChip([{ letter: 'a' }, { letter: 'b' }, { letter: 'c' }]) === 'A/B/C', 'armLettersChip: uppercases, 3 arms → A/B/C');
ok(armLettersChip([]) === API_DASH && armLettersChip(null) === API_DASH, 'armLettersChip: no arms → em-dash, never an empty chip');
ok(armLettersChip([{ letter: 'A' }, {}, { letter: 'C' }]) === 'A/C', 'armLettersChip: skips a letterless arm rather than printing "undefined"');

// THE HONESTY INVARIANT: an absent measurement must render as an em-dash and a
// measured zero must render as zero. Collapsing the two is the whole bug class
// the canvas tiles exist to avoid.
ok(fmtRate1(undefined) === API_DASH && fmtRate1(null) === API_DASH && fmtRate1('') === API_DASH,
  'fmtRate1: unmeasured → em-dash', fmtRate1(undefined));
ok(fmtRate1(0) === '0.0', 'fmtRate1: a measured zero is NOT an em-dash', fmtRate1(0));
ok(fmtRate1(4.32) === '4.3' && fmtRate1(12.36) === '12.4', 'fmtRate1: one decimal', `${fmtRate1(4.32)}/${fmtRate1(12.36)}`);
// toFixed rounds the BINARY double, not the decimal literal: 12.35 is stored
// as 12.3499…, so it goes DOWN. Pinned rather than "fixed" — a rate tile is
// not the place to introduce a bespoke rounding path.
ok(fmtRate1(12.35) === '12.3', 'fmtRate1: toFixed rounds the stored double (12.35 → 12.3), pinned', fmtRate1(12.35));
ok(!String(fmtRate1(4.32)).includes('%'), 'fmtRate1: NO percent sign in the value — the label carries it', fmtRate1(4.32));
ok(fmtRate1(NaN) === API_DASH && fmtRate1(Infinity) === API_DASH && fmtRate1('abc') === API_DASH,
  'fmtRate1: NaN/Infinity/garbage → em-dash, never "NaN"', `${fmtRate1(NaN)}/${fmtRate1(Infinity)}/${fmtRate1('abc')}`);
ok(fmtCount(undefined) === API_DASH && fmtCount(null) === API_DASH, 'fmtCount: unmeasured → em-dash');
ok(fmtCount(0) === '0', 'fmtCount: a measured zero is NOT an em-dash', fmtCount(0));
ok(fmtCount(12345) === '12,345', 'fmtCount: thousands separated', fmtCount(12345));
ok(fmtCount('4200') === '4,200', 'fmtCount: numeric string (PG NUMERIC arrives as one)', fmtCount('4200'));
ok(fmtCount(NaN) === API_DASH && fmtCount('abc') === API_DASH, 'fmtCount: NaN/garbage → em-dash');
ok(assertDashParity(API_DASH).length === 0, 'DASH parity: splitUiCopy and splitApi render the same glyph',
  JSON.stringify(assertDashParity(API_DASH)));

// ── splitUiCopy: page-picker copy + partitioning ────────────────────────────
ok(pageOptionLabel({ title: 'Lead Page', slug: '/lead' }) === 'Lead Page · /lead', 'pageOptionLabel: "<title> · <slug>"', pageOptionLabel({ title: 'Lead Page', slug: '/lead' }));
ok(pageOptionLabel({ slug: '/lead' }) === 'Untitled · /lead', 'pageOptionLabel: missing title → Untitled');
ok(pageOptionLabel({ title: 'X' }) === 'X', 'pageOptionLabel: no slug → title alone, no dangling separator');
ok(pageOptionLabel(null) === 'Untitled' && pageOptionLabel(undefined) === 'Untitled', 'pageOptionLabel: null page does not throw');
ok(pageOptionText({ title: 'A', slug: '/a', eligible: false, reason_label: 'post-purchase' }) === 'A · /a — post-purchase',
  'pageOptionText: ineligible carries its reason', pageOptionText({ title: 'A', slug: '/a', eligible: false, reason_label: 'post-purchase' }));
ok(pageOptionText({ title: 'A', slug: '/a', eligible: false }) === 'A · /a — cannot be an arm',
  'pageOptionText: ineligible with no reason still says why-less, never bare');
ok(pageOptionText({ title: 'B', slug: '/b', eligible: true, status: 'draft' }) === "B · /b · draft (won't serve until published)",
  'pageOptionText: a draft arm is labelled as one', pageOptionText({ title: 'B', slug: '/b', eligible: true, status: 'draft' }));
ok(pageOptionText({ title: 'C', slug: '/c', eligible: true, status: 'published' }) === 'C · /c', 'pageOptionText: published is unadorned');

{
  const pages = [
    { id: 'p1', eligible: true, title: 'One', slug: '/one' },
    { id: 'p2', eligible: true, title: 'Two', slug: '/two' },
    { id: 'p3', eligible: false, title: 'Three', slug: '/three', reason_label: 'funnel default' },
  ];
  const liveArms = [{ page_id: 'p1' }, { page_id: 'p2' }];
  const add = partitionArmPages({ pages, liveArms });
  ok(add.importable.length === 0, 'partitionArmPages: pages already armed are not importable again', JSON.stringify(add.importable.map((p) => p.id)));
  ok(add.ineligible.map((p) => p.id).join() === 'p3', 'partitionArmPages: ineligible pages are LISTED, not dropped');
  const armB = partitionArmPages({ pages, liveArms, currentPageId: 'p2' });
  ok(armB.importable.map((p) => p.id).join() === 'p2',
    'partitionArmPages: an arm keeps its OWN page offerable so the select can show its current value',
    JSON.stringify(armB.importable.map((p) => p.id)));
  ok(partitionArmPages({}).importable.length === 0 && partitionArmPages().ineligible.length === 0,
    'partitionArmPages: no pages / no args does not throw');
  ok(partitionArmPages({ pages: null, liveArms: null }).importable.length === 0, 'partitionArmPages: null inputs do not throw');
}

ok(ineligibleCountsPhrase({ post_purchase: 2, funnel_default: 1 }) === '2 post-purchase, 1 funnel default',
  'ineligibleCountsPhrase: joins the non-zero reasons', ineligibleCountsPhrase({ post_purchase: 2, funnel_default: 1 }));
ok(ineligibleCountsPhrase({ post_purchase: 0, in_other_test: 3 }) === '3 in another split',
  'ineligibleCountsPhrase: omits zeroes rather than printing "0 post-purchase"');
ok(ineligibleCountsPhrase({}) === '' && ineligibleCountsPhrase(null) === '' && ineligibleCountsPhrase(undefined) === '',
  'ineligibleCountsPhrase: empty/null → empty string, never "undefined"');

// nextSplitLetter titles the "+ Add Split C" column; armLetter mints the arm
// letters and the arm_key. If they ever disagree the column would promise a
// letter the modal does not create.
{
  let drift = null;
  for (let i = 0; i < 200 && drift === null; i += 1) {
    if (nextSplitLetter(i) !== armLetter(i)) drift = `${i}: ${nextSplitLetter(i)} vs ${armLetter(i)}`;
  }
  ok(drift === null, 'nextSplitLetter: agrees with splitApi.armLetter for 200 indices', String(drift));
  ok(nextSplitLetter(0) === 'A' && nextSplitLetter(2) === 'C' && nextSplitLetter(26) === 'AA',
    'nextSplitLetter: A / C / AA', `${nextSplitLetter(0)}/${nextSplitLetter(2)}/${nextSplitLetter(26)}`);
  ok(nextSplitLetter(undefined) === 'A' && nextSplitLetter(-3) === 'A' && nextSplitLetter('x') === 'A',
    'nextSplitLetter: garbage degrades to A — a column header must never read "?"',
    `${nextSplitLetter(undefined)}/${nextSplitLetter(-3)}/${nextSplitLetter('x')}`);
}

// ── REFERENCE-PARITY COPY GUARD ─────────────────────────────────────────────
// The operator's requirement is that these surfaces read EXACTLY like the
// reference tool. Verbatim strings are the part of that a machine can hold, so
// each one is asserted against the real source file. A reworded label is a
// parity regression, and this is what catches it.
const readSrc = (p) => readFileSync(new URL(`../client/src/components/funnels/${p}`, import.meta.url), 'utf8');
const PARITY = [
  ['split/SplitQuickCreateModal.jsx', [
    'Create A/B test',
    'Variant A is this page. Pick an existing page for variant B — traffic starts at a 50/50',
    'split (adjust the weights any time after).',
    'Variant B page',
    'Choose a page…',
    'Pick a page',      // the empty THUMBNAIL placeholder, distinct from the select's
    'Weight 50%',
    'Cancel',
  ]],
  ['split/SplitSetupModal.jsx', [
    'Split Pages',
    'Split Name (handle)',
    'Traffic is sent to this link:',
    'Page Analytics',
    'Created {fmtDate(test?.created_at)}',
    'Last edited {fmtDate(test?.updated_at)}',
    'Split Traffic By',
    '% Percentage',
    'A · {v}%',
    'B · {100 - v}%',
    'Lead Page Name',
    'Use name as title',
    'Published Page Name',
    'Set as Default Page',
    'Choose / import page',
    '+ Add Split {nextSplitLetter(liveArms.length)}',
    'Duplicate a page',
    'Import existing page',
  ]],
  ['split/SplitGroupNode.jsx', [
    '{splitNodeTitle(handle)}',
    'lifetime · not the verdict',
    'label="Visitors"',
    'label="CTR %"',
    'label="CVR %"',
    '{armLettersChip(arms)}',
  ]],
];
for (const [file, needles] of PARITY) {
  const src = readSrc(file);
  for (const n of needles) ok(src.includes(n), `parity copy: ${file} contains ${JSON.stringify(n)}`);
}
// The "OR" divider between Duplicate and Import, and the SPLIT chip, are
// CSS-uppercased in both the reference and here — assert the rendered form's
// source, not a guess at its casing.
{
  const setup = readSrc('split/SplitSetupModal.jsx');
  ok(/uppercase[^>]*>\s*or\s*</.test(setup), 'parity copy: SplitSetupModal has the CSS-uppercased "or" divider');
  const node = readSrc('split/SplitGroupNode.jsx');
  ok(/uppercase[^>]*>\s*Split\s*</.test(node), 'parity copy: SplitGroupNode has the CSS-uppercased "Split" chip');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
