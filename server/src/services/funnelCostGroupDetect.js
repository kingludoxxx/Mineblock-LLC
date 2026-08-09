// COST-GROUP PROPOSALS — which variants are probably the same good.
//
// Port of funnel-os lb_cost_group_service.cluster() / detect() (:491-839) and
// lb_quote_verify.parse_pack_size (:1216-1298), onto this repo's cost catalog.
//
// ══════════════════════════════════════════════════════════════════════════
// THE MATCHING RULE IS EXACT STRING EQUALITY. THAT IS THE DESIGN.
// ══════════════════════════════════════════════════════════════════════════
// There is no edit distance, no token overlap, no prefix match, no substring
// match, no handle match, no price match, no tag match. Two titles group only
// when their STEMS — the titles with channel suffixes stripped — are byte
// equal after casefolding.
//
// This is not conservatism for its own sake. Every looser rule is a live
// money bug, and the reference names the estate that proves it:
//
//   · "Acme Power Bank" vs "Acme Power Kit" share the prefix "Acme Power".
//     One is a cheap accessory, the other a high-ticket generator. A prefix
//     rule prices one at dozens of times the other.
//   · "Widget Pro" ↔ "Power Kit" is edit distance 2. Any fuzzy matcher merges
//     a low-cost consumable with that same high-ticket generator.
//
// A cost group applies ONE rate to every member, so a wrong grouping does not
// produce a slightly-off number — it produces a confidently wrong margin on
// real revenue. The rule stays exact.
//
// ── THE STAGES ────────────────────────────────────────────────────────────
//   STAGE 0  Exclude services and digital goods entirely.
//   STAGE A  Partition by shopify_product_id. Every variant of one Shopify
//            product IS the same good, by construction — a FACT, not a guess.
//   STAGE B  A product's stem set is stem() over every product_title ever
//            observed on its variants, plus its mirror title. Two products
//            LINK iff their stem sets intersect on an EXACT string.
//   STAGE C  Four cross-checks. Each failure downgrades the proposal to
//            'review'; none of them ever silently drops a member.
//
// ── WHAT THIS FILE CANNOT DO IN THIS REPO (honest gaps) ───────────────────
// Two reference inputs do not exist in our catalog, and both degrade SAFELY —
// toward less linking and lower confidence, never toward a merge:
//
//   1. lb_variant_costs.shopify_product_id is declared but the SOLD sweep
//      never writes it (funnelCosts.runDetectSweep sets observed order facts
//      only). Stage A is therefore recovered from the co_funnel_products
//      mirror when that table exists; a variant the mirror does not cover
//      falls back to the synthetic core key `vid:<variant_id>` and links only
//      through Stage B. Fewer facts, so more work for exact stem equality —
//      which is the conservative direction.
//   2. product_type is in no table we own, so CHECK C3 (goods type) has no
//      real input and always passes. It is implemented in full and reads the
//      mirror's product_type the moment that field is synced. It is NOT
//      silently dropped, because a check that vanishes is a check nobody
//      re-adds.
//
// NOTHING HERE WRITES A COST. A proposal is a suggestion; accepting one
// creates a group and binds members, and the group still has no rate until
// the operator enters one through funnelCosts.appendRate.
//
// WINDOWING: the detector reads lb_variant_costs, which IS the windowed
// projection of the order tables (runDetectSweep windows on paid_at). No
// order table is scanned here — unbounded or otherwise.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureFunnelCostsTables } from './funnelCostsSchema.js';
import { CostError, round2 } from './funnelCosts.js';
import { createGroup, MAX_MEMBERS } from './funnelCostGroups.js';

const PROPOSAL_RE = /^cgp_[0-9a-f]{8,32}$/;
export const PROPOSAL_STATUSES = ['open', 'accepted', 'dismissed'];
export const CONFIDENCE = ['certain', 'high', 'review'];

// ── Thresholds (reference :196-210 — the numbers are the contract) ─────────
// Two members at the same pack size whose per-unit prices differ by more than
// this are not plausibly the same good at the same tier.
const SAME_TIER_MAX_RATIO = 3.0;
// How far a bigger pack may sit ABOVE a smaller one, per unit, before it
// reads as a contradiction rather than a pricing decision.
//
// A hair-trigger here is NOT "safer". With an epsilon tolerance, "1 Test Kit"
// at $15.00/unit and "3 Testers" at $15.0017/unit — a 0.02% difference — fail
// the check and every honest ladder lands in 'review', which trains the
// operator to click through the tier that exists to be read. The live
// over-merge this must catch is $12.00/unit against $8.00/unit: a 50%
// inversion, not a rounding crumb.
const LADDER_TOLERANCE = 1.15;
// A stem linking this many products is likelier a naming accident than one
// good. It does not block the proposal — it blocks the one-click, which is
// the affordance that would do the damage.
const MAX_CLUSTER_PRODUCTS = 12;
const MAX_CLUSTER_MEMBERS = 60;

const MAX_TITLE = 200;
const MAX_REASON = 280;

// ── Text normalization (reference sanitize_text :327-340, stem :213-235) ───
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const WS_RE = /\s+/g;

export function sanitizeText(value, maxLen = MAX_TITLE) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(CONTROL_RE, ' ').replace(WS_RE, ' ').trim();
  // The ellipsis counts against the cap — max_len is a hard character bound.
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1).trimEnd()}…`;
  return s;
}

// A cloned funnel page appends a channel tag to the product title; two rows
// that differ only by "- Downsell (en-dws2)" are the same good. Stripping is
// the ONLY normalization allowed to change a title, and it strips SUFFIXES
// only — never a prefix, never an interior token.
const CLONE_TAG = '\\([a-z]{2,3}-dwn?s\\d{1,3}\\)';
const SUFFIX_RES = [
  new RegExp(`\\s*[-–—]\\s*downsell\\s*${CLONE_TAG}\\s*$`),
  /\s*[-–—]\s*downsell\s*$/,
  /\s*[-–—]\s*upsell\s*$/,
  /\s+upsell\s+legacycheckout\s*$/,
  new RegExp(`\\s*${CLONE_TAG}\\s*$`),
];
const STEM_PASSES = 6;

export function stem(title) {
  const base = sanitizeText(title, MAX_TITLE).toLowerCase();
  let s = base;
  for (let i = 0; i < STEM_PASSES; i += 1) {
    const before = s;
    for (const rx of SUFFIX_RES) s = s.replace(rx, '');
    s = s.trim();
    if (s === before) break;
  }
  s = s.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '');
  // Stripping everything means the title WAS only a channel tag; fall back to
  // the raw casefolded title rather than returning a blank that would link to
  // every other blank.
  return s || base;
}

// ── Pack size (reference parse_pack_size :1216-1298) ───────────────────────
// SIX RULES, FIRST MATCH WINS, AND THE ORDER IS THE CONTRACT.
//
// Two prohibitions the reference states outright and this port keeps:
//   · NEVER infer pack size from PRICE. Price is a contradiction check (C2),
//     never a match signal — "cheaper per unit" is a pricing decision, not
//     evidence about how many units are in the box.
//   · NEVER infer pack size from the PRODUCT title. It is read off the
//     VARIANT title only; a product called "3 Bottle System" whose variants
//     are "1 Pack"/"3 Pack" would otherwise multiply every member by 3.
const BOGO_RE = /buy\s*(\d{1,3})\s*\D{0,8}?\s*get\s*(\d{1,3})\s*free\s*\(\s*(\d{1,3})\s*[\w\s]*\)/i;
const DIGITAL_RE = /digital\s+download/i;
const SERVICE_TITLE_RE = /^(default title|this order)$/i;
const SERVICE_PRODUCT_RE = /expedited shipping|porch pirate protection/i;
const LEADING_INT_RE = /^(\d{1,3})\s+\S/;
const WORD_NUMBERS = {
  single: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const WORD_RE = new RegExp(`^(${Object.keys(WORD_NUMBERS).join('|')})\\s`, 'i');

/**
 * → {size:int|null, rule, confidence, is_digital, is_service, note}
 * confidence 'none' means the size is UNKNOWN — which blocks the one-click
 * rather than defaulting to 1. A silent default of 1 on a "3 Pack" is a 3x
 * COGS understatement on every unit it sells.
 */
export function parsePackSize({ variantTitle = '', productTitle = '' } = {}) {
  const vt = sanitizeText(variantTitle, MAX_TITLE);
  const pt = sanitizeText(productTitle, MAX_TITLE);
  const none = { size: null, rule: 'ambiguous', confidence: 'none', is_digital: false, is_service: false, note: '' };

  // 1. BOGO — "Buy 2 Get 1 Free (3 Bottles)". The parenthetical total is the
  //    only trustworthy number, and it is trusted ONLY when it reconciles.
  const bogo = BOGO_RE.exec(vt);
  if (bogo) {
    const bought = Number(bogo[1]);
    const free = Number(bogo[2]);
    const total = Number(bogo[3]);
    if (bought + free === total && total >= 1) {
      return { size: total, rule: 'parenthetical', confidence: 'review', is_digital: false, is_service: false, note: `buy ${bought} get ${free} free = ${total}` };
    }
    // The label contradicts itself — refuse, do not pick a number.
    return { ...none, note: 'bogo total does not reconcile' };
  }
  // 2. Digital — no physical unit, so a pack size is meaningless.
  if (DIGITAL_RE.test(vt) || DIGITAL_RE.test(pt)) {
    return { size: null, rule: 'digital', confidence: 'exact', is_digital: true, is_service: false, note: 'digital download' };
  }
  // 3. Service — shipping upgrades, protection plans, "Default Title" on a
  //    non-good. Never a group member.
  if (SERVICE_TITLE_RE.test(vt) || SERVICE_PRODUCT_RE.test(pt) || SERVICE_PRODUCT_RE.test(vt)) {
    return { size: null, rule: 'service', confidence: 'none', is_digital: false, is_service: true, note: 'service / non-good' };
  }
  // 4. Leading integer — "3 Bottles", "2 Pack".
  const lead = LEADING_INT_RE.exec(vt);
  if (lead) {
    const n = Number(lead[1]);
    if (n >= 1) return { size: n, rule: 'leading-int', confidence: 'exact', is_digital: false, is_service: false, note: '' };
  }
  // 5. Number word — "Three Bottles", "Single".
  const word = WORD_RE.exec(vt);
  if (word) {
    const n = WORD_NUMBERS[String(word[1]).toLowerCase()];
    if (n >= 1) return { size: n, rule: 'word', confidence: 'exact', is_digital: false, is_service: false, note: '' };
  }
  // 6. Unknown. Not 1 — unknown.
  return none;
}

// STAGE 0 — services and digital goods are not physical units and can never
// share a per-unit cost with one.
export function isExcluded(pack) {
  if (pack.rule === 'service' || pack.is_service) return { excluded: true, reason: 'service' };
  if (pack.rule === 'digital' || pack.is_digital) return { excluded: true, reason: 'digital' };
  return { excluded: false, reason: '' };
}

// ── C4 helpers: the trailing noun (reference :238-281) ─────────────────────
const GENERIC_NOUNS = new Set([
  'pack', 'packs', 'unit', 'units', 'piece', 'pieces', 'pc', 'pcs',
  'set', 'sets', 'bundle', 'bundles', 'box', 'boxes', 'count', 'ct',
  'item', 'items', 'order', 'orders',
]);
const COUNTING_RULES = new Set(['leading-int', 'word', 'parenthetical']);

/** Crude, deliberate, and symmetric: "Testers"→tester, "Boxes"→box. */
export function singular(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9]+$/, '');
  if (w.length > 3 && w.endsWith('es') && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// The noun a counting variant title ends on: "3 Testers" → tester. Blank when
// the title is not a counting one, or ends on a generic packaging word that
// says nothing about the good.
export function nounOf(variantTitle, rule) {
  if (rule && !COUNTING_RULES.has(rule)) return '';
  const tokens = sanitizeText(variantTitle, MAX_TITLE).match(/[A-Za-z]+/g);
  if (!tokens || !tokens.length) return '';
  const n = singular(tokens[tokens.length - 1]);
  if (!n || GENERIC_NOUNS.has(n)) return '';
  return n;
}

// product_type is a NEGATIVE signal only: channel plumbing words are not
// goods types, so they must not make two members "differently typed".
const NON_GOODS_TYPE_RE = /upsell|downsell|legacycheckout|legacy\s*platform|^shopify$|^crm\b|^$/i;
export function goodsType(productType) {
  const t = sanitizeText(productType, 120);
  return NON_GOODS_TYPE_RE.test(t) ? '' : t.toLowerCase();
}

// ── STAGE C — the four cross-checks ────────────────────────────────────────
// Each returns {code, ok, detail}. A failure DOWNGRADES to 'review'; it never
// drops a member. The operator is shown the cluster and told what is odd
// about it, because a silently-shrunk proposal is one nobody can audit.

function checkPackSizes(members) {
  const bad = members.filter((m) => m.units_per_conf === 'none' || m.units_per === null);
  return {
    code: 'pack_sizes_parse',
    ok: bad.length === 0,
    detail: bad.length
      ? `pack size unreadable on ${bad.length}: ${bad.slice(0, 4).map((m) => m.variant_title || m.variant_id).join(', ')}`
      : 'every member has a readable pack size',
  };
}

// Per-unit price points, skipping members without BOTH a known pack size and
// a real positive price. Price never MATCHES — it only contradicts.
function perUnitPoints(members) {
  const pts = [];
  for (const m of members) {
    const size = m.units_per;
    if (!Number.isInteger(size) || size < 1) continue;
    const p = Number(m.price);
    if (m.price === null || m.price === undefined || Number.isNaN(p) || !Number.isFinite(p) || p <= 0) continue;
    pts.push({ perUnit: p / size, size, member: m });
  }
  return pts;
}

function checkPriceLadder(members) {
  const pts = perUnitPoints(members);
  if (pts.length < 2) {
    return { code: 'price_ladder', ok: true, detail: 'not enough priced members to contradict the ladder' };
  }
  const bySize = new Map();
  for (const pt of pts) {
    if (!bySize.has(pt.size)) bySize.set(pt.size, []);
    bySize.get(pt.size).push(pt);
  }
  // Same tier: two members at the SAME pack size should cost about the same
  // per unit. A 3x spread means they are not the same good at the same tier.
  for (const [size, lst] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
    const lo = Math.min(...lst.map((x) => x.perUnit));
    const hi = Math.max(...lst.map((x) => x.perUnit));
    if (lo > 0 && hi / lo > SAME_TIER_MAX_RATIO) {
      return {
        code: 'price_ladder',
        ok: false,
        detail: `at pack size ${size}, per-unit prices span ${round2(lo)}–${round2(hi)} (${round2(hi / lo)}x)`,
      };
    }
  }
  // Across tiers: a BIGGER pack should not cost meaningfully MORE per unit.
  const sizes = [...bySize.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i += 1) {
    const hiPrev = Math.max(...bySize.get(sizes[i - 1]).map((x) => x.perUnit));
    const hiCur = Math.max(...bySize.get(sizes[i]).map((x) => x.perUnit));
    if (hiCur > hiPrev * LADDER_TOLERANCE) {
      return {
        code: 'price_ladder',
        ok: false,
        detail: `pack ${sizes[i]} costs ${round2(hiCur)}/unit vs pack ${sizes[i - 1]} at ${round2(hiPrev)}/unit`,
      };
    }
  }
  return { code: 'price_ladder', ok: true, detail: 'per-unit ladder is consistent' };
}

function checkGoodsType(members) {
  const types = new Set(members.map((m) => goodsType(m.product_type)).filter(Boolean));
  if (types.size < 2) {
    return {
      code: 'goods_type',
      ok: true,
      detail: types.size === 1
        ? `all members are ${[...types][0]}`
        : 'no product_type available to contradict (see this file\'s header)',
    };
  }
  return { code: 'goods_type', ok: false, detail: `members span ${[...types].sort().join(' / ')}` };
}

// THE CHECK THAT CATCHES THE LIVE OVER-MERGE: "1 Test Kit" vs "3 Testers".
// Both stem to the same product title, both parse a pack size, and the price
// ladder can look fine — but a kit and a tester are different goods.
function checkTrailingNoun(members) {
  const nouns = new Set(members.map((m) => nounOf(m.variant_title, m.units_per_rule)).filter(Boolean));
  if (nouns.size < 2) {
    return { code: 'trailing_noun', ok: true, detail: nouns.size === 1 ? `all members name a ${[...nouns][0]}` : 'no countable noun to contradict' };
  }
  return { code: 'trailing_noun', ok: false, detail: `members name different things: ${[...nouns].sort().join(' / ')}` };
}

// ── Union-find (deterministic: the lowest root id always wins) ─────────────
function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = x;
    while (parent.get(cur) !== cur) { const nxt = parent.get(cur); parent.set(cur, r); cur = nxt; }
    return r;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
    },
  };
}

/** Deterministic id, so a re-run is idempotent and a dismissal sticks. */
export function proposalIdFor(stems) {
  const key = [...stems].sort().join('|');
  return `cgp_${crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

// Longest stem, ties broken lexicographically, rendered in the original
// casing that produced it.
function suggestedName(stems, originals) {
  if (!stems.length) return '';
  const best = [...stems].sort((a, b) => (b.length - a.length) || (a < b ? 1 : a > b ? -1 : 0))[0];
  return originals.get(best) || best.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ══════════════════════════════════════════════════════════════════════════
// cluster() — PURE. Given catalog rows (+ an optional Shopify mirror), return
// the proposals. The harness drives this directly.
// ══════════════════════════════════════════════════════════════════════════
export function cluster(rows, mirror = new Map()) {
  const excluded = [];
  const live = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const vid = String(row.variant_id || '');
    if (!vid) continue;
    // 'ignored' is the operator saying this variant is off the worklist.
    // Proposing it back is nagging, so it is dropped before Stage A.
    if (row.coverage === 'ignored') continue;
    const variantTitle = sanitizeText(row.variant_title, MAX_TITLE);
    const productTitle = sanitizeText(row.product_title, MAX_TITLE);
    const pack = parsePackSize({ variantTitle, productTitle });
    const ex = isExcluded(pack);
    if (ex.excluded) {
      excluded.push({ variant_id: vid, reason: ex.reason, label: variantTitle || productTitle || vid });
      continue;
    }
    const enrich = mirror.get(vid) || {};
    live.push({
      variant_id: vid,
      product_title: productTitle,
      variant_title: variantTitle,
      image_url: row.image_url || '',
      price: row.price === null || row.price === undefined ? null : Number(row.price),
      shopify_product_id: String(row.shopify_product_id || enrich.shopify_product_id || ''),
      shopify_handle: String(row.shopify_handle || enrich.handle || ''),
      mirror_title: String(enrich.product_title || row.shopify_product_title || ''),
      product_type: String(enrich.product_type || ''),
      units_per: Number.isInteger(pack.size) && pack.size >= 1 ? pack.size : null,
      units_per_rule: pack.rule,
      units_per_conf: pack.confidence,
      contexts: Array.isArray(row.contexts) ? [...row.contexts].sort() : [],
      funnels: Array.isArray(row.funnels) ? [...row.funnels].sort() : [],
      units_30d: Number(row.units_30d || 0),
      revenue_30d: Number(row.revenue_30d || 0),
      already_bound_to: row.cost_item_id ? String(row.cost_item_id) : null,
    });
  }

  // STAGE A — one core per Shopify product. A variant the mirror does not
  // cover becomes its own core; it can still LINK through Stage B, but it
  // never drags unrelated variants in on a missing id.
  const cores = new Map();
  for (const m of live) {
    const pid = m.shopify_product_id || `vid:${m.variant_id}`;
    if (!cores.has(pid)) cores.set(pid, []);
    cores.get(pid).push(m);
  }

  // STAGE B — stem sets, then link cores sharing any EXACT stem.
  const stemsOf = new Map();
  const originals = new Map(); // stem → the SHORTEST original title that made it
  for (const [pid, members] of cores) {
    const set = new Set();
    for (const m of members) {
      for (const title of [m.product_title, m.mirror_title]) {
        if (!title) continue;
        const s = stem(title);
        if (!s) continue;
        set.add(s);
        const prev = originals.get(s);
        if (prev === undefined || title.length < prev.length) originals.set(s, title);
      }
    }
    // A product with no usable title links to nothing but itself.
    stemsOf.set(pid, set.size ? set : new Set([`core:${pid}`]));
  }

  const uf = makeUnionFind();
  const byStem = new Map();
  for (const [pid, set] of stemsOf) {
    uf.find(pid);
    for (const s of set) {
      if (!byStem.has(s)) byStem.set(s, []);
      byStem.get(s).push(pid);
    }
  }
  for (const pids of byStem.values()) {
    for (let i = 1; i < pids.length; i += 1) uf.union(pids[0], pids[i]);
  }

  const clusters = new Map();
  for (const pid of stemsOf.keys()) {
    const root = uf.find(pid);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(pid);
  }

  // STAGE C — score each cluster.
  const proposals = [];
  for (const pids of clusters.values()) {
    const members = pids.flatMap((pid) => cores.get(pid) || [])
      .sort((a, b) => (b.units_30d - a.units_30d)
        || a.product_title.localeCompare(b.product_title)
        || a.variant_id.localeCompare(b.variant_id));
    // A group of one is not a group.
    if (members.length < 2) continue;

    const stems = [...new Set(pids.flatMap((pid) => [...stemsOf.get(pid)]))]
      .filter((s) => !s.startsWith('core:')).sort();
    const linked = pids.length > 1;

    // A single Shopify product IS one good by construction, so the
    // cross-product checks have nothing to contradict. C1 still runs: pack
    // size is a per-variant reading, not a cross-product one.
    const checks = linked
      ? [checkPackSizes(members), checkPriceLadder(members), checkGoodsType(members), checkTrailingNoun(members)]
      : [checkPackSizes(members)];

    const blockers = [];
    for (const m of members) {
      if (m.units_per === null || m.units_per_conf === 'none') {
        blockers.push({ code: 'units_per_unknown', variant_id: m.variant_id, detail: `pack size unreadable on "${m.variant_title || m.product_title}"` });
      } else if (m.already_bound_to) {
        blockers.push({ code: 'already_bound', variant_id: m.variant_id, detail: `already in ${m.already_bound_to}` });
      }
    }
    if (pids.length > MAX_CLUSTER_PRODUCTS || members.length > MAX_CLUSTER_MEMBERS) {
      blockers.push({ code: 'cluster_too_large', variant_id: null, detail: `${members.length} variants across ${pids.length} products` });
    }

    let identity = linked ? 'high' : 'certain';
    if (checks.some((c) => !c.ok)) identity = 'review';
    const confidence = (identity === 'review' || blockers.length) ? 'review' : identity;

    // The members a one-click could safely bind RIGHT NOW: pack size known,
    // not already spoken for by another group.
    const ready = members.filter((m) => m.units_per !== null && !m.already_bound_to);

    const usableStems = stems.length ? stems : pids.map((p) => `core:${p}`).sort();
    proposals.push({
      proposal_id: proposalIdFor(usableStems),
      stems: usableStems,
      shopify_product_ids: [...pids].sort(),
      suggested_name: suggestedName(stems, originals) || members[0].product_title || members[0].variant_id,
      confidence,
      identity_confidence: identity,
      linked,
      members,
      members_ready: ready.map((m) => m.variant_id),
      checks,
      blockers,
      units_30d: members.reduce((s, m) => s + m.units_30d, 0),
      revenue_30d: round2(members.reduce((s, m) => s + m.revenue_30d, 0)),
    });
  }

  proposals.sort((a, b) => (b.units_30d - a.units_30d) || a.suggested_name.localeCompare(b.suggested_name));
  return { proposals, excluded };
}

// ── The Shopify mirror (optional enrichment) ───────────────────────────────
// co_funnel_products belongs to the commerce lane and may not exist on a
// fresh DB, so it is PROBED, exactly like funnelCosts.funnelNames probes the
// funnels table. A missing mirror costs us Stage A facts; it never throws.
export async function loadShopifyMirror() {
  const out = new Map();
  const [reg] = await pgQuery(`SELECT to_regclass('public.co_funnel_products') AS t`);
  if (!reg || !reg.t) return out;
  const rows = await pgQuery(
    `SELECT shopify_product_id, title, handle, variants FROM co_funnel_products`
  );
  for (const r of rows) {
    const variants = typeof r.variants === 'string' ? JSON.parse(r.variants) : r.variants;
    for (const v of Array.isArray(variants) ? variants : []) {
      const vid = String((v || {}).variant_id || '').trim();
      if (!vid) continue;
      // The same product can be snapshotted per funnel; first write wins and
      // they agree by construction (same Shopify product id).
      if (!out.has(vid)) {
        out.set(vid, {
          shopify_product_id: String(r.shopify_product_id || ''),
          product_title: String(r.title || ''),
          handle: String(r.handle || ''),
          // Not synced today — see this file's header (check C3).
          product_type: '',
        });
      }
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// detect() — run the rule, persist the proposals, reap the phantoms.
// ══════════════════════════════════════════════════════════════════════════
//
// IDEMPOTENCY AND STICKY DISMISSAL, IN ONE CONSTRAINT. proposal_id is the
// sha1 of the sorted stem set, and it is UNIQUE. The upsert below re-writes
// the OBSERVED fields (members, checks, confidence, …) and deliberately does
// NOT touch status / decided_at / decided_by / cost_item_id. So a re-run
// refreshes a dismissed proposal's contents and leaves it dismissed — the
// suppression list IS the proposals table, and there is no second one to
// drift.
//
// The phantom reaper deletes only status='open' rows the current estate no
// longer produces. 'dismissed' and 'accepted' are operator decisions and no
// sweep may erase them.
export async function detectProposals() {
  await ensureFunnelCostsTables();
  const rows = await pgQuery(`SELECT * FROM lb_variant_costs`);
  const mirror = await loadShopifyMirror();
  const parsed = rows.map((r) => ({
    ...r,
    contexts: typeof r.contexts === 'string' ? JSON.parse(r.contexts) : r.contexts,
    funnels: typeof r.funnels === 'string' ? JSON.parse(r.funnels) : r.funnels,
  }));
  const { proposals, excluded } = cluster(parsed, mirror);

  const seen = [];
  const tiers = { certain: 0, high: 0, review: 0 };
  for (const p of proposals) {
    seen.push(p.proposal_id);
    tiers[p.confidence] = (tiers[p.confidence] || 0) + 1;
    await pgQuery(
      `INSERT INTO lb_cost_group_proposals
         (fingerprint, rule, title, reason, score, members, refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (fingerprint) DO UPDATE SET
         rule = EXCLUDED.rule,
         title = EXCLUDED.title,
         reason = EXCLUDED.reason,
         score = EXCLUDED.score,
         members = EXCLUDED.members,
         refreshed_at = NOW()`,
      [
        p.proposal_id,
        p.confidence,
        p.suggested_name.slice(0, 200),
        // The whole verdict rides in one jsonb payload so the card can render
        // WHY without a second query. Passed as a RAW OBJECT: postgres.js
        // serializes jsonb params itself, and pre-stringifying would store a
        // jsonb STRING scalar that every later read gets back as text.
        {
          identity_confidence: p.identity_confidence,
          linked: p.linked,
          stems: p.stems,
          shopify_product_ids: p.shopify_product_ids,
          checks: p.checks,
          blockers: p.blockers,
          members_ready: p.members_ready,
          units_30d: p.units_30d,
          revenue_30d: p.revenue_30d,
        },
        // Rank = the money the grouping would put under one rate. Sorting the
        // worklist by unit count instead would float cheap high-volume SKUs
        // above the ones actually distorting the P&L.
        p.revenue_30d,
        p.members,
      ]
    );
  }

  const dropped = seen.length
    ? await pgQuery(
      `DELETE FROM lb_cost_group_proposals
       WHERE status = 'open' AND NOT (fingerprint = ANY($1)) RETURNING fingerprint`,
      [seen]
    )
    : await pgQuery(`DELETE FROM lb_cost_group_proposals WHERE status = 'open' RETURNING fingerprint`);

  const [openRow] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM lb_cost_group_proposals WHERE status = 'open'`
  );

  return {
    proposals: proposals.length,
    open: Number(openRow.n),
    certain: tiers.certain || 0,
    high: tiers.high || 0,
    review: tiers.review || 0,
    excluded: excluded.length,
    excluded_detail: excluded.slice(0, 50),
    dropped_stale: dropped.length,
    variants_scanned: rows.length,
    mirror_variants: mirror.size,
    ran_at: new Date().toISOString(),
  };
}

function proposalRow(r) {
  const reason = (typeof r.reason === 'string' ? JSON.parse(r.reason) : r.reason) || {};
  return {
    proposal_id: r.fingerprint,
    status: r.status,
    confidence: r.rule,
    suggested_name: r.title,
    members: typeof r.members === 'string' ? JSON.parse(r.members) : r.members,
    identity_confidence: reason.identity_confidence ?? null,
    linked: reason.linked ?? false,
    stems: reason.stems ?? [],
    shopify_product_ids: reason.shopify_product_ids ?? [],
    checks: reason.checks ?? [],
    blockers: reason.blockers ?? [],
    members_ready: reason.members_ready ?? [],
    units_30d: reason.units_30d ?? 0,
    revenue_30d: reason.revenue_30d ?? 0,
    cost_item_id: r.cost_item_id ?? null,
    detected_at: r.detected_at,
    refreshed_at: r.refreshed_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by || '',
  };
}

// Sorting happens in SQL, BEFORE the limit. (The reference sorts in Python
// after slicing, so above its cap the "top N" is an arbitrary N — a latent
// bug this port does not carry over.)
export async function listProposals({ status = 'open', limit = 200 } = {}) {
  await ensureFunnelCostsTables();
  const st = String(status || 'open');
  if (st !== 'all' && !PROPOSAL_STATUSES.includes(st)) {
    throw new CostError('bad_status', `status must be one of ${PROPOSAL_STATUSES} or all`);
  }
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 200));
  const params = [];
  let where = '';
  if (st !== 'all') { params.push(st); where = `WHERE status = $${params.length}`; }
  params.push(lim);
  const rows = await pgQuery(
    `SELECT * FROM lb_cost_group_proposals ${where}
     ORDER BY CASE rule WHEN 'certain' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
              score DESC, title, fingerprint
     LIMIT $${params.length}`,
    params
  );
  const items = rows.map(proposalRow);
  return { items, count: items.length };
}

export async function getProposal(proposalId) {
  await ensureFunnelCostsTables();
  const id = String(proposalId || '').trim();
  if (!PROPOSAL_RE.test(id)) throw new CostError('bad_proposal_id', 'proposal_id must look like cgp_…');
  const [row] = await pgQuery(`SELECT * FROM lb_cost_group_proposals WHERE fingerprint = $1`, [id]);
  if (!row) throw new CostError('unknown_proposal', 'no such proposal');
  return proposalRow(row);
}

// Dismiss. IDEMPOTENT by construction — re-dismissing rewrites the same
// fields. A dismissal survives every future detect run (see detectProposals).
export async function dismissProposal(proposalId, { reason = '', actor = '' } = {}) {
  const p = await getProposal(proposalId);
  await pgQuery(
    `UPDATE lb_cost_group_proposals
     SET status = 'dismissed', decided_at = NOW(), decided_by = $2,
         reason = jsonb_set(reason, '{dismiss_reason}', to_jsonb($3::text))
     WHERE fingerprint = $1`,
    [p.proposal_id, String(actor || '').slice(0, 128), String(reason || '').slice(0, MAX_REASON)]
  );
  return { proposal_id: p.proposal_id, status: 'dismissed' };
}

// Re-open a dismissal. The operator's escape hatch — without it a mis-click
// permanently hides a real grouping, since detect refuses to resurrect it.
export async function reopenProposal(proposalId) {
  const p = await getProposal(proposalId);
  if (p.status === 'accepted') throw new CostError('already_accepted', 'this proposal already became a group');
  await pgQuery(
    `UPDATE lb_cost_group_proposals
     SET status = 'open', decided_at = NULL, decided_by = '' WHERE fingerprint = $1`,
    [p.proposal_id]
  );
  return { proposal_id: p.proposal_id, status: 'open' };
}

// ACCEPT — the proposal becomes a group.
//
// Members are bound EXPLICITLY: the caller's list when given, otherwise the
// proposal's members_ready as of NOW. It is never "whatever the proposal
// happens to say" silently — the response reports exactly what was bound, and
// the members carry the detected units_per, which is the multiplier the P&L
// will apply to the group rate.
//
// Accepting creates NO rate. The group is costed only when the operator
// enters one through the append-only write door.
export async function acceptProposal(proposalId, { name = '', note = '', members = null, actor = '' } = {}) {
  const p = await getProposal(proposalId);
  if (p.status === 'accepted' && p.cost_item_id) {
    // IDEMPOTENT: a double-click must not mint a second group over the same
    // variants — the second bind would silently steal them from the first.
    throw new CostError('already_accepted', 'this proposal already became a group');
  }
  const bySize = new Map((p.members || []).map((m) => [String(m.variant_id), m.units_per]));
  let list;
  if (Array.isArray(members) && members.length) {
    list = members.map((m) => {
      const vid = String(typeof m === 'object' && m ? m.variant_id : m);
      const explicit = typeof m === 'object' && m && m.units_per !== undefined ? m.units_per : bySize.get(vid);
      return { variant_id: vid, units_per: explicit === null || explicit === undefined ? 1 : explicit };
    });
  } else {
    list = (p.members_ready || []).map((vid) => ({
      variant_id: String(vid),
      units_per: bySize.get(String(vid)) ?? 1,
    }));
  }
  if (list.length > MAX_MEMBERS) throw new CostError('too_many_members', `a group holds at most ${MAX_MEMBERS} variants`);
  if (list.length < 2) {
    // Every candidate was blocked (unknown pack size, or already in another
    // group). Refuse rather than mint a one-member group whose rate would
    // reach almost nothing.
    throw new CostError('too_few_members', 'no two bindable members — resolve the blockers first');
  }

  const created = await createGroup({
    name: String(name || p.suggested_name || '').trim() || p.suggested_name || p.proposal_id,
    note: String(note || '').slice(0, 500),
    members: list,
    createdBy: actor,
  });
  await pgQuery(
    `UPDATE lb_cost_group_proposals
     SET status = 'accepted', cost_item_id = $2, decided_at = NOW(), decided_by = $3
     WHERE fingerprint = $1`,
    [p.proposal_id, created.group.cost_item_id, String(actor || '').slice(0, 128)]
  );
  return {
    proposal_id: p.proposal_id,
    status: 'accepted',
    ...created,
  };
}

export default {
  cluster, detectProposals, listProposals, getProposal, dismissProposal,
  reopenProposal, acceptProposal, loadShopifyMirror, stem, parsePackSize,
  proposalIdFor, sanitizeText, nounOf, singular, goodsType, isExcluded,
  PROPOSAL_STATUSES, CONFIDENCE,
};
