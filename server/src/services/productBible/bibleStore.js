// PRODUCT BIBLE — database layer. One market's bible is written atomically; readers never see a half import.
import crypto from 'node:crypto';
import { client as sql } from '../../db/pg.js';
import { parseBibleMarkdown, buildEntities, selectQuotes, citedQuoteIds, validateBible } from './bibleParse.js';

export class BibleError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MARKET_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const SEP = String.fromCharCode(30); // record separator between hashed parts

function parseJsonl(text) {
  const byId = new Map();
  String(text ?? '').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let r;
    try { r = JSON.parse(t); } catch (e) { throw new BibleError(400, 'bad_quotes_jsonl', `quotes line ${i + 1} is not valid JSON: ${e.message}`); }
    if (r && r.id) byId.set(String(r.id), r);
  });
  return byId;
}

/**
 * Import (or re-import) one market's bible for a product.
 * @param db  a postgres.js client (defaults to the app pool); tests pass their own
 * @returns { status: 'imported'|'unchanged', marketId, counts }
 */
export async function importMarketBible({
  productId, marketKey, label, price, productUrl, sortOrder = 0,
  markdown, library, quotesJsonl, version, importedBy = 'import',
}, db = sql) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw new BibleError(400, 'bad_product', 'productId must be a positive integer');
  if (!MARKET_KEY_RE.test(String(marketKey || ''))) {
    throw new BibleError(400, 'bad_market', 'market key must be 2-40 chars: lowercase letters, digits, - or _');
  }
  if (!String(label || '').trim()) throw new BibleError(400, 'bad_label', 'market label is required');
  if (!String(markdown || '').trim()) throw new BibleError(400, 'empty_markdown', 'the bible markdown is empty');
  let lib = library;
  if (typeof lib === 'string') {
    try { lib = JSON.parse(lib); } catch (e) { throw new BibleError(400, 'bad_library_json', `library JSON does not parse: ${e.message}`); }
  }
  const [product] = await db`SELECT id FROM product_profiles WHERE id = ${pid}`;
  if (!product) throw new BibleError(404, 'product_not_found', `product ${pid} does not exist`);

  const { title, sections } = parseBibleMarkdown(markdown);
  let entities;
  try { entities = buildEntities(lib); } catch (e) { throw new BibleError(400, 'bad_library', e.message); }

  const allById = parseJsonl(quotesJsonl);
  const quotes = selectQuotes(quotesJsonl, marketKey);
  const cited = citedQuoteIds(markdown, entities);
  const have = new Set(quotes.map((q) => q.quote_id));
  // A market's bible may cite a quote tagged for another market: carry that exact quote along.
  for (const id of cited) {
    if (!have.has(id) && allById.has(id)) {
      quotes.push(...selectQuotes(JSON.stringify({ ...allById.get(id), funnel: marketKey }), marketKey));
      have.add(id);
    }
  }
  const problems = validateBible({ sections, entities, quotes, citedIds: cited, allQuoteIds: have });
  if (problems.length) {
    throw new BibleError(422, 'bible_invalid', `the bible did not pass validation (${problems.length} problem(s))`, problems);
  }

  const sha = crypto.createHash('sha256')
    .update(String(markdown)).update(SEP)
    .update(JSON.stringify(lib)).update(SEP)
    .update(quotes.map((q) => `${q.quote_id}:${q.quote}`).join('\n'))
    .digest('hex');
  const typeCounts = entities.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {});
  const counts = {
    sections: sections.filter((s) => s.level === 2).length,
    subsections: sections.filter((s) => s.level === 3).length,
    quotes: quotes.length,
    ...typeCounts,
  };

  return db.begin(async (tx) => {
    const [existing] = await tx`
      SELECT id, source_sha256 FROM product_markets
       WHERE product_id = ${pid} AND market_key = ${marketKey} FOR UPDATE`;
    if (existing && existing.source_sha256 === sha) {
      await tx`UPDATE product_markets SET label = ${label}, price = ${price ?? null}, product_url = ${productUrl ?? null},
                sort_order = ${sortOrder}, updated_at = now() WHERE id = ${existing.id}`;
      return { status: 'unchanged', marketId: existing.id, counts };
    }
    const [m] = await tx`
      INSERT INTO product_markets (product_id, market_key, label, price, product_url, sort_order, bible_title, bible_version,
                                   source_sha256, imported_at, imported_by, stats, updated_at)
      VALUES (${pid}, ${marketKey}, ${label}, ${price ?? null}, ${productUrl ?? null}, ${sortOrder}, ${title || null},
              ${version ?? null}, ${sha}, now(), ${importedBy}, ${tx.json(counts)}, now())
      ON CONFLICT (product_id, market_key) DO UPDATE SET
        label = EXCLUDED.label, price = EXCLUDED.price, product_url = EXCLUDED.product_url, sort_order = EXCLUDED.sort_order,
        bible_title = EXCLUDED.bible_title, bible_version = EXCLUDED.bible_version, source_sha256 = EXCLUDED.source_sha256,
        imported_at = now(), imported_by = EXCLUDED.imported_by, stats = EXCLUDED.stats, updated_at = now()
      RETURNING id`;
    await tx`DELETE FROM product_bible_sections WHERE market_id = ${m.id}`;
    await tx`DELETE FROM product_bible_entities WHERE market_id = ${m.id}`;
    await tx`DELETE FROM product_bible_quotes WHERE market_id = ${m.id}`;
    const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    for (const part of chunk(sections, 150)) {
      await tx`INSERT INTO product_bible_sections ${tx(part.map((s) => ({
        market_id: m.id, ord: s.ord, anchor: s.anchor, level: s.level, title: s.title,
        parent_anchor: s.parent_anchor, markdown: s.markdown, html: s.html, char_count: s.char_count,
      })))}`;
    }
    for (const part of chunk(entities, 150)) {
      await tx`INSERT INTO product_bible_entities ${tx(part.map((e) => ({
        market_id: m.id, type: e.type, key: e.key, title: e.title, tier: e.tier, data: tx.json(e.data),
        avatar_keys: tx.array(e.avatar_keys), angle_keys: tx.array(e.angle_keys), quote_ids: tx.array(e.quote_ids),
        search_text: e.search_text, ord: e.ord,
      })))}`;
    }
    for (const part of chunk(quotes, 250)) {
      await tx`INSERT INTO product_bible_quotes ${tx(part.map((q) => ({
        market_id: m.id, quote_id: q.quote_id, quote: q.quote, source: q.source, url: q.url, speaker: q.speaker,
        avatar: q.avatar, tags: tx.array(q.tags), hook_strength: q.hook_strength, failed_solution: q.failed_solution,
      })))}`;
    }
    return { status: 'imported', marketId: m.id, counts };
  });
}

/** A product reference as briefs, ClickUp and the CRM spell it: numeric id, product code, short name or name. */
export async function resolveProductRef(ref, db = sql) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new BibleError(400, 'bad_product', 'product is required');
  if (/^\d+$/.test(raw)) return Number(raw);
  const rows = await db`
    SELECT id FROM product_profiles
     WHERE lower(product_code) = lower(${raw}) OR lower(short_name) = lower(${raw}) OR lower(name) = lower(${raw})
     ORDER BY (lower(product_code) = lower(${raw})) DESC, id LIMIT 2`;
  if (!rows.length) throw new BibleError(404, 'product_not_found', `no product matches "${raw}"`);
  return rows[0].id;
}

export async function listMarkets(productId, db = sql) {
  return db`
    SELECT id, product_id, market_key, label, price, product_url, sort_order, bible_title, bible_version, imported_at, stats
      FROM product_markets WHERE product_id = ${Number(productId)} ORDER BY sort_order, id`;
}

export async function listProductsWithMarkets(db = sql) {
  return db`
    SELECT p.id, p.name, p.short_name, p.product_code,
           json_agg(json_build_object('market_key', m.market_key, 'label', m.label, 'price', m.price,
             'product_url', m.product_url, 'imported_at', m.imported_at) ORDER BY m.sort_order, m.id) AS markets
      FROM product_profiles p JOIN product_markets m ON m.product_id = p.id
     GROUP BY p.id ORDER BY p.name`;
}

export async function getMarket(productId, marketKey, db = sql) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw new BibleError(400, 'bad_product', 'product id must be a positive integer');
  const [m] = await db`SELECT * FROM product_markets WHERE product_id = ${pid} AND market_key = ${String(marketKey ?? '')}`;
  if (!m) throw new BibleError(404, 'market_not_found', `product ${pid} has no market "${marketKey}"`);
  return m;
}

export async function getBibleDocument(productId, marketKey, db = sql) {
  const m = await getMarket(productId, marketKey, db);
  const rows = await db`
    SELECT ord, anchor, level, title, parent_anchor, html FROM product_bible_sections
     WHERE market_id = ${m.id} ORDER BY ord`;
  const toc = [];
  for (const r of rows) {
    if (r.level === 2) toc.push({ anchor: r.anchor, title: r.title, children: [] });
    else if (r.level === 3) toc.find((t) => t.anchor === r.parent_anchor)?.children.push({ anchor: r.anchor, title: r.title });
  }
  return {
    market: {
      key: m.market_key, label: m.label, price: m.price, product_url: m.product_url, bible_title: m.bible_title,
      bible_version: m.bible_version, imported_at: m.imported_at, stats: m.stats,
    },
    toc,
    sections: rows.filter((r) => r.level === 2).map((r) => ({ anchor: r.anchor, title: r.title, html: r.html })),
  };
}

export async function listEntities(productId, marketKey, { type, avatar, angle, limit = 500 } = {}, db = sql) {
  const m = await getMarket(productId, marketKey, db);
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db`
    SELECT type, key, title, tier, data, avatar_keys, angle_keys, quote_ids FROM product_bible_entities
     WHERE market_id = ${m.id}
       ${type ? db`AND type = ${String(type)}` : db``}
       ${avatar ? db`AND ${String(avatar)} = ANY(avatar_keys)` : db``}
       ${angle ? db`AND ${String(angle)} = ANY(angle_keys)` : db``}
     ORDER BY type, ord, key LIMIT ${lim}`;
}

export async function getQuotes(productId, marketKey, ids, db = sql) {
  const m = await getMarket(productId, marketKey, db);
  const list = [...new Set((ids || []).map(String).filter((x) => /^Q\d{4,5}$/.test(x)))].slice(0, 500);
  if (!list.length) return [];
  return db`
    SELECT quote_id, quote, source, url, speaker, avatar, tags, hook_strength FROM product_bible_quotes
     WHERE market_id = ${m.id} AND quote_id = ANY(${db.array(list)})`;
}
