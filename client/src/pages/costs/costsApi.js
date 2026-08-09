// costsApi — the ONE place the Costs/P&L workspace names a backend route
// (NEW FILE, costs lane).
//
// Built against the Lane-1 contract documented in the COGS work order:
// routes/funnelCosts.js mounted at /api/v1/funnel-costs (our axios instance
// already carries the /api/v1 baseURL). The server lane builds in parallel, so
// every path and body below codes to the DOCUMENTED shapes; where the work
// order leaves a key ambiguous we follow the reference implementation's JSON
// and say so inline. Full integration verification happens post-merge.
//
// ── Routes ────────────────────────────────────────────────────────────────
//   GET    /variants ?coverage&context&funnel_id&q&limit&offset
//          -> { items: VariantCostRow[], total, limit, offset }   (reference shape)
//   GET    /by-funnel                 -> { funnels: [...] }
//   GET    /coverage-summary          -> { total, needs_cost, ready, ignored,
//                                          coverage_pct, revenue_at_risk_30d,
//                                          units_at_risk_30d }
//   POST   /detect ?days              -> { variants, inserted, updated, ran_at, … }
//   GET    /rates ?variant_id&limit   -> { items, count }
//   POST   /rates                     body { scope, variant_id?, cost_item_id?,
//                                       unit_cogs: number|null (NEVER blank→0),
//                                       ship: {default,main,upsell,addon,bump},
//                                       effective_from?, only_from_today?,
//                                       currency, source, note? }
//   GET    /rates/history/:variantId  -> { variant_id, items, count }
//   GET    /fee-settings              -> { default:{pct,fixed}, gateways:{gw:{pct,fixed}|null}, … }
//   PATCH  /fee-settings              body { default?, gateways? } (null clears an override)
//   PATCH  /variants/:id              operator fields only: { pays_shipping?, ignored?, kind_override? }
//   GET    /pnl/overview ?start&end   -> { rows: [...], totals } — per-funnel rows
//          {fid,name,revenue,gross_sales,orders,cogs,fees,ship_cost,gp,gp_margin,
//           cost_coverage_pct,spend,spend_known,net_profit,roas,cpa};
//          gp/gp_margin NULL at zero coverage (rendered as a dash, never 100%).
//   GET    /pnl/funnel/:fid ?start&end -> { totals, daily: [...], campaigns: [...],
//                                          manual_entries: [...] }
//          (key names chosen here; `rowsOf`-style tolerant readers below accept
//           `series`/`manual` as aliases so a Lane-1 rename is a no-op)
//   GET    /spend/status              -> { sources: [{source,last_sync,last_ok,
//                                          error,fail_streak,stale}] } (stale ≥6h)
//   POST   /spend/sync ?days          -> background kick, returns { started } or state
//   POST   /campaign-map              body { campaign_id, funnel_id?, action:'pin'|'unpin' }
//   POST   /pnl/funnel/:fid/spend-manual        body { day, spend, note? }
//   DELETE /pnl/funnel/:fid/spend-manual/:day
// Explicit .js extension so the node harness (scripts/verifyCostsUi.mjs) can
// import this module directly; Vite resolves it identically.
import api from '../../services/api.js';

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

/** Seeded gateways, in the order the fee card renders them (lb_fee_settings). */
export const GATEWAYS = [
  { key: 'whop', label: 'Whop' },
  { key: 'stripe', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'nmi', label: 'NMI' },
];

export function fetchVariants(params = {}) {
  return api.get(COSTS_ROUTES.variants, { params }).then(({ data }) => data);
}

export function fetchByFunnel(params = {}) {
  return api.get(COSTS_ROUTES.byFunnel, { params }).then(({ data }) => data);
}

export function fetchCoverageSummary() {
  return api.get(COSTS_ROUTES.coverageSummary).then(({ data }) => data);
}

/** `days` omitted = the backend's configured default window (90d SOLD sweep). */
export function postDetect(days) {
  return api
    .post(COSTS_ROUTES.detect, null, days ? { params: { days } } : undefined)
    .then(({ data }) => data);
}

/**
 * Append a rate. There is no "edit" — an edit is a new row, so history is
 * always reconstructible and a backdated change cannot silently rewrite last
 * quarter's gross profit. `unit_cogs: null` means UNKNOWN and must reach the
 * wire as null; this module never coerces it.
 */
export function postRate(body) {
  return api.post(COSTS_ROUTES.rates, body).then(({ data }) => data);
}

/** Newest-first history for a variant (server folds in group-scope rows). */
export function fetchRateHistory(variantId) {
  return api.get(COSTS_ROUTES.rateHistory(variantId)).then(({ data }) => data);
}

export function fetchFeeSettings() {
  return api.get(COSTS_ROUTES.feeSettings).then(({ data }) => data);
}

export function patchFeeSettings(body) {
  return api.patch(COSTS_ROUTES.feeSettings, body).then(({ data }) => data);
}

/** Operator-owned columns only: { pays_shipping?, ignored?, kind_override? }. */
export function patchVariant(variantId, body) {
  return api.patch(COSTS_ROUTES.variant(variantId), body).then(({ data }) => data);
}

/* ── P&L ───────────────────────────────────────────────────────────────── */

export function fetchPnlOverview({ start, end }) {
  return api.get(COSTS_ROUTES.pnlOverview, { params: { start, end } }).then(({ data }) => data);
}

export function fetchPnlFunnel(fid, { start, end }) {
  return api.get(COSTS_ROUTES.pnlFunnel(fid), { params: { start, end } }).then(({ data }) => data);
}

export function fetchSpendStatus() {
  return api.get(COSTS_ROUTES.spendStatus).then(({ data }) => data);
}

export function postSpendSync(days) {
  return api
    .post(COSTS_ROUTES.spendSync, null, days ? { params: { days } } : undefined)
    .then(({ data }) => data);
}

/** Pin a campaign to a funnel, or drop the pin (derived binding resumes). */
export function postCampaignMap({ campaign_id, funnel_id, action }) {
  return api
    .post(COSTS_ROUTES.campaignMap, { campaign_id, funnel_id, action })
    .then(({ data }) => data);
}

export function postManualSpend(fid, { day, spend, note }) {
  return api.post(COSTS_ROUTES.manualSpend(fid), { day, spend, note }).then(({ data }) => data);
}

export function deleteManualSpend(fid, day) {
  return api.delete(COSTS_ROUTES.manualSpendDay(fid, day)).then(({ data }) => data);
}

/* ── tolerant readers + errors ─────────────────────────────────────────── */

/** Rows out of any of the shapes a list endpoint might legally return. */
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

/** The drill-in's daily series, whatever Lane 1 called the key. */
export function dailyOf(data) {
  if (Array.isArray(data?.daily)) return data.daily;
  if (Array.isArray(data?.series)) return data.series;
  if (Array.isArray(data?.days)) return data.days;
  return [];
}

/** The drill-in's manual spend entries. */
export function manualOf(data) {
  if (Array.isArray(data?.manual_entries)) return data.manual_entries;
  if (Array.isArray(data?.manual)) return data.manual;
  return [];
}

/** The spend-status sources list, `{sources:[…]}` or a bare array. */
export function sourcesOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sources)) return data.sources;
  return [];
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
};

export function costApiError(err, fallback = 'The cost API rejected that.') {
  const data = err?.response?.data;
  const detail = data?.error || data?.detail || data?.message;
  if (typeof detail === 'string' && detail) return API_ERRORS[detail] || detail;
  if (err?.response?.status === 403) return 'You need funnels access to change costs.';
  if (err?.message) return `${fallback} (${err.message})`;
  return fallback;
}
