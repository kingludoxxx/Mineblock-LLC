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
  isSlugCollision, escapeHtml, displayPrice, bumpNameColor,
  refusedSaveField, retryFieldsAfterRefusal, mergeReplaceProps, WIRING_KEYS,
  resyncMeta, metaFromPage, recordRefusal, clearRefusals, META_FIELDS,
  BUMP_DEFAULT_HEADLINE, BUMP_DEFAULT_NAME_COLOR, SERVER_GENERATED_NOTE,
  listRows, addListRow, removeListRow, moveListRow, setListCell,
  comparisonColumns, addComparisonColumn, renameComparisonColumn,
  removeComparisonColumn, comparisonDefaultRow, moveWouldChangeColumns,
  isoFromLocalInput, localInputFromIso, localInputAnomaly, countdownPreview,
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
  // F17: duplicate ids are reachable (hand-edited paste, AI insert_block
  // echoing an id). Two React children with the same key silently drop a row,
  // so the DISPLAY must stay honest even when the data is not.
  const rows = buildOutline([B('dup', 'text'), B('dup', 'heading'), B('dup', 'button')]);
  eq(rows.length, 3, 'F17: three blocks sharing an id all render');
  eq(new Set(rows.map((r) => r.key)).size, 3, 'F17: and their React keys are DISTINCT');
  eq(rows.map((r) => r.id), ['dup', 'dup', 'dup'], 'F17: the underlying id is NOT rewritten — only the key');
  eq(rows.map((r) => r.index), [0, 1, 2], 'F17: each keeps its own array index');
}
{
  // A duplicate id colliding with a row's column key must also stay distinct.
  const rows = buildOutline([B('x', 'row', { columns: [{}, {}] }), B('x', 'row', { columns: [{}] })]);
  eq(new Set(rows.map((r) => r.key)).size, rows.length, 'F17: duplicate parents AND their columns keep unique keys');
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
// ===========================================================================
// bumpHeadline / bumpNameColor — PINNED TO THE SERVER RENDERER.
// funnelRender.js order_bump resolves:
//   p.headline -> `Yes, I want the ${offer_name}!` -> p.label -> default
// and its auto-headline carries NO PRICE. Every case below is that contract;
// if the renderer changes, these fail and the canvas stops lying quietly.
// ===========================================================================
eq(bumpHeadline({ headline: 'Custom line' }), 'Custom line', 'headline: explicit `headline` wins');
eq(bumpHeadline({ headline: 'H', offer_name: 'KIT', label: 'L' }), 'H', 'headline: `headline` beats offer_name AND label');
eq(bumpHeadline({ offer_name: 'KIT', label: 'L' }), 'Yes, I want the KIT!', 'headline: offer_name beats the legacy label');
eq(bumpHeadline({ offer_name: 'KIT' }), 'Yes, I want the KIT!', 'headline: auto form matches the server WORD FOR WORD (trailing !)');
eq(bumpHeadline({ label: 'Legacy line' }), 'Legacy line', 'headline: the LEGACY `label` key is still honoured');
eq(bumpHeadline({ headline: '   ', offer_name: 'KIT' }), 'Yes, I want the KIT!', 'headline: blank headline falls through');
eq(bumpHeadline({}), BUMP_DEFAULT_HEADLINE, 'headline: the default string matches the server default');

// THE PRICE MUST NOT APPEAR. The server never inserts one, so a canvas that
// advertised "for ONLY $19" would be previewing money the page never prints.
ok(!/ONLY/.test(bumpHeadline({ offer_name: 'KIT', price: '$19' })), 'headline: props.price is NEVER spliced into the auto-headline (the server does not)');
eq(bumpHeadline({ offer_name: 'KIT', price: '$19' }), 'Yes, I want the KIT!', 'headline: price present changes nothing');

// ---- bumpNameColor: the server's strict hex gate, mirrored ---------------
eq(bumpNameColor({ offer_name_color: '#abc' }), '#abc', 'nameColor: 3-digit hex accepted');
eq(bumpNameColor({ offer_name_color: '#112233' }), '#112233', 'nameColor: 6-digit hex accepted');
eq(bumpNameColor({ offer_name_color: '#11223344' }), '#11223344', 'nameColor: 8-digit hex accepted');
eq(bumpNameColor({ offer_name_color: 'red' }), BUMP_DEFAULT_NAME_COLOR, 'nameColor: a NAMED colour is refused here exactly as the server refuses it');
eq(bumpNameColor({ offer_name_color: 'rgb(1,2,3)' }), BUMP_DEFAULT_NAME_COLOR, 'nameColor: rgb() refused');
eq(bumpNameColor({ offer_name_color: '#12' }), BUMP_DEFAULT_NAME_COLOR, 'nameColor: too-short hex refused');
eq(bumpNameColor({ offer_name_color: 'red;background:url(x)' }), BUMP_DEFAULT_NAME_COLOR, 'nameColor: a CSS-injection attempt is refused');
eq(bumpNameColor({}), BUMP_DEFAULT_NAME_COLOR, 'nameColor: absent → the default ink');
eq(bumpNameColor(null), BUMP_DEFAULT_NAME_COLOR, 'nameColor: null props → the default ink');

// ---- F15: displayPrice (canvas chrome only) ------------------------------
eq(displayPrice('$19.00'), '$19.00', 'displayPrice: a real amount passes through');
eq(displayPrice(0), '', 'displayPrice: 0 → ""');
eq(displayPrice('0.00'), '', 'displayPrice: "0.00" → ""');
eq(displayPrice(null), '', 'displayPrice: null → ""');
eq(displayPrice('   '), '', 'displayPrice: whitespace → ""');
eq(displayPrice('$19'), '$19', 'displayPrice: currency symbol preserved');
eq(displayPrice('Free'), 'Free', 'displayPrice: a non-numeric label is kept as written');
eq(bumpHeadline({ price: '$19' }), BUMP_DEFAULT_HEADLINE, 'headline: price without a name → the default string');
eq(bumpHeadline({}), BUMP_DEFAULT_HEADLINE, 'headline: empty → default');
eq(bumpHeadline(), BUMP_DEFAULT_HEADLINE, 'headline: no argument at all → default');
eq(bumpHeadline(null), BUMP_DEFAULT_HEADLINE, 'headline: null → default');
ok(!/ONLY\s*$/.test(bumpHeadline({ offer_name: 'KIT', price: '   ' })), 'headline: whitespace-only price never yields a truncated money claim');

eq(bumpUnconfigured({}), true, 'bump: no variant_id → unconfigured');
eq(bumpUnconfigured({ variant_id: '   ' }), true, 'bump: whitespace variant_id → unconfigured');
eq(bumpUnconfigured({ variant_id: '123' }), false, 'bump: a real variant_id → configured');
eq(bumpUnconfigured(null), true, 'bump: null props → unconfigured');
eq(bumpUnconfigured({ variant_id: 123 }), false, 'bump: a numeric variant_id counts as configured');
// F14: the server does `String(bp.variant_id || '').trim()`. These four are
// unwired THERE, so the canvas must not call them wired — `??` would.
eq(bumpUnconfigured({ variant_id: 0 }), true, 'F14: variant_id 0 → unconfigured (matches the server\'s ||, not ??)');
eq(bumpUnconfigured({ variant_id: '' }), true, 'F14: variant_id "" → unconfigured');
eq(bumpUnconfigured({ variant_id: false }), true, 'F14: variant_id false → unconfigured');
eq(bumpUnconfigured({ variant_id: null }), true, 'F14: variant_id null → unconfigured');

eq(blockNameAttr({ block_name: ' hero ' }), 'hero', 'blockName: trimmed');
eq(blockNameAttr({ block_name: '   ' }), '', 'blockName: whitespace-only → "" so the attribute is omitted');
eq(blockNameAttr({}), '', 'blockName: absent → ""');
eq(blockNameAttr(null), '', 'blockName: null props → ""');
eq(blockNameAttr({ block_name: 5 }), '', 'blockName: a non-string is not emitted');

// ===========================================================================
// isSlugCollision
// ===========================================================================
eq(isSlugCollision('A page with this slug already exists in this funnel'), true, 'slug: the server refusal is recognised');
// F16: the FUNNEL-level refusal is a different field on a different screen —
// matching it would point the operator at the page slug box for a problem
// that is not there.
eq(isSlugCollision('A funnel with this slug already exists'), false, 'F16: the FUNNEL-level refusal does NOT flag the page slug field');
eq(isSlugCollision('blocks exceed the 2MB limit'), false, 'slug: an unrelated refusal does NOT claim a slug collision');
eq(isSlugCollision(null), false, 'slug: null → false');
eq(isSlugCollision(undefined), false, 'slug: undefined → false');
eq(isSlugCollision(''), false, 'slug: empty → false');
eq(isSlugCollision({}), false, 'slug: an object → false, never throws');

// ===========================================================================
// refusedSaveField (F5) — one refused field must not poison the whole batch
// ===========================================================================
eq(
  refusedSaveField('A page with this slug already exists in this funnel'), 'slug',
  'F5: the page-slug 409 NAMES the slug field, so the engine can hold just that one back'
);
eq(
  refusedSaveField('A funnel with this slug already exists'), null,
  'F5: the FUNNEL-level refusal names no page field — the whole batch is retried'
);
eq(
  refusedSaveField('blocks exceed the 2MB limit'), null,
  'F5: a refusal that is not field-scoped returns null, so nothing is silently dropped'
);
eq(refusedSaveField(null), null, 'F5: null → null');
eq(refusedSaveField(undefined), null, 'F5: undefined → null');
eq(refusedSaveField(''), null, 'F5: empty → null');
eq(refusedSaveField({}), null, 'F5: an object → null, never throws');

// The retry set is what actually breaks the poisoning loop: everything the
// refused PATCH carried, minus the field the refusal named.
{
  const carried = ['title', 'slug', 'blocks', 'custom_css'];
  eq(
    retryFieldsAfterRefusal(carried, 'A page with this slug already exists in this funnel'),
    ['title', 'blocks', 'custom_css'],
    'F5: a slug collision re-queues every OTHER field — the title and the blocks still save'
  );
  eq(
    retryFieldsAfterRefusal(carried, 'A page with this slug already exists in this funnel').includes('slug'),
    false,
    'F5: the refused field is NOT re-queued, so the next save is not refused for the same reason'
  );
  eq(
    retryFieldsAfterRefusal(carried, 'blocks exceed the 2MB limit'), carried,
    'F5: a refusal that names no field re-queues the WHOLE batch — nothing is dropped on a guess'
  );
  eq(
    retryFieldsAfterRefusal(['blocks'], 'A page with this slug already exists in this funnel'), ['blocks'],
    'F5: a batch that never carried the slug is untouched by a slug refusal'
  );
  eq(
    retryFieldsAfterRefusal(['slug'], 'A page with this slug already exists in this funnel'), [],
    'F5: a slug-only batch retries nothing — the operator edits the field to re-arm it'
  );
  eq(retryFieldsAfterRefusal([], 'anything'), [], 'F5: empty in, empty out');
  eq(retryFieldsAfterRefusal(null, 'anything'), [], 'F5: a non-array → [], never throws');
  eq(
    retryFieldsAfterRefusal(carried, null), carried,
    'F5: a null error (network abort) re-queues everything — an unread refusal is not a named one'
  );
}

// ===========================================================================
// resyncMeta — THE PHANTOM SLUG (F5-b)
//
// The gating defect the F5 fix introduced. Holding the refused field out of
// the dirty set stops the poisoning, but the refused VALUE stayed in `meta`,
// which is what the slug box renders — so the box showed a slug that existed
// nowhere but the browser, and the next successful save of anything else
// cleared the banner. Chip: "Saved". Box: a slug the server never accepted.
// ===========================================================================
{
  // The exact sequence: operator typed /checkout, server refused it, page is
  // still at /checkout-2, and a LATER save of the blocks succeeds.
  const afterRefusal = { title: 'Checkout', slug: '/checkout', status: 'draft' };
  const serverPage = { title: 'Checkout', slug: '/checkout-2', status: 'draft' };
  const next = resyncMeta(afterRefusal, serverPage, new Set(['blocks']));
  eq(next.slug, '/checkout-2', 'F5-b: the refused slug is replaced by the one the server actually holds');
  eq(next.title, 'Checkout', 'F5-b: untouched fields are left alone');
}
{
  // The re-sync must NOT eat keystrokes typed while the PATCH was in flight.
  const current = { title: 'New title', slug: '/a', status: 'draft' };
  const serverPage = { title: 'Old title', slug: '/a', status: 'draft' };
  const next = resyncMeta(current, serverPage, new Set(['title']));
  eq(next.title, 'New title', 'F5-b: a field STILL DIRTY belongs to the operator and is not overwritten');
}
{
  // Identity when nothing moved, so React bails out of the re-render.
  const current = { title: 't', slug: '/a', status: 'draft' };
  ok(
    resyncMeta(current, { title: 't', slug: '/a', status: 'draft' }, new Set()) === current,
    'F5-b: an unchanged re-sync returns the SAME object (no render churn)'
  );
  ok(
    resyncMeta(current, null, new Set()) === current,
    'F5-b: a response with no page is not authority to overwrite anything'
  );
  ok(
    resyncMeta(current, undefined, []) === current,
    'F5-b: undefined page → identity, never throws'
  );
}
{
  // Status rides the same path — this is what makes the publish flip honest.
  const next = resyncMeta({ title: '', slug: '/', status: 'draft' }, { status: 'published' }, []);
  eq(next.status, 'published', 'F5-b: status is re-synced from the response too');
  eq(next.slug, '/', 'F5-b: an absent slug on the row reads as "/", matching load()');
  eq(next.title, '', 'F5-b: an absent title reads as "", matching load()');
}
eq(
  metaFromPage(null), { title: '', slug: '/', status: 'draft' },
  'F5-b: metaFromPage(null) is the same default load() uses, never throws'
);
eq([...META_FIELDS], ['title', 'slug', 'status'], 'F5-b: the re-synced field set is exactly the meta bag');
ok(Object.isFrozen(META_FIELDS), 'F5-b: the field list is frozen');

// ===========================================================================
// recordRefusal / clearRefusals — STICKINESS (F5-b)
//
// The banner rides on `saveError`, which the next successful save clears. A
// refusal whose field is no longer queued would vanish while its cause was
// unresolved, so it is kept per-FIELD until a write actually carries it.
// ===========================================================================
{
  const msg = 'A page with this slug already exists in this funnel';
  const r1 = recordRefusal({}, msg, { slug: '/checkout', blocks: [] });
  eq(r1.slug.value, '/checkout', 'F5-b: the refusal remembers the value that was REJECTED, not the live one');
  eq(r1.slug.message, msg, 'F5-b: the refusal keeps the server message verbatim');

  // A save of something ELSE must not clear it — that is the whole point.
  const r2 = clearRefusals(r1, ['blocks', 'title']);
  ok(r2.slug, 'F5-b: a successful save of OTHER fields leaves the slug refusal standing');
  ok(r2 === r1, 'F5-b: …and returns the same object, so nothing re-renders');

  // A save that CARRIES the slug clears it.
  const r3 = clearRefusals(r1, ['slug', 'blocks']);
  eq(Object.keys(r3), [], 'F5-b: a write that carries the slug clears its refusal');
}
{
  const msg = 'A page with this slug already exists in this funnel';
  // A second collision replaces the record rather than stacking.
  const r1 = recordRefusal({}, msg, { slug: '/a' });
  const r2 = recordRefusal(r1, msg, { slug: '/b' });
  eq(r2.slug.value, '/b', 'F5-b: a fresh collision replaces the remembered value');
  eq(Object.keys(r2).length, 1, 'F5-b: refusals key by field, they do not stack');
}
{
  // A refusal that names NO field records nothing — there is no box to flag.
  const r = recordRefusal({}, 'blocks exceed the 2MB limit', { blocks: [] });
  eq(Object.keys(r), [], 'F5-b: an unscoped refusal records no field marker');
  ok(recordRefusal({}, null, null) !== undefined, 'F5-b: null error / null payload → {}, never throws');
  eq(clearRefusals(null, ['slug']), {}, 'F5-b: a null map → {}, never throws');
  eq(clearRefusals({ slug: { message: 'x' } }, null), { slug: { message: 'x' } }, 'F5-b: a non-array field list is a no-op');
}
{
  // END-TO-END of the reported defect, as state transitions.
  const msg = 'A page with this slug already exists in this funnel';
  let meta = { title: 'T', slug: '/taken', status: 'draft' };   // operator typed it
  let refusals = {};
  // 1. the PATCH carrying title+slug is refused
  refusals = recordRefusal(refusals, msg, { title: 'T', slug: '/taken' });
  const retry = retryFieldsAfterRefusal(['title', 'slug'], msg);
  eq(retry, ['title'], 'end-to-end: the slug is held back, the title still retries');
  // 2. a later save of blocks succeeds and the response carries the real page
  meta = resyncMeta(meta, { title: 'T', slug: '/live', status: 'draft' }, new Set());
  refusals = clearRefusals(refusals, ['blocks']);
  eq(meta.slug, '/live', 'end-to-end: the box now shows the slug the SERVER holds');
  ok(refusals.slug, 'end-to-end: …and the refusal is STILL on screen saying /taken was rejected');
  eq(refusals.slug.value, '/taken', 'end-to-end: naming the value the operator tried');
}

// ===========================================================================
// mergeReplaceProps (F4) — the AI wiring floor
//
// replace_props is a WHOLESALE overwrite. The floor is what stops an AI batch
// that re-emits a checkout block's copy from deleting the wiring that makes it
// charge. Client half; routes/aiDeveloper.js mirrors it.
// ===========================================================================
{
  const prev = {
    headline: 'Old', variant_id: '4455', line_items: [{ id: 1 }], offer_id: 'of_1',
    quantity: 2, style: { color: 'red' }, mobile_styles: { fontSize: '12px' },
    block_name: 'bump_a', product_id: 'p1', price_id: 'pr1',
  };
  const merged = mergeReplaceProps(prev, { headline: 'New' });
  eq(merged.headline, 'New', 'F4: the op WINS for the key it sets');
  eq(merged.variant_id, '4455', 'F4: variant_id survives an op that never mentions it');
  eq(merged.line_items, [{ id: 1 }], 'F4: line_items survives');
  eq(merged.offer_id, 'of_1', 'F4: offer_id survives');
  eq(merged.quantity, 2, 'F4: quantity survives');
  eq(merged.product_id, 'p1', 'F4: product_id survives');
  eq(merged.price_id, 'pr1', 'F4: price_id survives');
  eq(merged.style, { color: 'red' }, 'F4: the base style bag survives');
  eq(merged.mobile_styles, { fontSize: '12px' }, 'F4: the mobile override bag survives');
  eq(merged.block_name, 'bump_a', 'F4: the CSS hook / label survives');
}

{
  // NON-wiring props are NOT carried forward — replace_props stays a replace
  // for copy, which is the whole point of the op.
  const merged = mergeReplaceProps({ headline: 'Old', subtext: 'gone' }, { headline: 'New' });
  eq(merged.subtext, undefined, 'F4: a NON-wiring prop the op omits is dropped — this is still a replace');
  eq(Object.keys(merged).sort(), ['headline'], 'F4: nothing is invented when prev has no wiring');
}

{
  // An EXPLICIT set wins, including an explicit clear. Changing wiring on
  // purpose is legal; losing it by omission is not.
  eq(
    mergeReplaceProps({ variant_id: '1' }, { variant_id: '2' }).variant_id, '2',
    'F4: an op that SETS a wiring key overrides the carry-forward'
  );
  eq(
    mergeReplaceProps({ variant_id: '1' }, { variant_id: null }).variant_id, null,
    'F4: an EXPLICIT null is an intentional clear and is honored'
  );
  eq(
    mergeReplaceProps({ variant_id: '1' }, { variant_id: '' }).variant_id, '',
    'F4: an EXPLICIT empty string is honored too (the server reads it as unwired)'
  );
  eq(
    Object.prototype.hasOwnProperty.call(
      mergeReplaceProps({ variant_id: '1' }, { variant_id: undefined }), 'variant_id'
    ),
    true,
    'F4: an explicit undefined is still an own key, so it is NOT overwritten by the carry-forward'
  );
}

{
  // Totality — props are whatever was in the JSON.
  eq(mergeReplaceProps(null, null), {}, 'F4: null/null → {}, never throws');
  eq(mergeReplaceProps(undefined, { a: 1 }), { a: 1 }, 'F4: absent prev → the op verbatim');
  eq(mergeReplaceProps({ variant_id: '9' }, null), { variant_id: '9' }, 'F4: absent next → the wiring floor alone');
  eq(mergeReplaceProps([1, 2], [3]), {}, 'F4: arrays are not prop bags → {}');
  eq(mergeReplaceProps('x', 'y'), {}, 'F4: strings are not prop bags → {}');
}

{
  // The floor must not MUTATE either input — applyOpsNow maps over the live
  // blocks array and a mutation there would corrupt the undo stack.
  const prev = { variant_id: '1' };
  const next = { headline: 'a' };
  mergeReplaceProps(prev, next);
  eq(prev, { variant_id: '1' }, 'F4: prev is not mutated');
  eq(next, { headline: 'a' }, 'F4: next is not mutated');
}

ok(
  WIRING_KEYS.includes('variant_id') && WIRING_KEYS.includes('line_items')
  && WIRING_KEYS.includes('offer_id') && WIRING_KEYS.includes('quantity')
  && WIRING_KEYS.includes('style') && WIRING_KEYS.includes('mobile_styles')
  && WIRING_KEYS.includes('block_name'),
  'F4: every key the review named is on the floor'
);
ok(Object.isFrozen(WIRING_KEYS), 'F4: the floor is frozen — a caller cannot widen it at runtime');

// ===========================================================================
// Structured list fields — the row editors behind FAQ / Ranking /
// Product grid / Comparison table.
// ===========================================================================

{
  // listRows mirrors the RENDERER's filter. funnelRender.js does
  // `.filter(isPlainObject)` on every one of these arrays, so a null or a
  // string row is already invisible on the published page — the editor must
  // not draw a card for it.
  eq(listRows([{ a: 1 }, null, 'x', [1], { b: 2 }]), [{ a: 1 }, { b: 2 }],
    'rows: only plain objects survive — same filter the renderer applies');
  eq(listRows(null), [], 'rows: null → []');
  eq(listRows('nope'), [], 'rows: a string prop → []');
  eq(listRows(undefined), [], 'rows: absent prop → []');
  eq(listRows([]), [], 'rows: empty stays empty');
  // The identity every no-op path is built on: an already-clean array comes
  // back AS ITSELF, so `helper(rows) === rows` is a reliable "nothing changed".
  const clean = [{ a: 1 }, { b: 2 }];
  ok(listRows(clean) === clean, 'rows: an already-clean array is returned by IDENTITY, not copied');
  const dirty = [{ a: 1 }, null];
  ok(listRows(dirty) !== dirty, 'rows: an array with junk IS copied — the junk is really dropped');
}

{
  const rows = [{ q: 'a' }];
  const next = addListRow(rows, { q: 'new', a: '' });
  eq(next, [{ q: 'a' }, { q: 'new', a: '' }], 'rows: add appends the default row');
  eq(rows, [{ q: 'a' }], 'rows: add does not mutate the input');
  // The registry literal is shared across every insert — a row that aliased it
  // would let editing one FAQ entry edit the default for the next one.
  const d = { q: 'new' };
  ok(addListRow([], d)[0] !== d, 'rows: the default row is COPIED, never aliased');
  eq(addListRow(null, { x: 1 }), [{ x: 1 }], 'rows: add onto a non-array prop still works');
  eq(addListRow([], null), [{}], 'rows: a missing defaultItem adds an empty row, never throws');
}

{
  const rows = [{ n: 0 }, { n: 1 }, { n: 2 }];
  eq(removeListRow(rows, 1), [{ n: 0 }, { n: 2 }], 'rows: remove drops the named index');
  // REFERENCE IDENTITY, not deep equality. RowsField writes only when the
  // returned array is a DIFFERENT object, so a no-op that allocated a fresh
  // equal array would still push a props write and bank an undo step that
  // undoes nothing. `eq` (JSON) cannot see that difference — `ok(x === rows)`
  // can, and this is the assertion that caught it.
  ok(removeListRow(rows, 9) === rows, 'rows: an out-of-range remove returns the SAME array (no write)');
  ok(removeListRow(rows, -1) === rows, 'rows: a negative index returns the SAME array');
  ok(removeListRow(rows, 1.5) === rows, 'rows: a fractional index returns the SAME array');
  eq(rows, [{ n: 0 }, { n: 1 }, { n: 2 }], 'rows: remove does not mutate the input');
}

{
  const rows = [{ n: 0 }, { n: 1 }, { n: 2 }];
  eq(moveListRow(rows, 0, 1), [{ n: 1 }, { n: 0 }, { n: 2 }], 'rows: move down swaps with the next');
  eq(moveListRow(rows, 2, -1), [{ n: 0 }, { n: 2 }, { n: 1 }], 'rows: move up swaps with the previous');
  eq(moveListRow(rows, 0, 2), [{ n: 1 }, { n: 2 }, { n: 0 }], 'rows: a multi-step move is honoured');
  // The ends are the whole reason move returns identity — ↑ on the first row
  // must write NOTHING, not wrap the row around to the bottom.
  ok(moveListRow(rows, 0, -1) === rows, 'rows: ↑ on the first row returns the SAME array — no wrap, no write');
  ok(moveListRow(rows, 2, 1) === rows, 'rows: ↓ on the last row returns the SAME array');
  ok(moveListRow(rows, 0, 0) === rows, 'rows: a zero delta returns the SAME array');
  ok(moveListRow(rows, 0, 1.5) === rows, 'rows: a fractional delta returns the SAME array');
  eq(rows, [{ n: 0 }, { n: 1 }, { n: 2 }], 'rows: move does not mutate the input');
}

{
  const rows = [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }];
  eq(setListCell(rows, 0, 'q', 'z'), [{ q: 'z', a: 'b' }, { q: 'c', a: 'd' }],
    'rows: a cell write lands on the named row only');
  // THE COMPARISON-TABLE TRAP. The renderer derives the column set from
  // `Object.keys(rows[0])`. If clearing a text cell deleted its key, emptying
  // the first row's "Us" box would delete the entire Us COLUMN from the
  // published table — so '' is a value and only undefined is a delete.
  eq(setListCell(rows, 0, 'a', ''), [{ q: 'a', a: '' }, { q: 'c', a: 'd' }],
    'rows: an EMPTY STRING keeps the key — clearing a cell never drops a column');
  eq(setListCell(rows, 0, 'a', undefined), [{ q: 'a' }, { q: 'c', a: 'd' }],
    'rows: undefined DELETES the key (an unset number)');
  eq(setListCell(rows, 0, 'a', 0), [{ q: 'a', a: 0 }, { q: 'c', a: 'd' }],
    'rows: 0 is a value, not a delete');
  ok(setListCell(rows, 5, 'q', 'z') === rows, 'rows: a cell write off the end returns the SAME array');
  ok(setListCell(rows, 0, '', 'z') === rows, 'rows: an empty key returns the SAME array');
  ok(setListCell(rows, 0, null, 'z') === rows, 'rows: a non-string key returns the SAME array');
  eq(rows, [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }], 'rows: a cell write does not mutate the input');
}

// ===========================================================================
// Comparison table columns — MIRRORS funnelRender.js:
//   const cols = Object.keys(rows[0]).filter((k) => k !== 'feature');
// ===========================================================================

{
  const rows = [{ feature: 'Price', Us: '$9', Them: '$19' }, { feature: 'Support', Us: 'Yes', Them: 'No' }];
  eq(comparisonColumns(rows), ['Us', 'Them'], 'cols: read off row 0, feature excluded');
  eq(comparisonColumns([]), [], 'cols: no rows → no columns');
  eq(comparisonColumns(null), [], 'cols: a non-array prop → no columns');
  eq(comparisonColumns([{ feature: 'x' }]), [], 'cols: feature-only row → no columns');
  // Row 0 ALONE decides. A key that exists only on row 2 is never printed by
  // the renderer, so the editor must not offer a box for it either.
  eq(comparisonColumns([{ feature: 'a', Us: '1' }, { feature: 'b', Us: '1', Extra: '9' }]), ['Us'],
    'cols: a key present only on a LATER row is not a column — row 0 is the header source');
}

{
  const rows = [{ feature: 'Price', Us: '$9' }, { feature: 'Support', Us: 'Yes' }];
  eq(addComparisonColumn(rows, 'Them'),
    [{ feature: 'Price', Us: '$9', Them: '' }, { feature: 'Support', Us: 'Yes', Them: '' }],
    'cols: add writes an empty cell on EVERY row, not just row 0');
  eq(addComparisonColumn(rows, '  Them  '),
    [{ feature: 'Price', Us: '$9', Them: '' }, { feature: 'Support', Us: 'Yes', Them: '' }],
    'cols: the new name is trimmed');
  // F1. THE EMPTY CASE. A column lives inside the row objects, so with zero
  // rows there is nowhere to put one — and `[].map()` hands back a FRESH empty
  // array, which the panel reads as a change and banks an undo step for. Every
  // sibling helper had an identity assertion for its refusal path; add only
  // had populated-case ones, which is exactly how this slipped through.
  const noRows = [];
  ok(addComparisonColumn(noRows, 'X') === noRows, 'F1 cols: add with NO ROWS returns the SAME array — no phantom undo step');
  eq(addComparisonColumn(noRows, 'X'), [], 'F1 cols: add with no rows adds nothing');
  ok(addComparisonColumn(null, 'X').length === 0, 'F1 cols: add onto a non-array prop yields no columns and does not throw');
  // Refusals return the SAME array, so a rejected click writes nothing at all.
  ok(addComparisonColumn(rows, 'Us') === rows, 'cols: a duplicate name is refused (same array)');
  ok(addComparisonColumn(rows, 'feature') === rows, 'cols: the reserved `feature` key is refused');
  ok(addComparisonColumn(rows, '   ') === rows, 'cols: a blank name is refused');
  ok(addComparisonColumn(rows, null) === rows, 'cols: a non-string name is refused');
}

{
  const rows = [{ feature: 'Price', Us: '$9', Them: '$19' }, { feature: 'Support', Us: 'Yes', Them: 'No' }];
  const renamed = renameComparisonColumn(rows, 'Them', 'Brand X');
  eq(renamed, [{ feature: 'Price', Us: '$9', 'Brand X': '$19' }, { feature: 'Support', Us: 'Yes', 'Brand X': 'No' }],
    'cols: rename rewrites every row and KEEPS the values');
  // KEY ORDER IS THE HEADER ORDER. A rename done as delete-then-spread would
  // push the renamed column to the end and silently reorder the published
  // table's headers.
  eq(Object.keys(renamed[0]), ['feature', 'Us', 'Brand X'],
    'cols: rename preserves key ORDER — the published headers do not shuffle');
  ok(renameComparisonColumn(rows, 'Them', 'Us') === rows, 'cols: renaming onto an existing column is refused (same array)');
  ok(renameComparisonColumn(rows, 'Them', 'feature') === rows, 'cols: renaming to `feature` is refused');
  ok(renameComparisonColumn(rows, 'Them', '') === rows, 'cols: renaming to blank is refused');
  ok(renameComparisonColumn(rows, 'Them', 'Them') === rows, 'cols: renaming to itself is a no-op');
  ok(renameComparisonColumn(rows, 'Nope', 'X') === rows, 'cols: renaming a column that is not there is a no-op');
  eq(rows[0], { feature: 'Price', Us: '$9', Them: '$19' }, 'cols: rename does not mutate the input');
}

{
  const rows = [{ feature: 'Price', Us: '$9', Them: '$19' }, { feature: 'Support', Us: 'Yes', Them: 'No' }];
  eq(removeComparisonColumn(rows, 'Them'), [{ feature: 'Price', Us: '$9' }, { feature: 'Support', Us: 'Yes' }],
    'cols: remove drops the key from EVERY row');
  ok(removeComparisonColumn(rows, 'feature') === rows, 'cols: `feature` is not a column and cannot be removed');
  ok(removeComparisonColumn(rows, 'Nope') === rows, 'cols: removing an absent column is a no-op');
  eq(rows[0], { feature: 'Price', Us: '$9', Them: '$19' }, 'cols: remove does not mutate the input');
}

{
  // A new row must carry the CURRENT column set. A row without those keys
  // renders as blanks — and if it ever became row 0 (delete the one above it)
  // it would take every column off the published table with it.
  const rows = [{ feature: 'Price', Us: '$9', Them: '$19' }];
  eq(comparisonDefaultRow(rows), { feature: 'New feature', Us: '', Them: '' },
    'cols: a new row is seeded with every current column');
  eq(Object.keys(comparisonDefaultRow(rows)), ['feature', 'Us', 'Them'],
    'cols: a new row carries the columns in header order');
  eq(comparisonDefaultRow([]), { feature: 'New feature' }, 'cols: with no rows, a new row is feature-only');
  eq(comparisonDefaultRow(null), { feature: 'New feature' }, 'cols: a non-array prop still yields a usable row');
  eq(comparisonDefaultRow(rows, 'Warranty').feature, 'Warranty', 'cols: the feature label is overridable');
  // The round trip the "Add row" button actually performs.
  eq(comparisonColumns(addListRow(rows, comparisonDefaultRow(rows))), ['Us', 'Them'],
    'cols: adding a row leaves the column set untouched');
}

{
  // F5. Row 0 IS the header source, so on a HETEROGENEOUS table a reorder is
  // not cosmetic — it can rewrite the published columns. The panel blocks
  // those moves and says why.
  const mixed = [{ feature: 'a', Us: '1' }, { feature: 'b', Them: '2' }];
  ok(moveWouldChangeColumns(mixed, 0, 1), 'F5 cols: moving a differently-keyed row into position 0 is flagged');
  ok(moveWouldChangeColumns(mixed, 1, -1), 'F5 cols: the same move from the other direction is flagged');
  eq(comparisonColumns(mixed), ['Us'], 'F5 cols: before the move the headers are Us');
  eq(comparisonColumns(moveListRow(mixed, 0, 1)), ['Them'], 'F5 cols: the move WOULD have republished them as Them');
  // A homogeneous table — the case this editor authors — reorders freely.
  const same = [{ feature: 'a', Us: '1' }, { feature: 'b', Us: '2' }, { feature: 'c', Us: '3' }];
  ok(!moveWouldChangeColumns(same, 0, 1), 'F5 cols: a matching-column table reorders freely');
  ok(!moveWouldChangeColumns(same, 1, 1), 'F5 cols: a move that never touches row 0 is never blocked');
  // A no-op move cannot change anything, so it must not be flagged either —
  // otherwise ↑ on row 0 would show a scary column warning instead of nothing.
  ok(!moveWouldChangeColumns(mixed, 0, -1), 'F5 cols: a no-op move at the top is NOT flagged');
  ok(!moveWouldChangeColumns(mixed, 1, 1), 'F5 cols: a no-op move at the bottom is NOT flagged');
  ok(!moveWouldChangeColumns([], 0, 1), 'F5 cols: an empty table is not flagged and does not throw');
  // Column ORDER counts as a change: same names, different header order is
  // still a different published table.
  const reordered = [{ feature: 'a', Us: '1', Them: '2' }, { feature: 'b', Them: '2', Us: '1' }];
  ok(moveWouldChangeColumns(reordered, 0, 1), 'F5 cols: a change in column ORDER is flagged too');
}

// ===========================================================================
// Countdown deadline — the picker is LOCAL, the stored prop is a UTC instant,
// and funnelRender's emitted runtime parses it with Date.parse.
// ===========================================================================

{
  // TZ-INDEPENDENT BY CONSTRUCTION: asserting an absolute UTC string here
  // would pin the harness to whatever zone the runner happens to be in, so
  // the property under test is the ROUND TRIP the panel performs.
  const local = '2026-12-31T23:59';
  const iso = isoFromLocalInput(local);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso), 'countdown: a picked local time stores as a UTC ISO instant');
  eq(localInputFromIso(iso), local, 'countdown: ISO → picker → ISO round-trips to the same wall clock');
  ok(Number.isFinite(Date.parse(iso)), 'countdown: the stored value is Date.parse-able — what the emitted runtime calls');
}

{
  eq(isoFromLocalInput(''), '', 'countdown: a cleared picker stores nothing');
  eq(isoFromLocalInput('   '), '', 'countdown: whitespace stores nothing');
  eq(isoFromLocalInput('not a date'), '', 'countdown: an unparseable value stores nothing, never "Invalid Date"');
  eq(isoFromLocalInput(null), '', 'countdown: a null value stores nothing');
  eq(isoFromLocalInput(42), '', 'countdown: a non-string value stores nothing');
  eq(localInputFromIso(''), '', 'countdown: no deadline → empty picker');
  eq(localInputFromIso('garbage'), '', 'countdown: an unreadable saved deadline → empty picker (and the panel warns)');
  eq(localInputFromIso(null), '', 'countdown: a null deadline → empty picker');
  // A zone-less ISO already on a block still opens the picker rather than
  // reading as corrupt — Date.parse takes it as local time.
  ok(localInputFromIso('2026-06-01T12:00:00') !== '', 'countdown: a zone-less saved deadline is still readable');
}

{
  // MIRRORS countdownRuntimeScript() IN funnelRender.js: same formatting,
  // same 'Offer expired' literal, same <= 0 boundary.
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // `padded` rides on every result so the panel can name whitespace as the
  // cause; it is false for these clean instants.
  const at = (ms) => countdownPreview('2026-01-01T00:00:00Z', t0 - ms);
  eq(at(1000), { state: 'live', text: '00:00:01', padded: false }, 'countdown: one second out formats zero-padded');
  eq(at(61000), { state: 'live', text: '00:01:01', padded: false }, 'countdown: minutes and seconds pad');
  eq(at(3600000), { state: 'live', text: '01:00:00', padded: false }, 'countdown: a whole hour');
  eq(at(86400000), { state: 'live', text: '1d 00:00:00', padded: false }, 'countdown: a day prefixes "1d "');
  eq(at(90061000), { state: 'live', text: '1d 01:01:01', padded: false }, 'countdown: days + padded clock');
  eq(at(10 * 3600000), { state: 'live', text: '10:00:00', padded: false }, 'countdown: a two-digit hour is not double-padded');
  // The boundary is the runtime's: `if(ms<=0)`. Exactly ON the deadline is
  // EXPIRED, not a live 00:00:00.
  eq(at(0), { state: 'expired', text: 'Offer expired', padded: false }, 'countdown: the deadline instant itself reads expired');
  eq(at(-5000), { state: 'expired', text: 'Offer expired', padded: false }, 'countdown: a past deadline reads expired');
}

{
  // The three states the RUNTIME collapses into one silent no-op. The canvas
  // separates them because only one of them is the block working.
  eq(countdownPreview('', 0).state, 'unset', 'countdown: no deadline is its own state');
  eq(countdownPreview(null, 0).state, 'unset', 'countdown: a null deadline is unset');
  eq(countdownPreview('next tuesday', 0).state, 'invalid', 'countdown: an unparseable deadline is INVALID, not unset');
  eq(countdownPreview('', 0).text, '—', 'countdown: unset shows the renderer\'s static em-dash');
  eq(countdownPreview('next tuesday', 0).text, '—', 'countdown: invalid shows the same em-dash the page shows');
  // Totality — the prop is operator/AI-authored and need not be a string.
  eq(countdownPreview({}, 0).state, 'invalid', 'countdown: an object deadline degrades, never throws');
  eq(countdownPreview([], 0).state, 'unset', 'countdown: an empty array stringifies to blank → unset');
  ok(['live', 'expired'].includes(countdownPreview('2026-01-01T00:00:00Z').state),
    'countdown: an omitted `now` falls back to the real clock without throwing');
}

{
  // F3. THE PREVIEW MUST PARSE WHAT THE RUNTIME PARSES — NO TRIM.
  //
  // funnelRender's emitted runtime does `Date.parse(node.getAttribute(...))`
  // on the raw attribute, and V8 answers NaN for a padded instant (verified by
  // execution, not assumed). A preview that trimmed first showed a
  // PERMANENTLY DEAD countdown as a healthy ticking clock — reachable through
  // legacy free-text deadlines and AI replace_props.
  const good = '2026-01-01T00:00:00Z';
  const t0 = Date.parse(good);
  ok(Number.isFinite(t0), 'F3 countdown: the clean instant parses (control)');
  ok(!Number.isFinite(Date.parse(` ${good} `)), 'F3 countdown: NEGATIVE CONTROL — the runtime\'s own parse rejects a padded instant');

  for (const [pad, what] of [[` ${good} `, 'spaces'], [`\t${good}`, 'a tab'], [`${good}\n`, 'a newline'], [` ${good}`, 'a leading space']]) {
    const r = countdownPreview(pad, t0 - 60000);
    eq(r.state, 'invalid', `F3 countdown: a deadline padded with ${what} previews as DEAD, never live`);
    eq(r.padded, true, `F3 countdown: ...and the whitespace is named as the cause (${what})`);
    ok(r.text !== '00:01:00', `F3 countdown: ...and no clock is drawn for it (${what})`);
  }
  // Whitespace-only is likewise NOT "unset": the runtime's `if(!raw)` guard
  // passes it through to Date.parse, where it dies.
  eq(countdownPreview('   ', 0).state, 'invalid', 'F3 countdown: a whitespace-ONLY deadline is invalid, not unset');
  eq(countdownPreview('   ', 0).padded, true, 'F3 countdown: whitespace-only is flagged as padded');
  // A clean value must not be mislabelled.
  eq(countdownPreview(good, t0 - 60000).state, 'live', 'F3 countdown: the clean instant still ticks');
  eq(countdownPreview(good, t0 - 60000).padded, false, 'F3 countdown: a clean instant is not flagged as padded');
  eq(countdownPreview('', 0).padded, false, 'F3 countdown: an absent deadline is not flagged as padded');

  // THE WRITE PATH STILL CLEANS. isoFromLocalInput trims its input and emits a
  // canonical ISO, so anything this editor stores is readable by the page —
  // which is what makes the read-path strictness safe to ship.
  const written = isoFromLocalInput('  2026-12-31T23:59  ');
  ok(Number.isFinite(Date.parse(written)), 'F3 countdown: the WRITE path trims, so stored values always parse');
  eq(written, written.trim(), 'F3 countdown: a stored value never carries whitespace');
  eq(countdownPreview(written, 0).state, 'live', 'F3 countdown: a value this editor wrote always previews live');
}

{
  // F4. DST — the spring-forward gap and the ambiguous fall-back hour.
  // Date.parse resolves both silently; round-tripping is what exposes it.
  // Asserted against the RUNNER's own zone rather than a hard-coded one, so
  // the case holds wherever CI runs: find a local time that does not survive
  // the round trip, and require it to be reported.
  eq(localInputAnomaly('2026-06-15T12:00'), null, 'F4 dst: an ordinary local time round-trips exactly');
  eq(localInputAnomaly(''), null, 'F4 dst: a blank pick reports nothing');
  eq(localInputAnomaly(null), null, 'F4 dst: a null pick reports nothing');
  eq(localInputAnomaly('garbage'), null, 'F4 dst: an unparseable pick is not a DST anomaly (it is handled as invalid)');

  // Sweep a year of 30-minute local times; any that does not round-trip is a
  // clock change. In a DST zone there is at least one; in UTC there is none,
  // and the assertion below is written to hold either way.
  const offenders = [];
  for (let day = 0; day < 366 && offenders.length < 3; day += 1) {
    const base = new Date(2026, 0, 1 + day, 0, 0, 0);
    for (let half = 0; half < 48; half += 1) {
      const d = new Date(base.getTime());
      d.setHours(Math.floor(half / 2), (half % 2) * 30, 0, 0);
      const p = (n) => (n < 10 ? '0' : '') + n;
      const v = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(Math.floor(half / 2))}:${p((half % 2) * 30)}`;
      const a = localInputAnomaly(v);
      if (a) { offenders.push([v, a.stored]); break; }
    }
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (offenders.length) {
    ok(offenders.every(([, stored]) => typeof stored === 'string' && stored !== ''),
      `F4 dst: every non-round-tripping local time reports what WAS stored (zone ${zone}, e.g. ${offenders[0][0]} → ${offenders[0][1]})`);
    ok(offenders.every(([v, stored]) => v !== stored),
      'F4 dst: the reported stored value differs from the pick — which is the whole warning');
  } else {
    ok(true, `F4 dst: no clock changes exist in zone ${zone}, so no anomaly can be reported (vacuously correct)`);
  }
}

{
  // F4. Zero-padded years. getFullYear() returns 41 for a year-41 instant, and
  // `41-01-01T00:00` is not a value a datetime-local input will accept — the
  // picker would silently render empty.
  const early = localInputFromIso('0041-06-15T12:00:00Z');
  ok(/^\d{4}-/.test(early), `F4 dates: a year under 1000 is zero-padded to four digits (got ${early})`);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localInputFromIso('2026-06-15T12:00:00Z')),
    'F4 dates: an ordinary year keeps the exact datetime-local shape');
  // The documented zone split, pinned so the doc cannot drift from the engine:
  // date-ONLY is UTC, date-TIME without a zone is LOCAL.
  eq(new Date(Date.parse('2026-01-01')).toISOString(), '2026-01-01T00:00:00.000Z',
    'F4 dates: a DATE-ONLY string is parsed as UTC (as the doc now says)');
  const localNoon = Date.parse('2026-06-15T12:00:00');
  eq(new Date(localNoon).getHours(), 12,
    'F4 dates: a date-TIME string with no zone is parsed as LOCAL (as the doc now says)');
  // Seconds truncation is accepted and documented in the field help.
  eq(isoFromLocalInput('2026-06-15T12:00').endsWith(':00.000Z') || localInputFromIso(isoFromLocalInput('2026-06-15T12:00')) === '2026-06-15T12:00', true,
    'F4 dates: the picker carries no seconds, so a stored deadline lands on :00');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
