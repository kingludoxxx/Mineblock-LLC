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
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import postgres from 'postgres';
import {
  computeSplitStatistics, armReadiness, incrementalLift, timeToDecisionDays,
  requiredSampleForProportions, requiredSampleForMeans,
  MIN_STATS_SAMPLE, SPLIT_MIN_VISITORS_PER_ARM, SPLIT_MIN_CONVERSIONS_PER_ARM,
} from '../../src/services/splitStats.js';
import {
  normalCdf, tTestTwoSidedP, varianceFromSums, formatConfidencePct, buildVerdict,
} from '../../src/services/analyticsStats.js';
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

// `exposures` is the module's own spelling; `visitors` is accepted here so the
// cases written before the rename still exercise the alias path on every run.
const arm = (key, o) => ({
  arm_key: key,
  is_control: Boolean(o.control),
  exposures: o.exposures !== undefined ? o.exposures : o.visitors,
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
  near(b.arms.b.rev_per_exposure, s.arms.b.rev_per_exposure, 1e-9, 'RPV unchanged by 10x scale');
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
  assert(thin.arms.b.readiness.needs_exposures === SPLIT_MIN_VISITORS_PER_ARM - 40,
    `readiness reports the exact exposure shortfall (${SPLIT_MIN_VISITORS_PER_ARM - 40})`);
  assert(thin.arms.b.readiness.needs_conversions === SPLIT_MIN_CONVERSIONS_PER_ARM - 22,
    `readiness reports the exact conversion shortfall (${SPLIT_MIN_CONVERSIONS_PER_ARM - 22})`);
  // The prose must name EACH thin arm with ITS OWN shortfall. (The earlier form
  // asserted one shared conjunction for every arm; P17 covers why that was
  // false prose.) An operator reading "not ready" with no numbers has been told
  // nothing they can act on.
  assert(/a needs [^;]+/.test(thin.verdict.body) && /b needs [^;.]+/.test(thin.verdict.body),
    `the not-ready body names each thin arm with its own shortfall (${thin.verdict.body})`);
  assert(thin.verdict.body.includes(String(SPLIT_MIN_VISITORS_PER_ARM - 40)),
    'and the shortfall is the exact remaining distance to the floor');

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
    // The control QUALIFIES here and the challenger does not, which is what
    // isolates `below_stats_floor` from `control_below_stats_floor`. The old
    // fixture had a sub-floor control too, so it could not tell the two apart.
    ['below_stats_floor', [
      arm('a', { control: true, visitors: 900, conversions: 90, revenue: 4500, sumsq: 300000 }),
      arm('b', { control: false, visitors: 15, conversions: 6, revenue: 300, sumsq: 15000 }),
    ]],
    ['control_below_stats_floor', [
      arm('a', { control: true, visitors: 12, conversions: 1, revenue: 50, sumsq: 2500 }),
      arm('b', { control: false, visitors: 900, conversions: 120, revenue: 6000, sumsq: 400000 }),
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
  assert(one.verdict.status === 'insufficient_data' && one.verdict.reason === 'fewer_than_two_arms',
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
  // BOTH SPELLINGS PRESENT, one of them a structural zero. `orders: 0` is what
  // an object literal carries when the field was never populated; it must not
  // shadow a real count in the other spelling.
  const shadow = incrementalLift(
    { visitors: 1000, orders: 0, conversions: 100, net_revenue: 5000 },
    { visitors: 1000, orders: 0, conversions: 130, net_revenue: 6500 }
  );
  near(shadow.cvr_delta, 0.03, 1e-12, 'orders:0 does NOT shadow a real conversions value');
  const shadowRev = incrementalLift(
    { visitors: 1000, conversions: 0, orders: 100, net_revenue: 5000 },
    { visitors: 1000, conversions: 0, orders: 130, net_revenue: 6500 }
  );
  near(shadowRev.cvr_delta, 0.03, 1e-12, 'conversions:0 does NOT shadow a real orders value');
  // A GENUINE zero still survives — an arm that converted nothing reads 0.
  const realZero = incrementalLift(
    { visitors: 1000, conversions: 0, net_revenue: 0 },
    { visitors: 1000, conversions: 0, net_revenue: 0 }
  );
  assert(realZero.cvr_delta === 0, 'a genuine zero on both sides is still 0, not null');

  // ── P9 · SUB-FLOOR ARMS ARE SCOPED OUT, NOT ALLOWED TO POISON ──────────
  // THE WORST DEFECT THIS HARNESS GUARDS. A fresh or archived zero-traffic arm
  // riding along in readResults' output must not null every figure on a test
  // with tens of thousands of exposures.
  hr('P9 · a sub-floor arm is excluded from the family, never poisons the test');
  const big2 = [
    arm('a', { control: true, exposures: 10000, conversions: 1000, revenue: 50000, sumsq: 3000000 }),
    arm('b', { control: false, exposures: 10000, conversions: 1300, revenue: 65000, sumsq: 4200000 }),
  ];
  const decisive = computeSplitStatistics(big2);
  assert(decisive.verdict.status === 'winner', `the 2-arm test alone is decisive (${decisive.verdict.status})`);
  // Now add a brand-new arm with 12 exposures — the exact shape that broke it.
  const withFresh = computeSplitStatistics([
    ...big2,
    arm('c', { control: false, exposures: 12, conversions: 1, revenue: 50, sumsq: 2500 }),
  ]);
  assert(withFresh.verdict.status === 'winner',
    `adding a 12-exposure arm does NOT blind the test (got ${withFresh.verdict.status})`);
  assert(withFresh.verdict.winner === decisive.verdict.winner,
    'the winner is unchanged by the pending arm');
  assert(withFresh.arms.b.revenue.p_value !== null, 'the qualifying arm keeps its p-value');
  assert(withFresh.verdict.pending_arms.join() === 'c', 'the sub-floor arm is reported as pending');
  assert(withFresh.verdict.qualifying_arms.join() === 'a,b', 'the family is the two qualifying arms');
  assert(withFresh.arms.c.stats_status === 'insufficient', "the pending arm's status is 'insufficient'");
  assert(withFresh.arms.c.in_comparison === false, 'the pending arm is flagged out of the comparison');
  assert(withFresh.arms.c.conversion.p_value === null, 'the pending arm gets NO p-value of its own');
  assert(withFresh.arms.c.readiness.needs_exposures > 0, 'the pending arm still reports its shortfall');
  // The correction must not count a comparison that is not being made.
  assert(withFresh.verdict.comparisons === decisive.verdict.comparisons,
    `Bonferroni counts only qualifying comparisons (${withFresh.verdict.comparisons})`);
  assert(withFresh.verdict.alpha_adjusted === decisive.verdict.alpha_adjusted,
    'the corrected alpha is unchanged by the pending arm');
  assert(withFresh.verdict.body.includes('c is still collecting'),
    `the prose names the pending arm (${withFresh.verdict.body})`);
  // A THIRD QUALIFYING arm, by contrast, MUST tighten the correction.
  const threeReal = computeSplitStatistics([
    ...big2,
    arm('c', { control: false, exposures: 9000, conversions: 900, revenue: 45000, sumsq: 2800000 }),
  ]);
  assert(threeReal.verdict.comparisons === 2, 'a third QUALIFYING arm does add a comparison');
  assert(threeReal.verdict.alpha_adjusted < decisive.verdict.alpha_adjusted,
    'and it tightens the corrected alpha');
  // An arm ABOVE the stats floor but BELOW readiness is thin, NOT pending — it
  // is in the family and must still block the winner.
  const thinNotPending = computeSplitStatistics([
    ...big2,
    arm('c', { control: false, exposures: 120, conversions: 12, revenue: 600, sumsq: 30000 }),
  ]);
  assert(thinNotPending.verdict.pending_arms.length === 0, 'a 120-exposure arm is NOT pending');
  assert(thinNotPending.verdict.thin_arms.join() === 'c', 'it is THIN — inside the family');
  assert(thinNotPending.verdict.status === 'not_ready',
    `and it correctly blocks the winner (${thinNotPending.verdict.status})`);
  // A SUB-FLOOR CONTROL withholds the whole test — every comparison is against it.
  const thinControl = computeSplitStatistics([
    arm('a', { control: true, exposures: 12, conversions: 1, revenue: 50, sumsq: 2500 }),
    arm('b', { control: false, exposures: 10000, conversions: 1300, revenue: 65000, sumsq: 4200000 }),
  ]);
  assert(thinControl.verdict.reason === 'control_below_stats_floor',
    `a sub-floor CONTROL withholds under its own reason (got ${thinControl.verdict.reason})`);

  // ── P10 · THE DISPLAY FLOOR ON THE TAIL ────────────────────────────────
  // A p-value that rounds to 0 renders as "100.0% confidence" — a certainty no
  // finite sample supports.
  hr('P10 · p is floored and confidence capped, without moving any verdict');
  const overwhelming = computeSplitStatistics([
    arm('a', { control: true, exposures: 50000, conversions: 2500, revenue: 125000, sumsq: 7000000 }),
    arm('b', { control: false, exposures: 50000, conversions: 6000, revenue: 300000, sumsq: 22000000 }),
  ]);
  const ob = overwhelming.arms.b;
  assert(ob.conversion.p_value >= 1e-6, `p is never published below 1e-6 (got ${ob.conversion.p_value})`);
  assert(ob.conversion.confidence <= 0.9999,
    `confidence is never published above 0.9999 (got ${ob.conversion.confidence})`);
  assert(ob.conversion.p_value_floored === true, 'and the flooring is DECLARED, so the UI can print "<"');
  // The floor must not have changed the decision.
  assert(ob.conversion.significant === true, 'flooring does not stop a real result being significant');
  assert(overwhelming.verdict.status === 'winner', 'and the verdict still names the winner');
  // An ordinary p-value is untouched.
  assert(ka3Ref().arms.b.conversion.p_value_floored === false,
    'an ordinary p-value is NOT flagged as floored');
  near(ka3Ref().arms.b.conversion.p_value, 0.035488, 5e-6, 'and is published unchanged');

  // ── P11 · THE RANKED COMPARATOR IS TOTAL ───────────────────────────────
  // `(-Infinity) - (-Infinity)` is NaN, and a comparator returning NaN leaves
  // the order engine-defined.
  hr('P11 · ranking is deterministic even with several zero-exposure arms');
  const zeros = computeSplitStatistics([
    arm('a', { control: true, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
    arm('b', { control: false, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
    arm('c', { control: false, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
  ]);
  assert(zeros.verdict.ranked.join() === 'a,b,c',
    `three zero-exposure arms rank deterministically (got ${zeros.verdict.ranked.join()})`);
  const zerosAgain = computeSplitStatistics([
    arm('c', { control: false, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
    arm('a', { control: true, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
    arm('b', { control: false, exposures: 0, conversions: 0, revenue: 0, sumsq: 0 }),
  ]);
  assert(zeros.verdict.ranked.join() === zerosAgain.verdict.ranked.join(),
    'and the order does not depend on input order');

  // ── P12 · BOTH RATES SHARE ONE FLOOR ───────────────────────────────────
  hr('P12 · cvr and revenue-per-exposure are withheld together');
  const subFloor = computeSplitStatistics([
    arm('a', { control: true, exposures: 2, conversions: 1, revenue: 75, sumsq: 5625 }),
    arm('b', { control: false, exposures: 900, conversions: 90, revenue: 4500, sumsq: 300000 }),
  ]);
  assert(subFloor.arms.a.cvr === null, 'cvr is withheld below the floor');
  assert(subFloor.arms.a.rev_per_exposure === null,
    'revenue per exposure is withheld below the SAME floor (it was published before)');
  assert(subFloor.arms.a.cvr_withheld === true && subFloor.arms.a.rev_per_exposure_withheld === true,
    'both withholdings are declared');

  // ── P13 · PROSE MATCHES THE SHAPE IT DESCRIBES ─────────────────────────
  hr('P13 · withheld prose never describes a shape that is not there');
  assert(computeSplitStatistics([]).verdict.reason === 'no_arms',
    'zero arms -> no_arms (it used to claim "only one arm has traffic")');
  assert(!/one arm/i.test(computeSplitStatistics([]).verdict.body),
    'and its prose does not mention "one arm"');
  assert(computeSplitStatistics([arm('a', { control: true, exposures: 5000, conversions: 500, revenue: 25000, sumsq: 1500000 })])
    .verdict.reason === 'fewer_than_two_arms', 'one arm -> fewer_than_two_arms');
  const fourThin = computeSplitStatistics([
    arm('a', { control: true, exposures: 5, conversions: 1, revenue: 50, sumsq: 2500 }),
    arm('b', { control: false, exposures: 5, conversions: 1, revenue: 50, sumsq: 2500 }),
    arm('c', { control: false, exposures: 5, conversions: 1, revenue: 50, sumsq: 2500 }),
    arm('d', { control: false, exposures: 5, conversions: 1, revenue: 50, sumsq: 2500 }),
  ]);
  assert(!/Both arms/i.test(fourThin.verdict.body),
    `a 4-arm test is never described as "Both arms" (${fourThin.verdict.body})`);
  // A declared winner must not carry an orphan "proving it would take N more".
  assert(!/proving it would take/i.test(overwhelming.verdict.body),
    `a winner verdict carries no projection sentence (${overwhelming.verdict.body})`);
  assert(overwhelming.verdict.sized_on_observed_effect === false,
    'and the flag the UI keys its caveat on is false in the winner state');
  assert(overwhelming.verdict.time_to_decision_days === null,
    'and there is no "days to decide" on a decided test');

  // ── P14 · TIME TO DECISION IS WIRED, NOT DEAD ──────────────────────────
  hr('P14 · time_to_decision_days is produced when a rate is supplied');
  const waiting = computeSplitStatistics([
    arm('a', { control: true, exposures: 120, conversions: 12, revenue: 600, sumsq: 40000 }),
    arm('b', { control: false, exposures: 120, conversions: 15, revenue: 780, sumsq: 52000 }),
  ], { exposuresPerDay: 60 });
  assert(waiting.verdict.status === 'not_ready', 'the fixture is genuinely not ready');
  assert(typeof waiting.verdict.time_to_decision_days === 'number',
    `a rate produces a number (got ${waiting.verdict.time_to_decision_days})`);
  assert(waiting.verdict.time_to_decision_days > 0, 'and it is positive');
  assert(/more days at the current rate/.test(waiting.verdict.body),
    'and the prose actually says it');
  // No rate -> no estimate, and the sentence must not dangle.
  const noRate = computeSplitStatistics([
    arm('a', { control: true, exposures: 120, conversions: 12, revenue: 600, sumsq: 40000 }),
    arm('b', { control: false, exposures: 120, conversions: 15, revenue: 780, sumsq: 52000 }),
  ]);
  assert(noRate.verdict.time_to_decision_days === null, 'no rate -> null, never 0');
  assert(!/more days/.test(noRate.verdict.body), 'and the prose omits the clause entirely');
  // Faster traffic must mean a shorter wait.
  const fast = computeSplitStatistics([
    arm('a', { control: true, exposures: 120, conversions: 12, revenue: 600, sumsq: 40000 }),
    arm('b', { control: false, exposures: 120, conversions: 15, revenue: 780, sumsq: 52000 }),
  ], { exposuresPerDay: 600 });
  assert(fast.verdict.time_to_decision_days < waiting.verdict.time_to_decision_days,
    '10x the traffic rate gives a strictly shorter wait');

  // ── P15 · THE ENTRY POINT HONOURS BOTH SPELLINGS ───────────────────────
  hr('P15 · computeSplitStatistics accepts exposures/visitors and conversions/orders');
  const viaExposures = computeSplitStatistics([
    { arm_key: 'a', is_control: true, exposures: 900, conversions: 90, net_revenue: 4500, net_revenue_sum_squares: 300000 },
    { arm_key: 'b', is_control: false, exposures: 900, conversions: 120, net_revenue: 6000, net_revenue_sum_squares: 400000 },
  ]);
  const viaVisitors = computeSplitStatistics([
    { arm_key: 'a', is_control: true, visitors: 900, orders: 90, net_revenue: 4500, net_revenue_sum_squares: 300000 },
    { arm_key: 'b', is_control: false, visitors: 900, orders: 120, net_revenue: 6000, net_revenue_sum_squares: 400000 },
  ]);
  assert(JSON.stringify(viaExposures) === JSON.stringify(viaVisitors),
    'the funnelAnalytics spelling and the ledger spelling give byte-identical output');
  assert(viaVisitors.arms.b.exposures === 900,
    'and the OUTPUT is always `exposures`, whichever spelling came in');
}

// ── P16 · NO PROSE BUILDER EVER PRINTS FLAT 100% CERTAINTY ─────────────────
//
// The reviewer proved B7 (which greps the shipped JSX) structurally CANNOT see
// these two: both headlines are built SERVER-side, so the string reaches the
// panel already formatted and no client-side cap applies. They are covered here,
// where they live.
//
// TWO builders, one bug: splitStats' winner headline and analyticsStats'
// buildVerdict headline independently wrote `(conf * 100).toFixed(1)`, and
// `(0.9999 * 100).toFixed(1)` is the string "100.0". Both rendered "100.0%
// confidence" as the LARGEST string on the panel, directly above cells reading
// ">99.99%". They now share one formatter, and this case pins both.
function proseBuilders() {
  hr('P16 · neither server-side headline can print "100.0% confidence"');

  // The formatter itself, at the exact value both caps produce.
  near(Number(String(formatConfidencePct(0.5)).replace('%', '')), 50, 1e-9, 'formatter: 0.5 -> 50.0%');
  assert(formatConfidencePct(0.9999) === '>99.99%',
    `formatter: the CAP value renders as a bound, not "100.0%" (got ${formatConfidencePct(0.9999)})`);
  assert(formatConfidencePct(1) === '>99.99%', 'formatter: 1.0 renders as a bound');
  assert(formatConfidencePct(0.9) === '90.0%', `formatter: 0.9 -> "90.0%" (got ${formatConfidencePct(0.9)})`);
  assert(formatConfidencePct(0.973) === '97.3%', 'formatter: an ordinary confidence is untouched');
  assert(formatConfidencePct(null) === null, 'formatter: a missing confidence yields null, not a string');

  // BUILDER 1 — splitStats' winner headline, at a confidence that hits the cap.
  const capped = computeSplitStatistics([
    arm('a', { control: true, exposures: 50000, conversions: 2500, revenue: 125000, sumsq: 7000000 }),
    arm('b', { control: false, exposures: 50000, conversions: 6000, revenue: 300000, sumsq: 22000000 }),
  ]);
  assert(capped.verdict.status === 'winner', 'the fixture is a winner (so a headline exists)');
  assert(capped.arms.b.revenue.confidence === 0.9999,
    `and its confidence IS the capped value (got ${capped.arms.b.revenue.confidence})`);
  assert(!capped.verdict.headline.includes('100.0% confidence'),
    `splitStats headline never says "100.0% confidence" (got: ${capped.verdict.headline})`);
  assert(capped.verdict.headline.includes('>99.99% confidence'),
    `it says ">99.99% confidence" instead (got: ${capped.verdict.headline})`);

  // BUILDER 2 — analyticsStats' buildVerdict headline, the windowed banner in
  // the SAME modal. Driven to the same place.
  const wv = buildVerdict([
    { arm_key: 'a', is_control: true, visitors: 50000, orders: 2500, net_revenue: 125000, net_revenue_sum_squares: 7000000 },
    { arm_key: 'b', is_control: false, visitors: 50000, orders: 6000, net_revenue: 300000, net_revenue_sum_squares: 22000000 },
  ]);
  assert(wv.status === 'winner', 'the windowed fixture is a winner too');
  assert(!wv.headline.includes('100.0% confidence'),
    `buildVerdict headline never says "100.0% confidence" (got: ${wv.headline})`);
  assert(wv.headline.includes('>99.99% confidence'),
    `it says ">99.99% confidence" instead (got: ${wv.headline})`);

  // POSITIVE CONTROL — an ordinary confidence must still render as a NUMBER, or
  // the two assertions above would pass on a builder that had simply stopped
  // printing confidence at all.
  const ordinary = buildVerdict([
    { arm_key: 'a', is_control: true, visitors: 4000, orders: 400, net_revenue: 20000, net_revenue_sum_squares: 200000 },
    { arm_key: 'b', is_control: false, visitors: 4000, orders: 440, net_revenue: 21000, net_revenue_sum_squares: 220000 },
  ]);
  const pct = /(\d+\.\d)% confidence/.exec(ordinary.headline);
  assert(ordinary.status === 'winner' && pct !== null,
    `positive control: an ordinary winner prints a NUMERIC confidence (got: ${ordinary.headline})`);
  if (pct) {
    const value = Number(pct[1]);
    assert(value > 50 && value < 100,
      `positive control: it is a real percentage strictly below 100 (got ${value})`);
  }
  // And the same positive control on the split builder.
  const ordinarySplit = computeSplitStatistics([
    arm('a', { control: true, exposures: 4000, conversions: 400, revenue: 20000, sumsq: 200000 }),
    arm('b', { control: false, exposures: 4000, conversions: 440, revenue: 21000, sumsq: 220000 }),
  ]);
  assert(/\d+\.\d% confidence/.test(ordinarySplit.verdict.headline),
    `positive control: splitStats prints a numeric confidence too (got: ${ordinarySplit.verdict.headline})`);
}

// ── P17 · THE TWO NARRATION FIXES ──────────────────────────────────────────
function narration() {
  hr('P17 · not-ready prose is PER ARM, and the corrected bar is explained');

  // Arm a is short only on ORDERS (it has 4,000 exposures); arms b and c are
  // short only on EXPOSURES. The old sentence asserted BOTH floors against ALL
  // of them, which was false about every one.
  const mixed = computeSplitStatistics([
    arm('a', { control: true, exposures: 4000, conversions: 12, revenue: 600, sumsq: 40000 }),
    arm('b', { control: false, exposures: 120, conversions: 80, revenue: 4000, sumsq: 250000 }),
    arm('c', { control: false, exposures: 150, conversions: 90, revenue: 4500, sumsq: 280000 }),
  ]);
  assert(mixed.verdict.status === 'not_ready', 'the fixture is not ready');
  assert(mixed.verdict.body.includes('a needs ~13 more orders'),
    `arm a is short on ORDERS ONLY and says so (got: ${mixed.verdict.body})`);
  assert(!/a needs[^;]*more exposures/.test(mixed.verdict.body),
    'and arm a is NOT told it needs more exposures — it has 4,000');
  assert(mixed.verdict.body.includes('b needs ~180 more exposures'),
    'arm b is short on EXPOSURES and says so');
  assert(!/b needs[^;]*more orders/.test(mixed.verdict.body),
    'and arm b is NOT told it needs more orders — it has 80');
  assert(mixed.verdict.body.includes('c needs ~150 more exposures'), 'arm c reports its own shortfall');

  // BONFERRONI NARRATION — the sentence that explains a revoked winner.
  assert(/Bonferroni-corrected to α 0\.025/.test(mixed.verdict.body),
    `3 arms -> the corrected bar is stated (got: ${mixed.verdict.body})`);
  // With ONE comparison there is no correction, so there must be no sentence.
  const twoArm = computeSplitStatistics([
    arm('a', { control: true, exposures: 120, conversions: 12, revenue: 600, sumsq: 40000 }),
    arm('b', { control: false, exposures: 120, conversions: 15, revenue: 780, sumsq: 52000 }),
  ]);
  assert(!/Bonferroni/.test(twoArm.verdict.body),
    `2 arms -> NO correction sentence is invented (got: ${twoArm.verdict.body})`);
  // Given history, it narrates the TRANSITION — the revoked-winner explanation.
  const grew = computeSplitStatistics([
    arm('a', { control: true, exposures: 9000, conversions: 900, revenue: 45000, sumsq: 3000000 }),
    arm('b', { control: false, exposures: 9000, conversions: 940, revenue: 47000, sumsq: 3100000 }),
    arm('c', { control: false, exposures: 9000, conversions: 910, revenue: 45500, sumsq: 3050000 }),
  ], { previousComparisons: 1 });
  assert(/up from 2/.test(grew.verdict.body) && /tightened to α/.test(grew.verdict.body),
    `a grown family narrates the tightening (got: ${grew.verdict.body})`);
  assert(/may no longer clear this one/.test(grew.verdict.body),
    'and says explicitly that an old result may no longer clear the new bar');
}

// Re-used by P10; kept as a function so the two call sites cannot drift.
function ka3Ref() {
  return computeSplitStatistics([
    arm('a', { control: true, exposures: 1000, conversions: 100, revenue: 5000, sumsq: 250000 }),
    arm('b', { control: false, exposures: 1000, conversions: 130, revenue: 6500, sumsq: 350000 }),
  ]);
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
  assert(armB2.stats.readiness.needs_exposures === SPLIT_MIN_VISITORS_PER_ARM - 60,
    `readiness reports needing ${SPLIT_MIN_VISITORS_PER_ARM - 60} more exposures`);

  hr('C8 · the exposure rate is read from the ledger and reaches the estimate');
  // The fixture's exposures all land inside one second, so the span floors at
  // one day: 120 exposures / 1 day = 120 per day. That the number is EXACT is
  // the point — it proves the rate came from the ledger rather than a default.
  assert(after.exposures_per_day === 120,
    `exposures_per_day = 120 from 120 rows inside a floored 1-day span (got ${after.exposures_per_day})`);
  assert(typeof after.verdict.time_to_decision_days === 'number',
    `and it produces a real estimate (got ${after.verdict.time_to_decision_days})`);
  // The IDENTITY, not a guessed constant: days = (required − held) × arms ÷ rate.
  // `required` is the observed-effect sizing (larger than the 300 floor on this
  // fixture, which is why hardcoding 300 here was wrong), so it is read back
  // from the payload and the wiring arithmetic is checked against it.
  const req = after.verdict.required_sample_per_arm;
  assert(req >= SPLIT_MIN_VISITORS_PER_ARM,
    `required per arm is floored at the readiness bar (got ${req})`);
  const expectedDays = Math.round(((req - 60) * 2 / 120) * 10) / 10;
  assert(after.verdict.time_to_decision_days === expectedDays,
    `days = (${req} - 60) x 2 / 120 = ${expectedDays} (got ${after.verdict.time_to_decision_days})`);

  hr('C9 · withStats:false returns the raw counts ONLY, and skips the extra reads');
  const raw = await readResults({ testId }, { query, withStats: false });
  assert(raw.verdict === undefined, 'no verdict is computed on the suppressed path');
  assert(raw.floors === undefined && raw.method === undefined, 'no floors/method either');
  assert(raw.exposures_per_day === undefined, 'and no exposure-rate read');
  assert(raw.arms.every((a) => a.stats === undefined), 'no arm carries a stats block');
  // The RAW figures must be byte-identical to the full call — that is the whole
  // point of the flag: a cheaper read, never a different answer.
  const stripped = after.arms.map(({ stats, ...rest }) => rest);
  assert(JSON.stringify(raw.arms) === JSON.stringify(stripped),
    'the raw arm rows are byte-identical to the full call with `stats` removed');
  assert(JSON.stringify(raw.totals) === JSON.stringify(after.totals), 'totals are byte-identical');

  hr('C10 · the day-by-day series is per-day, per-arm, newest first');
  // The fixture credits all land on today's cell (the credit rolls up on its
  // EXPOSURE row's day), so there is exactly one day with both arms present.
  assert(Array.isArray(after.daily), 'a daily array is returned');
  assert(after.daily.length >= 1, `at least one day is present (got ${after.daily.length})`);
  const today = after.daily[0];
  assert(typeof today.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today.day),
    `each row carries an ISO day (got ${today.day})`);
  assert(today.arms.a && today.arms.b, 'both arms appear on the day');
  assert(today.arms.a.exposures === 60 && today.arms.b.exposures === 60,
    `per-day exposures are per ARM, not summed (a=${today.arms.a.exposures}, b=${today.arms.b.exposures})`);
  // Arm b after the refund: net 450 over 60 exposures = 7.5 exactly.
  near(today.arms.b.rev_per_exposure, 7.5, 1e-9, 'per-day rev/exposure = 450/60 = 7.5');
  near(today.arms.a.rev_per_exposure, 5, 1e-9, 'and arm a = 300/60 = 5');
  // Newest first.
  const daysSorted = after.daily.map((d) => d.day);
  assert(JSON.stringify(daysSorted) === JSON.stringify([...daysSorted].sort().reverse()),
    `days are newest-first (${daysSorted.join(', ')})`);
  assert(!findNonFinite(after.daily), 'the daily series carries no NaN/Infinity');
  // The series must NOT feed the verdict — it is a shape reading only.
  assert(after.verdict.ranked.length === 2, 'the verdict is unchanged by the presence of the series');

  hr('C12 · a credit-day lag cannot change the day-by-day shape');
  // THE REVIEWER'S FIXTURE. Two arms, identical lifetime numbers, differing ONLY
  // in when their money was stamped: arm a's credits carry their exposure day,
  // arm b's carry the NEXT day (the shape a settlement crossing midnight, an
  // explicit `day` override, a retry sweep or a rebuilt rollup produces).
  //
  // Keying the money to the credit row's own day rendered arm b as
  // "$0.0000 over 50 exposures" on the day it actually earned — a FALSE MEASURED
  // ZERO, which is exactly the null-vs-0 distinction this module refuses to blur
  // — followed by "— over 0 exposures" the next day, hiding real revenue behind
  // a dash. Keyed to the SESSION'S EXPOSURE DAY, the two arms are identical.
  const lagId = 'lbsg_stats_lag';
  await query(`DELETE FROM lb_split_credits WHERE group_id = $1`, [lagId]);
  await query(`DELETE FROM lb_split_arms WHERE test_id = $1`, [lagId]);
  await query(`DELETE FROM lb_split_tests WHERE id = $1`, [lagId]);
  await query(
    `INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ($1, 'credit-day lag', 'page', TRUE)`,
    [lagId]
  );
  for (const [key, ctl] of [['a', true], ['b', false]]) {
    await query(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control, is_entry, sort_order)
       VALUES ($1, $2, $3, 50, $4, $4, 0)`,
      [`lbsa_lag_${key}`, lagId, key, ctl]
    );
  }
  const EXPOSURE_DAY = '2026-03-01';
  const NEXT_DAY = '2026-03-02';
  for (const armKey of ['a', 'b']) {
    for (let i = 0; i < 50; i += 1) {
      const st = await recordExposure(
        { sessionId: `lag_${armKey}_${i}`, testId: lagId, armKey, day: EXPOSURE_DAY }, { query });
      if (st !== 'recorded') throw new Error(`lag exposure ${armKey}/${i} -> ${st}`);
    }
  }
  for (let i = 0; i < 10; i += 1) {
    // Arm a: no explicit day — the credit inherits its exposure row's day.
    const sa = await creditConversion(
      { sessionId: `lag_a_${i}`, testId: lagId, chargeId: `lag_ch_a_${i}`, value: 100 }, { query });
    if (sa !== 'credited') throw new Error(`lag credit a/${i} -> ${sa}`);
    // Arm b: the SAME money, stamped a day late.
    const sb = await creditConversion(
      { sessionId: `lag_b_${i}`, testId: lagId, chargeId: `lag_ch_b_${i}`, value: 100, day: NEXT_DAY },
      { query }
    );
    if (sb !== 'credited') throw new Error(`lag credit b/${i} -> ${sb}`);
  }

  const lag = await readResults({ testId: lagId }, { query });
  const lagA = lag.arms.find((x) => x.arm_key === 'a');
  const lagB = lag.arms.find((x) => x.arm_key === 'b');
  // Precondition: the arms really are identical on lifetime figures.
  assert(Number(lagA.net_revenue) === 1000 && Number(lagB.net_revenue) === 1000,
    `both arms earned 1000 lifetime (a=${lagA.net_revenue}, b=${lagB.net_revenue})`);
  assert(lagA.exposures === 50 && lagB.exposures === 50, 'both arms took 50 exposures');
  // Precondition: the credit rows really ARE stamped on different days, or this
  // case would pass without testing anything.
  const stampedDays = await query(
    `SELECT DISTINCT arm_key, day FROM lb_split_credits
     WHERE group_id = $1 AND kind = 'credit' ORDER BY arm_key`,
    [lagId]
  );
  const dayOf = (k) => stampedDays.filter((r) => r.arm_key === k)
    .map((r) => new Date(r.day).toISOString().slice(0, 10));
  assert(dayOf('a')[0] === EXPOSURE_DAY, `arm a's credits are stamped ${EXPOSURE_DAY}`);
  assert(dayOf('b')[0] === NEXT_DAY,
    `arm b's credits really ARE stamped a day late (${dayOf('b')[0]}) — the lag is present`);

  // THE ASSERTION. One day cell, both arms, identical shapes.
  assert(lag.daily.length === 1,
    `the lagged money does NOT create a second day cell (got ${lag.daily.length}: ${lag.daily.map((d) => d.day).join(', ')})`);
  assert(lag.daily[0].day === EXPOSURE_DAY,
    `and the single cell is the EXPOSURE day (got ${lag.daily[0].day})`);
  const cellA = lag.daily[0].arms.a;
  const cellB = lag.daily[0].arms.b;
  assert(JSON.stringify(cellA) === JSON.stringify(cellB),
    `two identical arms render IDENTICAL day-by-day shapes despite the credit-day lag `
    + `(a=${JSON.stringify(cellA)}, b=${JSON.stringify(cellB)})`);
  near(cellB.rev_per_exposure, 20, 1e-9, 'arm b reads 1000/50 = 20.00 on its exposure day, not 0.0000');
  assert(cellB.rev_per_exposure !== 0,
    'and specifically NOT a false measured zero — the defect this join fixes');
  assert(cellB.exposures === 50 && cellB.orders === 10, 'its numerator and denominator are on the same cell');

  for (const id of [lagId]) {
    await query(`DELETE FROM lb_split_credits WHERE group_id = $1`, [id]);
    await query(`DELETE FROM lb_split_arms WHERE test_id = $1`, [id]);
    await query(`DELETE FROM lb_split_tests WHERE id = $1`, [id]);
  }

  hr('C11 · per-arm submits are real or an honest refusal, never a fabricated zero');
  assert(after.submits && typeof after.submits.available === 'boolean',
    'a submits block is always returned');
  if (after.submits.available) {
    assert(Object.keys(after.submits.by_arm).length === 2, 'both arms carry a submit count');
  } else {
    assert(typeof after.submits.reason === 'string' && after.submits.reason.length > 0,
      `an unavailable block names WHY (got ${after.submits.reason})`);
    assert(Object.keys(after.submits.by_arm).length === 0,
      'and it carries NO per-arm numbers rather than zeros that would read as measured');
  }

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
// 4. CLIENT BOUNDARY — the REAL splitApi.js, executed
// ══════════════════════════════════════════════════════════════════════════
//
// The server can be perfectly right and the operator still be shown a lie: the
// client converts fractions to percents, and getting that wrong renders a
// decisive 97% as "0.97%". So the real file is loaded and run.
//
// Same technique as scripts/verifySplitUiGuards.mjs: node cannot resolve Vite's
// extensionless `../../../services/api` import, so that ONE line is rewritten
// to a controllable stub. If the line ever moves, the rewrite fails loudly
// rather than testing a file that is no longer the shipped one.
async function loadSplitApi() {
  const src = new URL('../../../client/src/components/funnels/split/splitApi.js', import.meta.url);
  const code = readFileSync(src, 'utf8');
  // The lookup is DEFERRED to call time, not bound at module load. Binding it
  // (`const api = globalThis.__SPLIT_API_STUB__`) captures `undefined`, because
  // the module is imported before any scenario installs its stub — and then
  // every call throws a TypeError that fetchLifetimeStats dutifully catches and
  // reports as 'network_error'. Every scenario passed its "never throws"
  // assertion and every reason was wrong: the harness would have been testing
  // its own broken stub. Caught by running it.
  const stubbed = code.replace(
    "import api from '../../../services/api';",
    'const api = { get: (...a) => globalThis.__SPLIT_API_STUB__.get(...a) };'
  );
  if (stubbed === code) {
    throw new Error('the api import line no longer matches splitApi.js — the stub is stale');
  }
  const file = join(mkdtempSync(join(tmpdir(), 'splitapi-stats-')), 'splitApi.mjs');
  writeFileSync(file, stubbed);
  return import(pathToFileURL(file).href);
}

async function clientBoundary() {
  const mod = await loadSplitApi();
  const { normalizeLifetimeStats, fetchLifetimeStats, shouldShowWinnerBadge } = mod;

  // ── B1 · THE 100x TRAP, IN BOTH DIRECTIONS ─────────────────────────────
  // `confidence` and `cvr` are FRACTIONS and must be multiplied once.
  // `rpv_lift_pct` and `cvr_lift_pct` are ALREADY percents and must NOT be.
  hr('B1 · fractions convert exactly once, already-percents are left alone');
  const norm = normalizeLifetimeStats({
    arms: [{
      arm_key: 'b', exposures: 900, conversions: 120, net_revenue: 6000,
      stats: {
        arm_key: 'b', is_control: false, is_winner: true, cvr: 0.0432,
        conversion: { confidence: 0.97, p_value: 0.03, significant: true },
        revenue: { confidence: 0.9812, p_value: 0.0188, significant: true },
        lift: { rpv_lift_pct: 30, cvr_lift_pct: 12.5 },
      },
    }],
    verdict: { status: 'winner', ready: true },
  });
  const nb = norm.arms[0];
  near(nb.stats.conversion.confidence_pct, 97, 1e-9, 'confidence 0.97 renders as 97%, NOT 0.97%');
  near(nb.stats.revenue.confidence_pct, 98.12, 1e-9, 'confidence 0.9812 renders as 98.12%');
  near(nb.stats.cvr_pct, 4.32, 1e-9, 'cvr 0.0432 renders as 4.32%');
  near(nb.stats.lift.rpv_lift_pct, 30, 1e-9, 'rpv_lift_pct 30 stays 30 (already a percent, NOT 3000)');
  near(nb.stats.lift.cvr_lift_pct, 12.5, 1e-9, 'cvr_lift_pct 12.5 stays 12.5');
  // The raw counts must survive the normaliser untouched — it is a display
  // adapter, never a place a figure changes.
  assert(nb.exposures === 900 && nb.conversions === 120 && nb.net_revenue === 6000,
    'the raw arm counts pass through the normaliser unchanged');
  // The originals are preserved beside the converted ones, so the payload stays
  // self-describing.
  near(nb.stats.conversion.confidence, 0.97, 1e-12, 'the original fraction is preserved alongside');

  // ── B2 · A WITHHELD NUMBER IS NEVER RENDERED AS ZERO ───────────────────
  // This is the whole withholding contract arriving intact at the UI. `null`
  // must become `undefined` (the '—' signal), NEVER 0.
  hr('B2 · a withheld (null) figure becomes undefined, never 0');
  const withheld = normalizeLifetimeStats({
    arms: [{
      arm_key: 'b', exposures: 5,
      stats: {
        arm_key: 'b', cvr: null,
        conversion: { confidence: null, p_value: null, reason: 'below_stats_floor' },
        revenue: { confidence: null, p_value: null, reason: 'below_stats_floor' },
        lift: {},
      },
    }],
    verdict: { status: 'insufficient_data', ready: false },
  });
  const wb = withheld.arms[0];
  assert(wb.stats.conversion.confidence_pct === undefined,
    `a null conversion confidence is undefined, not 0 (got ${wb.stats.conversion.confidence_pct})`);
  assert(wb.stats.revenue.confidence_pct === undefined,
    `a null revenue confidence is undefined, not 0 (got ${wb.stats.revenue.confidence_pct})`);
  assert(wb.stats.cvr_pct === undefined, `a null cvr is undefined, not 0 (got ${wb.stats.cvr_pct})`);
  assert(wb.stats.conversion.reason === 'below_stats_floor', 'the withholding reason survives to the UI');
  // A 0 that is a REAL measurement must still render as 0.
  const zero = normalizeLifetimeStats({
    arms: [{ arm_key: 'a', stats: { arm_key: 'a', cvr: 0, conversion: { confidence: 0 }, revenue: {}, lift: {} } }],
    verdict: { status: 'no_winner', ready: true },
  });
  assert(zero.arms[0].stats.cvr_pct === 0, 'a genuine cvr of 0 still renders as 0, not as a dash');

  // An arm with no statistics at all (older row) must not crash the normaliser.
  const noStats = normalizeLifetimeStats({ arms: [{ arm_key: 'a', exposures: 3 }], verdict: {} });
  assert(noStats.arms[0].stats === null, 'an arm with no stats normalises to null rather than throwing');

  // ── B3 · THE WINNER-BADGE TRUTH TABLE ──────────────────────────────────
  // The one rule on this surface whose failure costs money.
  hr('B3 · the winner badge truth table — never a trophy below readiness');
  const table = [
    [{ is_winner: true }, { status: 'winner', ready: true }, true, 'winner + ready + status winner'],
    [{ is_winner: true }, { status: 'winner', ready: false }, false, 'NOT ready -> no badge, even if flagged winner'],
    [{ is_winner: true }, { status: 'not_ready', ready: false }, false, 'status not_ready -> no badge'],
    [{ is_winner: true }, { status: 'no_winner', ready: true }, false, 'status no_winner -> no badge'],
    [{ is_winner: true }, { status: 'insufficient_data', ready: false }, false, 'insufficient_data -> no badge'],
    [{ is_winner: false }, { status: 'winner', ready: true }, false, 'a non-winning arm never gets the badge'],
    [{}, { status: 'winner', ready: true }, false, 'a missing is_winner defaults to NO badge'],
    [{ is_winner: true }, {}, false, 'a missing verdict defaults to NO badge'],
    [{ is_winner: true }, null, false, 'a null verdict defaults to NO badge'],
    [null, { status: 'winner', ready: true }, false, 'null stats defaults to NO badge'],
    [undefined, undefined, false, 'both missing defaults to NO badge'],
    [{ is_winner: true }, { status: 'winner' }, false, 'ready ABSENT (not false) still means NO badge'],
  ];
  for (const [st, vd, want, label] of table) {
    let got;
    let threw = null;
    try { got = shouldShowWinnerBadge(st, vd); } catch (err) { threw = err; }
    assert(!threw, `${label}: does not throw${threw ? ` (${threw.message})` : ''}`);
    assert(got === want, `${label}: ${want} (got ${got})`);
  }

  // ── B4 · fetchLifetimeStats DEGRADES, NEVER THROWS ─────────────────────
  // The results modal renders two independent reads side by side. If this one
  // throws, the modal takes the whole surface down — which is the failure the
  // analytics reader was already written to avoid.
  hr('B4 · fetchLifetimeStats degrades honestly and never throws');
  const scenarios = [
    ['a full payload', async () => ({ data: { data: { arms: [{ arm_key: 'a', stats: { conversion: {}, revenue: {}, lift: {} } }], verdict: { status: 'not_ready' } } } }),
      { available: true }],
    ['an UNWRAPPED payload (no success/data envelope)', async () => ({ data: { arms: [{ arm_key: 'a', stats: { conversion: {}, revenue: {}, lift: {} } }], verdict: { status: 'not_ready' } } }),
      { available: true }],
    ['200 with raw counts but NO statistics (an older deploy)', async () => ({ data: { data: { arms: [{ arm_key: 'a' }] } } }),
      { available: false, reason: 'no_statistics_on_this_deploy' }],
    ['200 with no arms array', async () => ({ data: { data: { verdict: {} } } }),
      { available: false, reason: 'unrecognised_shape' }],
    ['200 with a null body', async () => ({ data: null }),
      { available: false, reason: 'unrecognised_shape' }],
    ['a 404', async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; },
      { available: false, reason: 'http_404' }],
    ['a 500', async () => { const e = new Error('boom'); e.response = { status: 500 }; throw e; },
      { available: false, reason: 'http_500' }],
    ['a network error with no response', async () => { throw new Error('ECONNREFUSED'); },
      { available: false, reason: 'network_error' }],
  ];
  for (const [label, get, want] of scenarios) {
    globalThis.__SPLIT_API_STUB__ = { get };
    let res;
    let threw = null;
    try { res = await fetchLifetimeStats('lbsg_x'); } catch (err) { threw = err; }
    assert(!threw, `${label}: never throws${threw ? ` (${threw.message})` : ''}`);
    if (!threw) {
      assert(res.available === want.available, `${label}: available = ${want.available} (got ${res.available})`);
      if (want.reason) assert(res.reason === want.reason, `${label}: reason = ${want.reason} (got ${res.reason})`);
    }
  }

  // ── B5 · THE END-TO-END SHAPE ──────────────────────────────────────────
  // The SERVICE's own output, fed through the CLIENT's reader, with nothing
  // hand-written in between. This is the assertion that would catch the two
  // sides drifting apart — a field renamed on the server and still read here.
  hr('B5 · the real service output survives the real client reader');
  const serviceOut = computeSplitStatistics([
    arm('a', { control: true, visitors: 4000, conversions: 400, revenue: 20000, sumsq: 1400000 }),
    arm('b', { control: false, visitors: 4000, conversions: 520, revenue: 26000, sumsq: 1960000 }),
  ]);
  const payload = {
    arms: Object.values(serviceOut.arms).map((st) => ({
      arm_key: st.arm_key, exposures: st.visitors, conversions: st.conversions, stats: st,
    })),
    verdict: serviceOut.verdict,
    floors: serviceOut.floors,
  };
  globalThis.__SPLIT_API_STUB__ = { get: async () => ({ data: { data: payload } }) };
  const live = await fetchLifetimeStats('lbsg_e2e');
  assert(live.available === true, 'the real service payload is accepted by the client reader');
  const bArm = live.data.arms.find((a) => a.arm_key === 'b');
  assert(bArm.stats.revenue.confidence_pct > 1,
    `confidence renders above 1% (got ${bArm.stats.revenue.confidence_pct}) — the 100x regression guard`);
  near(bArm.stats.revenue.confidence_pct, serviceOut.arms.b.revenue.confidence * 100, 1e-6,
    'the rendered percent is exactly 100x the service fraction');
  assert(bArm.stats.readiness.ready === true, 'readiness survives the round trip');
  assert(shouldShowWinnerBadge(bArm.stats, live.data.verdict) === Boolean(serviceOut.verdict.winner === 'b'),
    'the badge predicate agrees with the service verdict end to end');
  // ── B6 · THE RENDERED SHAPES OF THE THREE TABLES ───────────────────────
  hr('B6 · rendered shape: formatters and the windowed Sample cell');
  const { fmtMoney: fmtMoneyC, fmtPct: fmtPctC, windowSampleState, normalizeMetrics, assertPercentScale } = mod;

  // A CONFIDENCE NEVER RENDERS AS FLAT 100% CERTAINTY. The cap is OPT-IN — see
  // below for why that direction matters — so these assert the confidence
  // contract, and the structural check that follows asserts the call sites
  // actually opt in.
  for (const v of [100, 99.999, 99.99999]) {
    const out = fmtPctC(v, { cap: true });
    assert(out !== '100.00%', `confidence ${v} does not render as flat 100.00% (got ${out})`);
  }
  assert(fmtPctC(100, { cap: true }) === '>99.99%',
    `a capped confidence renders as a BOUND (got ${fmtPctC(100, { cap: true })})`);
  assert(fmtPctC(99.99, { cap: true }) === '99.99%', 'exactly at the cap renders as a value, not a bound');
  assert(fmtPctC(4.32, { cap: true }) === '4.32%', 'ordinary confidences are untouched');
  // THE CAP MUST NOT TOUCH UNBOUNDED QUANTITIES. -100% means an arm earned
  // nothing — real data, and an earlier cut of fmtPct silently corrupted it to
  // -99.99% by capping on magnitude.
  assert(fmtPctC(-100) === '-100.00%', 'a -100% CHANGE is real data and is left alone');
  assert(fmtPctC(-100, { cap: true }) === '-100.00%', 'even opted-in, the cap never rewrites a negative');
  assert(fmtPctC(150) === '150.00%', 'an unbounded lift is uncapped by DEFAULT (opt-in, not opt-out)');
  assert(fmtPctC(100) === '100.00%', 'a +100% lift is a reachable value and renders as one');
  assert(assertPercentScale().length === 0,
    `the scale invariant still holds (${assertPercentScale().join('; ')})`);

  // FOUR DECIMALS on per-visitor money: two arms $0.004 apart must not both
  // render as the same string.
  assert(fmtMoneyC(5.4108, { digits: 4 }) === '$5.4108', `4dp money (got ${fmtMoneyC(5.4108, { digits: 4 })})`);
  assert(fmtMoneyC(5.4108) === '$5.41', 'the default stays 2dp for ordinary money');
  assert(fmtMoneyC(5.411, { digits: 4 }) !== fmtMoneyC(5.4148, { digits: 4 }),
    'two arms 0.4 cents apart render DIFFERENTLY at 4dp (they collided at 2dp)');

  // THE WINDOWED SAMPLE CELL, derived from the service's own floors.
  const sampleFloors = { minVisitorsPerArm: 300, minConversionsPerArm: 25 };
  const readyCell = windowSampleState({ visitors: 900, orders: 90 }, sampleFloors);
  assert(readyCell.known && readyCell.ready, 'an arm past both floors reads ready');
  const thinCell = windowSampleState({ visitors: 60, orders: 4 }, sampleFloors);
  assert(thinCell.known && !thinCell.ready, 'a thin arm reads not ready');
  assert(thinCell.needVisitors === 240 && thinCell.needOrders === 21,
    `and reports the exact shortfall (got ${thinCell.needVisitors}/${thinCell.needOrders})`);
  // Missing floors must read as UNKNOWN, never as ready.
  const unknownCell = windowSampleState({ visitors: 900, orders: 90 }, {});
  assert(!unknownCell.known && !unknownCell.ready,
    'absent floors read as unknown and NEVER as ready');
  assert(!windowSampleState(undefined, undefined).ready, 'no data at all is never ready');
  // Orders above the denominator must not manufacture a surplus.
  const clamped = windowSampleState({ visitors: 10, orders: 9000 }, sampleFloors);
  assert(clamped.needOrders === 15, `orders are clamped to the denominator (got ${clamped.needOrders})`);

  // THE NEW WINDOWED COLUMN — conversion confidence, from verdict.perArm.
  const win = normalizeMetrics({
    arms: [{ arm_key: 'a', is_control: true, visitors: 900, orders: 90 },
      { arm_key: 'b', is_control: false, visitors: 900, orders: 120 }],
    verdict: {
      status: 'no_winner',
      perArm: { b: { revenue_confidence: 0.909, conversion_confidence: 0.998, significant: false } },
      sample: sampleFloors,
    },
  });
  const winB = win.arms.find((a) => a.arm_key === 'b');
  near(winB.confidence, 90.9, 1e-9, 'revenue confidence 0.909 -> 90.9%');
  near(winB.conv_confidence, 99.8, 1e-9, 'conversion confidence 0.998 -> 99.8% (it rendered nowhere before)');
  assert(win.verdict.sample.minVisitorsPerArm === 300, 'the floors reach the Sample cell');

  // ── B7 · THE CONFIDENCE CALL SITES ACTUALLY OPT IN ─────────────────────
  // The cap is opt-in, so a correct fmtPct proves nothing on its own: what
  // matters is that every CONFIDENCE cell asks for it. Checked structurally
  // against the shipped JSX, because a call site that forgets is exactly the
  // regression the opt-in design makes possible.
  hr('B7 · every confidence cell in the modal opts into the display cap');
  const modalSrc = readFileSync(
    new URL('../../../client/src/components/funnels/split/SplitResultsModal.jsx', import.meta.url),
    'utf8'
  );
  // Every fmtPct call whose argument mentions a confidence must carry cap: true.
  const pctCalls = modalSrc.match(/fmtPct\([^)]*\)/g) || [];
  const confidenceCalls = pctCalls.filter((c) => /confidence|conf\b/.test(c));
  assert(confidenceCalls.length >= 3,
    `the modal has confidence cells to check (found ${confidenceCalls.length})`);
  const uncapped = confidenceCalls.filter((c) => !/cap:\s*true/.test(c));
  assert(uncapped.length === 0,
    `every confidence cell opts into the cap (uncapped: ${uncapped.join(' | ') || 'none'})`);
  // And the inverse: the vs-control cell must NOT be capped, or a -100% change
  // would be corrupted on screen.
  const vsControl = pctCalls.filter((c) => /vs_control/.test(c));
  assert(vsControl.length > 0 && vsControl.every((c) => !/cap:\s*true/.test(c)),
    `the vs-control cell is deliberately uncapped (${vsControl.join(' | ')})`);

  delete globalThis.__SPLIT_API_STUB__;
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('SPLIT STATISTICS HARNESS');
  knownAnswers();
  properties();
  proseBuilders();
  narration();
  await clientBoundary();

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
