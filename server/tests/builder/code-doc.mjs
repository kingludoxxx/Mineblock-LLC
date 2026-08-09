// Round-trip verification for the CODE VIEW document model
// (client/src/pages/funnels/builder/codeDoc.js).
//
// This is the highest-risk client code in the lane: it can DELETE BLOCKS and
// it can take a page off the money path. The adversarial review's four
// executed break-cases (F1 missing @BLOCKS header, F2 money-block retype,
// F3/F4 page-js wrapper, F8 embedded section markers) are PERMANENT TESTS
// below — each one is named for the rule it defends.
//
// The DOM element-splitter is injected (node has no document), which is
// exactly why parseBlocksSection takes it as a dependency. The stub mirrors
// the real DOM's node handling — elements, COMMENTS and non-blank text —
// because a stub that silently dropped comments would hide the bug that a
// comment-only segment is what a placeholder actually is.
//
// Run:  node server/tests/builder/code-doc.mjs
import {
  buildHtmlDoc, buildCssDoc, docBlockIds, blockSource,
  splitHtmlSections, splitBodyEnd, parseCssDoc, parseBlocksSection,
  parseCodeDocs, normalizeMarkup, stripScaffold,
  escapeMarkers, unescapeMarkers, makeNonce, CodeDocRefusal, PROTECTED_TYPES,
  SERVER_RENDER_PLACEHOLDER, MARK, codeDocEpochAction,
} from '../../../client/src/pages/funnels/builder/codeDoc.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);
const throws = (fn, code, m) => {
  try { fn(); fail++; console.log('FAIL ', m, ' — did NOT throw'); }
  catch (e) {
    if (e instanceof CodeDocRefusal && e.code === code) { pass++; console.log('PASS ', m); }
    else { fail++; console.log('FAIL ', m, ` — wrong error: ${e.name}/${e.code}: ${e.message}`); }
  }
};

const B = (id, type, props = {}) => ({ id, type, props });

let n = 0;
const newId = () => `new_${++n}`;
// F21: mirrors domElementSplitter's node handling (elements, comments, text).
const splitElements = (html) => {
  const out = [];
  const re = /<!--[\s\S]*?-->|<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>|<[a-z][\w-]*\b[^>]*\/?>/gi;
  let last = 0, m;
  while ((m = re.exec(html))) {
    const between = html.slice(last, m.index).trim();
    if (between) out.push(between);
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  const tail = html.slice(last).trim();
  if (tail) out.push(tail);
  return out;
};
const deps = () => { n = 0; return { newId, splitElements }; };

const CODE = {
  head_html: '<meta name="x" content="1">',
  custom_html: '<div id="top"></div>',
  body_end_html: '<div id="end"></div>',
  custom_js: 'console.log("hi");',
  custom_css: 'body{color:red}',
};
const build = (code, blocks, nonce) => buildHtmlDoc(code, blocks, nonce);

// ===========================================================================
// Build
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '.a{}' }), B('b', 'heading', { text: 'H' })];
  const { text: doc, nonce } = build(CODE, blocks);
  ok(doc.includes('<!-- @block a [custom_html] -->'), 'build: block marker for a');
  ok(doc.includes('<p>A</p>'), 'build: escape-hatch html inlined');
  ok(doc.includes(SERVER_RENDER_PLACEHOLDER), 'build: server-rendered block gets the placeholder');
  ok(doc.includes(MARK.head) && doc.includes(MARK.blocks) && doc.includes(MARK.bodyEnd), 'build: all section markers present');
  ok(doc.includes(`data-nonce="${nonce}"`), 'build: page-JS wrapper carries this document\'s nonce');
  ok(doc.startsWith('<!DOCTYPE html>'), 'build: cosmetic scaffolding present');
  eq(docBlockIds(blocks), ['a', 'b'], 'build: docBlockIds');
  ok(makeNonce() !== makeNonce(), 'build: nonces are distinct per call');
}
{
  const css = buildCssDoc(CODE, [B('a', 'custom_html', { css: '.a{color:blue}' }), B('b', 'heading', {})]);
  ok(css.includes('@BLOCK a'), 'buildCss: per-block marker for custom_html');
  ok(!css.includes('@BLOCK b'), 'buildCss: no marker for a block with no css prop');
}
eq(build({ ...CODE, custom_js: '   ' }, []).text.includes('data-lb="page-js"'), false, 'build: blank custom_js emits NO script wrapper');
ok(blockSource(B('r', 'row', { columns: [{ html: 'L' }] })).includes('<!-- @col 0 -->'), 'build: row emits @col markers');
eq(blockSource(B('x', 'heading', {})), SERVER_RENDER_PLACEHOLDER, 'build: heading → placeholder');
eq(blockSource(null), SERVER_RENDER_PLACEHOLDER, 'build: null block → placeholder, no throw');

// ===========================================================================
// THE INVARIANT: an untouched document round-trips byte-identically
// ===========================================================================
{
  const blocks = [
    B('a', 'custom_html', { html: '<p>A</p>', css: '.a{color:blue}' }),
    B('b', 'heading', { text: 'H', level: 2 }),
    B('c', 'row', { columns: [{ html: 'L' }, { html: 'R' }] }),
    B('d', 'html', { html: '<span>raw</span>' }),
  ];
  const { text: htmlDoc, nonce } = build(CODE, blocks);
  const cssDoc = buildCssDoc(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc, cssDoc, blocks, knownIds: docBlockIds(blocks), nonce, deps: deps() });

  eq(r.blocks.map((b) => b.id), ['a', 'b', 'c', 'd'], 'ROUND-TRIP: same blocks, same order');
  eq(r.blocks, blocks, 'ROUND-TRIP: blocks are DEEP-EQUAL after an untouched open/save');
  eq(r.code.head_html, CODE.head_html, 'ROUND-TRIP: head_html');
  eq(r.code.custom_html, CODE.custom_html, 'ROUND-TRIP: custom_html');
  eq(r.code.body_end_html, CODE.body_end_html, 'ROUND-TRIP: body_end_html separated from JS');
  eq(r.code.custom_js, CODE.custom_js, 'ROUND-TRIP: custom_js recovered from its wrapper');
  eq(r.code.custom_css, CODE.custom_css, 'ROUND-TRIP: page CSS');
  eq(r.stats, { created: 0, removed: 0, retyped: 0 }, 'ROUND-TRIP: nothing created, removed or retyped');
  eq(r.notices, [], 'ROUND-TRIP: and no notices to report');
}

// ===========================================================================
// F1 (CRITICAL) — a MISSING section header means UNTOUCHED, never EMPTIED
// ===========================================================================
{
  // The reviewer's exact case: delete the @BLOCKS header line. Before the fix
  // this scored removed:2 and blanked a live page.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' }), B('b', 'heading', { text: 'H' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(`${MARK.blocks}\n`, '');
  const r = parseCodeDocs({ htmlDoc, cssDoc: buildCssDoc(CODE, blocks), blocks, knownIds: docBlockIds(blocks), nonce, deps: deps() });

  eq(r.blocks, null, 'F1: no @BLOCKS header → blocks is NULL (not described), never an empty array');
  eq(r.stats.removed, 0, 'F1: nothing is scored as removed');
  eq(r.stats.retyped, 0, 'F1: nothing is retyped');
  ok(r.notices.some((x) => /@BLOCKS section is missing/i.test(x)), 'F1: and the operator is TOLD the section is missing', JSON.stringify(r.notices));
  ok(!('blocks' in r.code), 'F1: blocks never leaks into the code patch');
}
{
  // Same rule for the other families: a missing @HEAD must not blank head_html.
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(`${MARK.head}\n`, '');
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce, deps: deps() });
  ok(!('head_html' in r.code), 'F1: no @HEAD header → head_html is NOT written (stays as it is on the page)');
  ok(r.notices.some((x) => /@HEAD section is missing/i.test(x)), 'F1: and it is reported');
}
{
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(`${MARK.bodyEnd}\n`, '');
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce, deps: deps() });
  ok(!('body_end_html' in r.code) && !('custom_js' in r.code), 'F1: no @BODY-END header → neither body_end_html NOR custom_js is written');
}
{
  // An EXPLICITLY EMPTIED section (header present, body gone) still deletes —
  // the fix must not make deletion impossible, only accidental deletion.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const { nonce } = build(CODE, blocks);
  const htmlDoc = `${MARK.blocks}\n`;
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce, deps: deps() });
  eq(r.blocks, [], 'F1: an EXPLICITLY emptied @BLOCKS section still deletes (intent is legible)');
  eq(r.stats.removed, 1, 'F1: and reports the count');
}

// ===========================================================================
// F2 (HIGH) — money blocks cannot be retyped by a text edit
// ===========================================================================
for (const type of ['order_bump', 'whop_checkout', 'order_summary', 'product', 'shipping_method', 'checkout_template', 'express_checkout', 'stripe_checkout']) {
  const blocks = [B('m', type, { variant_id: '99', block_name: 'Bump A' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(SERVER_RENDER_PLACEHOLDER, '<div>my own markup</div>');
  throws(
    () => parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['m'], nonce, deps: deps() }),
    'protected_block_retype',
    `F2: editing a ${type} block's markup is REFUSED, not silently converted`
  );
}
{
  // The refusal must NAME the block so the operator can find it.
  const blocks = [B('m', 'order_bump', { block_name: 'Water Test Kit' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(SERVER_RENDER_PLACEHOLDER, '<div>x</div>');
  try { parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['m'], nonce, deps: deps() }); }
  catch (e) {
    ok(e.message.includes('Water Test Kit'), 'F2: the refusal names the block', e.message);
    ok(/order_bump/.test(e.message), 'F2: and names the type');
  }
}
{
  // An UNPROTECTED server-rendered block still converts — and now says so.
  const blocks = [B('h', 'heading', { text: 'H', block_name: 'Title' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(SERVER_RENDER_PLACEHOLDER, '<h2>MINE</h2>');
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['h'], nonce, deps: deps() });
  eq(r.blocks[0].type, 'custom_html', 'F2: an unprotected block still converts');
  ok(r.notices.some((x) => x.includes('Title')), 'F2: and the notice NAMES it', JSON.stringify(r.notices));
}
{
  // Leaving a protected block ALONE must not trip the refusal.
  const blocks = [B('m', 'order_bump', { variant_id: '99' })];
  const { text: htmlDoc, nonce } = build(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['m'], nonce, deps: deps() });
  eq(r.blocks[0], blocks[0], 'F2: an untouched protected block round-trips unchanged');
  ok(PROTECTED_TYPES.has('order_bump') && PROTECTED_TYPES.has('whop_checkout'), 'F2: the protected set covers the money types');
}

// ===========================================================================
// F3 + F4 (HIGH) — the page-JS wrapper is exclusive and escaped
// ===========================================================================
{
  // F3: custom_js containing </script> used to truncate the wrapper and leak
  // the tail into live HTML.
  const js = 'var s = "</script><img src=x onerror=alert(1)>"; go();';
  const code = { ...CODE, custom_js: js };
  const { text: htmlDoc, nonce } = build(code, []);
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks: [], knownIds: [], nonce, deps: deps() });
  eq(r.code.custom_js, js, 'F3: custom_js containing </script> round-trips LOSSLESSLY');
  eq(r.code.body_end_html, CODE.body_end_html, 'F3: and nothing leaked into body_end_html');
  ok(!htmlDoc.includes('"</script>'), 'F3: the emitted document never contains a raw closing </script> inside the JS body');
}
{
  // F4: an operator's own data-lb="page-js" script inside body_end_html used
  // to swap places with the real custom_js on every save cycle.
  const code = {
    ...CODE,
    body_end_html: '<script data-lb="page-js">IMPOSTOR()</script>',
    custom_js: 'REAL()',
  };
  const { text: htmlDoc, nonce } = build(code, []);
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks: [], knownIds: [], nonce, deps: deps() });
  eq(r.code.custom_js, 'REAL()', 'F4: the nonce\'d wrapper wins — custom_js is still the real JS');
  ok(r.code.body_end_html.includes('IMPOSTOR()'), 'F4: and the impostor stays inert in body_end_html', r.code.body_end_html);

  // …and it must be STABLE: a second cycle must not swap them either.
  const two = build(r.code, []);
  const r2 = parseCodeDocs({ htmlDoc: two.text, cssDoc: '', blocks: [], knownIds: [], nonce: two.nonce, deps: deps() });
  eq(r2.code.custom_js, 'REAL()', 'F4: STILL the real JS after a second open/save cycle');
  ok(r2.code.body_end_html.includes('IMPOSTOR()'), 'F4: impostor still inert after a second cycle');
}
{
  // A wrapper carrying the WRONG nonce is operator content, not our JS.
  const doc = `${MARK.bodyEnd}\n<script data-lb="page-js" data-nonce="notours">X()</script>`;
  const r = splitBodyEnd(doc.replace(MARK.bodyEnd, ''), 'ourNonce');
  eq(r.js, '', 'F4: a wrapper with a foreign nonce is NOT read as custom_js');
  ok(r.html.includes('X()'), 'F4: it stays in body_end_html');
}
eq(splitBodyEnd('<div>x</div>', 'abc'), { html: '<div>x</div>', js: '' }, 'bodyEnd: no wrapper → all html');
eq(splitBodyEnd('<script>theirs()</script>', 'abc').js, '', 'bodyEnd: an untagged <script> is never hijacked into custom_js');

// ===========================================================================
// F8 (MEDIUM) — markers inside operator content are TEXT
// ===========================================================================
{
  // The reviewer's case: a block whose HTML contains section markers used to
  // escape its own section and hijack head_html / custom_js.
  const hostile = `<div>hi</div>\n${MARK.head}\n<script>PWNED()</script>\n${MARK.bodyEnd}\n<b>tail</b>`;
  const blocks = [B('a', 'custom_html', { html: hostile }), B('b', 'html', { html: '<i>keep me</i>' })];
  const { text: htmlDoc, nonce } = build(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc, cssDoc: buildCssDoc(CODE, blocks), blocks, knownIds: docBlockIds(blocks), nonce, deps: deps() });

  eq(r.blocks.length, 2, 'F8: both blocks survive a block containing section markers');
  eq(r.blocks[0].props.html, hostile, 'F8: the hostile HTML round-trips VERBATIM inside its own block');
  eq(r.code.head_html, CODE.head_html, 'F8: head_html is NOT hijacked');
  eq(r.code.custom_js, CODE.custom_js, 'F8: custom_js is NOT hijacked');
  eq(r.stats.removed, 0, 'F8: no block is removed by the smuggled markers');
}
{
  // A BLOCK marker smuggled inside a block's HTML must not bind another block.
  const hostile = '<div><!-- @block b [custom_html] --></div>';
  const blocks = [B('a', 'custom_html', { html: hostile }), B('b', 'custom_html', { html: '<p>B</p>' })];
  const { text: htmlDoc, nonce } = build(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a', 'b'], nonce, deps: deps() });
  eq(r.blocks.map((x) => x.id), ['a', 'b'], 'F8: a smuggled @block marker does not re-bind or drop a block');
  eq(r.blocks[0].props.html, hostile, 'F8: it round-trips verbatim as text');
  eq(r.blocks[1].props.html, '<p>B</p>', 'F8: and the real block b is untouched');
}
eq(unescapeMarkers(escapeMarkers(`x ${MARK.head} y`)), `x ${MARK.head} y`, 'F8: escape/unescape is lossless');
ok(escapeMarkers(MARK.head) !== MARK.head, 'F8: escaping actually changes a marker');
eq(escapeMarkers('<div>no markers here</div>'), '<div>no markers here</div>', 'F8: ordinary content is untouched');

// ===========================================================================
// F13 (MEDIUM) — content above the first marker is preserved, never dropped
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<p>STRAY CONTENT</p>');
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce, deps: deps() });
  ok(r.code.head_html.includes('STRAY CONTENT'), 'F13: content above the first marker is PRESERVED', r.code.head_html);
  ok(r.notices.some((x) => /above the first section marker/i.test(x)), 'F13: and the operator is told where it went');
}

// ===========================================================================
// Editing / create / delete
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '' })];
  const { text: full, nonce } = build(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc: full.replace('<p>A</p>', '<p>EDITED</p>'), cssDoc: buildCssDoc(CODE, blocks), blocks, knownIds: ['a'], nonce, deps: deps() });
  eq(r.blocks[0].props.html, '<p>EDITED</p>', 'edit: an escape-hatch edit lands on the prop');
}
{
  const blocks = [B('c', 'row', { columns: [{ html: 'L', width: 6 }, { html: 'R', width: 6 }] })];
  const { text: full, nonce } = build(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc: full.replace('\nR', '\nRIGHT'), cssDoc: '', blocks, knownIds: ['c'], nonce, deps: deps() });
  // F18: a column carries keys the Code view never shows; a rewrite must not
  // amount to deleting them.
  eq(r.blocks[0].props.columns, [{ html: 'L', width: 6 }, { html: 'RIGHT', width: 6 }], 'F18: unknown row-column keys survive a rewrite');
}
{
  const blocks = [B('a', 'custom_html', { html: 'x', css: '.old{}' })];
  const { text: htmlDoc, nonce } = build(CODE, blocks);
  const cssDoc = buildCssDoc(CODE, blocks).replace('.old{}', '.new{}');
  const r = parseCodeDocs({ htmlDoc, cssDoc, blocks, knownIds: ['a'], nonce, deps: deps() });
  eq(r.blocks[0].props.css, '.new{}', 'edit: per-block CSS lands on the block');
}
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace(MARK.blocks, `${MARK.blocks}\n<section>PASTED</section>`);
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce, deps: deps() });
  eq(r.blocks.length, 2, 'create: pasted markup becomes a new block');
  eq(r.stats.created, 1, 'create: counted');
}
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' }), B('b', 'html', { html: '<i>B</i>' })];
  const { text: full, nonce } = build(CODE, blocks);
  const htmlDoc = full.replace('<!-- @block b [html] -->\n<i>B</i>', '');
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a', 'b'], nonce, deps: deps() });
  eq(r.blocks.map((x) => x.id), ['a'], 'delete: removing a marker removes the block');
  eq(r.stats.removed, 1, 'delete: counted');
}

// ===========================================================================
// Preserve / orphan / duplicate
// ===========================================================================
{
  const atBuild = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const { text: htmlDoc, nonce } = build(CODE, atBuild);
  const now = [...atBuild, B('z', 'heading', { text: 'added later' })];
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks: now, knownIds: ['a'], nonce, deps: deps() });
  eq(r.blocks.map((b) => b.id), ['a', 'z'], 'PRESERVE: a block added since the doc was built is NOT dropped');
  eq(r.stats.removed, 0, 'PRESERVE: and is not counted as removed');
}
{
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const htmlDoc = `${MARK.blocks}\n<!-- @block ghost [custom_html] -->\n<p>orphan</p>`;
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce: 'x', deps: deps() });
  ok(!r.blocks.some((b) => b.id === 'ghost'), 'orphan: a marker for an unknown id does not resurrect that id');
  ok(r.blocks.some((b) => b.props?.html === '<p>orphan</p>'), 'orphan: its markup is kept as a new block');
  ok(r.notices.some((x) => /ghost/.test(x)), 'orphan: and it is reported', JSON.stringify(r.notices));
}
{
  // F21: a duplicated marker is an editing mistake — dedupe AND say so.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const htmlDoc = `${MARK.blocks}\n<!-- @block a [custom_html] -->\n<p>A</p>\n<!-- @block a [custom_html] -->\n<p>DUP</p>`;
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce: 'x', deps: deps() });
  eq(r.blocks.filter((b) => b.id === 'a').length, 1, 'F21: a duplicated marker emits the block ONCE');
  eq(new Set(r.blocks.map((b) => b.id)).size, r.blocks.length, 'F21: no duplicate ids in the result');
  ok(r.notices.some((x) => /twice/i.test(x)), 'F21: and the duplicate is REPORTED, not silent', JSON.stringify(r.notices));
}

// ===========================================================================
// Degraded / hostile input
// ===========================================================================
{
  const s = splitHtmlSections('<p>no markers</p>');
  eq(s.sections, { '@BLOCKS': '<p>no markers</p>' }, 'split: a marker-less document is all blocks');
  eq(s.hadAnyMarker, false, 'split: and reports that it had no markers');
}
eq(splitHtmlSections('').sections, { '@BLOCKS': '' }, 'split: empty document');
eq(splitHtmlSections(null).sections, { '@BLOCKS': '' }, 'split: null document');
{
  const s = splitHtmlSections(`${MARK.head}\nA\n${MARK.head}\nB`);
  ok(s.sections['@HEAD'].includes('A') && s.sections['@HEAD'].includes('B'), 'split: a REPEATED section marker appends, never drops the first half');
}
eq(parseCssDoc('').page, '', 'css: empty doc');
eq(parseCssDoc('.x{}').page, '.x{}', 'css: a marker-less doc is all page CSS');
eq(stripScaffold('<!DOCTYPE html><html><head>  X  </head></html>'), 'X', 'scaffold: stripped');
eq(normalizeMarkup('  a \n  b  '), 'a b', 'normalize: whitespace collapsed');
eq(parseBlocksSection(null, null, null, deps()).blocks, [], 'degraded: all-null arguments → [], no throw');
ok(Array.isArray(parseBlocksSection('<p>x</p>', null, null, {}).blocks), 'degraded: missing deps falls back to defaults, no throw');
ok(Array.isArray(parseBlocksSection('<p>x</p>', [null, 7, B('a', 'custom_html', {})], ['a'], deps()).blocks), 'degraded: junk entries do not throw');
{
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const htmlDoc = `${MARK.blocks}\n<!-- @block a [custom html] -->\n<p>y</p>`;
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks, knownIds: ['a'], nonce: 'x', deps: deps() });
  ok(!r.blocks.some((b) => b.id === 'a' && b.props.html === '<p>y</p>'), 'hostile: a malformed marker does not bind to block a');
}
{
  // Stability: a second open/save cycle is a fixed point.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '.a{}' }), B('b', 'heading', { text: 'H' })];
  const d1 = build(CODE, blocks);
  const one = parseCodeDocs({ htmlDoc: d1.text, cssDoc: buildCssDoc(CODE, blocks), blocks, knownIds: docBlockIds(blocks), nonce: d1.nonce, deps: deps() });
  const d2 = build(one.code, one.blocks);
  const two = parseCodeDocs({ htmlDoc: d2.text, cssDoc: buildCssDoc(one.code, one.blocks), blocks: one.blocks, knownIds: docBlockIds(one.blocks), nonce: d2.nonce, deps: deps() });
  eq(two.blocks, one.blocks, 'STABILITY: a second open/save cycle is a fixed point (blocks)');
  eq(two.code, one.code, 'STABILITY: a second open/save cycle is a fixed point (code)');
}

// ===========================================================================
// codeDocEpochAction — BLOCKER #2, the stale-document gate
//
// The pane builds its document ONCE. A version restore and an applied AI batch
// both replace the page from OUTSIDE the tab ternary, so a "Save code" taken
// afterwards used to write the pre-replacement document back over the change —
// silently undoing the restore, or the whole batch.
// ===========================================================================
eq(
  codeDocEpochAction({ seenEpoch: 3, docEpoch: 3, dirty: false }), 'none',
  'epoch: unchanged + clean → nothing happens'
);
eq(
  codeDocEpochAction({ seenEpoch: 3, docEpoch: 3, dirty: true }), 'none',
  'epoch: unchanged + DIRTY → nothing happens, typing is never interrupted by a no-op'
);
eq(
  codeDocEpochAction({ seenEpoch: 3, docEpoch: 4, dirty: false }), 'rebuild',
  'epoch: the page changed under a CLEAN document → rebuild, the operator loses nothing'
);
eq(
  codeDocEpochAction({ seenEpoch: 3, docEpoch: 4, dirty: true }), 'block',
  'epoch: the page changed under a DIRTY document → BLOCK Save (this is the data-loss case)'
);
eq(
  codeDocEpochAction({ seenEpoch: 0, docEpoch: 9, dirty: true }), 'block',
  'epoch: several replacements while typing still resolves to one block, not a rebuild'
);
eq(
  codeDocEpochAction({ seenEpoch: 4, docEpoch: 3, dirty: true }), 'block',
  'epoch: any INEQUALITY counts — a decrement is still "not the page I was built from"'
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
