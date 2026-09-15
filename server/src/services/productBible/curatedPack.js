// PRODUCT PACK — the operator-approved slice of a market that the content tools read INSTEAD of the bible.
//
// Found live 2026-09-15: a whole bible (~770 KB, 30+ angles, 25 avatars) cut to a 9,000-character excerpt produced
// repetitive, off-angle static copy, and the picker offered every research angle. The bible stays the research
// document; the tools get what the operator approved:
//   product_profiles.market_packs[market].core   the product core (what it is, looks like, mechanism, offer, rules)
//   product_profiles.angles[] with market = key  the pinned angles (full briefs, each with its customer_voice)
// A market has a pack only when BOTH exist. Without one, everything reads the bible exactly as before.
// Nothing here names a product, market, store or brand (R15).
import { client as sql } from '../../db/pg.js';
import { BibleError } from './bibleStore.js';

export const AUTO_ANGLE_KEY = '__auto__';

const parse = (v, fallback) => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v ?? fallback;
};
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/** Pure: the pack for one market from a product row, or null when the market has no approved core + angles. */
export function curatedFromRow(row, marketKey) {
  if (!row || !marketKey) return null;
  const packs = parse(row.market_packs, {});
  const core = packs && typeof packs === 'object' ? packs[marketKey]?.core : null;
  const angles = parse(row.angles, []);
  const pinned = (Array.isArray(angles) ? angles : []).filter((a) => a && a.id && a.name && a.market === marketKey);
  if (typeof core !== 'string' || !core.trim() || pinned.length === 0) return null;
  // Optional structural ban list next to the core (literal phrases); the core's own WHAT WE NEVER SAY block is parsed too.
  return { core: core.trim(), angles: pinned, banned_phrases: list(packs[marketKey]?.banned_phrases) };
}

/** The pack for one market, or null. A product table without the column reads as "no pack". */
export async function loadCuratedMarket(productId, marketKey, db = sql) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0 || !marketKey) return null;
  const [r] = await db`SELECT to_jsonb(p) AS row FROM product_profiles p WHERE p.id = ${id}`;
  return curatedFromRow(r?.row, String(marketKey));
}

/** A pinned angle in the bible-entity shape the picker and the statics chips render (no tier: no tier headers). */
export function curatedAngleEntity(a) {
  return {
    type: 'angle', key: a.id, title: a.name, tier: null,
    data: { ...a, lead_with: a.lead_with || '', avatar_ids: [] },
    avatar_keys: [], angle_keys: [], quote_ids: [],
  };
}

/** A pinned angle in the legacy shape the statics / brief angle blocks read. */
export function curatedAngleLegacy(a) {
  return {
    name: a.name, key: a.id, tier: null,
    avatar: a.avatar || '', awareness: a.awareness || '', funnel_stage: a.funnel_stage || '', messenger: a.messenger || '',
    hook_strategy: a.hook_strategy || '', lead_with: a.lead_with || '', tone: a.tone || '',
    copy_directives: a.copy_directives || '',
    headline_examples: list(a.headline_examples), required_elements: list(a.required_elements), banned_phrases: list(a.banned_phrases),
  };
}

function angleBrief(a, { full = true, required = full } = {}) {
  const lines = [`=== ANGLE: ${a.name} ===`];
  if (a.funnel_stage) lines.push(`funnel stage: ${a.funnel_stage}`);
  if (a.messenger) lines.push(`messenger: ${a.messenger}`);
  if (a.avatar) lines.push(`avatar: ${a.avatar}`);
  if (full && a.awareness) lines.push(`awareness: ${a.awareness}`);
  if (a.hook_strategy) lines.push(`hook strategy: ${a.hook_strategy}`);
  if (a.lead_with) lines.push(`lead with: ${a.lead_with}`);
  if (full && a.tone) lines.push(`tone: ${a.tone}`);
  if (full && a.copy_directives) lines.push(`copy directives:\n${a.copy_directives}`);
  const req = list(a.required_elements);
  if (required && req.length) lines.push(`required elements:\n- ${req.join('\n- ')}`);
  const heads = list(a.headline_examples);
  if (heads.length) lines.push(`headline examples:\n- ${(full ? heads : heads.slice(0, 3)).join('\n- ')}`);
  const voice = list(a.customer_voice);
  if (voice.length) lines.push(`customer voice (real people's words: language inspiration only, never quote them as a customer review):\n- "${(full ? voice : voice.slice(0, 2)).join('"\n- "')}"`);
  const banned = list(a.banned_phrases);
  if (full && banned.length) lines.push(`banned phrases (HARD ban):\n- ${banned.join('\n- ')}`);
  return lines.join('\n');
}

/**
 * Pure: the pack text and selection for one job. `angleKey` null or AUTO_ANGLE_KEY = auto: every pinned angle is
 * listed and the model must pick exactly one for the source it is adapting.
 */
export function buildCuratedPack({ product, market, curated, angleKey = null, job }) {
  const angles = curated.angles;
  let chosen = null;
  if (angleKey && angleKey !== AUTO_ANGLE_KEY) {
    chosen = angles.find((a) => a.id === angleKey) || null;
    if (!chosen) throw new BibleError(404, 'angle_not_found', `market "${market.key}" has no angle "${angleKey}"`);
  }
  const header = [
    'PRODUCT PACK (approved by the operator: the only product knowledge to write from)',
    `Product: ${product?.name || ''}${product?.code ? ` (${product.code})` : ''}`,
    `Market: ${market.label}${market.price ? ` · price ${market.price}` : ''}${market.product_url ? ` · ${market.product_url}` : ''}`,
    chosen ? `Angle: ${chosen.name}` : `Angle: AUTO, choose one of the ${angles.length} angles below`,
    'Rule: write only from this pack. Use no product fact, claim, number or angle that is not in it.',
  ].join('\n');

  let body;
  if (job === 'static_image') {
    const a = chosen;
    body = a ? `=== ANGLE: ${a.name} ===\n${[a.avatar && `avatar: ${a.avatar}`, a.tone && `tone: ${a.tone}`].filter(Boolean).join('\n')}` : '';
  } else if (chosen) {
    body = angleBrief(chosen, { full: true });
  } else {
    body = [
      `=== CHOOSE THE ANGLE ===\nThese are the ONLY angles. Read the source (the reference ad, script or request) and pick the ONE angle it fits best. Write only from that angle's brief, and return its exact name as "chosen_angle" (plus one sentence "chosen_angle_reason") when you answer in JSON.`,
      // Statics auto keeps the briefs compact but lists each angle's required elements: the bullets are built from them.
      ...angles.map((a) => angleBrief(a, { full: job !== 'static_copy' && job !== 'summary', required: job !== 'summary' })),
    ].join('\n\n');
  }
  const text = `${header}\n\n=== PRODUCT CORE ===\n${curated.core}${body ? `\n\n${body}` : ''}`;
  const angle = chosen ? { key: chosen.id, title: chosen.name, tier: null } : { key: AUTO_ANGLE_KEY, title: 'Auto (best of our angles)', tier: null };
  const avatar = chosen
    ? { key: `${chosen.id}:avatar`, title: String(chosen.avatar || chosen.name).split(/(?<=\.)\s/)[0].slice(0, 160) }
    : { key: `${AUTO_ANGLE_KEY}:avatar`, title: 'From the chosen angle' };
  return {
    product: product ? { id: product.id, name: product.name, code: product.code } : null,
    market,
    avatar,
    angle,
    picked: { avatar: 'auto', angle: chosen ? 'operator' : 'auto' },
    job,
    budget: text.length,
    chars: text.length,
    truncated: false,
    included: ['product_core', chosen ? 'angle' : 'angles'],
    quote_ids: [],
    curated: true,
    text,
  };
}
