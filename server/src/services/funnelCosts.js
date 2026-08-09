// COGS / shipping / processing-fee resolver — the pure cost engine + catalog.
// Faithful port of funnel-os backend/app/services/lb_cogs_service.py
// (resolve_unit_cogs :386, resolve_unit_ship :412, resolve_fee_rate :525,
// build_legs :631, build_upsell_legs :706, resolve_costs :774-1020,
// coverage_summary :1306) and lb_cost_detection_service.py's SOLD sweep,
// mapped onto Puure's co_* money tables.
//
// THE TWO WORDS THAT ALREADY MEAN TWO THINGS (reference docstring :9-31):
// * `shipping` on a co_sessions row is shipping CHARGED TO THE BUYER —
//   revenue. Our fulfilment cost is ALWAYS spelled `ship_cost` and is never
//   written onto a money document.
// * None and 0.0 are DIFFERENT ANSWERS and must stay different. null means
//   *nobody has told us* — the leg lands in missing_legs and the order's
//   profit is withheld. 0 means *known free* and is a real answer. The rule
//   binds shipping exactly as hard as it binds COGS: unknown ship and an
//   explicit ship=0 must never produce byte-identical output.
//
// REVENUE BASE (reference :33-44): an order's revenue is the money the
// processors actually captured — collected(session) plus every settled upsell
// charge — deliberately NOT the sum of the cart lines. The difference is
// surfaced as other_revenue rather than smuggled into a leg.
//
// REFUNDS net the top line only. COGS is not reversed (the goods do not come
// back) and fees are not reversed (processors keep them).
//
// LET IT THROW: nothing in this file swallows an error. A bad write raises
// CostError (the route maps it to a 4xx with .code); an infra failure
// propagates to the route's 500 boundary.
import { pgQuery } from '../db/pg.js';
import { ensureFunnelCostsTables } from './funnelCostsSchema.js';
import { funnelSpendByDay, deriveCampaignBindings, metaConfigured } from './funnelSpend.js';

// ── Constants (reference :113-128) ─────────────────────────────────────────
// Contexts a cost can be resolved for. "default" is the fallback bucket
// inside a rate's ship map, never a leg context.
export const CONTEXTS = ['main', 'upsell', 'addon', 'bump'];
export const SHIP_KEYS = ['default', ...CONTEXTS];
export const SCOPES = ['variant', 'item'];
export const SOURCES = ['manual', 'import', 'detect', 'revert'];
export const COVERAGE_STATES = ['needs_cost', 'ready', 'ignored'];
export const SEED_GATEWAYS = ['whop', 'stripe', 'paypal', 'nmi'];
// Upsell charge statuses that really collected money. Puure semantics
// (funnelAnalytics.js :145): 'settled' and 'refunded' — a refunded leg DID
// collect (refunds net the top line; the leg stays gross). 'declined' rows
// are markers carrying no money and 'charging'/'pending_settlement' are
// intent, not money.
export const COLLECTED_UPSELL = ['settled', 'refunded'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Shopify numeric variant ids are 12-14 digits today; the bound is generous
// but still rejects free text (reference :131-134).
const VARIANT_RE = /^[0-9]{6,20}$/;
const ITEM_RE = /^ci_[0-9a-z_-]{2,64}$/i;
// Effective-from floor for a backdated first rate whose variant has no known
// first sale — earlier than any order this business has ever taken.
const EPOCH_DAY = '2000-01-01';

// THE money predicate — copied verbatim from funnelAnalytics.js:198 (the
// canonical definition; see that file's header for why 'refunded' must be in
// the set and why paid_at IS NOT NULL is load-bearing).
const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

// Rejected write — the route maps this to a 4xx with .code.
export class CostError extends Error {
  constructor(code, message = '') {
    super(message || code);
    this.code = code;
  }
}

// ── Small pure helpers ─────────────────────────────────────────────────────
export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 10000) / 10000;

// UTC 'YYYY-MM-DD' for a Date / ISO string / day key. Every date in this
// lane is a UTC day key compared as a string — no timezone re-parse.
export function dayKey(value = null) {
  if (typeof value === 'string' && DAY_RE.test(value)) return value;
  const d = value == null ? new Date() : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n, now = null) {
  const base = now ? new Date(now) : new Date();
  return new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
}

// null stays null (unknown); anything else must be a finite number >= 0.
// Blank must reach this function as null and LEAVE as null — coercing
// blank → 0 is how the legacy catalog fabricated 24 shipping=0 rows.
export function moneyOrNone(v, field, maxValue = null) {
  if (v === null || v === undefined) return null;
  const f = Number(v);
  if (typeof v === 'boolean' || v === '' || Number.isNaN(f) || !Number.isFinite(f)) {
    throw new CostError('bad_amount', `${field} is not a number`);
  }
  if (f < 0) throw new CostError('negative_amount', `${field} must be >= 0`);
  if (maxValue !== null && f > maxValue) {
    throw new CostError('bad_pct', `${field} must be <= ${maxValue}`);
  }
  return round4(f);
}

// A full five-key ship map. Missing keys are null (unknown), NOT 0.
export function normalizeShip(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of SHIP_KEYS) out[k] = moneyOrNone(src[k], `ship.${k}`);
  return out;
}

function cleanId(scope, refId) {
  const ref = String(refId || '').trim();
  if (scope === 'variant') {
    if (!VARIANT_RE.test(ref)) throw new CostError('bad_variant_id', 'variant_id must be numeric');
  } else if (scope === 'item') {
    if (!ITEM_RE.test(ref)) throw new CostError('bad_cost_item_id', 'cost_item_id must look like ci_…');
  } else {
    throw new CostError('bad_scope', 'scope must be variant or item');
  }
  return ref;
}

const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === 'string') return JSON.parse(v); // let a corrupt row THROW
  return v;
};

// ── Rate resolution (pure — the harness runs this exact code) ──────────────
// The ledger indexed ONCE per public call, bisected per lookup
// (reference RateIndex :249-350). Rows sharing (effective_from, created_at)
// keep insertion order so the last WRITE wins — correcting today's typo is
// deterministic.
export function buildRateIndex(rows) {
  const buckets = new Map(); // `${scope}|${ref}` → [{ef, at, row}]
  for (const r of rows || []) {
    const scope = String(r.scope || '');
    const ref = String((scope === 'variant' ? r.variant_id : r.cost_item_id) || '');
    const ef = dayKey(r.effective_from);
    if (!ref || !ef) continue;
    const key = `${scope}|${ref}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ef, at: String(r.created_at || ''), id: Number(r.id || 0), row: r });
  }
  for (const lst of buckets.values()) {
    lst.sort((a, b) => (a.ef < b.ef ? -1 : a.ef > b.ef ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  }
  return {
    lookup(scope, refId, day) {
      const lst = buckets.get(`${String(scope)}|${String(refId)}`);
      if (!lst) return null;
      const d = String(day || '');
      // bisect_right over effective_from
      let lo = 0;
      let hi = lst.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lst[mid].ef <= d) lo = mid + 1;
        else hi = mid;
      }
      return lo === 0 ? null : lst[lo - 1].row;
    },
  };
}

// (unit cost of ONE unit of this variant, which rate answered).
// Chain: variant-scoped rate wins outright; otherwise the variant's cost
// group answers, multiplied by units_per (COGS is per unit OF THE VARIANT; a
// "5 Packs" variant bound to a single-bottle item has units_per 5). Returns
// [null, null] when nobody has told us — never 0.
export function resolveUnitCogs(vc, rateIndex, day) {
  const v = vc || {};
  const vid = String(v.variant_id || '');
  const r = rateIndex.lookup('variant', vid, day);
  if (r && r.unit_cogs !== null && r.unit_cogs !== undefined) {
    return [Number(r.unit_cogs), 'variant'];
  }
  const itemId = String(v.cost_item_id || '');
  if (itemId) {
    const ri = rateIndex.lookup('item', itemId, day);
    if (ri && ri.unit_cogs !== null && ri.unit_cogs !== undefined) {
      const unitsPer = Number(v.units_per) > 0 ? Number(v.units_per) : 1;
      return [Number(ri.unit_cogs) * unitsPer, 'item'];
    }
  }
  return [null, null];
}

// (ship cost of ONE unit in this context, which rate answered).
// Chain per source: ship[context] → ship.default → the cost group's map →
// unknown. An explicit 0 at any step is a real answer (known free) and STOPS
// the chain; only null falls through. Ship is per SHIPPED UNIT of the
// variant, not per unit of the physical good — a 5-pack goes in one box, so
// units_per does NOT multiply here. That asymmetry with COGS is deliberate.
export function resolveUnitShip(vc, rateIndex, day, context) {
  const v = vc || {};
  const ctx = CONTEXTS.includes(context) ? context : 'main';
  const pick = (rate) => {
    if (!rate) return null;
    const ship = parseJson(rate.ship, {}) || {};
    let val = ship[ctx];
    if (val === null || val === undefined) val = ship.default;
    return val === null || val === undefined ? null : Number(val);
  };
  let val = pick(rateIndex.lookup('variant', String(v.variant_id || ''), day));
  if (val !== null) return [val, 'variant'];
  const itemId = String(v.cost_item_id || '');
  if (itemId) {
    val = pick(rateIndex.lookup('item', itemId, day));
    if (val !== null) return [val, 'item'];
  }
  return [null, null];
}

// (pct, fixed) for a gateway. A missing OR null override → the default; a
// partial override fills its blanks from the default (reference :525-540).
export function resolveFeeRate(feeSettings, provider) {
  const s = feeSettings || {};
  const dPct = s.default_pct === null || s.default_pct === undefined ? 6.0 : Number(s.default_pct);
  const dFixed = Number(s.default_fixed || 0);
  const gw = (s.gateways || {})[String(provider || '').trim().toLowerCase()];
  if (!gw || typeof gw !== 'object') return { pct: dPct, fixed: dFixed };
  return {
    pct: gw.pct === null || gw.pct === undefined ? dPct : Number(gw.pct),
    fixed: gw.fixed === null || gw.fixed === undefined ? dFixed : Number(gw.fixed),
  };
}

// The variant's classification — an operator pin beats the detector.
export function resolveKind(vc) {
  const v = vc || {};
  return String(v.kind_override || v.kind_auto || 'main').trim().toLowerCase() || 'main';
}

// Does this variant carry a fulfilment cost at all? Operator column
// (pays_shipping, default TRUE in DDL) → kind fallback ("mains ship, legs
// ride along"). false is a real answer — explicit null test, never `||`.
// A variant that does not ship has a KNOWN shipping cost of zero, so a blank
// ship rate on it is not a miss.
export function paysShipping(vc) {
  const v = vc || {};
  if (v.pays_shipping !== null && v.pays_shipping !== undefined) return Boolean(v.pays_shipping);
  return resolveKind(v) === 'main';
}

// A cart line's context. is_bump is authoritative; otherwise the variant's
// own classification decides, defaulting to main.
export function contextOfLine(li, vc) {
  if (li && li.is_bump) return 'bump';
  const kind = String((vc || {}).kind_override || (vc || {}).kind_auto || '').trim().toLowerCase();
  return kind === 'addon' || kind === 'bump' ? kind : 'main';
}

// Money actually captured on the base session. Puure has no deposit lane —
// total IS the capture (the reference's deposit/balance split ports as a
// single base transaction).
export function collected(s) {
  return round2(Number((s || {}).total || 0));
}

export function refundsOf(s) {
  const entries = (s || {}).refunds;
  const list = Array.isArray(entries) ? entries : parseJson(entries, []);
  if (Array.isArray(list) && list.length) {
    return round2(list.reduce((sum, e) => sum + (e && typeof e === 'object' ? Number(e.amount || 0) : 0), 0));
  }
  return 0;
}

const providerOf = (s) => String((s || {}).gateway || 'whop').toLowerCase();

// ── Legs + transactions (reference build_legs :631 / build_upsell_legs :706)
// Legs = every cart line + every SETTLED upsell charge. Transactions exist
// because processors charge PER CHARGE, not per order: an order with three
// upsells is four charges, and billing one blended fee on the order total
// understates the fixed component by a factor of the leg count.
export function buildLegs(session, charges = null, catalog = null) {
  const s = session || {};
  const cat = catalog || {};
  const provider = providerOf(s);
  const legs = [];
  const txs = [{ id: 'base', amount: collected(s), provider }];

  const lines = Array.isArray(s.line_items) ? s.line_items : parseJson(s.line_items, []);
  (Array.isArray(lines) ? lines : []).forEach((li, lineIndex) => {
    if (!li || typeof li !== 'object') return;
    const vid = String(li.variant_id || '').trim();
    let qty = parseInt(li.quantity, 10);
    if (Number.isNaN(qty)) qty = 1;
    qty = Math.max(qty, 0);
    const price = Number(li.price || 0);
    legs.push({
      variant_id: vid,
      context: contextOfLine(li, cat[vid]),
      quantity: qty,
      revenue: round2(qty * price),
      unit_price: round2(price),
      title: li.title || '',
      product_title: li.product_title || '',
      tx: 'base',
      kind: 'cart',
      line_index: lineIndex,
    });
  });

  const [upLegs, upTxs] = buildUpsellLegs(charges, provider, txs.length);
  legs.push(...upLegs);
  txs.push(...upTxs);
  return [legs, txs];
}

// (legs, transactions) for co_upsell_charges rows. Skipped: everything
// outside COLLECTED_UPSELL and every $0 marker row. NOT skipped: a settled
// charge with no variant — it becomes an UNCOSTED leg rather than vanishing,
// and, decisively, its transaction is still billed a fee (dropping it made
// the processor's cut on that money silently free — reference :719-724).
// Every settled charge is stamped cost_day = ITS OWN settle day, so an
// upsell recovered days after the order prices at the rate in force when its
// money actually landed (MONEY INVARIANT 4).
export function buildUpsellLegs(charges, provider, txOffset = 0) {
  const legs = [];
  const txs = [];
  for (const c of charges || []) {
    if (!c || typeof c !== 'object') continue;
    if (!COLLECTED_UPSELL.includes(String(c.status || ''))) continue;
    const amount = Number(c.amount || 0);
    if (amount <= 0) continue; // the $0 decline marker row
    const lines = Array.isArray(c.line_items) ? c.line_items : parseJson(c.line_items, []);
    const li = Array.isArray(lines) && lines.length && lines[0] && typeof lines[0] === 'object' ? lines[0] : {};
    const vid = String(li.variant_id || '').trim();
    let qty = parseInt(li.quantity, 10);
    if (Number.isNaN(qty)) qty = 1;
    qty = Math.max(qty, 1);
    const txId = `upsell:${c.id || vid || 'anon'}:${txOffset + txs.length}`;
    txs.push({ id: txId, amount: round2(amount), provider });
    const leg = {
      variant_id: vid,
      context: 'upsell',
      quantity: qty,
      revenue: round2(amount),
      unit_price: round2(Number(li.unit_price || amount / qty)),
      title: li.title || '',
      product_title: li.product_title || '',
      tx: txId,
      kind: 'upsell',
      charge_id: String(c.id || ''),
    };
    // Only stamped when the charge carries a timestamp — dayKey(null) would
    // silently mean "today" and re-price history on every read.
    if (c.created_at) leg.cost_day = dayKey(c.created_at);
    legs.push(leg);
  }
  return [legs, txs];
}

// ══════════════════════════════════════════════════════════════════════════
// THE resolver (reference resolve_costs :774-1020 — contract keys :988-1016)
// ══════════════════════════════════════════════════════════════════════════
export function resolveCosts(orderOrLegs, atTime = null, opts = {}) {
  const cat = opts.catalog || {};
  const rateIndex = opts.rateIndex || buildRateIndex(opts.rates || []);
  const feesCfg = opts.feeSettings || {};

  let session = {};
  let legs;
  let txs;
  let day;
  let orderRefunds = 0;
  const isOrder = orderOrLegs && !Array.isArray(orderOrLegs) && typeof orderOrLegs === 'object';
  if (isOrder) {
    session = orderOrLegs;
    [legs, txs] = buildLegs(session, opts.charges, cat);
    day = dayKey(atTime !== null && atTime !== undefined ? atTime : (session.paid_at || session.created_at));
    orderRefunds = refundsOf(session);
  } else {
    legs = (orderOrLegs || []).map((l) => ({ ...l }));
    day = dayKey(atTime);
    if (opts.transactions) {
      txs = [...opts.transactions];
      // A caller that supplies transactions but forgets a leg's tx would
      // silently bill that leg zero fees. Pin it to the first transaction.
      const fallback = txs.length ? String(txs[0].id) : 'leg:0';
      for (const leg of legs) if (!leg.tx) leg.tx = fallback;
    } else {
      // No order context: every leg is its own transaction. Stated, not
      // guessed — a caller that knows better passes transactions.
      txs = legs.map((leg, i) => {
        if (!leg.tx) leg.tx = `leg:${i}`;
        return { id: leg.tx, amount: Number(leg.revenue || 0), provider: leg.provider || 'whop' };
      });
    }
  }

  // ── the revenue base, reconciled with the fee base (INVARIANT 2) ────────
  // other_revenue = the slice of the base capture no cart line carries:
  // buyer-paid shipping/tax positive, discounts negative. Guarded on a
  // positive capture so a zero-collected session keeps its line revenue.
  let otherRevenue = 0;
  if (isOrder) {
    const baseCollected = collected(session);
    if (baseCollected > 0) {
      const cartRevenue = legs.filter((l) => l.kind === 'cart')
        .reduce((sum, l) => sum + Number(l.revenue || 0), 0);
      otherRevenue = round2(baseCollected - cartRevenue);
    }
  }

  // ── fees, per transaction ───────────────────────────────────────────────
  const txFee = new Map();
  const txRate = new Map();
  let totalFees = 0;
  for (const tx of txs) {
    const { pct, fixed } = resolveFeeRate(feesCfg, tx.provider || 'whop');
    const amount = Number(tx.amount || 0);
    const fee = amount > 0 ? round2((amount * pct) / 100 + fixed) : 0;
    txFee.set(String(tx.id), fee);
    txRate.set(String(tx.id), { pct, fixed });
    totalFees += fee;
  }
  totalFees = round2(totalFees);

  // Transaction fee → legs, pro-rata by leg revenue inside the transaction.
  // Σ per-leg fees == the transaction's fee by construction: the LAST leg
  // absorbs the rounding remainder, so no cent goes missing (INVARIANT 2).
  const byTx = new Map();
  for (const leg of legs) {
    const key = String(leg.tx);
    if (!byTx.has(key)) byTx.set(key, []);
    byTx.get(key).push(leg);
  }
  for (const [txId, group] of byTx) {
    const fee = txFee.get(txId) || 0;
    const rev = group.reduce((sum, g) => sum + Number(g.revenue || 0), 0);
    let allocated = 0;
    group.forEach((leg, i) => {
      let share;
      if (i === group.length - 1) share = round2(fee - allocated);
      else if (rev > 0) share = round2((fee * Number(leg.revenue || 0)) / rev);
      else share = round2(fee / group.length);
      allocated = round2(allocated + share);
      leg.fees = share;
    });
  }

  // ── per-leg costs ───────────────────────────────────────────────────────
  let cogsTotal = 0;
  let shipTotal = 0;
  let revenueTotal = 0;
  let known = 0;
  let missing = 0;
  let missingCogs = 0;
  let missingShip = 0;
  const missingVariants = [];

  for (const leg of legs) {
    const vid = String(leg.variant_id || '');
    const vc = cat[vid];
    const qty = parseInt(leg.quantity, 10) || 0;
    const rate = txRate.get(String(leg.tx)) || resolveFeeRate(feesCfg, 'whop');

    // PER-LEG PRICING DAY (INVARIANT 4): cost_day is stamped by
    // buildUpsellLegs; a leg without one (every cart line) prices at the
    // order's day.
    const legDay = String(leg.cost_day || '') || day;

    const [unitCogs, cogsSrc] = resolveUnitCogs({ ...(vc || {}), variant_id: vid }, rateIndex, legDay);
    const [unitShip, shipSrc] = resolveUnitShip(
      { ...(vc || {}), variant_id: vid }, rateIndex, legDay, String(leg.context || 'main'));

    const legCogs = unitCogs === null ? null : round2(qty * unitCogs);
    const legShip = unitShip === null ? null : round2(qty * unitShip);
    const revenue = Number(leg.revenue || 0);
    const legFees = Number(leg.fees || 0);

    // A variant that does not ship has a KNOWN ship cost of zero; one that
    // ships and carries no rate is UNKNOWN, and unknown withholds profit
    // (INVARIANT 1 — the rule binds ship exactly as hard as COGS).
    const ships = paysShipping({ ...(vc || {}), variant_id: vid });
    const shipKnown = unitShip !== null || !ships;

    leg.unit_cogs = unitCogs === null ? null : round4(unitCogs);
    leg.shipping = unitShip === null ? null : round4(unitShip);
    leg.cogs = legCogs;
    leg.ship_cost = legShip;
    leg.cogs_source = cogsSrc;
    leg.ship_source = shipSrc;
    leg.pays_shipping = ships;
    leg.fee_pct = rate.pct;
    leg.fee_fixed = rate.fixed;
    leg.fees = legFees;
    leg.cogs_known = legCogs !== null;
    leg.ship_known = shipKnown;
    // ONE gate for the whole leg: costed when BOTH answers exist.
    leg.cost_known = legCogs !== null && shipKnown;
    leg.net = !leg.cost_known ? null
      : round2(revenue - legCogs - (legShip || 0) - legFees);

    revenueTotal += revenue;
    // Totals accumulate every answer we DO have, independently of the miss
    // counters: known COGS + unknown ship still contributes its COGS.
    if (legCogs !== null) cogsTotal += legCogs;
    if (legShip !== null) shipTotal += legShip;
    if (legCogs === null) missingCogs += 1;
    if (!shipKnown) missingShip += 1;
    if (leg.cost_known) known += 1;
    else {
      missing += 1;
      if (vid && !missingVariants.includes(vid)) missingVariants.push(vid);
    }
  }

  const totalLegs = known + missing;
  const coverage = totalLegs ? round2((100 * known) / totalLegs) : 0;
  revenueTotal = round2(revenueTotal + otherRevenue);
  const netRevenue = round2(revenueTotal - orderRefunds); // INVARIANT 5
  cogsTotal = round2(cogsTotal);
  shipTotal = round2(shipTotal);

  // Withhold the profit entirely at zero coverage (INVARIANT 3). A funnel
  // with no costs entered must render a dash, never "100% margin" — that
  // false number is the whole reason this build exists. Partial coverage
  // still returns a number, with the miss counters beside it.
  const net = known === 0 ? null
    : round2(netRevenue - cogsTotal - shipTotal - totalFees);
  const marginPct = net === null || netRevenue <= 0 ? null
    : round2((100 * net) / netRevenue);

  return {
    day,
    legs,
    transactions: txs,
    revenue: revenueTotal,
    other_revenue: round2(otherRevenue),
    refunds: orderRefunds,
    net_revenue: netRevenue,
    cogs: cogsTotal,
    ship_cost: shipTotal,
    fees: totalFees,
    net,
    margin_pct: marginPct,
    known_legs: known,
    missing_legs: missing,
    missing_cogs_legs: missingCogs,
    missing_ship_legs: missingShip,
    missing_variants: missingVariants,
    coverage_pct: coverage,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Loaders
// ══════════════════════════════════════════════════════════════════════════
export async function loadRates() {
  await ensureFunnelCostsTables();
  return pgQuery(`
    SELECT id, scope, variant_id, cost_item_id,
           to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
           unit_cogs, ship, currency, source, batch_id, note, created_by,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM lb_cost_rates
    ORDER BY effective_from, created_at, id
  `);
}

export async function loadCatalog() {
  await ensureFunnelCostsTables();
  const rows = await pgQuery(`SELECT * FROM lb_variant_costs`);
  const cat = {};
  for (const r of rows) cat[String(r.variant_id)] = r;
  return cat;
}

export async function getFeeSettings() {
  await ensureFunnelCostsTables();
  await pgQuery(`INSERT INTO lb_fee_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const [row] = await pgQuery(`SELECT * FROM lb_fee_settings WHERE id = 1`);
  const gateways = {};
  for (const g of SEED_GATEWAYS) gateways[g] = null;
  const stored = parseJson(row.gateways, {}) || {};
  for (const [name, val] of Object.entries(stored)) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) continue;
    gateways[key] = val === null ? null : {
      pct: val.pct === null || val.pct === undefined ? null : Number(val.pct),
      fixed: val.fixed === null || val.fixed === undefined ? null : Number(val.fixed),
    };
  }
  return {
    default_pct: Number(row.default_pct),
    default_fixed: Number(row.default_fixed),
    gateways,
    updated_at: row.updated_at,
    updated_by: row.updated_by || '',
  };
}

// A workspace has a handful of payment rails, not an unbounded map.
const MAX_GATEWAYS = 32;

export async function updateFeeSettings(patch, userId = '') {
  const cur = await getFeeSettings();
  const next = { default_pct: cur.default_pct, default_fixed: cur.default_fixed, gateways: { ...cur.gateways } };
  const p = patch || {};
  if (p.default_pct !== undefined) {
    const v = moneyOrNone(p.default_pct, 'default_pct', 100);
    if (v === null) throw new CostError('bad_amount', 'default_pct cannot be null');
    next.default_pct = v;
  }
  if (p.default_fixed !== undefined) {
    const v = moneyOrNone(p.default_fixed, 'default_fixed');
    if (v === null) throw new CostError('bad_amount', 'default_fixed cannot be null');
    next.default_fixed = v;
  }
  if (p.gateways !== undefined) {
    if (!p.gateways || typeof p.gateways !== 'object' || Array.isArray(p.gateways)) {
      throw new CostError('bad_gateways', 'gateways must be an object');
    }
    for (const [name, val] of Object.entries(p.gateways)) {
      const key = String(name || '').trim().toLowerCase();
      if (!key || key.length > 32) throw new CostError('bad_gateway', 'bad gateway name');
      if (val === null) { next.gateways[key] = null; continue; } // clear → inherit
      if (typeof val !== 'object' || Array.isArray(val)) {
        throw new CostError('bad_gateway', `gateway ${key} must be null or {pct, fixed}`);
      }
      next.gateways[key] = {
        pct: moneyOrNone(val.pct, `${key}.pct`, 100),
        fixed: moneyOrNone(val.fixed, `${key}.fixed`),
      };
    }
    if (Object.keys(next.gateways).length > MAX_GATEWAYS) {
      throw new CostError('too_many_gateways', 'gateway map too large');
    }
  }
  await pgQuery(
    `UPDATE lb_fee_settings SET default_pct = $1, default_fixed = $2, gateways = $3,
       updated_at = NOW(), updated_by = $4 WHERE id = 1`,
    [next.default_pct, next.default_fixed, next.gateways, String(userId || '').slice(0, 128)]
  );
  return getFeeSettings();
}

// ══════════════════════════════════════════════════════════════════════════
// The single write door (reference append_rate :1130 / resolve_effective_from
// :1106)
// ══════════════════════════════════════════════════════════════════════════
// When a newly entered cost starts to apply:
// * an explicit day always wins — the operator said so;
// * only_from_today pins it to today;
// * otherwise the FIRST cost for a ref backdates to the variant's first sale
//   (effective_from = today on a first entry reports nothing: every
//   historical report keeps showing 100% margin);
// * a SUBSEQUENT cost defaults to today — an edit is a change from now, not
//   a retroactive restatement. Backdating one is an explicit act.
export function resolveEffectiveFrom({ explicit, onlyFromToday, hasPriorRate, firstSold, today }) {
  if (explicit) {
    if (!DAY_RE.test(explicit)) throw new CostError('bad_effective_from', 'effective_from must be YYYY-MM-DD');
    return explicit;
  }
  if (onlyFromToday || hasPriorRate) return today;
  const fs = firstSold ? dayKey(firstSold) : '';
  return fs && DAY_RE.test(fs) ? fs : EPOCH_DAY;
}

export async function appendRate({
  scope = 'variant', refId, unitCogs = null, ship = null, effectiveFrom = null,
  onlyFromToday = false, currency = 'USD', source = 'manual', batchId = '',
  note = '', createdBy = '',
}) {
  await ensureFunnelCostsTables();
  if (!SCOPES.includes(scope)) throw new CostError('bad_scope', 'scope must be variant or item');
  if (!SOURCES.includes(source)) throw new CostError('bad_source', `source must be one of ${SOURCES}`);
  const ref = cleanId(scope, refId);
  const cogs = moneyOrNone(unitCogs, 'unit_cogs');
  const shipMap = normalizeShip(ship);
  if (cogs === null && SHIP_KEYS.every((k) => shipMap[k] === null)) {
    throw new CostError('empty_rate', 'a rate must set unit_cogs or a ship value');
  }
  if (!/^[A-Za-z]{3}$/.test(String(currency || 'USD'))) {
    throw new CostError('bad_currency', 'currency must be a 3-letter code');
  }

  const col = scope === 'variant' ? 'variant_id' : 'cost_item_id';
  const [prior] = await pgQuery(
    `SELECT id FROM lb_cost_rates WHERE scope = $1 AND ${col} = $2 LIMIT 1`, [scope, ref]);
  let firstSold = null;
  if (scope === 'variant') {
    const [vc] = await pgQuery(`SELECT first_sold FROM lb_variant_costs WHERE variant_id = $1`, [ref]);
    firstSold = vc ? vc.first_sold || null : null;
  }
  const ef = resolveEffectiveFrom({
    explicit: effectiveFrom || null,
    onlyFromToday: Boolean(onlyFromToday),
    hasPriorRate: Boolean(prior),
    firstSold,
    today: dayKey(),
  });

  const [row] = await pgQuery(
    `INSERT INTO lb_cost_rates
       (scope, variant_id, cost_item_id, effective_from, unit_cogs, ship,
        currency, source, batch_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, scope, variant_id, cost_item_id,
       to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
       unit_cogs, ship, currency, source, batch_id, note, created_by, created_at`,
    [
      scope,
      scope === 'variant' ? ref : null,
      scope === 'item' ? ref : null,
      ef,
      cogs,
      shipMap,
      String(currency || 'USD').toUpperCase().slice(0, 3),
      source,
      String(batchId || '').slice(0, 64),
      String(note || '').slice(0, 500),
      String(createdBy || '').slice(0, 128),
    ]
  );
  await refreshCoverage(scope, ref);
  return row;
}

// Flip the affected variants' coverage the moment a cost lands — without
// this the grid keeps saying "needs cost" until the next sweep. 'ignored'
// is an operator decision and is never overwritten here.
export async function refreshCoverage(scope, refId) {
  const col = scope === 'variant' ? 'variant_id' : 'cost_item_id';
  const rows = await pgQuery(`SELECT * FROM lb_variant_costs WHERE ${col} = $1`, [refId]);
  if (!rows.length) return 0;
  const rateIndex = buildRateIndex(await loadRates());
  const today = dayKey();
  let flipped = 0;
  for (const vc of rows) {
    if (vc.coverage === 'ignored') continue;
    const [unit] = resolveUnitCogs(vc, rateIndex, today);
    const coverage = unit !== null ? 'ready' : 'needs_cost';
    if (coverage === vc.coverage) continue;
    await pgQuery(
      `UPDATE lb_variant_costs SET coverage = $1, updated_at = NOW() WHERE variant_id = $2`,
      [coverage, vc.variant_id]);
    flipped += 1;
  }
  return flipped;
}

export async function listRates({ variantId = null, costItemId = null, limit = 100 } = {}) {
  await ensureFunnelCostsTables();
  const where = [];
  const params = [];
  if (variantId) { params.push(cleanId('variant', variantId)); where.push(`variant_id = $${params.length}`); }
  if (costItemId) { params.push(cleanId('item', costItemId)); where.push(`cost_item_id = $${params.length}`); }
  params.push(Math.max(1, Math.min(parseInt(limit, 10) || 100, 200)));
  return pgQuery(
    `SELECT id, scope, variant_id, cost_item_id,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            unit_cogs, ship, currency, source, batch_id, note, created_by, created_at
     FROM lb_cost_rates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
}

// Newest-first history for a variant, INCLUDING its cost group's rows so
// "why is this variant's cost what it is" is answerable in one call.
export async function rateHistory(variantId, limit = 200) {
  await ensureFunnelCostsTables();
  const vid = cleanId('variant', variantId);
  const [vc] = await pgQuery(`SELECT cost_item_id FROM lb_variant_costs WHERE variant_id = $1`, [vid]);
  const itemId = vc ? String(vc.cost_item_id || '') : '';
  const params = [vid];
  let where = `(scope = 'variant' AND variant_id = $1)`;
  if (itemId) {
    params.push(itemId);
    where += ` OR (scope = 'item' AND cost_item_id = $2)`;
  }
  params.push(Math.max(1, Math.min(parseInt(limit, 10) || 200, 200)));
  return pgQuery(
    `SELECT id, scope, variant_id, cost_item_id,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            unit_cogs, ship, currency, source, batch_id, note, created_by, created_at
     FROM lb_cost_rates WHERE ${where}
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Detection sweep — SOLD only, v1 (funnel-os sweeps SOLD ∪ WIRED; the WIRED
// page-scan half is a flagged v1 gap: a variant cannot be costed before its
// first sale). Idempotent. $sets facts only, never operator columns.
// ══════════════════════════════════════════════════════════════════════════
export async function runDetectSweep({ days = 90, now = null } = {}) {
  await ensureFunnelCostsTables();
  const window = Math.max(1, Math.min(parseInt(days, 10) || 90, 400));
  const nowD = now ? new Date(now) : new Date();
  const hiDay = dayKey(nowD);
  const loDay = daysAgo(window - 1, nowD);
  const lo30 = daysAgo(29, nowD);
  const loIso = `${loDay}T00:00:00Z`;
  const lo30Iso = `${lo30}T00:00:00Z`;

  const acc = new Map();
  const get = (vid) => {
    if (!acc.has(vid)) {
      acc.set(vid, {
        variant_id: vid, product_title: '', variant_title: '', image_url: '',
        contexts: new Set(), funnels: new Set(), by_funnel: new Map(),
        units_30d: 0, revenue_30d: 0, price: null, first_sold: '', last_sold: '',
      });
    }
    return acc.get(vid);
  };
  const fun = (a, fid) => {
    if (!a.by_funnel.has(fid)) a.by_funnel.set(fid, { revenue_30d: 0, units_30d: 0 });
    return a.by_funnel.get(fid);
  };
  const sawSale = (a, { at, qty, revenue, in30, fid }) => {
    if (in30) { a.units_30d += qty; a.revenue_30d += revenue; }
    if (fid) {
      a.funnels.add(fid);
      if (in30) { const f = fun(a, fid); f.units_30d += qty; f.revenue_30d += revenue; }
    }
    if (at) {
      const d = dayKey(at);
      if (!a.first_sold || d < a.first_sold) a.first_sold = d;
      if (d > a.last_sold) a.last_sold = d;
    }
  };

  // ── 1. SOLD — cart lines of money sessions in the window ────────────────
  // Windowed on paid_at (the money day — the same clock revenue_30d means).
  const sessions = await pgQuery(
    `SELECT s.id, s.funnel_id, s.line_items, s.paid_at
     FROM co_sessions s
     WHERE ${MONEY_MOVED_SQL} AND s.paid_at >= $1`,
    [loIso]
  );
  for (const s of sessions) {
    const paidIso = s.paid_at ? new Date(s.paid_at).toISOString() : '';
    const in30 = Boolean(paidIso) && paidIso >= lo30Iso;
    const fid = String(s.funnel_id || '');
    const lines = Array.isArray(s.line_items) ? s.line_items : parseJson(s.line_items, []);
    for (const li of Array.isArray(lines) ? lines : []) {
      if (!li || typeof li !== 'object') continue;
      const vid = String(li.variant_id || '').trim();
      if (!vid) continue;
      const a = get(vid);
      let qty = parseInt(li.quantity, 10);
      if (Number.isNaN(qty)) qty = 1;
      qty = Math.max(qty, 0);
      const price = Number(li.price || 0);
      const ctx = li.is_bump ? 'bump' : 'main';
      sawSale(a, { at: paidIso, qty, revenue: qty * price, in30, fid });
      a.contexts.add(ctx);
      if (!a.product_title && li.product_title) a.product_title = String(li.product_title).slice(0, 200);
      if (!a.variant_title && (li.variant_title || li.title)) a.variant_title = String(li.variant_title || li.title).slice(0, 200);
      if (!a.image_url && li.image) a.image_url = String(li.image).slice(0, 600);
      if (price > 0) a.price = price;
    }
  }

  // ── 2. SOLD — settled upsell legs (funnel via the parent session) ───────
  const charges = await pgQuery(
    `SELECT c.id, c.amount, c.line_items, c.created_at, s.funnel_id
     FROM co_upsell_charges c
     JOIN co_sessions s ON s.id = c.session_id
     WHERE c.status = ANY($1) AND c.created_at >= $2`,
    [COLLECTED_UPSELL, loIso]
  );
  for (const c of charges) {
    const amount = Number(c.amount || 0);
    if (amount <= 0) continue; // the $0 decline marker row
    const lines = Array.isArray(c.line_items) ? c.line_items : parseJson(c.line_items, []);
    const li = Array.isArray(lines) && lines.length && lines[0] && typeof lines[0] === 'object' ? lines[0] : {};
    const vid = String(li.variant_id || '').trim();
    if (!vid) continue;
    const a = get(vid);
    let qty = parseInt(li.quantity, 10);
    if (Number.isNaN(qty)) qty = 1;
    qty = Math.max(qty, 1);
    const atIso = c.created_at ? new Date(c.created_at).toISOString() : '';
    sawSale(a, {
      at: atIso, qty, revenue: amount,
      in30: Boolean(atIso) && atIso >= lo30Iso,
      fid: String(c.funnel_id || ''),
    });
    a.contexts.add('upsell');
    if (!a.product_title && li.product_title) a.product_title = String(li.product_title).slice(0, 200);
    if (!a.variant_title && li.title) a.variant_title = String(li.title).slice(0, 200);
    if (li.unit_price) a.price = Number(li.unit_price);
  }

  // ── 3. Upsert — observed facts $set; operator columns untouched ─────────
  const existing = await pgQuery(`SELECT variant_id, coverage, cost_item_id, units_per, first_sold FROM lb_variant_costs`);
  const existingBy = new Map(existing.map((r) => [String(r.variant_id), r]));
  const rateIndex = buildRateIndex(await loadRates());
  const today = dayKey(nowD);

  let inserted = 0;
  let updated = 0;
  for (const a of acc.values()) {
    const prev = existingBy.get(a.variant_id);
    const [unit] = resolveUnitCogs(
      { variant_id: a.variant_id, cost_item_id: prev ? prev.cost_item_id : null, units_per: prev ? prev.units_per : 1 },
      rateIndex, today);
    // 'ignored' is an operator decision — never reset by the sweep.
    const coverage = prev && prev.coverage === 'ignored' ? 'ignored'
      : (unit !== null ? 'ready' : 'needs_cost');
    let firstSold = a.first_sold;
    const prevFirst = prev ? String(prev.first_sold || '') : '';
    if (prevFirst && (!firstSold || prevFirst < firstSold)) firstSold = prevFirst;

    const byFunnel = {};
    for (const [fid, f] of [...a.by_funnel.entries()].sort()) {
      byFunnel[fid] = { revenue_30d: round2(f.revenue_30d), units_30d: f.units_30d };
    }
    const kindAuto = [...a.contexts].join(',') === 'upsell' ? 'upsell' : 'main';

    await pgQuery(
      `INSERT INTO lb_variant_costs
         (variant_id, product_title, variant_title, image_url, contexts, funnels,
          by_funnel, revenue_30d, units_30d, price, first_sold, last_sold,
          kind_auto, coverage, detected_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
       ON CONFLICT (variant_id) DO UPDATE SET
         product_title = CASE WHEN EXCLUDED.product_title <> '' THEN EXCLUDED.product_title ELSE lb_variant_costs.product_title END,
         variant_title = CASE WHEN EXCLUDED.variant_title <> '' THEN EXCLUDED.variant_title ELSE lb_variant_costs.variant_title END,
         image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE lb_variant_costs.image_url END,
         contexts = EXCLUDED.contexts,
         funnels = EXCLUDED.funnels,
         by_funnel = EXCLUDED.by_funnel,
         revenue_30d = EXCLUDED.revenue_30d,
         units_30d = EXCLUDED.units_30d,
         price = COALESCE(EXCLUDED.price, lb_variant_costs.price),
         first_sold = EXCLUDED.first_sold,
         last_sold = GREATEST(EXCLUDED.last_sold, lb_variant_costs.last_sold),
         kind_auto = EXCLUDED.kind_auto,
         coverage = EXCLUDED.coverage,
         updated_at = NOW()`,
      [
        a.variant_id,
        a.product_title, a.variant_title, a.image_url,
        [...a.contexts].sort(), [...a.funnels].sort(), byFunnel,
        round2(a.revenue_30d), a.units_30d, a.price,
        firstSold, a.last_sold, kindAuto, coverage,
      ]
    );
    if (prev) updated += 1; else inserted += 1;
  }

  // Variants that fell out of the window would keep frozen 30d money forever
  // — and coverage_summary sums revenue_30d over needs_cost rows, so a stale
  // row makes revenue_at_risk_30d drift upward as the catalog ages. Zero the
  // counters; keep first/last_sold and every operator-owned field.
  let staleZeroed = 0;
  if (acc.size) {
    const seen = [...acc.keys()];
    const res = await pgQuery(
      `UPDATE lb_variant_costs
       SET units_30d = 0, revenue_30d = 0, by_funnel = '{}', updated_at = NOW()
       WHERE NOT (variant_id = ANY($1)) AND (units_30d <> 0 OR revenue_30d <> 0)
       RETURNING variant_id`,
      [seen]
    );
    staleZeroed = res.length;
  }

  return {
    window_days: window,
    start_day: loDay,
    end_day: hiDay,
    sessions_scanned: sessions.length,
    charges_scanned: charges.length,
    variants: acc.size,
    inserted,
    updated,
    stale_zeroed: staleZeroed,
    ran_at: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Read surfaces
// ══════════════════════════════════════════════════════════════════════════
// Counts + the money currently booked at 100% margin. revenue_at_risk_30d is
// the whole point: the trailing 30d revenue of every variant that still has
// no cost — exactly how much of the P&L is a lie today. coverage_pct
// EXCLUDES ignored rows from the denominator (an ignored variant is off the
// worklist; counting it would mean the number could never reach 100%).
export async function coverageSummary() {
  await ensureFunnelCostsTables();
  const rows = await pgQuery(`
    SELECT coverage, COUNT(*)::int AS n,
           COALESCE(SUM(revenue_30d) FILTER (WHERE coverage = 'needs_cost'), 0) AS at_risk,
           COALESCE(SUM(units_30d) FILTER (WHERE coverage = 'needs_cost'), 0)::int AS units_at_risk
    FROM lb_variant_costs GROUP BY coverage
  `);
  const counts = { needs_cost: 0, ready: 0, ignored: 0 };
  let atRisk = 0;
  let unitsAtRisk = 0;
  for (const r of rows) {
    if (counts[r.coverage] !== undefined) counts[r.coverage] = Number(r.n);
    atRisk += Number(r.at_risk || 0);
    unitsAtRisk += Number(r.units_at_risk || 0);
  }
  const total = counts.needs_cost + counts.ready + counts.ignored;
  const live = total - counts.ignored;
  return {
    total,
    needs_cost: counts.needs_cost,
    ready: counts.ready,
    ignored: counts.ignored,
    coverage_pct: live ? round2((100 * counts.ready) / live) : 0,
    revenue_at_risk_30d: round2(atRisk),
    units_at_risk_30d: unitsAtRisk,
  };
}

// The Variants grid. Sorted by 30d revenue desc — the operator's worklist is
// "what is costing me the most to not know", not alphabetical. Each row
// carries its resolved-for-today COGS/ship so the grid never re-derives.
export async function listVariants({ coverage = null, context = null, funnelId = null, q = null, limit = 200, offset = 0 } = {}) {
  await ensureFunnelCostsTables();
  if (coverage && !COVERAGE_STATES.includes(coverage)) {
    throw new CostError('bad_coverage', `coverage must be one of ${COVERAGE_STATES}`);
  }
  if (context && !CONTEXTS.includes(context)) {
    throw new CostError('bad_context', `context must be one of ${CONTEXTS}`);
  }
  const where = [];
  const params = [];
  // NOTE: jsonb containment params must be the RAW JS array — postgres.js
  // serializes it to a jsonb array; a pre-stringified value double-encodes
  // into a jsonb STRING and matches nothing (caught by the routes harness).
  if (coverage) { params.push(coverage); where.push(`coverage = $${params.length}`); }
  if (context) { params.push([context]); where.push(`contexts @> $${params.length}`); }
  if (funnelId) { params.push([String(funnelId).slice(0, 64)]); where.push(`funnels @> $${params.length}`); }
  if (q) {
    params.push(`%${String(q).trim().slice(0, 100)}%`);
    where.push(`(product_title ILIKE $${params.length} OR variant_title ILIKE $${params.length} OR variant_id ILIKE $${params.length})`);
  }
  const rows = await pgQuery(
    `SELECT * FROM lb_variant_costs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY revenue_30d DESC, units_30d DESC, variant_id`,
    params
  );
  const total = rows.length;
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));
  const page = rows.slice(off, off + lim);

  const rateIndex = buildRateIndex(await loadRates());
  const today = dayKey();
  const items = page.map((vc) => {
    const [unitCogs, cogsSrc] = resolveUnitCogs(vc, rateIndex, today);
    const ship = {};
    let shipSrc = null;
    for (const ctx of CONTEXTS) {
      const [val, src] = resolveUnitShip(vc, rateIndex, today, ctx);
      ship[ctx] = val;
      if (src && !shipSrc) shipSrc = src;
    }
    return {
      ...vc,
      resolved: {
        day: today,
        unit_cogs: unitCogs,
        cogs_source: cogsSrc,
        ship,
        ship_source: shipSrc,
        pays_shipping: paysShipping(vc),
        kind: resolveKind(vc),
      },
    };
  });
  return { items, total, limit: lim, offset: off };
}

// Funnel → variants view, credited from by_funnel (a funnel only ever shows
// the money ITS OWN sessions produced — never the variant's cross-funnel
// total, which is the double-count the split exists to prevent).
export async function listByFunnel() {
  await ensureFunnelCostsTables();
  const rows = await pgQuery(`SELECT * FROM lb_variant_costs ORDER BY revenue_30d DESC, variant_id`);
  const rateIndex = buildRateIndex(await loadRates());
  const today = dayKey();
  const byFid = new Map();
  for (const vc of rows) {
    const split = parseJson(vc.by_funnel, {}) || {};
    const [unitCogs, cogsSrc] = resolveUnitCogs(vc, rateIndex, today);
    for (const [fid, f] of Object.entries(split)) {
      if (!byFid.has(fid)) byFid.set(fid, { funnel_id: fid, revenue_30d: 0, units_30d: 0, variants: [] });
      const g = byFid.get(fid);
      const rev = round2(Number((f || {}).revenue_30d || 0));
      const units = Number((f || {}).units_30d || 0);
      g.revenue_30d = round2(g.revenue_30d + rev);
      g.units_30d += units;
      g.variants.push({
        variant_id: vc.variant_id,
        product_title: vc.product_title,
        variant_title: vc.variant_title,
        image_url: vc.image_url,
        coverage: vc.coverage,
        revenue_30d: rev,
        units_30d: units,
        funnel_count: (parseJson(vc.funnels, []) || []).length,
        unit_cogs: unitCogs,
        cogs_source: cogsSrc,
      });
    }
  }
  const funnels = [...byFid.values()].sort((a, b) => b.revenue_30d - a.revenue_30d);
  // Names are additive; the funnels table belongs to another lane and may
  // not exist on a fresh DB — probe first, explicitly, instead of letting an
  // optional label lookup take the whole read down.
  const names = await funnelNames(funnels.map((f) => f.funnel_id));
  for (const f of funnels) f.name = names.get(f.funnel_id) || f.funnel_id;
  return { funnels };
}

async function funnelNames(fids) {
  const out = new Map();
  if (!fids.length) return out;
  const [reg] = await pgQuery(`SELECT to_regclass('public.funnels') AS t`);
  if (!reg || !reg.t) return out;
  const rows = await pgQuery(`SELECT id, name FROM funnels WHERE id = ANY($1)`, [fids]);
  for (const r of rows) out.set(String(r.id), r.name || String(r.id));
  return out;
}

// Operator fields ONLY — the sweep owns the facts.
export async function patchVariant(variantId, patch) {
  await ensureFunnelCostsTables();
  const vid = String(variantId || '').trim();
  if (!vid) throw new CostError('bad_variant_id', 'variant_id required');
  const [vc] = await pgQuery(`SELECT * FROM lb_variant_costs WHERE variant_id = $1`, [vid]);
  if (!vc) throw new CostError('variant_not_found', 'no such variant');
  const p = patch || {};
  const sets = [];
  const params = [];
  if (p.pays_shipping !== undefined) {
    if (typeof p.pays_shipping !== 'boolean') throw new CostError('bad_pays_shipping', 'pays_shipping must be boolean');
    params.push(p.pays_shipping);
    sets.push(`pays_shipping = $${params.length}`);
  }
  if (p.kind_override !== undefined) {
    if (p.kind_override !== null && !CONTEXTS.includes(p.kind_override)) {
      throw new CostError('bad_kind_override', `kind_override must be null or one of ${CONTEXTS}`);
    }
    params.push(p.kind_override);
    sets.push(`kind_override = $${params.length}`);
  }
  if (p.ignored !== undefined) {
    if (typeof p.ignored !== 'boolean') throw new CostError('bad_ignored', 'ignored must be boolean');
    if (p.ignored) {
      params.push('ignored');
      sets.push(`coverage = $${params.length}`);
    } else {
      // un-ignore → recompute from the ledger, never guess
      const rateIndex = buildRateIndex(await loadRates());
      const [unit] = resolveUnitCogs(vc, rateIndex, dayKey());
      params.push(unit !== null ? 'ready' : 'needs_cost');
      sets.push(`coverage = $${params.length}`);
    }
  }
  if (!sets.length) throw new CostError('empty_patch', 'nothing to update');
  params.push(vid);
  const [row] = await pgQuery(
    `UPDATE lb_variant_costs SET ${sets.join(', ')}, updated_at = NOW()
     WHERE variant_id = $${params.length} RETURNING *`,
    params
  );
  return row;
}

// ══════════════════════════════════════════════════════════════════════════
// P&L — computed ON-READ (no rollup tables). Effective-dated rates give
// historically correct costs without touching the money path.
// ══════════════════════════════════════════════════════════════════════════
function validateDay(v, name) {
  const d = String(v || '');
  // Shape AND calendar: '2026-13-01' matches the regex but is not a day —
  // the UTC round-trip refuses it (getTime NaN-guard first: an invalid Date
  // would make toISOString throw a RangeError, not a CostError).
  const t = DAY_RE.test(d) ? new Date(`${d}T00:00:00Z`).getTime() : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) {
    throw new CostError('bad_day', `${name} must be a real YYYY-MM-DD day`);
  }
  return d;
}

const nextDayIso = (day) => `${daysAgo(-1, `${day}T00:00:00Z`)}T00:00:00Z`;

async function loadMoneyWindow(start, end, fid = null) {
  const params = [`${start}T00:00:00Z`, nextDayIso(end)];
  let fidSql = '';
  if (fid) {
    params.push(fid);
    fidSql = ` AND s.funnel_id = $3`;
  }
  const sessions = await pgQuery(
    `SELECT s.id, s.funnel_id, s.gateway, s.line_items, s.total, s.refunds, s.paid_at
     FROM co_sessions s
     WHERE ${MONEY_MOVED_SQL} AND s.paid_at >= $1 AND s.paid_at < $2${fidSql}`,
    params
  );
  let charges = [];
  if (sessions.length) {
    charges = await pgQuery(
      `SELECT c.id, c.session_id, c.amount, c.status, c.line_items, c.created_at
       FROM co_upsell_charges c
       WHERE c.session_id = ANY($1) AND c.status = ANY($2)`,
      [sessions.map((s) => s.id), COLLECTED_UPSELL]
    );
  }
  const chargesBySession = new Map();
  for (const c of charges) {
    const key = String(c.session_id);
    if (!chargesBySession.has(key)) chargesBySession.set(key, []);
    chargesBySession.get(key).push(c);
  }
  return { sessions, chargesBySession };
}

function foldOrder(bucket, r) {
  bucket.orders += 1;
  bucket.gross_sales = round2(bucket.gross_sales + r.revenue);
  bucket.revenue = round2(bucket.revenue + r.net_revenue);
  bucket.refunds = round2(bucket.refunds + r.refunds);
  bucket.cogs = round2(bucket.cogs + r.cogs);
  bucket.ship_cost = round2(bucket.ship_cost + r.ship_cost);
  bucket.fees = round2(bucket.fees + r.fees);
  bucket.known_legs += r.known_legs;
  bucket.missing_legs += r.missing_legs;
}

const newBucket = () => ({
  orders: 0, gross_sales: 0, revenue: 0, refunds: 0, cogs: 0, ship_cost: 0,
  fees: 0, known_legs: 0, missing_legs: 0,
});

// gp = net_revenue − cogs − ship_cost − fees, WITHHELD (null) at zero
// coverage (INVARIANTS 3 + 6). Partial coverage returns a number with
// cost_coverage_pct beside it saying how much is still guesswork.
function finishBucket(b) {
  const totalLegs = b.known_legs + b.missing_legs;
  const coverage = totalLegs ? round2((100 * b.known_legs) / totalLegs) : 0;
  const gp = b.known_legs === 0 ? null
    : round2(b.revenue - b.cogs - b.ship_cost - b.fees);
  const gpMargin = gp === null || b.revenue <= 0 ? null : round2((100 * gp) / b.revenue);
  return { ...b, cost_coverage_pct: coverage, gp, gp_margin: gpMargin };
}

// net_profit = gp − spend ONLY when spend is KNOWN (INVARIANT 6). A zero
// there would read as "no ad spend", which is the opposite of the truth.
function spendBlock(bucket, spendMap, known) {
  const spend = known ? round2(Object.values(spendMap || {}).reduce((s, v) => s + Number(v || 0), 0)) : null;
  const netProfit = known && bucket.gp !== null ? round2(bucket.gp - spend) : null;
  return {
    spend,
    spend_known: Boolean(known),
    net_profit: netProfit,
    roas: known && spend > 0 ? round2(bucket.revenue / spend) : null,
    cpa: known && bucket.orders > 0 ? round2(spend / bucket.orders) : null,
  };
}

export async function pnlOverview(start, end) {
  const s = validateDay(start, 'start');
  const e = validateDay(end, 'end');
  if (s > e) throw new CostError('bad_range', 'start must be <= end');
  const { sessions, chargesBySession } = await loadMoneyWindow(s, e);
  const catalog = await loadCatalog();
  const rateIndex = buildRateIndex(await loadRates());
  const feeSettings = await getFeeSettings();

  const byFid = new Map();
  for (const sess of sessions) {
    const fid = String(sess.funnel_id || '');
    if (!byFid.has(fid)) byFid.set(fid, newBucket());
    const r = resolveCosts(sess, sess.paid_at, {
      catalog, rateIndex, feeSettings,
      charges: chargesBySession.get(String(sess.id)) || [],
    });
    foldOrder(byFid.get(fid), r);
  }

  const fids = [...byFid.keys()].filter(Boolean);
  const spend = await funnelSpendByDay(fids, s, e);
  const names = await funnelNames(fids);

  const rows = [];
  const totalBucket = newBucket();
  let totalSpend = 0;
  let totalSpendKnown = fids.length > 0;
  for (const [fid, bucket] of byFid) {
    const fin = finishBucket(bucket);
    const known = spend.known[fid] || false;
    const block = spendBlock(fin, spend.days[fid], known);
    rows.push({
      fid,
      name: names.get(fid) || fid,
      revenue: fin.revenue,
      gross_sales: fin.gross_sales,
      orders: fin.orders,
      refunds: fin.refunds,
      cogs: fin.cogs,
      fees: fin.fees,
      ship_cost: fin.ship_cost,
      gp: fin.gp,
      gp_margin: fin.gp_margin,
      cost_coverage_pct: fin.cost_coverage_pct,
      ...block,
    });
    totalBucket.orders += bucket.orders;
    totalBucket.gross_sales = round2(totalBucket.gross_sales + bucket.gross_sales);
    totalBucket.revenue = round2(totalBucket.revenue + bucket.revenue);
    totalBucket.refunds = round2(totalBucket.refunds + bucket.refunds);
    totalBucket.cogs = round2(totalBucket.cogs + bucket.cogs);
    totalBucket.ship_cost = round2(totalBucket.ship_cost + bucket.ship_cost);
    totalBucket.fees = round2(totalBucket.fees + bucket.fees);
    totalBucket.known_legs += bucket.known_legs;
    totalBucket.missing_legs += bucket.missing_legs;
    if (block.spend_known) totalSpend = round2(totalSpend + block.spend);
    else totalSpendKnown = false;
  }
  // Sorted by REVENUE, not gp: gp is null on any uncosted funnel, and
  // sorting on a null would bury exactly the funnels the operator most
  // needs to see.
  rows.sort((a, b) => b.revenue - a.revenue);

  const finTotals = finishBucket(totalBucket);
  const totals = {
    revenue: finTotals.revenue,
    gross_sales: finTotals.gross_sales,
    orders: finTotals.orders,
    refunds: finTotals.refunds,
    cogs: finTotals.cogs,
    fees: finTotals.fees,
    ship_cost: finTotals.ship_cost,
    gp: finTotals.gp,
    gp_margin: finTotals.gp_margin,
    cost_coverage_pct: finTotals.cost_coverage_pct,
    spend: totalSpendKnown ? totalSpend : null,
    spend_known: totalSpendKnown,
    net_profit: totalSpendKnown && finTotals.gp !== null ? round2(finTotals.gp - totalSpend) : null,
    roas: totalSpendKnown && totalSpend > 0 ? round2(finTotals.revenue / totalSpend) : null,
    cpa: totalSpendKnown && finTotals.orders > 0 ? round2(totalSpend / finTotals.orders) : null,
  };
  return { start: s, end: e, rows, totals };
}

export async function pnlFunnel(fid, start, end) {
  const s = validateDay(start, 'start');
  const e = validateDay(end, 'end');
  if (s > e) throw new CostError('bad_range', 'start must be <= end');
  const funnelId = String(fid || '').trim();
  if (!funnelId) throw new CostError('bad_funnel_id', 'funnel id required');

  const { sessions, chargesBySession } = await loadMoneyWindow(s, e, funnelId);
  const catalog = await loadCatalog();
  const rateIndex = buildRateIndex(await loadRates());
  const feeSettings = await getFeeSettings();

  const totalsBucket = newBucket();
  const byDay = new Map();
  for (const sess of sessions) {
    const r = resolveCosts(sess, sess.paid_at, {
      catalog, rateIndex, feeSettings,
      charges: chargesBySession.get(String(sess.id)) || [],
    });
    foldOrder(totalsBucket, r);
    const day = dayKey(sess.paid_at);
    if (!byDay.has(day)) byDay.set(day, newBucket());
    foldOrder(byDay.get(day), r);
  }

  const spend = await funnelSpendByDay([funnelId], s, e);
  const spendDays = spend.days[funnelId] || {};
  const spendKnown = spend.known[funnelId] || false;

  const daily = [...byDay.keys()].sort().map((day) => {
    const fin = finishBucket(byDay.get(day));
    const daySpend = spendKnown ? round2(Number(spendDays[day] || 0)) : null;
    return {
      day,
      orders: fin.orders,
      revenue: fin.revenue,
      cogs: fin.cogs,
      fees: fin.fees,
      ship_cost: fin.ship_cost,
      gp: fin.gp,
      cost_coverage_pct: fin.cost_coverage_pct,
      spend: daySpend,
      net_profit: fin.gp !== null && daySpend !== null ? round2(fin.gp - daySpend) : null,
    };
  });

  const fin = finishBucket(totalsBucket);
  const block = spendBlock(fin, spendDays, spendKnown);

  // Campaign rows: derived bindings over the window + pins, each with its
  // window spend, so the operator can see WHY the funnel's spend is what it
  // is and pin/unpin from the same screen.
  const bindings = await deriveCampaignBindings(s, e);
  const pins = await pgQuery(`SELECT campaign_id, funnel_id FROM lb_campaign_map`);
  const pinByCid = new Map(pins.map((p) => [String(p.campaign_id), String(p.funnel_id)]));
  const cids = new Set();
  for (const [cid, b] of Object.entries(bindings)) {
    if (b.fid === funnelId && pinByCid.get(cid) === undefined) cids.add(cid);
  }
  for (const [cid, pfid] of pinByCid) if (pfid === funnelId) cids.add(cid);
  let campaigns = [];
  if (cids.size) {
    const spendRows = await pgQuery(
      `SELECT ref_id, campaign_name, SUM(spend) AS spend, MAX(day) AS last_day
       FROM lb_ad_spend_daily
       WHERE source = 'meta' AND ref_id = ANY($1) AND day >= $2 AND day <= $3
       GROUP BY ref_id, campaign_name`,
      [[...cids], s, e]
    );
    const nameByCid = new Map();
    const spendByCid = new Map();
    for (const r of spendRows) {
      const cid = String(r.ref_id);
      spendByCid.set(cid, round2(Number(spendByCid.get(cid) || 0) + Number(r.spend || 0)));
      if (r.campaign_name) nameByCid.set(cid, r.campaign_name);
    }
    campaigns = [...cids].map((cid) => ({
      campaign_id: cid,
      name: nameByCid.get(cid) || '',
      spend: round2(Number(spendByCid.get(cid) || 0)),
      pinned: pinByCid.get(cid) === funnelId,
      derived: Boolean(bindings[cid] && bindings[cid].fid === funnelId),
      split: Boolean(bindings[cid] && bindings[cid].split),
      sessions: bindings[cid] ? bindings[cid].sessions : 0,
    })).sort((a, b) => b.spend - a.spend);
  }

  const manual = await pgQuery(
    `SELECT day, spend, note, updated_by, synced_at
     FROM lb_ad_spend_daily
     WHERE source = 'manual' AND ref_id = $1 AND day >= $2 AND day <= $3
     ORDER BY day DESC`,
    [funnelId, s, e]
  );

  const names = await funnelNames([funnelId]);
  return {
    fid: funnelId,
    name: names.get(funnelId) || funnelId,
    start: s,
    end: e,
    totals: {
      revenue: fin.revenue,
      gross_sales: fin.gross_sales,
      orders: fin.orders,
      refunds: fin.refunds,
      cogs: fin.cogs,
      fees: fin.fees,
      ship_cost: fin.ship_cost,
      gp: fin.gp,
      gp_margin: fin.gp_margin,
      cost_coverage_pct: fin.cost_coverage_pct,
      ...block,
    },
    daily,
    campaigns,
    manual_entries: manual.map((m) => ({
      day: m.day, spend: round2(Number(m.spend || 0)), note: m.note || '',
      updated_by: m.updated_by || '', updated_at: m.synced_at,
    })),
    meta_configured: metaConfigured(),
  };
}

export default {
  ensureFunnelCostsTables,
};
