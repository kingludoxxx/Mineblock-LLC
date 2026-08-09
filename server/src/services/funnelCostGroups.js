// COST GROUPS — several Shopify variants sharing ONE cost item, plus the
// auto-proposal loop that suggests the groupings from order data.
//
// Port of funnel-os lb_cost_group_service.py / lb_cost_groups_service.py
// (CRUD + membership) and lb_cost_group_detect_service.py /
// lb_cost_detection_service.py (the candidate heuristics), mapped onto the
// cost catalog this repo already owns.
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE ADDS NO SECOND ENGINE
// ══════════════════════════════════════════════════════════════════════════
// The P&L engine already resolves group rates. funnelCosts.resolveUnitCogs
// reads `vc.cost_item_id` off the variant ROW and looks up scope='item' in
// the same bisected rate index it uses for variant rates; resolveUnitShip
// does the same for the ship map. Both were written with the group layer's
// hook in place — what was missing was the group ENTITY and the UI to bind
// members.
//
// So membership is stored as lb_variant_costs.cost_item_id and NOWHERE else.
// A dedicated membership table would be a second source of truth the engine
// never consults: rates would save, the UI would look right, and margins
// would not move. Writing the column the read path already bisects on is the
// whole reason this lane is additive.
//
// ── RESOLUTION ORDER (the contract this file must not break) ──────────────
//   1. an explicit per-VARIANT rate for that day        → wins outright
//   2. else the variant's GROUP rate for that day       → × units_per
//   3. else UNKNOWN (null) — never 0, profit is withheld
//
// Step 2's `× units_per` is why membership carries units_per: COGS is per
// unit OF THE VARIANT, so a "3 Pack" bound to a single-bottle group costs
// 3 × the group rate. Shipping is deliberately NOT multiplied (a 3-pack
// ships in one box) — that asymmetry lives in funnelCosts.resolveUnitShip
// and this file must not duplicate it.
//
// A member with its own variant-scope rate is SHADOWED: the group rate is
// stored and its history is real, but the member's resolved cost does not
// move until that variant rate is superseded. The read surfaces below label
// those rows rather than hiding them, because "I set the group rate and
// nothing changed" is otherwise an unexplainable result.
//
// MONEY DISCIPLINE. This file writes NO rates. Every cost still goes through
// funnelCosts.appendRate — the one append-only, effective-dated write door —
// so group rates get the same history, the same null-vs-0 rule (null =
// nobody has told us and profit is withheld; 0 = known free) and the same
// backdating semantics as variant rates. Nothing here is destructive: a
// deleted group is ARCHIVED and unbound, and its rate rows are kept.
//
// LET IT THROW: no error is swallowed. Bad input raises CostError (the route
// maps .code to a 4xx); infra failures propagate to the route's 500.
import { pgQuery } from '../db/pg.js';
import { ensureFunnelCostsTables } from './funnelCostsSchema.js';
import {
  CostError, buildRateIndex, loadRates, resolveUnitCogs, resolveUnitShip,
  dayKey, round2, refreshCoverage, SHIP_KEYS,
} from './funnelCosts.js';

const ITEM_RE = /^ci_[0-9a-z_-]{2,64}$/i;
const VARIANT_RE = /^[0-9]{6,20}$/;

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

function cleanName(raw, { required = false } = {}) {
  const name = String(raw ?? '').trim().slice(0, MAX_NAME);
  if (!name && required) throw new CostError('name_required', 'a cost group needs a name');
  return name;
}

// units_per is a COUNT, not money: it must be a positive integer. 0 would
// make a member's COGS a hard 0 (a real answer that nobody gave), which is
// exactly the null-vs-zero bug in multiplier form.
export function cleanUnitsPer(raw) {
  if (raw === null || raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (typeof raw === 'boolean' || Number.isNaN(n) || !Number.isFinite(n) || !Number.isInteger(n)) {
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
    const [val] = resolveUnitShip(vc, rateIndex, today, key);
    ship[key] = val;
  }
  const ownRate = rateIndex.lookup('variant', String(vc.variant_id || ''), today);
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
    unit_cogs: unitCogs,
    cogs_source: cogsSrc,
    ship,
    // The group rate is stored either way; this says whether it MOVES this
    // member today. Surfaced, never silently hidden.
    shadowed_by_variant_rate: Boolean(
      ownRate && ownRate.unit_cogs !== null && ownRate.unit_cogs !== undefined
    ),
  };
}

// The Groups tab payload. Coverage here is the group's OWN worklist: how many
// of its members currently resolve to a known cost, and how much trailing 30d
// revenue is still booked at 100% margin underneath it.
export async function listGroups({ includeArchived = false } = {}) {
  await ensureFunnelCostsTables();
  const groups = await pgQuery(
    `SELECT * FROM lb_cost_items
     ${includeArchived ? '' : 'WHERE archived = FALSE'}
     ORDER BY archived, name, cost_item_id`
  );
  if (!groups.length) return { items: [], total: 0 };

  const ids = groups.map((g) => String(g.cost_item_id));
  const members = await pgQuery(
    `SELECT * FROM lb_variant_costs WHERE cost_item_id = ANY($1)
     ORDER BY revenue_30d DESC, units_30d DESC, variant_id`,
    [ids]
  );
  const rateIndex = buildRateIndex(await loadRates());
  const today = dayKey();

  const byItem = new Map(ids.map((id) => [id, []]));
  for (const vc of members) {
    const list = byItem.get(String(vc.cost_item_id));
    if (list) list.push(memberRow(vc, rateIndex, today));
  }

  const items = groups.map((g) => {
    const id = String(g.cost_item_id);
    const rows = byItem.get(id) || [];
    const rate = rateIndex.lookup('item', id, today);
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
      members: rows,
      // The group's rate in force TODAY — null unit_cogs stays null (unknown),
      // it is never rendered as a free good.
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
      },
      created_at: g.created_at,
      updated_at: g.updated_at,
    };
  });
  return { items, total: items.length };
}

export async function getGroup(costItemId) {
  const id = cleanItemId(costItemId);
  const { items } = await listGroups({ includeArchived: true });
  const found = items.find((g) => g.cost_item_id === id);
  if (!found) throw new CostError('group_not_found', 'no such cost group');
  return found;
}

// The group's rate ledger — the SAME append-only rows as a variant's history,
// filtered to scope='item'. Newest first.
export async function groupRateHistory(costItemId, limit = 200) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 200));
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

// ══════════════════════════════════════════════════════════════════════════
// Writes — membership only. Rates go through funnelCosts.appendRate.
// ══════════════════════════════════════════════════════════════════════════

async function assertGroupExists(id) {
  const [row] = await pgQuery(`SELECT cost_item_id, archived FROM lb_cost_items WHERE cost_item_id = $1`, [id]);
  if (!row) throw new CostError('group_not_found', 'no such cost group');
  return row;
}

// Bind variants to a group. Returns what actually moved, including variants
// TAKEN from another group — a rebind changes which rate answers a variant's
// cost, so it is reported rather than performed quietly.
async function bindMembers(costItemId, members) {
  const bound = [];
  const moved = [];
  const missing = [];
  for (const m of members) {
    const [prev] = await pgQuery(
      `SELECT variant_id, cost_item_id, units_per FROM lb_variant_costs WHERE variant_id = $1`,
      [m.variant_id]
    );
    // A variant with no catalog row has never been sold, so no rate of any
    // scope could reach it. Binding it would create a member the P&L cannot
    // see — refused loudly instead of written as a ghost.
    if (!prev) { missing.push(m.variant_id); continue; }
    const from = prev.cost_item_id ? String(prev.cost_item_id) : null;
    if (from && from !== costItemId) moved.push({ variant_id: m.variant_id, from });
    await pgQuery(
      `UPDATE lb_variant_costs SET cost_item_id = $1, units_per = $2, updated_at = NOW()
       WHERE variant_id = $3`,
      [costItemId, m.units_per, m.variant_id]
    );
    bound.push(m.variant_id);
  }
  return { bound, moved, missing };
}

export async function createGroup({ name, note = '', members = [], createdBy = '' } = {}) {
  await ensureFunnelCostsTables();
  const clean = cleanName(name, { required: true });
  const list = normalizeMembers(members);
  if (list.length < MIN_MEMBERS) {
    throw new CostError('too_few_members', `a cost group needs at least ${MIN_MEMBERS} variants`);
  }
  const id = newCostItemId();
  await pgQuery(
    `INSERT INTO lb_cost_items (cost_item_id, name, note, created_by) VALUES ($1, $2, $3, $4)`,
    [id, clean, String(note || '').slice(0, MAX_NOTE), String(createdBy || '').slice(0, 128)]
  );
  const res = await bindMembers(id, list);
  // Binding can change a variant's resolved cost the instant it lands (the
  // group may already carry a rate), so coverage is recomputed from the
  // ledger — not guessed, and not left for the next sweep.
  await refreshCoverage('item', id);
  return { group: await getGroup(id), ...res };
}

export async function updateGroup(costItemId, patch = {}, updatedBy = '') {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  await assertGroupExists(id);
  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    params.push(cleanName(patch.name, { required: true }));
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
  params.push(String(updatedBy || '').slice(0, 128));
  sets.push(`created_by = COALESCE(NULLIF(lb_cost_items.created_by, ''), $${params.length})`);
  params.push(id);
  await pgQuery(
    `UPDATE lb_cost_items SET ${sets.join(', ')}, updated_at = NOW() WHERE cost_item_id = $${params.length}`,
    params
  );
  return getGroup(id);
}

export async function addMembers(costItemId, members) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  const row = await assertGroupExists(id);
  if (row.archived) throw new CostError('group_archived', 'un-archive the group before binding variants');
  const list = normalizeMembers(members);
  if (!list.length) throw new CostError('no_members', 'name at least one variant');
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM lb_variant_costs
     WHERE cost_item_id = $1 AND NOT (variant_id = ANY($2))`,
    [id, list.map((m) => m.variant_id)]
  );
  if (Number(n) + list.length > MAX_MEMBERS) {
    throw new CostError('too_many_members', `a group holds at most ${MAX_MEMBERS} variants`);
  }
  const res = await bindMembers(id, list);
  await refreshCoverage('item', id);
  return { group: await getGroup(id), ...res };
}

// Unbind. The variant keeps every rate it ever had — only the group POINTER
// is cleared — so its cost falls back to its own variant-scope rate, or to
// unknown. units_per resets to 1 because it only ever meant "how many of the
// GROUP's unit this variant contains".
export async function removeMembers(costItemId, variantIds) {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  await assertGroupExists(id);
  const ids = (Array.isArray(variantIds) ? variantIds : [variantIds]).map(cleanVariantId);
  if (!ids.length) throw new CostError('no_members', 'name at least one variant');
  const removed = await pgQuery(
    `UPDATE lb_variant_costs SET cost_item_id = NULL, units_per = 1, updated_at = NOW()
     WHERE cost_item_id = $1 AND variant_id = ANY($2) RETURNING variant_id`,
    [id, ids]
  );
  // Losing the group can take a member's only cost away — recompute from the
  // ledger so the worklist tells the truth immediately.
  for (const r of removed) await refreshCoverage('variant', String(r.variant_id));
  return { group: await getGroup(id), removed: removed.map((r) => String(r.variant_id)) };
}

// DELETE is an ARCHIVE + unbind, never a row drop. The group's rate rows are
// money history and are kept: the P&L for a past day still has to be
// reconstructible after the operator retires a grouping. Members are unbound
// so their costs stop resolving through a group that no longer applies.
export async function deleteGroup(costItemId, deletedBy = '') {
  await ensureFunnelCostsTables();
  const id = cleanItemId(costItemId);
  await assertGroupExists(id);
  const freed = await pgQuery(
    `UPDATE lb_variant_costs SET cost_item_id = NULL, units_per = 1, updated_at = NOW()
     WHERE cost_item_id = $1 RETURNING variant_id`,
    [id]
  );
  await pgQuery(
    `UPDATE lb_cost_items SET archived = TRUE, updated_at = NOW() WHERE cost_item_id = $1`,
    [id]
  );
  for (const r of freed) await refreshCoverage('variant', String(r.variant_id));
  return {
    cost_item_id: id,
    archived: true,
    unbound: freed.map((r) => String(r.variant_id)),
    rates_kept: true,
    deleted_by: String(deletedBy || '').slice(0, 128),
  };
}

export default {
  listGroups, getGroup, groupRateHistory, createGroup, updateGroup,
  addMembers, removeMembers, deleteGroup, newCostItemId, cleanItemId,
  normalizeMembers, cleanUnitsPer, MIN_MEMBERS, MAX_MEMBERS, MAX_UNITS_PER,
};
