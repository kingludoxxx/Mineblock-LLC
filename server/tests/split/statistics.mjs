// Verification harness for the split-test STATISTICS layer.
//
//   node server/tests/split/statistics.mjs
//
// Three kinds of case, in this order, because they fail differently:
//
//   1. KNOWN-ANSWER — the arithmetic is compared against values worked out BY
//      HAND (shown in full in the comment above each case) or read off a
//      standard statistical table. This is the only kind of case that can catch
//      a wrong formula: a property test passes happily on a consistently wrong
//      one. If any of these move, the number on the operator's screen moved.
//   2. PROPERTY — invariants that must hold for EVERY input: swapping the arms
//      mirrors the verdict, scaling both arms 10× raises confidence without
//      moving the rates, identical arms are never significant, a smaller gap
//      always needs a larger sample, and no input at all produces a throw or a
//      NaN.
//   3. ADDITIVE-RESPONSE CONTRACT — `splitCredits.readResults` against a REAL
//      Postgres, asserting the pre-existing raw counts are untouched in name,
//      type and value while the statistics ride alongside them.
//
// Sections 1 and 2 are pure and need nothing. Section 3 needs the harness
// Postgres (127.0.0.1:5433 by default, same as scripts/verifySplitTesting.mjs).
// If it is unreachable the section is reported BLOCKED with the verbatim error
// and the run exits NON-ZERO — a contract that could not be checked must never
// read as a contract that passed.
import postgres from 'postgres';
import {
  computeSplitStatistics, armReadiness, incrementalLift, timeToDecisionDays,
  requiredSampleForProportions, requiredSampleForMeans,
  MIN_STATS_SAMPLE, SPLIT_MIN_VISITORS_PER_ARM, SPLIT_MIN_CONVERSIONS_PER_ARM,
} from '../../src/services/splitStats.js';
import { normalCdf, tTestTwoSidedP, varianceFromSums } from '../../src/services/analyticsStats.js';
import { ensureSplitTables } from '../../src/services/splitTestSchema.js';
import { readResults, recordExposure, creditConversion, voidCredit } from '../../src/services/splitCredits.js';

const DB = process.env.SPLIT_TEST_DB_URL || 'postgresql://puure@127.0.0.1:5433/puure_split';

let passed = 0;
let failed = 0;
let blocked = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); } else { failed += 1; failures.push(msg); console.log(`  FAIL  ${msg}`); }
}
// Numeric comparison with an EXPLICIT tolerance at every call site. There is no
// default: a tolerance chosen by the helper is a tolerance nobody reviewed.
function near(got, want, tol, msg) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  assert(ok, `${msg} (want ${want} ±${tol}, got ${got})`);
}
const hr = (t) => console.log(`\n=== ${t} ===`);

// Walk an arbitrary value and report the path of the first non-finite number.
// `null` is fine and expected everywhere — it is the withheld signal. A NaN or
// an Infinity is not.
function findNonFinite(value, path = '$') {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNonFinite(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findNonFinite(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

const arm = (key, o) => ({
  arm_key: key,
  is_control: Boolean(o.control),
  visitors: o.visitors,
  conversions: o.conversions,
  net_revenue: o.revenue,
  net_revenue_sum_squares: o.sumsq,
});

// ══════════════════════════════════════════════════════════════════════════
// 1. KNOWN-ANSWER CASES
// ══════════════════════════════════════════════════════════════════════════
function knownAnswers() {
  // ── KA1 · Standard normal CDF ──────────────────────────────────────────
  // The two-proportion test's whole p-value rests on Φ. These four points are
  // exact by definition or standard table:
  //   Φ(0)            = 0.5                (symmetry)
  //   Φ(1)            = 0.8413447460685429 (erf(1/√2)/2 + 1/2)
  //   Φ(1.959963985)  = 0.975              ⇒ two-tailed p = 0.05 exactly
  //   Φ(1.644853627)  = 0.95               ⇒ one-tailed 5% critical value
  hr('KA1 · standard normal CDF against exact/table values');
  near(normalCdf(0), 0.5, 1e-12, 'Phi(0) = 0.5');
  near(normalCdf(1), 0.8413447460685429, 1e-7, 'Phi(1) = 0.84134475');
  near(normalCdf(1.959963984540054), 0.975, 1e-7, 'Phi(1.95996398) = 0.975 (the 5% two-tailed point)');
  near(normalCdf(1.6448536269514722), 0.95, 1e-7, 'Phi(1.64485363) = 0.95 (the 5% one-tailed point)');
  near(normalCdf(-1), 1 - 0.8413447460685429, 1e-7, 'Phi(-1) = 1 - Phi(1) (symmetry)');

  // ── KA2 · Student-t two-tailed p at textbook critical values ───────────
  // Every value below is the α=0.05 two-tailed critical value straight off a
  // standard t-table, so the returned p MUST be 0.05:
  //   t = 3.182446, df =  3
  //   t = 2.262157, df =  9
  //   t = 2.228139, df = 10
  //   t = 2.085963, df = 20
  // A normal approximation would answer 0.00146 / 0.02368 / 0.02587 / 0.03701
  // here instead — the fatter tail is exactly what this test pins.
  hr('KA2 · Student-t two-tailed p at t-table 5% critical values');
  near(tTestTwoSidedP(3.182446, 3), 0.05, 1e-5, 't(3.182446, df=3) -> p = 0.05');
  near(tTestTwoSidedP(2.262157, 9), 0.05, 1e-5, 't(2.262157, df=9) -> p = 0.05');
  near(tTestTwoSidedP(2.228139, 10), 0.05, 1e-5, 't(2.228139, df=10) -> p = 0.05');
  near(tTestTwoSidedP(2.085963, 20), 0.05, 1e-5, 't(2.085963, df=20) -> p = 0.05');
  assert(tTestTwoSidedP(2.228139, 10) > tTestTwoSidedP(2.228139, 1000),
    'same t is LESS significant at df=10 than at df=1000 (fatter tail)');

  // ── KA3 · Two-proportion pooled z-test, worked by hand ─────────────────
  //   control  n1 = 1000, x1 = 100  ⇒ p1 = 0.100
  //   variant  n2 = 1000, x2 = 130  ⇒ p2 = 0.130
  //   pooled   p̂ = 230 / 2000 = 0.115
  //   se = sqrt( 0.115 × 0.885 × (1/1000 + 1/1000) )
  //      = sqrt( 0.101775 × 0.002 ) = sqrt( 0.00020355 ) = 0.014267096…
  //   z  = (0.130 − 0.100) / 0.014267096 = 0.030 / 0.014267096 = 2.1026963…
  //   p  = 2 · (1 − Φ(2.1026963)) = 0.0354882…
  hr('KA3 · two-proportion pooled z-test (100/1000 vs 130/1000), hand-computed');
  const ka3 = computeSplitStatistics([
    arm('a', { control: true, visitors: 1000, conversions: 100, revenue: 5000, sumsq: 250000 }),
    arm('b', { control: false, visitors: 1000, conversions: 130, revenue: 6500, sumsq: 350000 }),
  ]);
  near(ka3.arms.b.conversion.statistic, 2.1027, 5e-4, 'z = 2.10270');
  near(ka3.arms.b.conversion.p_value, 0.035488, 5e-6, 'two-tailed p = 0.035488');
  near(ka3.arms.b.conversion.confidence, 1 - 0.035488, 5e-6, 'confidence = 1 - p = 0.964512');
  near(ka3.arms.a.cvr, 0.10, 1e-12, 'control cvr = 0.100');
  near(ka3.arms.b.cvr, 0.13, 1e-12, 'variant cvr = 0.130');

  // ── KA4 · Welch's t from sufficient statistics, worked by hand ─────────
  //   A: n = 100, Σx = 1000, Σx² = 50000
  //      m1 = 10 ; v1 = (50000 − 1000²/100)/99 = (50000 − 10000)/99 = 404.040404
  //   B: n = 100, Σx = 1300, Σx² = 70000
  //      m2 = 13 ; v2 = (70000 − 1300²/100)/99 = (70000 − 16900)/99 = 536.363636
  //   se² = v1/n1 + v2/n2 = 4.04040404 + 5.36363636 = 9.40404040
  //   se  = 3.06660079
  //   t   = (13 − 10) / 3.06660079 = 0.9782787…
  //   ν   = se⁴ / [ (v1/n1)²/(n1−1) + (v2/n2)²/(n2−1) ]
  //       = 88.4359750 / (16.3248648/99 + 28.7685951/99)
  //       = 88.4359750 / (0.16489762 + 0.29059187)
  //       = 88.4359750 / 0.45548949 = 194.15583…
  //   p   ≈ 0.3291 (two-tailed) — comfortably NOT significant, which is the
  //       point: a 30% RPV gap on n=100 per arm is still noise.
  hr("KA4 · Welch's t from sufficient statistics, hand-computed");
  near(varianceFromSums(100, 1000, 50000), 404.040404, 1e-5, 'v1 = 404.040404');
  near(varianceFromSums(100, 1300, 70000), 536.363636, 1e-5, 'v2 = 536.363636');
  const ka4 = computeSplitStatistics([
    arm('a', { control: true, visitors: 100, conversions: 40, revenue: 1000, sumsq: 50000 }),
    arm('b', { control: false, visitors: 100, conversions: 40, revenue: 1300, sumsq: 70000 }),
  ]);
  near(ka4.arms.b.revenue.statistic, 0.9783, 5e-4, 't = 0.97828');
  near(ka4.arms.b.revenue.degrees_of_freedom, 194.16, 0.01, 'Welch df = 194.156');
  near(ka4.arms.b.revenue.p_value, 0.3291, 5e-4, 'two-tailed p = 0.3291');
  assert(ka4.arms.b.revenue.significant === false, 'a 30% RPV gap at n=100/arm is NOT significant');

  // ── KA5 · Required sample per arm, proportions ─────────────────────────
  //   p1 = 0.10, p2 = 0.15, δ = 0.05, α = 0.05 two-sided, power = 0.80
  //   p̄ = 0.125
  //   term1 = 1.959963985 · √(2 · 0.125 · 0.875) = 1.959963985 · 0.46770717
  //         = 0.9166881…
  //   term2 = 0.841621234 · √(0.10·0.90 + 0.15·0.85)
  //         = 0.841621234 · √0.2175 = 0.841621234 · 0.46636896 = 0.3924729…
  //   n = (0.9166881 + 0.3924729)² / 0.05² = 1.3091610² / 0.0025
  //     = 1.7139024 / 0.0025 = 685.561 → ceil = 686
  hr('KA5 · required sample per arm, proportions (0.10 vs 0.15 @ 95%/80%)');
  assert(requiredSampleForProportions(0.10, 0.15, 0.8) === 686,
    `n = 686 per arm (got ${requiredSampleForProportions(0.10, 0.15, 0.8)})`);

  // ── KA6 · Required sample per arm, means ───────────────────────────────
  //   v1 = v2 = 100, δ = 5, α = 0.05 two-sided, power = 0.80
  //   n = (z_{α/2} + z_β)² (v1 + v2) / δ²
  //     = (1.959963985 + 0.841621234)² · 200 / 25
  //     = 2.801585219² · 8 = 7.8488787 · 8 = 62.79103 → ceil = 63
  //   Cross-check against the textbook one-variance form
  //   n = 2(z_{α/2}+z_β)²σ²/δ² = 2 · 7.8488787 · 100 / 25 = 62.79103 → 63 ✓
  hr('KA6 · required sample per arm, means (v=100/100, delta=5 @ 95%/80%)');
  assert(requiredSampleForMeans(100, 100, 5, 0.8) === 63,
    `n = 63 per arm (got ${requiredSampleForMeans(100, 100, 5, 0.8)})`);

  // ── KA7 · time_to_decision_days, arithmetic by hand ────────────────────
  //   required 1000/arm, already 200/arm, 2 arms, 400 visitors/day
  //   remaining per arm = 800 ; total = 800 × 2 = 1600 ; 1600 / 400 = 4.0 days
  hr('KA7 · time to decision (1000/arm required, 200 held, 2 arms, 400/day)');
  assert(timeToDecisionDays(1000, 400, { arms: 2, alreadyPerArm: 200 }) === 4,
    `4.0 days (got ${timeToDecisionDays(1000, 400, { arms: 2, alreadyPerArm: 200 })})`);
  //   Same, from scratch: 1000 × 2 / 400 = 5.0 days
  assert(timeToDecisionDays(1000, 400, { arms: 2 }) === 5,
    `5.0 days from scratch (got ${timeToDecisionDays(1000, 400, { arms: 2 })})`);
  //   Three arms need half again as long: 1000 × 3 / 400 = 7.5 days
  assert(timeToDecisionDays(1000, 400, { arms: 3 }) === 7.5,
    `7.5 days across 3 arms (got ${timeToDecisionDays(1000, 400, { arms: 3 })})`);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. PROPERTY CASES
// ══════════════════════════════════════════════════════════════════════════
function properties() {
  // ── P1 · SWAP SYMMETRY ─────────────────────────────────────────────────
  // Which arm carries the control flag is a labelling choice. Swap it and the
  // EVIDENCE must not move: |z|, |t| and both p-values are identical, and the
  // lift flips sign and nothing else. A test that fails this is reading the
  // arms asymmetrically somewhere, which means the operator's verdict depends
  // on which button they clicked first.
  hr('P1 · swapping which arm is control mirrors the verdict, never moves the evidence');
  const rowsA = [
    arm('a', { control: true, visitors: 2000, conversions: 200, revenue: 10000, sumsq: 700000 }),
    arm('b', { control: false, visitors: 2000, conversions: 260, revenue: 13000, sumsq: 980000 }),
  ];
  const rowsB = [
    arm('a', { control: false, visitors: 2000, conversions: 200, revenue: 10000, sumsq: 700000 }),
    arm('b', { control: true, visitors: 2000, conversions: 260, revenue: 13000, sumsq: 980000 }),
  ];
  const fwd = computeSplitStatistics(rowsA);
  const rev = computeSplitStatistics(rowsB);
  near(fwd.arms.b.conversion.p_value, rev.arms.a.conversion.p_value, 1e-12,
    'conversion p-value identical under swap');
  near(fwd.arms.b.revenue.p_value, rev.arms.a.revenue.p_value, 1e-12,
    'revenue p-value identical under swap');
  near(Math.abs(fwd.arms.b.conversion.statistic), Math.abs(rev.arms.a.conversion.statistic), 1e-12,
    '|z| identical under swap');
  near(Math.abs(fwd.arms.b.revenue.statistic), Math.abs(rev.arms.a.revenue.statistic), 1e-12,
    '|t| identical under swap');
  assert(Math.sign(fwd.arms.b.lift.rpv_delta) === -Math.sign(rev.arms.a.lift.rpv_delta),
    'RPV lift flips sign under swap');
  near(fwd.arms.b.revenue.confidence, rev.arms.a.revenue.confidence, 1e-12,
    'confidence identical under swap');

  // ── P2 · SCALE INVARIANCE OF RATES, NOT OF CONFIDENCE ──────────────────
  // Multiply every count and every money moment by 10 keeping the shape of the
  // distribution. The RATES must not move at all (they are ratios); the
  // CONFIDENCE must strictly RISE, because ten times the evidence for the same
  // effect is ten times the evidence. A module that scaled confidence with the
  // rates would be ignoring sample size entirely.
  hr('P2 · scaling both arms 10x holds the rates and raises the confidence');
  const small = [
    arm('a', { control: true, visitors: 500, conversions: 50, revenue: 2500, sumsq: 150000 }),
    arm('b', { control: false, visitors: 500, conversions: 65, revenue: 3250, sumsq: 210000 }),
  ];
  // ×10 on n, on Σx and on Σx² keeps every per-visitor mean AND the variance
  // identical (Σx² scales with n for a repeated sample), so only n changed.
  const big = [
    arm('a', { control: true, visitors: 5000, conversions: 500, revenue: 25000, sumsq: 1500000 }),
    arm('b', { control: false, visitors: 5000, conversions: 650, revenue: 32500, sumsq: 2100000 }),
  ];
  const s = computeSplitStatistics(small);
  const b = computeSplitStatistics(big);
  near(b.arms.a.cvr, s.arms.a.cvr, 1e-12, 'control cvr unchanged by 10x scale');
  near(b.arms.b.cvr, s.arms.b.cvr, 1e-12, 'variant cvr unchanged by 10x scale');
  near(b.arms.b.rev_per_visitor, s.arms.b.rev_per_visitor, 1e-9, 'RPV unchanged by 10x scale');
  assert(b.arms.b.conversion.p_value < s.arms.b.conversion.p_value,
    `conversion p-value strictly falls at 10x (${s.arms.b.conversion.p_value} -> ${b.arms.b.conversion.p_value})`);
  assert(b.arms.b.conversion.confidence > s.arms.b.conversion.confidence,
    'conversion confidence strictly rises at 10x');
  assert(b.arms.b.revenue.p_value < s.arms.b.revenue.p_value,
    `revenue p-value strictly falls at 10x (${s.arms.b.revenue.p_value} -> ${b.arms.b.revenue.p_value})`);
  // The required sample is a function of the RATES only, so it must NOT move.
  assert(b.arms.b.conversion.required_sample_per_arm === s.arms.b.conversion.required_sample_per_arm,
    'required sample per arm is scale-free (depends on the rates, not on n)');

  // ── P3 · A == B EXACTLY IS NEVER SIGNIFICANT ───────────────────────────
  // At any scale, including scales far past every floor. This is the case a
  // broken engine gets wrong most expensively: it crowns a winner on two
  // samples from one distribution.
  hr('P3 · identical arms are never significant and never produce a winner');
  for (const n of [40, 500, 5000, 250000]) {
    const same = computeSplitStatistics([
      arm('a', { control: true, visitors: n, conversions: Math.round(n * 0.1), revenue: n * 5, sumsq: n * 300 }),
      arm('b', { control: false, visitors: n, conversions: Math.round(n * 0.1), revenue: n * 5, sumsq: n * 300 }),
    ]);
    assert(same.verdict.winner === null, `n=${n}: identical arms produce NO winner (status ${same.verdict.status})`);
    assert(same.arms.b.conversion.significant === false, `n=${n}: conversion not significant`);
    assert(same.arms.b.revenue.significant === false, `n=${n}: revenue not significant`);
    assert(same.arms.b.conversion.p_value === null || same.arms.b.conversion.p_value >= 0.05,
      `n=${n}: no small conversion p-value invented (got ${same.arms.b.conversion.p_value})`);
  }

  // ── P4 · MONOTONICITY OF THE SAMPLE-SIZE ESTIMATE ──────────────────────
  // n ∝ 1/δ². A smaller observed gap must ALWAYS need a larger sample; if this
  // ever inverts, the panel tells an operator a hairline difference is the
  // cheap one to prove.
  hr('P4 · a smaller observed gap always needs a larger sample');
  const gaps = [0.05, 0.03, 0.02, 0.01, 0.005];
  let prev = 0;
  let monotone = true;
  for (const g of gaps) {
    const n = requiredSampleForProportions(0.10, 0.10 + g, 0.8);
    if (prev && !(n > prev)) monotone = false;
    prev = n;
  }
  assert(monotone, `required N strictly increases as the gap shrinks (${gaps.join(' > ')} -> ${prev} at the smallest)`);
  assert(requiredSampleForProportions(0.10, 0.10, 0.8) === null,
    'a ZERO gap has no finite sample size (null, never Infinity)');
  assert(requiredSampleForMeans(100, 100, 0, 0.8) === null,
    'a ZERO mean gap has no finite sample size (null, never Infinity)');

  // ── P5 · THE READINESS GATE OUTRANKS SIGNIFICANCE ──────────────────────
  // A gap that is wildly significant on its own arithmetic must still NOT be a
  // winner while any arm is below the floors. This is the gate that stops an
  // operator promoting on a coin that landed heads three times.
  hr('P5 · no winner below the readiness floors, however significant the gap');
  const thin = computeSplitStatistics([
    // 40 visitors clears the STATISTICS floor (30) so a p-value is printed,
    // but is far below the READINESS floor (300) so no winner may be named.
    arm('a', { control: true, visitors: 40, conversions: 2, revenue: 100, sumsq: 5000 }),
    arm('b', { control: false, visitors: 40, conversions: 22, revenue: 1100, sumsq: 55000 }),
  ]);
  assert(thin.arms.b.conversion.p_value !== null, 'a p-value IS printed above the statistics floor');
  assert(thin.arms.b.conversion.p_value < 0.001,
    `the gap is genuinely significant on its own arithmetic (p=${thin.arms.b.conversion.p_value})`);
  assert(thin.verdict.status === 'not_ready', `verdict is not_ready (got ${thin.verdict.status})`);
  assert(thin.verdict.winner === null, 'NO winner is named below the readiness floors');
  assert(thin.arms.b.is_winner === false, 'no arm carries is_winner below the floors');
  assert(thin.verdict.thin_arms.length === 2, 'both arms are reported thin');
  assert(thin.arms.b.readiness.needs_visitors === SPLIT_MIN_VISITORS_PER_ARM - 40,
    `readiness reports the exact visitor shortfall (${SPLIT_MIN_VISITORS_PER_ARM - 40})`);
  assert(thin.arms.b.readiness.needs_conversions === SPLIT_MIN_CONVERSIONS_PER_ARM - 22,
    `readiness reports the exact conversion shortfall (${SPLIT_MIN_CONVERSIONS_PER_ARM - 22})`);
  // The prose must name BOTH thin arms and BOTH floors — an operator reading
  // "not ready" with no numbers has been told nothing they can act on.
  assert(thin.verdict.body.includes('a, b'), `the not-ready body names the thin arms (${thin.verdict.body})`);
  assert(thin.verdict.body.includes(String(SPLIT_MIN_VISITORS_PER_ARM))
    && thin.verdict.body.includes(String(SPLIT_MIN_CONVERSIONS_PER_ARM)),
  'the not-ready body names both floors');

  // ── P6 · WITHHOLD, DON'T GUESS ─────────────────────────────────────────
  // Each of the three named states must produce insufficient_data WITH prose
  // and a NULL p-value. A fabricated p-value here is the failure this whole
  // module exists to prevent.
  hr('P6 · the three withheld states emit prose and a null p-value, never a number');
  const cases = [
    ['fewer_than_two_arms_with_data', [
      arm('a', { control: true, visitors: 4000, conversions: 400, revenue: 20000, sumsq: 900000 }),
      arm('b', { control: false, visitors: 0, conversions: 0, revenue: 0, sumsq: 0 }),
    ]],
    ['below_stats_floor', [
      arm('a', { control: true, visitors: 12, conversions: 1, revenue: 50, sumsq: 2500 }),
      arm('b', { control: false, visitors: 15, conversions: 6, revenue: 300, sumsq: 15000 }),
    ]],
    ['zero_variance', [
      // Every visitor identical in BOTH arms: same cvr, no revenue spread.
      arm('a', { control: true, visitors: 600, conversions: 600, revenue: 0, sumsq: 0 }),
      arm('b', { control: false, visitors: 600, conversions: 600, revenue: 0, sumsq: 0 }),
    ]],
  ];
  for (const [reason, rows] of cases) {
    const out = computeSplitStatistics(rows);
    assert(out.verdict.status === 'insufficient_data',
      `${reason}: status = insufficient_data (got ${out.verdict.status})`);
    assert(out.verdict.reason === reason, `${reason}: reason names the state (got ${out.verdict.reason})`);
    assert(typeof out.verdict.body === 'string' && out.verdict.body.length > 40,
      `${reason}: prose explains the withholding (${out.verdict.body?.slice(0, 40)}...)`);
    assert(out.verdict.winner === null, `${reason}: no winner`);
    const anyP = Object.values(out.arms).some(
      (a) => a.conversion.p_value !== null || a.revenue.p_value !== null
    );
    assert(!anyP, `${reason}: NO p-value is emitted for any arm`);
    assert(Object.keys(out.arms).length === rows.length,
      `${reason}: every arm still gets a block (readiness must render while withheld)`);
  }
  // A single arm cannot be an experiment.
  const one = computeSplitStatistics([
    arm('a', { control: true, visitors: 9000, conversions: 900, revenue: 45000, sumsq: 3000000 }),
  ]);
  assert(one.verdict.status === 'insufficient_data' && one.verdict.reason === 'fewer_than_two_arms_with_data',
    'a single arm is insufficient_data, never a result');
  // No control flagged at all — reported, never silently substituted.
  const noCtl = computeSplitStatistics([
    arm('a', { control: false, visitors: 900, conversions: 90, revenue: 4500, sumsq: 300000 }),
    arm('b', { control: false, visitors: 900, conversions: 120, revenue: 6000, sumsq: 400000 }),
  ]);
  assert(noCtl.verdict.reason === 'no_control',
    `a missing control is REPORTED, not guessed at (got ${noCtl.verdict.reason})`);

  // ── P7 · TOTALITY UNDER HOSTILE INPUT ──────────────────────────────────
  // Nothing may throw and nothing may produce NaN or Infinity. `null` is the
  // expected withheld signal and is not a failure.
  hr('P7 · hostile input never throws and never produces NaN/Infinity');
  const hostile = [
    ['empty array', []],
    ['null argument', null],
    ['undefined argument', undefined],
    ['a string instead of rows', 'nonsense'],
    ['rows of nulls', [null, null]],
    ['NaN everywhere', [
      { arm_key: 'a', is_control: true, visitors: NaN, conversions: NaN, net_revenue: NaN, net_revenue_sum_squares: NaN },
      { arm_key: 'b', is_control: false, visitors: NaN, conversions: NaN, net_revenue: NaN, net_revenue_sum_squares: NaN },
    ]],
    ['numeric strings (the postgres.js NUMERIC shape)', [
      { arm_key: 'a', is_control: true, visitors: '900', conversions: '90', net_revenue: '4500.00', net_revenue_sum_squares: '300000.00' },
      { arm_key: 'b', is_control: false, visitors: '900', conversions: '120', net_revenue: '6000.00', net_revenue_sum_squares: '400000.00' },
    ]],
    ['negative visitors and revenue', [
      arm('a', { control: true, visitors: -50, conversions: -5, revenue: -100, sumsq: -20 }),
      arm('b', { control: false, visitors: -1, conversions: 9, revenue: 5, sumsq: -3 }),
    ]],
    ['conversions ABOVE the denominator (a crediting bug)', [
      arm('a', { control: true, visitors: 400, conversions: 9000, revenue: 4000, sumsq: 900000 }),
      arm('b', { control: false, visitors: 400, conversions: 50, revenue: 5000, sumsq: 950000 }),
    ]],
    ['Infinity in the moments', [
      arm('a', { control: true, visitors: 900, conversions: 90, revenue: Infinity, sumsq: Infinity }),
      arm('b', { control: false, visitors: 900, conversions: 120, revenue: 6000, sumsq: 400000 }),
    ]],
    ['one arm with a huge n and one with 1', [
      arm('a', { control: true, visitors: 1000000, conversions: 100000, revenue: 5000000, sumsq: 900000000 }),
      arm('b', { control: false, visitors: 1, conversions: 1, revenue: 50, sumsq: 2500 }),
    ]],
  ];
  for (const [label, rows] of hostile) {
    let out;
    let threw = null;
    try { out = computeSplitStatistics(rows); } catch (err) { threw = err; }
    assert(!threw, `${label}: does not throw${threw ? ` (${threw.message})` : ''}`);
    if (!threw) {
      const bad = findNonFinite(out);
      assert(!bad, `${label}: no NaN/Infinity in the output${bad ? ` (at ${bad})` : ''}`);
      assert(typeof out.verdict?.status === 'string', `${label}: a status is always returned`);
    }
  }
  // The same totality for the standalone helpers.
  for (const v of [NaN, Infinity, -Infinity, null, undefined, 'x', -1, 0]) {
    assert(timeToDecisionDays(1000, v) === null || Number.isFinite(timeToDecisionDays(1000, v)),
      `timeToDecisionDays with rate=${String(v)} is null or finite, never NaN`);
  }
  assert(timeToDecisionDays(1000, 0) === null, 'a zero traffic rate yields null days, NEVER 0 days');
  assert(findNonFinite(armReadiness(null)) === null, 'armReadiness(null) is finite throughout');
  assert(findNonFinite(incrementalLift(null, null)) === null, 'incrementalLift(null,null) is finite throughout');

  // ── P8 · THE ORDERS/CONVERSIONS ALIAS ──────────────────────────────────
  // funnelAnalytics rows call the numerator `orders`; the split ledger calls it
  // `conversions`. Reading only one silently reported a real difference as
  // zero. Both spellings must give the same lift.
  hr('P8 · incrementalLift reads `orders` and `conversions` identically');
  const byOrders = incrementalLift(
    { visitors: 1000, orders: 100, net_revenue: 5000 },
    { visitors: 1000, orders: 130, net_revenue: 6500 }
  );
  const byConversions = incrementalLift(
    { visitors: 1000, conversions: 100, net_revenue: 5000 },
    { visitors: 1000, conversions: 130, net_revenue: 6500 }
  );
  assert(JSON.stringify(byOrders) === JSON.stringify(byConversions),
    'the two spellings of the numerator produce byte-identical lift');
  near(byConversions.cvr_delta, 0.03, 1e-12, 'cvr_delta = 0.03 from `conversions` (the ledger spelling)');
  near(byConversions.rpv_delta, 1.5, 1e-12, 'rpv_delta = $1.50 per visitor');
  near(byConversions.per_1000_visitors, 1500, 1e-9, 'per 1,000 visitors = $1,500');
  near(byConversions.earned_so_far, 1500, 1e-9, 'earned so far = $1,500 on 1,000 observed visitors');
  assert(incrementalLift({ visitors: 100, orders: 0, net_revenue: 0 },
    { visitors: 100, orders: 5, net_revenue: 500 }).rpv_lift_pct === null,
  'relative lift over a ZERO baseline is null, never Infinity');
}

// ══════════════════════════════════════════════════════════════════════════
// 3. ADDITIVE-RESPONSE CONTRACT (real Postgres)
// ══════════════════════════════════════════════════════════════════════════

// Every key `readResults` returned per arm BEFORE the statistics landed. The
// contract is that this list survives exactly — same names, same types, same
// values. Written out longhand rather than derived, so a rename shows up here
// as a conflict instead of silently re-deriving itself.
const RAW_ARM_KEYS = [
  'arm_key', 'weight', 'is_control', 'archived', 'visitors', 'exposures',
  'conversions', 'credited_legs', 'gross_revenue', 'refunded', 'net_revenue',
  'take_rate',
];
const RAW_TOTAL_KEYS = [
  'visitors', 'exposures', 'conversions', 'credited_legs', 'gross_revenue',
  'refunded', 'net_revenue',
];

// `sql` is the postgres.js client itself, not the query wrapper: voidCredit
// takes `sql.begin` for its row-locked transaction (the cap must be enforced
// under a lock, not by read-then-write), and an injected query fn cannot open
// one. Passing null here made the refund silently return 'failed' — caught by
// running the harness, which is exactly what the C5 assertions are for.
async function contract(query, sql) {
  await ensureSplitTables(query);
  const testId = 'lbsg_stats_contract';
  // Clean only THIS harness's rows — dropping the tables would destroy a
  // concurrent run's fixture, and the money-path harnesses share this database.
  await query(`DELETE FROM lb_split_credits WHERE group_id = $1`, [testId]);
  await query(`DELETE FROM lb_split_arms WHERE test_id = $1`, [testId]);
  await query(`DELETE FROM lb_split_tests WHERE id = $1`, [testId]);
  await query(
    `INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ($1, 'stats contract', 'page', TRUE)`,
    [testId]
  );
  for (const [key, ctl] of [['a', true], ['b', false]]) {
    await query(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, is_entry, sort_order)
       VALUES ($1, $2, $3, 50, $4, $4, 0)`,
      [`lbsa_sc_${key}`, testId, key, ctl]
    );
  }

  // 60 exposures per arm. Arm a: 6 buyers at $50. Arm b: 9 buyers at $50,
  // one of whom takes TWO legs ($50 + $50) — the multi-leg case that separates
  // per-session moments from per-leg ones.
  const mk = (armKey, i) => `s_${armKey}_${i}`;
  for (const armKey of ['a', 'b']) {
    for (let i = 0; i < 60; i += 1) {
      const st = await recordExposure({ sessionId: mk(armKey, i), testId, armKey }, { query });
      if (st !== 'recorded') throw new Error(`exposure ${armKey}/${i} -> ${st}`);
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const st = await creditConversion(
      { sessionId: mk('a', i), testId, chargeId: `ch_a_${i}`, value: 50 }, { query });
    if (st !== 'credited') throw new Error(`credit a/${i} -> ${st}`);
  }
  for (let i = 0; i < 9; i += 1) {
    const st = await creditConversion(
      { sessionId: mk('b', i), testId, chargeId: `ch_b_${i}`, value: 50 }, { query });
    if (st !== 'credited') throw new Error(`credit b/${i} -> ${st}`);
  }
  // The two-leg buyer: session b_0 takes a SECOND charge.
  const second = await creditConversion(
    { sessionId: mk('b', 0), testId, chargeId: 'ch_b_0_second', value: 50 }, { query });
  if (second !== 'credited') throw new Error(`second leg -> ${second}`);

  const res = await readResults({ testId }, { query });

  hr('C1 · the pre-existing raw counts survive, name for name and value for value');
  const armA = res.arms.find((a) => a.arm_key === 'a');
  const armB = res.arms.find((a) => a.arm_key === 'b');
  assert(Boolean(armA && armB), 'both arms are returned');
  for (const k of RAW_ARM_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(armA, k), `arm.${k} still present`);
  }
  for (const k of RAW_TOTAL_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(res.totals, k), `totals.${k} still present`);
  }
  // The ONLY new key on an arm row.
  const added = Object.keys(armA).filter((k) => !RAW_ARM_KEYS.includes(k));
  assert(added.length === 1 && added[0] === 'stats',
    `exactly ONE key added per arm and it is 'stats' (added: ${added.join(', ') || 'none'})`);
  assert(Object.keys(res.totals).length === RAW_TOTAL_KEYS.length,
    `totals gained NOTHING (${Object.keys(res.totals).length} keys)`);
  // The values themselves, computed by hand off the fixture above.
  assert(armA.exposures === 60, `arm a exposures = 60 (got ${armA.exposures})`);
  assert(armB.exposures === 60, `arm b exposures = 60 (got ${armB.exposures})`);
  assert(armA.conversions === 6, `arm a conversions = 6 DISTINCT sessions (got ${armA.conversions})`);
  assert(armB.conversions === 9, `arm b conversions = 9 DISTINCT sessions, not 10 legs (got ${armB.conversions})`);
  assert(armB.credited_legs === 10, `arm b credited_legs = 10 (got ${armB.credited_legs})`);
  assert(Number(armA.net_revenue) === 300, `arm a net revenue = 300 (got ${armA.net_revenue})`);
  assert(Number(armB.net_revenue) === 500, `arm b net revenue = 500 (got ${armB.net_revenue})`);

  hr('C2 · the statistics ride alongside, on every arm and at the top level');
  assert(res.verdict && typeof res.verdict.status === 'string', 'a top-level verdict block is returned');
  assert(res.floors && res.method, 'floors and method travel with the payload');
  for (const a of res.arms) {
    assert(a.stats && a.stats.readiness, `arm ${a.arm_key}: stats.readiness present`);
    assert(a.stats.conversion && a.stats.revenue, `arm ${a.arm_key}: both comparisons present`);
    assert(typeof a.stats.money_sessions === 'number', `arm ${a.arm_key}: raw moments travel with the block`);
  }

  hr('C3 · nothing in the whole payload is NaN or Infinity');
  const bad = findNonFinite(res);
  assert(!bad, `no non-finite number anywhere in the response${bad ? ` (at ${bad})` : ''}`);

  hr('C4 · the moments are PER SESSION, not per leg');
  // Arm b: 9 money sessions. Eight worth $50, one worth $100 (the two-leg
  // buyer), 51 worth $0.
  //   Σx  = 8×50 + 100 = 500                    (equals net_revenue)
  //   Σx² = 8×50² + 100² = 8×2500 + 10000 = 30000
  // Per LEG it would be 10 observations and Σx² = 10×2500 = 25000 — a smaller
  // variance and therefore a falsely narrower interval. This assertion is the
  // one that would catch that regression.
  assert(armB.stats.money_sessions === 9,
    `arm b: 9 money SESSIONS (not 10 legs) — got ${armB.stats.money_sessions}`);
  near(Number(armB.stats.net_revenue_sum), 500, 1e-9, 'arm b: sum(x) = 500, equal to net_revenue');
  near(Number(armB.stats.net_revenue_sum_squares), 30000, 1e-6,
    'arm b: sum(x^2) = 30000 (per session), NOT 25000 (per leg)');
  //   Arm a: 6 sessions at $50 ⇒ Σx = 300, Σx² = 6×2500 = 15000
  assert(armA.stats.money_sessions === 6, `arm a: 6 money sessions (got ${armA.stats.money_sessions})`);
  near(Number(armA.stats.net_revenue_sum_squares), 15000, 1e-6, 'arm a: sum(x^2) = 15000');
  //   Variance over the FULL denominator (n = 60 exposures, 54 of them zeros):
  //   mean = 300/60 = 5 ; ss = 15000 − 60×25 = 13500 ; v = 13500/59 = 228.813559
  near(armA.stats.net_revenue_variance, 228.813559, 1e-5,
    'arm a: variance over all 60 exposures (non-buyers counted as 0) = 228.8136');

  hr('C5 · a refund NETS into the moments, it does not merely reduce a column');
  const before = Number(armB.stats.net_revenue_sum_squares);
  const netted = await voidCredit(
    { sessionId: mk('b', 1), testId, chargeId: 'ch_b_1', amount: 50, refundKey: 'rf1' },
    { query, sql }
  ).catch((e) => `threw:${e.message}`);
  assert(netted === 'netted', `the refund nets (got ${netted})`);
  const after = await readResults({ testId }, { query });
  const armB2 = after.arms.find((a) => a.arm_key === 'b');
  //   b now: 7 sessions at $50, one at $100, one at $0 (fully refunded).
  //   money_sessions still counts the refunded session (it has ledger rows),
  //   Σx  = 7×50 + 100 = 450 ; Σx² = 7×2500 + 10000 = 27500
  assert(Number(armB2.net_revenue) === 450, `arm b net revenue drops to 450 (got ${armB2.net_revenue})`);
  near(Number(armB2.stats.net_revenue_sum), 450, 1e-9, 'sum(x) follows the refund down to 450');
  near(Number(armB2.stats.net_revenue_sum_squares), 27500, 1e-6,
    `sum(x^2) falls to 27500 (was ${before}) — the refunded session stops inflating the variance`);

  hr('C6 · the verdict withholds on this fixture rather than inventing one');
  // 60 exposures per arm is above the statistics floor (30) and far below the
  // readiness floor (300), so a p-value is printed and NO winner is named.
  assert(after.verdict.status === 'not_ready',
    `status is not_ready at 60 exposures/arm (got ${after.verdict.status})`);
  assert(after.verdict.winner === null, 'no winner named below the readiness floor');
  assert(armB2.stats.conversion.p_value !== null, 'a conversion p-value IS printed above the statistics floor');
  assert(armB2.stats.readiness.needs_visitors === SPLIT_MIN_VISITORS_PER_ARM - 60,
    `readiness reports needing ${SPLIT_MIN_VISITORS_PER_ARM - 60} more visitors`);

  hr('C7 · an empty test yields insufficient_data, not a crash and not a fake verdict');
  const emptyId = 'lbsg_stats_empty';
  await query(`DELETE FROM lb_split_credits WHERE group_id = $1`, [emptyId]);
  await query(`DELETE FROM lb_split_arms WHERE test_id = $1`, [emptyId]);
  await query(`DELETE FROM lb_split_tests WHERE id = $1`, [emptyId]);
  await query(
    `INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ($1, 'empty', 'page', TRUE)`, [emptyId]);
  await query(
    `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, is_entry, sort_order)
     VALUES ('lbsa_se_a', $1, 'a', 50, TRUE, TRUE, 0)`, [emptyId]);
  await query(
    `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, is_entry, sort_order)
     VALUES ('lbsa_se_b', $1, 'b', 50, FALSE, FALSE, 1)`, [emptyId]);
  const empty = await readResults({ testId: emptyId }, { query });
  assert(empty.verdict.status === 'insufficient_data',
    `an empty test is insufficient_data (got ${empty.verdict.status})`);
  assert(empty.arms.every((a) => a.stats && a.stats.readiness),
    'every arm of an empty test still carries a readiness block');
  assert(!findNonFinite(empty), 'an empty test produces no NaN/Infinity');

  // Leave the database as we found it.
  for (const id of [testId, emptyId]) {
    await query(`DELETE FROM lb_split_credits WHERE group_id = $1`, [id]);
    await query(`DELETE FROM lb_split_arms WHERE test_id = $1`, [id]);
    await query(`DELETE FROM lb_split_tests WHERE id = $1`, [id]);
  }
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('SPLIT STATISTICS HARNESS');
  knownAnswers();
  properties();

  let sql = null;
  try {
    sql = postgres(DB, { max: 4, idle_timeout: 5, connect_timeout: 5 });
    const query = (text, params = []) => sql.unsafe(text, params);
    await query('SELECT 1');
    await contract(query, sql);
  } catch (err) {
    blocked += 1;
    console.log(`\n=== 3. ADDITIVE-RESPONSE CONTRACT — BLOCKED ===`);
    console.log(`  BLOCKED  ${DB.replace(/\/\/.*@/, '//***@')} — ${err.message}`);
    console.log('  The pure sections above still ran. The contract section did NOT,');
    console.log('  so this run exits non-zero: an unchecked contract is not a passing one.');
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed${blocked ? `, ${blocked} section BLOCKED` : ''}`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));
  process.exit(failed === 0 && blocked === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
