// insightShapes — the readers and label tables the LANE 5 cards share
// (NEW FILE, LANE 5).
//
// ── WHY THESE ARE NOT IN THE COMPONENTS THAT USE THEM ───────────────────────
//
// `react-refresh/only-export-components` is on in this repo's eslint config,
// and it is right: a module that exports both a component and a constant breaks
// fast refresh, so every edit to the constant remounts the tree and loses the
// operator's state. cardKit.jsx records the same rule ("EXPORTS ARE COMPONENTS
// ONLY — formatters live in ./dashFormat.js"). This file is the LANE 5 twin of
// that decision.
//
// ── WHY THE COMPOSITE READERS LIVE HERE AND NOT IN metricsApi.js ────────────
//
// `waterfallOf` and `moversOf` read blocks of the METRICS composite, so
// ../metricsApi.js is arguably their natural home. They are here instead
// because that file is Lane 3's contract surface — it is pinned key-by-key by
// __checks__/formatterContract.mjs, and growing it from another lane is exactly
// how a pinned contract file quietly stops describing one lane's beliefs. These
// two readers are additive, they are consumed by two cards, and they are pinned
// by this lane's own harness.
//
// Both follow metricsApi's rule verbatim: TOLERANT ON SHAPE, STRICT ON MEANING.
// `null` is WITHHELD, an absent key is NOT REPORTED BY THIS BUILD, and neither
// is ever collapsed into the other or into `0`.
import { EM_DASH } from './dashFormat.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ── the six detector kinds, in operator language ────────────────────────── */

export const KIND_LABELS = Object.freeze({
  anomaly: 'Outlier day',
  top_mover: 'Biggest mover',
  funnel_leak: 'Funnel leak',
  aov_shift: 'AOV shift',
  dead_rail: 'Tracking rail',
  first_sale: 'First sale',
});

/* ── the cohort groupings ────────────────────────────────────────────────── */

export const GROUP_BY_LABELS = Object.freeze({
  day: 'Acquisition day',
  funnel: 'Acquisition funnel',
  campaign: 'Acquisition campaign',
});

/* ── composite readers ───────────────────────────────────────────────────── */

/**
 * `data.waterfall` — the step ledger the metrics engine has shipped since
 * Lane 1. `sent:false` means the key never arrived, which is a DIFFERENT claim
 * from an empty step list and is rendered differently.
 */
export function waterfallOf(data) {
  const src = isObj(data) && isObj(data.waterfall) ? data.waterfall : null;
  if (!src) return { sent: false, steps: [], basis: '' };
  return {
    sent: true,
    steps: (Array.isArray(src.steps) ? src.steps : []).filter(isObj).map((s) => ({
      step: typeof s.step === 'string' ? s.step : '',
      label: typeof s.label === 'string' ? s.label
        : (typeof s.step === 'string' ? s.step : EM_DASH),
      visitors: numOrNull(s.visitors),
      pctOfTop: numOrNull(s.pct_of_top),
    })),
    basis: typeof src.basis === 'string' ? src.basis : '',
  };
}

/**
 * `data.movers` — the window-over-window funnel deltas.
 *
 * ⚠️ A ROW WITH NO MEASURED `delta` IS DROPPED. The server already refuses to
 * rank a funnel without a measured previous value ("a funnel with no previous
 * window has an UNKNOWN change, not a 0% one"); this reader will not put one
 * back on the card by coercing a missing delta to zero.
 */
export function moversOf(data) {
  if (!isObj(data) || !Object.prototype.hasOwnProperty.call(data, 'movers')) {
    return { sent: false, rows: [] };
  }
  const list = Array.isArray(data.movers) ? data.movers : [];
  return {
    sent: true,
    rows: list.filter(isObj).map((r) => ({
      key: r.key === undefined || r.key === null ? '' : String(r.key),
      label: typeof r.label === 'string' && r.label ? r.label
        : (typeof r.name === 'string' && r.name ? r.name : String(r.key ?? EM_DASH)),
      netSales: numOrNull(r.net_sales),
      previous: numOrNull(r.previous_net_sales),
      delta: numOrNull(r.delta),
      deltaPct: numOrNull(r.delta_pct),
    })).filter((r) => r.delta !== null),
  };
}
