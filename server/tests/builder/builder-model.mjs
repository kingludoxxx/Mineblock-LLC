// Unit verification for the BUILDER-UX pure helpers
// (client/src/pages/funnels/builder/builderModel.js).
//
// They are dependency-free on purpose so node can drive them directly. The
// cases that matter are the DEGRADED ones: `blocks` is operator/AI-authored
// JSON validated only for {type: string, props: object}, so every function
// here must survive nulls, missing ids, wrong-typed props and hostile strings
// without throwing — a render pass that throws white-screens the builder.
//
// Run:  node server/tests/builder/builder-model.mjs
import {
  buildOutline, defaultLabel, blockCodeSections, editableCount, safeJson,
  parseInlineMarkup, bumpHeadline, bumpUnconfigured, blockNameAttr,
  isSlugCollision, escapeHtml, SERVER_GENERATED_NOTE,
} from '../../../client/src/pages/funnels/builder/builderModel.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

// ===========================================================================
// buildOutline
// ===========================================================================
const B = (id, type, props = {}) => ({ id, type, props });

{
  const rows = buildOutline([B('a', 'heading'), B('b', 'text')]);
  eq(rows.length, 2, 'outline: flat list of 2');
  eq(rows.map((r) => r.index), [0, 1], 'outline: index tracks array position');
  eq(rows.every((r) => r.depth === 0 && r.movable), true, 'outline: top-level rows are depth 0 and movable');
}

{
  // A row block nests its columns as depth-1, NON-movable rows pointing at the
  // parent index — a drag reading index off a child must move the PARENT.
  const rows = buildOutline([
    B('r', 'row', { columns: [{ html: 'x' }, { html: 'y' }] }),
    B('z', 'text'),
  ]);
  eq(rows.map((r) => [r.type, r.depth, r.index, r.movable]), [
    ['row', 0, 0, true],
    ['column', 1, 0, false],
    ['column', 1, 0, false],
    ['text', 0, 1, true],
  ], 'outline: row columns nest at depth 1, non-movable, parent index');
  eq(rows[1].parentId, 'r', 'outline: column carries parentId');
  eq(new Set(rows.map((r) => r.key)).size, 4, 'outline: keys are unique across parents and children');
}

{
  // Only `row` nests. A columns prop on another type must not sprout children.
  const rows = buildOutline([B('s', 'section', { columns: [{}, {}] })]);
  eq(rows.length, 1, 'outline: columns on a non-row type does NOT nest');
}

// ---- degraded inputs ------------------------------------------------------
eq(buildOutline(null), [], 'outline: null blocks → []');
eq(buildOutline(undefined), [], 'outline: undefined → []');
eq(buildOutline('nope'), [], 'outline: a string → []');
eq(buildOutline([]), [], 'outline: empty → []');
{
  const rows = buildOutline([null, 'str', 42, [], B('a', 'text')]);
  eq(rows.length, 1, 'outline: null / primitive / array entries are dropped, not rendered as ghosts');
  eq(rows[0].id, 'a', 'outline: the one real block survives');
}
{
  // A block with no id still renders (it is visible on the canvas) but is not
  // addressable — the key must not collide with a sibling.
  const rows = buildOutline([{ type: 'text', props: {} }, { type: 'text', props: {} }]);
  eq(rows.map((r) => r.id), [null, null], 'outline: missing id → null, never invented');
  eq(new Set(rows.map((r) => r.key)).size, 2, 'outline: id-less blocks still get distinct keys');
}
{
  const rows = buildOutline([{ id: 'a', props: {} }]);
  eq(rows[0].type, 'unknown', 'outline: missing type → "unknown", never undefined');
}
{
  const rows = buildOutline([B('r', 'row', { columns: 'not-an-array' })]);
  eq(rows.length, 1, 'outline: row with a non-array columns prop does not throw or nest');
}
{
  const rows = buildOutline([B('r', 'row', null)]);
  eq(rows.length, 1, 'outline: row with null props does not throw');
}

// ---- labels ---------------------------------------------------------------
eq(defaultLabel(B('a', 'text', { block_name: '  Hero copy  ' })), 'Hero copy', 'label: block_name trimmed and preferred');
eq(defaultLabel(B('a', 'text', { block_name: '   ' })), 'text', 'label: whitespace-only block_name falls back to type');
eq(defaultLabel({}), 'Unknown', 'label: no type at all → Unknown');
{
  const rows = buildOutline([B('a', 'text')], () => '');
  eq(rows[0].label, 'text', 'label: an injected labelFor returning "" falls back to type, never blank');
  const rows2 = buildOutline([B('a', 'text')], () => null);
  eq(rows2[0].label, 'text', 'label: an injected labelFor returning null falls back to type');
}
{
  const rows = buildOutline([B('a', 'text')], 'not-a-function');
  eq(rows[0].label, 'text', 'label: a non-function labelFor is ignored rather than called');
}

// ===========================================================================
// blockCodeSections
// ===========================================================================
{
  const secs = blockCodeSections([
    B('a', 'custom_html', { html: '<p>hi</p>', css: '.x{}' }),
    B('b', 'heading', { text: 'Yo' }),
    B('c', 'html', { html: '<b>x</b>' }),
  ]);
  eq(secs.map((s) => s.editable), [true, false, true], 'code: only escape-hatch types are editable');
  eq(secs[0].html, '<p>hi</p>', 'code: html prop read through');
  eq(secs[0].css, '.x{}', 'code: css prop read through (custom_html only)');
  eq(secs[2].cssProp, null, 'code: html type has no css prop');
  eq(secs[1].note, SERVER_GENERATED_NOTE, 'code: a server-rendered block explains itself');
  eq(editableCount(secs), 2, 'code: editableCount');
}
{
  // An editable TYPE with no id has no write target — it must degrade to
  // read-only rather than offering a textarea whose edits land nowhere.
  const secs = blockCodeSections([{ type: 'custom_html', props: { html: 'x' } }]);
  eq(secs[0].editable, false, 'code: editable type without an id degrades to read-only');
  ok(/no id yet/i.test(secs[0].note), 'code: and says why', secs[0].note);
}
{
  // A controlled textarea fed null flips to uncontrolled — html/css must be
  // strings ALWAYS, even when the prop is missing or wrong-typed.
  const secs = blockCodeSections([
    B('a', 'custom_html', {}),
    B('b', 'custom_html', { html: 42, css: null }),
  ]);
  eq([secs[0].html, secs[0].css], ['', ''], 'code: missing props → empty strings, never null');
  eq([secs[1].html, secs[1].css], ['', ''], 'code: wrong-typed props → empty strings, never null');
}
eq(blockCodeSections(null), [], 'code: null blocks → []');
eq(blockCodeSections([null, 7]), [], 'code: junk entries dropped');
eq(editableCount(null), 0, 'code: editableCount(null) → 0');
{
  const secs = blockCodeSections([B('a', 'text', null)]);
  eq(secs[0].propsJson, '{}', 'code: null props serialize as {}');
}

// ---- safeJson -------------------------------------------------------------
{
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const out = safeJson(cyclic);
  ok(typeof out === 'string' && /circular/i.test(out), 'safeJson: a cycle returns a message, never throws', out);
}
eq(safeJson(undefined), 'undefined', 'safeJson: undefined stringifies rather than crashing');

// ===========================================================================
// parseInlineMarkup — the ALLOW-LIST. Failure mode must be "shows brackets".
// ===========================================================================
const flat = (s) => parseInlineMarkup(s).map((x) => [x.text, x.bold, x.underline]);

eq(flat('plain'), [['plain', false, false]], 'markup: plain text is one segment');
eq(flat('a<b>B</b>c'), [['a', false, false], ['B', true, false], ['c', false, false]], 'markup: <b> honoured');
eq(flat('<u>U</u>'), [['U', false, true]], 'markup: <u> honoured');
eq(flat('<b><u>x</u></b>'), [['x', true, true]], 'markup: nesting combines flags');
eq(flat('<B>X</B>'), [['X', true, false]], 'markup: tags are case-insensitive');

{
  // The whole point: a script tag is NOT markup here, it is text.
  const segs = parseInlineMarkup('<script>alert(1)</script>');
  eq(segs.map((s) => s.text).join(''), '<script>alert(1)</script>', 'markup: <script> stays literal text');
  eq(segs.every((s) => !s.bold && !s.underline), true, 'markup: and carries no formatting');
}
{
  // The security-relevant claim: an attribute-bearing tag is NOT recognised,
  // so the opening tag survives as literal text and nothing becomes bold.
  // (The matching `</b>` IS in the allow-list and is consumed as a stray
  // close — lossy for that token, but it cannot produce markup either way.)
  const segs = parseInlineMarkup('<b onclick="evil()">x</b>');
  ok(segs.map((s) => s.text).join('').includes('<b onclick="evil()">'),
    'markup: an ATTRIBUTE on <b> is not recognised — the opening tag stays literal text',
    segs.map((s) => s.text).join(''));
  eq(segs.every((s) => !s.bold), true, 'markup: and an attribute-bearing <b> never turns anything bold');
}
{
  const segs = parseInlineMarkup('<img src=x onerror=alert(1)>');
  eq(segs.map((s) => s.text).join(''), '<img src=x onerror=alert(1)>', 'markup: <img onerror> stays literal text');
}
{
  // Nesting-sanitizer bypass: a naive strip would turn this INTO a script tag.
  const segs = parseInlineMarkup('<scr<b></b>ipt>');
  eq(segs.map((s) => s.text).join(''), '<scr' + 'ipt>', 'markup: split-tag smuggling leaves inert text (the <b></b> is consumed as formatting)');
}
eq(flat('</b>x'), [['x', false, false]], 'markup: a stray closing tag does not go negative');
eq(flat('<b>x'), [['x', true, false]], 'markup: an unclosed <b> still formats what follows, no throw');
eq(parseInlineMarkup(null), [], 'markup: null → []');
eq(parseInlineMarkup(''), [], 'markup: empty → []');
eq(flat(123), [['123', false, false]], 'markup: a number is coerced, not crashed on');

// escapeHtml still guards anything that DOES go to a string sink.
eq(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;', 'escapeHtml: &, <, > all escaped');
eq(escapeHtml(null), '', 'escapeHtml: null → empty');

// ===========================================================================
// bumpHeadline / bumpUnconfigured / blockNameAttr
// ===========================================================================
eq(bumpHeadline({ headline: 'Custom line' }), 'Custom line', 'headline: explicit wins');
eq(bumpHeadline({ headline: '   ', offer_name: 'KIT', price: '$19' }), 'Yes, I want the KIT for ONLY $19', 'headline: blank headline auto-builds');
eq(bumpHeadline({ offer_name: 'KIT' }), 'Yes, I want the KIT', 'headline: no price → no money claim, and NO dangling "for ONLY $"');
eq(bumpHeadline({ price: '$19' }), 'Yes, I want the offer', 'headline: price without a name → generic');
eq(bumpHeadline({}), 'Yes, I want the offer', 'headline: empty → generic fallback');
eq(bumpHeadline(), 'Yes, I want the offer', 'headline: no argument at all → generic fallback');
eq(bumpHeadline(null), 'Yes, I want the offer', 'headline: null → generic fallback');
eq(bumpHeadline({ offer_name: 'KIT', price: 19 }), 'Yes, I want the KIT for ONLY 19', 'headline: a numeric price is coerced');
ok(!/ONLY\s*$/.test(bumpHeadline({ offer_name: 'KIT', price: '   ' })), 'headline: whitespace-only price never yields a truncated money claim');

eq(bumpUnconfigured({}), true, 'bump: no variant_id → unconfigured');
eq(bumpUnconfigured({ variant_id: '   ' }), true, 'bump: whitespace variant_id → unconfigured');
eq(bumpUnconfigured({ variant_id: '123' }), false, 'bump: a real variant_id → configured');
eq(bumpUnconfigured(null), true, 'bump: null props → unconfigured');
eq(bumpUnconfigured({ variant_id: 123 }), false, 'bump: a numeric variant_id counts as configured');

eq(blockNameAttr({ block_name: ' hero ' }), 'hero', 'blockName: trimmed');
eq(blockNameAttr({ block_name: '   ' }), '', 'blockName: whitespace-only → "" so the attribute is omitted');
eq(blockNameAttr({}), '', 'blockName: absent → ""');
eq(blockNameAttr(null), '', 'blockName: null props → ""');
eq(blockNameAttr({ block_name: 5 }), '', 'blockName: a non-string is not emitted');

// ===========================================================================
// isSlugCollision
// ===========================================================================
eq(isSlugCollision('A page with this slug already exists in this funnel'), true, 'slug: the server refusal is recognised');
eq(isSlugCollision('A funnel with this slug already exists'), true, 'slug: the funnel-level refusal also matches the field hint');
eq(isSlugCollision('blocks exceed the 2MB limit'), false, 'slug: an unrelated refusal does NOT claim a slug collision');
eq(isSlugCollision(null), false, 'slug: null → false');
eq(isSlugCollision(undefined), false, 'slug: undefined → false');
eq(isSlugCollision(''), false, 'slug: empty → false');
eq(isSlugCollision({}), false, 'slug: an object → false, never throws');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
