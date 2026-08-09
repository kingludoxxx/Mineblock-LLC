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
  splitNodeTitle, armLettersChip, armCountLabel, fmtRate1, fmtCount,
  pageOptionLabel, pageOptionText, sameTestOptionText, SAME_TEST_REASON, isIneligible,
  partitionArmPages, ineligibleCountsPhrase, nextArmKey, nextSplitLetter, indexLetter,
  canChoosePage, repointConfirmText, ledgerCvr, MIN_RATE_SAMPLE,
  CANVAS_TILES, CANVAS_TILE_LABELS, assertDashParity,
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
ok(armCountLabel(1) === '1 arm', 'armCountLabel: singular is "1 arm", not "1 arms"', armCountLabel(1));
ok(armCountLabel(0) === '0 arms' && armCountLabel(2) === '2 arms', 'armCountLabel: plural elsewhere');
ok(armCountLabel(undefined) === '0 arms' && armCountLabel('x') === '0 arms', 'armCountLabel: garbage → "0 arms", never "NaN arms"');

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

// ── CANVAS TILES — RENDERED, not grepped ────────────────────────────────────
// The three tiles are data (CANVAS_TILES), so their labels, values and
// tooltips are asserted by CALLING them. No source-text matching is involved.
ok(JSON.stringify(CANVAS_TILE_LABELS) === JSON.stringify(['Visitors', 'CTR %', 'CVR %']),
  'CANVAS_TILES: labels are Visitors / CTR % / CVR %, in reference order', JSON.stringify(CANVAS_TILE_LABELS));
ok(CANVAS_TILES.length === 3, 'CANVAS_TILES: exactly three tiles', String(CANVAS_TILES.length));
{
  const byKey = Object.fromEntries(CANVAS_TILES.map((t) => [t.key, t]));
  const arm = { source: 'ledger', visitors: 4200, orders: 63, cvr: 1.5, ctr: undefined };
  ok(byKey.visitors.value(arm) === '4,200', 'CANVAS_TILES: visitors renders the count', byKey.visitors.value(arm));
  ok(byKey.ctr.value(arm) === API_DASH, 'CANVAS_TILES: CTR renders the em-dash', byKey.ctr.value(arm));
  ok(byKey.cvr.value(arm) === '1.5', 'CANVAS_TILES: CVR renders one decimal, no sign', byKey.cvr.value(arm));
  ok(byKey.cvr.title(arm).includes('Orders: 63.'), 'CANVAS_TILES: orders survives in the CVR tooltip', byKey.cvr.title(arm));
  ok(byKey.visitors.value({}) === API_DASH && byKey.cvr.value({}) === API_DASH && byKey.ctr.value({}) === API_DASH,
    'CANVAS_TILES: an empty arm renders em-dashes, never zeroes or NaN');
  ok(CANVAS_TILES.every((t) => typeof t.title({}) === 'string' && t.title({}).length > 20),
    'CANVAS_TILES: every tile has a tooltip even for an empty arm');

  // M3 — THE VISITORS TOOLTIP IS SOURCE-AWARE. The overlay's per-arm visitors
  // is a checkout-mint count; the ledger's is everyone the splitter assigned.
  // One sentence cannot be true of both.
  const overlayTitle = byKey.visitors.title({ source: 'overlay' });
  const ledgerTitle = byKey.visitors.title({ source: 'ledger' });
  ok(overlayTitle !== ledgerTitle, 'M3: the Visitors tooltip DIFFERS by source', `${overlayTitle} === ${ledgerTitle}`);
  ok(overlayTitle.includes('reached checkout'), 'M3: overlay mode says "reached checkout" (the results modal wording)', overlayTitle);
  ok(ledgerTitle.includes('assigned to this arm'), 'M3: ledger mode says "assigned to this arm"', ledgerTitle);
  ok(!ledgerTitle.includes('reached checkout'), 'M3: ledger mode does NOT claim the checkout definition', ledgerTitle);
  ok(byKey.visitors.title({}) === ledgerTitle, 'M3: an unknown source falls back to the narrower (ledger) claim');
  ok(byKey.ctr.title({}).includes('product call'), 'M3: the CTR tooltip names it a product call, not a measurement gap', byKey.ctr.title({}));
  ok(byKey.ctr.title({}).includes('per-PAGE ctr does exist'), 'm6: the CTR rationale concedes the per-page ctr exists');
}

// ── m5: the ledger-fallback CVR obeys the SAME floor and clamp as overlay ───
ok(MIN_RATE_SAMPLE === 30, 'MIN_RATE_SAMPLE mirrors the service constant (30)', String(MIN_RATE_SAMPLE));
{
  // Pinned against the SERVER's own constant — a change there must not leave
  // the canvas quietly reporting rates the service would have withheld.
  const statsSrc = readFileSync(new URL('../server/src/services/analyticsStats.js', import.meta.url), 'utf8');
  const m = statsSrc.match(/export const MIN_RATE_SAMPLE\s*=\s*(\d+)/);
  ok(Boolean(m), 'MIN_RATE_SAMPLE: the server constant is still declared where we read it');
  ok(m && Number(m[1]) === MIN_RATE_SAMPLE, 'MIN_RATE_SAMPLE: client mirror EQUALS the server value', m ? m[1] : 'n/a');
}
{
  const small = ledgerCvr({ exposures: 3, conversions: 1 });
  ok(small.cvr === undefined && small.cvr_withheld === true,
    'ledgerCvr: below MIN_RATE_SAMPLE the rate is WITHHELD, not printed as 33.3', JSON.stringify(small));
  const healthy = ledgerCvr({ exposures: 100, conversions: 4 });
  ok(healthy.cvr === 4 && !healthy.cvr_withheld && !healthy.cvr_clamped, 'ledgerCvr: a healthy sample reports the rate', JSON.stringify(healthy));
  // The clamp: you cannot convert without being exposed. A lost beacon must not
  // become a 300% conversion rate.
  const lost = ledgerCvr({ exposures: 10, conversions: 30 });
  ok(lost.cvr_clamped === true, 'ledgerCvr: conversions > exposures sets cvr_clamped', JSON.stringify(lost));
  ok(lost.cvr === 100, 'ledgerCvr: the clamped rate is exactly 100, never above', JSON.stringify(lost));
  const lostSmall = ledgerCvr({ exposures: 1, conversions: 5 });
  ok(lostSmall.cvr === undefined && lostSmall.cvr_withheld && lostSmall.cvr_clamped,
    'ledgerCvr: a clamped-AND-tiny sample is still withheld', JSON.stringify(lostSmall));
  const zero = ledgerCvr({ exposures: 0, conversions: 0 });
  ok(zero.cvr === undefined && !zero.cvr_withheld, 'ledgerCvr: nothing recorded → undefined, not a withheld flag', JSON.stringify(zero));
  ok(ledgerCvr().cvr === undefined, 'ledgerCvr: no args does not throw');
  ok(ledgerCvr({ exposures: 'abc', conversions: null }).cvr === undefined, 'ledgerCvr: garbage → undefined, never NaN');
  const exact = ledgerCvr({ exposures: MIN_RATE_SAMPLE, conversions: 3 });
  ok(exact.cvr === 10 && !exact.cvr_withheld, 'ledgerCvr: exactly MIN_RATE_SAMPLE is REPORTED (floor is inclusive)', JSON.stringify(exact));
  const under = ledgerCvr({ exposures: MIN_RATE_SAMPLE - 1, conversions: 3 });
  ok(under.cvr === undefined && under.cvr_withheld, 'ledgerCvr: one below the floor is withheld', JSON.stringify(under));
  // The tooltip must SAY so when either rule fired.
  const cvrTile = CANVAS_TILES.find((t) => t.key === 'cvr');
  ok(cvrTile.title({ cvr_withheld: true }).includes(`below ${MIN_RATE_SAMPLE} visitors`),
    'm5: a withheld CVR explains the floor in the tooltip');
  ok(cvrTile.title({ cvr_clamped: true }).includes('lost beacon'),
    'm5: a clamped CVR carries the lost-beacon note');
  ok(!cvrTile.title({}).includes('lost beacon'), 'm5: an unclamped CVR does NOT carry the note');
}

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
ok(sameTestOptionText({ title: 'D', slug: '/d' }) === `D · /d — ${SAME_TEST_REASON}`,
  'm1: a same-test sibling carries its own reason', sameTestOptionText({ title: 'D', slug: '/d' }));

// m2 — ONE eligibility predicate, keyed on an EXPLICIT false.
ok(isIneligible({ eligible: false }) === true, 'm2: eligible:false IS ineligible');
ok(isIneligible({ eligible: true }) === false, 'm2: eligible:true is not');
ok(isIneligible({}) === false && isIneligible(undefined) === false && isIneligible(null) === false,
  'm2: an UNSTATED eligibility is not ineligibility — the server guard is the authority');
{
  // The predicate pageOptionText uses must be the same one partitionArmPages
  // buckets by, or a page could be greyed out by one and offered by the other.
  const unstated = { id: 'pu', title: 'U', slug: '/u' };
  const part = partitionArmPages({ pages: [unstated], liveArms: [] });
  ok(part.importable.length === 1 && part.ineligible.length === 0, 'm2: an unstated page is OFFERED by partitionArmPages…');
  ok(!pageOptionText(unstated).includes('—'), '…and pageOptionText does not brand it with a reason', pageOptionText(unstated));
}

{
  const pages = [
    { id: 'p1', eligible: true, title: 'One', slug: '/one' },
    { id: 'p2', eligible: true, title: 'Two', slug: '/two' },
    { id: 'p3', eligible: false, title: 'Three', slug: '/three', reason_label: 'funnel default' },
  ];
  const liveArms = [{ page_id: 'p1' }, { page_id: 'p2' }];
  const add = partitionArmPages({ pages, liveArms });
  ok(add.importable.length === 0, 'partitionArmPages: pages already armed are not importable again', JSON.stringify(add.importable.map((p) => p.id)));
  // m1 — THE VANISHING SIBLINGS. They used to be filtered out with no trace.
  ok(add.sameTest.map((p) => p.id).join() === 'p1,p2',
    'm1: same-test siblings land in their own bucket instead of vanishing', JSON.stringify(add.sameTest.map((p) => p.id)));
  ok(add.ineligible.map((p) => p.id).join() === 'p3', 'partitionArmPages: ineligible pages are LISTED, not dropped');
  ok(add.importable.length + add.sameTest.length + add.ineligible.length === pages.length,
    'partitionArmPages: the three buckets PARTITION the input — no page is lost');
  const armB = partitionArmPages({ pages, liveArms, currentPageId: 'p2' });
  ok(armB.importable.map((p) => p.id).join() === 'p2',
    'partitionArmPages: an arm keeps its OWN page offerable so the select can show its current value',
    JSON.stringify(armB.importable.map((p) => p.id)));
  ok(armB.sameTest.map((p) => p.id).join() === 'p1', 'partitionArmPages: the OTHER arm page is a same-test sibling');
  ok(partitionArmPages({}).importable.length === 0 && partitionArmPages().ineligible.length === 0,
    'partitionArmPages: no pages / no args does not throw');
  ok(partitionArmPages({ pages: null, liveArms: null }).importable.length === 0, 'partitionArmPages: null inputs do not throw');
  ok(partitionArmPages({ pages: [null, undefined, pages[0]] }).importable.length === 1,
    'partitionArmPages: null entries in the page list are dropped, not rendered as "Untitled"');
}

ok(ineligibleCountsPhrase({ post_purchase: 2, funnel_default: 1 }) === '2 post-purchase, 1 funnel default',
  'ineligibleCountsPhrase: joins the non-zero reasons', ineligibleCountsPhrase({ post_purchase: 2, funnel_default: 1 }));
ok(ineligibleCountsPhrase({ post_purchase: 0, in_other_test: 3 }) === '3 in another split',
  'ineligibleCountsPhrase: omits zeroes rather than printing "0 post-purchase"');
ok(ineligibleCountsPhrase({}) === '' && ineligibleCountsPhrase(null) === '' && ineligibleCountsPhrase(undefined) === '',
  'ineligibleCountsPhrase: empty/null → empty string, never "undefined"');

// ── M5: the "+ Add Split X" header and the arm_key the POST mints ───────────
// These were TWO implementations — a count-based letter in the header and a
// first-unused scan in the modal — and they disagree exactly when an arm in the
// middle was archived. One function now answers both.
{
  ok(indexLetter(0) === 'A' && indexLetter(2) === 'C' && indexLetter(26) === 'AA',
    'indexLetter: A / C / AA', `${indexLetter(0)}/${indexLetter(2)}/${indexLetter(26)}`);
  let drift = null;
  for (let i = 0; i < 200 && drift === null; i += 1) {
    if (indexLetter(i) !== armLetter(i)) drift = `${i}: ${indexLetter(i)} vs ${armLetter(i)}`;
  }
  ok(drift === null, 'indexLetter: agrees with splitApi.armLetter for 200 indices', String(drift));

  ok(nextArmKey([{ arm_key: 'a' }, { arm_key: 'b' }]) === 'c', 'nextArmKey: a,b → c');
  ok(nextSplitLetter([{ arm_key: 'a' }, { arm_key: 'b' }]) === 'C', 'nextSplitLetter: a,b → C');
  // THE PINNED REGRESSION: arm b was archived, so liveArms is [a, c]. The old
  // count-based header said "Add Split C" while the POST minted 'b'.
  const midArchived = [{ arm_key: 'a' }, { arm_key: 'c' }];
  ok(nextArmKey(midArchived) === 'b',
    'M5: with a mid-sequence archived arm the next KEY is the first unused (b)', nextArmKey(midArchived));
  ok(nextSplitLetter(midArchived) === 'B',
    'M5: …and the HEADER says B — header and minted key agree', nextSplitLetter(midArchived));
  ok(nextSplitLetter(midArchived) === nextArmKey(midArchived).toUpperCase(),
    'M5: the header is DERIVED from the key, so they cannot drift');
  ok(nextArmKey([{ arm_key: 'A' }, { arm_key: 'B' }]) === 'c', 'nextArmKey: existing keys are matched case-insensitively');
  ok(nextArmKey([]) === 'a' && nextSplitLetter([]) === 'A', 'nextArmKey: an empty test starts at a');
  ok(nextArmKey(null) === 'a' && nextSplitLetter(undefined) === 'A', 'nextArmKey: null/undefined does not throw');
  ok(nextArmKey(['a', 'b']) === 'c', 'nextArmKey: accepts bare key strings too');
  ok(nextArmKey([{ arm_key: null }, { arm_key: 'a' }]) === 'b', 'nextArmKey: a null key is ignored, not stringified to "null"');
}

// ── M2: the page picker is keyed on the CONTROL, never on position ──────────
{
  ok(canChoosePage({ is_control: true }) === false, 'M2: the CONTROL arm cannot be re-pointed');
  ok(canChoosePage({ is_control: false }) === true, 'M2: a non-control arm can');
  // The case index-keying got wrong: the control is NOT always first (POST
  // .../control can move it), and sort_order is operator-reorderable.
  const arms = [{ arm_key: 'a', is_control: false }, { arm_key: 'b', is_control: true }];
  ok(canChoosePage(arms[0]) === true && canChoosePage(arms[1]) === false,
    'M2: when the control is the SECOND arm, the FIRST becomes re-pointable and the second does not');
  ok(canChoosePage(null) === false && canChoosePage(undefined) === false, 'M2: a missing arm is not re-pointable');
  ok(canChoosePage({}) === true, 'M2: an arm with no is_control flag is treated as non-control');

  const t = repointConfirmText({
    letter: 'B',
    fromPage: { title: 'Old', slug: '/old' },
    toPage: { title: 'New', slug: '/new' },
  });
  ok(t.includes('Old · /old') && t.includes('New · /new'), 'M2: the confirm names BOTH pages', t);
  ok(t.includes('Arm B'), 'M2: the confirm names the arm', t);
  ok(t.includes('stays with the arm'), 'M2: the confirm says what SURVIVES the change', t);
  ok(repointConfirmText({ letter: 'C' }).includes('no page'), 'M2: an arm with no page reads "no page", not "undefined"');
  ok(repointConfirmText().includes('Arm ?'), 'M2: no args does not throw');
}

// ── REFERENCE-PARITY COPY GUARD ─────────────────────────────────────────────
// The operator's requirement is that these surfaces read EXACTLY like the
// reference tool, and verbatim strings are the part of that a machine can hold.
//
// THE PREVIOUS VERSION OF THIS GUARD COULD NOT FAIL. It grepped raw source, so
// a needle was satisfied by the very COMMENT that described the copy — delete
// the JSX and the assertion still passed. Two changes fix that:
//   1. comments and title= tooltips are stripped BEFORE matching, so only
//      visible JSX can satisfy a needle;
//   2. each needle class carries a MUTATION CHECK that deletes the copy from
//      the visible text and asserts the guard then FAILS.
// Everything that could be rendered instead of matched already has been (the
// tile labels, tooltips and helper outputs above); what remains here is copy
// bound directly into JSX.
const readSrc = (p) => readFileSync(new URL(`../client/src/components/funnels/${p}`, import.meta.url), 'utf8');

/** Source reduced to what a user can actually SEE: no comments, no tooltips. */
const visibleCopy = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')                 // block comments, incl. {/* JSX */}
  .replace(/^[ \t]*\/\/.*$/gm, ' ')                  // whole-line // comments
  .replace(/\/\/[^\n'"`]*$/gm, ' ')                  // trailing // comments (no quote → not a URL)
  .replace(/title=\{`[^`]*`\}/g, ' ')                // title={`…`}
  .replace(/title=\{[^}]*\}/g, ' ')                  // title={…}
  .replace(/title="[^"]*"/g, ' ')                    // title="…"
  .replace(/aria-label=\{?["'`][^"'`]*["'`]\}?/g, ' ');
const parityCheck = (visible, needle) => visible.includes(needle);

// The stripper itself is verified against synthetic fixtures — this is the
// defect being fixed, so it gets its own proof rather than being assumed.
ok(!parityCheck(visibleCopy('// Create A/B test\nconst x = 1;'), 'Create A/B test'),
  'stripper: a line comment can NO LONGER satisfy a needle');
ok(!parityCheck(visibleCopy('{/* Split Pages heading */}\n<div/>'), 'Split Pages'),
  'stripper: a JSX block comment can no longer satisfy a needle');
ok(!parityCheck(visibleCopy('<span title="lifetime · not the verdict" />'), 'lifetime · not the verdict'),
  'stripper: a title= tooltip can no longer satisfy a needle');
ok(parityCheck(visibleCopy('<span title="x">Split Pages</span>'), 'Split Pages'),
  'stripper: real visible JSX text still DOES satisfy a needle');
ok(parityCheck(visibleCopy("const u = 'https://x.test/a';\n<b>https://x.test/a</b>"), 'https://x.test/a'),
  'stripper: a // inside a URL is not mistaken for a comment');

// COPY = literal text the operator reads. BINDING = the JSX expression that
// emits a runtime value; the value itself is asserted by the rendered tests.
const PARITY = [
  ['split/SplitQuickCreateModal.jsx', {
    copy: [
      'Create A/B test',
      'Variant A is this page. Pick an existing page for variant B — traffic starts at a 50/50',
      'split (adjust the weights any time after).',
      'Variant B page',
      'Choose a page…',
      'Pick a page',      // the empty THUMBNAIL placeholder, distinct from the select's
      'Weight 50%',
      'Cancel',
    ],
    binding: [],
  }],
  ['split/SplitSetupModal.jsx', {
    copy: [
      'Split Pages',
      'Split Name (handle)',
      'Traffic is sent to this link:',
      'Page Analytics',
      'Split Traffic By',
      '% Percentage',
      'Lead Page Name',
      'Use name as title',
      'Published Page Name',
      'Set as Default Page',
      'Choose / import page',
      'Duplicate a page',
      'Import existing page',
    ],
    binding: [
      'Created {fmtDate(test?.created_at)}',
      'Last edited {fmtDate(test?.updated_at)}',
      'A · {v}%',
      'B · {100 - v}%',
      '+ Add Split {nextSplitLetter(liveArms)}',
    ],
  }],
  ['split/SplitGroupNode.jsx', {
    copy: ['lifetime · not the verdict'],
    binding: ['{splitNodeTitle(handle)}', '{armLettersChip(arms)}', 'CANVAS_TILES.map'],
  }],
];
for (const [file, { copy, binding }] of PARITY) {
  const visible = visibleCopy(readSrc(file));
  for (const n of copy) ok(parityCheck(visible, n), `parity copy: ${file} renders ${JSON.stringify(n)}`);
  for (const n of binding) ok(parityCheck(visible, n), `parity binding: ${file} binds ${JSON.stringify(n)}`);
  // MUTATION CHECK, one per needle class per surface: delete the copy from the
  // visible text and the guard must go red.
  const probe = copy[0];
  ok(!parityCheck(visible.split(probe).join('X'), probe),
    `parity MUTATION: deleting ${JSON.stringify(probe)} from ${file} FAILS the guard`);
  if (binding.length) {
    const bprobe = binding[0];
    ok(!parityCheck(visible.split(bprobe).join('X'), bprobe),
      `parity MUTATION: deleting the binding ${JSON.stringify(bprobe)} from ${file} FAILS the guard`);
  }
}
// The "OR" divider and the SPLIT chip are CSS-uppercased in both the reference
// and here — assert the source form, on the VISIBLE text only.
{
  const setup = visibleCopy(readSrc('split/SplitSetupModal.jsx'));
  ok(/uppercase[^>]*>\s*or\s*</.test(setup), 'parity copy: SplitSetupModal renders the CSS-uppercased "or" divider');
  const node = visibleCopy(readSrc('split/SplitGroupNode.jsx'));
  ok(/uppercase[^>]*>\s*Split\s*</.test(node), 'parity copy: SplitGroupNode renders the CSS-uppercased "Split" chip');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
