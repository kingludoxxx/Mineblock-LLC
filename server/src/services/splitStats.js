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
  formatConfidencePct,
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

// ── DISPLAY FLOORS FOR THE TAIL ────────────────────────────────────────────
//
// A p-value of 4e-9 is arithmetically fine and RENDERS AS A LIE. Rounded to six
// decimals it becomes 0.000000, and `1 - p` becomes exactly 1, which the panel
// prints as "100.0% confidence" — a claim no finite experiment can support and
// the single most over-confident string this module could emit.
//
// analyticsStats already refuses to do this on its zero-variance branch (it
// caps at 0.9999 and names the reason rather than emitting 1/Infinity). These
// two constants apply that same posture to the ORDINARY path, where a large
// sample with a real effect reaches the same place by a different road.
//
// FLOORED FOR DISPLAY, NOT FOR THE DECISION. `significant` is still judged on
// the true p against the corrected alpha, so flooring can never flip a verdict —
// it only stops the panel printing a certainty that does not exist.
export const P_DISPLAY_FLOOR = 1e-6;
export const CONFIDENCE_DISPLAY_CAP = 0.9999;

// A published p is never below the floor, and a published confidence is never
// above the cap. `p_value_floored` travels beside them so the UI can render
// "< 0.000001" rather than an exact-looking 0.000001.
const publishP = (p) => (p === null || p === undefined ? null : Math.max(Number(p), P_DISPLAY_FLOOR));
const publishConfidence = (c) => (c === null || c === undefined
  ? null
  : Math.min(Number(c), CONFIDENCE_DISPLAY_CAP));

/**
 * THE CONVERSION NUMERATOR, under two spellings.
 *
 * funnelAnalytics' arm rows call it `orders`; the split ledger
 * (`splitCredits.readResults`) calls it `conversions`. Both are accepted, and
 * the tie-break is EXPLICIT rather than positional:
 *
 *   the first POSITIVE value wins, checking `conversions` then `orders`;
 *   if neither is positive, the first value that is present at all wins.
 *
 * The positive-first rule exists because `orders: 0` is what an object literal
 * carries when the field was simply never populated, and a structural 0 must
 * not shadow a real count sitting in the other spelling. That is not
 * hypothetical: reading `orders` unconditionally is exactly how a real
 * cvr_delta of 0.03 got published as 0.00 in the first cut of this file.
 *
 * A genuine zero still survives — when BOTH spellings are absent or zero the
 * answer is 0, which is the truth for an arm that converted nothing.
 */
function conversionNumerator(row) {
  const candidates = [row?.conversions, row?.orders];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const v of candidates) {
    if (v !== undefined && v !== null) return v;
  }
  return 0;
}

/**
 * THE DENOMINATOR, under two spellings.
 *
 * `exposures` is this module's name for it (see the M4 note on
 * computeSplitStatistics). `visitors` is accepted because funnelAnalytics'
 * arm rows spell it that way, and rejecting them would make this module
 * usable from only one of its two natural callers.
 */
function exposureDenominator(row) {
  const e = Number(row?.exposures);
  if (Number.isFinite(e) && e > 0) return e;
  return row?.exposures !== undefined && row?.exposures !== null ? row.exposures : row?.visitors;
}

/**
 * PER-ARM READINESS — how far THIS arm is from being scoreable, in deltas.
 *
 * `buildVerdict` answers "which arms are thin"; this answers "how much more".
 * The deltas are what the UI prints ("needs ~240 more exposures") and they are
 * the reason this is per-arm rather than a single global figure: with 3 arms,
 * one can be 10 short while another is 2,000 short, and one number describing
 * both is wrong for both.
 *
 * THE UNIT IS `exposures`, NOT `visitors`, AND THE RENAME IS THE POINT. Two
 * different numbers were both called "visitors" on one screen: the results
 * table's `visitors` counts DELIVERED PAGE RENDERS (lb_split_views) while this
 * one counts ATTRIBUTABLE CHECKOUT SESSIONS (the exposure ledger). They differ
 * by a large factor in normal operation — 910 against 400 on the fixture that
 * exposed this — and an operator seeing "400/300 visitors ready" directly under
 * a table reading "910 visitors" concludes the panel is broken. Both numbers
 * are real; only one is this test's denominator.
 *
 * `blockers` is an ORDERED list of machine-readable reasons, so the UI can
 * render them without parsing prose. Empty ⇔ ready.
 *
 * @param {{arm_key?:string, exposures?:number, visitors?:number,
 *          conversions?:number, orders?:number}} row
 * @param {{minExposures?:number, minConversions?:number}} [opts]
 */
export function armReadiness(row, opts = {}) {
  const minExposures = nonNegInt(opts.minExposures) || SPLIT_MIN_VISITORS_PER_ARM;
  const minConversions = Number.isFinite(Number(opts.minConversions)) && Number(opts.minConversions) >= 0
    ? Math.floor(Number(opts.minConversions))
    : SPLIT_MIN_CONVERSIONS_PER_ARM;
  const exposures = nonNegInt(exposureDenominator(row));
  // Conversions are CLAMPED to the denominator. A crediting bug upstream that
  // reports more orders than exposures must produce a capped (wrong-but-sane)
  // readiness, never a negative "needs" that would read as a surplus.
  const conversions = Math.min(nonNegInt(conversionNumerator(row)), exposures);

  const needsExposures = Math.max(0, minExposures - exposures);
  const needsConversions = Math.max(0, minConversions - conversions);
  const blockers = [];
  if (needsExposures > 0) blockers.push('below_exposure_floor');
  if (needsConversions > 0) blockers.push('below_conversion_floor');

  return {
    arm_key: String(row?.arm_key ?? ''),
    exposures,
    conversions,
    ready: blockers.length === 0,
    needs_exposures: needsExposures,
    needs_conversions: needsConversions,
    min_exposures: minExposures,
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
  const nC = nonNegInt(exposureDenominator(control));
  const nV = nonNegInt(exposureDenominator(challenger));
  const revC = finite(control?.net_revenue);
  const revV = finite(challenger?.net_revenue);

  const rpvC = nC > 0 ? revC / nC : null;
  const rpvV = nV > 0 ? revV / nV : null;

  const ordersC = Math.min(nonNegInt(conversionNumerator(control)), nC);
  const ordersV = Math.min(nonNegInt(conversionNumerator(challenger)), nV);
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
 * @param {number} exposuresPerDay — total across all arms, the operator's own unit
 * @param {{arms?:number, alreadyPerArm?:number}} [opts]
 * @returns {number|null} days, 1dp
 */
export function timeToDecisionDays(requiredPerArm, exposuresPerDay, opts = {}) {
  const required = Number(requiredPerArm);
  if (!Number.isFinite(required) || required <= 0) return null;
  const rate = Number(exposuresPerDay);
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
// Each entry is a function of the shape it is describing, so the sentence can
// never disagree with the arm count it is talking about. The first cut wrote
// "Both arms need at least 30 visitors" unconditionally, which is simply false
// prose on a 4-arm test — and "Only one arm has recorded traffic" was reachable
// with ZERO arms, describing a state that did not exist.
const WITHHOLD_PROSE = {
  no_arms: () =>
    'This test has no arms, so there is nothing to compare. Add at least two arms to run it.',
  fewer_than_two_arms: () =>
    'This test has only one arm. A split test needs at least two before any comparison is '
    + 'possible — the figures below are a report, not an experiment.',
  fewer_than_two_arms_with_data: ({ withData }) =>
    `${withData === 0 ? 'No arm has' : 'Only one arm has'} recorded traffic yet. A comparison needs `
    + 'at least two arms with data, so no test has been run on these figures.',
  below_stats_floor: ({ total, qualifying }) =>
    `${qualifying === 0 ? 'No arm' : 'Only 1 of the ' + total + ' arms'} has reached the `
    + `${MIN_STATS_SAMPLE}-exposure minimum needed before a confidence figure means anything, and a `
    + 'comparison needs two. Below that floor a percentage is drawn almost entirely from noise, so '
    + 'no p-value is calculated at all.',
  zero_variance: () =>
    'Every exposure in every arm produced an identical outcome, so there is no variation for a '
    + 'significance test to work on. No p-value can be calculated from a constant.',
  no_control: () =>
    'No control arm is marked on this test, so there is no baseline to compare the other arms '
    + 'against.',
  control_below_stats_floor: () =>
    `The control arm has not reached the ${MIN_STATS_SAMPLE}-exposure minimum. Every comparison on `
    + 'this test is measured against the control, so until it clears the floor no arm can be scored '
    + '— however much traffic the other arms have taken.',
};

const emptyComparison = () => ({
  p_value: null,
  p_value_floored: false,
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
 * Each row: `{ arm_key, is_control, exposures, conversions, net_revenue,
 *              net_revenue_sum_squares }`
 *   • `exposures` is the FULL denominator (buyers AND non-buyers). A non-buyer
 *     is a genuine 0 observation; dropping them would compare only buyers, which
 *     is AOV, not RPV — a different metric on a different denominator.
 *     `visitors` is accepted as an alias for funnelAnalytics-shaped rows, and
 *     `orders` as an alias for `conversions`; see conversionNumerator.
 *   • `net_revenue` is Σx over that same population, and
 *     `net_revenue_sum_squares` is Σx². Sufficient statistics, so the caller can
 *     compute them in ONE SQL pass instead of shipping every row, and so the
 *     mean and the variance are guaranteed to come from the same series.
 *
 * ── SUB-FLOOR ARMS ARE EXCLUDED FROM THE FAMILY, NOT ALLOWED TO POISON IT ──
 *
 * The first cut gated on EVERY arm (`parsed.some(r => r.exposures < FLOOR)`)
 * and withheld the whole test if any one of them was thin. That is wrong in the
 * most expensive direction: adding a fresh arm to a 20,000-exposure test — or
 * merely having an archived zero-traffic arm ride along in readResults' output,
 * which it always does — nulled every figure on the entire test, while the
 * windowed banner thirty pixels above went on naming a winner. The operator saw
 * two panels disagreeing and believed the confident one.
 *
 * So the family is scoped:
 *   • QUALIFYING arms (`exposures >= MIN_STATS_SAMPLE`) are compared, counted in
 *     the Bonferroni correction, and subject to the readiness floors.
 *   • PENDING arms (below it) get `stats_status: 'insufficient'`, keep their
 *     readiness block so the panel can say how far off they are, and take NO
 *     part in the comparison, the alpha correction or the winner gate. They are
 *     reported in `verdict.pending_arms`.
 *   • The verdict needs >= 2 QUALIFYING arms; otherwise it withholds.
 *
 * The control is the one arm that cannot be merely pending: every comparison is
 * measured against it, so a sub-floor control withholds the whole test under its
 * own named reason.
 *
 * Returns `{ arms: {arm_key: {...}}, verdict: {...}, floors: {...},
 *            method: {...} }`. `arms` is keyed rather than an array so a caller
 *            can attach each block to its own row without an index join.
 *
 * @param {Array} rows
 * @param {{alpha?:number, minExposures?:number, minConversions?:number,
 *          exposuresPerDay?:number}} [opts]
 */
export function computeSplitStatistics(rows, opts = {}) {
  const alpha = Number.isFinite(opts.alpha) && opts.alpha > 0 ? opts.alpha : SPLIT_ALPHA;
  const minExposures = nonNegInt(opts.minExposures) || SPLIT_MIN_VISITORS_PER_ARM;
  const minConversions = Number.isFinite(Number(opts.minConversions)) && Number(opts.minConversions) >= 0
    ? Math.floor(Number(opts.minConversions))
    : SPLIT_MIN_CONVERSIONS_PER_ARM;
  const exposuresPerDay = opts.exposuresPerDay;

  const parsed = (Array.isArray(rows) ? rows : []).map((r) => {
    const exposures = nonNegInt(exposureDenominator(r));
    return {
      arm_key: String(r?.arm_key ?? ''),
      is_control: Boolean(r?.is_control),
      exposures,
      conversions: Math.min(nonNegInt(conversionNumerator(r)), exposures),
      net_revenue: finite(r?.net_revenue),
      // Σx² is a sum of squares — it cannot be negative. A negative one is
      // corrupt input, and clamping it here stops varianceFromSums being fed a
      // value that would make the variance negative and every downstream sqrt
      // NaN.
      net_revenue_sum_squares: Math.max(0, finite(r?.net_revenue_sum_squares)),
    };
  });

  const floors = {
    min_exposures_per_arm: minExposures,
    min_conversions_per_arm: minConversions,
    min_stats_sample: MIN_STATS_SAMPLE,
    alpha,
  };

  const qualifies = (r) => r.exposures >= MIN_STATS_SAMPLE;

  // Per-arm blocks exist for EVERY arm, always — including in every withheld
  // state. A UI that has to branch on "did the stats block come back?" ends up
  // rendering nothing at exactly the moment the operator most needs the
  // readiness numbers.
  const armsOut = {};
  for (const r of parsed) {
    const readiness = armReadiness(r, { minExposures, minConversions });
    const variance = varianceFromSums(r.exposures, r.net_revenue, r.net_revenue_sum_squares);
    const belowFloor = !qualifies(r);
    armsOut[r.arm_key] = {
      arm_key: r.arm_key,
      is_control: r.is_control,
      is_winner: false,
      // 'insufficient' — below the statistics floor, excluded from the family.
      // 'baseline'/'compared' are assigned once a control is resolved.
      stats_status: belowFloor ? 'insufficient' : 'pending_comparison',
      in_comparison: !belowFloor,
      exposures: r.exposures,
      conversions: r.conversions,
      // BOTH rates are withheld below the floor, and they are withheld
      // TOGETHER. The first cut withheld `cvr` but published
      // `rev_per_visitor` from the same sub-floor denominator — so the panel
      // refused to print "50% conversion" off 2 exposures and cheerfully
      // printed "$37.50 per visitor" off the same two. One floor, both rates.
      cvr: belowFloor ? null : round(r.conversions / r.exposures, 6),
      cvr_withheld: r.exposures > 0 && belowFloor,
      rev_per_exposure: belowFloor ? null : round(r.net_revenue / r.exposures, 6),
      rev_per_exposure_withheld: r.exposures > 0 && belowFloor,
      net_revenue_variance: round(variance, 6),
      readiness,
      // Filled in below for qualifying non-control arms. Present-and-null, never
      // absent — an absent key and a null key render differently in JS and only
      // one of them is honest.
      conversion: emptyComparison(),
      revenue: emptyComparison(),
      lift: null,
    };
  }

  // NaN-FREE COMPARATOR. `(-Infinity) - (-Infinity)` is NaN, so the previous
  // subtraction form made the sort comparator undefined for any PAIR of
  // zero-exposure arms — and a comparator that returns NaN leaves the order
  // engine-defined. Compared, not subtracted.
  const rpvOf = (r) => (r.exposures > 0 ? r.net_revenue / r.exposures : null);
  const ranked = [...parsed].sort((x, y) => {
    const rx = rpvOf(x);
    const ry = rpvOf(y);
    if (rx === null && ry === null) return String(x.arm_key).localeCompare(String(y.arm_key));
    if (rx === null) return 1;
    if (ry === null) return -1;
    if (rx === ry) return String(x.arm_key).localeCompare(String(y.arm_key));
    return ry - rx;
  }).map((r) => r.arm_key);

  const withData = parsed.filter((r) => r.exposures > 0);
  const qualifying = parsed.filter(qualifies);
  const pendingArms = parsed.filter((r) => !qualifies(r)).map((r) => r.arm_key);
  // Readiness is judged over the arms IN THE FAMILY. A pending arm is not
  // "thin", it is not yet part of the experiment at all — calling it thin is
  // what let one fresh arm hold an otherwise-conclusive test hostage.
  const thinArms = qualifying
    .map((r) => armsOut[r.arm_key].readiness)
    .filter((rd) => !rd.ready)
    .map((rd) => rd.arm_key);
  const ready = qualifying.length >= 2 && thinArms.length === 0;

  const withhold = (reason) => ({
    arms: armsOut,
    floors,
    method: SPLIT_STATS_METHOD,
    verdict: {
      status: 'insufficient_data',
      reason,
      headline: 'Not enough data to call this test.',
      body: (WITHHOLD_PROSE[reason] || WITHHOLD_PROSE.below_stats_floor)({
        total: parsed.length,
        withData: withData.length,
        qualifying: qualifying.length,
      }),
      winner: null,
      leader: null,
      control: parsed.find((r) => r.is_control)?.arm_key ?? null,
      ready,
      thin_arms: thinArms,
      pending_arms: pendingArms,
      qualifying_arms: qualifying.map((r) => r.arm_key),
      comparisons: Math.max(0, qualifying.length - 1),
      alpha_adjusted: null,
      required_sample_per_arm: null,
      time_to_decision_days: null,
      ranked,
    },
  });

  if (parsed.length === 0) return withhold('no_arms');
  if (parsed.length === 1) return withhold('fewer_than_two_arms');
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
  // The control is the one arm that may not merely be pending — every
  // comparison is measured against it.
  if (!qualifies(control)) return withhold('control_below_stats_floor');
  if (qualifying.length < 2) return withhold('below_stats_floor');

  armsOut[control.arm_key].stats_status = 'baseline';

  // Bonferroni over the QUALIFYING family only. Counting a pending arm here
  // would tighten every other arm's bar for a comparison that is not being made.
  const comparisons = Math.max(1, qualifying.length - 1);
  // Bonferroni. With 4 arms against one control at α=0.05 the chance of at
  // least one false winner is ~14% uncorrected. The corrected bar is the claim
  // the UI actually makes, so it is the bar every comparison is judged at.
  const alphaAdjusted = alpha / comparisons;

  const controlStats = {
    exposures: control.exposures,
    conversions: control.conversions,
    net_revenue: control.net_revenue,
    net_revenue_sum_squares: control.net_revenue_sum_squares,
  };

  // ZERO VARIANCE ACROSS THE FAMILY. Over QUALIFYING arms only, for the same
  // reason the comparisons are: a pending arm's constant outcome says nothing
  // about whether the arms being compared have spread.
  const anyRevenueVariance = qualifying.some(
    (r) => varianceFromSums(r.exposures, r.net_revenue, r.net_revenue_sum_squares) > 0
  );
  const anyCvrSpread = new Set(qualifying.map((r) => r.conversions / r.exposures)).size > 1;
  if (!anyRevenueVariance && !anyCvrSpread) return withhold('zero_variance');

  let bestRpv = control.exposures > 0 ? control.net_revenue / control.exposures : -Infinity;
  let winner = null;
  const requiredCandidates = [];

  for (const r of qualifying) {
    if (r.arm_key === control.arm_key) continue;
    const block = armsOut[r.arm_key];
    block.stats_status = 'compared';

    const conv = compareConversion(
      { visitors: controlStats.exposures, conversions: controlStats.conversions },
      { visitors: r.exposures, conversions: r.conversions },
      { alpha: alphaAdjusted }
    );
    const rev = compareRevenuePerVisitor(
      {
        visitors: controlStats.exposures,
        revenueSum: controlStats.net_revenue,
        revenueSumSquares: controlStats.net_revenue_sum_squares,
      },
      {
        visitors: r.exposures,
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

    // SIGNIFICANCE IS JUDGED ON THE TRUE p, PUBLISHED ON THE FLOORED ONE. The
    // display floor can therefore never move a verdict — it only stops the
    // panel printing a certainty no finite sample supports.
    block.conversion = {
      p_value: convDegenerate ? null : publishP(conv.pValue),
      p_value_floored: !convDegenerate && conv.pValue < P_DISPLAY_FLOOR,
      confidence: convDegenerate ? null : publishConfidence(conv.confidence),
      significant: !convDegenerate && conv.significant,
      statistic: convDegenerate ? null : conv.statistic,
      required_sample_per_arm: conv.requiredSamplePerArm ?? null,
      reason: conv.reason ?? null,
      normal_approx_weak: Boolean(conv.normalApproxWeak),
    };
    block.revenue = {
      p_value: revDegenerate ? null : publishP(rev.pValue),
      p_value_floored: !revDegenerate && rev.pValue < P_DISPLAY_FLOOR,
      confidence: revDegenerate ? null : publishConfidence(rev.confidence),
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
    //   1. every QUALIFYING arm past its readiness floors (a significant
    //      p-value on a thin sample is a coin that landed heads three times);
    //   2. this arm leads the control on net revenue per exposure;
    //   3. its RPV difference is significant at the CORRECTED alpha.
    // Ranked on MONEY, never on conversion rate: an arm can convert worse and
    // still be the winner if it sells a better basket.
    const rpv = r.exposures > 0 ? r.net_revenue / r.exposures : null;
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
  const requiredPerArm = rawRequired === null ? null : Math.max(rawRequired, minExposures);

  // Over QUALIFYING arms — the wait is until the arms IN THE COMPARISON are big
  // enough. A pending arm's tiny sample is not what the operator is waiting on.
  const worstExposures = Math.min(...qualifying.map((r) => r.exposures));
  const timeToDecision = timeToDecisionDays(requiredPerArm, exposuresPerDay, {
    arms: qualifying.length,
    alreadyPerArm: worstExposures,
  });
  // The projection sentence is only appended where it is TRUE. In the winner
  // state there is nothing left to prove, and appending "proving it would take
  // N more" under a declared winner is the orphan sentence the review caught.
  const waitClause = requiredPerArm
    ? `about ${requiredPerArm.toLocaleString('en-US')} exposures per arm`
      + (timeToDecision === null ? '.' : ` — roughly ${timeToDecision} more days at the current rate.`)
    : null;
  // ── WHY THE BAR IS WHERE IT IS ─────────────────────────────────────────
  //
  // A winner can be REVOKED without a single number moving: a third arm crosses
  // the statistics floor, joins the family, and Bonferroni divides the
  // threshold — so yesterday's significant result is today's "not significant"
  // and nothing on screen explains it. That is the moment an operator stops
  // trusting the panel.
  //
  // This module is PURE and has no memory, so it cannot observe the transition
  // by itself. Two honest forms:
  //   • given `previousComparisons` by a caller that DOES have history, it
  //     narrates the change;
  //   • otherwise it states the current correction whenever one is in force,
  //     which is what actually answers "why is the bar 0.025?".
  // Never invented: with a single comparison there is no correction and the
  // sentence is absent entirely.
  const prevComparisons = Number(opts.previousComparisons);
  const grew = Number.isFinite(prevComparisons) && prevComparisons > 0 && comparisons > prevComparisons;
  const correctionClause = comparisons > 1
    ? (grew
      ? ` ${qualifying.length} arms are now in the comparison (up from ${prevComparisons + 1}), so the `
        + `significance bar tightened to α ${round(alphaAdjusted, 6)} — a result that cleared the old bar `
        + 'may no longer clear this one.'
      : ` ${qualifying.length} arms are in the comparison, so the significance bar is Bonferroni-corrected `
        + `to α ${round(alphaAdjusted, 6)} rather than ${alpha}.`)
    : '';

  const pendingClause = pendingArms.length
    ? ` ${pendingArms.join(', ')} ${pendingArms.length === 1 ? 'is' : 'are'} still collecting and `
      + `${pendingArms.length === 1 ? 'is' : 'are'} not part of this comparison yet.`
    : '';

  const leader = ranked.find((k) => k !== control.arm_key) ?? null;

  let status;
  let headline;
  let body;
  if (winner) {
    const lift = armsOut[winner].lift;
    const conf = armsOut[winner].revenue.confidence;
    const pct = lift?.rpv_lift_pct;
    status = 'winner';
    headline = `${winner} beats ${control.arm_key} on net revenue per exposure`
      + (pct === null || pct === undefined ? '' : ` by ${round(pct, 1)}%`)
      // ONE shared formatter (analyticsStats.formatConfidencePct) — this string
      // and the windowed banner's are built by the same function precisely so
      // they cannot disagree about what 0.9999 looks like. Both used to print
      // "100.0% confidence" above cells reading ">99.99%".
      + (conf === null ? '.' : ` — ${formatConfidencePct(conf)} confidence.`);
    body = (lift?.earned_so_far === null || lift?.earned_so_far === undefined
      ? 'Every compared arm has cleared its sample floors and the gap is significant at the '
        + 'corrected threshold.'
      : `On the traffic it has already taken, ${winner} earned $${lift.earned_so_far.toFixed(2)} more than `
        + `${control.arm_key}'s rate would have produced.`) + pendingClause + correctionClause;
  } else if (!ready) {
    status = 'not_ready';
    headline = 'Not ready — the sample is still too thin to call.';
    // PER ARM, NOT ONE CONJUNCTION FOR ALL OF THEM. The old sentence asserted
    // BOTH floors against EVERY thin arm — "a, b have not reached 300 exposures
    // and 25 orders yet" — which is simply false about an arm that has 4,000
    // exposures and is short only on orders. It also told the operator to go get
    // the wrong thing. Each arm now states its own shortfall.
    const shortfalls = thinArms.map((k) => {
      const rd = armsOut[k].readiness;
      const needs = [];
      if (rd.needs_exposures > 0) needs.push(`~${rd.needs_exposures.toLocaleString('en-US')} more exposures`);
      if (rd.needs_conversions > 0) needs.push(`~${rd.needs_conversions.toLocaleString('en-US')} more orders`);
      return `${k} needs ${needs.join(' and ')}`;
    });
    body = `${shortfalls.join('; ')}. `
      + (waitClause
        ? `At the gap observed so far, proving it would take ${waitClause}`
        : 'No winner can be named until every compared arm clears both floors.')
      + pendingClause + correctionClause;
  } else {
    status = 'no_winner';
    headline = 'No winner yet — the arms are too close to call.';
    body = (waitClause
      ? 'Every compared arm has cleared its floors, but the gap is not significant at the corrected '
        + `threshold. Proving it would take ${waitClause}`
      : 'Every compared arm has cleared its floors and the observed gap is zero, so no amount of '
        + 'further traffic will prove one.') + pendingClause + correctionClause;
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
      // Arms below the statistics floor: reported so the panel can say they are
      // still collecting, and excluded from every number above.
      pending_arms: pendingArms,
      qualifying_arms: qualifying.map((r) => r.arm_key),
      comparisons,
      alpha_adjusted: round(alphaAdjusted),
      required_sample_per_arm: requiredPerArm,
      required_sample_raw: rawRequired,
      required_sample_floored: rawRequired !== null && rawRequired < minExposures,
      // Only true where a projection was actually emitted, so the UI's caveat
      // cannot orphan itself under a winner.
      sized_on_observed_effect: Boolean(waitClause) && !winner,
      time_to_decision_days: winner ? null : timeToDecision,
      ranked,
    },
  };
}

// Stated method, shipped in the payload. A statistic without its method is a
// number the operator has to trust; with it, they can check.
export const SPLIT_STATS_METHOD = Object.freeze({
  conversion: 'two-proportion z-test, pooled SE, two-sided',
  revenue: "Welch's t-test on revenue per visitor, exact Student-t tail via regularized incomplete beta, two-sided",
  variance: 'reconstructed from sufficient statistics (n, Σx, Σx²) over the FULL exposure population, non-buyers included as 0',
  sample_size: 'observed-effect sizing at α=0.05 two-sided, power 0.80, floored at the readiness bar',
  multiplicity: 'Bonferroni over (qualifying arms − 1) comparisons against the control',
  ranking: 'net revenue per exposure',
  denominator: 'exposures = attributable checkout sessions (the credits ledger), NOT delivered page renders',
  withheld: `arms below ${MIN_STATS_SAMPLE} exposures are excluded from the comparison and reported as pending; `
    + 'the whole test is withheld with fewer than 2 qualifying arms, a sub-floor control, or zero variance',
  display_floor: `p-values are published no lower than ${P_DISPLAY_FLOOR} and confidence no higher than `
    + `${CONFIDENCE_DISPLAY_CAP}; significance is judged on the TRUE p, so the floor never moves a verdict`,
});

export { requiredSampleForProportions, requiredSampleForMeans };
