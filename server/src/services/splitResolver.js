// Split-testing subsystem — the RESOLVER (SELF-CONTAINED, NEW FILE).
//
// Deterministically and STICKILY assigns a visitor to an arm. Ported from
// funnel-os split_groups_service._pick_split_variant, with one deliberate
// change the Puure task calls for: assignment is a pure HASH of
// (visitor id + test id) rather than random.choices()+cookie. That buys three
// things at once:
//   • sticky WITHOUT storage — the same visitor id always hashes to the same
//     arm across every hop of the funnel, so no 30-day cookie to mint, read
//     back, or lose;
//   • deterministic and testable — no Math.random (unavailable here anyway),
//     no clock, no I/O;
//   • even distribution — the hash is uniform over [0,1), so weighting is exact
//     across arms at N.
//
// FAIL-OPEN (DECISIONS #16 "fail open for serving"): if anything here throws,
// the caller still gets a page. resolveArm returns the CONTROL arm on any
// error and never raises. An A/B assignment bug must cost a measurement, never
// the traffic you already paid for.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';

/**
 * Uniform fraction in [0, 1) derived from (visitorId, testId). Stable: the
 * same pair always yields the same fraction, on any machine, forever.
 * Seeded by BOTH ids so a visitor lands on independent arms across different
 * tests (no correlation between experiments).
 */
export function hashFraction(visitorId, testId) {
  const h = crypto
    .createHash('sha256')
    .update(`${String(visitorId)}|${String(testId)}`)
    .digest();
  // 52 bits of the digest → an exact double in [0,1) (JS integers are exact to
  // 2^53). readUIntBE handles up to 6 bytes; combine two reads for 52 bits.
  const hi = h.readUIntBE(0, 4); // 32 bits
  const lo = h.readUIntBE(4, 3) & 0xfffff; // 20 bits → 52 total
  const n = hi * 0x100000 + lo; // 0 .. 2^52 - 1
  return n / 0x10000000000000; // / 2^52  → [0, 1)
}

// The eligible, non-archived arms of a test, normalised. Negative/NaN weights
// clamp to 0; an all-zero (or empty-weight) set degrades to EQUAL weights —
// serve time never rejects. Returns { arms:[{arm_key,weight,...}], control }.
function normaliseArms(arms) {
  const live = (arms || []).filter((a) => a && !a.archived && a.arm_key != null);
  if (!live.length) return { arms: [], control: null };
  const sorted = [...live].sort((a, b) => String(a.arm_key).localeCompare(String(b.arm_key)));
  const control =
    sorted.find((a) => a.is_control) || sorted[0]; // lowest arm_key if none flagged
  let weights = sorted.map((a) => {
    const w = Number(a.weight);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  if (weights.reduce((s, w) => s + w, 0) <= 0) weights = sorted.map(() => 1);
  return { arms: sorted, weights, control };
}

/**
 * PURE sticky picker. Given a visitor id, a test id and the arm list, return
 * the chosen arm object. Deterministic and side-effect-free. Returns the
 * control arm if resolution cannot proceed. Never throws.
 *
 * @returns {object|null} the chosen arm row, or null if the test has no arms.
 */
export function pickArm(visitorId, testId, arms) {
  try {
    const { arms: sorted, weights, control } = normaliseArms(arms);
    if (!sorted.length) return null;
    if (!visitorId) return control; // no identity → control, still deterministic
    const total = weights.reduce((s, w) => s + w, 0);
    let target = hashFraction(visitorId, testId) * total;
    for (let i = 0; i < sorted.length; i += 1) {
      target -= weights[i];
      if (target < 0) return sorted[i];
    }
    return sorted[sorted.length - 1]; // float dust guard
  } catch {
    // Fail-open: hand back a control arm if we can find one, else null.
    const live = (arms || []).filter((a) => a && !a.archived);
    return live.find((a) => a.is_control) || live[0] || null;
  }
}

/**
 * DB-backed sticky resolution. Loads a live test + its arms and returns the
 * chosen arm. FAIL-OPEN end to end: on ANY error (bad test id, DB down, weird
 * data) it returns { armKey: null, arm: null, failedOpen: true } and the caller
 * serves the default/control page unbranched. Never throws.
 *
 * @param {{visitorId:string, testId:string}} p
 * @param {object} [deps] — { query } injectable for tests.
 * @returns {Promise<{armKey:string|null, arm:object|null, failedOpen:boolean}>}
 */
export async function resolveArm({ visitorId, testId }, { query = pgQuery } = {}) {
  try {
    if (!testId) return { armKey: null, arm: null, failedOpen: true };
    const tests = await query(
      `SELECT id, enabled, archived FROM lb_split_tests WHERE id = $1`,
      [String(testId).slice(0, 120)]
    );
    const test = tests[0];
    // A paused/archived/absent test resolves OUTSIDE the splitter: the caller
    // serves its default. Not an error — a no-op.
    if (!test || !test.enabled || test.archived) {
      return { armKey: null, arm: null, failedOpen: false };
    }
    const arms = await query(
      `SELECT id, arm_key, weight, page_id, offer_id, is_control, archived
       FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
      [test.id]
    );
    const arm = pickArm(visitorId, test.id, arms);
    return { armKey: arm ? arm.arm_key : null, arm: arm || null, failedOpen: false };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitResolver] resolve failed (fail-open):', err.message);
    return { armKey: null, arm: null, failedOpen: true };
  }
}

// Whether the SERVE path actually delivers a visitor's assigned arm.
//
// False today: routes/funnelPublic.js renders by slug and routes/checkoutPublic.js
// loads the offer the client names, so lb_split_arms.page_id / offer_id are
// written by the admin CRUD and read by nothing. Assignment is recorded and has
// no causal effect, which means any measured gap between arms is noise.
//
// funnelAnalytics reads this to refuse to declare a winner. Flip it to true in
// the SAME commit that wires arm delivery into serving — not before.
export const SPLIT_DELIVERY_WIRED = false;
