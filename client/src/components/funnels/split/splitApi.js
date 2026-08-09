// Split-test operator surfaces — data access + the analytics CONTRACT.
//
// Everything the setup modal, the canvas A/B node and the results modal read
// goes through here, so there is exactly one place that knows the shape of the
// two backends they talk to:
//
//   1. /api/v1/split-tests/*        — this lane owns it. Tests, arms, handle,
//                                     domain, entry arm, lifetime ledger
//                                     results. Always present.
//   2. /api/v1/funnel-analytics/... — the ANALYTICS lane owns it. Windowed
//                                     per-arm metrics + the verdict. May not
//                                     exist yet. EVERY caller must survive its
//                                     absence: see fetchSplitMetrics.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ANALYTICS CONTRACT — verified against the MERGED implementation
// (server/src/routes/funnelAnalytics.js + services/funnelAnalytics.js +
//  services/analyticsStats.js), not against a guess.
//
//   GET /api/v1/funnel-analytics/split/:testId/results?from=YYYY-MM-DD&to=YYYY-MM-DD
//
//   ⚠️ THE PAYLOAD IS TOP-LEVEL, NOT WRAPPED. funnelAnalytics.js's `send()` is
//   `res.json(result)` — there is no { success, data } envelope, unlike every
//   other route in this app. Reading `res.data.data` yields undefined and the
//   whole feature renders empty. `readEnvelope()` below tolerates BOTH shapes so
//   a future envelope change cannot break it either.
//
//   200 {
//     test:    { id, funnel_id, name, scope, enabled, archived },
//     window:  { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', days, basis },
//     arms: [{
//       arm_key, is_control, archived, weight, page_id, offer_id,
//       visitors, distinct_visitors, submits, submit_rate,
//       orders, cvr, cvr_withheld,
//       aov_pre_upsell, aov_post_upsell, aov_reason,
//       upsell_legs, upsell_buyers, upsell_declined_legs,
//       upsell_refunded_legs, upsell_revenue,
//       base_revenue, gross_revenue, refunded, base_refunded, upsell_refunded,
//       net_revenue, rev_per_visitor, vs_control_rpv_pct,
//       net_revenue_sum, net_revenue_sum_squares, net_revenue_variance
//     }],
//     totals, ledger, meta, warnings: [], degraded: bool,
//     verdict: {
//       status: 'winner'|'no_winner'|'not_ready'|'no_data'|'insufficient_arms',
//       headline,           // COMPLETE PROSE — render it, do not compose around it
//       leader, control, ranked: [],
//       conversion, revenue, sample, requiredSamplePerArm,
//       perArm: { [arm_key]: { conversion_confidence, revenue_confidence,
//                              significant, significant_uncorrected,
//                              requiredSamplePerArm } }
//     },
//     disclosure: { test_created_at, tracking_started_at,
//                   tracking_started_after_test, note, window_only,
//                   visitors_understated, visitors_basis }
//   }
//
//   404 / 501 / network error → METRICS UNAVAILABLE. Not an error to escalate:
//   a funnel with no analytics rows, or an older deploy, legitimately 404s.
//
// ⚠️⚠️ UNIT SCALE — THE 100× TRAP.
// funnelAnalytics.js's `rate()` returns FRACTIONS in [0,1], and analyticsStats'
// `confidence` is `1 - pValue`, also a fraction. So `cvr: 0.0432` MEANS 4.32%
// and `revenue_confidence: 0.97` MEANS 97%. Formatting those with a percent
// formatter prints "0.04%" and "0.97%" — off by 100×, and in the direction that
// makes a decisive result look like noise. Every fraction is therefore
// converted EXACTLY ONCE, here at the boundary, by `fracToPct()`.
//
// `vs_control_rpv_pct` is the exception: the service already multiplies by 100
// (`Math.round(x * 1000) / 10`), so it is ALREADY a percent and must NOT be
// converted again. Converting it would be the same bug in reverse.
//
// Fields that DO NOT EXIST on the merged endpoint and must never be invented:
//   submits_today, submit_attributable, conv_rate, vs_control_pct, revenue,
//   confidence (per arm), verdict.body, verdict.winner_arm_key,
//   verdict.significance, test_id, from, to.
import api from '../../../services/api';

// ── Split-test CRUD (this lane's own API) ─────────────────────────────────
export async function fetchFunnelSplitTests(funnelId) {
  const res = await api.get('/split-tests', { params: { funnel_id: funnelId, with_arms: 1 } });
  return res.data?.data || [];
}

export async function fetchSplitTest(testId) {
  const res = await api.get(`/split-tests/${encodeURIComponent(testId)}`);
  return res.data?.data || null;
}

export async function patchSplitTest(testId, patch) {
  const res = await api.patch(`/split-tests/${encodeURIComponent(testId)}`, patch);
  return res.data?.data || null;
}

export async function patchSplitArm(testId, armId, patch) {
  const res = await api.patch(
    `/split-tests/${encodeURIComponent(testId)}/arms/${encodeURIComponent(armId)}`,
    patch
  );
  return res.data?.data || null;
}

export async function addSplitArm(testId, arm) {
  const res = await api.post(`/split-tests/${encodeURIComponent(testId)}/arms`, arm);
  return res.data?.data || null;
}

export async function setSplitEntryArm(testId, armId) {
  const res = await api.post(
    `/split-tests/${encodeURIComponent(testId)}/arms/${encodeURIComponent(armId)}/entry`
  );
  return res.data?.data || null;
}

export async function fetchEligiblePages(funnelId, testId) {
  const res = await api.get('/split-tests/eligible-pages', {
    params: { funnel_id: funnelId, ...(testId ? { test_id: testId } : {}) },
  });
  return res.data?.data || { pages: [], counts: {} };
}

/** Lifetime, ledger-derived per-arm figures. Always available. */
export async function fetchLifetimeResults(testId) {
  const res = await api.get(`/split-tests/${encodeURIComponent(testId)}/results`);
  return res.data?.data || null;
}

// ── The analytics overlay (the analytics lane's API — merged; may still 404) ─

/**
 * Unwrap a response body that may or may not carry this app's usual
 * { success, data } envelope. funnelAnalytics.js answers TOP-LEVEL
 * (`res.json(result)`), so `body.data` is undefined there — reading only
 * `body.data` silently turned every successful call into "no metrics".
 * Accepting both shapes means neither side can break the other by changing it.
 */
export function readEnvelope(body) {
  if (!body || typeof body !== 'object') return null;
  // An envelope is only an envelope if `data` is itself an object/array.
  if (body.data && typeof body.data === 'object') return body.data;
  return body;
}

/**
 * Windowed metrics + verdict. NEVER throws for an absent endpoint.
 * @returns {Promise<{available: boolean, reason?: string, data?: object}>}
 */
export async function fetchSplitMetrics(testId, { from, to } = {}) {
  try {
    const res = await api.get(`/funnel-analytics/split/${encodeURIComponent(testId)}/results`, {
      params: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
    });
    const raw = readEnvelope(res.data);
    // `arms` is the load-bearing key. A 200 without it is a shape we do not
    // understand, and rendering a table from it would invent numbers.
    if (!raw || !Array.isArray(raw.arms)) return { available: false, reason: 'unrecognised_shape' };
    return { available: true, data: normalizeMetrics(raw) };
  } catch (err) {
    const status = err?.response?.status;
    // 404 = no such test / older deploy. Anything else is reported with its
    // status so the operator sees WHY, but the surface degrades identically
    // rather than crashing.
    return { available: false, reason: status ? `http_${status}` : 'network_error' };
  }
}

// Read `obj[snake]` or its camelCase twin. Returns undefined when neither is
// present — undefined is the '—' signal all the way through the renderers.
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  const c = camel(key);
  if (obj[c] !== undefined && obj[c] !== null) return obj[c];
  return undefined;
}

// Coerce to a finite number or undefined. A string '12.5' is accepted (a JSON
// numeric from Postgres NUMERIC arrives as a string through postgres.js);
// NaN/Infinity/null/'' all become undefined, which renders '—'.
export function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Values that crossed the fraction→percent boundary on a scale we did not expect. */
export const scaleAnomalies = [];

/**
 * THE 100× GUARD. Convert a fraction in [0,1] to a percent, exactly once.
 *
 * A fraction is by definition ≤ 1 (a hair over is rounding). A value above the
 * tolerance is ALREADY a percent — converting it again would report 9700%. So
 * instead of multiplying blindly this passes it through and records the
 * anomaly, which is what a scale change upstream actually looks like.
 *
 * The failure this exists to prevent is asymmetric: rendering 0.97 as "0.97%"
 * turns a decisive 97%-confidence result into apparent noise, and nothing on
 * screen looks wrong. `assertPercentScale` below is the executable form of
 * that invariant.
 */
export const FRACTION_TOLERANCE = 1.5;
export function fracToPct(v, field = 'value') {
  const n = num(v);
  if (n === undefined) return undefined;
  if (Math.abs(n) > FRACTION_TOLERANCE) {
    scaleAnomalies.push({ field, value: n });
    return n; // already a percent — do not double-convert
  }
  return Math.round(n * 1e6) / 1e4; // 0.0432 -> 4.32
}

/**
 * Executable invariant, exercised by the verification harness:
 * a confidence expressed as a fraction must NEVER render below 1%.
 * Returns a list of failures (empty === healthy).
 */
export function assertPercentScale() {
  const failures = [];
  const cases = [
    { name: 'confidence 0.97', raw: 0.97, expect: 97 },
    { name: 'confidence 1', raw: 1, expect: 100 },
    { name: 'cvr 0.0432', raw: 0.0432, expect: 4.32 },
    { name: 'cvr 0', raw: 0, expect: 0 },
    { name: 'already-percent 97 passes through', raw: 97, expect: 97 },
  ];
  for (const c of cases) {
    const got = fracToPct(c.raw, c.name);
    if (Math.abs(got - c.expect) > 1e-9) failures.push(`${c.name}: got ${got}, want ${c.expect}`);
  }
  // The specific regression: a non-zero fraction confidence must not render sub-1%.
  if (fracToPct(0.97, 'regression') < 1) failures.push('0.97 confidence rendered below 1%');
  return failures;
}

// Arm fields that are plain numbers (money, counts, or an ALREADY-percent value).
const ARM_PASSTHROUGH_KEYS = [
  'visitors', 'distinct_visitors', 'submits', 'orders',
  'aov_pre_upsell', 'aov_post_upsell',
  'upsell_legs', 'upsell_buyers', 'upsell_declined_legs', 'upsell_refunded_legs',
  'upsell_revenue', 'base_revenue', 'gross_revenue',
  'refunded', 'base_refunded', 'upsell_refunded',
  'net_revenue', 'rev_per_visitor',
  // ALREADY a percent (service multiplies by 100) — never fracToPct this.
  'vs_control_rpv_pct',
];
// Arm fields that arrive as FRACTIONS and must cross fracToPct exactly once.
const ARM_FRACTION_KEYS = ['submit_rate', 'cvr'];

export function normalizeMetrics(raw) {
  const armsRaw = Array.isArray(pick(raw, 'arms')) ? pick(raw, 'arms') : [];
  const v = pick(raw, 'verdict') || {};
  const perArm = pick(v, 'perArm') || {};
  const d = pick(raw, 'disclosure') || {};
  const w = pick(raw, 'window') || {};
  const t = pick(raw, 'test') || {};

  const arms = armsRaw.map((a) => {
    const key = String(pick(a, 'arm_key') ?? '');
    const out = {
      arm_key: key,
      is_control: Boolean(pick(a, 'is_control')),
      archived: Boolean(pick(a, 'archived')),
      // Reasons the service gives for a deliberately-absent number. Rendering
      // these is the difference between "0" and "we chose not to say".
      cvr_withheld: Boolean(pick(a, 'cvr_withheld')),
      aov_reason: pick(a, 'aov_reason') ?? undefined,
    };
    for (const k of ARM_PASSTHROUGH_KEYS) out[k] = num(pick(a, k));
    for (const k of ARM_FRACTION_KEYS) out[k] = fracToPct(pick(a, k), k);
    // CONFIDENCE IS NOT ON THE ARM. It lives on verdict.perArm[arm_key], is
    // per-arm on purpose (a single scalar would paint arm C with arm B's
    // number), and is a FRACTION.
    const pa = perArm[key] || {};
    out.confidence = fracToPct(pick(pa, 'revenue_confidence'), 'revenue_confidence');
    out.significant = pick(pa, 'significant');
    return out;
  });

  return {
    test: { id: pick(t, 'id'), name: pick(t, 'name'), scope: pick(t, 'scope') },
    window: { from: pick(w, 'from'), to: pick(w, 'to'), days: num(pick(w, 'days')) },
    arms,
    totals: pick(raw, 'totals') || {},
    verdict: {
      // COMPLETE PROSE from the service. The UI renders it; it does not
      // compose a second sentence around it (they contradicted each other).
      status: pick(v, 'status') || undefined,
      headline: pick(v, 'headline'),
      leader: pick(v, 'leader'),
      control: pick(v, 'control'),
      ranked: Array.isArray(pick(v, 'ranked')) ? pick(v, 'ranked') : [],
      requiredSamplePerArm: num(pick(v, 'requiredSamplePerArm')),
      sample: pick(v, 'sample') || {},
    },
    disclosure: {
      tracking_started_at: pick(d, 'tracking_started_at'),
      tracking_started_after_test: Boolean(pick(d, 'tracking_started_after_test')),
      test_created_at: pick(d, 'test_created_at'),
      visitors_basis: pick(d, 'visitors_basis'),
      visitors_understated: Boolean(pick(d, 'visitors_understated')),
    },
    warnings: Array.isArray(pick(raw, 'warnings')) ? pick(raw, 'warnings') : [],
    degraded: Boolean(pick(raw, 'degraded')),
  };
}

// ── Formatting ────────────────────────────────────────────────────────────
export const DASH = '—';

export function fmtInt(v) {
  const n = num(v);
  return n === undefined ? DASH : Math.round(n).toLocaleString('en-US');
}

export function fmtMoney(v, { signed = false } = {}) {
  const n = num(v);
  if (n === undefined) return DASH;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return `-$${s}`;
  return signed ? `+$${s}` : `$${s}`;
}

export function fmtPct(v, { digits = 2, signed = false } = {}) {
  const n = num(v);
  if (n === undefined) return DASH;
  const s = `${Math.abs(n).toFixed(digits)}%`;
  if (n < 0) return `-${s}`;
  return signed && n > 0 ? `+${s}` : s;
}

export function fmtDate(v) {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(v) {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** ISO yyyy-mm-dd for a date input, in LOCAL time (the picker's own frame). */
export function isoDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// ── Handle safety ─────────────────────────────────────────────────────────
// The server bounds a handle to this charset on write. This is the READ-side
// twin: a row written before that validation existed (or by anything other
// than this API) must never reach an href. Text rendering is always safe —
// React escapes it — but an href is a SINK, so a handle that does not match is
// rendered as inert text instead of a link.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isSafeHandle(h) {
  return typeof h === 'string' && HANDLE_RE.test(h);
}
/** The public path for a handle, or null when it is not link-safe. */
export function handlePath(h) {
  return isSafeHandle(h) ? `/${h}` : null;
}

/** Arm letter from its index: A, B, C … then AA (never runs out, never NaN). */
export function armLetter(index) {
  let i = Number(index);
  if (!Number.isInteger(i) || i < 0) return '?';
  let out = '';
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

/** Do the arm weights sum to 100? Returns { sum, ok }. */
export function weightSum(arms) {
  const sum = (arms || [])
    .filter((a) => !a.archived)
    .reduce((acc, a) => acc + (num(a.weight) ?? 0), 0);
  return { sum: Math.round(sum * 100) / 100, ok: Math.abs(sum - 100) < 0.01 };
}
