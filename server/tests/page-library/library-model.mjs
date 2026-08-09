// Pure-unit verification for the page library's client-side model
// (client/src/components/funnels/pageLibraryModel.js) — no DOM, no server, no
// database. Same shape as builder/version-format.mjs, which imports client
// source directly across the tree.
//
// Asserts BY EXECUTION:
//   • bands come out in GROUPS order, empty bands dropped
//   • an unknown / new / null page type lands in a trailing "Other" band and is
//     NEVER dropped (a page visible on the canvas but missing from the library
//     would read as data loss)
//   • a missing/empty type is GENERIC (the funnel_pages column default), not
//     "unknown"
//   • order inside a band follows the INPUT order (the API's
//     is_home DESC, created_at ASC), never a re-sort
//   • a multi-type band interleaves by TYPE order, not by input order
//   • garbage input (null, a string, an object, holes) yields [] rather than
//     throwing
//   • fmtBytes: unknown → em dash, never "0 B"; unit thresholds exact
//   • pageCountLabel: singular/plural, non-array → 0
//
// Run:  node server/tests/page-library/library-model.mjs
import {
  GROUPS, OTHER_LABEL, groupPagesByBand, fmtBytes, pageCountLabel,
} from '../../../client/src/components/funnels/pageLibraryModel.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) =>
  ok(got === want, m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const shape = (bands) => bands.map((b) => `${b.label}[${b.items.map((i) => i.id).join(',')}]`).join(' | ');

// ── Band order + empty-band dropping ───────────────────────────────────────
{
  const bands = groupPagesByBand([
    { id: 'a', type: 'thankyou' },
    { id: 'b', type: 'quiz' },
    { id: 'c', type: 'checkout' },
  ]);
  eq(shape(bands), 'Quiz[b] | Checkout[c] | Thank You[a]',
    'bands render in GROUPS order regardless of input order');
  eq(bands.length, 3, 'empty bands are dropped');
}

// ── Multi-type bands interleave by TYPE order ──────────────────────────────
{
  const bands = groupPagesByBand([
    { id: 'd1', type: 'downsell' },
    { id: 'u1', type: 'upsell' },
    { id: 'd2', type: 'downsell' },
    { id: 'u2', type: 'upsell' },
  ]);
  eq(shape(bands), 'Upsell / Downsell[u1,u2,d1,d2]',
    'a two-type band lists all of the FIRST type, then all of the second');
  const lead = groupPagesByBand([
    { id: 'l1', type: 'lead' },
    { id: 'x1', type: 'listicle' },
  ]);
  eq(shape(lead), 'Listicle / Advertorial[x1,l1]',
    'listicle precedes lead inside the Listicle / Advertorial band');
}

// ── Order inside a band is the INPUT order ─────────────────────────────────
{
  const bands = groupPagesByBand([
    { id: 'home', type: 'checkout' },
    { id: 'second', type: 'checkout' },
    { id: 'third', type: 'checkout' },
  ]);
  eq(shape(bands), 'Checkout[home,second,third]',
    'input order survives inside a band (the API already sorted it)');
}

// ── NOTHING IS EVER DROPPED ────────────────────────────────────────────────
{
  const bands = groupPagesByBand([
    { id: 'k', type: 'quiz' },
    { id: 'new', type: 'a_type_that_does_not_exist_yet' },
    { id: 'nul', type: null },
    { id: 'und' },
    { id: 'blank', type: '' },
    { id: 'num', type: 42 },
  ]);
  const all = bands.flatMap((b) => b.items.map((i) => i.id));
  eq(all.length, 6, 'every input page appears in exactly one band');
  eq(shape(bands), `Quiz[k] | Survey / Generic[nul,und,blank] | ${OTHER_LABEL}[new,num]`,
    'null/absent/empty types are GENERIC; genuinely unknown types go to Other');
  eq(bands[bands.length - 1].label, OTHER_LABEL, 'the Other band is always LAST');
}
{
  const onlyKnown = groupPagesByBand([{ id: 'q', type: 'quiz' }]);
  ok(!onlyKnown.some((b) => b.label === OTHER_LABEL),
    'no Other band is emitted when every type is known');
}

// ── Garbage input does not throw ───────────────────────────────────────────
{
  eq(shape(groupPagesByBand([])), '', 'empty input → no bands');
  eq(shape(groupPagesByBand(null)), '', 'null input → no bands');
  eq(shape(groupPagesByBand(undefined)), '', 'undefined input → no bands');
  eq(shape(groupPagesByBand('not an array')), '', 'a string input → no bands');
  eq(shape(groupPagesByBand({ 0: { type: 'quiz' } })), '', 'an object input → no bands');
  // A HOLE IS NOT A PAGE. Keeping a null "because nothing is dropped" would
  // hand the renderer an item with no id and no title — a crash, not a
  // preserved page. This assertion exists because an earlier revision DID keep
  // them and this harness blew up on it.
  const holes = groupPagesByBand([null, undefined, 7, 'x', [], { id: 'real', type: 'quiz' }]);
  eq(shape(holes), 'Quiz[real]', 'nulls / primitives / nested arrays are dropped, real pages are not');
  eq(holes.length, 1, 'holes do not conjure an empty band');
}

// ── Purity ─────────────────────────────────────────────────────────────────
{
  const input = [{ id: 'a', type: 'quiz' }, { id: 'b', type: 'checkout' }];
  const snapshot = JSON.stringify(input);
  const first = shape(groupPagesByBand(input));
  const second = shape(groupPagesByBand(input));
  eq(first, second, 'groupPagesByBand is pure (same in → same out)');
  eq(JSON.stringify(input), snapshot, 'groupPagesByBand does not mutate its input');
  eq(GROUPS.length, 7, 'the band table is the seven ported groups');
}

// ── fmtBytes ───────────────────────────────────────────────────────────────
{
  eq(fmtBytes(0), '0 B', 'zero bytes is a MEASURED zero and prints as 0 B');
  eq(fmtBytes(1023), '1023 B', 'under 1KB stays in bytes');
  eq(fmtBytes(1024), '1.0 KB', 'exactly 1024 becomes KB');
  eq(fmtBytes(1024 * 1024 - 1), '1024.0 KB', 'just under 1MB stays KB');
  eq(fmtBytes(1024 * 1024), '1.00 MB', 'exactly 1MB becomes MB');
  eq(fmtBytes(2.5 * 1024 * 1024), '2.50 MB', 'MB carries two decimals');
  eq(fmtBytes(null), '—', 'null is UNMEASURED → em dash, never 0 B');
  eq(fmtBytes(undefined), '—', 'undefined → em dash');
  eq(fmtBytes(NaN), '—', 'NaN → em dash');
  eq(fmtBytes(Infinity), '—', 'Infinity → em dash');
  eq(fmtBytes('1024'), '—', 'a numeric STRING is not a measurement → em dash');
  eq(fmtBytes(-1), '—', 'a negative size is nonsense → em dash, not "-1 B"');
}

// ── pageCountLabel ─────────────────────────────────────────────────────────
{
  eq(pageCountLabel([]), '0 pages', 'zero is plural');
  eq(pageCountLabel([{}]), '1 page', 'one is singular');
  eq(pageCountLabel(new Array(45).fill({})), '45 pages',
    'the reference caption is derived live from the array, not stored');
  eq(pageCountLabel(null), '0 pages', 'a non-array reads as 0, never NaN');
  eq(pageCountLabel(undefined), '0 pages', 'undefined reads as 0');
  eq(pageCountLabel({ length: 9 }), '0 pages',
    'an array-LIKE is not an array — a length property must not be trusted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
