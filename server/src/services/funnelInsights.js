// FUNNEL INSIGHTS — the deterministic detector layer (LANE 5, SELF-CONTAINED,
// NEW FILE).
//
// Six detectors, no LLM anywhere, ported from the reference implementation
// (funnel-os `lb_insights_service.py`) onto THIS build's data. Each detector
// emits at most one card; the list is ranked by severity (bad → warn → good →
// info, then by spec order) and hard-capped at MAX_CARDS.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE TRUTH LAYER IS funnelMetrics.runQuery — NOTHING ELSE
// ═══════════════════════════════════════════════════════════════════════════
// Every metric a detector judges comes out of the SAME engine the dashboard
// and the explorer read, through the SAME `runQuery` door: the isolated
// analytics pool (analyticsDb, max 2 connections, server-side
// statement_timeout, no shared circuit breaker), REPORT_TZ day buckets, and
// the engine's tri-state nulls. This file adds no second way to count money.
//
// It is READ-ONLY, exactly like its truth layer: not one INSERT/UPDATE/DELETE,
// here or in its route. The reference CACHED its cards in a Mongo collection
// (`lb_insights_daily`, 6h TTL) — that is the ONE thing deliberately NOT
// ported. See DECISION 1 below.
//
// ═══════════════════════════════════════════════════════════════════════════
// WITHHOLD RATHER THAN INVENT — WHERE THIS PORT DIFFERS FROM ITS REFERENCE
// ═══════════════════════════════════════════════════════════════════════════
// The reference reads every metric as `float(point.get(metric) or 0)`. On an
// engine whose whole contract is "null is not zero", that coercion is the
// absent-means-zero lie wearing a detector's clothes, and it is not
// hypothetical here:
//
//   · A window past the 90-day lb_touches retention returns a FULL series of
//     `sessions: null`. Coerced, that is 28 days of "zero visitors" — a flat
//     baseline with σ = 0 on the good days and a spectacular ±2σ "sessions
//     collapsed to 0" card on the bad ones. Both are fabrications about a
//     measurement that merely expired.
//   · `first_sale` fires when EVERY baseline day had zero orders. Coerced, a
//     baseline of withheld days reads as a zero baseline, and the page
//     celebrates a first sale for an account that has been selling for a year.
//
// So this port reads NULL AS NOT MEASURED, everywhere:
//   · a null baseline point is EXCLUDED from the baseline (and the remaining
//     count is re-checked against the floor, so a mostly-withheld baseline
//     simply does not clear it);
//   · a null CURRENT value means the detector cannot fire at all;
//   · `first_sale` additionally requires every baseline day to be MEASURED
//     and zero — a withheld day is not a day at zero.
//
// Each such deviation is tagged DEVIATION in the detector it belongs to and is
// published on `/funnel-insights/definitions` so the rule table is readable
// from the running server rather than only from this comment.
//
// ═══════════════════════════════════════════════════════════════════════════
// DECISIONS
// ═══════════════════════════════════════════════════════════════════════════
// 1. NO CACHE. The reference upserts one doc per (workspace, day) and serves
//    it for six hours. This lane is READ-ONLY over the money database and owns
//    no table; caching would mean a migration, a write path and a staleness
//    window on numbers the operator moves budget on. The composite that feeds
//    these detectors is ~1 query family on the isolated pool and the route is
//    behind the same 30/min limiter as the rest of the metrics surface, so the
//    cost of recomputing is bounded and visible (`meta.computed_ms`).
//
// 2. NO SILENT DEGRADATION. The reference "NEVER raises" — every detector
//    failure is swallowed and an empty list is returned, which renders as
//    "nothing to report" over a subsystem that is on fire. Here, a detector
//    that throws is CAUGHT and NAMED: the card list loses that detector and
//    `meta.degraded[]` says which one and why. An empty strip with a named
//    degradation is a different claim from an empty strip without one.
//
// 3. THRESHOLDS ARE CONSTANTS, NOT PROSE. Every floor below is a named export
//    (`THRESHOLDS`), pinned by server/tests/insights/detectors.mjs and served
//    on /definitions. The reference's numbers are carried over unchanged; the
//    two that had to change shape are marked ADAPTED with the reason.
import {
  runQuery,
  todayInTz,
  zonedDayStart,
  REPORT_TIMEZONE,
  REPORT_TZ,
  MetricsError,
} from './funnelMetrics.js';
import { analyticsQuery } from './analyticsDb.js';

// ═══════════════════════════════════════════════════════════════════════════
// Thresholds — ported verbatim unless marked
// ═══════════════════════════════════════════════════════════════════════════

/** How many cards the strip may ever carry (reference: MAX_CARDS = 6). */
export const MAX_CARDS = 6;

/** The trailing baseline every detector judges "today" against. */
export const BASELINE_DAYS = 28;

/** The long series the last-60 card draws (this build's addition). */
export const LAST_N_DAYS = 60;

/**
 * Every floor, in one frozen object, so the rule table is data.
 *
 * `source: 'reference'` means the number is the reference implementation's,
 * unchanged. `source: 'adapted'` means the RULE had to change shape for this
 * build's data and the note says why.
 */
export const THRESHOLDS = Object.freeze({
  anomaly_sigma: Object.freeze({
    value: 2,
    source: 'reference',
    note: 'a day outside mean ± 2σ of the trailing 28-day baseline',
  }),
  anomaly_min_baseline: Object.freeze({
    value: 7,
    source: 'reference',
    note: 'MEASURED baseline days required before ±2σ means anything; a null day is not a day',
  }),
  aov_shift_min_pct: Object.freeze({
    value: 20,
    source: 'reference',
    note: '|AOV delta| vs the baseline mean that counts as a shift',
  }),
  aov_min_baseline: Object.freeze({
    value: 5,
    source: 'reference',
    note: 'baseline days WITH orders and a measured AOV required for an AOV baseline',
  }),
  leak_min_day_hits: Object.freeze({
    value: 10,
    source: 'reference',
    note: 'visitors on the UPSTREAM step today before a step-to-step drop is callable',
  }),
  leak_min_base_hits: Object.freeze({
    value: 50,
    source: 'reference',
    note: 'visitors on the UPSTREAM step across the baseline before it is a baseline',
  }),
  leak_drop_ratio: Object.freeze({
    value: 0.5,
    source: 'reference',
    note: "today's step-through must fall BELOW half the baseline's to be a leak",
  }),
  dead_rail_window_days: Object.freeze({
    value: 7,
    source: 'reference',
    note: 'the delivery window a rail is judged silent over',
  }),
  mover_min_abs_delta: Object.freeze({
    value: 0.01,
    source: 'adapted',
    note: 'a delta below one cent is rounding, not a move',
  }),
  funnel_scan_cap: Object.freeze({
    value: 200,
    source: 'adapted',
    note: 'breakdown rows read per detector pass (the engine\'s own MAX_BREAKDOWN_LIMIT)',
  }),
});

/** Ranking: bad first, then warn, good, info (reference `_SEVERITY_RANK`). */
const SEVERITY_RANK = Object.freeze({ bad: 0, warn: 1, good: 2, info: 3 });
export const SEVERITIES = Object.freeze(['bad', 'warn', 'good', 'info']);

/**
 * The metrics the ±2σ test walks, IN ORDER — first anomaly wins.
 * `[metric, sentence label, format, severity when DOWN]`.
 * A net-sales fall is `bad`; the other two are `warn` (reference's rule).
 */
const ANOMALY_METRICS = Object.freeze([
  Object.freeze({ metric: 'net_sales', label: 'Net sales', format: 'money', down: 'bad' }),
  Object.freeze({ metric: 'orders', label: 'Orders', format: 'int', down: 'warn' }),
  Object.freeze({ metric: 'sessions', label: 'Sessions', format: 'int', down: 'warn' }),
]);

/** The day-series metrics one read serves every detector (and the last-60 card). */
export const SERIES_METRICS = Object.freeze([
  'net_sales', 'orders', 'sessions', 'aov', 'spend', 'net_profit',
]);

/**
 * The step vocabulary, IDENTICAL to funnelMetrics' own waterfall
 * (`STEP_ORDER` / `TYPE_TO_STEP`). Duplicated rather than imported because
 * that module keeps them private and this lane's fence is create-only — and it
 * is PINNED BY EXECUTION: server/tests/insights/detectors.mjs reads
 * funnelMetrics.js off disk and asserts these literals appear in it. If anyone
 * re-orders the funnel there, that assertion fails here.
 */
export const STEP_ORDER = Object.freeze([
  'listicle', 'product', 'checkout', 'upsell', 'downsell', 'thankyou',
]);
export const STEP_LABELS = Object.freeze({
  listicle: 'Landing', product: 'Product', checkout: 'Checkout',
  upsell: 'Upsell', downsell: 'Downsell', thankyou: 'Thank you', other: 'Other',
});
const TYPE_TO_STEP = Object.freeze({
  lead: 'listicle', listicle: 'listicle', optin: 'listicle', quiz: 'listicle', generic: 'listicle',
  product: 'product', checkout: 'checkout', upsell: 'upsell', downsell: 'downsell', thankyou: 'thankyou',
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers — every one of them null-safe, none of them coercing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A MEASUREMENT, or null.
 *
 * ⚠️ THE WHOLE PORT TURNS ON THIS FUNCTION. `Number(null)` is 0 and
 * `Number('')` is 0, so the reference's `or 0` idiom silently converts every
 * withheld figure into a confident zero. Here, anything that is not a finite
 * number is `null` and every caller has to decide what to do about it.
 */
export const measured = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const money2 = (v) => Math.round(Number(v) * 100) / 100;

/** A percentage, or null when the denominator cannot support one. */
const pct = (numer, denom) => (denom > 0 ? Math.round((numer / denom) * 1e6) / 1e4 : null);

/** Population standard deviation (the reference uses `statistics.pstdev`). */
export function pstdev(values) {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const varsum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(varsum / n);
}

export const fmean = (values) =>
  (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Shift a YYYY-MM-DD day by n calendar days.
 * Anchored at UTC noon so a ±1h DST shift can never move it onto a different
 * calendar date — the same reason the engine's own `dayAdd` does it.
 */
export const dayAdd = (day, n) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day string, or null. Rejects 2026-13-99 as well as junk. */
export function validDay(v) {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!DAY_RE.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

const fmtMoney = (v) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (v) => Number(Math.round(v)).toLocaleString('en-US');
const fmtMean = (v, format) =>
  (format === 'money' ? fmtMoney(v) : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtPct1 = (v) => `${Number(v).toFixed(1)}%`;

/** "today" when the card's day IS today in REPORT_TZ, "on 2026-08-04" otherwise. */
export const whenOf = (day, today) => (day === today ? 'today' : `on ${day}`);

/**
 * The explorer deep link.
 *
 * The vocabulary is the EXPLORER'S OWN URL params (reportConfig.seedFromParams:
 * metrics as a CSV string, start_day/end_day, funnel_id) — the same ones the
 * dashboard's KPI drill already speaks. The window is the trailing baseline
 * ending on the card's day, so clicking a card shows the day AGAINST the exact
 * baseline the detector judged it by, not against some other range.
 */
export function explorerLink(metric, day, funnelId = null, days = BASELINE_DAYS) {
  const params = {
    metrics: metric,
    start_day: dayAdd(day, -days),
    end_day: day,
  };
  if (funnelId) params.funnel_id = funnelId;
  return { page: 'explorer', params };
}

/** The one card shape every detector returns. */
function card(kind, severity, headline, prose, deepLink, evidence = {}) {
  return {
    kind,
    severity,
    headline,
    prose,
    deep_link: deepLink,
    evidence,
  };
}

/**
 * Rank and cap. Severity first, then the reference's detector order, so two
 * `bad` cards do not swap places between two loads of the same day.
 */
export function rankInsights(entries) {
  return [...entries]
    .filter((e) => e && e.card)
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.card.severity] ?? 9;
      const sb = SEVERITY_RANK[b.card.severity] ?? 9;
      return sa - sb || a.order - b.order;
    })
    .slice(0, MAX_CARDS)
    .map((e) => e.card);
}

// ═══════════════════════════════════════════════════════════════════════════
// Series shaping
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a day series into `{baseline, current}` around `day`.
 *
 * `baseline` is every point STRICTLY BEFORE `day` and not before
 * `day - BASELINE_DAYS` — the reference's `start <= k < day`. Points are handed
 * back UNTOUCHED (nulls intact); it is each detector's job to say what a null
 * means for the question it is asking.
 */
export function splitSeries(points, day, baselineDays = BASELINE_DAYS) {
  const start = dayAdd(day, -baselineDays);
  const list = Array.isArray(points) ? points.filter((p) => p && typeof p === 'object') : [];
  const baseline = list
    .filter((p) => String(p.key) >= start && String(p.key) < day)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const current = list.find((p) => String(p.key) === day) || null;
  return { baseline, current };
}

/**
 * The MEASURED values of one metric across a baseline.
 *
 * ⚠️ DEVIATION FROM THE REFERENCE (documented at the top of this file): a null
 * point is DROPPED, not read as 0. The caller then re-checks `values.length`
 * against the floor, so a baseline that is mostly withheld fails the floor
 * instead of producing a confident statistic over invented zeros.
 */
export function measuredColumn(points, metric) {
  const out = [];
  for (const p of points) {
    const v = measured(p ? p[metric] : null);
    if (v !== null) out.push(v);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 1 — anomaly (±2σ vs the trailing 28-day baseline)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The pure core: given a baseline and a current point, is any of net_sales /
 * orders / sessions outside mean ± 2σ? First metric in ANOMALY_METRICS order
 * that answers yes wins, exactly as the reference does.
 *
 * FLOORS, all three of which must clear or the detector stays silent:
 *   · `anomaly_min_baseline` (7) MEASURED baseline days;
 *   · σ > 0 — a flat baseline cannot have an outlier, and dividing by it would
 *     make every tiny wobble a two-sigma event;
 *   · the CURRENT value is measured. DEVIATION: the reference reads a missing
 *     current as 0, which manufactures a "dropped to 0" card out of a
 *     withheld measurement.
 */
export function detectAnomaly(baseline, current, day, today, {
  scope = '', funnelId = null,
} = {}) {
  for (const spec of ANOMALY_METRICS) {
    const vals = measuredColumn(baseline, spec.metric);
    if (vals.length < THRESHOLDS.anomaly_min_baseline.value) continue;
    const sd = pstdev(vals);
    if (!(sd > 0)) continue;
    const mean = fmean(vals);
    const cur = measured(current ? current[spec.metric] : null);
    if (cur === null) continue;
    const k = THRESHOLDS.anomaly_sigma.value;
    if (cur >= mean - k * sd && cur <= mean + k * sd) continue;

    const up = cur > mean;
    const curStr = spec.format === 'money' ? fmtMoney(cur) : fmtInt(cur);
    const meanStr = fmtMean(mean, spec.format);
    const severity = up ? 'good' : spec.down;
    const headline = `${spec.label}${scope} ${up ? 'jumped' : 'dropped'} to ${curStr}`;
    const prose = `${spec.label}${scope} ${up ? 'jumped' : 'dropped'} to ${curStr} ${whenOf(day, today)} `
      + `vs a ${meanStr} ${BASELINE_DAYS}-day average `
      + `(${vals.length} measured baseline day${vals.length === 1 ? '' : 's'}, σ ${fmtMean(sd, spec.format)}).`;
    return card('anomaly', severity, headline, prose,
      explorerLink(spec.metric, day, funnelId), {
        metric: spec.metric,
        value: spec.format === 'money' ? money2(cur) : Math.round(cur),
        baseline_mean: spec.format === 'money' ? money2(mean) : Math.round(mean * 10) / 10,
        baseline_sigma: Math.round(sd * 10000) / 10000,
        baseline_days_measured: vals.length,
        direction: up ? 'up' : 'down',
        funnel_id: funnelId,
      });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 2 — top mover (largest net-sales delta vs the previous day)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ DEVIATION — NO DELTA WITHOUT A BASELINE.
 *
 * The reference reads a funnel absent from the previous day's fold as
 * `net_sales = 0` and ranks it against funnels whose change was actually
 * measured. A funnel that did not exist yesterday, or whose money was withheld
 * yesterday, then wins "biggest mover" with a delta that is entirely the
 * default value.
 *
 * This build refuses that: a mover needs a PRESENT, MEASURED previous row.
 * It is the same rule funnelMetrics' own `moversFrom` enforces on the
 * window-over-window movers — one doctrine, not two.
 */
export function detectTopMover(curRows, prevRows, day, today) {
  const prev = new Map();
  for (const r of Array.isArray(prevRows) ? prevRows : []) {
    if (r && r.key !== undefined && r.key !== null) prev.set(String(r.key), r);
  }
  let best = null;
  for (const r of Array.isArray(curRows) ? curRows : []) {
    if (!r || r.key === undefined || r.key === null) continue;
    const p = prev.get(String(r.key));
    if (!p) continue;
    const c = measured(r.net_sales);
    const pv = measured(p.net_sales);
    if (c === null || pv === null) continue;
    const delta = money2(c - pv);
    if (Math.abs(delta) < THRESHOLDS.mover_min_abs_delta.value) continue;
    if (best === null || Math.abs(delta) > Math.abs(best.delta)) {
      best = { key: String(r.key), label: r.label || r.name || String(r.key), delta, cur: c, prev: pv };
    }
  }
  if (best === null) return null;
  const sign = best.delta > 0 ? '+' : '−';
  const headline = `${best.label} moved the most: ${sign}${fmtMoney(Math.abs(best.delta))}`;
  const prose = `${best.label} moved the most ${whenOf(day, today)}: net sales ${fmtMoney(best.cur)} `
    + `vs ${fmtMoney(best.prev)} the previous day (${sign}${fmtMoney(Math.abs(best.delta))}). `
    + 'Only funnels with a measured previous day are ranked — a funnel that was not there yesterday '
    + 'has an unknown change, not a change of its whole value.';
  return card('top_mover', 'info', headline, prose,
    explorerLink('net_sales', day, best.key), {
      funnel_id: best.key,
      label: best.label,
      net_sales: best.cur,
      previous_net_sales: best.prev,
      delta: best.delta,
      delta_pct: pct(best.delta, Math.abs(best.prev)),
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 3 — funnel leak (a step-to-step drop-off vs its own baseline)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ ADAPTED, and the adaptation is forced by the data.
 *
 * The reference measures `submits / hits` on ONE page-type step, because its
 * page-stats collection records a submit event per page. THIS BUILD RECORDS NO
 * SUBMIT: `lb_touches` is a view ledger (vid, ts, funnel_id, page_id) and
 * nothing else. Reporting a submit rate here would be inventing the numerator.
 *
 * What IS measurable is the STEP-TO-STEP THROUGH-RATE: distinct visitors on
 * step N+1 over distinct visitors on step N, in the funnel's own flow order —
 * the same quantity funnelMetrics' `dashboardWaterfall` already draws, judged
 * against its own 28-day baseline. It answers the same operator question
 * ("where are people falling out?") off a measurement this build actually
 * takes.
 *
 * The FLOORS are the reference's, applied to the UPSTREAM step (its `hits`):
 * ≥10 visitors today and ≥50 across the baseline, and the drop must be to
 * BELOW HALF the baseline through-rate.
 *
 * BASIS: visitors are DISTINCT PER DAY and summed across the baseline — the
 * engine's own additive `sessions_basis` convention, named on the payload.
 */
export function detectFunnelLeak(stepDays, day, today, funnelNames = new Map()) {
  // stepDays: [{funnel_id, day, step, visitors}]
  const byFunnel = new Map();
  for (const r of Array.isArray(stepDays) ? stepDays : []) {
    if (!r || !r.step) continue;
    const fid = String(r.funnel_id ?? '(none)');
    if (!byFunnel.has(fid)) byFunnel.set(fid, { day: new Map(), base: new Map() });
    const slot = byFunnel.get(fid);
    const bucket = String(r.day) === day ? slot.day : (String(r.day) < day ? slot.base : null);
    if (!bucket) continue;
    const v = measured(r.visitors);
    if (v === null) continue;
    bucket.set(r.step, (bucket.get(r.step) || 0) + v);
  }

  let best = null;
  // Sorted so a tie between two funnels resolves the same way on every load.
  for (const fid of [...byFunnel.keys()].sort()) {
    const { day: dayMap, base: baseMap } = byFunnel.get(fid);
    // CONSECUTIVE PAIRS OF STEPS THAT BOTH EXIST IN THIS FUNNEL. A funnel with
    // no downsell must compare upsell → thankyou, not upsell → (nothing) and
    // certainly not upsell → 0.
    const present = STEP_ORDER.filter((s) => dayMap.has(s) || baseMap.has(s));
    for (let i = 0; i < present.length - 1; i += 1) {
      const from = present[i];
      const to = present[i + 1];
      const dh = dayMap.get(from) || 0;
      const bh = baseMap.get(from) || 0;
      if (dh < THRESHOLDS.leak_min_day_hits.value) continue;
      if (bh < THRESHOLDS.leak_min_base_hits.value) continue;
      const ds = dayMap.get(to) || 0;
      const bs = baseMap.get(to) || 0;
      const baseConv = (bs / bh) * 100;
      const dayConv = (ds / dh) * 100;
      if (!(baseConv > 0)) continue;
      if (dayConv >= baseConv * THRESHOLDS.leak_drop_ratio.value) continue;
      const drop = (baseConv - dayConv) / baseConv;
      if (best === null || drop > best.drop) {
        best = { drop, fid, from, to, dayConv, baseConv, dh, bh };
      }
    }
  }
  if (best === null) return null;

  const name = funnelNames.get(best.fid) || (best.fid === '(none)' ? 'an unattributed funnel' : best.fid);
  const stepPair = `${STEP_LABELS[best.from] || best.from} → ${STEP_LABELS[best.to] || best.to}`;
  const severity = best.dayConv === 0 ? 'bad' : 'warn';
  const headline = `${stepPair} on ${name} fell to ${fmtPct1(best.dayConv)}`;
  const prose = `Step-through from ${stepPair} on ${name} dropped to ${fmtPct1(best.dayConv)} `
    + `${whenOf(day, today)} vs a ${fmtPct1(best.baseConv)} ${BASELINE_DAYS}-day average `
    + `(${fmtInt(best.dh)} visitors on ${STEP_LABELS[best.from] || best.from} today). `
    + 'This build records page VIEWS, not form submits, so this is a visitor through-rate '
    + 'between consecutive steps — not a submit rate.';
  return card('funnel_leak', severity, headline, prose,
    explorerLink('conv_pct', day, best.fid === '(none)' ? null : best.fid), {
      funnel_id: best.fid,
      from_step: best.from,
      to_step: best.to,
      day_pct: Math.round(best.dayConv * 1e4) / 1e4,
      baseline_pct: Math.round(best.baseConv * 1e4) / 1e4,
      day_upstream_visitors: best.dh,
      baseline_upstream_visitors: best.bh,
      basis: 'distinct lb_touches.vid per funnel_pages.type per day, summed (additive)',
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 4 — AOV shift (≥ 20% off the 28-day baseline mean)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The baseline is days that ACTUALLY HAD ORDERS and a measured AOV — an AOV
 * over a day with no orders is null in this engine, and the reference's
 * `or 0` would drag the mean toward zero with every quiet day.
 */
export function detectAovShift(baseline, current, day, today) {
  const baseVals = [];
  for (const p of baseline) {
    const orders = measured(p ? p.orders : null);
    const aov = measured(p ? p.aov : null);
    if (orders !== null && orders > 0 && aov !== null && aov > 0) baseVals.push(aov);
  }
  if (baseVals.length < THRESHOLDS.aov_min_baseline.value) return null;

  const curOrders = measured(current ? current.orders : null);
  const cur = measured(current ? current.aov : null);
  if (curOrders === null || curOrders <= 0) return null;
  if (cur === null || cur <= 0) return null;

  const mean = fmean(baseVals);
  if (!(mean > 0)) return null;
  const shift = ((cur - mean) / mean) * 100;
  if (Math.abs(shift) < THRESHOLDS.aov_shift_min_pct.value) return null;

  const up = shift > 0;
  const sign = up ? '+' : '−';
  const headline = `AOV ${up ? 'rose' : 'fell'} to ${fmtMoney(cur)} (${sign}${Math.abs(shift).toFixed(1)}%)`;
  const prose = `AOV ${up ? 'rose' : 'fell'} to ${fmtMoney(cur)} ${whenOf(day, today)} vs a `
    + `${fmtMoney(mean)} ${BASELINE_DAYS}-day average (${sign}${Math.abs(shift).toFixed(1)}%), `
    + `over ${baseVals.length} baseline day${baseVals.length === 1 ? '' : 's'} that had orders.`;
  return card('aov_shift', up ? 'good' : 'warn', headline, prose,
    explorerLink('aov', day), {
      metric: 'aov',
      value: money2(cur),
      baseline_mean: money2(mean),
      baseline_days_with_orders: baseVals.length,
      shift_pct: Math.round(shift * 10) / 10,
      orders: Math.round(curOrders),
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 5 — dead rail (a tracking rail that is silently not delivering)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ported onto this build's OWN tracking tables. Two signals, both `bad`:
 *
 *   A. An ENABLED Meta pixel with no CAPI token in `lb_pixels.config`.
 *      Server-side purchases cannot reach Meta at all, and the card says
 *      exactly what to paste where.
 *   B. A platform whose 7-day `lb_tracking_events` rows show ATTEMPTS but
 *      `sent = 0`.
 *
 * ATTEMPTED = error + deduped + queued, the reference's own definition.
 * `skipped` is EXCLUDED on purpose: this repo's own tracking-health surface
 * documents a skip as "a decline, not a failure" (routes/funnelTrackingExtras),
 * and counting declines as attempts would flag every consent-denied funnel as
 * a dead rail.
 *
 * ⚠️ THE CONFIG VALUE NEVER LEAVES THIS FUNCTION. The SQL selects a BOOLEAN
 * (`has_capi`), never the token itself, so a CAPI secret cannot end up in an
 * insight payload, a log line, or a screenshot of the strip.
 */
export function detectDeadRail(pixelRows, platformRows, funnelNames = new Map()) {
  for (const p of Array.isArray(pixelRows) ? pixelRows : []) {
    if (!p) continue;
    if (p.has_capi === true) continue;
    const fid = String(p.funnel_id ?? '');
    const name = funnelNames.get(fid) || fid || 'a funnel';
    const headline = `Meta CAPI token missing on ${name}`;
    const prose = `Meta CAPI token missing on ${name} — paste your Meta Conversions API access token `
      + 'into Funnel Settings → Tracking → Meta Pixel → CAPI token so server-side purchases reach '
      + 'Meta. Until then the browser pixel is the only rail, and it is the one ad blockers stop.';
    return card('dead_rail', 'bad', headline, prose,
      { page: 'funnel_tracking', params: { funnel_id: fid } },
      { funnel_id: fid, platform: 'meta_pixel', signal: 'capi_token_missing' });
  }
  for (const r of Array.isArray(platformRows) ? platformRows : []) {
    if (!r) continue;
    const sent = measured(r.sent);
    const attempted = (measured(r.failed) || 0) + (measured(r.deduped) || 0) + (measured(r.queued) || 0);
    if (sent === null || sent > 0) continue;
    if (!(attempted > 0)) continue;
    const fid = String(r.funnel_id ?? '');
    const name = funnelNames.get(fid) || fid || 'a funnel';
    const label = String(r.platform || 'A platform');
    const days = THRESHOLDS.dead_rail_window_days.value;
    const headline = `${label} delivered 0 of ${fmtInt(attempted)} events on ${name}`;
    const prose = `${label} logged ${fmtInt(attempted)} tracking events on ${name} in the last `
      + `${days} days and delivered 0 — re-check its credentials in Funnel Settings → Tracking → `
      + `${label}. Declines (skipped) are not counted as attempts.`;
    return card('dead_rail', 'bad', headline, prose,
      { page: 'funnel_tracking', params: { funnel_id: fid } },
      { funnel_id: fid, platform: label, attempted, sent: 0, signal: 'attempts_without_delivery' });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 6 — first sale (0 → N after a genuinely zero window)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ DEVIATION — A WITHHELD DAY IS NOT A DAY AT ZERO.
 *
 * The reference tests `any(orders > 0)` over a baseline it has already coerced,
 * so a baseline of nulls passes as "all zero" and the page congratulates an
 * account that has been trading for a year. Here EVERY baseline day must be
 * MEASURED and zero; one unmeasured day and the detector stays silent, because
 * "nobody bought" and "we did not look" are different claims and only one of
 * them is worth celebrating.
 */
export function detectFirstSale(baseline, current, day, today) {
  if (!Array.isArray(baseline) || baseline.length === 0) return null;
  for (const p of baseline) {
    const o = measured(p ? p.orders : null);
    if (o === null) return null; // unmeasured — cannot claim the window was dry
    if (o > 0) return null;
  }
  const n = measured(current ? current.orders : null);
  if (n === null || n <= 0) return null;
  const net = measured(current ? current.net_sales : null);
  const netStr = net === null ? 'an amount this window could not measure' : fmtMoney(net);
  const headline = `First sale is in — ${fmtInt(n)} order${n === 1 ? '' : 's'}`;
  const prose = `First sale is in — ${fmtInt(n)} order${n === 1 ? '' : 's'} totalling ${netStr} `
    + `${whenOf(day, today)} after ${baseline.length} measured day${baseline.length === 1 ? '' : 's'} at zero.`;
  return card('first_sale', 'good', headline, prose,
    explorerLink('orders', day), {
      orders: Math.round(n),
      net_sales: net === null ? null : money2(net),
      zero_days: baseline.length,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// The reads (each its own failure domain; all on the ISOLATED analytics pool)
// ═══════════════════════════════════════════════════════════════════════════

/** Does this table exist on this database? Guards every non-engine read. */
async function tableExists(query, name) {
  const [row] = await query(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
  return Boolean(row && row.t);
}

/**
 * Per-day, per-funnel, per-step distinct visitors over [from, to).
 *
 * Same join and same vocabulary as funnelMetrics' waterfall, plus the day
 * bucket (so a baseline can be built) and the funnel key (so the card can name
 * which funnel leaked). `$1` is the zone, as a BOUND PARAMETER — Postgres does
 * the DST arithmetic, never JavaScript.
 */
async function readStepDays(query, fromTs, toTs, funnelId) {
  if (!(await tableExists(query, 'funnel_pages'))) return { rows: [], available: false };
  const params = [REPORT_TZ, fromTs, toTs];
  let fsql = '';
  if (funnelId) { params.push(funnelId); fsql = ` AND t.funnel_id = $${params.length}`; }
  const rows = await query(
    `SELECT COALESCE(NULLIF(t.funnel_id, ''), '(none)')            AS funnel_id,
            to_char(t.ts AT TIME ZONE $1::text, 'YYYY-MM-DD')      AS day,
            COALESCE(NULLIF(p.type, ''), 'generic')                AS ptype,
            COUNT(DISTINCT t.vid)::bigint                          AS visitors
     FROM lb_touches t
     JOIN funnel_pages p ON p.id = t.page_id
     WHERE t.ts >= $2 AND t.ts < $3${fsql}
     GROUP BY 1, 2, 3`,
    params
  );
  return {
    available: true,
    rows: rows.map((r) => ({
      funnel_id: String(r.funnel_id),
      day: String(r.day),
      // A page type outside the vocabulary folds to 'other' and is DROPPED from
      // the leak test (it has no position in the flow), but it is never
      // silently renamed into a step it is not.
      step: TYPE_TO_STEP[String(r.ptype)] || 'other',
      visitors: Number(r.visitors),
    })).filter((r) => r.step !== 'other'),
  };
}

/** Enabled Meta pixels and whether each has a CAPI token — the token itself never read. */
async function readPixels(query, funnelId) {
  if (!(await tableExists(query, 'lb_pixels'))) return { rows: [], available: false };
  const params = [];
  let fsql = '';
  if (funnelId) { params.push(funnelId); fsql = ` AND funnel_id = $${params.length}`; }
  const rows = await query(
    `SELECT funnel_id,
            (COALESCE(NULLIF(TRIM(config->>'capi_token'), ''), NULL) IS NOT NULL) AS has_capi
     FROM lb_pixels
     WHERE kind = 'meta_pixel' AND enabled = TRUE AND COALESCE(NULLIF(pixel_id, ''), NULL) IS NOT NULL${fsql}
     ORDER BY funnel_id
     LIMIT ${THRESHOLDS.funnel_scan_cap.value}`,
    params
  );
  return { available: true, rows: rows.map((r) => ({ funnel_id: String(r.funnel_id), has_capi: r.has_capi === true })) };
}

/** Per-(funnel, platform) delivery counters over the dead-rail window. */
async function readRailHealth(query, funnelId) {
  if (!(await tableExists(query, 'lb_tracking_events'))) return { rows: [], available: false };
  const days = THRESHOLDS.dead_rail_window_days.value;
  const params = [String(days)];
  let fsql = '';
  if (funnelId) { params.push(funnelId); fsql = ` AND funnel_id = $${params.length}`; }
  const rows = await query(
    `SELECT COALESCE(NULLIF(funnel_id, ''), '(none)') AS funnel_id,
            COALESCE(NULLIF(platform, ''), '(unknown)') AS platform,
            COUNT(*) FILTER (WHERE status = 'sent')::bigint    AS sent,
            COUNT(*) FILTER (WHERE status = 'error')::bigint   AS failed,
            COUNT(*) FILTER (WHERE status = 'deduped')::bigint AS deduped,
            COUNT(*) FILTER (WHERE status = 'queued')::bigint  AS queued
     FROM lb_tracking_events
     WHERE ts >= NOW() - ($1::text || ' days')::interval${fsql}
     GROUP BY 1, 2
     ORDER BY 1, 2
     LIMIT ${THRESHOLDS.funnel_scan_cap.value}`,
    params
  );
  return {
    available: true,
    rows: rows.map((r) => ({
      funnel_id: String(r.funnel_id),
      platform: String(r.platform),
      sent: Number(r.sent),
      failed: Number(r.failed),
      deduped: Number(r.deduped),
      queued: Number(r.queued),
    })),
  };
}

/** id → name for the funnels a card might have to say out loud. */
async function readFunnelNames(query) {
  if (!(await tableExists(query, 'funnels'))) return new Map();
  const rows = await query(
    `SELECT id, name FROM funnels ORDER BY id LIMIT ${THRESHOLDS.funnel_scan_cap.value}`
  );
  return new Map(rows.map((r) => [String(r.id), r.name || null]).filter(([, n]) => n));
}

// ═══════════════════════════════════════════════════════════════════════════
// Orchestration
// ═══════════════════════════════════════════════════════════════════════════

const idOf = (v, max = 120) => String(v ?? '').trim().slice(0, max);

/**
 * GET /funnel-insights/insights — the whole insight layer in ONE composite.
 *
 * Returns:
 *   { day, insights[], last_60:{series, window}, thresholds, window, meta }
 *
 * ONE endpoint on purpose, for the same reason `/dashboard` is one: the strip,
 * the last-60 card and the rule table are all functions of the same day series,
 * and three requests could paint three mutually inconsistent versions of it.
 */
export async function runInsights({ day: dayIn, funnel_id: funnelIdIn } = {}, {
  query = analyticsQuery,
} = {}) {
  const t0 = Date.now();
  const today = todayInTz();
  const day = dayIn === undefined || dayIn === null || dayIn === '' ? today : validDay(dayIn);
  if (day === null) {
    throw new MetricsError('invalid_day', 'day must be a real YYYY-MM-DD calendar date', 422, { day: String(dayIn).slice(0, 20) });
  }
  // A day in the future has not happened; judging it against a baseline would
  // compare an empty bucket to a full one and fire every downward detector.
  if (day > today) {
    throw new MetricsError('day_in_future', `day ${day} is after today (${today} in ${REPORT_TZ})`, 422, { day, today });
  }
  const funnelId = idOf(funnelIdIn, 64) || null;

  const seriesStart = dayAdd(day, -(LAST_N_DAYS - 1));
  const filters = { funnel_id: funnelId, country: null, gateway: null, source: null };

  const degraded = [];
  const warnings = [];
  /** A read whose failure costs a detector, not the response. */
  const attempt = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      degraded.push({ source: name, reason: `${name} could not be read: ${String(err && err.message ? err.message : err).slice(0, 200)}` });
      return fallback;
    }
  };

  const windowFor = (start, end) => ({ start_day: start, end_day: end });

  // ── the reads. Independent, so they run together. ───────────────────────
  const [seriesRes, funnelWindowRes, dayRowsRes, prevRowsRes, names] = await Promise.all([
    attempt('series', () => runQuery({
      metrics: [...SERIES_METRICS],
      window: windowFor(seriesStart, day),
      granularity: 'day',
      filters,
    }, { query }), null),
    attempt('funnel_breakdown', () => runQuery({
      metrics: ['net_sales'],
      dimension: 'funnel',
      window: windowFor(dayAdd(day, -BASELINE_DAYS), day),
      filters,
      limit: THRESHOLDS.funnel_scan_cap.value,
    }, { query }), null),
    attempt('funnel_day', () => runQuery({
      metrics: ['net_sales'],
      dimension: 'funnel',
      window: windowFor(day, day),
      filters,
      limit: THRESHOLDS.funnel_scan_cap.value,
    }, { query }), null),
    attempt('funnel_prev_day', () => runQuery({
      metrics: ['net_sales'],
      dimension: 'funnel',
      window: windowFor(dayAdd(day, -1), dayAdd(day, -1)),
      filters,
      limit: THRESHOLDS.funnel_scan_cap.value,
    }, { query }), null),
    attempt('funnel_names', () => readFunnelNames(query), new Map()),
  ]);

  const points = seriesRes ? (Array.isArray(seriesRes.series) ? seriesRes.series : []) : [];
  const { baseline, current } = splitSeries(points, day);

  // The step ledger's window is the baseline PLUS the day itself, bounded by
  // the ENGINE'S OWN `zonedDayStart` — the same function that cut every metric
  // window above. Re-deriving local midnight in this file would be a second
  // implementation of the DST double-offset, and the two would disagree twice a
  // year on exactly the days an operator is most likely to ask about.
  const leakFromTs = zonedDayStart(dayAdd(day, -BASELINE_DAYS)).toISOString();
  const leakToTs = zonedDayStart(dayAdd(day, 1)).toISOString();

  const [stepRes, pixelRes, railRes] = await Promise.all([
    attempt('steps', () => readStepDays(query, leakFromTs, leakToTs, funnelId),
      { rows: [], available: false }),
    attempt('pixels', () => readPixels(query, funnelId), { rows: [], available: false }),
    attempt('rails', () => readRailHealth(query, funnelId), { rows: [], available: false }),
  ]);

  // ── the top-funnel anomaly fallback (reference detector 1, second half) ──
  const funnelRows = funnelWindowRes && Array.isArray(funnelWindowRes.rows) ? funnelWindowRes.rows : [];
  const topFunnel = funnelRows.find((r) => r && r.key && r.key !== '(none)') || null;

  let scopedBaseline = [];
  let scopedCurrent = null;
  let scopedName = null;
  let scopedId = null;
  if (topFunnel && detectAnomaly(baseline, current, day, today) === null) {
    scopedId = String(topFunnel.key);
    scopedName = topFunnel.label || topFunnel.name || scopedId;
    const scoped = await attempt('series_top_funnel', () => runQuery({
      metrics: [...SERIES_METRICS],
      window: windowFor(dayAdd(day, -BASELINE_DAYS), day),
      granularity: 'day',
      filters: { ...filters, funnel_id: scopedId },
    }, { query }), null);
    if (scoped) {
      const split = splitSeries(Array.isArray(scoped.series) ? scoped.series : [], day);
      scopedBaseline = split.baseline;
      scopedCurrent = split.current;
    }
  }

  // ── run the detectors. A thrower loses its own card and NAMES itself. ────
  const entries = [];
  const run = (order, kind, fn) => {
    try {
      const c = fn();
      if (c) entries.push({ order, card: c });
    } catch (err) {
      degraded.push({ source: kind, reason: `detector '${kind}' failed: ${String(err && err.message ? err.message : err).slice(0, 200)}` });
    }
  };

  run(1, 'anomaly', () => detectAnomaly(baseline, current, day, today)
    || (scopedId
      ? detectAnomaly(scopedBaseline, scopedCurrent, day, today, { scope: ` on ${scopedName}`, funnelId: scopedId })
      : null));
  run(2, 'top_mover', () => detectTopMover(
    dayRowsRes && Array.isArray(dayRowsRes.rows) ? dayRowsRes.rows : [],
    prevRowsRes && Array.isArray(prevRowsRes.rows) ? prevRowsRes.rows : [],
    day, today,
  ));
  run(3, 'funnel_leak', () => detectFunnelLeak(stepRes.rows, day, today, names));
  run(4, 'aov_shift', () => detectAovShift(baseline, current, day, today));
  run(5, 'dead_rail', () => detectDeadRail(pixelRes.rows, railRes.rows, names));
  run(6, 'first_sale', () => detectFirstSale(baseline, current, day, today));

  const insights = rankInsights(entries);

  // ── the disclosures. A silent strip is the one an operator trusts most. ──
  if (!seriesRes) {
    warnings.push({
      source: 'series',
      reason: 'the day series could not be read, so the anomaly, AOV-shift and first-sale detectors did not run. '
        + 'This is not a statement that nothing happened.',
    });
  } else {
    // ⚠️ COUNT THE MEASURED DAYS, NOT THE BUCKETS. The engine's series is
    // GAP-FREE: a brand-new account still gets 28 baseline points, every one of
    // them a measured 0. Keying this disclosure off `baseline.length` therefore
    // said nothing at all on exactly the account that most needs telling, while
    // the ±2σ test sat silent because a flat baseline has σ = 0. Caught by
    // running the service against an EMPTY database, which is why that is the
    // first case in server/tests/insights/service.mjs.
    const measuredDays = Math.max(
      ...ANOMALY_METRICS.map((s) => measuredColumn(baseline, s.metric).length), 0,
    );
    const flat = ANOMALY_METRICS.every((s) => !(pstdev(measuredColumn(baseline, s.metric)) > 0));
    if (measuredDays < THRESHOLDS.anomaly_min_baseline.value) {
      warnings.push({
        source: 'baseline',
        reason: `only ${measuredDays} of the ${baseline.length} baseline day(s) before ${day} carry a measured figure; `
          + `the ±${THRESHOLDS.anomaly_sigma.value}σ test needs ${THRESHOLDS.anomaly_min_baseline.value} and stays `
          + 'silent until it has them. A silent detector is not a clean bill of health.',
      });
    } else if (flat) {
      warnings.push({
        source: 'baseline',
        reason: `every baseline series before ${day} is perfectly flat (σ = 0), so no day can be an outlier and the `
          + 'anomaly detector cannot speak. This is a property of the baseline, not a statement that today is normal.',
      });
    }
  }
  if (!stepRes.available) {
    warnings.push({
      source: 'steps',
      reason: 'the page/touch ledger is not present on this database, so the funnel-leak detector did not run.',
    });
  }
  if (!pixelRes.available && !railRes.available) {
    warnings.push({
      source: 'tracking',
      reason: 'the tracking tables are not present on this database, so the dead-rail detector did not run.',
    });
  }
  if (seriesRes && seriesRes.meta && seriesRes.meta.sessions_unknown === true) {
    warnings.push({
      source: 'lb_touches',
      reason: `part of this ${LAST_N_DAYS}-day series reaches past the touch retention — the sessions column is withheld `
        + 'for those buckets and the sessions anomaly cannot be judged over them. Withheld is not zero.',
    });
  }

  return {
    day,
    timezone: REPORT_TIMEZONE,
    insights,
    // EVERY DETECTOR THAT RAN, whether or not it fired — a strip showing two
    // cards says nothing about whether the other four were quiet or broken.
    detectors: [
      { kind: 'anomaly', ran: Boolean(seriesRes), fired: insights.some((c) => c.kind === 'anomaly') },
      { kind: 'top_mover', ran: Boolean(dayRowsRes && prevRowsRes), fired: insights.some((c) => c.kind === 'top_mover') },
      { kind: 'funnel_leak', ran: stepRes.available, fired: insights.some((c) => c.kind === 'funnel_leak') },
      { kind: 'aov_shift', ran: Boolean(seriesRes), fired: insights.some((c) => c.kind === 'aov_shift') },
      { kind: 'dead_rail', ran: pixelRes.available || railRes.available, fired: insights.some((c) => c.kind === 'dead_rail') },
      { kind: 'first_sale', ran: Boolean(seriesRes), fired: insights.some((c) => c.kind === 'first_sale') },
    ],
    last_60: {
      series: points,
      metrics: [...SERIES_METRICS],
      window: {
        start: seriesStart, end: day, days: LAST_N_DAYS, timezone: REPORT_TIMEZONE,
      },
      // The engine's own disclosures for THIS series, forwarded verbatim: the
      // card draws holes, and the reason the holes are there is on the wire.
      sessions_unknown: Boolean(seriesRes && seriesRes.meta && seriesRes.meta.sessions_unknown),
      currency: seriesRes && seriesRes.meta ? seriesRes.meta.currency : null,
      mixed_currency: Boolean(seriesRes && seriesRes.meta && seriesRes.meta.mixed_currency),
    },
    baseline_window: {
      start: dayAdd(day, -BASELINE_DAYS), end: dayAdd(day, -1), days: BASELINE_DAYS, timezone: REPORT_TIMEZONE,
    },
    thresholds: THRESHOLDS,
    window: {
      start: seriesStart, end: day, days: LAST_N_DAYS, timezone: REPORT_TIMEZONE,
    },
    meta: {
      computed_ms: Date.now() - t0,
      rows_scanned: [seriesRes, funnelWindowRes, dayRowsRes, prevRowsRes]
        .reduce((t, r) => t + (r && r.meta ? Number(r.meta.rows_scanned) || 0 : 0), 0),
      timezone: REPORT_TIMEZONE,
      max_cards: MAX_CARDS,
      baseline_days: BASELINE_DAYS,
      window: { start: seriesStart, end: day, days: LAST_N_DAYS, timezone: REPORT_TIMEZONE },
      // A read or a detector that fell over, NAMED. Never swallowed.
      degraded,
      warnings,
    },
  };
}

/** The rule table, as data — served on /funnel-insights/definitions. */
export const RULES = Object.freeze([
  Object.freeze({
    kind: 'anomaly',
    order: 1,
    ported: true,
    what: 'net_sales / orders / sessions outside the trailing 28-day mean ± 2σ, account-wide first, then the top funnel by net sales.',
    floors: ['anomaly_min_baseline', 'anomaly_sigma'],
    severity: 'good when up; bad when net_sales falls; warn when orders or sessions fall',
    deviation: 'null baseline points are EXCLUDED (not read as 0) and a null current value blocks the card; the reference coerces both to 0.',
  }),
  Object.freeze({
    kind: 'top_mover',
    order: 2,
    ported: true,
    what: 'the funnel with the largest net-sales delta vs the previous day.',
    floors: ['mover_min_abs_delta'],
    severity: 'info',
    deviation: 'a funnel with NO measured previous-day row is skipped; the reference defaults it to 0 and lets it win.',
  }),
  Object.freeze({
    kind: 'funnel_leak',
    order: 3,
    ported: 'adapted',
    what: 'the consecutive step pair whose visitor through-rate fell below half its 28-day baseline.',
    floors: ['leak_min_day_hits', 'leak_min_base_hits', 'leak_drop_ratio'],
    severity: 'bad at 0%, warn otherwise',
    deviation: 'the reference measures submits ÷ hits per page; this build records no submit event, so the measurable quantity is the step-to-step visitor through-rate (the same one the dashboard waterfall draws).',
  }),
  Object.freeze({
    kind: 'aov_shift',
    order: 4,
    ported: true,
    what: 'AOV moved at least 20% off its 28-day baseline mean.',
    floors: ['aov_min_baseline', 'aov_shift_min_pct'],
    severity: 'good when up, warn when down',
    deviation: 'the baseline counts only days with orders AND a measured AOV; the reference coerces a null AOV to 0 and drags the mean down.',
  }),
  Object.freeze({
    kind: 'dead_rail',
    order: 5,
    ported: true,
    what: 'an enabled Meta pixel with no CAPI token, or a platform with 7-day attempts and zero deliveries.',
    floors: ['dead_rail_window_days'],
    severity: 'bad',
    deviation: "attempted = error + deduped + queued; 'skipped' is excluded because this repo's own tracking-health surface defines a skip as a decline, not a failure. The CAPI token is read as a BOOLEAN in SQL and never leaves the database.",
  }),
  Object.freeze({
    kind: 'first_sale',
    order: 6,
    ported: true,
    what: 'orders went 0 → N after a baseline window with no orders.',
    floors: [],
    severity: 'good',
    deviation: 'EVERY baseline day must be MEASURED and zero; the reference treats a withheld day as a zero one and can celebrate a first sale for an account that has traded for a year.',
  }),
]);

/** What did NOT survive the port, and why. Served beside RULES. */
export const DROPPED = Object.freeze([
  Object.freeze({
    kind: 'insights_cache',
    what: 'the reference upserts one card doc per (workspace, day) into lb_insights_daily and serves it for 6 hours.',
    why: 'this lane is read-only over the money database and owns no table; a cache would mean a migration, a write path, and a six-hour staleness window on numbers the operator moves budget on.',
  }),
  Object.freeze({
    kind: 'never_raises',
    what: "the reference's daily_insights() swallows every failure and returns [].",
    why: 'an empty strip with no explanation is a claim that nothing is wrong. Failures are caught per-read and per-detector and NAMED in meta.degraded[] instead.',
  }),
]);

export default {
  runInsights, RULES, DROPPED, THRESHOLDS, MAX_CARDS, BASELINE_DAYS, LAST_N_DAYS,
  SERIES_METRICS, STEP_ORDER, STEP_LABELS, SEVERITIES,
  detectAnomaly, detectTopMover, detectFunnelLeak, detectAovShift,
  detectDeadRail, detectFirstSale, rankInsights, splitSeries, measuredColumn,
  measured, pstdev, fmean, dayAdd, validDay, explorerLink, whenOf,
};
