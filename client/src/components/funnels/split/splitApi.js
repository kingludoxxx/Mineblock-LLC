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
// THE ANALYTICS CONTRACT (coded against; documented in the delivery report)
//
//   GET /api/v1/funnel-analytics/split/:testId/results?from=YYYY-MM-DD&to=YYYY-MM-DD
//
//   200 { success: true, data: {
//     test_id, from, to,
//     arms: [{
//       arm_key, is_control,
//       visitors, submits, submits_today, submit_rate, submit_attributable,
//       orders, conv_rate, aov_pre_upsell,
//       upsell_legs, upsell_buyers, upsell_revenue, upsell_refunded,
//       aov_post_upsell, revenue, refunded, net_revenue,
//       rev_per_visitor, vs_control_pct, confidence
//     }],
//     verdict: { status: 'winner'|'no_winner'|'insufficient_data',
//                winner_arm_key, significance, significant, confidence,
//                required_sample_per_arm, headline, body },
//     disclosure: { tracking_started_at, tracking_started_after_test,
//                   test_created_at }
//   }}
//
//   404 / 501 / network error → METRICS UNAVAILABLE. Not an error state to
//   escalate: the endpoint legitimately does not exist before that lane merges.
//
// Two deliberate robustness choices, because this contract is being built in
// PARALLEL by another lane and I cannot re-probe it:
//   • every field is read through `pick()`, which accepts the snake_case name
//     OR its camelCase twin. A casing disagreement between two lanes must not
//     render an entire results table as '—';
//   • every field is OPTIONAL. A missing field renders '—' in exactly one
//     cell. There is no shape assertion that can fail the whole modal.
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

// ── The analytics overlay (another lane's API — may 404) ──────────────────
/**
 * Windowed metrics + verdict. NEVER throws for an absent endpoint.
 * @returns {Promise<{available: boolean, reason?: string, data?: object}>}
 */
export async function fetchSplitMetrics(testId, { from, to } = {}) {
  try {
    const res = await api.get(`/funnel-analytics/split/${encodeURIComponent(testId)}/results`, {
      params: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
    });
    const raw = res.data?.data;
    if (!raw) return { available: false, reason: 'empty_response' };
    return { available: true, data: normalizeMetrics(raw) };
  } catch (err) {
    const status = err?.response?.status;
    // 404/501 mean "not built yet" — the designed, expected state. Anything
    // else is reported with its status so the operator sees WHY, but the
    // surface still degrades to the same '—' table rather than crashing.
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

const ARM_METRIC_KEYS = [
  'visitors', 'submits', 'submits_today', 'submit_rate', 'submit_attributable',
  'orders', 'conv_rate', 'aov_pre_upsell',
  'upsell_legs', 'upsell_buyers', 'upsell_revenue', 'upsell_refunded',
  'aov_post_upsell', 'revenue', 'refunded', 'net_revenue',
  'rev_per_visitor', 'vs_control_pct', 'confidence',
];

export function normalizeMetrics(raw) {
  const armsRaw = Array.isArray(pick(raw, 'arms')) ? pick(raw, 'arms') : [];
  const arms = armsRaw.map((a) => {
    const out = {
      arm_key: String(pick(a, 'arm_key') ?? ''),
      is_control: Boolean(pick(a, 'is_control')),
    };
    for (const k of ARM_METRIC_KEYS) out[k] = num(pick(a, k));
    return out;
  });
  const v = pick(raw, 'verdict') || {};
  const d = pick(raw, 'disclosure') || {};
  return {
    test_id: pick(raw, 'test_id'),
    from: pick(raw, 'from'),
    to: pick(raw, 'to'),
    arms,
    verdict: {
      status: pick(v, 'status') || undefined,
      winner_arm_key: pick(v, 'winner_arm_key'),
      significance: num(pick(v, 'significance')),
      significant: pick(v, 'significant'),
      confidence: num(pick(v, 'confidence')),
      required_sample_per_arm: num(pick(v, 'required_sample_per_arm')),
      headline: pick(v, 'headline'),
      body: pick(v, 'body'),
    },
    disclosure: {
      tracking_started_at: pick(d, 'tracking_started_at'),
      tracking_started_after_test: Boolean(pick(d, 'tracking_started_after_test')),
      test_created_at: pick(d, 'test_created_at'),
    },
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
