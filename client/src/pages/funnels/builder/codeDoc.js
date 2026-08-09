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
//                                      inside a tagged <script>)
//
// The <!DOCTYPE>/<html>/<head>/<body> framing is COSMETIC SCAFFOLDING: it is
// regenerated on every load and stripped on save, exactly as the reference
// does. It exists so the document reads like a page, not so it is stored.
//
// ── TWO DELIBERATE DEVIATIONS FROM THE REFERENCE, BOTH TOWARD SAFETY ───────
//
// 1. custom_js round-trips inside `<script data-lb="page-js">`, its own
//    identifiable wrapper, instead of being concatenated into the body-end
//    string. The reference merges them and has to guess on the way back; a
//    tagged wrapper makes the split exact, so a page's JS cannot silently
//    migrate into its HTML (or vice versa) across one open/save cycle.
//
// 2. A block that exists NOW but did not exist when the document was built
//    (added on the Builder tab in another tab/session since) is PRESERVED and
//    appended, not dropped. The reference documents dropping it as a known
//    corollary of marker bookkeeping; here `knownIds` records what the
//    document actually described, so "no marker" can be told apart from
//    "never in this document" — and only the former means delete.
//
// Everything here is pure and DOM-free (the one place a DOM parser is useful
// is injected), so server/tests/builder/code-doc.mjs can drive it in node.

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export const SECTION_KEYS = ['@HEAD', '@BODY-TOP', '@BLOCKS', '@BODY-END'];

export const MARK = {
  head: '<!-- ═══ @HEAD — injected into the page <head> ═══ -->',
  bodyTop: '<!-- ═══ @BODY-TOP — custom HTML at the top of <body> ═══ -->',
  blocks: '<!-- ═══ @BLOCKS — this page\'s blocks; paste HTML here to make a new block ═══ -->',
  bodyEnd: '<!-- ═══ @BODY-END — HTML and JS before </body> ═══ -->',
};

export const PAGE_JS_OPEN = '<script data-lb="page-js">';
export const PAGE_JS_CLOSE = '</script>';

export const blockMarker = (b) => `<!-- @block ${b.id} [${b.type}] -->`;
export const colMarker = (i) => `<!-- @col ${i} -->`;

// Anchored on the exact marker shape we emit. Global — used with split().
export const BLOCK_MARK_RE = /<!--\s*@block\s+([A-Za-z0-9_-]+)\s+\[([A-Za-z0-9_]+)\]\s*-->/g;
const COL_MARK_RE = /<!--\s*@col\s+(\d+)\s*-->/g;

// Blocks whose MARKUP IS A PROP — the same allow-list the inspector uses.
// For every other type the markup is produced by the server renderer, which
// this client does not own and must not re-implement.
export const HTML_PROP_BY_TYPE = {
  custom_html: 'html',
  html: 'html',
  embed: 'html',
  section: 'html',
  text: 'html',
};
export const CSS_PROP_BY_TYPE = { custom_html: 'css' };

// What a server-rendered block shows in place of markup we cannot generate
// here. Leaving it UNCHANGED is what tells the save "this block was not
// edited" — the same proof-of-edit test the reference applies to its own
// server renders.
export const SERVER_RENDER_PLACEHOLDER =
  '<!-- rendered by the server from this block\'s props — edit them on the Builder tab, or replace this comment with your own HTML to convert the block to custom_html -->';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

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
      .map((c, i) => `${colMarker(i)}\n${str(isObj(c) ? c.html : '')}`)
      .join('\n');
  }
  const prop = HTML_PROP_BY_TYPE[type];
  if (!prop) return SERVER_RENDER_PLACEHOLDER;
  const html = str(props[prop]);
  return html.trim() ? html : SERVER_RENDER_PLACEHOLDER;
}

/**
 * Build the "Full HTML" document.
 * @param {{head_html?:string,custom_html?:string,body_end_html?:string,custom_js?:string}} code
 * @param {Array} blocks
 */
export function buildHtmlDoc(code, blocks) {
  const c = isObj(code) ? code : {};
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => isObj(b) && str(b.id));
  const blocksSrc = list.map((b) => `${blockMarker(b)}\n${blockSource(b)}`).join('\n\n');
  const js = str(c.custom_js);
  const bodyEnd = [
    str(c.body_end_html),
    js.trim() ? `${PAGE_JS_OPEN}\n${js}\n${PAGE_JS_CLOSE}` : '',
  ].filter(Boolean).join('\n\n');

  return [
    '<!DOCTYPE html>', '<html>', '<head>',
    MARK.head, str(c.head_html), '',
    '</head>', '<body>',
    MARK.bodyTop, str(c.custom_html), '',
    MARK.blocks, blocksSrc, '',
    MARK.bodyEnd, bodyEnd, '',
    '</body>', '</html>',
  ].join('\n');
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
 * A document with NO markers at all is treated as pure block markup — the
 * reference's rule, and the one that makes "paste a whole page in" work.
 */
export function splitHtmlSections(text) {
  const src = str(text);
  const parts = src.split(/<!--.*?(@HEAD|@BODY-TOP|@BLOCKS|@BODY-END).*?-->/);
  if (parts.length === 1) return { '@BLOCKS': src };
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i];
    const body = parts[i + 1] == null ? '' : parts[i + 1];
    // A repeated marker appends rather than overwrites — an operator who
    // duplicated a section header must not silently lose the first half.
    out[key] = out[key] == null ? body : `${out[key]}\n${body}`;
  }
  return out;
}

/** Strip the cosmetic scaffolding a section may have picked up. */
export function stripScaffold(text) {
  return str(text)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?(html|head|body)\s*>/gi, '')
    .trim();
}

/**
 * Pull the tagged page-JS wrapper out of the @BODY-END section.
 * @returns {{html:string, js:string}}
 */
export function splitBodyEnd(text) {
  const src = stripScaffold(text);
  const re = /<script\s+data-lb="page-js"\s*>([\s\S]*?)<\/script>/i;
  const m = re.exec(src);
  if (!m) return { html: src.trim(), js: '' };
  return { html: src.replace(re, '').trim(), js: m[1].replace(/^\n/, '').replace(/\n$/, '') };
}

/** Split the CSS doc back into per-block CSS + page CSS. */
export function parseCssDoc(text) {
  const src = str(text);
  const parts = src.split(/\/\*\s*═══\s*@(BLOCK\s+[A-Za-z0-9_-]+|PAGE)[^*]*═══\s*\*\//);
  const byBlock = {};
  let page = '';
  if (parts.length === 1) return { byBlock, page: src.trim() };
  for (let i = 1; i < parts.length; i += 2) {
    const key = str(parts[i]).trim();
    const body = str(parts[i + 1]).trim();
    if (key === 'PAGE') page = page ? `${page}\n${body}` : body;
    else {
      const id = key.replace(/^BLOCK\s+/, '');
      byBlock[id] = byBlock[id] ? `${byBlock[id]}\n${body}` : body;
    }
  }
  return { byBlock, page };
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
  const els = Array.from(t.content.children).map((el) => el.outerHTML);
  if (els.length) return els;
  const text = str(t.textContent).trim();
  return text ? [str(html).trim()] : [];
}

/**
 * Map the @BLOCKS text back onto the blocks array.
 *
 * @param {string} blocksText
 * @param {Array} currentBlocks   blocks as they are NOW
 * @param {string[]} knownIds     ids the document was BUILT from
 * @param {{newId:()=>string, splitElements?:(html:string)=>string[]}} deps
 * @returns {{blocks:Array, created:number, removed:number, retyped:number}}
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
  let created = 0;
  let retyped = 0;

  const emitLoose = (markup) => {
    const text = str(markup).trim();
    if (!text) return;
    for (const el of splitElements(text)) {
      const html = str(el).trim();
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

    // A marker naming an id we do not have is not addressable — treat its
    // markup as loose rather than inventing a block with a foreign id.
    if (!existing || seen.has(id)) { emitLoose(segment); continue; }
    seen.add(id);

    const type = str(existing.type) || declaredType;
    const props = isObj(existing.props) ? { ...existing.props } : {};
    const body = segment.trim();

    if (type === 'row') {
      COL_MARK_RE.lastIndex = 0;
      const colParts = body.split(COL_MARK_RE);
      if (colParts.length > 1) {
        const cols = [];
        for (let c = 1; c < colParts.length; c += 2) cols.push({ html: str(colParts[c + 1]).trim() });
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
      props[htmlProp] = wasPlaceholder ? '' : body;
      out.push({ ...existing, props });
      continue;
    }

    // Server-rendered block. UNCHANGED placeholder -> keep it exactly as it
    // is. CHANGED -> the operator has written markup the server would ignore,
    // so the block converts to custom_html, which is the only type that can
    // honour it. Never silently discard what they typed.
    if (normalizeMarkup(body) === normalizeMarkup(SERVER_RENDER_PLACEHOLDER) || !body) {
      out.push(existing);
    } else {
      out.push({ ...existing, type: 'custom_html', props: { ...props, html: body, css: str(props.css) } });
      retyped += 1;
    }
  }

  // Blocks the document never described (added elsewhere since it was built)
  // are PRESERVED — only a marker that was deleted means delete.
  const preserved = [];
  for (const b of Array.isArray(currentBlocks) ? currentBlocks : []) {
    if (!isObj(b)) continue;
    const id = str(b.id);
    if (id && !known.has(id) && !seen.has(id)) preserved.push(b);
  }

  const removed = Array.from(known).filter((id) => byId.has(id) && !seen.has(id)).length;
  return { blocks: out.concat(preserved), created, removed, retyped };
}

/**
 * Full round-trip: document text -> the exact payload the pages PATCH takes.
 * The caller still sends it through the SAME validateBlocks-guarded endpoint
 * every other builder edit uses — nothing here writes.
 */
export function parseCodeDocs({ htmlDoc, cssDoc, blocks, knownIds, deps }) {
  const sections = splitHtmlSections(htmlDoc);
  const bodyEnd = splitBodyEnd(sections['@BODY-END'] || '');
  const parsed = parseBlocksSection(sections['@BLOCKS'] || '', blocks, knownIds, deps);
  const css = parseCssDoc(cssDoc);

  const nextBlocks = parsed.blocks.map((b) => {
    const prop = CSS_PROP_BY_TYPE[str(b.type)];
    if (!prop) return b;
    const id = str(b.id);
    if (!(id in css.byBlock)) return b;
    return { ...b, props: { ...(isObj(b.props) ? b.props : {}), [prop]: css.byBlock[id] } };
  });

  return {
    blocks: nextBlocks,
    code: {
      head_html: stripScaffold(sections['@HEAD'] || ''),
      custom_html: stripScaffold(sections['@BODY-TOP'] || ''),
      body_end_html: bodyEnd.html,
      custom_js: bodyEnd.js,
      custom_css: css.page,
    },
    stats: { created: parsed.created, removed: parsed.removed, retyped: parsed.retyped },
  };
}
