// Unit verification for the AI DEVELOPER op validator's WIRING FLOOR
// (server/src/routes/aiDeveloper.js — applyOps / mergeReplaceProps).
//
// WHY THIS EXISTS. `replace_props` is a wholesale overwrite of a block's props.
// A model asked to reword a checkout block's headline routinely re-emits only
// the props it was thinking about — and the ones it drops are the wiring:
// variant_id, line_items, offer_id, quantity. The block keeps rendering, keeps
// looking right on the canvas, and stops charging. Nothing downstream catches
// it: validateBlocks only checks shape, and the operator sees a page that looks
// exactly like the one they asked for.
//
// The floor carries those keys forward from the block's CURRENT props whenever
// an op is silent about them. An op that SETS one wins, including setting it to
// null — clearing wiring on purpose is legal, losing it by omission is not.
//
// This is the SERVER half. The client half (builderModel.mergeReplaceProps,
// applied in PageBuilderPage.applyOpsNow) is covered in builder-model.mjs, and
// the two lists must move together.
//
// Run:  node server/tests/builder/ai-ops-wiring.mjs
import { applyOps, detectLinkHostChanges, linkHost, mergeReplaceProps, WIRING_KEYS } from '../../src/routes/aiDeveloper.js';
// The CLIENT floor, imported for real so the "byte-identical" claim below is
// a measurement rather than an assertion about a hardcoded literal.
import { WIRING_KEYS as CLIENT_WIRING_KEYS } from '../../../client/src/pages/funnels/builder/builderModel.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

// A wired order bump, as the editor would hold it.
const bump = () => ({
  id: 'blk_bump',
  type: 'order_bump',
  props: {
    headline: 'Add the warranty',
    variant_id: '44556677',
    line_items: [{ variant_id: '44556677', quantity: 1 }],
    offer_id: 'of_warranty',
    quantity: 1,
    product_id: 'prod_1',
    price_id: 'price_1',
    style: { color: '#111' },
    mobile_styles: { fontSize: '13px' },
    block_name: 'bump_warranty',
  },
});

// ===========================================================================
// The defect the floor exists to stop
// ===========================================================================
{
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'blk_bump', props: { headline: 'Add the extended warranty' } },
  ]);
  ok(!res.error, 'a copy-only replace_props is accepted', res.error);
  const props = res.blocks[0].props;
  eq(props.headline, 'Add the extended warranty', 'the op WINS for the key it set');
  eq(props.variant_id, '44556677', 'variant_id survives — the bump still charges');
  eq(props.line_items, [{ variant_id: '44556677', quantity: 1 }], 'line_items survives');
  eq(props.offer_id, 'of_warranty', 'offer_id survives');
  eq(props.quantity, 1, 'quantity survives');
  eq(props.product_id, 'prod_1', 'product_id survives');
  eq(props.price_id, 'price_1', 'price_id survives');
  eq(props.style, { color: '#111' }, 'the base style bag survives');
  eq(props.mobile_styles, { fontSize: '13px' }, 'the mobile override bag survives');
  eq(props.block_name, 'bump_warranty', 'the CSS hook / label survives');

  // The NORMALIZED op is what the editor applies. If the floor were only
  // applied to the simulated blocks, the client would still receive — and
  // apply — the model's raw, wiring-less object.
  eq(
    res.ops[0].props.variant_id, '44556677',
    'the RETURNED op carries the floor too, so the editor applies what was validated'
  );
  eq(
    JSON.stringify(res.ops[0].props), JSON.stringify(res.blocks[0].props),
    'the returned op and the simulated block agree exactly'
  );
}

// ===========================================================================
// A replace is still a replace for everything else
// ===========================================================================
{
  const blocks = [{ id: 'h1', type: 'heading', props: { text: 'Old', subtext: 'drop me', align: 'left' } }];
  const res = applyOps(blocks, [
    { op: 'replace_props', block_id: 'h1', props: { text: 'New' } },
  ]);
  ok(!res.error, 'a heading replace is accepted', res.error);
  eq(res.blocks[0].props, { text: 'New' }, 'NON-wiring props the op omits are dropped — the op is still a replace');
}

// ===========================================================================
// Explicit wins, including an explicit clear
// ===========================================================================
{
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'blk_bump', props: { headline: 'x', variant_id: '99' } },
  ]);
  eq(res.blocks[0].props.variant_id, '99', 'an op that SETS a wiring key overrides the carry-forward');
}
{
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'blk_bump', props: { headline: 'x', variant_id: null } },
  ]);
  eq(res.blocks[0].props.variant_id, null, 'an EXPLICIT null unwires on purpose and is honored');
}

// ===========================================================================
// The floor does not leak across blocks or ops
// ===========================================================================
{
  const blocks = [bump(), { id: 'h1', type: 'heading', props: { text: 'hi' } }];
  const res = applyOps(blocks, [
    { op: 'replace_props', block_id: 'h1', props: { text: 'bye' } },
  ]);
  eq(res.blocks[1].props, { text: 'bye' }, 'a block with no wiring gains none from its neighbour');
  eq(res.blocks[0].props.variant_id, '44556677', 'the untouched bump is unchanged');
}
{
  // Two replaces on the SAME block: the second reads the FIRST's result, so
  // the floor still holds at the end of the chain.
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'blk_bump', props: { headline: 'one' } },
    { op: 'replace_props', block_id: 'blk_bump', props: { headline: 'two' } },
  ]);
  eq(res.blocks[0].props.headline, 'two', 'ops apply in order');
  eq(res.blocks[0].props.variant_id, '44556677', 'the floor survives a CHAIN of replaces on one block');
}

// ===========================================================================
// insert_block is NOT floored — a new block has no previous wiring to keep
// ===========================================================================
{
  const res = applyOps([], [
    { op: 'insert_block', index: 0, block: { type: 'heading', props: { text: 'hi' } } },
  ]);
  ok(!res.error, 'insert_block is accepted', res.error);
  eq(res.blocks[0].props, { text: 'hi' }, 'an inserted block gets exactly the props proposed');
}

// ===========================================================================
// Degraded inputs — the validator is fed model output and must never throw
// ===========================================================================
{
  const res = applyOps([{ id: 'b', type: 'heading' }], [
    { op: 'replace_props', block_id: 'b', props: { text: 'x' } },
  ]);
  ok(!res.error, 'a block with NO props object is accepted', res.error);
  eq(res.blocks[0].props, { text: 'x' }, 'absent previous props → the op verbatim, no throw');
}
{
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'blk_bump', props: [] },
  ]);
  ok(!!res.error, 'an ARRAY props is still refused — the floor did not weaken the shape check');
}
{
  const res = applyOps([bump()], [
    { op: 'replace_props', block_id: 'nope', props: { a: 1 } },
  ]);
  ok(!!res.error, 'an unknown block_id is still refused');
}

// ===========================================================================
// SEAM AUDIT B3 — the second wave.
//
// The original nine keys covered the checkout blocks that existed when the
// floor was written. Every block type added since carried load-bearing props
// OUTSIDE it, and a routine "reword this" batch blanked all of them while the
// canvas still looked correct. Reproduced through the real applyOps +
// renderBlock before the fix:
//
//   sticky_cta.href      → href='#'                  the money link dies
//   product_grid.items   → empty grid
//   countdown.deadline   → data-deadline=''          the clock never starts
//   embed.html           → the widget is erased
//   table.rows           → <tbody></tbody>
//   order_bump.checked   → a pre-ticked bump unticks
//   hero.cta_href        → href='#'
//
// Each new key is asserted in ALL THREE directions the floor's contract
// promises: OMITTED → carried forward, EXPLICITLY SET → the op wins, EXPLICIT
// NULL → honored as a deliberate clear. The third is what keeps the floor a
// safety net rather than a write-protect: items/rows/html are content the
// model legitimately rewrites.
// ===========================================================================
const SECOND_WAVE = [
  { key: 'href', type: 'sticky_cta', live: 'https://shop.example.com/checkout?v=1', next: 'https://shop.example.com/checkout?v=2' },
  { key: 'cta_href', type: 'hero', live: 'https://shop.example.com/offer', next: '#fos-next' },
  { key: 'url', type: 'embed', live: 'https://player.example.com/abc', next: 'https://player.example.com/xyz' },
  { key: 'deadline', type: 'countdown', live: '2026-12-31T23:59:59Z', next: '2027-01-31T23:59:59Z' },
  { key: 'html', type: 'embed', live: '<div class="paid-widget">WIDGET</div>', next: '<div class="paid-widget">NEW</div>' },
  { key: 'items', type: 'product_grid', live: [{ name: 'Kit', href: 'https://shop.example.com/p/kit' }], next: [{ name: 'Bundle' }] },
  { key: 'rows', type: 'table', live: [['A', 'B']], next: [['C', 'D']] },
  { key: 'checked', type: 'order_bump', live: true, next: false },
];

for (const { key, type, live, next } of SECOND_WAVE) {
  const block = () => ({ id: `blk_${key}`, type, props: { headline: 'Original', [key]: live } });

  // 1. OMITTED → carried forward. This is the defect.
  {
    const res = applyOps([block()], [
      { op: 'replace_props', block_id: `blk_${key}`, props: { headline: 'Reworded' } },
    ]);
    ok(!res.error, `B3 ${type}.${key}: a copy-only replace_props is accepted`, res.error);
    eq(res.blocks[0].props[key], live, `B3 ${type}.${key}: SURVIVES an op that never mentioned it`);
    eq(res.blocks[0].props.headline, 'Reworded', `B3 ${type}.${key}: and the copy edit still landed`);
    // The NORMALIZED op is what the editor applies — the floor must be in it.
    eq(res.ops[0].props[key], live, `B3 ${type}.${key}: the op HANDED BACK to the client carries it too`);
  }

  // 2. EXPLICITLY SET → the op wins. Without this the floor would be a
  //    write-protect, and "rewrite the product cards" would silently no-op.
  {
    const res = applyOps([block()], [
      { op: 'replace_props', block_id: `blk_${key}`, props: { headline: 'Reworded', [key]: next } },
    ]);
    ok(!res.error, `B3 ${type}.${key}: an explicit set is accepted`, res.error);
    eq(res.blocks[0].props[key], next, `B3 ${type}.${key}: an EXPLICIT value WINS over the carry-forward`);
  }

  // 3. EXPLICIT NULL → honored. Clearing on purpose is legal.
  {
    const res = applyOps([block()], [
      { op: 'replace_props', block_id: `blk_${key}`, props: { headline: 'Reworded', [key]: null } },
    ]);
    ok(!res.error, `B3 ${type}.${key}: an explicit null is accepted`, res.error);
    eq(res.blocks[0].props[key], null, `B3 ${type}.${key}: an EXPLICIT NULL clears it — deliberate is not the same as silent`);
  }
}

// The whole batch at once, which is how it actually reaches the validator.
{
  const page = [
    { id: 'b_sticky', type: 'sticky_cta', props: { text: 'Buy Now', href: 'https://shop.example.com/checkout' } },
    { id: 'b_grid', type: 'product_grid', props: { items: [{ name: 'Kit' }] } },
    { id: 'b_clock', type: 'countdown', props: { label: 'Ends in', deadline: '2026-12-31T23:59:59Z' } },
    { id: 'b_embed', type: 'embed', props: { html: '<div>W</div>' } },
    { id: 'b_table', type: 'table', props: { rows: [['A', 'B']] } },
    { id: 'b_bump', type: 'order_bump', props: { headline: 'Add it', variant_id: '77', checked: true } },
  ];
  const res = applyOps(page, [
    { op: 'replace_props', block_id: 'b_sticky', props: { text: 'Get Yours' } },
    { op: 'replace_props', block_id: 'b_grid', props: { heading: 'Products' } },
    { op: 'replace_props', block_id: 'b_clock', props: { label: 'Hurry' } },
    { op: 'replace_props', block_id: 'b_embed', props: { title: 'W' } },
    { op: 'replace_props', block_id: 'b_table', props: { caption: 'Specs' } },
    { op: 'replace_props', block_id: 'b_bump', props: { headline: 'Add the warranty' } },
  ]);
  ok(!res.error, 'B3 BATCH: a whole-page reword batch is accepted', res.error);
  eq(res.blocks[0].props.href, 'https://shop.example.com/checkout', 'B3 BATCH: the sticky CTA still points at checkout');
  eq(res.blocks[1].props.items, [{ name: 'Kit' }], 'B3 BATCH: the product grid still has its cards');
  eq(res.blocks[2].props.deadline, '2026-12-31T23:59:59Z', 'B3 BATCH: the countdown still has its deadline');
  eq(res.blocks[3].props.html, '<div>W</div>', 'B3 BATCH: the embed still has its HTML');
  eq(res.blocks[4].props.rows, [['A', 'B']], 'B3 BATCH: the table still has its rows');
  eq(res.blocks[5].props.checked, true, 'B3 BATCH: the order bump is still pre-ticked');
  eq(res.blocks[5].props.variant_id, '77', 'B3 BATCH: and still charges (first-wave key unaffected)');
}

// ===========================================================================
// SEAM AUDIT M15 — link-host change advisories
// ===========================================================================
{
  const page = [{ id: 'b_cta', type: 'sticky_cta', props: { text: 'Buy', href: 'https://shop.example.com/checkout' } }];
  const res = applyOps(page, [
    { op: 'replace_props', block_id: 'b_cta', props: { text: 'Buy', href: 'https://evil.example.net/pay' } },
  ]);
  ok(!res.error, 'M15: a link re-point is APPLIED, not refused — flag, do not block', res.error);
  eq(res.blocks[0].props.href, 'https://evil.example.net/pay', 'M15: the op took effect');
  eq(res.warnings.length, 1, 'M15: exactly one advisory');
  eq(res.warnings[0].from, 'shop.example.com', 'M15: the advisory names the OLD host');
  eq(res.warnings[0].to, 'evil.example.net', 'M15: and the NEW host');
  eq(res.warnings[0].key, 'href', 'M15: and which prop moved');
  eq(res.warnings[0].block_type, 'sticky_cta', 'M15: and the block type, for the amber row');
}
{
  // Same host, different path → NOT flagged. A validator that cries wolf on
  // every copy edit gets ignored, which is the same as not having one.
  const page = [{ id: 'b_cta', type: 'sticky_cta', props: { href: 'https://shop.example.com/a?x=1' } }];
  const res = applyOps(page, [
    { op: 'replace_props', block_id: 'b_cta', props: { href: 'https://shop.example.com/b?x=2' } },
  ]);
  eq(res.warnings.length, 0, 'M15: a SAME-HOST path/query change is NOT flagged');
}
{
  const page = [{ id: 'b_cta', type: 'sticky_cta', props: { href: 'https://shop.example.com/checkout' } }];
  const res = applyOps(page, [{ op: 'replace_props', block_id: 'b_cta', props: { text: 'Buy' } }]);
  eq(res.warnings.length, 0,
    'M15: an op that never mentions the link is NOT flagged — the floor carried it, nothing moved');
}
{
  // The money link explicitly killed. Absolute → '#' is the B3 symptom made
  // deliberate, and the operator should still see it.
  const page = [{ id: 'b_cta', type: 'sticky_cta', props: { href: 'https://shop.example.com/checkout' } }];
  const res = applyOps(page, [{ op: 'replace_props', block_id: 'b_cta', props: { href: '#' } }]);
  eq(res.warnings.length, 1, 'M15: an absolute link explicitly replaced by "#" IS flagged');
  eq(res.warnings[0].to, null, 'M15: with a null "to" host the panel renders as "same-site"');
}
{
  // Per-item links inside a product grid — where a grid's money links live.
  const page = [{
    id: 'b_grid', type: 'product_grid',
    props: { items: [{ name: 'A', href: 'https://shop.example.com/a' }, { name: 'B', href: 'https://shop.example.com/b' }] },
  }];
  const res = applyOps(page, [{
    op: 'replace_props', block_id: 'b_grid',
    props: { items: [{ name: 'A', href: 'https://shop.example.com/a' }, { name: 'B', href: 'https://elsewhere.example.org/b' }] },
  }]);
  eq(res.warnings.length, 1, 'M15: a per-ITEM link host change is flagged');
  eq(res.warnings[0].key, 'items[1].href', 'M15: and the advisory names the index');
  eq(res.warnings[0].to, 'elsewhere.example.org', 'M15: with the new host');
}
{
  // Totality — link detection must never throw on model-supplied junk.
  const page = [{ id: 'b_cta', type: 'sticky_cta', props: { href: 'https://shop.example.com/x' } }];
  for (const junk of [null, 42, {}, [], 'not a url', 'javascript:alert(1)', 'mailto:a@b.co', '', '   ']) {
    const res = applyOps(page, [{ op: 'replace_props', block_id: 'b_cta', props: { href: junk } }]);
    ok(!res.error || typeof res.error === 'string', `M15: href=${JSON.stringify(junk)} does not throw`);
  }
  const res = applyOps(page, [{ op: 'replace_props', block_id: 'b_cta', props: { items: 'not-an-array' } }]);
  ok(!res.error, 'M15: a non-array items does not throw the per-item walk', res.error);
}
{
  eq(linkHost('https://Shop.Example.COM/x'), 'shop.example.com', 'linkHost lowercases the host');
  eq(linkHost('https://shop.example.com:8443/x'), 'shop.example.com:8443', 'linkHost keeps a non-default port — a different port is a different origin');
  eq(linkHost('#fos-next'), null, 'linkHost: an in-page anchor has no host');
  eq(linkHost('/checkout'), null, 'linkHost: a root-relative path has no host');
  eq(linkHost('?step=2'), null, 'linkHost: a query-only link has no host');
  eq(linkHost('mailto:a@b.co'), null, 'linkHost: mailto has no host');
  eq(linkHost(undefined), null, 'linkHost: undefined → null, never throws');
  eq(linkHost(''), null, 'linkHost: empty string → null');
}
{
  // detectLinkHostChanges directly — it is exported, so it is part of the
  // contract and must be total on its own, not only as applyOps drives it.
  const blk = { id: 'b', type: 'button' };
  eq(detectLinkHostChanges(null, null, blk), [], 'detectLinkHostChanges: null/null → [], never throws');
  eq(detectLinkHostChanges({}, {}, blk), [], 'detectLinkHostChanges: empty props → []');
  eq(detectLinkHostChanges({ href: 'https://a.example.com' }, { href: 'https://a.example.com' }, blk), [],
    'detectLinkHostChanges: an unchanged link → []');
  const moved = detectLinkHostChanges(
    { href: 'https://a.example.com/x', cta_href: 'https://a.example.com/y' },
    { href: 'https://b.example.net/x', cta_href: 'https://a.example.com/y' },
    blk
  );
  eq(moved.length, 1, 'detectLinkHostChanges: reports ONLY the prop whose host moved');
  eq(moved[0].key, 'href', 'detectLinkHostChanges: naming that prop');
  eq(moved[0].from_url, 'https://a.example.com/x', 'and carrying the old URL for the operator');
  const multi = detectLinkHostChanges(
    { href: 'https://a.example.com', cta_href: 'https://a.example.com', url: 'https://a.example.com' },
    { href: 'https://b.example.net', cta_href: 'https://c.example.org', url: 'https://d.example.io' },
    blk
  );
  eq(multi.length, 3, 'detectLinkHostChanges: all three link props are covered');
  eq(multi.map((w) => w.key), ['href', 'cta_href', 'url'], 'in LINK_PROP_KEYS order');
}

eq(mergeReplaceProps(null, null), {}, 'mergeReplaceProps: null/null → {}, never throws');
eq(mergeReplaceProps({ variant_id: '9' }, undefined), { variant_id: '9' }, 'mergeReplaceProps: absent next → the floor alone');
ok(Object.isFrozen(WIRING_KEYS), 'the floor is frozen — no caller can widen it at runtime');
ok(Object.isFrozen(CLIENT_WIRING_KEYS), 'the CLIENT floor is frozen too');

// THE MIRROR ASSERTION, DONE PROPERLY.
//
// This used to compare the server floor against a hardcoded literal while its
// message CLAIMED byte-identity with builderModel.js — it never read the client
// file at all, so the two lists could drift apart and this stayed green. It now
// imports the client floor and compares them directly, ORDER INCLUDED.
eq([...WIRING_KEYS], [...CLIENT_WIRING_KEYS],
  'the SERVER floor is byte-identical to the CLIENT floor — same keys, same ORDER, both files actually read');
eq(
  [...WIRING_KEYS].sort(),
  [
    'block_name', 'checked', 'cta_href', 'deadline', 'href', 'html', 'items',
    'line_items', 'mobile_styles', 'offer_id', 'price_id', 'product_id',
    'quantity', 'rows', 'style', 'url', 'variant_id',
  ],
  'and the floor is the expected 17 keys — a mirrored edit to BOTH files is still caught here'
);
eq(WIRING_KEYS.length, 17, 'the floor is 17 keys (9 original + 8 from seam audit B3)');
eq(new Set(WIRING_KEYS).size, WIRING_KEYS.length, 'with no duplicates');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
