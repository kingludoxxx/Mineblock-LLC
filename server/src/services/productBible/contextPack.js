// PRODUCT BIBLE — the context pack. THE ONE function every consumer calls (briefs, statics, funnel builder,
// assistants). It returns a SLICE of one market's bible sized for the job: never the whole book, and never
// anything from another market of the same product.
//
//   buildBibleContextPack({ productId, market, avatar?, angle?, job, query? }, db?)
//     -> { product, market, avatar, angle, picked, job, budget, chars, truncated, text, parts }
//
// When avatar/angle are not given the pack picks them (test queue first, then tier A) and SAYS so in
// `picked`, so a caller can show "auto-selected" instead of pretending the operator chose.
import { client as sql } from '../../db/pg.js';
import { BibleError, getMarket } from './bibleStore.js';

export const JOB_BUDGETS = {
  brief: 26000,
  static_copy: 9000,
  static_image: 2800,
  funnel_page: 42000,
  chat: 30000,
  summary: 6000,
};

const LIMITS = {
  brief:        { quotes: 24, beliefs: 8, objections: 10, hooks: 12, competitors: 6, winners: 5, subAngles: 8 },
  static_copy:  { quotes: 10, beliefs: 3, objections: 4, hooks: 10, competitors: 3, winners: 2, subAngles: 6 },
  static_image: { quotes: 3, beliefs: 0, objections: 0, hooks: 3, competitors: 0, winners: 0, subAngles: 4 },
  funnel_page:  { quotes: 30, beliefs: 12, objections: 16, hooks: 15, competitors: 8, winners: 6, subAngles: 8 },
  chat:         { quotes: 20, beliefs: 10, objections: 12, hooks: 12, competitors: 8, winners: 5, subAngles: 8 },
  summary:      { quotes: 5, beliefs: 3, objections: 3, hooks: 5, competitors: 3, winners: 0, subAngles: 4 },
};

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function renderValue(v, depth = 0) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => {
      const r = renderValue(x, depth + 1);
      return r ? `${'  '.repeat(depth)}- ${r.replace(/\n/g, `\n${'  '.repeat(depth + 1)}`)}` : '';
    }).filter(Boolean).join('\n');
  }
  if (typeof v === 'object') {
    if (typeof v.text === 'string' && Object.keys(v).length <= 3) {
      const q = v.quote ? ` ("${v.quote}")` : '';
      const ids = asArray(v.quote_ids).length ? ` [${asArray(v.quote_ids).join(', ')}]` : '';
      return `${v.text}${q}${ids}`;
    }
    return Object.entries(v).map(([k, x]) => {
      const r = renderValue(x, depth + 1);
      return r ? `${k.replace(/_/g, ' ')}: ${r.includes('\n') ? `\n${r}` : r}` : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function tokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z][a-z']{3,}/g) || []);
}
function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/**
 * @param {object} args
 * @param {number} args.productId
 * @param {string} args.market      market key
 * @param {string} [args.avatar]    avatar key
 * @param {string} [args.angle]     angle key
 * @param {string} args.job         one of JOB_BUDGETS
 * @param {string} [args.query]     free text (chat / funnel prompt) used to rank beliefs, objections, quotes
 * @param {number} [args.budget]    override the job's character budget (bounded 1000..60000)
 */
export async function buildBibleContextPack({ productId, market, avatar, angle, job, query, budget } = {}, db = sql) {
  if (!JOB_BUDGETS[job]) {
    throw new BibleError(400, 'bad_job', `job must be one of: ${Object.keys(JOB_BUDGETS).join(', ')}`);
  }
  const m = await getMarket(productId, market, db);
  const [product] = await db`SELECT id, name, short_name, product_code FROM product_profiles WHERE id = ${m.product_id}`;
  const limits = LIMITS[job];
  const cap = Math.min(60000, Math.max(1000, Number(budget) || JOB_BUDGETS[job]));

  const ents = await db`
    SELECT type, key, title, tier, data, avatar_keys, angle_keys, quote_ids, search_text, ord
      FROM product_bible_entities WHERE market_id = ${m.id} ORDER BY type, ord`;
  const byType = (t) => ents.filter((e) => e.type === t);
  const one = (t) => byType(t)[0] || null;
  const avatars = byType('avatar');
  const angles = byType('angle');
  if (!avatars.length || !angles.length) {
    throw new BibleError(409, 'bible_incomplete', `market "${market}" has no ${!avatars.length ? 'avatars' : 'angles'} imported`);
  }

  const picked = { avatar: 'operator', angle: 'operator' };
  let av = avatar ? avatars.find((a) => a.key === avatar) : null;
  if (avatar && !av) throw new BibleError(404, 'avatar_not_found', `market "${market}" has no avatar "${avatar}"`);
  let an = angle ? angles.find((a) => a.key === angle) : null;
  if (angle && !an) throw new BibleError(404, 'angle_not_found', `market "${market}" has no angle "${angle}"`);

  const tierRank = (t) => ({ A: 0, B: 1, C: 2 }[String(t || '').toUpperCase()] ?? 3);
  const queue = byType('test_queue').slice().sort((a, b) => (Number(a.data.rank) || 99) - (Number(b.data.rank) || 99));

  if (!an) {
    picked.angle = 'auto';
    const q = query ? tokens(query) : null;
    let pool = angles;
    if (av) {
      const best = asArray(av.data.best_angle_ids);
      const linked = angles.filter((a) => best.includes(a.key) || a.avatar_keys.includes(av.key));
      if (linked.length) pool = linked;
      pool = pool.slice().sort((a, b) => {
        const ia = best.indexOf(a.key); const ib = best.indexOf(b.key);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || tierRank(a.tier) - tierRank(b.tier);
      });
    } else if (q && q.size) {
      pool = angles.slice().sort((a, b) => overlap(q, tokens(b.search_text)) - overlap(q, tokens(a.search_text)) || tierRank(a.tier) - tierRank(b.tier));
    } else {
      const queued = queue.map((t) => angles.find((a) => a.key === t.data.angle_id)).filter(Boolean);
      pool = queued.length ? queued : angles.slice().sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    }
    an = pool[0];
  }
  if (!av) {
    picked.avatar = 'auto';
    const q = query ? tokens(query) : null;
    const fromAngle = avatars.filter((a) => an.avatar_keys.includes(a.key));
    let pool = fromAngle.length ? fromAngle : avatars;
    if (q && q.size && !fromAngle.length) {
      pool = pool.slice().sort((a, b) => overlap(q, tokens(b.search_text)) - overlap(q, tokens(a.search_text)));
    }
    if (fromAngle.length) {
      // The angle names its avatars in priority order: the first one it lists is the one it was written for.
      const order = an.avatar_keys;
      av = pool.slice().sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))[0];
    } else {
      av = pool.find((a) => String(a.data.type || '').toLowerCase() === 'lead') || pool[0];
    }
  }

  const focus = tokens(`${av.search_text} ${an.search_text} ${query || ''}`);
  const rank = (list, n) => list
    .map((e) => ({ e, s: overlap(focus, tokens(e.search_text)) + (e.avatar_keys.includes(av.key) ? 5 : 0) + (e.angle_keys.includes(an.key) ? 5 : 0) }))
    .sort((a, b) => b.s - a.s || a.e.ord - b.e.ord)
    .slice(0, n).map((x) => x.e);

  const beliefs = limits.beliefs ? rank(byType('belief'), limits.beliefs) : [];
  const objections = limits.objections ? rank(byType('objection'), limits.objections) : [];
  const hooksForAngle = byType('hook').filter((h) => h.angle_keys.includes(an.key));
  const hooksForAvatar = byType('hook').filter((h) => !h.angle_keys.includes(an.key) && h.avatar_keys.includes(av.key));
  const hooks = [...hooksForAngle, ...hooksForAvatar].slice(0, limits.hooks);
  const competitors = limits.competitors ? byType('competitor').slice(0, limits.competitors) : [];
  const winners = limits.winners ? rank(byType('proven_winner'), limits.winners) : [];

  // Quotes: the avatar's own voice first (strongest hooks), then quotes the avatar/angle cite, then query matches.
  const citeIds = [...new Set([...av.quote_ids, ...an.quote_ids])];
  const quoteRows = await db`
    SELECT quote_id, quote, source, url, speaker, avatar, tags, hook_strength FROM product_bible_quotes
     WHERE market_id = ${m.id} AND (avatar = ${av.key} OR quote_id = ANY(${db.array(citeIds.length ? citeIds : ['__none__'])}))
     ORDER BY (avatar = ${av.key}) DESC, hook_strength DESC NULLS LAST, quote_id
     LIMIT ${Math.max(limits.quotes * 3, 12)}`;
  let quotes = quoteRows;
  if (quotes.length < limits.quotes) {
    // The avatar has little or no voice of its own: top up with this market's quotes closest to the avatar + angle.
    const seen = new Set(quotes.map((q) => q.quote_id));
    const pool = await db`
      SELECT quote_id, quote, source, url, speaker, avatar, tags, hook_strength FROM product_bible_quotes
       WHERE market_id = ${m.id} ORDER BY hook_strength DESC NULLS LAST, quote_id LIMIT 1500`;
    const extra = pool
      .filter((q) => !seen.has(q.quote_id))
      .map((q) => ({ q, s: overlap(focus, tokens(q.quote)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.q.hook_strength || 0) - (a.q.hook_strength || 0))
      .slice(0, limits.quotes * 2 - quotes.length)
      .map((x) => x.q);
    quotes = [...quotes, ...extra];
  }
  if (query && tokens(query).size) {
    const qt = tokens(query);
    quotes = quoteRows.slice().sort((a, b) => overlap(qt, tokens(b.quote)) - overlap(qt, tokens(a.quote)) || (b.hook_strength || 0) - (a.hook_strength || 0));
  }
  quotes = quotes.slice(0, limits.quotes);

  const mech = one('mechanism');
  const launch = one('launch_map');
  const desire = one('desire');
  const banned = one('banned_phrase');
  const tired = one('tired_word');
  const marketFact = one('market_fact');

  // Assemble in PRIORITY order; lower blocks are dropped first when the budget runs out.
  const header = [
    `PRODUCT BIBLE CONTEXT (read-only research, authoritative for this product and market)`,
    `Product: ${product?.name || ''}${product?.product_code ? ` (${product.product_code})` : ''}`,
    `Market: ${m.label}${m.price ? ` · price ${m.price}` : ''}${m.product_url ? ` · ${m.product_url}` : ''}`,
    `Bible: ${m.bible_title || ''}${m.bible_version ? ` · ${m.bible_version}` : ''}`,
    `Avatar: ${av.title} [${av.key}]${picked.avatar === 'auto' ? ' (auto-selected)' : ''}`,
    `Angle: ${an.title} [${an.key}]${an.tier ? ` · tier ${an.tier}` : ''}${picked.angle === 'auto' ? ' (auto-selected)' : ''}`,
    `Rule: write only from this market's bible. Use the customers' verbatim language. Do not borrow from any other market.`,
  ].join('\n');

  const COMPACT_AVATAR = {
    static_image: ['name', 'situation', 'moment', 'identity', 'dream_outcome', 'pains', 'first_sentence'],
    static_copy: ['name', 'situation', 'awareness', 'moment', 'desires', 'from_to', 'dream_outcome', 'fears', 'pains', 'objections', 'identity', 'first_sentences', 'first_sentence', 'proof_needed'],
    summary: ['name', 'situation', 'awareness', 'moment', 'from_to', 'dream_outcome', 'pains', 'first_sentence'],
  };
  const avatarData = { ...av.data };
  if (COMPACT_AVATAR[job]) {
    for (const k of Object.keys(avatarData)) if (!COMPACT_AVATAR[job].includes(k)) delete avatarData[k];
  }
  delete avatarData.verbatim; // quotes arrive through the ranked quotes block, not twice
  const angleData = { ...an.data };
  if (Array.isArray(angleData.sub_angles)) angleData.sub_angles = angleData.sub_angles.slice(0, limits.subAngles);
  if (Array.isArray(angleData.micro_angles)) angleData.micro_angles = angleData.micro_angles.slice(0, limits.subAngles);
  if (job === 'static_image') {
    for (const k of Object.keys(angleData)) {
      if (!['name', 'mechanism_framing', 'format', 'tone', 'sub_angles', 'lead_with'].includes(k)) delete angleData[k];
    }
  }

  const blocks = [
    ['avatar', `=== AVATAR CARD: ${av.title} ===\n${renderValue(avatarData)}`],
    ['angle', `=== ANGLE: ${an.title} ===\n${renderValue(angleData)}`],
    ['quotes', quotes.length ? `=== VERBATIM CUSTOMER LANGUAGE (use as written) ===\n${quotes.map((q) => `- "${q.quote}" [${q.quote_id}${q.source ? `, ${q.source}` : ''}]`).join('\n')}` : ''],
    ['mechanism', mech ? `=== MECHANISM ===\n${renderValue(mech.data)}` : ''],
    ['hooks', hooks.length ? `=== HOOKS FOR THIS ANGLE / AVATAR ===\n${hooks.map((h) => `- ${h.data.hook || h.title}`).join('\n')}` : ''],
    ['objections', objections.length ? `=== OBJECTIONS AND ANSWERS ===\n${objections.map((o) => `- ${o.data.objection || o.title}\n  answer: ${str(o.data.answer)}`).join('\n')}` : ''],
    ['beliefs', beliefs.length ? `=== BELIEFS (and the move) ===\n${beliefs.map((b) => `- ${b.data.belief || b.title} · ${str(b.data.family)} · move: ${str(b.data.move)}${b.data.copy_line ? `\n  copy line: ${str(b.data.copy_line)}` : ''}`).join('\n')}` : ''],
    ['offer', launch ? `=== OFFER AND LAUNCH MAP ===\n${renderValue(launch.data)}` : ''],
    ['language_rules', (banned || tired) ? `=== LANGUAGE RULES ===\n${banned ? `Banned phrases: ${asArray(banned.data.items).join(' | ')}\n` : ''}${tired ? `Tired words (avoid leading with): ${asArray(tired.data.items).join(' | ')}` : ''}` : ''],
    ['desires', desire && job !== 'static_image' ? `=== MARKET DESIRES ===\n${renderValue(desire.data)}` : ''],
    ['competitors', competitors.length ? `=== COMPETITORS ===\n${competitors.map((c) => `- ${c.title}: ${renderValue({ price: c.data.price, guarantee: c.data.guarantee, positioning: c.data.positioning, weaknesses: c.data.weaknesses })}`).join('\n')}` : ''],
    ['proven_winners', winners.length ? `=== PROVEN WINNERS (long-running competitor ads) ===\n${winners.map((w) => `- ${renderValue(w.data)}`).join('\n')}` : ''],
    ['market', marketFact && (job === 'funnel_page' || job === 'chat') ? `=== MARKET ===\n${renderValue(marketFact.data)}` : ''],
  ].filter(([, t]) => t);

  // Each block gets a SHARE of the budget, so a long avatar card can never crowd out the angle, the customers'
  // language or the objections. Unused share flows to later blocks. Trims cut at a line boundary.
  const SHARES = job === 'static_image'
    ? { avatar: 0.42, angle: 0.33, quotes: 0.15, hooks: 0.05, mechanism: 0.05 }
    : { avatar: 0.26, angle: 0.2, quotes: 0.16, mechanism: 0.05, hooks: 0.06, objections: 0.08, beliefs: 0.06, offer: 0.04,
        language_rules: 0.03, desires: 0.03, competitors: 0.04, proven_winners: 0.03, market: 0.04 };
  const trimTo = (block, limit) => {
    if (block.length <= limit) return { out: block, cut: false };
    const slice = block.slice(0, Math.max(0, limit - 16));
    const at = slice.lastIndexOf('\n');
    return { out: `${at > limit * 0.5 ? slice.slice(0, at) : slice}\n[...trimmed]`, cut: true };
  };
  let text = header;
  const included = [];
  let truncated = false;
  let carry = 0;
  const body = Math.max(0, cap - header.length);
  for (const [name, block] of blocks) {
    const share = Math.floor(body * (SHARES[name] ?? 0.03)) + carry;
    const remaining = cap - text.length - 2;
    if (remaining <= 120) { truncated = true; break; }
    const { out, cut } = trimTo(block, Math.min(share, remaining));
    if (out.trim() === '[...trimmed]' || out.length < 60) { truncated = true; carry = share; continue; }
    text += `\n\n${out}`;
    included.push(cut ? `${name}(trimmed)` : name);
    if (cut) truncated = true;
    carry = Math.max(0, share - out.length);
  }

  return {
    product: product ? { id: product.id, name: product.name, code: product.product_code } : null,
    market: { key: m.market_key, label: m.label, price: m.price, product_url: m.product_url },
    avatar: { key: av.key, title: av.title },
    angle: { key: an.key, title: an.title, tier: an.tier },
    picked,
    job,
    budget: cap,
    chars: text.length,
    truncated,
    included,
    quote_ids: quotes.map((q) => q.quote_id),
    text,
  };
}
