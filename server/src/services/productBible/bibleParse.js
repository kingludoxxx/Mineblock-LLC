// PRODUCT BIBLE — pure parsing (no database). Turns one market's research into rows.
//
//   parseBibleMarkdown(md)            -> { title, sections: [{ord, anchor, level, title, parent_anchor, markdown, html, char_count}] }
//   buildEntities(library)            -> [{type, key, title, tier, data, avatar_keys, angle_keys, quote_ids, search_text, ord}]
//   selectQuotes(libraryJsonl, market)-> [{quote_id, quote, source, url, speaker, avatar, tags, hook_strength, failed_solution}]
//   validateBible({sections, entities, quotes, citedIds}) -> string[] problems (empty = valid)
//
// R15: nothing here names a product, market, store or brand. Shapes are read generically so two
// markets whose research files differ in optional fields both import.

import { Marked } from 'marked';

export const ENTITY_LIST_TYPES = {
  avatars: 'avatar', angles: 'angle', beliefs: 'belief', objections: 'objection', hooks: 'hook',
  competitors: 'competitor', solutions: 'solution', proven_winners: 'proven_winner',
  sophistication: 'sophistication', test_queue: 'test_queue',
};
export const ENTITY_OBJECT_TYPES = { launch_map: 'launch_map', desires: 'desire', mechanism: 'mechanism', market: 'market_fact' };
const STRING_LIST_TYPES = { banned_phrases: 'banned_phrase', tired_words: 'tired_word' };
const SCALAR_META = new Set(['product', 'funnel', 'price', 'guarantee', 'version', 'written', 'generated', 'source_bible']);
const QUOTE_ID_RE = /\bQ\d{4,5}\b/g;

export function slugify(s, max = 80) {
  const out = String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return out || 'section';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeMarked() {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Raw HTML inside a research document is shown as text, never executed.
      html(token) { return escapeHtml(token.text ?? token.raw ?? ''); },
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const id = slugify(token.text);
        return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
      },
      link(token) {
        const href = String(token.href || '');
        const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
        const text = this.parser.parseInline(token.tokens);
        const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${escapeHtml(safe)}"${ext}>${text}</a>`;
      },
      image(token) { return escapeHtml(token.text || ''); },
      table(token) {
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
        return `<div class="pb-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(md) {
  const html = makeMarked().parse(String(md ?? ''));
  // Quote ids become addressable chips the UI can resolve against the quotes API.
  return html.replace(/\[(Q\d{4,5})\]/g, '<span class="pb-qid" data-qid="$1">$1</span>');
}

/** Split at H2; H3 headings become child TOC rows (markdown/html empty, content lives in the H2 chunk). */
export function parseBibleMarkdown(md) {
  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let title = '';
  const chunks = [];
  let cur = null;
  let inFence = false;
  const preamble = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h1 = !inFence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && !title && !chunks.length) { title = h1[1].trim(); continue; }
    if (h2) { cur = { title: h2[1].trim(), body: [] }; chunks.push(cur); continue; }
    (cur ? cur.body : preamble).push(line);
  }
  const used = new Map();
  const uniq = (base) => {
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  const sections = [];
  let ord = 0;
  const pre = preamble.join('\n').trim();
  if (pre) {
    const anchor = uniq('introduction');
    sections.push({ ord: ord++, anchor, level: 2, title: 'Introduction', parent_anchor: null, markdown: pre, html: renderMarkdown(pre), char_count: pre.length });
  }
  for (const c of chunks) {
    const body = c.body.join('\n').trim();
    const anchor = uniq(slugify(c.title));
    const markdown = `## ${c.title}\n\n${body}`;
    let html = renderMarkdown(markdown);
    // Ids inside a chunk must be unique across the whole document: prefix H3/H4 ids with the H2 anchor.
    const childIds = [];
    html = html.replace(/<h([34]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (m, lvl, id, inner) => {
      const childAnchor = uniq(`${anchor}--${id}`);
      childIds.push({ level: Number(lvl), anchor: childAnchor, title: inner.replace(/<[^>]+>/g, '').trim() });
      return `<h${lvl} id="${childAnchor}">${inner}</h${lvl}>`;
    });
    html = html.replace(/<h2 id="[^"]+">/, `<h2 id="${anchor}">`);
    sections.push({ ord: ord++, anchor, level: 2, title: c.title, parent_anchor: null, markdown, html, char_count: markdown.length });
    for (const ch of childIds) {
      if (ch.level !== 3) continue;
      sections.push({ ord: ord++, anchor: ch.anchor, level: 3, title: ch.title, parent_anchor: anchor, markdown: '', html: '', char_count: 0 });
    }
  }
  return { title, sections };
}

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const strings = (v) => asArray(v).flatMap((x) => (typeof x === 'string' ? [x] : [])).filter(Boolean);

function collectQuoteIds(obj) {
  const found = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 10 || v === null || v === undefined) return;
    if (typeof v === 'string') { for (const m of v.matchAll(QUOTE_ID_RE)) found.add(m[0]); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(obj);
  return [...found];
}

function flattenText(obj, max = 20000) {
  const parts = [];
  const walk = (v, depth = 0) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') { parts.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(obj);
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, max);
}

function titleOf(type, item) {
  const pick = item.name || item.title || item.belief || item.objection || item.hook || item.route
    || item.advertiser || item.brand || item.product || (item.angle_id ? `#${item.rank ?? ''} ${item.angle_id}` : '');
  return String(pick || type).slice(0, 500);
}

function avatarKeysOf(item) {
  return [...new Set([
    ...strings(item.avatar_ids), ...strings(item.avatar_id), ...strings(item.lead_avatars), ...strings(item.avatars),
  ])];
}
function angleKeysOf(item) {
  return [...new Set([...strings(item.angle_id), ...strings(item.angle_ids), ...strings(item.best_angle_ids)])];
}

export function buildEntities(library) {
  if (!library || typeof library !== 'object' || Array.isArray(library)) throw new Error('library JSON must be an object');
  const out = [];
  const seen = new Set();
  const add = (e) => {
    let key = e.key; let n = 1;
    while (seen.has(`${e.type}:${key}`)) { n += 1; key = `${e.key}-${n}`; }
    seen.add(`${e.type}:${key}`);
    out.push({ ...e, key });
  };
  for (const [field, value] of Object.entries(library)) {
    if (ENTITY_LIST_TYPES[field] && Array.isArray(value)) {
      const type = ENTITY_LIST_TYPES[field];
      value.forEach((item, i) => {
        const obj = (item && typeof item === 'object') ? item : { text: item };
        const base = obj.id ? slugify(obj.id).replace(/-/g, '_') : slugify(titleOf(type, obj), 60).replace(/-/g, '_');
        const key = (obj.id ? String(obj.id) : (type === 'test_queue' ? `rank_${obj.rank ?? i + 1}` : `${base || type}_${i + 1}`)).slice(0, 120);
        add({
          type, key, title: titleOf(type, obj), tier: obj.tier ? String(obj.tier) : null, data: obj,
          avatar_keys: type === 'avatar' ? [String(obj.id || key)] : avatarKeysOf(obj),
          angle_keys: type === 'angle' ? [String(obj.id || key)] : angleKeysOf(obj),
          quote_ids: collectQuoteIds(obj), search_text: flattenText(obj), ord: i,
        });
      });
    } else if (ENTITY_OBJECT_TYPES[field] && value && typeof value === 'object') {
      add({ type: ENTITY_OBJECT_TYPES[field], key: field, title: field.replace(/_/g, ' '), tier: null, data: value,
        avatar_keys: [], angle_keys: [], quote_ids: collectQuoteIds(value), search_text: flattenText(value), ord: 0 });
    } else if (STRING_LIST_TYPES[field] && Array.isArray(value)) {
      add({ type: STRING_LIST_TYPES[field], key: 'all', title: field.replace(/_/g, ' '), tier: null, data: { items: strings(value) },
        avatar_keys: [], angle_keys: [], quote_ids: [], search_text: strings(value).join(' | '), ord: 0 });
    } else if (!SCALAR_META.has(field) && value !== null && value !== undefined && value !== '') {
      add({ type: 'flag', key: field, title: field.replace(/_/g, ' '), tier: null, data: { value },
        avatar_keys: [], angle_keys: [], quote_ids: collectQuoteIds(value), search_text: flattenText(value), ord: 0 });
    }
  }
  return out;
}

/** Quotes from a JSONL library for one market: funnel === market or 'both'. */
export function selectQuotes(jsonlText, marketKey) {
  const out = [];
  const seen = new Set();
  String(jsonlText ?? '').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let r;
    try { r = JSON.parse(t); } catch (e) { throw new Error(`quotes line ${i + 1} is not valid JSON: ${e.message}`); }
    if (!r.id || !r.quote) return;
    if (r.funnel !== marketKey && r.funnel !== 'both') return;
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({
      quote_id: String(r.id), quote: String(r.quote), source: r.source ?? null, url: r.url ?? null, speaker: r.speaker ?? null,
      avatar: r.avatar ?? null, tags: strings(r.tags), hook_strength: Number.isFinite(Number(r.hook_strength)) ? Number(r.hook_strength) : null,
      failed_solution: r.failed_solution ?? null,
    });
  });
  return out;
}

export function citedQuoteIds(md, entities) {
  const ids = new Set();
  for (const m of String(md ?? '').matchAll(QUOTE_ID_RE)) ids.add(m[0]);
  for (const e of entities) e.quote_ids.forEach((q) => ids.add(q));
  return ids;
}

export function validateBible({ sections, entities, quotes, citedIds, allQuoteIds }) {
  const problems = [];
  const h2 = sections.filter((s) => s.level === 2);
  if (h2.length < 5) problems.push(`only ${h2.length} top-level sections (need at least 5)`);
  const count = (t) => entities.filter((e) => e.type === t).length;
  if (count('avatar') < 1) problems.push('no avatars in the library JSON');
  if (count('angle') < 1) problems.push('no angles in the library JSON');
  const avatarKeys = new Set(entities.filter((e) => e.type === 'avatar').map((e) => e.key));
  const angleKeys = new Set(entities.filter((e) => e.type === 'angle').map((e) => e.key));
  for (const a of entities.filter((e) => e.type === 'angle')) {
    const unknown = a.avatar_keys.filter((k) => !avatarKeys.has(k));
    if (unknown.length) problems.push(`angle ${a.key} names unknown avatar(s): ${unknown.slice(0, 5).join(', ')}`);
  }
  for (const a of entities.filter((e) => e.type === 'avatar')) {
    const best = asArray(a.data.best_angle_ids).filter((k) => typeof k === 'string');
    const unknown = best.filter((k) => !angleKeys.has(k));
    if (unknown.length) problems.push(`avatar ${a.key} names unknown angle(s): ${unknown.slice(0, 5).join(', ')}`);
  }
  if (!quotes.length) problems.push('no quotes selected for this market');
  const available = allQuoteIds || new Set(quotes.map((q) => q.quote_id));
  const missing = [...citedIds].filter((id) => !available.has(id));
  if (missing.length) problems.push(`${missing.length} cited quote id(s) missing from the quotes file: ${missing.slice(0, 8).join(', ')}`);
  return problems;
}
