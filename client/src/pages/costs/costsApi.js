// costsApi — the ONE place the Costs/P&L workspace names a backend route
// (NEW FILE, costs lane).
//
// Conforms EXACTLY to COGS API CONTRACT v2 (scratchpad/cogs-contract-v2.md),
// the binding document for both lanes. The load-bearing points:
//
//   · ENVELOPE (B1): every endpoint answers `{success:true, data:<payload>}`.
//     `unwrap` peels that ONCE, here, for every call — no component ever sees
//     the envelope, and a bare body (no `data` key) passes through untouched.
//   · EMPTY POST BODIES (B2): `{}`, never `null` — express strict json
//     rejects a literal-null body with a 400 before our route ever runs.
//   · ERRORS (M5): `{success:false, error:{code}}`. `costApiError` reads
//     `data?.error?.code` and maps it through API_ERRORS; anything absent or
//     unknown gets generic prose, never a raw machine code in the UI.
//   · ROWS ARE FLAT (B4): resolved-for-today `unit_cogs` / `ship` /
//     `cogs_source` / `margin_pct` sit top-level on every variant ROW;
//     unknown = null, never omitted.
//
// ── Routes (payloads = the `data` member, per contract v2) ───────────────
//   GET    /variants                  -> { items:[ROW], total, limit, offset }
//   GET    /by-funnel                 -> { funnels:[{funnel_id, name, revenue_30d,
//                                          units_30d, revenue_at_risk_30d,
//                                          counts:{needs_cost,ready,ignored},
//                                          products:[{product_title, shopify_product_id,
//                                            avg_price, missing_count,
//                                            variants:[ROW + {own_revenue_30d, own_units_30d}]}]}] }
//   GET    /coverage-summary          -> { total, needs_cost, ready, ignored,
//                                          coverage_pct, revenue_at_risk_30d, units_at_risk_30d }
//   POST   /detect                    body {}; ?days clamped ≥30 (400 window_too_small below)
//   POST   /rates                     -> { rate:{id, scope, variant_id, cost_item_id,
//                                          effective_from, unit_cogs, ship, currency,
//                                          source, note, created_at} }
//   GET    /rates/history/:variantId  -> { variant_id, items, count }
//   GET/PATCH /fee-settings           -> { default:{pct,fixed},
//                                          gateways:{whop|stripe|paypal|nmi:{pct,fixed}|null},
//                                          updated_at } (both directions, nested)
//   PATCH  /variants/:id              operator fields only: { pays_shipping?, ignored?, kind_override? }
//   GET    /pnl/overview ?start&end   -> { rows:[{fid, name, revenue, gross_sales, orders,
//                                          cogs, fees, ship_cost, gp, gp_margin,
//                                          cost_coverage_pct, known_legs, missing_legs,
//                                          missing_cogs_legs, missing_ship_legs, spend,
//                                          spend_known, net_profit, roas, cpa}],
//                                          totals:{…same…}, window:{start,end} }
//   GET    /pnl/funnel/:fid ?start&end -> { totals, daily:[{day, orders, revenue, cogs,
//                                          fees, ship_cost, gp, spend, np,
//                                          cost_coverage_pct}],
//                                          campaigns:[{campaign_id, name, spend,
//                                            bound_via:'pin'|'derived', split, sessions}],
//                                          manual_entries:[{day, spend, note}] }
//   GET    /spend/status              -> { sources:[{source:'meta', configured, last_sync,
//                                          last_attempt, last_ok, stale, error, fail_streak}] }
//   POST   /spend/sync                body {}
//   POST   /campaign-map              body { campaign_id, funnel_id?, action:'pin'|'unpin' }
//   POST   /pnl/funnel/:fid/spend-manual        body { day:'YYYY-MM-DD', spend:number≥0, note? }
//   DELETE /pnl/funnel/:fid/spend-manual/:day
// Explicit .js extension so the node harness (scripts/verifyCostsUi.mjs) can
// import this module directly; Vite resolves it identically.
import api from '../../services/api.js';

/**
 * The ONE envelope unwrap (B1). House convention wraps every payload as
 * `{success, data}`; `res.data?.data ?? res.data` peels exactly that and
 * passes a bare body through unchanged, so no second unwrap assumption can
 * exist anywhere downstream.
 */
export const unwrap = (res) => res.data?.data ?? res.data;

export const COSTS_BASE = '/funnel-costs';

export const COSTS_ROUTES = {
  variants: `${COSTS_BASE}/variants`,
  variant: (id) => `${COSTS_BASE}/variants/${encodeURIComponent(id)}`,
  byFunnel: `${COSTS_BASE}/by-funnel`,
  coverageSummary: `${COSTS_BASE}/coverage-summary`,
  detect: `${COSTS_BASE}/detect`,
  rates: `${COSTS_BASE}/rates`,
  rateHistory: (variantId) => `${COSTS_BASE}/rates/history/${encodeURIComponent(variantId)}`,
  feeSettings: `${COSTS_BASE}/fee-settings`,
  pnlOverview: `${COSTS_BASE}/pnl/overview`,
  pnlFunnel: (fid) => `${COSTS_BASE}/pnl/funnel/${encodeURIComponent(fid)}`,
  spendStatus: `${COSTS_BASE}/spend/status`,
  spendSync: `${COSTS_BASE}/spend/sync`,
  campaignMap: `${COSTS_BASE}/campaign-map`,
  manualSpend: (fid) => `${COSTS_BASE}/pnl/funnel/${encodeURIComponent(fid)}/spend-manual`,
  manualSpendDay: (fid, day) =>
    `${COSTS_BASE}/pnl/funnel/${encodeURIComponent(fid)}/spend-manual/${encodeURIComponent(day)}`,
};

/* ── cost groups + proposals ───────────────────────────────────────────────
 * A SECOND BASE, on purpose. Groups live at /funnel-cost-groups because they
 * touch none of the money surface above — no P&L, no spend feed.
 *
 * THERE IS NO GROUP-RATE FUNCTION HERE. A group's cost is written with
 * `postRate({scope:'item', cost_item_id})` — the same append-only door as a
 * variant rate, which is why RateDrawer's "Cost group" scope already works
 * the moment a variant has a cost_item_id. A second write path would be a
 * second history.
 *
 *   GET    /                          -> { items:[GROUP], total }
 *   POST   /                          body { name, note?, members:[{variant_id, units_per?}] } -> 201
 *   GET    /:id                       -> { group:GROUP }
 *   PATCH  /:id                       body { name?, note?, archived? }
 *   DELETE /:id                       archive + unbind (rate history KEPT)
 *   POST   /:id/members               body { members:[{variant_id, units_per?}] }
 *   DELETE /:id/members/:variantId
 *   GET    /:id/history               -> { cost_item_id, items, count }
 *   POST   /proposals/detect          -> { proposals, open, certain, high, review, … }
 *   GET    /proposals?status&limit    -> { items:[PROPOSAL], count }
 *   POST   /proposals/:id/accept      body { name?, note?, members? } -> becomes a group
 *   POST   /proposals/:id/dismiss     body { reason? }
 *   POST   /proposals/:id/reopen
 *
 * GROUP = { cost_item_id, name, note, archived, member_count, members:[…],
 *           rate:{unit_cogs, ship, effective_from, …}|null,
 *           coverage:{counts, coverage_pct, revenue_30d, revenue_at_risk_30d, shadowed} }
 */
export const GROUPS_BASE = '/funnel-cost-groups';

export const GROUP_ROUTES = {
  groups: GROUPS_BASE,
  group: (id) => `${GROUPS_BASE}/${encodeURIComponent(id)}`,
  members: (id) => `${GROUPS_BASE}/${encodeURIComponent(id)}/members`,
  member: (id, variantId) => `${GROUPS_BASE}/${encodeURIComponent(id)}/members/${encodeURIComponent(variantId)}`,
  groupHistory: (id) => `${GROUPS_BASE}/${encodeURIComponent(id)}/history`,
  proposals: `${GROUPS_BASE}/proposals`,
  proposalsDetect: `${GROUPS_BASE}/proposals/detect`,
  proposalAccept: (id) => `${GROUPS_BASE}/proposals/${encodeURIComponent(id)}/accept`,
  proposalDismiss: (id) => `${GROUPS_BASE}/proposals/${encodeURIComponent(id)}/dismiss`,
  proposalReopen: (id) => `${GROUPS_BASE}/proposals/${encodeURIComponent(id)}/reopen`,
};

export function fetchCostGroups(params = {}) {
  return api.get(GROUP_ROUTES.groups, { params }).then(unwrap);
}

/**
 * ONE group, from the server. The rate drawer's fan-out preview MUST use
 * this and never the loaded variant page: the page is one slice of the
 * catalog, so a group whose members sit outside it would under-report how
 * many variants (and which funnels) a group rate is about to move.
 */
export function fetchCostGroup(id) {
  return api.get(GROUP_ROUTES.group(id)).then(unwrap);
}

export function createCostGroup(body) {
  return api.post(GROUP_ROUTES.groups, body).then(unwrap);
}

export function patchCostGroup(id, body) {
  return api.patch(GROUP_ROUTES.group(id), body).then(unwrap);
}

/** Archive + unbind. The group's rate history is kept, never dropped. */
export function deleteCostGroup(id) {
  return api.delete(GROUP_ROUTES.group(id)).then(unwrap);
}

/**
 * `steal` must be explicit. A variant already in another group is REFUSED
 * (409 variant_in_other_group) unless the caller says to move it — silently
 * reassigning it would change which rate answers that variant's cost, in a
 * call the operator issued about a different group.
 */
export function addCostGroupMembers(id, members, steal = false) {
  return api.post(GROUP_ROUTES.members(id), { members, steal }).then(unwrap);
}

export function removeCostGroupMember(id, variantId) {
  return api.delete(GROUP_ROUTES.member(id, variantId)).then(unwrap);
}

export function fetchCostGroupHistory(id) {
  return api.get(GROUP_ROUTES.groupHistory(id)).then(unwrap);
}

/** Body `{}` — express strict json 400s on a literal null body (B2). */
export function postProposalsDetect() {
  return api.post(GROUP_ROUTES.proposalsDetect, {}).then(unwrap);
}

export function fetchProposals(params = { status: 'open' }) {
  return api.get(GROUP_ROUTES.proposals, { params }).then(unwrap);
}

/** Accept → the proposal becomes a group. Creates NO rate. */
export function acceptProposal(id, body = {}) {
  return api.post(GROUP_ROUTES.proposalAccept(id), body).then(unwrap);
}

export function dismissProposal(id, reason = '') {
  return api.post(GROUP_ROUTES.proposalDismiss(id), { reason }).then(unwrap);
}

export function reopenProposal(id) {
  return api.post(GROUP_ROUTES.proposalReopen(id), {}).then(unwrap);
}

/** Seeded gateways, in the order the fee card renders them (lb_fee_settings). */
export const GATEWAYS = [
  { key: 'whop', label: 'Whop' },
  { key: 'stripe', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'nmi', label: 'NMI' },
];

export function fetchVariants(params = {}) {
  return api.get(COSTS_ROUTES.variants, { params }).then(unwrap);
}

export function fetchByFunnel(params = {}) {
  return api.get(COSTS_ROUTES.byFunnel, { params }).then(unwrap);
}

export function fetchCoverageSummary() {
  return api.get(COSTS_ROUTES.coverageSummary).then(unwrap);
}

/** `days` omitted = the backend's configured default window (90d SOLD sweep,
 *  server clamps to ≥30). Body is `{}` — express strict json 400s on null (B2). */
export function postDetect(days) {
  return api
    .post(COSTS_ROUTES.detect, {}, days ? { params: { days } } : undefined)
    .then(unwrap);
}

/**
 * Append a rate. There is no "edit" — an edit is a new row, so history is
 * always reconstructible and a backdated change cannot silently rewrite last
 * quarter's gross profit. `unit_cogs: null` means UNKNOWN and must reach the
 * wire as null; this module never coerces it.
 */
export function postRate(body) {
  return api.post(COSTS_ROUTES.rates, body).then(unwrap);
}

/** Newest-first history for a variant (server folds in group-scope rows). */
export function fetchRateHistory(variantId) {
  return api.get(COSTS_ROUTES.rateHistory(variantId)).then(unwrap);
}

export function fetchFeeSettings() {
  return api.get(COSTS_ROUTES.feeSettings).then(unwrap);
}

export function patchFeeSettings(body) {
  return api.patch(COSTS_ROUTES.feeSettings, body).then(unwrap);
}

/** Operator-owned columns only: { pays_shipping?, ignored?, kind_override? }. */
export function patchVariant(variantId, body) {
  return api.patch(COSTS_ROUTES.variant(variantId), body).then(unwrap);
}

/* ── P&L ───────────────────────────────────────────────────────────────── */

export function fetchPnlOverview({ start, end }) {
  return api.get(COSTS_ROUTES.pnlOverview, { params: { start, end } }).then(unwrap);
}

export function fetchPnlFunnel(fid, { start, end }) {
  return api.get(COSTS_ROUTES.pnlFunnel(fid), { params: { start, end } }).then(unwrap);
}

export function fetchSpendStatus() {
  return api.get(COSTS_ROUTES.spendStatus).then(unwrap);
}

/** Body `{}` — express strict json 400s on a literal null body (B2). */
export function postSpendSync(days) {
  return api
    .post(COSTS_ROUTES.spendSync, {}, days ? { params: { days } } : undefined)
    .then(unwrap);
}

/** Pin a campaign to a funnel, or drop the pin (derived binding resumes). */
export function postCampaignMap({ campaign_id, funnel_id, action }) {
  return api
    .post(COSTS_ROUTES.campaignMap, { campaign_id, funnel_id, action })
    .then(unwrap);
}

export function postManualSpend(fid, { day, spend, note }) {
  return api.post(COSTS_ROUTES.manualSpend(fid), { day, spend, note }).then(unwrap);
}

export function deleteManualSpend(fid, day) {
  return api.delete(COSTS_ROUTES.manualSpendDay(fid, day)).then(unwrap);
}

/* ── payload readers + errors (keys per contract v2) ───────────────────── */

/** `items` out of a list payload (contract: /variants, /rates/history). */
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

/** The drill-in's daily series — contract key `daily`. */
export function dailyOf(data) {
  return Array.isArray(data?.daily) ? data.daily : [];
}

/** The drill-in's manual spend entries — contract key `manual_entries`. */
export function manualOf(data) {
  return Array.isArray(data?.manual_entries) ? data.manual_entries : [];
}

/** The spend-status sources list — contract shape `{sources:[…]}` (M2). */
export function sourcesOf(data) {
  return Array.isArray(data?.sources) ? data.sources : [];
}

const API_ERRORS = {
  empty_rate: 'A rate has to set a cost or a shipping value — there is nothing to save.',
  negative_amount: 'A cost cannot be negative.',
  bad_amount: 'That value is not a number.',
  bad_effective_from: 'The effective date must be a real YYYY-MM-DD day.',
  bad_variant_id: 'That variant id does not look like a Shopify variant id.',
  bad_gateway: 'That is not a gateway the cost engine knows about.',
  bad_scope: 'A rate is either variant-scoped or group-scoped.',
  bad_day: 'The day must be a real YYYY-MM-DD date.',
  bad_action: 'A campaign map action is pin or unpin.',
  usd_only: 'Only USD rates are supported in v1.',
  window_too_small: 'The detection window must be at least 30 days.',
  // ── cost groups ──
  name_required: 'A cost group needs a name.',
  too_few_members: 'A cost group needs at least two variants — one variant does not need a group.',
  too_many_members: 'That is more variants than one cost group can hold.',
  bad_members: 'The member list is not in a shape the server understands.',
  bad_units_per: 'Units per variant must be a whole number of 1 or more.',
  group_not_found: 'That cost group no longer exists.',
  group_archived: 'Un-archive this group before binding variants to it.',
  bad_cost_item_id: 'That does not look like a cost group id.',
  unknown_proposal: 'That suggestion no longer exists — re-run detection.',
  bad_proposal_id: 'That does not look like a suggestion id.',
  already_accepted: 'That suggestion has already become a group.',
  bad_status: 'That is not a status the suggestions list knows about.',
  no_members: 'Name at least one variant.',
  name_taken: 'Another live cost group already has that name.',
  variant_in_other_group: 'That variant is already in another cost group — confirm the move to take it.',
  item_not_found: 'That cost group does not exist, so a rate for it would reach nothing.',
  item_archived: 'That cost group is archived — un-archive it before entering a cost.',
  empty_patch: 'Nothing to change.',
  unknown_field: 'That field cannot be edited here.',
};

/**
 * Error prose (M5). The contract's error shape is `{success:false,
 * error:{code}}` — read `data?.error?.code`, map it through API_ERRORS, and
 * fall back to GENERIC prose when the code is absent or unknown. A raw
 * machine code never reaches the operator's screen.
 */
export function costApiError(err, fallback = 'The cost API rejected that.') {
  const data = err?.response?.data;
  const code = data?.error?.code;
  if (typeof code === 'string' && code && API_ERRORS[code]) return API_ERRORS[code];
  if (err?.response?.status === 403) return 'You need funnels access to change costs.';
  if (err?.response) return fallback;
  if (err?.message) return `${fallback} (${err.message})`;
  return fallback;
}
