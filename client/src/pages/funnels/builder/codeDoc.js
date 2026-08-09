// PAGE BUILDER — Code view document model.
//
// MIRRORS THE REFERENCE TOOL (funnel-os LBCodeTab.jsx): the Code view is not a
// stack of per-block boxes, it is ONE editable document per sub-tab —
// "Full HTML" and "CSS" — in which blocks are delimited by HTML/CSS COMMENT
// MARKERS. Editing is free-text; the markers are what let a save map the text
// back onto the blocks array.
//
//   <!-- ═══ @HEAD … ═══ -->        -> page.head_html
//   <!-- ═══ @BODY-TOP … ═══ -->    -> page.custom_html
//   <!-- ═══ @BLOCKS … ═══ -->      -> page.blocks
//        <!-- @block <id> [<type>] -->   one per block
//        <!-- @col <i> -->               one per row column
//   <!-- ═══ @BODY-END … ═══ -->    -> page.body_end_html (+ page.custom_js,
//                                      inside a nonce-anchored <script>)
//
// The <!DOCTYPE>/<html>/<head>/<body> framing is COSMETIC SCAFFOLDING: it is
// regenerated on every load and stripped on save, exactly as the reference
// does. It exists so the document reads like a page, not so it is stored.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR RULES THAT KEEP A SAVE FROM DESTROYING A PAGE
// ═══════════════════════════════════════════════════════════════════════════
//
// R1. A MISSING SECTION IS "NOT DESCRIBED", NEVER "EMPTIED".
//     Deleting the `@BLOCKS` header line used to make the whole document read
//     as "zero blocks described", and every block scored as an intentional
//     deletion — one removed line blanked a live page. A field family is only
//     written when ITS OWN section header is present. Deletions are scored
//     only inside a section that exists.
//
// R2. MONEY BLOCKS CANNOT BE RETYPED.
//     Editing the markup under a block used to convert it to custom_html.
//     For `order_bump` that silently discards its charging identity, and for
//     `whop_checkout` it removes the type the checkout runtime keys on — a
//     text edit could take a page off the money path with no warning. Those
//     conversions are now REFUSED with a named error.
//
// R3. THE PAGE-JS WRAPPER IS NONCE-ANCHORED AND ESCAPED.
//     A `</script>` inside custom_js used to truncate the wrapper and leak the
//     tail into live HTML; a `data-lb="page-js"` script the operator wrote in
//     body_end_html used to swap places with the real JS on every save. The
//     wrapper now carries a per-build nonce (only that exact one is parsed
//     back) and `</script>` is escaped inside the emitted body.
//
// R4. MARKERS INSIDE OPERATOR CONTENT ARE TEXT.
//     A section or block marker pasted into a block's HTML used to escape its
//     own section and hijack head_html / custom_js. Marker-shaped comments in
//     operator content are escaped on emit and restored on parse, and every
//     marker regex is anchored so an escaped one cannot match.
//
// ── TWO DELIBERATE DEVIATIONS FROM THE REFERENCE, BOTH TOWARD SAFETY ───────
//
// 1. custom_js round-trips inside its own identifiable wrapper instead of
//    being concatenated into the body-end string (see R3).
//
// 2. A block that exists NOW but did not exist when the document was built is
//    PRESERVED and appended, not dropped. The reference documents dropping it
//    as a known corollary of marker bookkeeping; here `knownIds` records what
//    the document actually described, so "no marker" can be told apart from
//    "never in this document" — and only the former means delete.
//
// Everything here is pure and DOM-free (the one place a DOM parser is useful
// is injected), so server/tests/builder/code-doc.mjs can drive it in node.

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export const SECTION_KEYS = ['@HEAD', '@BODY-TOP', '@BLOCKS', '@BODY-END'];

// NO `<` OR `>` INSIDE MARKER PROSE. The section regexes end at `[^>]*-->`,
// so an embedded tag like `<head>` would terminate the match early and the
// marker would stop being recognised — which, under R1, reads as "this
// section is missing" and silently declines to write the field. The prose
// says "head" and "body" in words for exactly that reason.
export const MARK = {
  head: '<!-- ═══ @HEAD — injected into the page head ═══ -->',
  bodyTop: '<!-- ═══ @BODY-TOP — custom HTML at the top of the body ═══ -->',
  blocks: '<!-- ═══ @BLOCKS — this page\'s blocks; paste HTML here to make a new block ═══ -->',
  bodyEnd: '<!-- ═══ @BODY-END — HTML and JS before the closing body tag ═══ -->',
};

/** Which page column each section owns. R1 keys off exactly this map. */
export const SECTION_FIELD = {
  '@HEAD': 'head_html',
  '@BODY-TOP': 'custom_html',
  '@BODY-END': 'body_end_html', // also custom_js, via the nonce'd wrapper
};

export const blockMarker = (b) => `<!-- @block ${b.id} [${b.type}] -->`;
export const colMarker = (i) => `<!-- @col ${i} -->`;

// ANCHORED on the exact shapes we emit. `<!--` followed immediately by
// optional WHITESPACE only — which is what makes the `\`-escape in R4 work:
// a backslash is not whitespace, so an escaped marker cannot match.
export const BLOCK_MARK_RE = /<!--[ \t]*@block[ \t]+([A-Za-z0-9_-]+)[ \t]+\[([A-Za-z0-9_]+)\][ \t]*-->/g;
const COL_MARK_RE = /<!--[ \t]*@col[ \t]+(\d+)[ \t]*-->/g;
const SECTION_MARK_RE = /<!--[ \t]*═══[ \t]*(@HEAD|@BODY-TOP|@BLOCKS|@BODY-END)\b[^>]*-->/;
const SECTION_SPLIT_RE = /<!--[ \t]*═══[ \t]*(@HEAD|@BODY-TOP|@BLOCKS|@BODY-END)\b[^>]*-->/g;

// R2. Types whose IDENTITY is load-bearing on the money path or the public
// renderer's runtime wiring. A text edit may change their CONTENT props; it
// may never change what they ARE.
export const PROTECTED_TYPES = new Set([
  'order_bump',        // data-bump-armed + POST /session/:id/bump
  'whop_checkout',     // arms the checkout runtime
  'order_summary',     // arms the checkout runtime
  'stripe_checkout',
  'express_checkout',
  'checkout_template',
  'shipping_method',
  'product',
]);

export class CodeDocRefusal extends Error {
  constructor(message, code = 'code_doc_refused') {
    super(message);
    this.name = 'CodeDocRefusal';
    this.code = code;
  }
}

// Blocks whose MARKUP IS A PROP — the same allow-list the inspector uses.
export const HTML_PROP_BY_TYPE = {
  custom_html: 'html',
  html: 'html',
  embed: 'html',
  section: 'html',
  text: 'html',
};
export const CSS_PROP_BY_TYPE = { custom_html: 'css' };

export const SERVER_RENDER_PLACEHOLDER =
  '<!-- rendered by the server from this block\'s props — edit them on the Builder tab, or replace this comment with your own HTML to convert the block to custom_html -->';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// R4 — marker escaping inside operator content
// ---------------------------------------------------------------------------

/**
 * Neutralise marker-shaped comments in operator content by inserting a single
 * `\` immediately after `<!--`. Every marker regex requires whitespace-only
 * between `<!--` and the marker body, so an escaped one cannot match — and
 * because the escape is inside a COMMENT, it changes nothing about how a
 * browser renders the content.
 */
export function escapeMarkers(text) {
  return str(text).replace(/<!--([ \t]*)(═══[ \t]*(?:@HEAD|@BODY-TOP|@BLOCKS|@BODY-END)\b|[ \t]*@block[ \t]|[ \t]*@col[ \t])/g,
    (_m, ws, body) => `<!--\\${ws}${body}`);
}

/** Inverse of escapeMarkers — removes ONE backslash directly after `<!--`. */
export function unescapeMarkers(text) {
  return str(text).replace(/<!--\\/g, '<!--');
}

// ---------------------------------------------------------------------------
// R3 — page-JS wrapper
// ---------------------------------------------------------------------------

/** Per-document nonce. Only the wrapper carrying THIS value is parsed back. */
export function makeNonce() {
  return `n${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// `</script>` inside a script body ends the element, whatever the JS meant.
// Escaping the slash is the standard, semantics-preserving fix.
const escapeScriptBody = (js) => str(js).replace(/<\/script/gi, '<\\/script');
const unescapeScriptBody = (js) => str(js).replace(/<\\\/script/gi, '</script');

export const pageJsOpen = (nonce) => `<script data-lb="page-js" data-nonce="${nonce}">`;
export const PAGE_JS_CLOSE = '</script>';

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** The source text for one block inside the @BLOCKS section. */
export function blockSource(block) {
  const type = str(block?.type);
  const props = isObj(block?.props) ? block.props : {};
  if (type === 'row') {
    const cols = Array.isArray(props.columns) ? props.columns : [];
    if (!cols.length) return SERVER_RENDER_PLACEHOLDER;
    return cols
      .map((c, i) => `${colMarker(i)}\n${escapeMarkers(str(isObj(c) ? c.html : ''))}`)
      .join('\n');
  }
  const prop = HTML_PROP_BY_TYPE[type];
  if (!prop) return SERVER_RENDER_PLACEHOLDER;
  const html = str(props[prop]);
  return html.trim() ? escapeMarkers(html) : SERVER_RENDER_PLACEHOLDER;
}

/**
 * Build the "Full HTML" document.
 * @returns {{text:string, nonce:string}}
 */
export function buildHtmlDoc(code, blocks, nonce = makeNonce()) {
  const c = isObj(code) ? code : {};
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => isObj(b) && str(b.id));
  const blocksSrc = list.map((b) => `${blockMarker(b)}\n${blockSource(b)}`).join('\n\n');
  const js = str(c.custom_js);
  const bodyEnd = [
    escapeMarkers(str(c.body_end_html)),
    js.trim() ? `${pageJsOpen(nonce)}\n${escapeScriptBody(js)}\n${PAGE_JS_CLOSE}` : '',
  ].filter(Boolean).join('\n\n');

  const text = [
    '<!DOCTYPE html>', '<html>', '<head>',
    MARK.head, escapeMarkers(str(c.head_html)), '',
    '</head>', '<body>',
    MARK.bodyTop, escapeMarkers(str(c.custom_html)), '',
    MARK.blocks, blocksSrc, '',
    MARK.bodyEnd, bodyEnd, '',
    '</body>', '</html>',
  ].join('\n');
  return { text, nonce };
}

/** Build the "CSS" document: per-block CSS, then the page CSS. */
export function buildCssDoc(code, blocks) {
  const c = isObj(code) ? code : {};
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!isObj(b) || !str(b.id)) continue;
    const prop = CSS_PROP_BY_TYPE[str(b.type)];
    if (!prop) continue;
    const props = isObj(b.props) ? b.props : {};
    out.push(`/* ═══ @BLOCK ${b.id} — CSS for that ${b.type} block ═══ */`);
    out.push(str(props[prop]));
    out.push('');
  }
  out.push('/* ═══ @PAGE — this page\'s custom CSS ═══ */');
  out.push(str(c.custom_css));
  return out.join('\n');
}

/** The ids a document DESCRIBES — the set a missing marker means "deleted" over. */
export function docBlockIds(blocks) {
  const ids = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (isObj(b) && str(b.id)) ids.push(str(b.id));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Split the Full HTML doc on its section markers.
 *
 * R1: the returned object contains a key ONLY for a section whose header is
 * actually present. `'@BLOCKS' in sections` is therefore the exact test for
 * "this document describes the blocks", and a missing key means UNTOUCHED.
 *
 * A document with NO markers at all is treated as pure block markup — the
 * reference's rule, and what makes "paste a whole page in" work.
 *
 * @returns {{sections:Object, preamble:string, hadAnyMarker:boolean}}
 */
export function splitHtmlSections(text) {
  const src = str(text);
  if (!SECTION_MARK_RE.test(src)) {
    return { sections: { '@BLOCKS': src }, preamble: '', hadAnyMarker: false };
  }
  SECTION_SPLIT_RE.lastIndex = 0;
  const parts = src.split(SECTION_SPLIT_RE);
  const sections = {};
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i];
    const body = parts[i + 1] == null ? '' : parts[i + 1];
    // A repeated marker appends rather than overwrites — an operator who
    // duplicated a section header must not silently lose the first half.
    sections[key] = sections[key] == null ? body : `${sections[key]}\n${body}`;
  }
  // F13: anything above the FIRST marker is real content the operator can see.
  // It is handed back rather than dropped so the caller can preserve it.
  return { sections, preamble: parts[0] == null ? '' : parts[0], hadAnyMarker: true };
}

/** Strip the cosmetic scaffolding a section may have picked up. */
export function stripScaffold(text) {
  return str(text)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?(html|head|body)\s*>/gi, '')
    .trim();
}

/**
 * Pull the nonce-anchored page-JS wrapper out of the @BODY-END section (R3).
 * A wrapper WITHOUT this document's nonce is operator content and stays in
 * body_end_html as inert text.
 */
export function splitBodyEnd(text, nonce) {
  const src = stripScaffold(text);
  if (!nonce) return { html: unescapeMarkers(src), js: '' };
  const re = new RegExp(
    `<script\\s+data-lb="page-js"\\s+data-nonce="${nonce.replace(/[^A-Za-z0-9]/g, '')}"\\s*>([\\s\\S]*?)<\\/script>`,
    'i'
  );
  const m = re.exec(src);
  if (!m) return { html: unescapeMarkers(src), js: '' };
  return {
    html: unescapeMarkers(src.replace(re, '').trim()),
    js: unescapeScriptBody(m[1].replace(/^\n/, '').replace(/\n$/, '')),
  };
}

/** Split the CSS doc back into per-block CSS + page CSS. */
export function parseCssDoc(text) {
  const src = str(text);
  const parts = src.split(/\/\*[ \t]*═══[ \t]*@(BLOCK[ \t]+[A-Za-z0-9_-]+|PAGE)\b[^*]*\*\//);
  const byBlock = {};
  let page = '';
  if (parts.length === 1) return { byBlock, page: src.trim(), described: false };
  for (let i = 1; i < parts.length; i += 2) {
    const key = str(parts[i]).trim();
    const body = str(parts[i + 1]).trim();
    if (key === 'PAGE') page = page ? `${page}\n${body}` : body;
    else {
      const id = key.replace(/^BLOCK[ \t]+/, '');
      byBlock[id] = byBlock[id] ? `${byBlock[id]}\n${body}` : body;
    }
  }
  return { byBlock, page, described: true };
}

/** Whitespace-insensitive comparison — "did the operator actually change it?" */
export function normalizeMarkup(s) {
  return str(s).replace(/\s+/g, ' ').trim();
}

/**
 * Default splitter for loose markup -> one block per top-level element.
 * Uses the DOM as the parser (the reference's approach). In node the caller
 * injects a stub, which is why this is a parameter rather than an import.
 */
export function domElementSplitter(html) {
  if (typeof document === 'undefined') return [str(html).trim()].filter(Boolean);
  const t = document.createElement('template');
  t.innerHTML = str(html);
  const out = [];
  for (const node of Array.from(t.content.childNodes)) {
    if (node.nodeType === 1) out.push(node.outerHTML);            // element
    else if (node.nodeType === 8) out.push(`<!--${node.data}-->`); // comment
    else if (node.nodeType === 3 && node.data.trim()) out.push(node.data.trim());
  }
  return out;
}

/**
 * Map the @BLOCKS text back onto the blocks array.
 *
 * @returns {{blocks:Array, created:number, removed:number, retyped:number, notices:string[]}}
 * @throws {CodeDocRefusal} when a PROTECTED type would be converted (R2)
 */
export function parseBlocksSection(blocksText, currentBlocks, knownIds, deps) {
  const newId = deps && typeof deps.newId === 'function' ? deps.newId : () => `blk_${Math.random().toString(36).slice(2, 10)}`;
  const splitElements = deps && typeof deps.splitElements === 'function' ? deps.splitElements : domElementSplitter;

  const byId = new Map();
  for (const b of Array.isArray(currentBlocks) ? currentBlocks : []) {
    if (isObj(b) && str(b.id)) byId.set(str(b.id), b);
  }
  const known = new Set((Array.isArray(knownIds) ? knownIds : []).map(String));

  const src = stripScaffold(blocksText);
  BLOCK_MARK_RE.lastIndex = 0;
  const parts = src.split(BLOCK_MARK_RE);

  const out = [];
  const seen = new Set();
  const notices = [];
  let created = 0;
  let retyped = 0;

  const emitLoose = (markup) => {
    const text = str(markup).trim();
    if (!text) return;
    for (const el of splitElements(text)) {
      const html = unescapeMarkers(str(el).trim());
      if (!html) continue;
      out.push({ id: newId(), type: 'custom_html', props: { html, css: '' } });
      created += 1;
    }
  };

  // parts = [preamble, id, type, segment, id, type, segment, …]
  emitLoose(parts[0]);
  for (let i = 1; i < parts.length; i += 3) {
    const id = str(parts[i]);
    const declaredType = str(parts[i + 1]);
    const segment = str(parts[i + 2]);
    const existing = byId.get(id);

    if (!existing) {
      notices.push(`A marker named block “${id}”, which is not on this page — its markup was kept as a new block.`);
      emitLoose(segment);
      continue;
    }
    if (seen.has(id)) {
      // F21: a duplicated marker is a real editing mistake. Say so rather than
      // emitting the same block twice (which validateBlocks would accept and
      // the renderer would draw twice).
      notices.push(`Block “${id}” appeared twice — the duplicate marker was ignored.`);
      continue;
    }
    seen.add(id);

    const type = str(existing.type) || declaredType;
    const props = isObj(existing.props) ? { ...existing.props } : {};
    const body = segment.trim();
    const label = str(props.block_name) || type;

    if (type === 'row') {
      COL_MARK_RE.lastIndex = 0;
      const colParts = body.split(COL_MARK_RE);
      if (colParts.length > 1) {
        const prev = Array.isArray(props.columns) ? props.columns : [];
        const cols = [];
        for (let c = 1; c < colParts.length; c += 2) {
          const idx = cols.length;
          // F18: keep any keys the column carried besides `html` — a column
          // may hold width/align the Code view does not show, and a rewrite
          // must not amount to deleting them.
          const before = isObj(prev[idx]) ? prev[idx] : {};
          cols.push({ ...before, html: unescapeMarkers(str(colParts[c + 1]).trim()) });
        }
        props.columns = cols;
        out.push({ ...existing, props });
        continue;
      }
      out.push(existing);
      continue;
    }

    const htmlProp = HTML_PROP_BY_TYPE[type];
    if (htmlProp) {
      const wasPlaceholder = normalizeMarkup(body) === normalizeMarkup(SERVER_RENDER_PLACEHOLDER);
      props[htmlProp] = wasPlaceholder ? '' : unescapeMarkers(body);
      out.push({ ...existing, props });
      continue;
    }

    // Server-rendered block. UNCHANGED placeholder -> keep it exactly as is.
    if (normalizeMarkup(body) === normalizeMarkup(SERVER_RENDER_PLACEHOLDER) || !body) {
      out.push(existing);
      continue;
    }

    // R2 — a protected type may never be converted by a text edit.
    if (PROTECTED_TYPES.has(type)) {
      throw new CodeDocRefusal(
        `“${label}” is a ${type} block — its markup comes from the server and it cannot be turned into custom HTML here, ` +
        `because that would remove the wiring the checkout depends on. Undo your edit under that block's marker ` +
        `(restore the placeholder comment), or delete the block on the Builder tab if you meant to remove it.`,
        'protected_block_retype'
      );
    }

    out.push({ ...existing, type: 'custom_html', props: { ...props, html: unescapeMarkers(body), css: str(props.css) } });
    retyped += 1;
    notices.push(`“${label}” was converted to a custom HTML block because its markup was edited here.`);
  }

  // Blocks the document never described are PRESERVED — only a marker that was
  // deleted means delete.
  const preserved = [];
  for (const b of Array.isArray(currentBlocks) ? currentBlocks : []) {
    if (!isObj(b)) continue;
    const id = str(b.id);
    if (id && !known.has(id) && !seen.has(id)) preserved.push(b);
  }

  const removed = Array.from(known).filter((id) => byId.has(id) && !seen.has(id)).length;
  return { blocks: out.concat(preserved), created, removed, retyped, notices };
}

/**
 * Full round-trip: document text -> the exact payload the pages PATCH takes.
 *
 * R1 IS ENFORCED HERE: `code` carries ONLY the fields whose section headers
 * were present, and `blocks` is null when the document did not describe them.
 * The caller must send only what is returned — never a default for a field
 * this document said nothing about.
 *
 * @returns {{blocks:Array|null, code:Object, stats:Object, notices:string[]}}
 * @throws {CodeDocRefusal}
 */
export function parseCodeDocs({ htmlDoc, cssDoc, blocks, knownIds, nonce, deps }) {
  const { sections, preamble, hadAnyMarker } = splitHtmlSections(htmlDoc);
  const notices = [];
  const code = {};

  // F13: content above the first marker belongs to the nearest field family.
  // It is folded into @HEAD's section when that section exists (it is the
  // first), and reported either way — never silently dropped.
  const stray = stripScaffold(preamble);
  if (stray) {
    if ('@HEAD' in sections) {
      sections['@HEAD'] = `${stray}\n${sections['@HEAD']}`;
      notices.push('Content above the first section marker was kept and folded into the @HEAD section.');
    } else if ('@BLOCKS' in sections) {
      sections['@BLOCKS'] = `${stray}\n${sections['@BLOCKS']}`;
      notices.push('Content above the first section marker was kept and folded into the @BLOCKS section.');
    } else {
      notices.push('Content above the first section marker could not be placed and was left unchanged on the page.');
    }
  }

  // R1 — write a field family ONLY when its section header exists.
  for (const [key, field] of Object.entries(SECTION_FIELD)) {
    if (!(key in sections)) continue;
    if (key === '@BODY-END') {
      const be = splitBodyEnd(sections[key], nonce);
      code.body_end_html = be.html;
      code.custom_js = be.js;
    } else {
      code[field] = unescapeMarkers(stripScaffold(sections[key]));
    }
  }
  for (const key of SECTION_KEYS) {
    if (!(key in sections) && hadAnyMarker) {
      notices.push(`The ${key} section is missing from the document — that part of the page was left untouched.`);
    }
  }

  // R1 for blocks: no @BLOCKS section => the document does not describe the
  // blocks at all, so NOTHING about them is written and nothing is deleted.
  let nextBlocks = null;
  let stats = { created: 0, removed: 0, retyped: 0 };
  if ('@BLOCKS' in sections) {
    const parsed = parseBlocksSection(sections['@BLOCKS'], blocks, knownIds, deps);
    stats = { created: parsed.created, removed: parsed.removed, retyped: parsed.retyped };
    notices.push(...parsed.notices);
    nextBlocks = parsed.blocks;
  }

  const css = parseCssDoc(cssDoc);
  if (css.described || str(cssDoc).trim()) code.custom_css = css.page;
  if (nextBlocks) {
    nextBlocks = nextBlocks.map((b) => {
      const prop = CSS_PROP_BY_TYPE[str(b.type)];
      if (!prop) return b;
      const id = str(b.id);
      if (!(id in css.byBlock)) return b;
      return { ...b, props: { ...(isObj(b.props) ? b.props : {}), [prop]: css.byBlock[id] } };
    });
  }

  return { blocks: nextBlocks, code, stats, notices };
}

// ---------------------------------------------------------------------------
// Epoch gate (review BLOCKER #2)
// ---------------------------------------------------------------------------
/**
 * What the Code view must do when the page changed UNDERNEATH its document.
 *
 * The document is built once, on mount. A version restore and an applied AI
 * batch both render outside the Builder|Code tab ternary, so either can replace
 * the page with this pane open — and neither is visible to a mount-once build.
 * Saving afterwards wrote the PRE-replacement document straight back over the
 * change: a silent rollback of the restore, or of the whole AI batch.
 *
 * The page bumps `docEpoch` on both events. The response depends only on
 * whether the operator has typed:
 *
 *   'none'    — the epoch has not moved; nothing to do.
 *   'rebuild' — the page changed and the document is CLEAN. Rebuilding costs
 *               the operator nothing and shows them the new page.
 *   'block'   — the page changed and the document is DIRTY. Auto-rebuilding
 *               would throw their text away; letting Save through would throw
 *               the page away. Neither is ours to pick, so Save is refused and
 *               the pane says why.
 *
 * Pure so the decision can be tested without a DOM — see
 * server/tests/builder/code-doc.mjs.
 */
export function codeDocEpochAction({ seenEpoch, docEpoch, dirty }) {
  if (seenEpoch === docEpoch) return 'none';
  return dirty ? 'block' : 'rebuild';
}
