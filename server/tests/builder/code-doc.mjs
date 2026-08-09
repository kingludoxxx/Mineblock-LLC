// Round-trip verification for the CODE VIEW document model
// (client/src/pages/funnels/builder/codeDoc.js).
//
// This is the highest-risk client code in the lane: it can DELETE BLOCKS. A
// marker the operator did not touch must round-trip byte-identically, and a
// block the document never described must survive untouched. Both are tested
// below as named invariants, not as incidental assertions.
//
// The DOM element-splitter is injected (node has no document), which is
// exactly why parseBlocksSection takes it as a dependency.
//
// Run:  node server/tests/builder/code-doc.mjs
import {
  buildHtmlDoc, buildCssDoc, docBlockIds, blockSource,
  splitHtmlSections, splitBodyEnd, parseCssDoc, parseBlocksSection,
  parseCodeDocs, normalizeMarkup, stripScaffold,
  SERVER_RENDER_PLACEHOLDER, MARK,
} from '../../../client/src/pages/funnels/builder/codeDoc.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`
);

const B = (id, type, props = {}) => ({ id, type, props });

// Deterministic id minting so failures are readable.
let n = 0;
const newId = () => `new_${++n}`;
// Stand-in for the browser's template parser: split on top-level <tag>…</tag>.
const splitElements = (html) => {
  const out = [];
  const re = /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>|<[a-z][\w-]*\b[^>]*\/?>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out.length ? out : (String(html).trim() ? [String(html).trim()] : []);
};
const deps = () => { n = 0; return { newId, splitElements }; };

const CODE = {
  head_html: '<meta name="x" content="1">',
  custom_html: '<div id="top"></div>',
  body_end_html: '<div id="end"></div>',
  custom_js: 'console.log("hi");',
  custom_css: 'body{color:red}',
};

// ===========================================================================
// Build
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '.a{}' }), B('b', 'heading', { text: 'H' })];
  const doc = buildHtmlDoc(CODE, blocks);
  ok(doc.includes('<!-- @block a [custom_html] -->'), 'build: block marker for a');
  ok(doc.includes('<!-- @block b [heading] -->'), 'build: block marker for b');
  ok(doc.includes('<p>A</p>'), 'build: escape-hatch html inlined');
  ok(doc.includes(SERVER_RENDER_PLACEHOLDER), 'build: server-rendered block gets the placeholder');
  ok(doc.includes(MARK.head) && doc.includes(MARK.blocks) && doc.includes(MARK.bodyEnd), 'build: all section markers present');
  ok(doc.includes('<script data-lb="page-js">'), 'build: custom_js rides its own tagged wrapper');
  ok(doc.startsWith('<!DOCTYPE html>'), 'build: cosmetic scaffolding present');
  eq(docBlockIds(blocks), ['a', 'b'], 'build: docBlockIds');
}
{
  const css = buildCssDoc(CODE, [B('a', 'custom_html', { css: '.a{color:blue}' }), B('b', 'heading', {})]);
  ok(css.includes('@BLOCK a'), 'buildCss: per-block marker for custom_html');
  ok(!css.includes('@BLOCK b'), 'buildCss: no marker for a block with no css prop');
  ok(css.includes('@PAGE') && css.includes('body{color:red}'), 'buildCss: page CSS section');
}
{
  // No custom_js -> no empty <script> wrapper shipped into the page.
  const doc = buildHtmlDoc({ ...CODE, custom_js: '   ' }, []);
  ok(!doc.includes('data-lb="page-js"'), 'build: blank custom_js emits NO script wrapper');
}
eq(blockSource(B('r', 'row', { columns: [{ html: 'L' }, { html: 'R' }] })).includes('<!-- @col 0 -->'), true, 'build: row emits @col markers');
eq(blockSource(B('x', 'heading', {})), SERVER_RENDER_PLACEHOLDER, 'build: heading → placeholder');
eq(blockSource(B('x', 'custom_html', { html: '   ' })), SERVER_RENDER_PLACEHOLDER, 'build: blank escape-hatch html → placeholder (not an empty section)');
eq(blockSource(null), SERVER_RENDER_PLACEHOLDER, 'build: null block → placeholder, no throw');
eq(buildHtmlDoc(null, null).includes(MARK.blocks), true, 'build: null code + null blocks still builds a document');

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
  const htmlDoc = buildHtmlDoc(CODE, blocks);
  const cssDoc = buildCssDoc(CODE, blocks);
  const r = parseCodeDocs({ htmlDoc, cssDoc, blocks, knownIds: docBlockIds(blocks), deps: deps() });

  eq(r.blocks.map((b) => b.id), ['a', 'b', 'c', 'd'], 'ROUND-TRIP: same blocks, same order');
  eq(r.blocks.map((b) => b.type), ['custom_html', 'heading', 'row', 'html'], 'ROUND-TRIP: no type drift');
  eq(r.blocks, blocks, 'ROUND-TRIP: blocks are DEEP-EQUAL after an untouched open/save');
  eq(r.code.head_html, CODE.head_html, 'ROUND-TRIP: head_html');
  eq(r.code.custom_html, CODE.custom_html, 'ROUND-TRIP: custom_html');
  eq(r.code.body_end_html, CODE.body_end_html, 'ROUND-TRIP: body_end_html separated from JS');
  eq(r.code.custom_js, CODE.custom_js, 'ROUND-TRIP: custom_js recovered from its wrapper');
  eq(r.code.custom_css, CODE.custom_css, 'ROUND-TRIP: page CSS');
  eq(r.stats, { created: 0, removed: 0, retyped: 0 }, 'ROUND-TRIP: nothing created, removed or retyped');
}

// ===========================================================================
// Editing
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '' })];
  const doc = buildHtmlDoc(CODE, blocks).replace('<p>A</p>', '<p>EDITED</p>');
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: buildCssDoc(CODE, blocks), blocks, knownIds: ['a'], deps: deps() });
  eq(r.blocks[0].props.html, '<p>EDITED</p>', 'edit: an escape-hatch edit lands on the prop');
  eq(r.blocks[0].type, 'custom_html', 'edit: type unchanged');
}
{
  // A server-rendered block whose placeholder is REPLACED converts to
  // custom_html — the only type that can honour typed markup.
  const blocks = [B('b', 'heading', { text: 'H' })];
  const doc = buildHtmlDoc(CODE, blocks).replace(SERVER_RENDER_PLACEHOLDER, '<h2>MINE</h2>');
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['b'], deps: deps() });
  eq(r.blocks[0].type, 'custom_html', 'edit: editing a server-rendered block retypes it to custom_html');
  eq(r.blocks[0].props.html, '<h2>MINE</h2>', 'edit: and keeps what the operator typed');
  eq(r.blocks[0].id, 'b', 'edit: the id is preserved through the retype');
  eq(r.stats.retyped, 1, 'edit: retyped counted');
}
{
  // …and one left ALONE is not retyped, even with whitespace noise.
  const blocks = [B('b', 'heading', { text: 'H' })];
  const doc = buildHtmlDoc(CODE, blocks).replace(SERVER_RENDER_PLACEHOLDER, `\n   ${SERVER_RENDER_PLACEHOLDER}   \n`);
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['b'], deps: deps() });
  eq(r.blocks[0].type, 'heading', 'edit: a re-indented placeholder is NOT an edit');
  eq(r.stats.retyped, 0, 'edit: nothing retyped by whitespace alone');
}
{
  const blocks = [B('c', 'row', { columns: [{ html: 'L' }, { html: 'R' }] })];
  const doc = buildHtmlDoc(CODE, blocks).replace('R', 'RIGHT');
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['c'], deps: deps() });
  eq(r.blocks[0].props.columns, [{ html: 'L' }, { html: 'RIGHT' }], 'edit: row columns parse back per @col');
}
{
  const blocks = [B('a', 'custom_html', { html: 'x', css: '.old{}' })];
  const cssDoc = buildCssDoc(CODE, blocks).replace('.old{}', '.new{}');
  const r = parseCodeDocs({ htmlDoc: buildHtmlDoc(CODE, blocks), cssDoc, blocks, knownIds: ['a'], deps: deps() });
  eq(r.blocks[0].props.css, '.new{}', 'edit: per-block CSS lands on the block');
}

// ===========================================================================
// Create / delete
// ===========================================================================
{
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const doc = buildHtmlDoc(CODE, blocks).replace(MARK.blocks, `${MARK.blocks}\n<section>PASTED</section>`);
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['a'], deps: deps() });
  eq(r.blocks.length, 2, 'create: pasted markup becomes a new block');
  eq(r.blocks[0].type, 'custom_html', 'create: the new block is custom_html');
  eq(r.blocks[0].props.html, '<section>PASTED</section>', 'create: with the pasted markup');
  eq(r.stats.created, 1, 'create: counted');
}
{
  // Deleting a marker + its markup deletes the block.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' }), B('b', 'html', { html: '<i>B</i>' })];
  let doc = buildHtmlDoc(CODE, blocks);
  doc = doc.replace('<!-- @block b [html] -->\n<i>B</i>', '');
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['a', 'b'], deps: deps() });
  eq(r.blocks.map((x) => x.id), ['a'], 'delete: removing a marker removes the block');
  eq(r.stats.removed, 1, 'delete: counted');
}

// ===========================================================================
// THE OTHER INVARIANT: a block the document never described SURVIVES
// ===========================================================================
{
  // 'a' was in the doc; 'z' was added on the Builder tab afterwards, so it has
  // no marker. "No marker" must mean DELETE only for ids the doc described.
  const atBuild = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const htmlDoc = buildHtmlDoc(CODE, atBuild);
  const now = [...atBuild, B('z', 'heading', { text: 'added later' })];
  const r = parseCodeDocs({ htmlDoc, cssDoc: '', blocks: now, knownIds: ['a'], deps: deps() });
  eq(r.blocks.map((b) => b.id), ['a', 'z'], 'PRESERVE: a block added since the doc was built is NOT dropped');
  eq(r.stats.removed, 0, 'PRESERVE: and is not counted as removed');
  eq(r.blocks[1].type, 'heading', 'PRESERVE: it keeps its type and props');
}
{
  // A marker naming an unknown id must not mint a block carrying that id.
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const doc = `${MARK.blocks}\n<!-- @block ghost [custom_html] -->\n<p>orphan</p>`;
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['a'], deps: deps() });
  ok(!r.blocks.some((b) => b.id === 'ghost'), 'orphan: a marker for an unknown id does not resurrect that id');
  ok(r.blocks.some((b) => b.props?.html === '<p>orphan</p>'), 'orphan: its markup is kept as a new block instead of being lost');
}
{
  // A DUPLICATED marker must not emit the same block twice.
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>' })];
  const doc = `${MARK.blocks}\n<!-- @block a [custom_html] -->\n<p>A</p>\n<!-- @block a [custom_html] -->\n<p>DUP</p>`;
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['a'], deps: deps() });
  eq(r.blocks.filter((b) => b.id === 'a').length, 1, 'dup: a duplicated marker emits the block ONCE');
  eq(new Set(r.blocks.map((b) => b.id)).size, r.blocks.length, 'dup: no duplicate ids in the result');
}

// ===========================================================================
// Degraded / hostile input
// ===========================================================================
eq(splitHtmlSections('<p>no markers</p>'), { '@BLOCKS': '<p>no markers</p>' }, 'split: a marker-less document is all blocks');
eq(splitHtmlSections(''), { '@BLOCKS': '' }, 'split: empty document');
eq(splitHtmlSections(null), { '@BLOCKS': '' }, 'split: null document');
{
  const s = splitHtmlSections(`${MARK.head}\nA\n${MARK.head}\nB`);
  ok(s['@HEAD'].includes('A') && s['@HEAD'].includes('B'), 'split: a REPEATED section marker appends, never silently drops the first half', JSON.stringify(s));
}
eq(splitBodyEnd('<div>x</div>'), { html: '<div>x</div>', js: '' }, 'bodyEnd: no wrapper → all html');
eq(splitBodyEnd('<script data-lb="page-js">\nalert(1)\n</script>'), { html: '', js: 'alert(1)' }, 'bodyEnd: wrapper extracted');
{
  // An operator's OWN <script> is body HTML, not page JS — only our tagged
  // wrapper is treated as the custom_js column.
  const r = splitBodyEnd('<script>theirs()</script>');
  eq(r.js, '', 'bodyEnd: an untagged <script> is NOT hijacked into custom_js');
  ok(r.html.includes('theirs()'), 'bodyEnd: and stays in body_end_html');
}
eq(parseCssDoc(''), { byBlock: {}, page: '' }, 'css: empty doc');
eq(parseCssDoc('.x{}').page, '.x{}', 'css: a marker-less doc is all page CSS');
eq(stripScaffold('<!DOCTYPE html><html><head>  X  </head></html>'), 'X', 'scaffold: stripped');
eq(normalizeMarkup('  a \n  b  '), 'a b', 'normalize: whitespace collapsed');

{
  const r = parseBlocksSection('', [B('a', 'custom_html', { html: 'x' })], ['a'], deps());
  eq(r.blocks, [], 'degraded: an EMPTIED document deletes every block it described (explicit, not accidental)');
  eq(r.removed, 1, 'degraded: and reports the count so the UI can say so');
}
eq(parseBlocksSection(null, null, null, deps()).blocks, [], 'degraded: all-null arguments → [], no throw');
eq(parseBlocksSection('<p>x</p>', null, null, {}).blocks.length >= 0, true, 'degraded: missing deps falls back to built-in defaults, no throw');
{
  const r = parseBlocksSection('<p>x</p>', [null, 7, B('a', 'custom_html', {})], ['a'], deps());
  ok(Array.isArray(r.blocks), 'degraded: junk entries in currentBlocks do not throw');
}
{
  // A hostile marker-shaped string must not match our anchored regex.
  const blocks = [B('a', 'custom_html', { html: 'x' })];
  const doc = `${MARK.blocks}\n<!-- @block a [custom html] -->\n<p>y</p>`;
  const r = parseCodeDocs({ htmlDoc: doc, cssDoc: '', blocks, knownIds: ['a'], deps: deps() });
  ok(!r.blocks.some((b) => b.id === 'a' && b.props.html === '<p>y</p>'),
    'hostile: a malformed marker (space in the type) does not bind to block a');
}
{
  // Round-trip stability: parse(build(parse(build(x)))) === parse(build(x)).
  const blocks = [B('a', 'custom_html', { html: '<p>A</p>', css: '.a{}' }), B('b', 'heading', { text: 'H' })];
  const one = parseCodeDocs({
    htmlDoc: buildHtmlDoc(CODE, blocks), cssDoc: buildCssDoc(CODE, blocks),
    blocks, knownIds: docBlockIds(blocks), deps: deps(),
  });
  const two = parseCodeDocs({
    htmlDoc: buildHtmlDoc(one.code, one.blocks), cssDoc: buildCssDoc(one.code, one.blocks),
    blocks: one.blocks, knownIds: docBlockIds(one.blocks), deps: deps(),
  });
  eq(two.blocks, one.blocks, 'STABILITY: a second open/save cycle is a fixed point (blocks)');
  eq(two.code, one.code, 'STABILITY: a second open/save cycle is a fixed point (code)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
