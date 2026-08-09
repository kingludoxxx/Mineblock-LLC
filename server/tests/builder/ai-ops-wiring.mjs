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
import { applyOps, mergeReplaceProps, WIRING_KEYS } from '../../src/routes/aiDeveloper.js';

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

eq(mergeReplaceProps(null, null), {}, 'mergeReplaceProps: null/null → {}, never throws');
eq(mergeReplaceProps({ variant_id: '9' }, undefined), { variant_id: '9' }, 'mergeReplaceProps: absent next → the floor alone');
ok(Object.isFrozen(WIRING_KEYS), 'the floor is frozen — no caller can widen it at runtime');
eq(
  [...WIRING_KEYS].sort(),
  ['block_name', 'line_items', 'mobile_styles', 'offer_id', 'price_id', 'product_id', 'quantity', 'style', 'variant_id'],
  'the SERVER floor is byte-identical to the client floor in builderModel.js'
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
