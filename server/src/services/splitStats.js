// Split-test STATISTICS LAYER — PURE functions, no DB, no I/O, no clock.
//
// Rows in → verdicts out. Every export in this file is a total function of its
// arguments; the harness (server/tests/split/statistics.mjs) pins the math by
// executing it against textbook known answers, so nothing here may reach for a
// query, a Date, or an env var.
//
// ── WHY THIS FILE EXISTS, GIVEN analyticsStats.js ALREADY DOES z AND WELCH ──
//
// It is NOT a second statistics engine. Before writing a line here the existing
// corpus was grepped: `server/src/services/analyticsStats.js` already ships the
// primitives — the pooled two-proportion z-test, Welch's t with an exact
// Student-t tail via the regularized incomplete beta, `varianceFromSums`, both
// sample-size formulas and `buildVerdict` — and `funnelAnalytics.js` already
// consumes them for the WINDOWED experiment endpoint
// (GET /funnel-analytics/split/:id/results). Re-deriving erfc, logGamma or the
// beta continued fraction here would mean two implementations of one number,
// and the first time they disagreed by a ulp the operator would be looking at
// two different confidences for one test with no way to tell which is real.
//
// So this module IMPORTS those primitives and adds the four things the split
// lane still lacks, all of them absent from the codebase before this file
// (verified by grep, not assumed):
//
//   1. PER-ARM READINESS. `buildVerdict` reports a global `thinArms` list and
//      ONE `requiredSamplePerArm`. It never says "arm b needs 240 more
//      visitors and 18 more orders", which is the only form an operator can
//      act on. `armReadiness` answers per arm, in deltas.
//   2. INCREMENTAL LIFT IN MONEY. A confidence percentage does not tell anyone
//      whether the gap is worth shipping. `incrementalLift` converts the RPV
//      gap into money — per visitor, per 1,000 visitors, and the amount the
//      challenger's own observed traffic already earned above the control's
//      rate.
//   3. TIME TO DECISION. Ported from funnel-os
//      `lb_split_incremental_service.time_to_decision_days`. Grepped for first:
//      zero hits anywhere in this repo. Deliberately crude and deliberately
//      present — the failure it exists to prevent is an operator concluding on
//      noise because the panel only ever said "not significant".
//   4. THE WITHHOLDING CONTRACT. `computeSplitStatistics` refuses to emit a
//      p-value at all in three named states rather than emitting a plausible
//      one. See WITHHOLD below.
//
// ── WITHHOLD, DON'T GUESS ──────────────────────────────────────────────────
//
// Three states produce `status: 'insufficient_data'` with prose, `p_value:
// null`, `confidence: null` — never a number:
//
//   • FEWER THAN TWO ARMS WITH DATA. One arm cannot be compared to anything.
//     A single-arm "result" is a report, not an experiment.
//   • n BELOW THE STATISTICS FLOOR. Below `MIN_STATS_SAMPLE` visitors on either
//     side, the normal/t approximations are describing the prior, not the data.
//     This floor is SEPARATE from — and far below — the readiness floor: the
//     readiness floor gates a WINNER, this one gates whether a p-value is
//     printed at all.
//   • ZERO VARIANCE. Both arms perfectly constant. Either identical (nothing to
//     detect) or separated with no within-arm noise, which is a degenerate
//     sample, not overwhelming evidence.
//
// A NULL IS A FACT AND A NUMBER IS A CLAIM. Everywhere below, a quantity that
// could not be measured is `null`, never 0 and never a default. `0.00%` reads
// as "measured, and it is zero"; a dash reads as "not measured". They ask the
// operator to do different things.
//
// ── THE CONTRACT EVERY EXPORT HONOURS ──────────────────────────────────────
// A returned number is ALWAYS finite. There is no input — n=0, n=1, negative
// revenue, identical arms, NaN, undefined, a string, a null row — that can
// produce NaN or Infinity anywhere in the output. The harness asserts this by
// walking the whole returned object.
import {
  compareConversion,
  compareRevenuePerVisitor,
  varianceFromSums,
  requiredSampleForProportions,
  requiredSampleForMeans,
  SPLIT_MIN_VISITORS_PER_ARM,
  SPLIT_MIN_CONVERSIONS_PER_ARM,
  MIN_RATE_SAMPLE,
} from './analyticsStats.js';

// Re-exported so a caller needs ONE import to render the floors it is being
// judged against. Re-export, not redefinition: two copies of a floor is how the
// UI ends up saying 300 while the gate uses 250.
export {
  SPLIT_MIN_VISITORS_PER_ARM,
  SPLIT_MIN_CONVERSIONS_PER_ARM,
  MIN_RATE_SAMPLE,
};

// Below this many visitors on EITHER side, no p-value is emitted at all.
//
// Deliberately equal to MIN_RATE_SAMPLE (30) and deliberately NOT equal to the
// readiness floor (300). They answer different questions:
//   • MIN_STATS_SAMPLE — "is arithmetic on this sample meaningful?" A z-test on
//     8 visitors will happily print 94% confidence; the number is not wrong, it
//     is meaningless, which is worse because it invites action.
//   • SPLIT_MIN_VISITORS_PER_ARM — "may this test name a winner?" A test can be
//     well below that and still deserve an honest, hedged p-value on screen so
//     the operator can watch it move.
// Collapsing the two would either hide the p-value until 300 (the operator
// flies blind and concludes by eye) or print one at n=3.
export const MIN_STATS_SAMPLE = MIN_RATE_SAMPLE;

// α for the family. Bonferroni-corrected by the number of comparisons against
// the control inside computeSplitStatistics, exactly as buildVerdict does — one
// rule, one bar, so a per-arm `significant` and the verdict gate can never
// disagree.
export const SPLIT_ALPHA = 0.05;

const finite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nonNegInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const round = (v, dp = 6) => {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const money = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * PER-ARM READINESS — how far THIS arm is from being scoreable, in deltas.
 *
 * `buildVerdict` answers "which arms are thin"; this answers "how much more".
 * The deltas are what the UI prints ("needs ~240 more visitors") and they are
 * the reason this is per-arm rather than a single global figure: with 3 arms,
 * one can be 10 visitors short while another is 2,000 short, and one number
 * describing both is wrong for both.
 *
 * `blockers` is an ORDERED list of machine-readable reasons, so the UI can
 * render them without parsing prose. Empty ⇔ ready.
 *
 * @param {{arm_key?:string, visitors?:number, conversions?:number}} row
 * @param {{minVisitors?:number, minConversions?:number}} [opts]
 * @returns {{arm_key:string, visitors:number, conversions:number, ready:boolean,
 *            needs_visitors:number, needs_conversions:number,
 *            min_visitors:number, min_conversions:number, blockers:string[]}}
 */
export function armReadiness(row, opts = {}) {
  const minVisitors = nonNegInt(opts.minVisitors) || SPLIT_MIN_VISITORS_PER_ARM;
  const minConversions = Number.isFinite(Number(opts.minConversions)) && Number(opts.minConversions) >= 0
    ? Math.floor(Number(opts.minConversions))
    : SPLIT_MIN_CONVERSIONS_PER_ARM;
  const visitors = nonNegInt(row?.visitors);
  // Conversions are CLAMPED to the denominator. A crediting bug upstream that
  // reports more orders than exposures must produce a capped (wrong-but-sane)
  // readiness, never a negative "needs" that would read as a surplus.
  const conversions = Math.min(nonNegInt(row?.conversions), visitors);

  const needsVisitors = Math.max(0, minVisitors - visitors);
  const needsConversions = Math.max(0, minConversions - conversions);
  const blockers = [];
  if (needsVisitors > 0) blockers.push('below_visitor_floor');
  if (needsConversions > 0) blockers.push('below_conversion_floor');

  return {
    arm_key: String(row?.arm_key ?? ''),
    visitors,
    conversions,
    ready: blockers.length === 0,
    needs_visitors: needsVisitors,
    needs_conversions: needsConversions,
    min_visitors: minVisitors,
    min_conversions: minConversions,
    blockers,
  };
}

/**
 * INCREMENTAL LIFT, IN MONEY — what the gap is actually worth.
 *
 * A confidence percentage answers "could this be chance?". It cannot answer
 * "is it worth shipping?", and those are different questions with different
 * answers: a 99.9%-confident gap of $0.004 per visitor is real and worthless.
 *
 * `earned_so_far` is the honest headline number: the challenger's OWN observed
 * traffic, valued at the gap. It is what the challenger already earned above
 * what the control's rate would have produced on that same traffic. It is
 * deliberately NOT extrapolated to a year or a month — this module has no clock
 * and a projection needs a traffic forecast nobody has supplied.
 *
 * Every field is null when its inputs are missing, never 0.
 *
 * BOTH `orders` and `conversions` are accepted for the numerator, and that is
 * not sloppiness — it is a bug fix pinned by execution. The two names for one
 * quantity are already live in this codebase: funnelAnalytics' arm rows call it
 * `orders`, the split ledger (`splitCredits.readResults`) calls it
 * `conversions`. Reading only `orders` here made `cvr_delta` come back 0.03 →
 * 0.00 for every ledger-fed caller — a real difference silently reported as
 * "no difference", which is the single worst wrong answer this file could give.
 * Caught by running it, not by reading it.
 *
 * @param {{visitors?:number, orders?:number, conversions?:number, net_revenue?:number}} control
 * @param {{visitors?:number, orders?:number, conversions?:number, net_revenue?:number}} challenger
 */
export function incrementalLift(control, challenger) {
  const nC = nonNegInt(control?.visitors);
  const nV = nonNegInt(challenger?.visitors);
  const revC = finite(control?.net_revenue);
  const revV = finite(challenger?.net_revenue);

  const rpvC = nC > 0 ? revC / nC : null;
  const rpvV = nV > 0 ? revV / nV : null;

  const numerator = (row) => (row?.orders !== undefined && row?.orders !== null
    ? row.orders
    : row?.conversions);
  const ordersC = Math.min(nonNegInt(numerator(control)), nC);
  const ordersV = Math.min(nonNegInt(numerator(challenger)), nV);
  const cvrC = nC > 0 ? ordersC / nC : null;
  const cvrV = nV > 0 ? ordersV / nV : null;

  const rpvDelta = rpvC === null || rpvV === null ? null : rpvV - rpvC;
  const cvrDelta = cvrC === null || cvrV === null ? null : cvrV - cvrC;

  return {
    control_rpv: rpvC === null ? null : round(rpvC, 6),
    challenger_rpv: rpvV === null ? null : round(rpvV, 6),
    // Absolute money per visitor. 6dp, not 2: a real per-visitor gap is often
    // cents, and rounding it to the cent would print $0.00 for a difference
    // worth thousands at volume.
    rpv_delta: rpvDelta === null ? null : round(rpvDelta, 6),
    // RELATIVE lift. Null (not 0, not Infinity) when the control earns nothing
    // — "infinitely better than zero" is not a number an operator can use.
    rpv_lift_pct: rpvDelta === null || !(rpvC > 0) ? null : round((rpvDelta / rpvC) * 100, 4),
    // The same gap in a unit an operator buys traffic in.
    per_1000_visitors: rpvDelta === null ? null : money(rpvDelta * 1000),
    // Money the challenger already made above the control's rate, on the
    // challenger's own observed traffic. The one figure here that is a
    // MEASUREMENT rather than a rate.
    earned_so_far: rpvDelta === null ? null : money(rpvDelta * nV),
    cvr_delta: cvrDelta === null ? null : round(cvrDelta, 6),
    cvr_lift_pct: cvrDelta === null || !(cvrC > 0) ? null : round((cvrDelta / cvrC) * 100, 4),
  };
}

/**
 * TIME TO DECISION — rough days until every arm holds `requiredPerArm`.
 *
 * Ported from funnel-os `lb_split_incremental_service.time_to_decision_days`.
 * Deliberately crude and deliberately present: the failure it exists to prevent
 * is an operator concluding on noise because the panel only ever said "not
 * significant". A number on screen — even a rough one — is what turns "keep
 * waiting" into a decision about whether the wait is affordable at all.
 *
 * `alreadyPerArm` is the WORST arm's current sample, so the estimate is the
 * REMAINING wait rather than the wait from zero. Passing 0 (or omitting it)
 * gives the from-scratch figure, which is the one to show before a test starts.
 *
 * Null — never 0 — when there is no rate to divide by. An unknown wait must
 * read as unknown; "0 days" reads as "decide now", which is the opposite.
 *
 * @param {number|null} requiredPerArm
 * @param {number} visitorsPerDay — total across all arms, the operator's own unit
 * @param {{arms?:number, alreadyPerArm?:number}} [opts]
 * @returns {number|null} days, 1dp
 */
export function timeToDecisionDays(requiredPerArm, visitorsPerDay, opts = {}) {
  const required = Number(requiredPerArm);
  if (!Number.isFinite(required) || required <= 0) return null;
  const rate = Number(visitorsPerDay);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const arms = nonNegInt(opts.arms) || 2;
  const already = nonNegInt(opts.alreadyPerArm);
  const remainingPerArm = Math.max(0, required - already);
  if (remainingPerArm === 0) return 0;
  const days = (remainingPerArm * arms) / rate;
  if (!Number.isFinite(days)) return null;
  return Math.round(days * 10) / 10;
}

// Prose for each withheld state. Written out rather than composed from
// fragments so the sentence an operator reads is reviewable in one place, and
// so no code path can assemble a half-sentence.
const WITHHOLD_PROSE = {
  no_arms: 'This test has no arms with any recorded traffic, so there is nothing to compare.',
  fewer_than_two_arms_with_data:
    'Only one arm has recorded traffic. A split test needs at least two arms with data before any '
    + 'comparison is possible — the figures below are a report, not an experiment.',
  below_stats_floor:
    `Both arms need at least ${MIN_STATS_SAMPLE} visitors before a confidence figure means anything. `
    + 'Below that the test would report a percentage drawn almost entirely from noise, so no p-value '
    + 'is calculated at all.',
  zero_variance:
    'Every visitor in both arms produced an identical outcome, so there is no variation for a '
    + 'significance test to work on. No p-value can be calculated from a constant.',
  no_control:
    'No control arm is marked on this test, so there is no baseline to compare the other arms '
    + 'against.',
};

const emptyComparison = () => ({
  p_value: null,
  confidence: null,
  significant: false,
  statistic: null,
  required_sample_per_arm: null,
  reason: null,
});

/**
 * THE WHOLE VERDICT for one split test, from per-arm rows.
 *
 * PURE: rows in, verdicts out. Every number is derived from the arguments and
 * nothing else — no DB, no clock, no environment.
 *
 * Each row: `{ arm_key, is_control, visitors, conversions, net_revenue,
 *              net_revenue_sum_squares }`
 *   • `visitors` is the FULL denominator (buyers AND non-buyers). A non-buyer is
 *     a genuine 0 observation; dropping them would compare only buyers, which is
 *     AOV, not RPV — a different metric on a different denominator.
 *   • `net_revenue` is Σx over that same population, and
 *     `net_revenue_sum_squares` is Σx². Sufficient statistics, so the caller can
 *     compute them in ONE SQL pass instead of shipping every row, and so the
 *     mean and the variance are guaranteed to come from the same series.
 *
 * Returns `{ arms: {arm_key: {...}}, verdict: {...}, floors: {...},
 *            method: {...} }`. `arms` is keyed rather than an array so a caller
 *            can attach each block to its own row without an index join.
 *
 * @param {Array} rows
 * @param {{alpha?:number, minVisitors?:number, minConversions?:number,
 *          visitorsPerDay?:number}} [opts]
 */
export function computeSplitStatistics(rows, opts = {}) {
  const alpha = Number.isFinite(opts.alpha) && opts.alpha > 0 ? opts.alpha : SPLIT_ALPHA;
  const minVisitors = nonNegInt(opts.minVisitors) || SPLIT_MIN_VISITORS_PER_ARM;
  const minConversions = Number.isFinite(Number(opts.minConversions)) && Number(opts.minConversions) >= 0
    ? Math.floor(Number(opts.minConversions))
    : SPLIT_MIN_CONVERSIONS_PER_ARM;

  const parsed = (Array.isArray(rows) ? rows : []).map((r) => {
    const visitors = nonNegInt(r?.visitors);
    return {
      arm_key: String(r?.arm_key ?? ''),
      is_control: Boolean(r?.is_control),
      visitors,
      conversions: Math.min(nonNegInt(r?.conversions), visitors),
      net_revenue: finite(r?.net_revenue),
      // Σx² is a sum of squares — it cannot be negative. A negative one is
      // corrupt input, and clamping it here stops varianceFromSums being fed a
      // value that would make the variance negative and every downstream sqrt
      // NaN.
      net_revenue_sum_squares: Math.max(0, finite(r?.net_revenue_sum_squares)),
    };
  });

  const floors = {
    min_visitors_per_arm: minVisitors,
    min_conversions_per_arm: minConversions,
    min_stats_sample: MIN_STATS_SAMPLE,
    alpha,
  };

  // Per-arm blocks exist for EVERY arm, always — including in every withheld
  // state. A UI that has to branch on "did the stats block come back?" ends up
  // rendering nothing at exactly the moment the operator most needs the
  // readiness numbers.
  const armsOut = {};
  for (const r of parsed) {
    const readiness = armReadiness(r, { minVisitors, minConversions });
    const variance = varianceFromSums(r.visitors, r.net_revenue, r.net_revenue_sum_squares);
    armsOut[r.arm_key] = {
      arm_key: r.arm_key,
      is_control: r.is_control,
      is_winner: false,
      visitors: r.visitors,
      conversions: r.conversions,
      // Rates are WITHHELD below the stats floor, exactly as funnelAnalytics
      // withholds `cvr`. A "50% conversion rate" off 2 visitors reads as a
      // measurement.
      cvr: r.visitors >= MIN_STATS_SAMPLE ? round(r.conversions / r.visitors, 6) : null,
      cvr_withheld: r.visitors > 0 && r.visitors < MIN_STATS_SAMPLE,
      rev_per_visitor: r.visitors > 0 ? round(r.net_revenue / r.visitors, 6) : null,
      net_revenue_variance: round(variance, 6),
      readiness,
      // Filled in below for non-control arms once a baseline exists AND the
      // withholding gates pass. Present-and-null, never absent — an absent key
      // and a null key render differently in JS and only one of them is honest.
      conversion: emptyComparison(),
      revenue: emptyComparison(),
      lift: null,
    };
  }

  const ranked = [...parsed].sort((x, y) => {
    const rx = x.visitors > 0 ? x.net_revenue / x.visitors : -Infinity;
    const ry = y.visitors > 0 ? y.net_revenue / y.visitors : -Infinity;
    return ry - rx;
  }).map((r) => r.arm_key);

  const withData = parsed.filter((r) => r.visitors > 0);
  const readinessAll = parsed.map((r) => armsOut[r.arm_key].readiness);
  const thinArms = readinessAll.filter((r) => !r.ready).map((r) => r.arm_key);
  const ready = parsed.length >= 2 && thinArms.length === 0;

  const withhold = (reason) => ({
    arms: armsOut,
    floors,
    method: SPLIT_STATS_METHOD,
    verdict: {
      status: 'insufficient_data',
      reason,
      headline: 'Not enough data to call this test.',
      body: WITHHOLD_PROSE[reason] || WITHHOLD_PROSE.below_stats_floor,
      winner: null,
      leader: null,
      control: parsed.find((r) => r.is_control)?.arm_key ?? null,
      ready,
      thin_arms: thinArms,
      comparisons: Math.max(0, parsed.length - 1),
      alpha_adjusted: null,
      required_sample_per_arm: null,
      time_to_decision_days: null,
      ranked,
    },
  });

  if (parsed.length < 2 || withData.length === 0) {
    return withhold(parsed.length < 2 ? 'fewer_than_two_arms_with_data' : 'no_arms');
  }
  if (withData.length < 2) return withhold('fewer_than_two_arms_with_data');

  // BASELINE. `is_control` is the ONLY source. There is deliberately no
  // fallback to "the busiest arm" or "the worst arm": buildVerdict falls back to
  // `ranked[ranked.length - 1]` (the WORST arm by revenue per visitor) when no
  // control is flagged, which silently flips every vs-control number and can
  // flip the verdict itself. splitTests.js guards the control in both directions
  // precisely so that fallback is unreachable there — so here, a missing control
  // is reported as a missing control rather than papered over with a guess.
  const control = parsed.find((r) => r.is_control);
  if (!control) return withhold('no_control');

  // Every arm must clear the STATISTICS floor — not the readiness floor — for a
  // p-value to be printed at all. Checked across all arms, not just the pair
  // being compared: a 3-arm test where one arm has 4 visitors cannot honestly
  // print a family-wide corrected alpha over a family that includes it.
  if (parsed.some((r) => r.visitors < MIN_STATS_SAMPLE)) return withhold('below_stats_floor');

  const comparisons = Math.max(1, parsed.length - 1);
  // Bonferroni. With 4 arms against one control at α=0.05 the chance of at
  // least one false winner is ~14% uncorrected. The corrected bar is the claim
  // the UI actually makes, so it is the bar every comparison is judged at.
  const alphaAdjusted = alpha / comparisons;

  const controlStats = {
    visitors: control.visitors,
    conversions: control.conversions,
    net_revenue: control.net_revenue,
    net_revenue_sum_squares: control.net_revenue_sum_squares,
  };

  // ZERO VARIANCE ACROSS THE WHOLE TEST. Checked once, over every arm: if no
  // arm has any spread in per-visitor revenue AND no arm's conversion rate
  // differs, there is nothing for either test to work on.
  const anyRevenueVariance = parsed.some(
    (r) => varianceFromSums(r.visitors, r.net_revenue, r.net_revenue_sum_squares) > 0
  );
  const anyCvrSpread = new Set(parsed.map((r) => r.conversions / r.visitors)).size > 1;
  if (!anyRevenueVariance && !anyCvrSpread) return withhold('zero_variance');

  let bestRpv = control.visitors > 0 ? control.net_revenue / control.visitors : -Infinity;
  let winner = null;
  const requiredCandidates = [];

  for (const r of parsed) {
    if (r.arm_key === control.arm_key) continue;
    const block = armsOut[r.arm_key];

    const conv = compareConversion(
      { visitors: controlStats.visitors, conversions: controlStats.conversions },
      { visitors: r.visitors, conversions: r.conversions },
      { alpha: alphaAdjusted }
    );
    const rev = compareRevenuePerVisitor(
      {
        visitors: controlStats.visitors,
        revenueSum: controlStats.net_revenue,
        revenueSumSquares: controlStats.net_revenue_sum_squares,
      },
      {
        visitors: r.visitors,
        revenueSum: r.net_revenue,
        revenueSumSquares: r.net_revenue_sum_squares,
      },
      { alpha: alphaAdjusted }
    );

    // `reason` non-null on the primitive means IT withheld — a degenerate pair.
    // The p-value it returns in that case is the degenerate placeholder (1),
    // which must NOT be published as a measurement. Nulled here, reason kept.
    const convDegenerate = Boolean(conv.reason);
    const revDegenerate = Boolean(rev.reason);

    block.conversion = {
      p_value: convDegenerate ? null : conv.pValue,
      confidence: convDegenerate ? null : conv.confidence,
      significant: !convDegenerate && conv.significant,
      statistic: convDegenerate ? null : conv.statistic,
      required_sample_per_arm: conv.requiredSamplePerArm ?? null,
      reason: conv.reason ?? null,
      normal_approx_weak: Boolean(conv.normalApproxWeak),
    };
    block.revenue = {
      p_value: revDegenerate ? null : rev.pValue,
      confidence: revDegenerate ? null : rev.confidence,
      significant: !revDegenerate && rev.significant,
      statistic: revDegenerate ? null : rev.statistic,
      degrees_of_freedom: rev.degreesOfFreedom ?? null,
      required_sample_per_arm: rev.requiredSamplePerArm ?? null,
      reason: rev.reason ?? null,
      sample_small: Boolean(rev.sampleSmall),
    };
    block.lift = incrementalLift(controlStats, r);

    if (Number.isFinite(conv.requiredSamplePerArm)) requiredCandidates.push(conv.requiredSamplePerArm);
    if (Number.isFinite(rev.requiredSamplePerArm)) requiredCandidates.push(rev.requiredSamplePerArm);

    // WINNER GATE — all three, and the order is the point:
    //   1. every arm past its readiness floors (a significant p-value on a thin
    //      sample is a coin that landed heads three times);
    //   2. this arm leads the control on net revenue per visitor;
    //   3. its RPV difference is significant at the CORRECTED alpha.
    // Ranked on MONEY, never on conversion rate: an arm can convert worse and
    // still be the winner if it sells a better basket.
    const rpv = r.visitors > 0 ? r.net_revenue / r.visitors : null;
    if (ready && !revDegenerate && rev.significant && rpv !== null && rpv > bestRpv) {
      bestRpv = rpv;
      winner = r.arm_key;
    }
  }

  if (winner) armsOut[winner].is_winner = true;

  // Report the HARDER of the required-N figures so "run it this much longer" is
  // never an underestimate, then FLOOR it at the readiness bar. Sizing on the
  // observed effect is biased: at small n the observed gap is inflated by noise,
  // so the raw formula happily answers "42 per arm" in the same breath the
  // readiness rule says 300. Without the floor the panel contradicts itself.
  const rawRequired = requiredCandidates.length ? Math.max(...requiredCandidates) : null;
  const requiredPerArm = rawRequired === null ? null : Math.max(rawRequired, minVisitors);

  const worstVisitors = Math.min(...parsed.map((r) => r.visitors));
  const timeToDecision = timeToDecisionDays(requiredPerArm, opts.visitorsPerDay, {
    arms: parsed.length,
    alreadyPerArm: worstVisitors,
  });

  const leader = ranked.find((k) => k !== control.arm_key) ?? null;

  let status;
  let headline;
  let body;
  if (winner) {
    const lift = armsOut[winner].lift;
    const conf = armsOut[winner].revenue.confidence;
    const pct = lift?.rpv_lift_pct;
    status = 'winner';
    headline = `${winner} beats ${control.arm_key} on net revenue per visitor`
      + (pct === null || pct === undefined ? '' : ` by ${round(pct, 1)}%`)
      + (conf === null ? '.' : ` — ${(conf * 100).toFixed(1)}% confidence.`);
    body = lift?.earned_so_far === null || lift?.earned_so_far === undefined
      ? 'Every arm has cleared its sample floors and the gap is significant at the corrected threshold.'
      : `On the traffic it has already taken, ${winner} earned $${lift.earned_so_far.toFixed(2)} more than `
        + `${control.arm_key}'s rate would have produced.`;
  } else if (!ready) {
    status = 'not_ready';
    headline = 'Not ready — the sample is still too thin to call.';
    body = `${thinArms.join(', ')} ${thinArms.length === 1 ? 'has' : 'have'} not reached `
      + `${minVisitors.toLocaleString('en-US')} visitors and ${minConversions} orders yet. `
      + (requiredPerArm
        ? `At the gap observed so far, proving it would take about `
          + `${requiredPerArm.toLocaleString('en-US')} visitors per arm`
          + (timeToDecision === null ? '.' : ` — roughly ${timeToDecision} more days at the current rate.`)
        : 'No winner can be named until every arm clears both floors.');
  } else {
    status = 'no_winner';
    headline = 'No winner yet — the arms are too close to call.';
    body = requiredPerArm
      ? `Every arm has cleared its floors, but the gap is not significant at the corrected threshold. `
        + `Proving it would take about ${requiredPerArm.toLocaleString('en-US')} visitors per arm`
        + (timeToDecision === null ? '.' : ` — roughly ${timeToDecision} more days at the current rate.`)
      : 'Every arm has cleared its floors and the observed gap is zero, so no amount of further traffic '
        + 'will prove one.';
  }

  return {
    arms: armsOut,
    floors,
    method: SPLIT_STATS_METHOD,
    verdict: {
      status,
      reason: null,
      headline,
      body,
      winner,
      leader,
      control: control.arm_key,
      ready,
      thin_arms: thinArms,
      comparisons,
      alpha_adjusted: round(alphaAdjusted),
      required_sample_per_arm: requiredPerArm,
      required_sample_raw: rawRequired,
      required_sample_floored: rawRequired !== null && rawRequired < minVisitors,
      sized_on_observed_effect: true,
      time_to_decision_days: timeToDecision,
      ranked,
    },
  };
}

// Stated method, shipped in the payload. A statistic without its method is a
// number the operator has to trust; with it, they can check.
export const SPLIT_STATS_METHOD = Object.freeze({
  conversion: 'two-proportion z-test, pooled SE, two-sided',
  revenue: "Welch's t-test on revenue per visitor, exact Student-t tail via regularized incomplete beta, two-sided",
  variance: 'reconstructed from sufficient statistics (n, Σx, Σx²) over the FULL visitor population, non-buyers included as 0',
  sample_size: 'observed-effect sizing at α=0.05 two-sided, power 0.80, floored at the readiness bar',
  multiplicity: 'Bonferroni over (arms − 1) comparisons against the control',
  ranking: 'net revenue per visitor',
  withheld: `no p-value below ${MIN_STATS_SAMPLE} visitors per arm, with fewer than 2 arms with data, or at zero variance`,
});

export { requiredSampleForProportions, requiredSampleForMeans };
