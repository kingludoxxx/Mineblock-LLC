// Split-test statistics — PURE functions, no DB, no I/O (SELF-CONTAINED, NEW FILE).
//
// Powers the split-results verdict banner ("No winner yet — the arms are too
// close … proving the gap would take about N visitors per arm").
//
// THE CONTRACT EVERY EXPORT HONOURS: a returned number is ALWAYS finite. There
// is no input — n=0, n=1, zero variance, identical arms, all-zero revenue —
// that can produce NaN or Infinity. Degenerate inputs return
// `confidence: 0.5, significant: false` plus a `reason` string, because "we
// cannot tell" is the honest answer and 50% is exactly what a coin flip is
// worth. `requiredSamplePerArm` is `null` (never Infinity) when the observed
// gap is zero, since no finite sample proves a zero difference.
//
// ── METHOD + ASSUMPTIONS (stated, because they are load-bearing) ───────────
//
// (a) CONVERSION RATE → two-proportion z-test, POOLED standard error, two-sided.
//       p̂ = (x₁+x₂)/(n₁+n₂)
//       se = sqrt( p̂(1−p̂) · (1/n₁ + 1/n₂) )
//       z  = (p₂ − p₁) / se ;  p-value = 2·(1 − Φ(|z|)) ;  confidence = 1 − p
//     Assumes independent Bernoulli trials and a normal approximation to the
//     binomial. That approximation degrades when the expected success count per
//     arm is small; we therefore emit `normal_approx_weak: true` when any of
//     n·p or n·(1−p) is < 5 (the textbook rule of thumb) so the UI can hedge
//     rather than us silently returning a confident-looking number.
//
// (b) REVENUE PER VISITOR → WELCH's t-test (unequal variances), two-sided, with
//     an EXACT Student-t tail via the regularized incomplete beta function —
//     not a normal approximation, because RPV samples are small far more often
//     than conversion samples are.
//       t  = (m₂ − m₁) / sqrt( v₁/n₁ + v₂/n₂ )
//       ν  = (v₁/n₁ + v₂/n₂)² / [ (v₁/n₁)²/(n₁−1) + (v₂/n₂)²/(n₂−1) ]
//     Assumes the per-visitor revenue values are i.i.d. within an arm. They are
//     NOT normal — RPV is a zero-inflated, right-skewed distribution (most
//     visitors contribute exactly 0, a few contribute a large order). Welch's
//     t is robust here by the CLT once n is in the hundreds, which is the
//     regime a split test actually runs in; below that the test is
//     under-powered and we say so via `sample_small`. This caveat is reported,
//     not hidden.
//     Variance is reconstructed from sufficient statistics (n, Σx, Σx²) so the
//     caller can compute it in ONE SQL pass instead of shipping every row:
//       v = (Σx² − (Σx)²/n) / (n − 1)      [clamped at 0 for float error]
//
// (c) REQUIRED SAMPLE PER ARM — the classic two-sample size formula, sized to
//     detect the CURRENTLY OBSERVED gap (not some hypothetical MDE):
//       proportions: n = ( z_{α/2}·sqrt(2p̄(1−p̄)) + z_β·sqrt(p₁q₁ + p₂q₂) )² / δ²
//       means:       n = ( z_{α/2} + z_β )² · (v₁ + v₂) / δ²
//     with α = 0.05 two-sided ("at 95%") and power 1−β = 0.80 by default.
//     MONOTONICITY, which the harness asserts: n ∝ 1/δ², so a SMALLER observed
//     gap always yields a LARGER N.

// Two-sided α = 0.05 and power 0.80. Hard-coded rather than computed from an
// inverse-normal, because these two constants are the only quantiles we need
// and a wrong inverse-normal would be invisible.
const Z_ALPHA_TWO_SIDED_95 = 1.959963984540054; // Φ⁻¹(0.975)
const Z_POWER_80 = 0.8416212335729143; //           Φ⁻¹(0.80)

// Never return a required-N that is really "we have no idea". Anything above
// this is reported as null with reason 'gap_too_small_to_size'.
const MAX_REQUIRED_N = 100_000_000;

const finite = (v) => (Number.isFinite(v) ? v : 0);
const nonNegInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const round = (v, dp = 6) => {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/**
 * Complementary error function — Numerical Recipes' Chebyshev fit `erfcc`.
 * Fractional error everywhere < 1.2e-7, which is far tighter than the 0.1%
 * resolution a confidence percentage is displayed at.
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15,
  ];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j -= 1) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF Φ(z). */
export function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 1 - 0.5 * erfc(z / Math.SQRT2);
}

/** log Γ(x) — Lanczos approximation, needed by the incomplete beta. */
function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction evaluation of the incomplete beta (modified Lentz). */
function betaContinuedFraction(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value of Student's t with `df` degrees of freedom.
 * Exact (to float precision), not a normal approximation.
 */
export function tTestTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  const p = incompleteBeta(df / 2, 0.5, x);
  // Clamp: the CF can overshoot by ~1e-16 at the tails.
  return Math.min(1, Math.max(0, p));
}

/**
 * Sample variance from sufficient statistics (n, Σx, Σx²).
 * Clamped at 0 — catastrophic cancellation on a near-constant sample can push
 * the numerator a few ulps negative, and a negative variance would poison
 * every downstream sqrt into NaN.
 */
export function varianceFromSums(n, sum, sumSquares) {
  const N = nonNegInt(n);
  if (N < 2) return 0;
  const num = finite(sumSquares) - (finite(sum) * finite(sum)) / N;
  return num > 0 ? num / (N - 1) : 0;
}

const DEGENERATE = (reason) => ({
  confidence: 0.5,
  significant_uncorrected: false,
  significant: false,
  alpha: 0.05,
  requiredSamplePerArm: null,
  pValue: 1,
  statistic: 0,
  reason,
});

/**
 * Two-proportion z-test on conversion rate.
 *
 * @param {{visitors:number, conversions:number}} control
 * @param {{visitors:number, conversions:number}} variant
 * @param {{power?:number}} [opts] — power for the sample-size calc (0.80 default)
 * @returns {{confidence:number, significant:boolean, requiredSamplePerArm:number|null,
 *            pValue:number, statistic:number, reason:string|null,
 *            controlRate:number|null, variantRate:number|null, absoluteLift:number,
 *            relativeLift:number|null, normalApproxWeak:boolean}}
 */
export function compareConversion(control, variant, opts = {}) {
  // `alpha` is the bar this comparison is judged at. buildVerdict passes the
  // BONFERRONI-ADJUSTED value so that `significant` and the verdict gate can
  // never disagree — previously `significant` was p<0.05 flat while the gate
  // used α/(k−1), so a 5-arm test could report `significant: true` on an arm
  // the verdict correctly refused to call. `significant_uncorrected` keeps the
  // raw p<0.05 answer for anyone who wants it, explicitly named.
  const alpha = Number.isFinite(opts.alpha) && opts.alpha > 0 ? opts.alpha : 0.05;
  const n1 = nonNegInt(control?.visitors);
  const n2 = nonNegInt(variant?.visitors);
  // Conversions can never exceed the denominator; clamping here means a
  // crediting bug upstream produces a capped (wrong-but-sane) rate instead of
  // a >100% rate that silently breaks sqrt(p(1-p)) into NaN.
  const x1 = Math.min(nonNegInt(control?.conversions), n1);
  const x2 = Math.min(nonNegInt(variant?.conversions), n2);

  const base = {
    controlRate: n1 > 0 ? round(x1 / n1) : null,
    variantRate: n2 > 0 ? round(x2 / n2) : null,
    absoluteLift: 0,
    relativeLift: null,
    normalApproxWeak: true,
  };

  if (n1 < 1 || n2 < 1) return { ...DEGENERATE('insufficient_sample'), ...base };

  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const delta = p2 - p1;
  base.absoluteLift = round(delta);
  base.relativeLift = p1 > 0 ? round(delta / p1) : null;
  base.normalApproxWeak =
    n1 * p1 < 5 || n1 * (1 - p1) < 5 || n2 * p2 < 5 || n2 * (1 - p2) < 5;

  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

  // se === 0 ⇔ every visitor in BOTH arms converted, or none did. The arms are
  // then identical by construction and there is nothing to detect.
  if (!(se > 0)) return { ...DEGENERATE('zero_variance_identical'), ...base };
  if (delta === 0) {
    return {
      ...DEGENERATE('no_observed_difference'),
      ...base,
      requiredSamplePerArm: null,
    };
  }

  const z = delta / se;
  const pValue = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));

  return {
    confidence: round(1 - pValue),
    significant: pValue < alpha,
    significant_uncorrected: pValue < 0.05,
    alpha: round(alpha),
    requiredSamplePerArm: requiredSampleForProportions(p1, p2, opts.power),
    sized_on_observed_effect: true,
    pValue: round(pValue),
    statistic: round(z, 4),
    reason: null,
    ...base,
  };
}

/**
 * Welch's t-test on revenue per visitor, from sufficient statistics.
 *
 * `visitors` is the FULL denominator (buyers and non-buyers): a non-buyer is a
 * genuine 0 observation and dropping them would compare only buyers, which is
 * AOV, not RPV — a different metric with a different denominator.
 *
 * @param {{visitors:number, revenueSum:number, revenueSumSquares:number}} control
 * @param {{visitors:number, revenueSum:number, revenueSumSquares:number}} variant
 */
export function compareRevenuePerVisitor(control, variant, opts = {}) {
  const alpha = Number.isFinite(opts.alpha) && opts.alpha > 0 ? opts.alpha : 0.05;
  const n1 = nonNegInt(control?.visitors);
  const n2 = nonNegInt(variant?.visitors);
  const s1 = finite(Number(control?.revenueSum));
  const s2 = finite(Number(variant?.revenueSum));
  const q1 = finite(Number(control?.revenueSumSquares));
  const q2 = finite(Number(variant?.revenueSumSquares));

  const base = {
    controlRpv: n1 > 0 ? round(s1 / n1, 6) : null,
    variantRpv: n2 > 0 ? round(s2 / n2, 6) : null,
    absoluteLift: 0,
    relativeLift: null,
    sampleSmall: n1 < 100 || n2 < 100,
  };

  // Welch needs n ≥ 2 per arm to have any variance at all.
  if (n1 < 2 || n2 < 2) return { ...DEGENERATE('insufficient_sample'), ...base };

  const m1 = s1 / n1;
  const m2 = s2 / n2;
  const delta = m2 - m1;
  base.absoluteLift = round(delta, 6);
  base.relativeLift = m1 > 0 ? round(delta / m1) : null;

  const v1 = varianceFromSums(n1, s1, q1);
  const v2 = varianceFromSums(n2, s2, q2);
  const se2 = v1 / n1 + v2 / n2;

  if (!(se2 > 0)) {
    // Both arms are perfectly constant. Either they are the same constant
    // (nothing to detect) or they differ with zero within-arm noise, which is
    // overwhelming evidence — but we cap the reported confidence at 0.9999
    // rather than emitting 1/Infinity, and we name the reason so the UI can
    // show "degenerate sample" instead of a fake certainty.
    if (delta === 0) return { ...DEGENERATE('zero_variance_identical'), ...base };
    return {
      confidence: 0.9999,
      significant: 0.0001 < alpha,
      significant_uncorrected: true,
      alpha: round(alpha),
      requiredSamplePerArm: 2,
      pValue: 0.0001,
      statistic: 0,
      reason: 'zero_variance_separated',
      ...base,
    };
  }
  if (delta === 0) {
    return { ...DEGENERATE('no_observed_difference'), ...base };
  }

  const t = delta / Math.sqrt(se2);
  const a = (v1 / n1) ** 2 / (n1 - 1);
  const b = (v2 / n2) ** 2 / (n2 - 1);
  // a+b > 0 is guaranteed: se2 > 0 means at least one of v1,v2 is > 0.
  const df = se2 ** 2 / (a + b);
  const pValue = tTestTwoSidedP(t, df);

  return {
    confidence: round(1 - pValue),
    significant: pValue < alpha,
    significant_uncorrected: pValue < 0.05,
    alpha: round(alpha),
    requiredSamplePerArm: requiredSampleForMeans(v1, v2, delta, opts.power),
    sized_on_observed_effect: true,
    pValue: round(pValue),
    statistic: round(t, 4),
    degreesOfFreedom: round(df, 2),
    reason: null,
    ...base,
  };
}

/** Sample per arm to detect an observed p₁ vs p₂ gap at α=0.05 two-sided. */
export function requiredSampleForProportions(p1, p2, power = 0.8) {
  const d = Math.abs(p2 - p1);
  if (!(d > 0)) return null;
  const zb = power === 0.9 ? 1.2815515655446004 : Z_POWER_80;
  const pbar = (p1 + p2) / 2;
  const term1 = Z_ALPHA_TWO_SIDED_95 * Math.sqrt(2 * pbar * (1 - pbar));
  const term2 = zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const n = (term1 + term2) ** 2 / (d * d);
  if (!Number.isFinite(n) || n > MAX_REQUIRED_N) return null;
  return Math.max(2, Math.ceil(n));
}

/** Sample per arm to detect an observed mean gap `delta` at α=0.05 two-sided. */
export function requiredSampleForMeans(v1, v2, delta, power = 0.8) {
  const d = Math.abs(finite(delta));
  const pooled = Math.max(0, finite(v1)) + Math.max(0, finite(v2));
  if (!(d > 0) || !(pooled > 0)) return null;
  const zb = power === 0.9 ? 1.2815515655446004 : Z_POWER_80;
  const n = ((Z_ALPHA_TWO_SIDED_95 + zb) ** 2 * pooled) / (d * d);
  if (!Number.isFinite(n) || n > MAX_REQUIRED_N) return null;
  return Math.max(2, Math.ceil(n));
}

// Readiness floors, ported from funnel-os lb_split_winners_service. A test is
// not "ready" until EVERY arm clears both. They exist because a two-proportion
// z-test on 40 visitors will happily report 96% confidence on noise.
export const SPLIT_MIN_VISITORS_PER_ARM = 300;
export const SPLIT_MIN_CONVERSIONS_PER_ARM = 25;
// Below this many attributable visitors a rate is withheld (null) and the UI
// prints raw counts instead of a percentage that reads as precision.
export const MIN_RATE_SAMPLE = 30;

/**
 * The operator-facing verdict for a whole test.
 *
 * Ranks arms by NET REVENUE PER VISITOR (the operator's reference report ranks
 * on exactly this, not on conversion rate: an arm can convert worse and still
 * be the winner if it sells a better basket). The verdict compares the top arm
 * against the CONTROL, and reports the harder of the two required-N figures so
 * "run it this much longer" is not an underestimate.
 *
 * BONFERRONI: with k arms there are k−1 comparisons against control, so the
 * significance bar is α/(k−1). Without it, a 5-arm test finds a "winner" at
 * α=0.05 about one time in five by chance alone.
 *
 * @param {Array} arms — each { arm_key, is_control, visitors, orders,
 *                              net_revenue, net_revenue_sum_squares }
 */
export function buildVerdict(arms) {
  const rows = (Array.isArray(arms) ? arms : []).map((a) => {
    const visitors = nonNegInt(a?.visitors);
    const net = finite(Number(a?.net_revenue));
    return {
      arm_key: String(a?.arm_key ?? ''),
      is_control: Boolean(a?.is_control),
      visitors,
      orders: Math.min(nonNegInt(a?.orders), visitors),
      net_revenue: net,
      net_revenue_sum_squares: Math.max(0, finite(Number(a?.net_revenue_sum_squares))),
      rev_per_visitor: visitors > 0 ? net / visitors : null,
    };
  });

  if (rows.length < 2) {
    return {
      status: 'insufficient_arms',
      headline: 'Not enough arms to compare.',
      leader: rows[0]?.arm_key ?? null,
      control: rows.find((r) => r.is_control)?.arm_key ?? null,
      conversion: null,
      revenue: null,
      requiredSamplePerArm: null,
      ranked: rows.map((r) => r.arm_key),
    };
  }

  // Rank on net rev/visitor; an arm with no visitors ranks last (never first
  // on a null) so a zero-traffic arm can't be declared the leader.
  const ranked = [...rows].sort(
    (x, y) => (y.rev_per_visitor ?? -Infinity) - (x.rev_per_visitor ?? -Infinity)
  );
  const control = rows.find((r) => r.is_control) || ranked[ranked.length - 1];
  const leader = ranked[0];
  const challenger = leader.arm_key === control.arm_key ? ranked[1] : leader;

  // Bonferroni FIRST: k arms ⇒ k−1 comparisons against control. Every
  // comparison below is judged at the adjusted bar, so `significant` on a
  // comparison and the verdict gate can never disagree.
  const comparisons = Math.max(1, rows.length - 1);
  const alphaAdjusted = 0.05 / comparisons;

  const cmp = (arm) => ({
    conversion: compareConversion(
      { visitors: control.visitors, conversions: control.orders },
      { visitors: arm.visitors, conversions: arm.orders },
      { alpha: alphaAdjusted }
    ),
    revenue: compareRevenuePerVisitor(
      {
        visitors: control.visitors,
        revenueSum: control.net_revenue,
        revenueSumSquares: control.net_revenue_sum_squares,
      },
      {
        visitors: arm.visitors,
        revenueSum: arm.net_revenue,
        revenueSumSquares: arm.net_revenue_sum_squares,
      },
      { alpha: alphaAdjusted }
    ),
  });

  // PER-ARM, not one scalar. A single confidence painted under every arm is
  // wrong the moment there are 3+ arms: arm C would display arm B's 97% even
  // when C is losing to control. Each non-control arm is compared against
  // control on its own.
  const perArm = {};
  for (const a of rows) {
    if (a.arm_key === control.arm_key) continue;
    const c = cmp(a);
    perArm[a.arm_key] = {
      conversion_confidence: c.conversion.confidence,
      revenue_confidence: c.revenue.confidence,
      significant: c.revenue.significant,
      significant_uncorrected: c.revenue.significant_uncorrected,
      requiredSamplePerArm: c.revenue.requiredSamplePerArm,
    };
  }

  const headToHead = cmp(challenger);
  const conversion = headToHead.conversion;
  const revenue = headToHead.revenue;

  // The headline metric IS revenue per visitor. Conversion is reported
  // alongside but never overrides it — DECISIONS #8's warning about mixing
  // denominators applies here too: these are two tests, not one.
  const needed = [conversion.requiredSamplePerArm, revenue.requiredSamplePerArm]
    .filter((n) => Number.isFinite(n));
  // FLOORED AT THE READINESS BAR. Sizing on the OBSERVED effect is biased: at
  // small n the observed gap is inflated by noise, so the formula happily
  // answers "42 visitors per arm" in the same breath the readiness rule says
  // "you need 300". Reporting the raw figure produced a self-contradicting
  // sentence. The floor makes the two agree, and `sized_on_observed_effect`
  // tells the UI to render the caveat rather than treat this as a forecast.
  const rawRequired = needed.length ? Math.max(...needed) : null;
  const requiredSamplePerArm =
    rawRequired === null ? null : Math.max(rawRequired, SPLIT_MIN_VISITORS_PER_ARM);
  const thin = rows.filter(
    (r) =>
      r.visitors < SPLIT_MIN_VISITORS_PER_ARM || r.orders < SPLIT_MIN_CONVERSIONS_PER_ARM
  );
  const ready = thin.length === 0;
  const sample = {
    ready,
    comparisons,
    alphaAdjusted: round(alphaAdjusted),
    minVisitorsPerArm: SPLIT_MIN_VISITORS_PER_ARM,
    minConversionsPerArm: SPLIT_MIN_CONVERSIONS_PER_ARM,
    thinArms: thin.map((r) => r.arm_key),
    requiredSampleRaw: rawRequired,
    requiredSampleFloored: rawRequired !== null && rawRequired < SPLIT_MIN_VISITORS_PER_ARM,
    sized_on_observed_effect: true,
  };

  const totalVisitors = rows.reduce((t, r) => t + r.visitors, 0);
  if (totalVisitors === 0) {
    return {
      status: 'no_data',
      headline: 'No traffic recorded in this window.',
      leader: null,
      control: control.arm_key,
      conversion,
      revenue,
      perArm,
      sample,
      requiredSamplePerArm: null,
      ranked: ranked.map((r) => r.arm_key),
    };
  }

  // A winner requires BOTH: every arm past its floors, AND significance at the
  // Bonferroni-adjusted bar. A significant p-value on a thin sample is not a
  // winner, it is a coin that landed heads three times.
  if (ready && revenue.pValue < alphaAdjusted) {
    const pct = revenue.relativeLift === null ? null : Math.round(revenue.relativeLift * 1000) / 10;
    const dir = (revenue.absoluteLift ?? 0) >= 0 ? 'ahead of' : 'behind';
    return {
      status: 'winner',
      headline:
        `${challenger.arm_key} is ${dir} ${control.arm_key} on net revenue per visitor` +
        (pct === null ? '' : ` by ${pct}%`) +
        ` — ${(revenue.confidence * 100).toFixed(1)}% confidence.`,
      leader: challenger.arm_key,
      control: control.arm_key,
      conversion,
      revenue,
      perArm,
      sample,
      requiredSamplePerArm,
      ranked: ranked.map((r) => r.arm_key),
    };
  }

  // Distinguish "too close to call" from "not enough traffic yet" — they ask
  // the operator to do different things (kill the test vs. keep it running).
  if (!ready) {
    return {
      status: 'not_ready',
      headline:
        `Sample is still thin (${thin.map((r) => r.arm_key).join(', ')}) — ` +
        `each arm needs ${SPLIT_MIN_VISITORS_PER_ARM.toLocaleString('en-US')} visitors ` +
        `and ${SPLIT_MIN_CONVERSIONS_PER_ARM} orders before a verdict means anything` +
        (requiredSamplePerArm
          ? `. At the current gap that is about ${requiredSamplePerArm.toLocaleString('en-US')} visitors per arm.`
          : '.'),
      leader: challenger.arm_key,
      control: control.arm_key,
      conversion,
      revenue,
      perArm,
      sample,
      requiredSamplePerArm,
      ranked: ranked.map((r) => r.arm_key),
    };
  }

  return {
    status: 'no_winner',
    headline:
      'No winner yet — the arms are too close to call' +
      (requiredSamplePerArm
        ? `. Proving the gap would take about ${requiredSamplePerArm.toLocaleString('en-US')} visitors per arm.`
        : '. The observed gap is zero, so no amount of traffic will prove it.'),
    leader: challenger.arm_key,
    control: control.arm_key,
    conversion,
    revenue,
    perArm,
    sample,
    requiredSamplePerArm,
    ranked: ranked.map((r) => r.arm_key),
  };
}

export const STAT_METHOD = Object.freeze({
  conversion: 'two-proportion z-test, pooled SE, two-sided, α=0.05',
  revenue: "Welch's t-test, exact Student-t tail via regularized incomplete beta, two-sided, α=0.05",
  sample_size: 'observed-effect sizing at α=0.05 two-sided, power 0.80',
  ranking: 'net revenue per visitor',
});
