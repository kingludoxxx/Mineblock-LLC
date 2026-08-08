// Split-testing subsystem — CREDITING + refund netting + results read
// (SELF-CONTAINED, NEW FILE).
//
// The money-adjacent core. Ported faithfully from funnel-os's
// lb_split_offers_service (the DENOMINATOR) and lb_split_credits_service (the
// NUMERATOR + per-leg refund cap). Reimplemented on Postgres.
//
// The four rules that keep this correct (DECISIONS #6 / #16, DATA-MODEL):
//   1. LEDGERS NOT COUNTERS. Every write is an immutable append. Counts are
//      derived on read (see readResults). A bug can be replayed away.
//   2. EXACTLY-ONCE crediting. A credit is an INSERT guarded by a UNIQUE index
//      on (session, group, CHARGE) — never a read-then-write. A redelivered or
//      concurrent settlement collides and no-ops. NOT session-keyed: the charge
//      id is in the key because one session carries several money legs.
//   3. NEVER CREDIT WITHOUT A DENOMINATOR. A credit resolves its arm from the
//      session's exposure (offer) row. No exposure ⇒ NO credit (returned as
//      'no_exposure'), so a lost assignment can never make a take rate exceed
//      100%.
//   4. A REFUND NETS IN THE LEDGER. It appends a NEGATIVE 'void' row on the
//      credit's own (arm, day) cell, capped at that leg's value; the original
//      credit row is never mutated. Per-leg cap: a downsell refund can never
//      subtract from a different leg's arm.
//
// NOTHING HERE RAISES into a money path — every function swallows and logs, and
// returns a status string. Two of the callers sit on the settle path of real
// money (DECISIONS #16: fail closed for money means REFUSE + escalate, never
// throw a 500 up the webhook).
import { pgQuery } from '../db/pg.js';
import { ensureSplitTables, EXPOSURE_CHARGE_SENTINEL } from './splitTestSchema.js';

// Money that can never poison an aggregate: finite, non-negative, 2dp.
// (funnel-os lb_split_ledger_service._safe_amount.)
function safeAmount(value) {
  const f = Number(value);
  if (!Number.isFinite(f) || f < 0) return 0;
  return Math.round(f * 100) / 100;
}

// A short opaque token for a row's day cell key. Callers may pass an explicit
// `day` (the funnel-os rule: a credit rolls up on the OFFER ROW's day, so a leg
// settling after midnight lands in the cell that carries its exposure); default
// is today (UTC).
function coerceDay(day) {
  if (!day) return null; // let the column DEFAULT (UTC today) apply
  const d = new Date(day);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Record that THIS session was SHOWN one arm of one test — the DENOMINATOR.
 * One immutable row per (session, group); first write wins; value is always 0
 * and it can never raise a credit. Idempotent.
 *
 * Call this at arm-assignment time: the serve-time hook (page split) or the
 * STEP-0 offer beacon / upsell accept+decline (offer split), mirroring
 * checkoutPublic's default-off arm-exposure denominator row.
 *
 * @returns {'recorded'|'duplicate'|'refused'|'failed'}
 */
export async function recordExposure(
  { sessionId, testId, armKey, currency = 'USD', day = null },
  { query = pgQuery } = {}
) {
  if (!sessionId || !testId || !armKey) return 'refused';
  try {
    await ensureSplitTables(query);
    const entryId = `exp:${sessionId}|${testId}`;
    const rows = await query(
      `INSERT INTO lb_split_credits
         (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day)
       VALUES ($1, 'exposure', $2, $3, $4, $5, 0, FALSE, $6, COALESCE($7::date, (NOW() AT TIME ZONE 'UTC')::date))
       ON CONFLICT (entry_id) DO NOTHING
       RETURNING id`,
      [entryId, String(sessionId), String(testId), String(armKey),
        EXPOSURE_CHARGE_SENTINEL, currency, coerceDay(day)]
    );
    return rows.length ? 'recorded' : 'duplicate';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] recordExposure failed:', err.message);
    return 'failed';
  }
}

/**
 * Credit a settled conversion to its arm — the NUMERATOR. Exactly-once,
 * idempotent, keyed by charge. The arm is resolved SERVER-SIDE from the
 * session's exposure row (never from a caller argument), so a leg can only be
 * credited to the arm the buyer was actually shown.
 *
 * `chargeId` is the money-leg id: the co_upsell_charges.id for an upsell leg,
 * or a deterministic base-leg id (e.g. `base:<sessionId>`) for the base order.
 * Different charges on one session ⇒ distinct rows. Same charge redelivered ⇒
 * one row.
 *
 * @returns {'credited'|'duplicate'|'no_exposure'|'refused'|'failed'}
 */
export async function creditConversion(
  { sessionId, testId, chargeId, value, currency = 'USD', day = null },
  { query = pgQuery } = {}
) {
  if (!sessionId || !testId || !chargeId) return 'refused';
  try {
    await ensureSplitTables(query);
    // ── The denominator must already exist (rule 3). Its arm + day are the
    //    server-side truth this credit rolls up on. ──────────────────────────
    const exp = await query(
      `SELECT arm_key, day, currency FROM lb_split_credits
       WHERE kind = 'exposure' AND session_id = $1 AND group_id = $2 LIMIT 1`,
      [String(sessionId), String(testId)]
    );
    if (!exp.length) {
      // A real money leg with no denominator: crediting it would push the take
      // rate above 100%. Refuse — the loss is visible as a missing numerator,
      // not an inflated one.
      // eslint-disable-next-line no-console
      console.warn(
        `[splitCredits] no_exposure session=${sessionId} test=${testId} charge=${chargeId} — refusing credit`
      );
      return 'no_exposure';
    }
    const armKey = exp[0].arm_key;
    // The credit rolls up on the EXPOSURE ROW's day (funnel-os rule), so a leg
    // that settles after midnight or replays days later still lands in the cell
    // that carries its exposure. Explicit `day` overrides only if provided.
    const rollupDay = coerceDay(day) || (exp[0].day ? new Date(exp[0].day).toISOString().slice(0, 10) : null);
    const entryId = `cr:${sessionId}|${testId}|u:${chargeId}`;
    const rows = await query(
      `INSERT INTO lb_split_credits
         (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day)
       VALUES ($1, 'credit', $2, $3, $4, $5, $6, TRUE, $7, COALESCE($8::date, (NOW() AT TIME ZONE 'UTC')::date))
       ON CONFLICT (entry_id) DO NOTHING
       RETURNING id`,
      [entryId, String(sessionId), String(testId), String(armKey),
        String(chargeId), safeAmount(value), currency || exp[0].currency || 'USD', rollupDay]
    );
    // The partial UNIQUE on (session, group, charge) WHERE kind='credit' is the
    // second guard: even a forged entry_id can't mint a second credit for a leg.
    return rows.length ? 'credited' : 'duplicate';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] creditConversion failed:', err.message);
    return 'failed';
  }
}

/**
 * Net a refund against ONE credit leg — append a NEGATIVE void row, never
 * mutate the credit. Capped at the leg's remaining value (per-leg cap: a
 * refund can only ever subtract from its own leg's arm). Idempotent per refund
 * event via `refundKey` (the gateway refund id, or any stable per-event id).
 *
 * @returns {'netted'|'duplicate'|'nothing_to_net'|'no_credit'|'refused'|'failed'}
 */
export async function voidCredit(
  { sessionId, testId, chargeId, amount, refundKey = 'r', currency = 'USD' },
  { query = pgQuery } = {}
) {
  if (!sessionId || !testId || !chargeId) return 'refused';
  try {
    await ensureSplitTables(query);
    // The one credit row for this leg (resolution is exactly-once, so at most
    // one exists). Its arm and day are what the void rolls up on.
    const credit = await query(
      `SELECT arm_key, value, day, currency FROM lb_split_credits
       WHERE kind = 'credit' AND session_id = $1 AND group_id = $2 AND charge_id = $3 LIMIT 1`,
      [String(sessionId), String(testId), String(chargeId)]
    );
    if (!credit.length) return 'no_credit';
    // Re-derive the cap from the ledger on every call: room = value - already
    // voided. value is written once; voids only ever ADD negative deltas; so the
    // sum of voids is bounded by value by induction (a partial-then-full or a
    // redelivered reversal is idempotent-safe).
    const voided = await query(
      `SELECT COALESCE(-SUM(value), 0) AS total FROM lb_split_credits
       WHERE kind = 'void' AND session_id = $1 AND group_id = $2 AND charge_id = $3`,
      [String(sessionId), String(testId), String(chargeId)]
    );
    const creditVal = safeAmount(credit[0].value);
    const already = safeAmount(voided[0].total);
    const room = Math.round((creditVal - already) * 100) / 100;
    const delta = Math.min(safeAmount(amount), Math.max(0, room));
    if (delta <= 0) return 'nothing_to_net';

    const voidDay = credit[0].day ? new Date(credit[0].day).toISOString().slice(0, 10) : null;
    const entryId = `void:${sessionId}|${testId}|u:${chargeId}|${String(refundKey).slice(0, 80)}`;
    const rows = await query(
      `INSERT INTO lb_split_credits
         (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day, refund_key)
       VALUES ($1, 'void', $2, $3, $4, $5, $6, TRUE, $7, COALESCE($8::date, (NOW() AT TIME ZONE 'UTC')::date), $9)
       ON CONFLICT (entry_id) DO NOTHING
       RETURNING id`,
      [entryId, String(sessionId), String(testId), String(credit[0].arm_key),
        String(chargeId), -delta, currency || credit[0].currency || 'USD', voidDay,
        String(refundKey).slice(0, 80)]
    );
    return rows.length ? 'netted' : 'duplicate';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] voidCredit failed:', err.message);
    return 'failed';
  }
}

/**
 * CONVENIENCE settle-hook wrapper: credit ONE money leg to every test this
 * session was exposed to whose scope matches. This keeps the settlement hooks a
 * single call and semantically correct:
 *   • base order settles  → scope 'page'  (lander split numerator)
 *   • upsell leg settles   → scope 'offer' (post-purchase split numerator)
 * A session in several tests is credited to each; a session in none is a no-op.
 * Never throws — returns a per-test status array.
 *
 * @returns {Promise<Array<{testId:string, status:string}>>}
 */
export async function creditSessionConversions(
  { sessionId, chargeId, value, currency = 'USD', scope },
  { query = pgQuery } = {}
) {
  if (!sessionId || !chargeId) return [];
  try {
    await ensureSplitTables(query);
    // Every test (of this scope) this session carries a denominator for. The
    // exposure rows ARE the server-side proof of which arm; crediting reads
    // them, so a settle hook needs no test id of its own.
    const params = [String(sessionId)];
    let scopeClause = '';
    if (scope) { params.push(String(scope)); scopeClause = ` AND t.scope = $2`; }
    const tests = await query(
      `SELECT DISTINCT c.group_id FROM lb_split_credits c
       JOIN lb_split_tests t ON t.id = c.group_id
       WHERE c.kind = 'exposure' AND c.session_id = $1${scopeClause}`,
      params
    );
    const out = [];
    for (const row of tests) {
      const status = await creditConversion(
        { sessionId, testId: row.group_id, chargeId, value, currency }, { query }
      );
      out.push({ testId: row.group_id, status });
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] creditSessionConversions failed:', err.message);
    return [];
  }
}

/**
 * CONVENIENCE refund-hook wrapper: net a leg's refund across every test that
 * credited it. Mirrors creditSessionConversions. Never throws.
 *
 * @returns {Promise<Array<{testId:string, status:string}>>}
 */
export async function voidSessionRefund(
  { sessionId, chargeId, amount, refundKey = 'r', currency = 'USD' },
  { query = pgQuery } = {}
) {
  if (!sessionId || !chargeId) return [];
  try {
    await ensureSplitTables(query);
    const credits = await query(
      `SELECT DISTINCT group_id FROM lb_split_credits
       WHERE kind = 'credit' AND session_id = $1 AND charge_id = $2`,
      [String(sessionId), String(chargeId)]
    );
    const out = [];
    for (const row of credits) {
      const status = await voidCredit(
        { sessionId, testId: row.group_id, chargeId, amount, refundKey, currency }, { query }
      );
      out.push({ testId: row.group_id, status });
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] voidSessionRefund failed:', err.message);
    return [];
  }
}

/**
 * DERIVED results per arm — exposures vs credited conversions, netted against
 * refunds. Counters are computed from the ledger, never stored. Both sides of
 * the take rate are SESSIONS (funnel-os invariant: accepts<=offers holds only
 * because both count sessions), so `conversions` counts DISTINCT converting
 * sessions, not money legs — while revenue SUMS every leg.
 *
 * @returns {Promise<{testId, arms: Array, totals: object}>}
 */
export async function readResults({ testId }, { query = pgQuery } = {}) {
  await ensureSplitTables(query);
  const arms = await query(
    `SELECT arm_key, weight, is_control FROM lb_split_arms
     WHERE test_id = $1 AND NOT archived ORDER BY arm_key`,
    [String(testId)]
  );
  const agg = await query(
    `SELECT arm_key,
            COUNT(*) FILTER (WHERE kind = 'exposure')                    AS exposures,
            COUNT(DISTINCT session_id) FILTER (WHERE kind = 'credit')    AS conversions,
            COUNT(*) FILTER (WHERE kind = 'credit')                      AS credited_legs,
            COALESCE(SUM(value) FILTER (WHERE kind = 'credit'), 0)       AS gross_revenue,
            COALESCE(-SUM(value) FILTER (WHERE kind = 'void'), 0)        AS refunded,
            COALESCE(SUM(value) FILTER (WHERE kind IN ('credit','void')), 0) AS net_revenue
     FROM lb_split_credits WHERE group_id = $1
     GROUP BY arm_key`,
    [String(testId)]
  );
  const byArm = new Map(agg.map((r) => [r.arm_key, r]));
  const result = arms.map((a) => {
    const r = byArm.get(a.arm_key) || {};
    const exposures = Number(r.exposures || 0);
    const conversions = Number(r.conversions || 0);
    return {
      arm_key: a.arm_key,
      weight: Number(a.weight),
      is_control: a.is_control,
      exposures,
      conversions,
      credited_legs: Number(r.credited_legs || 0),
      gross_revenue: Number(r.gross_revenue || 0),
      refunded: Number(r.refunded || 0),
      net_revenue: Number(r.net_revenue || 0),
      take_rate: exposures > 0 ? Math.round((conversions / exposures) * 10000) / 10000 : null,
    };
  });
  const totals = result.reduce(
    (t, a) => ({
      exposures: t.exposures + a.exposures,
      conversions: t.conversions + a.conversions,
      credited_legs: t.credited_legs + a.credited_legs,
      gross_revenue: Math.round((t.gross_revenue + a.gross_revenue) * 100) / 100,
      refunded: Math.round((t.refunded + a.refunded) * 100) / 100,
      net_revenue: Math.round((t.net_revenue + a.net_revenue) * 100) / 100,
    }),
    { exposures: 0, conversions: 0, credited_legs: 0, gross_revenue: 0, refunded: 0, net_revenue: 0 }
  );
  return { testId: String(testId), arms: result, totals };
}
