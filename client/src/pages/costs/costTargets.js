// costTargets — the pure logic behind the Costs workspace (NEW FILE, costs lane).
//
// Ported from the reference implementation's costTargets.js. Two rules carry
// the whole build and live here (no React, no fetch, harness-tested in
// client/scripts/verifyCostsUi.mjs):
//
//   1. NULL vs 0. `null` means "nobody has told us what this costs".
//      `0` means "we know, it is free". They are different answers and must
//      stay different: blank clears to `null`, and the ONLY way to write an
//      explicit 0 is the "known free" checkbox in the rate drawer. The
//      reference shipped a blank→0 coercion once and fabricated a
//      free-shipping claim on 24 live variants; this module is the fix.
//
//   2. THE FAN-OUT TARGET RESOLVER. An "item"-scope (cost-group) rate reaches
//      every variant bound to the group, across funnels. `resolveFanOutTargets`
//      returns the EXACT list the drawer shows before saving. (v1 keeps
//      cost_item_id as a nullable hook, so in practice scope stays "variant".)
//
// Cost convention: `unit_cogs` is the cost of ONE UNIT OF THE VARIANT — a
// "5 Packs" variant's unit_cogs is the cost of the five-pack, not one bottle.

/** Per-context shipping keys, in the order the grid renders them. */
export const CONTEXT_KEYS = ['main', 'upsell', 'addon', 'bump'];

/** Row lifecycle states, mirrored from `lb_variant_costs.coverage`. */
export const ROW_STATUSES = ['needs_cost', 'ready', 'ignored'];

export const EM_DASH = '—';

/* ── formatting (null-aware, the review bar for this lane) ─────────────── */

const isNil = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));

/** Full-precision money. `null`/`undefined`/NaN → em dash, never "$0.00". */
export function fmtMoney(v, currency = 'USD') {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return EM_DASH;
  const s = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return n < 0 ? `−${s}` : s;
}

/** Whole-dollar money for dense tables. Same null discipline. */
export function fmtMoney0(v) {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return EM_DASH;
  const s = `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  return n < 0 ? `−${s}` : s;
}

export function fmtInt(v) {
  if (isNil(v)) return EM_DASH;
  return new Intl.NumberFormat('en-US').format(Math.round(Number(v)));
}

/** A percentage already stored as a percentage (e.g. margin 62.4). */
export function fmtPct(v, dp = 1) {
  if (isNil(v)) return EM_DASH;
  return `${Number(v).toFixed(dp)}%`;
}

/** A ratio (e.g. ROAS 1.52) with an "x" suffix. */
export function fmtX(v, dp = 2) {
  if (isNil(v)) return EM_DASH;
  return `${Number(v).toFixed(dp)}x`;
}

export function fmtDateTime(iso) {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Local-calendar today, YYYY-MM-DD (matches DateRangePicker's day boundary). */
export function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function daysAgoIso(n) {
  const d = new Date(Date.now() - n * 86_400_000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/* ── row semantics ─────────────────────────────────────────────────────── */

/**
 * The row's lifecycle state as the BACKEND sees it (`coverage`) — the only
 * authority on `ignored`, which is an operator decision the detection sweep
 * must never reset. Tolerates a legacy `status` key.
 */
export function lifecycleOf(row) {
  const v = row?.coverage ?? row?.status;
  return ROW_STATUSES.includes(v) ? v : null;
}

/** True for a row the operator has deliberately taken off the worklist. */
export function isIgnored(row) {
  return lifecycleOf(row) === 'ignored';
}

/** A finite number, or null. Never NaN, never a numeric string leaking through. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The shipping cost in force for one context. Null-aware fall-through: an
 * explicit `0` on the context wins (known free for that leg), a `null` falls
 * through to `default`, and only when BOTH are absent is the answer unknown
 * (`null`). A `0` default is a real answer and does not fall through.
 */
export function resolveShip(ship, context) {
  if (!ship || typeof ship !== 'object') return null;
  const own = ship[context];
  if (own !== null && own !== undefined && own !== '') {
    const n = Number(own);
    if (Number.isFinite(n)) return n;
  }
  const dflt = ship.default;
  if (dflt !== null && dflt !== undefined && dflt !== '') {
    const n = Number(dflt);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** The resolved kind for a row: an operator pin beats the detector. */
export function resolveKind(row) {
  if (!row) return 'main';
  return row.kind_override || row.kind_auto || row.kind || 'main';
}

/**
 * The context a single-figure display (margin, the ship headline) should use.
 * `contexts` is a LIST — variants sold as both a main offer and an upsell are
 * real, and collapsing to one majority vote is the trap the reference names T5.
 */
export function primaryContext(row) {
  const list = Array.isArray(row?.contexts) ? row.contexts : [];
  for (const k of CONTEXT_KEYS) if (list.includes(k)) return k;
  const kind = resolveKind(row);
  return CONTEXT_KEYS.includes(kind) ? kind : 'main';
}

/**
 * Does this variant carry a shipping cost at all?
 * Operator override → Shopify `requiresShipping` → "mains ship, legs ride
 * along". `false` is a real answer at every step, so `??`-style explicit
 * null checks (never `||`) are load-bearing here.
 */
export function paysShipping(row) {
  if (!row) return false;
  if (row.pays_shipping_override !== null && row.pays_shipping_override !== undefined) {
    return Boolean(row.pays_shipping_override);
  }
  if (row.pays_shipping !== null && row.pays_shipping !== undefined) {
    return Boolean(row.pays_shipping);
  }
  if (row.requires_shipping !== null && row.requires_shipping !== undefined) {
    return Boolean(row.requires_shipping);
  }
  return resolveKind(row) === 'main';
}

/**
 * Parse one operator keystroke into a cost value.
 * Returns `{ value, error, cleared }` so "blank" and "zero" cannot collapse
 * into each other on the way out:
 *   ""      → { value: null, cleared: true }        — clears to UNKNOWN
 *   "3.20"  → { value: 3.2 }
 *   "0"     → { error: "zero_requires_known_free" } — must be deliberate
 *   "-1"    → { error: "negative" }
 *   "abc"   → { error: "not_a_number" }
 * `knownFree: true` is the one door to an explicit 0 and ignores the text.
 */
export function parseCostInput(raw, { knownFree = false } = {}) {
  if (knownFree) return { value: 0, error: null, cleared: false };
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (s === '') return { value: null, error: null, cleared: true };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, error: 'not_a_number', cleared: false };
  if (n < 0) return { value: null, error: 'negative', cleared: false };
  if (n === 0) return { value: null, error: 'zero_requires_known_free', cleared: false };
  return { value: n, error: null, cleared: false };
}

/** Human text for a `parseCostInput` error code. */
export function costInputError(code) {
  return {
    negative: 'A cost cannot be negative.',
    not_a_number: 'Enter a number, or clear the field to mark it unknown.',
    zero_requires_known_free:
      'Use "known free" in the rate editor to record a real $0.00 — a blank field means unknown.',
  }[code] || 'Invalid value.';
}

/**
 * Render one cost value. `null` is an unknown dash, `0` is "$0.00".
 * The whole point of the module in one function.
 */
export function formatCost(value, { currency = 'USD' } = {}) {
  if (value === null || value === undefined || value === '') {
    return { state: 'unknown', text: EM_DASH };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { state: 'unknown', text: EM_DASH };
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  const text = `${n < 0 ? '-' : ''}${sym}${Math.abs(n).toFixed(2)}`;
  return { state: n === 0 ? 'free' : 'value', text };
}

/**
 * How complete is this row's cost picture?
 *   "none"    — no COGS at all. Margin MUST render as a dash, never 100%.
 *   "partial" — COGS known, but the row ships and its shipping is unknown.
 *   "full"    — everything needed to compute a margin is present.
 */
export function rowCoverage(row) {
  const cogs = row?.unit_cogs;
  if (cogs === null || cogs === undefined || !Number.isFinite(Number(cogs))) return 'none';
  if (paysShipping(row) && resolveShip(row?.ship, primaryContext(row)) === null) return 'partial';
  return 'full';
}

/**
 * Contribution margin %, or `null` — never 0, never 100 — whenever any cost
 * is unknown. "Unknown" covers SHIPPING too: a row that ships with no ship
 * figure has NO margin, not a margin computed as if shipping were free.
 */
export function computeMargin(row) {
  if (rowCoverage(row) !== 'full') return null;
  const price = num(row?.price);
  if (price === null || price <= 0) return null;
  const cogs = num(row?.unit_cogs) ?? 0;
  const ship = paysShipping(row) ? (resolveShip(row?.ship, primaryContext(row)) ?? 0) : 0;
  return ((price - cogs - ship) / price) * 100;
}

/** Catalog-wide coverage. Ignored rows are out of the denominator. */
export function computeCoverage(rows) {
  const live = (Array.isArray(rows) ? rows : []).filter((r) => r && !isIgnored(r));
  const costed = live.filter((r) => rowCoverage(r) !== 'none').length;
  const total = live.length;
  return { costed, total, pct: total ? (costed / total) * 100 : 0 };
}

/** 30d revenue still booked at 100% margin — the "why this matters" figure. */
export function uncostedRevenue(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && !isIgnored(r) && rowCoverage(r) === 'none')
    .reduce((acc, r) => acc + (num(r.revenue_30d) ?? 0), 0);
}

/** "Acme Widget — 5 Packs", never a bare tier name (they collide across products). */
export function variantLabel(row) {
  const p = String(row?.product_title || '').trim();
  const v = String(row?.variant_title || '').trim();
  if (p && v) return `${p} — ${v}`;
  return p || v || String(row?.variant_id || EM_DASH);
}

function targetOf(row, { shadowed }) {
  return {
    variant_id: String(row?.variant_id ?? ''),
    label: variantLabel(row),
    funnels: Array.isArray(row?.funnels) ? row.funnels : [],
    contexts: Array.isArray(row?.contexts) ? row.contexts : [],
    units_30d: num(row?.units_30d) ?? 0,
    units_per: num(row?.units_per) ?? 1,
    current: row?.unit_cogs === null || row?.unit_cogs === undefined ? null : Number(row.unit_cogs),
    shadowed,
  };
}

/**
 * The exact list of variants one save will touch.
 * `scope: "variant"` — one row, no fan-out, ever.
 * `scope: "item"` — every non-ignored variant bound to the group; a variant
 * with its OWN variant-scope rate is listed but flagged `shadowed` (the group
 * rate is written, the resolved cost does not move).
 * `crossFunnel` is true when the save reaches a funnel the edited variant is
 * not itself wired on — the single fact that makes a COGS edit dangerous.
 */
export function resolveFanOutTargets({ row, rows = [], scope = 'variant' } = {}) {
  if (!row) {
    return { scope, targets: [], affected: [], shadowed: [], funnels: [], crossFunnel: false };
  }
  const all = Array.isArray(rows) ? rows : [];

  let group;
  if (scope === 'item' && row.cost_item_id) {
    group = all.filter((r) => r && r.cost_item_id === row.cost_item_id && !isIgnored(r));
    if (!group.some((r) => String(r.variant_id) === String(row.variant_id))) {
      group = [row, ...group];
    }
  } else {
    // Variant scope — or an "item" edit on a variant bound to no group, which
    // can only mean itself. Never silently widen.
    group = [row];
  }

  const targets = group
    .map((r) => targetOf(r, { shadowed: scope === 'item' && r.cogs_source === 'variant' }))
    .sort((a, b) => (b.units_30d - a.units_30d) || a.label.localeCompare(b.label));

  const affected = targets.filter((t) => !t.shadowed);
  const shadowed = targets.filter((t) => t.shadowed);

  const funnels = [...new Set(affected.flatMap((t) => t.funnels.map((f) => String(f?.funnel_id ?? f))))].sort();
  const own = new Set((Array.isArray(row.funnels) ? row.funnels : []).map((f) => String(f?.funnel_id ?? f)));
  const crossFunnel = funnels.some((f) => !own.has(f));

  return {
    scope: scope === 'item' && row.cost_item_id ? 'item' : 'variant',
    targets,
    affected,
    shadowed,
    funnels,
    crossFunnel,
  };
}

/**
 * The POST body for an INLINE cogs save. Deliberately carries NO
 * `effective_from` / `only_from_today`: the server backdates a variant's FIRST
 * cost to its first sale (a first cost dated today reports nothing — every
 * historical report keeps showing 100% margin) and starts a later one today.
 * Pinning a date belongs to the RateDrawer, which shows the resolved date.
 *
 * The row's CURRENT shipping is carried forward deliberately: a rate row is a
 * complete SNAPSHOT, so omitting shipping here would wipe it while the
 * operator thought they were editing one number.
 */
export function buildInlineRateBody(row, value) {
  return {
    scope: 'variant',
    variant_id: String(row?.variant_id ?? ''),
    unit_cogs: value,
    ship: row?.ship || {},
    currency: 'USD',
    source: 'manual',
  };
}

/**
 * The rate body for an inline SHIPPING edit. Carries the variant's current
 * unit_cogs forward for the same snapshot reason — saving shipping must never
 * silently un-know the cost that was already entered.
 */
export function buildInlineShipBody(row, context, value) {
  const ship = { ...(row?.ship || {}) };
  ship[context] = value;
  return {
    scope: 'variant',
    variant_id: String(row?.variant_id ?? ''),
    unit_cogs: row?.unit_cogs ?? null,
    ship,
    currency: 'USD',
    source: 'manual',
  };
}

/** Filter chips → predicate. "all" keeps ignored rows out of the way. */
export function matchesFilter(row, filter) {
  if (!row) return false;
  const ignored = isIgnored(row);
  if (filter === 'needs_cost') return !ignored && rowCoverage(row) === 'none';
  if (filter === 'ready') return !ignored && rowCoverage(row) !== 'none';
  if (filter === 'ignored') return ignored;
  return !ignored;
}

/* ── fee settings (mirrors PATCH /fee-settings) ────────────────────────── */

/**
 * Blank → null (inherit the default). A typed value → that number.
 * Throws on junk and negatives, which the API would 4xx on anyway.
 */
export function optionalNumber(raw, label) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number, or blank to use the default.`);
  if (n < 0) throw new Error(`${label} cannot be negative.`);
  return n;
}

export function requiredNumber(raw, label) {
  const n = optionalNumber(raw, label);
  if (n === null) throw new Error(`${label} is required.`);
  return n;
}

/**
 * Draft → PATCH /fee-settings body. Both gateway fields blank = `null`
 * (no override at all, the documented way to clear one back to the default);
 * a partial override keeps the blank half as null so it inherits.
 */
export function buildFeeSettingsBody(draft, gateways) {
  const body = {
    default: {
      pct: requiredNumber(draft.pct, 'Processing rate'),
      fixed: optionalNumber(draft.fixed, 'Fixed fee') ?? 0,
    },
    gateways: {},
  };
  for (const { key, label } of gateways) {
    const pct = optionalNumber(draft.gateways[key].pct, `${label} rate`);
    const fixed = optionalNumber(draft.gateways[key].fixed, `${label} fixed fee`);
    body.gateways[key] = (pct === null && fixed === null) ? null : { pct, fixed };
  }
  return body;
}

/* ── manual spend (PnL drill-in) ───────────────────────────────────────── */

/**
 * Manual spend for a day. Unlike COGS, a typed 0 is legitimate here ("we
 * spent nothing that day" is a real, unambiguous claim), but blank is still
 * refused rather than coerced — there is nothing to save.
 */
export function parseManualSpend(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, error: 'empty' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, error: 'not_a_number' };
  if (n < 0) return { value: null, error: 'negative' };
  return { value: n, error: null };
}
