// COST GROUPS — several Shopify variants sharing ONE cost item, plus the
// membership ledger that decides which variants that rate reached on any
// given day.
//
// Port of funnel-os lb_cost_group_service.py / lb_cost_groups_service.py
// (CRUD + membership), mapped onto the cost catalog this repo already owns.
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE ADDS NO SECOND ENGINE
// ══════════════════════════════════════════════════════════════════════════
// The P&L engine already resolves group rates. funnelCosts.resolveUnitCogs
// looks up scope='item' in the same bisected index it uses for variant rates;
// resolveUnitShip does the same for the ship map. What was missing was the
// group ENTITY, the membership ledger, and the UI to bind members.
//
// ── RESOLUTION ORDER (the contract this file must not break) ──────────────
//   1. an explicit per-VARIANT rate for that day        → wins outright
//   2. else the variant's GROUP rate for that day       → × units_per
//   3. else UNKNOWN (null) — never 0, profit is withheld
//
// BOTH INPUTS ARE EFFECTIVE-DATED. A member's COGS is the group rate ×
// units_per, so membership and units_per are as much a part of the price as
// the rate itself. They live in lb_cost_item_members, append-only, and the
// engine resolves them AS OF THE DAY BEING PRICED. That is what stops a pack
// size corrected today from restating last quarter, and what lets a deleted
// group keep pricing the days it was real. lb_variant_costs.cost_item_id /
// units_per are kept in step as the CURRENT view, for the UI and the grid's
// filters — they are never the authority for a past day.
//
// Step 2's `× units_per` is why membership carries it: COGS is per unit OF
// THE VARIANT, so a "3 Pack" bound to a single-bottle group costs 3 × the
// group rate. Shipping is deliberately NOT multiplied (a 3-pack ships in one
// box) — that asymmetry lives in funnelCosts.resolveUnitShip.
//
// A member with its own variant-scope rate is SHADOWED: the group rate is
// stored and its history is real, but the member's resolved cost does not
// move until that variant rate is superseded. The read surfaces below label
// those rows rather than hiding them.
//
// MONEY DISCIPLINE. This file writes NO rates. Every cost still goes through
// funnelCosts.appendRate — the one append-only, effective-dated write door.
// Nothing here is destructive: an unbind APPENDS a tombstone, a deleted group
// is ARCHIVED, and rate rows are never dropped.
//
// ATOMICITY. Every multi-statement write runs inside ONE transaction. A bind
// touches the catalog row AND the membership ledger; a half-applied bind
// leaves the current view and the priced history disagreeing, which is a
// wrong margin that no later write corrects.
//
// LET IT THROW: no error is swallowed. Bad input raises CostError (the route
// maps .code to a 4xx); infra failures propagate to the route's 500.
import { pgQuery, pgDb } from '../db/pg.js';
import { ensureFunnelCostsTables } from './funnelCostsSchema.js';
import {
  CostError, loadCostIndex, resolveUnitCogs, resolveUnitShip,
  dayKey, round2, refreshCoverage, SHIP_KEYS,
} from './funnelCosts.js';

const ITEM_RE = /^ci_[0-9a-z_-]{2,64}$/i;
const VARIANT_RE = /^[0-9]{6,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A group of one is not a group, and a workspace does not have thousand-member
// cost items — both bounds keep a fat-fingered payload from becoming a
// catalog-wide rebind.
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 200;
const MAX_NAME = 120;
const MAX_NOTE = 500;
// A variant cannot plausibly contain more than this many units of the group's
// good; beyond it the "pack size" almost certainly parsed a year or a SKU.
export const MAX_UNITS_PER = 500;
// Earlier than any order this business has ever taken — the floor for a
// backdated first membership whose variant has no recorded first sale.
const EPOCH_DAY = '2000-01-01';

/**
 * One transaction, one query signature. postgres.js commits when the callback
 * resolves and rolls back when it throws, so a CostError raised mid-way
 * (a steal without consent, a group that would end up with one member) undoes
 * every statement before it.
 */
export async function withTx(fn) {
  return pgDb.begin((tx) => fn((text, params = []) => tx.unsafe(text, params)));
}

export function cleanItemId(id) {
  const v = String(id || '').trim();
  if (!ITEM_RE.test(v)) throw new CostError('bad_cost_item_id', 'cost_item_id must look like ci_…');
  return v;
}

function cleanVariantId(id) {
  const v = String(id || '').trim();
  if (!VARIANT_RE.test(v)) throw new CostError('bad_variant_id', 'variant_id must be numeric');
  return v;
}

// Group ids are opaque and operator-visible; a short random suffix keeps them
// unguessable-enough and collision-free without a sequence round-trip.
export function newCostItemId() {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `ci_${Date.now().toString(36)}${rand}`.slice(0, 64).toLowerCase();
}

const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === 'string') return JSON.parse(v); // let a corrupt row THROW
  return v;
};

/**
 * A limit is either absent (use the default) or a real positive integer.
 * `parseInt(x, 10) || fallback` silently turns 0, '', 'abc' and NaN into the
 * default — so `?limit=0` quietly returns a full page, which is the opposite
 * of what it asked for.
 */
export function validateLimit(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' ? (/^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN) : Number(raw);
  if (Number.isNaN(n) || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new CostError('bad_limit', 'limit must be a whole number of 1 or more');
  }
  return Math.min(n, max);
}

function cleanName(raw, { required = false } = {}) {
  const name = String(raw ?? '').trim().slice(0, MAX_NAME);
  if (!name && required) throw new CostError('name_required', 'a cost group needs a name');
  return name;
}

/**
 * units_per is a COUNT, not money: a positive integer in CANONICAL form.
 *
 * `Number()` happily reads '0x18', '1e3' and ' 24 ' as numbers, and each of
 * those is a pack size nobody typed — a hex string that becomes 24 is a
 * silent 24x on a member's COGS. A string input must therefore look exactly
 * like the integer it claims to be.
 */
export function cleanUnitsPer(raw) {
  if (raw === null || raw === undefined || raw === '') return 1;
  if (typeof raw === 'boolean') throw new CostError('bad_units_per', 'units_per must be a whole number');
  if (typeof raw === 'string') {
    if (!/^[0-9]{1,6}$/.test(raw.trim())) {
      throw new CostError('bad_units_per', 'units_per must be a plain whole number');
    }
    raw = Number(raw.trim());
  }
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CostError('bad_units_per', 'units_per must be a whole number');
  }
  if (n < 1) throw new CostError('bad_units_per', 'units_per must be >= 1');
  if (n > MAX_UNITS_PER) throw new CostError('bad_units_per', `units_per must be <= ${MAX_UNITS_PER}`);
  return n;
}

// Members arrive either as bare ids or as {variant_id, units_per} objects.
// Deduped on variant_id, LAST wins — a payload that names the same variant
// twice with different pack sizes is ambiguous, and silently keeping the
// first would bind a cost multiplier the operator did not see.
export function normalizeMembers(raw) {
  if (!Array.isArray(raw)) throw new CostError('bad_members', 'members must be an array');
  const out = new Map();
  for (const m of raw) {
    if (m === null || m === undefined) throw new CostError('bad_members', 'members cannot contain blanks');
    const isObj = typeof m === 'object' && !Array.isArray(m);
    const vid = cleanVariantId(isObj ? m.variant_id : m);
    out.set(vid, { variant_id: vid, units_per: cleanUnitsPer(isObj ? m.units_per : 1) });
  }
  if (out.size > MAX_MEMBERS) throw new CostError('too_many_members', `a group holds at most ${MAX_MEMBERS} variants`);
  return [...out.values()];
}

/**
 * When a membership change starts to apply — the same shape as
 * funnelCosts.resolveEffectiveFrom, and for the same reason.
 *
 * * an explicit day always wins — the operator said so;
 * * the FIRST membership for a variant backdates to its first sale, so
 *   grouping a variant today also costs the days it was already selling
 *   (starting today would leave every historical report at 100% margin);
 * * a SUBSEQUENT change defaults to today — correcting a pack size is a
 *   change from now, NOT a retroactive restatement of closed periods.
 */
export function resolveMembershipFrom({ explicit, hasPrior, firstSold, today }) {
  if (explicit) {
    if (!DAY_RE.test(explicit)) throw new CostError('bad_effective_from', 'effective_from must be YYYY-MM-DD');
    return explicit;
  }
  if (hasPrior) return today;
  const fs = firstSold ? dayKey(firstSold) : '';
  return fs && DAY_RE.test(fs) ? fs : EPOCH_DAY;
}

// ══════════════════════════════════════════════════════════════════════════
// Reads
// ══════════════════════════════════════════════════════════════════════════

// One group's member rows, each carrying what the operator has to see before
// touching a rate: the resolved-for-today cost, WHICH layer answered it, and
// whether a variant rate is shadowing the group.
function memberRow(vc, rateIndex, today) {
  const [unitCogs, cogsSrc] = resolveUnitCogs(vc, rateIndex, today);
  const ship = {};
  for (const key of SHIP_KEYS) {
    if (key === 'default') continue;
    const [val, src] = resolveUnitShip(vc, rateIndex, today, key);
    ship[key] = val;
    if (src === 'variant') ship[`${key}_from_variant`] = true;
  }
  const ownRate = rateIndex.lookup('variant', String(vc.variant_id || ''), today);
  const ownCogs = Boolean(ownRate && ownRate.unit_cogs !== null && ownRate.unit_cogs !== undefined);
  // A ship-only variant rate shadows the group's SHIPPING but not its COGS.
  // Calling both "shadowed" would tell the operator their group cost is inert
  // when it is doing all the work.
  const ownShip = Boolean(ownRate) && SHIP_KEYS.some((k) => {
    const map = parseJson(ownRate.ship, {}) || {};
    return map[k] !== null && map[k] !== undefined;
  });
  return {
    variant_id: String(vc.variant_id),
    product_title: vc.product_title || '',
    variant_title: vc.variant_title || '',
    image_url: vc.image_url || '',
    revenue_30d: round2(Number(vc.revenue_30d || 0)),
    units_30d: Number(vc.units_30d || 0),
    price: vc.price === null || vc.price === undefined ? null : Number(vc.price),
    coverage: vc.coverage,
    units_per: Number(vc.units_per || 1),
    // The funnels this member sells on. A group rate reaches every one of
    // them, so the rate drawer's fan-out preview needs the REAL list from
    // here — deriving it from whatever page the client happens to hold would
    // under-report the blast radius of a cost edit.
    funnels: parseJson(vc.funnels, []) || [],
    contexts: parseJson(vc.contexts, []) || [],
    unit_cogs: unitCogs,
    cogs_source: cogsSrc,
    ship,
    // The group rate is stored either way; these say whether it MOVES this
    // member today, per FIELD. Surfaced, never silently hidden.
    shadowed_by_variant_rate: ownCogs,
    ship_shadowed_by_variant_rate: ownShip && !ownCogs,
  };
}

// Shared hydration for a KNOWN set of group rows — used by both the paged
// list and the single-group read, so one group never costs a full-catalog
// scan (N4).
async function hydrate(groupRows, { rateIndex = null } = {}) {
  if (!groupRows.length) return [];
  const ids = groupRows.map((g) => String(g.cost_item_id));
  const members = await pgQuery(
    `SELECT * FROM lb_variant_costs WHERE cost_item_id = ANY($1)
     ORDER BY revenue_30d DESC, units_30d DESC, variant_id`,
    [ids]
  );
  const idx = rateIndex || await loadCostIndex();
  const today = dayKey();

  const byItem = new Map(ids.map((id) => [id, []]));
  for (const vc of members) {
    const list = byItem.get(String(vc.cost_item_id));
    if (list) list.push(memberRow(vc, idx, today));
  }

  return groupRows.map((g) => {
    const id = String(g.cost_item_id);
    const rows = byItem.get(id) || [];
    const rate = idx.lookup('item', id, today);
    const counts = { needs_cost: 0, ready: 0, ignored: 0 };
    let atRisk = 0;
    let revenue = 0;
    for (const r of rows) {
      if (counts[r.coverage] !== undefined) counts[r.coverage] += 1;
      revenue = round2(revenue + r.revenue_30d);
      if (r.coverage === 'needs_cost') atRisk = round2(atRisk + r.revenue_30d);
    }
    const live = rows.length - counts.ignored;
    return {
      cost_item_id: id,
      name: g.name || '',
      note: g.note || '',
      archived: Boolean(g.archived),
      member_count: rows.length,
      // A group everything was unbound out of still holds a rate that now
      // reaches nobody. Say so rather than rendering an ordinary empty row.
      is_empty: rows.length === 0,
      // …and one member short of being a group at all. Its rate still prices
      // that member, so this is not broken — but a "group" of one is almost
      // always the residue of a steal, and it should be visible as such.
      is_understaffed: !g.archived && rows.length < MIN_MEMBERS,
      members: rows,
      rate: rate
        ? {
          id: Number(rate.id),
          effective_from: rate.effective_from,
          unit_cogs: rate.unit_cogs === null || rate.unit_cogs === undefined ? null : Number(rate.unit_cogs),
          ship: parseJson(rate.ship, {}) || {},
          currency: rate.currency,
          source: rate.source,
          note: rate.note || '',
          created_at: rate.created_at,
        }
        : null,
      coverage: {
        counts,
        coverage_pct: live > 0 ? round2((100 * counts.ready) / live) : 0,
        revenue_30d: revenue,
        revenue_at_risk_30d: atRisk,
        shadowed: rows.filter((r) => r.shadowed_by_variant_rate).length,
        ship_shadowed: rows.filter((r) => r.ship_shadowed_by_variant_rate).length,
      },
      created_at: g.created_at,
      updated_at: g.updated_at,
    };
  });
}

export async function listGroups({ includeArchived = false, limit = 100, offset = 0 } = {}) {
  await ensureFunnelCostsTables();
  // `limit=0` means "none" to whoever typed it and meant it. Coercing it to
  // the default 100 answers a question nobody asked; it is refused instead,
  // so a paging bug surfaces as an error rather than as a full page.
  const lim = validateLimit(limit, 100, 200);
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM lb_cost_items ${includeArchived ? '' : 'WHERE archived = FALSE'}`
  );
  // Paged in SQL, BEFORE hydration — a catalog with hundreds of groups must
  // not fold every member row to answer one screen.
  const groups = await pgQuery(
    `SELECT * FROM lb_cost_items
     ${includeArchived ? '' : 'WHERE archived = FALSE'}
     ORDER BY archived, name, cost_item_id
     LIMIT $1 OFFSET $2`,
    [lim, off]
  );
  return { items: await hydrate(groups), total: Number(n), limit: lim, offset: off };
}

export async function getGroup(costItemId) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const rows = await pgQuery(`SELECT * FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
  if (!rows.length) throw new CostError('group_not_found', 'no such cost group');
  const [group] = await hydrate(rows);
  return group;
}

// The group's rate ledger — the SAME append-only rows as a variant's history,
// filtered to scope='item'. Newest first.
export async function groupRateHistory(costItemId, limit = 200) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const lim = validateLimit(limit, 200, 200);
  const items = await pgQuery(
    `SELECT id, scope, variant_id, cost_item_id,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            unit_cogs, ship, currency, source, batch_id, note, created_by, created_at
     FROM lb_cost_rates WHERE scope = 'item' AND cost_item_id = $1
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT $2`,
    [id, lim]
  );
  return { cost_item_id: id, items, count: items.length };
}

// The MEMBERSHIP ledger — who was in this group, with what units_per, from
// when. This is the audit trail for "why did March price the way it did".
export async function groupMemberHistory(costItemId, limit = 200) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const lim = validateLimit(limit, 200, 200);
  const items = await pgQuery(
    `SELECT m.id, m.variant_id, m.cost_item_id, m.units_per,
            to_char(m.effective_from, 'YYYY-MM-DD') AS effective_from,
            m.superseded_at, m.source, m.note, m.created_by, m.created_at,
            v.product_title, v.variant_title
     FROM lb_cost_item_members m
     LEFT JOIN lb_variant_costs v ON v.variant_id = m.variant_id
     WHERE m.cost_item_id = $1
     ORDER BY m.effective_from DESC, m.created_at DESC, m.id DESC
     LIMIT $2`,
    [id, lim]
  );
  return { cost_item_id: id, items, count: items.length };
}

// ══════════════════════════════════════════════════════════════════════════
// Writes — membership only. Rates go through funnelCosts.appendRate.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Bind a set of variants to a group, inside an EXISTING transaction.
 *
 * Writes both halves atomically: the membership ledger (append-only, the
 * authority for every past day) and lb_variant_costs (the current view).
 *
 * A variant already in ANOTHER group is a STEAL — refused unless the caller
 * passes steal:true. Silently moving it would change which rate answers that
 * variant's cost, in a call the operator issued about a different group.
 */
async function bindMembers(q, costItemId, members, { steal = false, actor = '', effectiveFrom = null, source = 'manual' } = {}) {
  const ids = members.map((m) => m.variant_id);
  const existing = await q(
    `SELECT variant_id, cost_item_id, units_per, first_sold FROM lb_variant_costs WHERE variant_id = ANY($1)`,
    [ids]
  );
  const byId = new Map(existing.map((r) => [String(r.variant_id), r]));
  const priorRows = await q(
    `SELECT DISTINCT variant_id FROM lb_cost_item_members WHERE variant_id = ANY($1)`, [ids]
  );
  const hasPrior = new Set(priorRows.map((r) => String(r.variant_id)));

  const today = dayKey();
  const bound = [];
  const moved = [];
  const missing = [];
  const rows = [];
  for (const m of members) {
    const prev = byId.get(m.variant_id);
    // A variant with no catalog row has never been sold, so no rate of any
    // scope could reach it. Binding it would create a member the P&L cannot
    // see — refused loudly instead of written as a ghost.
    if (!prev) { missing.push(m.variant_id); continue; }
    const from = prev.cost_item_id ? String(prev.cost_item_id) : null;
    if (from && from !== costItemId) {
      if (!steal) {
        throw new CostError('variant_in_other_group',
          `${m.variant_id} is already in ${from} — pass steal:true to move it`);
      }
      moved.push({ variant_id: m.variant_id, from });
    }
    rows.push({
      variant_id: m.variant_id,
      units_per: m.units_per,
      effective_from: resolveMembershipFrom({
        explicit: effectiveFrom,
        hasPrior: hasPrior.has(m.variant_id),
        firstSold: prev.first_sold,
        today,
      }),
    });
    bound.push(m.variant_id);
  }

  if (rows.length) {
    // Stamp the rows this supersedes BEFORE appending — derived audit
    // metadata only; resolution bisects effective_from and never reads it.
    await q(
      `UPDATE lb_cost_item_members SET superseded_at = NOW()
       WHERE variant_id = ANY($1) AND superseded_at IS NULL`,
      [rows.map((r) => r.variant_id)]
    );
    // ONE statement per direction (N4) — a per-member round trip inside a
    // transaction holds locks for as long as the slowest member.
    await q(
      `INSERT INTO lb_cost_item_members
         (variant_id, cost_item_id, units_per, effective_from, source, created_by)
       SELECT t.variant_id, $2, t.units_per, t.effective_from::date, $6, $5
       FROM unnest($1::text[], $3::int[], $4::text[])
         AS t(variant_id, units_per, effective_from)`,
      [
        rows.map((r) => r.variant_id), costItemId,
        rows.map((r) => r.units_per), rows.map((r) => r.effective_from),
        String(actor || '').slice(0, 128), source,
      ]
    );
    await q(
      `UPDATE lb_variant_costs AS v
       SET cost_item_id = $2, units_per = t.units_per, updated_at = NOW()
       FROM unnest($1::text[], $3::int[]) AS t(variant_id, units_per)
       WHERE v.variant_id = t.variant_id`,
      [rows.map((r) => r.variant_id), costItemId, rows.map((r) => r.units_per)]
    );
  }

  // A steal has TWO sides. Taking a variant can strand the group it came
  // from below the two members a group needs to mean anything — and that
  // group may still carry a rate, now pricing one variant or none. The
  // caller is told which groups it just hollowed out, by name, rather than
  // discovering it on a later screen.
  let sourceUnderstaffed = [];
  if (moved.length) {
    const sources = [...new Set(moved.map((m) => m.from))];
    sourceUnderstaffed = await q(
      `SELECT i.cost_item_id, i.name,
              (SELECT COUNT(*)::int FROM lb_variant_costs v WHERE v.cost_item_id = i.cost_item_id) AS member_count
       FROM lb_cost_items i
       WHERE i.cost_item_id = ANY($1) AND i.archived = FALSE
         AND (SELECT COUNT(*) FROM lb_variant_costs v WHERE v.cost_item_id = i.cost_item_id) < $2`,
      [sources, MIN_MEMBERS]
    );
  }
  return {
    bound,
    moved,
    missing,
    source_understaffed: sourceUnderstaffed.map((r) => ({
      cost_item_id: String(r.cost_item_id),
      name: r.name || '',
      member_count: Number(r.member_count),
    })),
  };
}

// Unbind, inside an EXISTING transaction. The variant keeps every rate it
// ever had and every day it was genuinely a member: only a TOMBSTONE is
// appended (cost_item_id NULL, effective today), so past days keep pricing
// through the group and today stops. units_per resets to 1 because it only
// ever meant "how many of the GROUP's unit this variant contains".
async function unbindMembers(q, costItemId, variantIds, { actor = '', source = 'manual' } = {}) {
  const present = await q(
    `SELECT variant_id FROM lb_variant_costs WHERE cost_item_id = $1 AND variant_id = ANY($2)`,
    [costItemId, variantIds]
  );
  const ids = present.map((r) => String(r.variant_id));
  if (!ids.length) return [];
  const today = dayKey();
  await q(
    `UPDATE lb_cost_item_members SET superseded_at = NOW()
     WHERE variant_id = ANY($1) AND superseded_at IS NULL`,
    [ids]
  );
  await q(
    `INSERT INTO lb_cost_item_members
       (variant_id, cost_item_id, units_per, effective_from, source, created_by, note)
     SELECT t.variant_id, NULL, 1, $2::date, $4, $3, 'unbound'
     FROM unnest($1::text[]) AS t(variant_id)`,
    [ids, today, String(actor || '').slice(0, 128), source]
  );
  await q(
    `UPDATE lb_variant_costs SET cost_item_id = NULL, units_per = 1, updated_at = NOW()
     WHERE variant_id = ANY($1)`,
    [ids]
  );
  return ids;
}

// Post-bind invariant, checked INSIDE the transaction so a violation rolls
// the whole thing back (M4). Counting before the write would race the very
// steal that empties the other group.
async function assertMinMembers(q, costItemId) {
  const [{ n }] = await q(
    `SELECT COUNT(*)::int AS n FROM lb_variant_costs WHERE cost_item_id = $1`, [costItemId]);
  if (Number(n) < MIN_MEMBERS) {
    throw new CostError('too_few_members',
      `a cost group needs at least ${MIN_MEMBERS} variants (would end with ${n})`);
  }
  return Number(n);
}

async function assertNameFree(q, name, exceptId = null) {
  const rows = await q(
    `SELECT cost_item_id FROM lb_cost_items
     WHERE archived = FALSE AND lower(name) = lower($1) AND ($2::text IS NULL OR cost_item_id <> $2)`,
    [name, exceptId]
  );
  if (rows.length) throw new CostError('name_taken', 'another live cost group already has that name');
}

/**
 * Create a group inside an EXISTING transaction.
 *
 * Exported so a caller that must create a group as part of a larger atomic
 * act — accepting a proposal, which has to CLAIM the proposal and mint the
 * group together or not at all — can compose it without nesting transactions.
 */
export async function createGroupInTx(q, {
  name, note = '', members = [], createdBy = '', steal = false, costItemId = null,
} = {}) {
  const clean = cleanName(name, { required: true });
  const list = normalizeMembers(members);
  if (list.length < MIN_MEMBERS) {
    throw new CostError('too_few_members', `a cost group needs at least ${MIN_MEMBERS} variants`);
  }
  const id = costItemId ? cleanItemId(costItemId) : newCostItemId();
  await assertNameFree(q, clean);
  await q(
    `INSERT INTO lb_cost_items (cost_item_id, name, note, created_by) VALUES ($1, $2, $3, $4)`,
    [id, clean, String(note || '').slice(0, MAX_NOTE), String(createdBy || '').slice(0, 128)]
  );
  const out = await bindMembers(q, id, list, { steal, actor: createdBy });
  await assertMinMembers(q, id);
  return { cost_item_id: id, ...out };
}

export async function createGroup(opts = {}) {
  await ensureFunnelCostsTables();
  let res;
  try {
    res = await withTx((q) => createGroupInTx(q, opts));
  } catch (err) {
    // assertNameFree is a READ, so two creates racing on the same name both
    // pass it and one hits the unique index instead. That is the constraint
    // doing its job — it must surface as the same 409 the pre-check gives,
    // not as an opaque 500 with a Postgres string in it.
    if (err && err.code === '23505' && String(err.constraint_name || err.constraint || '').includes('lb_cost_items_name')) {
      throw new CostError('name_taken', 'another live cost group already has that name');
    }
    throw err;
  }
  // Binding can change a variant's resolved cost the instant it lands (the
  // group may already carry a rate), so coverage is recomputed from the
  // ledger — not guessed, and not left for the next sweep.
  await refreshCoverage('item', res.cost_item_id);
  return { group: await getGroup(res.cost_item_id), ...res };
}

export async function updateGroup(costItemId, patch = {}, updatedBy = '') {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  await withTx(async (q) => {
    const [row] = await q(`SELECT cost_item_id, archived FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
    if (!row) throw new CostError('group_not_found', 'no such cost group');
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const nm = cleanName(patch.name, { required: true });
      await assertNameFree(q, nm, id);
      params.push(nm);
      sets.push(`name = $${params.length}`);
    }
    if (patch.note !== undefined) {
      params.push(String(patch.note ?? '').slice(0, MAX_NOTE));
      sets.push(`note = $${params.length}`);
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') throw new CostError('bad_archived', 'archived must be boolean');
      params.push(patch.archived);
      sets.push(`archived = $${params.length}`);
    }
    if (!sets.length) throw new CostError('empty_patch', 'nothing to update');
    params.push(id);
    await q(
      `UPDATE lb_cost_items SET ${sets.join(', ')}, updated_at = NOW() WHERE cost_item_id = $${params.length}`,
      params
    );
  });
  return getGroup(id);
}

export async function addMembers(costItemId, members, { steal = false, actor = '' } = {}) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const list = normalizeMembers(members);
  if (!list.length) throw new CostError('no_members', 'name at least one variant');

  const res = await withTx(async (q) => {
    const [row] = await q(`SELECT cost_item_id, archived FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
    if (!row) throw new CostError('group_not_found', 'no such cost group');
    if (row.archived) throw new CostError('group_archived', 'un-archive the group before binding variants');
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM lb_variant_costs
       WHERE cost_item_id = $1 AND NOT (variant_id = ANY($2))`,
      [id, list.map((m) => m.variant_id)]
    );
    if (Number(n) + list.length > MAX_MEMBERS) {
      throw new CostError('too_many_members', `a group holds at most ${MAX_MEMBERS} variants`);
    }
    const out = await bindMembers(q, id, list, { steal, actor });
    await assertMinMembers(q, id);
    return out;
  });

  await refreshCoverage('item', id);
  return { group: await getGroup(id), ...res };
}

export async function removeMembers(costItemId, variantIds, { actor = '' } = {}) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const ids = (Array.isArray(variantIds) ? variantIds : [variantIds]).map(cleanVariantId);
  if (!ids.length) throw new CostError('no_members', 'name at least one variant');

  const removed = await withTx(async (q) => {
    const [row] = await q(`SELECT cost_item_id FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
    if (!row) throw new CostError('group_not_found', 'no such cost group');
    // NOTE: unbinding may leave the group with fewer than MIN_MEMBERS, and
    // that is allowed — the operator is dismantling it deliberately. The read
    // surface flags `is_empty` so a group whose rate now reaches nobody is
    // visible rather than silently inert.
    return unbindMembers(q, id, ids, { actor });
  });

  // Losing the group can take a member's only cost away — recompute from the
  // ledger so the worklist tells the truth immediately.
  for (const vid of removed) await refreshCoverage('variant', vid);
  return { group: await getGroup(id), removed };
}

// DELETE is an ARCHIVE + a SUPERSEDE, never a row drop and never a rewrite.
// The group's rate rows AND its membership history are money history: a past
// day's P&L still resolves through the group for every day the membership was
// real, and stops on the day of the delete. Only "from today onward" changes.
export async function deleteGroup(costItemId, deletedBy = '') {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const freed = await withTx(async (q) => {
    const [row] = await q(`SELECT cost_item_id FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
    if (!row) throw new CostError('group_not_found', 'no such cost group');
    const current = await q(`SELECT variant_id FROM lb_variant_costs WHERE cost_item_id = $1`, [id]);
    const ids = current.map((r) => String(r.variant_id));
    const out = ids.length ? await unbindMembers(q, id, ids, { actor: deletedBy }) : [];
    await q(`UPDATE lb_cost_items SET archived = TRUE, updated_at = NOW() WHERE cost_item_id = $1`, [id]);
    // An accepted proposal whose group is gone must not stay "accepted" —
    // otherwise the grouping can never be suggested or re-accepted again.
    await q(
      `UPDATE lb_cost_group_proposals
       SET status = 'open', cost_item_id = NULL, decided_at = NULL, decided_by = ''
       WHERE cost_item_id = $1 AND status = 'accepted'`,
      [id]
    );
    return out;
  });
  for (const vid of freed) await refreshCoverage('variant', vid);
  return {
    cost_item_id: id,
    archived: true,
    unbound: freed,
    rates_kept: true,
    history_kept: true,
    deleted_by: String(deletedBy || '').slice(0, 128),
  };
}

export default {
  listGroups, getGroup, groupRateHistory, groupMemberHistory, createGroup,
  updateGroup, addMembers, removeMembers, deleteGroup, newCostItemId,
  cleanItemId, normalizeMembers, cleanUnitsPer, resolveMembershipFrom,
  MIN_MEMBERS, MAX_MEMBERS, MAX_UNITS_PER,
};
