// PRODUCT BIBLE -> CONTENT PIPELINES. The one place a pipeline (Brief Pipeline, Statics Generation, assistants)
// decides WHETHER a bible applies to a request and WHICH slice of it to use.
//
//   resolvePipelineBible({ bible, productRow, hintText, job, query?, budget? }, db?)
//     bible given        -> validate it and build the pack for `job` (clear 400/404 BibleError when invalid)
//     product has markets -> infer the market from hintText (card name, avatar field, angle, transcript...);
//                            exactly one market matches -> that one ('inferred'); none/ambiguous -> the first
//                            market by sort_order ('auto')
//     no markets          -> null. The caller keeps today's exact behaviour. Never throws for "no markets".
//
// Returns the context pack plus: marketPicked, picked.market, markets[], productId, selection (what to persist).
// Nothing here names a product, market, store or brand (R15).
import { client as sql } from '../../db/pg.js';
import { BibleError, listMarkets, listEntities, listProductsWithMarkets, resolveProductRef, marketOffer } from './bibleStore.js';

export { marketOffer };
import { buildBibleContextPack } from './contextPack.js';
import { loadCuratedMarket, curatedAngleLegacy, AUTO_ANGLE_KEY } from './curatedPack.js';

const STOP = new Set(['with', 'from', 'that', 'this', 'your', 'their', 'into', 'over', 'more', 'less', 'than', 'what',
  'when', 'where', 'which', 'who', 'about', 'after', 'before', 'people', 'market', 'markets', 'product', 'general']);

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (hay, phrase) => phrase.trim().length > 0 && hay.includes(` ${phrase.trim()} `);

/**
 * Infer one market from hint text. `hints` is a string or a list of strings in PRIORITY order (a card name before
 * a transcript): the first hint that names exactly one market decides. A full label / market key match outranks a
 * single distinctive label word; a word shared by two markets' labels never decides.
 * @returns {{ market: object, how: 'inferred'|'auto' }}
 */
export function inferMarket(markets, hints) {
  if (!Array.isArray(markets) || markets.length === 0) return { market: null, how: 'auto' };
  const vocab = markets.map((m) => {
    const phrases = [norm(m.label), norm(String(m.market_key || '').replace(/[-_]+/g, ' '))].map((p) => p.trim()).filter(Boolean);
    const words = new Set(phrases.join(' ').split(' ').filter((w) => w.length >= 4 && !STOP.has(w)));
    return { m, phrases, words };
  });
  for (const v of vocab) {
    v.distinct = [...v.words].filter((w) => vocab.every((o) => o === v || !o.words.has(w)));
  }
  const list = (Array.isArray(hints) ? hints : [hints]).filter((h) => typeof h === 'string' && h.trim());
  for (const hint of list) {
    const hay = norm(hint);
    const byPhrase = vocab.filter((v) => v.phrases.some((p) => has(hay, p)));
    if (byPhrase.length === 1) return { market: byPhrase[0].m, how: 'inferred' };
    if (byPhrase.length > 1) continue; // ambiguous: a later (weaker) hint may still decide
    const byWord = vocab.filter((v) => v.distinct.some((w) => has(hay, w)));
    if (byWord.length === 1) return { market: byWord[0].m, how: 'inferred' };
  }
  return { market: markets[0], how: 'auto' };
}

async function marketsOf(productId, db) {
  try {
    return await listMarkets(productId, db);
  } catch (err) {
    // The bible tables not existing yet means "no markets". Anything else is a real fault: say so loudly, and
    // keep the store generating on today's behaviour rather than failing a generation that worked yesterday.
    if (err?.code !== '42P01') console.error(`[productBible] could not read markets for product ${productId}: ${err.message}`);
    return [];
  }
}

function selectionOf(productId, pack, marketPicked) {
  return {
    product_id: productId,
    market: pack.market.key,
    avatar: pack.avatar.key,
    angle: pack.angle.key,
    picked: { market: marketPicked, avatar: pack.picked.avatar, angle: pack.picked.angle },
  };
}

/**
 * @param {object} args
 * @param {object|null} [args.bible]     { product: id|code, market: key|null, avatar: key|null, angle: key|null }
 * @param {object|null} [args.productRow] the product_profiles row the pipeline already loaded (needs `id`)
 * @param {string|string[]} [args.hintText] text to infer the market from, strongest hint first
 * @param {string} args.job              a contextPack job
 */
export async function resolvePipelineBible({ bible = null, productRow = null, hintText = '', job, query, budget } = {}, db = sql) {
  const explicit = bible && typeof bible === 'object';
  let productId;
  if (explicit) {
    const ref = bible.product ?? bible.productId ?? productRow?.id;
    if (ref === undefined || ref === null || ref === '') throw new BibleError(400, 'bad_product', 'bible.product is required');
    productId = await resolveProductRef(ref, db);
    if (productRow?.id && Number(productRow.id) !== productId) {
      throw new BibleError(400, 'bible_product_mismatch', `bible.product (${productId}) is not the product of this request (${productRow.id})`);
    }
  } else {
    const id = Number(productRow?.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    productId = id;
  }

  const markets = await marketsOf(productId, db);
  if (!explicit && markets.length === 0) return null;

  let marketKey;
  let marketPicked;
  if (explicit && bible.market) {
    marketKey = String(bible.market);
    marketPicked = 'operator';
  } else {
    if (!markets.length) throw new BibleError(404, 'market_not_found', `product ${productId} has no markets`);
    const inferred = inferMarket(markets, hintText);
    marketKey = inferred.market.market_key;
    marketPicked = inferred.how;
  }

  const pack = await buildBibleContextPack({
    productId, market: marketKey, avatar: (explicit && bible.avatar) || undefined, angle: (explicit && bible.angle) || undefined,
    job, query, budget,
  }, db);
  return {
    ...pack,
    picked: { ...pack.picked, market: marketPicked },
    marketPicked,
    markets: markets.map((m) => ({ key: m.market_key, label: m.label })),
    productId,
    selection: selectionOf(productId, pack, marketPicked),
  };
}

/** Rebuild a pack for another job on the SAME selection (same market, avatar and angle; picked flags carried). */
export async function repackBible(resolved, job, { query, budget } = {}, db = sql) {
  const pack = await buildBibleContextPack({
    productId: resolved.productId, market: resolved.market.key, avatar: resolved.avatar.key, angle: resolved.angle.key, job, query, budget,
  }, db);
  return { ...pack, picked: resolved.picked, marketPicked: resolved.marketPicked, markets: resolved.markets, productId: resolved.productId, selection: resolved.selection };
}

const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
  .map((x) => (typeof x === 'string' ? x : (x && (x.text || x.hook || x.name)) || ''))
  .map((s) => String(s).replace(/\s*\[Q\d{4,5}\](?=[\s.,;:!?)]|$)/g, '').trim())
  .filter(Boolean);
const uniq = (a) => [...new Set(a)];

/**
 * A bible angle entity in the shape the statics / brief angle blocks already read
 * (renderAngleDetailsBlock, renderAngleVariantBlock, the copywriter, the QC audit):
 * headline_examples = the angle's headlines + hooks, required_elements = its sub-angles (quote ids stripped),
 * banned_phrases = the angle's own + the market's.
 */
export function bibleAngleToLegacy(entity, { avatarTitle = '', marketBanned = [] } = {}) {
  const d = entity?.data || {};
  const subs = listOf(d.sub_angles);
  return {
    name: entity?.title || d.name || entity?.key || '',
    key: entity?.key || null,
    tier: entity?.tier || null,
    avatar: avatarTitle || '',
    awareness: typeof d.awareness === 'string' ? d.awareness : '',
    funnel_stage: typeof d.funnel_stage === 'string' ? d.funnel_stage : '',
    messenger: typeof d.messenger === 'string' ? d.messenger : '',
    hook_strategy: typeof d.hook_strategy === 'string' ? d.hook_strategy : '',
    lead_with: typeof d.lead_with === 'string' ? d.lead_with : (typeof d.mechanism_framing === 'string' ? d.mechanism_framing : ''),
    tone: typeof d.tone === 'string' ? d.tone : '',
    headline_examples: uniq([...listOf(d.headline_examples), ...listOf(d.hooks)]),
    required_elements: subs.length ? subs : listOf(d.micro_angles),
    banned_phrases: uniq([...listOf(d.banned_phrases), ...listOf(marketBanned)]),
  };
}

/** The legacy-shaped angle definition for one selection. */
export async function bibleAngleDef(productId, marketKey, angleKey, avatarTitle = '', db = sql) {
  const curated = await loadCuratedMarket(productId, marketKey, db);
  if (curated) {
    // Auto: the pack lists every pinned angle and the model picks one, so there is no single angle block.
    if (!angleKey || angleKey === AUTO_ANGLE_KEY) return { ...curatedAngleLegacy({ name: 'AUTO' }), key: AUTO_ANGLE_KEY };
    const a = curated.angles.find((x) => x.id === angleKey);
    if (!a) throw new BibleError(404, 'angle_not_found', `market "${marketKey}" has no angle "${angleKey}"`);
    return curatedAngleLegacy(a);
  }
  const rows = await db`
    SELECT e.type, e.key, e.title, e.tier, e.data
      FROM product_bible_entities e JOIN product_markets m ON m.id = e.market_id
     WHERE m.product_id = ${Number(productId)} AND m.market_key = ${String(marketKey)}
       AND ((e.type = 'angle' AND e.key = ${String(angleKey)}) OR e.type = 'banned_phrase')`;
  const angle = rows.find((r) => r.type === 'angle');
  if (!angle) throw new BibleError(404, 'angle_not_found', `market "${marketKey}" has no angle "${angleKey}"`);
  const banned = rows.filter((r) => r.type === 'banned_phrase').flatMap((r) => listOf(r.data?.items));
  return bibleAngleToLegacy(angle, { avatarTitle, marketBanned: banned });
}

/**
 * Statics need two slices of ONE selection: static_copy (analysis prompt, copywriter) and static_image (image
 * prompt), plus the angle block. Null when the product has no markets and no bible was sent.
 */
export async function resolveStaticsBible({ bible = null, loadPersisted = null, productRow = null, hintText = '', query } = {}, db = sql) {
  const copy = await resolveRecordBible({ bible, loadPersisted, productRow, hintText, job: 'static_copy', query }, db);
  if (!copy) return null;
  const image = await repackBible(copy, 'static_image', {}, db);
  const angleDef = await bibleAngleDef(copy.productId, copy.market.key, copy.angle.key, copy.avatar.title, db);
  const offer = await marketOffer(copy.productId, copy.market.key, db);
  return { copy, image, angleDef, selection: copy.selection, market: copy.market, offer };
}


/** The market's bible avatars + angles as a detection catalog (name = title, the key kept for mapping back). */
export async function bibleCatalog(productId, marketKey, db = sql) {
  const curated = await loadCuratedMarket(productId, marketKey, db);
  if (curated) {
    const cut = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return {
      avatars: [],
      angles: curated.angles.map((a) => ({ key: a.id, name: a.name, tier: null, funnel_stage: a.funnel_stage || '', description: cut(a.hook_strategy || a.lead_with) })),
    };
  }
  const [avatars, angles] = await Promise.all([
    listEntities(productId, marketKey, { type: 'avatar' }, db),
    listEntities(productId, marketKey, { type: 'angle' }, db),
  ]);
  const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return {
    avatars: avatars.map((a) => ({ key: a.key, name: a.title, description: short(a.data?.situation || a.data?.moment || a.data?.identity) })),
    angles: angles.map((a) => ({
      key: a.key, name: a.title, tier: a.tier, funnel_stage: a.data?.funnel_stage || '',
      description: short(a.data?.lead_with || a.data?.mechanism_framing),
    })),
  };
}

/** Map a detected catalog NAME back to its entity key; a name that is not in the catalog is rejected (null). */
export function catalogKey(list, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return (list || []).find((x) => x.name === n)?.key || null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Assistants: inject the `chat` pack when the request carries `bible`, or when the conversation names a product
 * that has markets (name / short name / product code, case-insensitive, whole word). When the market cannot be
 * told from the conversation, a one-line note lists the markets and the first one is used.
 * @returns {null | { pack, note, block }}  block = what to append to the system prompt
 */
export async function resolveChatBible({ text = '', bible = null, query } = {}, db = sql) {
  const convo = String(text || '');
  const q = typeof query === 'string' && query.trim() ? query.slice(0, 20000) : convo.slice(-20000);
  let pack;
  let productName = '';
  if (bible && typeof bible === 'object') {
    pack = await resolvePipelineBible({ bible, hintText: convo, job: 'chat', query: q }, db);
    productName = pack.product?.name || '';
  } else {
    let products;
    try {
      products = await listProductsWithMarkets(db);
    } catch (err) {
      if (err?.code !== '42P01') console.error(`[productBible] could not list products with markets: ${err.message}`);
      return null;
    }
    const hits = [];
    for (const p of products) {
      for (const term of [p.name, p.short_name, p.product_code]) {
        const t = String(term || '').trim();
        if (!t) continue;
        const m = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'i').exec(convo);
        if (m) { hits.push({ p, at: m.index }); break; }
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.at - b.at);
    const { p } = hits[0];
    productName = p.name;
    pack = await resolvePipelineBible({ productRow: { id: p.id }, hintText: convo, job: 'chat', query: q }, db);
    if (!pack) return null;
  }
  const note = pack.marketPicked === 'auto' && pack.markets.length > 1
    ? `Note: ${productName || 'this product'} is sold into ${pack.markets.length} markets (${pack.markets.map((m) => `${m.label} [${m.key}]`).join(', ')}); the conversation does not say which, so this context uses ${pack.market.label} [${pack.market.key}]. Ask the operator if another market is meant.`
    : '';
  return { pack, note, block: `${note ? `${note}\n\n` : ''}${pack.text}` };
}

/** True when the product has at least one market (a missing bible schema counts as none). */
export async function productHasMarkets(productId, db = sql) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return (await marketsOf(id, db)).length > 0;
}

/**
 * For a record that may already carry a selection (a brief being edited, a static being regenerated):
 *   request `bible` > the record's persisted selection > inference from hints > null (no markets).
 * `loadPersisted` is only called when the product has markets, so a store without the bible schema never runs it.
 * A persisted selection that no longer resolves (the bible was re-imported without that angle) falls back to
 * inference, loudly.
 */
export async function resolveRecordBible({ bible = null, loadPersisted = null, productRow = null, hintText = '', job, query, budget } = {}, db = sql) {
  if (bible && typeof bible === 'object') return resolvePipelineBible({ bible, productRow, hintText, job, query, budget }, db);
  if (!productRow?.id || !(await productHasMarkets(productRow.id, db))) return null;
  let sel = null;
  if (typeof loadPersisted === 'function') {
    sel = await loadPersisted();
    if (typeof sel === 'string') { try { sel = JSON.parse(sel); } catch { sel = null; } }
  }
  if (sel && sel.market) {
    try {
      const r = await resolvePipelineBible({
        bible: { product: productRow.id, market: sel.market, avatar: sel.avatar || null, angle: sel.angle || null },
        productRow, job, query, budget,
      }, db);
      const picked = sel.picked && typeof sel.picked === 'object' ? sel.picked : r.picked;
      return { ...r, picked, marketPicked: picked.market || r.marketPicked, selection: { ...r.selection, picked } };
    } catch (err) {
      if (!(err instanceof BibleError)) throw err;
      // The market usually still exists (an angle was renamed, or an approved product pack replaced the research
      // angles): keep the record in its market and let the angle be picked again.
      if (sel.avatar || sel.angle) {
        try {
          const r = await resolvePipelineBible({ bible: { product: productRow.id, market: sel.market, avatar: null, angle: null }, productRow, job, query, budget }, db);
          console.warn(`[productBible] stored selection ${JSON.stringify(sel)} no longer resolves (${err.message}); kept market "${sel.market}", angle auto`);
          return r;
        } catch (err2) {
          if (!(err2 instanceof BibleError)) throw err2;
        }
      }
      console.warn(`[productBible] stored selection ${JSON.stringify(sel)} no longer resolves (${err.message}); inferring again`);
    }
  }
  return resolvePipelineBible({ productRow, hintText, job, query, budget }, db);
}

/**
 * Same market, a new avatar and/or angle (e.g. the ones detection picked from the bible catalog). Keys not given
 * keep the current choice when the operator made it, and are re-picked by the pack otherwise.
 */
export async function reselectBible(resolved, { avatar = null, angle = null } = {}, how = 'detected', job = resolved.job, db = sql) {
  const keepAvatar = !avatar && resolved.picked.avatar !== 'auto' ? resolved.avatar.key : undefined;
  const keepAngle = !angle && resolved.picked.angle !== 'auto' ? resolved.angle.key : undefined;
  const pack = await buildBibleContextPack({
    productId: resolved.productId, market: resolved.market.key, avatar: avatar || keepAvatar, angle: angle || keepAngle, job,
  }, db);
  const picked = {
    market: resolved.picked.market,
    avatar: avatar ? how : keepAvatar ? resolved.picked.avatar : pack.picked.avatar,
    angle: angle ? how : keepAngle ? resolved.picked.angle : pack.picked.angle,
  };
  return {
    ...pack, picked, marketPicked: resolved.marketPicked, markets: resolved.markets, productId: resolved.productId,
    selection: { ...selectionOf(resolved.productId, pack, resolved.marketPicked), picked },
  };
}

/** Catalog avatars as the brief prompts list them. */
export function catalogAvatarsList(catalog) {
  return (catalog?.avatars || []).map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');
}

/** ANGLES_LIST / ANGLE_NAME / ANGLE_DETAILS for the clone prompt, from the bible (same line format as the legacy block). */
export function bibleCloneAngleParts(angleDef, catalog) {
  const anglesList = (catalog?.angles || []).length
    ? catalog.angles.map((a) => `- ${a.name} [${String(a.funnel_stage || 'middle').toUpperCase()}]${a.tier ? ` tier ${a.tier}` : ''}`).join('\n')
    : '(no angles in this market\'s bible)';
  const d = angleDef || {};
  const lines = [];
  if (d.avatar) lines.push(`avatar: ${d.avatar}`);
  if (d.awareness) lines.push(`awareness: ${d.awareness}`);
  if (d.funnel_stage) lines.push(`funnel_stage: ${d.funnel_stage}`);
  if (d.hook_strategy) lines.push(`hook_strategy: ${d.hook_strategy}`);
  if (d.lead_with) lines.push(`lead_with: ${d.lead_with}`);
  if (d.tone) lines.push(`tone: ${d.tone}`);
  if (d.required_elements?.length) lines.push(`sub_angles:\n- ${d.required_elements.join('\n- ')}`);
  if (d.headline_examples?.length) lines.push(`headline_examples:\n- ${d.headline_examples.join('\n- ')}`);
  if (d.banned_phrases?.length) lines.push(`banned_phrases (HARD ban):\n- ${d.banned_phrases.join('\n- ')}`);
  return { anglesList, angleName: d.name || 'AUTO', angleDetails: lines.join('\n') || '(no detail in the bible for this angle)' };
}
