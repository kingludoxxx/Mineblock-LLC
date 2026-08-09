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
import pgDb, { pgQuery } from '../db/pg.js';
import { ensureSplitTables, EXPOSURE_CHARGE_SENTINEL } from './splitTestSchema.js';

// Money that can never poison an aggregate: finite, non-negative, 2dp.
// (funnel-os lb_split_ledger_service._safe_amount.)
function safeAmount(value) {
  const f = Number(value);
  if (!Number.isFinite(f) || f < 0) return 0;
  return Math.round(f * 100) / 100;
}

// Identifier hygiene: trim + bound. A whitespace-only id must be REFUSED, not
// silently keyed as '  ' (a ledger keyed by an invisible id is unauditable).
const tid = (v, max = 120) => String(v ?? '').trim().slice(0, max);

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
  const sid = tid(sessionId);
  const gid = tid(testId);
  const arm = tid(armKey, 32);
  if (!sid || !gid || !arm) return 'refused';
  try {
    await ensureSplitTables(query);
    const entryId = `exp:${sid}|${gid}`;
    const rows = await query(
      `INSERT INTO lb_split_credits
         (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day)
       VALUES ($1, 'exposure', $2, $3, $4, $5, 0, FALSE, $6, COALESCE($7::date, (NOW() AT TIME ZONE 'UTC')::date))
       ON CONFLICT (entry_id) DO NOTHING
       RETURNING id`,
      [entryId, sid, gid, arm, EXPOSURE_CHARGE_SENTINEL, currency, coerceDay(day)]
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
  const sid = tid(sessionId);
  const gid = tid(testId);
  const cid = tid(chargeId, 160);
  if (!sid || !gid || !cid) return 'refused';
  // A non-finite/negative amount is a CALLER BUG, not a $0 sale. Coercing it
  // (safeAmount) writes a valid-looking zero-revenue credit and corrupts the
  // arm's revenue silently — the failure mode that hid a wrong SELECT at the
  // webhook call site. Fail closed and make the caller visible instead.
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[splitCredits] refused non-finite credit value session=${sid} test=${gid} charge=${cid} value=${String(value)}`
    );
    return 'refused';
  }
  try {
    await ensureSplitTables(query);
    // ── The denominator must already exist (rule 3). Its arm + day are the
    //    server-side truth this credit rolls up on. ──────────────────────────
    const exp = await query(
      `SELECT arm_key, day, currency FROM lb_split_credits
       WHERE kind = 'exposure' AND session_id = $1 AND group_id = $2 LIMIT 1`,
      [sid, gid]
    );
    if (!exp.length) {
      // A real money leg with no denominator: crediting it NOW would push the
      // take rate above 100%. Refuse — but PARK it (settle can race the
      // exposure beacon by seconds); retrySplitPendingCredits re-attempts once
      // the exposure lands, and the UNIQUE credit triple makes the replay safe.
      // eslint-disable-next-line no-console
      console.warn(
        `[splitCredits] no_exposure session=${sid} test=${gid} charge=${cid} — parked for retry`
      );
      await recordPendingCredit(
        { sessionId: sid, chargeId: cid, value, currency, testId: gid }, { query }
      );
      return 'no_exposure';
    }
    const armKey = exp[0].arm_key;
    // The credit rolls up on the EXPOSURE ROW's day (funnel-os rule), so a leg
    // that settles after midnight or replays days later still lands in the cell
    // that carries its exposure. Explicit `day` overrides only if provided.
    const rollupDay = coerceDay(day) || (exp[0].day ? new Date(exp[0].day).toISOString().slice(0, 10) : null);
    const entryId = `cr:${sid}|${gid}|u:${cid}`;
    const rows = await query(
      `INSERT INTO lb_split_credits
         (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day)
       VALUES ($1, 'credit', $2, $3, $4, $5, $6, TRUE, $7, COALESCE($8::date, (NOW() AT TIME ZONE 'UTC')::date))
       ON CONFLICT (entry_id) DO NOTHING
       RETURNING id`,
      [entryId, sid, gid, String(armKey), cid, safeAmount(value),
        currency || exp[0].currency || 'USD', rollupDay]
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

// Park a leg whose exposure has not landed yet. One row per (session, charge);
// a replay refreshes nothing (first write wins). Never raises. The `scope`
// (or a specific testId's scope, looked up) is stored so the retry pass can
// re-run the same scope-filtered credit the settle hook attempted.
async function recordPendingCredit(
  { sessionId, chargeId, value, currency = 'USD', scope = null, testId = null },
  { query = pgQuery } = {}
) {
  try {
    let sc = scope ? String(scope) : null;
    if (!sc && testId) {
      const t = await query(`SELECT scope FROM lb_split_tests WHERE id = $1`, [testId]);
      sc = t.length ? t[0].scope : null;
    }
    await query(
      `INSERT INTO lb_split_pending_credits (session_id, charge_id, value, currency, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, charge_id) DO NOTHING`,
      [sessionId, chargeId, safeAmount(value), currency, sc]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] recordPendingCredit failed:', err.message);
  }
}

/**
 * Retry pass for parked legs — export for the money-sweep wiring (call it from
 * moneySweeps' tick at merge; it is safe to run concurrently and repeatedly).
 * For each unresolved pending row (bounded age + attempts), re-run the same
 * scope-aware credit the settle hook ran. Exactly-once still holds: the credit
 * ledger's UNIQUE triple arbitrates, so a retry can only ever land ONE credit
 * per (session, group, charge) no matter how many passes overlap.
 *
 * Give-up bounds (DECISION): attempts >= 12 or age > 72h ⇒ the row is marked
 * resolved with resolution 'gave_up' — at that point the exposure is never
 * coming (ad blocker ate the beacon) and the loss stays an auditable
 * undercount, exactly funnel-os's lb_split_credit_audit semantics.
 *
 * @returns {Promise<{scanned:number, credited:number, resolved:number}>}
 */
export async function retrySplitPendingCredits(
  { limit = 200 } = {},
  { query = pgQuery } = {}
) {
  const out = { scanned: 0, credited: 0, resolved: 0 };
  try {
    await ensureSplitTables(query);
    // Sweep abandoned rows first so the open set stays bounded.
    await query(
      `UPDATE lb_split_pending_credits
       SET resolved_at = NOW(), resolution = 'gave_up'
       WHERE resolved_at IS NULL
         AND (attempts >= 12 OR created_at < NOW() - INTERVAL '72 hours')`
    );
    const rows = await query(
      `SELECT id, session_id, charge_id, value, currency, scope
       FROM lb_split_pending_credits
       WHERE resolved_at IS NULL
       ORDER BY id LIMIT $1`,
      [Math.max(1, Math.min(Number(limit) || 200, 1000))]
    );
    for (const row of rows) {
      out.scanned += 1;
      const results = await creditSessionConversions(
        {
          sessionId: row.session_id, chargeId: row.charge_id,
          value: Number(row.value), currency: row.currency || 'USD',
          scope: row.scope || undefined,
          // The retry pass must not re-park its own miss — it IS the retry.
          park: false,
        },
        { query }
      );
      const landed = results.some((r) => r.status === 'credited' || r.status === 'duplicate');
      if (landed) {
        out.credited += results.filter((r) => r.status === 'credited').length;
        out.resolved += 1;
        await query(
          `UPDATE lb_split_pending_credits
           SET resolved_at = NOW(), resolution = 'credited', attempts = attempts + 1
           WHERE id = $1`,
          [row.id]
        );
      } else {
        await query(
          `UPDATE lb_split_pending_credits SET attempts = attempts + 1 WHERE id = $1`,
          [row.id]
        );
      }
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] retrySplitPendingCredits failed:', err.message);
    return out;
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
  { query = pgQuery, sql = pgDb } = {}
) {
  const sid = tid(sessionId);
  const gid = tid(testId);
  const cid = tid(chargeId, 160);
  if (!sid || !gid || !cid) return 'refused';
  try {
    await ensureSplitTables(query);
    // THE CAP IS ENFORCED UNDER A ROW LOCK, NOT BY READ-THEN-WRITE.
    // Two concurrent refunds with DISTINCT refundKeys would otherwise both read
    // already=0 and both insert — over-voiding past the leg's value (the exact
    // race DECISIONS #3 bans: "never read, decide, write"). The whole
    // read+cap+insert runs in ONE transaction that takes SELECT ... FOR UPDATE
    // on the leg's credit row. The credit row is never UPDATEd by anything, so
    // the lock costs nothing except serializing concurrent voids of the SAME
    // leg — which is precisely the point: the second void re-reads the sum
    // AFTER the first commits and sees its room already consumed.
    //
    // pgQuery is autocommit-per-statement, so the transaction must come from
    // the postgres.js client itself (sql.begin). This bypasses pg.js's circuit
    // breaker for the duration of the transaction — acceptable: refunds are
    // low-rate and the breaker still guards every other call in this module.
    const result = await sql.begin(async (tx) => {
      const q = (text, params = []) => tx.unsafe(text, params);
      // Lock the ONE credit row for this leg (resolution is exactly-once, so at
      // most one exists). Its arm and day are what the void rolls up on.
      const credit = await q(
        `SELECT arm_key, value, day, currency FROM lb_split_credits
         WHERE kind = 'credit' AND session_id = $1 AND group_id = $2 AND charge_id = $3
         LIMIT 1
         FOR UPDATE`,
        [sid, gid, cid]
      );
      if (!credit.length) return 'no_credit';
      // Re-derive the cap AFTER acquiring the lock: room = value - already
      // voided. value is written once; voids only ever ADD negative deltas
      // under this same lock; so the sum of voids is bounded by value by
      // induction — now under concurrency as well as replay.
      const voided = await q(
        `SELECT COALESCE(-SUM(value), 0) AS total FROM lb_split_credits
         WHERE kind = 'void' AND session_id = $1 AND group_id = $2 AND charge_id = $3`,
        [sid, gid, cid]
      );
      const creditVal = safeAmount(credit[0].value);
      const already = safeAmount(voided[0].total);
      const room = Math.round((creditVal - already) * 100) / 100;
      const delta = Math.min(safeAmount(amount), Math.max(0, room));
      if (delta <= 0) return 'nothing_to_net';

      const voidDay = credit[0].day ? new Date(credit[0].day).toISOString().slice(0, 10) : null;
      const entryId = `void:${sid}|${gid}|u:${cid}|${String(refundKey).trim().slice(0, 80)}`;
      const rows = await q(
        `INSERT INTO lb_split_credits
           (entry_id, kind, session_id, group_id, arm_key, charge_id, value, credited, currency, day, refund_key)
         VALUES ($1, 'void', $2, $3, $4, $5, $6, TRUE, $7, COALESCE($8::date, (NOW() AT TIME ZONE 'UTC')::date), $9)
         ON CONFLICT (entry_id) DO NOTHING
         RETURNING id`,
        [entryId, sid, gid, String(credit[0].arm_key), cid, -delta,
          currency || credit[0].currency || 'USD', voidDay,
          String(refundKey).trim().slice(0, 80)]
      );
      return rows.length ? 'netted' : 'duplicate';
    });
    return result;
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
  { sessionId, chargeId, value, currency = 'USD', scope, park = true },
  { query = pgQuery } = {}
) {
  const sid = tid(sessionId);
  const cid = tid(chargeId, 160);
  if (!sid || !cid) return [];
  try {
    await ensureSplitTables(query);
    // Every test (of this scope) this session carries a denominator for. The
    // exposure rows ARE the server-side proof of which arm; crediting reads
    // them, so a settle hook needs no test id of its own.
    const params = [sid];
    let scopeClause = '';
    if (scope) { params.push(String(scope)); scopeClause = ` AND t.scope = $2`; }
    const tests = await query(
      `SELECT DISTINCT c.group_id FROM lb_split_credits c
       JOIN lb_split_tests t ON t.id = c.group_id
       WHERE c.kind = 'exposure' AND c.session_id = $1${scopeClause}`,
      params
    );
    if (!tests.length) {
      // No denominator YET. Either this session is simply not in any test
      // (the overwhelmingly common case — no-op), or the settle raced the
      // exposure beacon. Park ONLY when a live test of this scope exists, so
      // the pending table stays bounded to sessions that could plausibly still
      // resolve. The retry pass calls back with park:false so a genuine miss
      // cannot re-park itself forever.
      if (park) {
        const liveParams = [];
        let liveScope = '';
        if (scope) { liveParams.push(String(scope)); liveScope = ` AND scope = $1`; }
        const live = await query(
          `SELECT 1 FROM lb_split_tests WHERE enabled AND NOT archived${liveScope} LIMIT 1`,
          liveParams
        );
        if (live.length) {
          await recordPendingCredit(
            { sessionId: sid, chargeId: cid, value, currency, scope: scope || null }, { query }
          );
          return [{ testId: null, status: 'pending' }];
        }
      }
      return [];
    }
    const out = [];
    for (const row of tests) {
      const status = await creditConversion(
        { sessionId: sid, testId: row.group_id, chargeId: cid, value, currency }, { query }
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
  { query = pgQuery, sql = pgDb } = {}
) {
  const sid = tid(sessionId);
  const cid = tid(chargeId, 160);
  if (!sid || !cid) return [];
  try {
    await ensureSplitTables(query);
    const credits = await query(
      `SELECT DISTINCT group_id FROM lb_split_credits
       WHERE kind = 'credit' AND session_id = $1 AND charge_id = $2`,
      [sid, cid]
    );
    const out = [];
    for (const row of credits) {
      const status = await voidCredit(
        { sessionId: sid, testId: row.group_id, chargeId: cid, amount, refundKey, currency },
        { query, sql }
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
  // ALL arms, archived included (DECISION, documented): archiving an arm must
  // never silently drop its historical ledger rows from the results — the
  // money already moved. Archived arms are returned flagged `archived: true`
  // (a UI can collapse them) and their rows stay in per-arm figures AND
  // totals. Ledger arm_keys with no arm row at all (an arm hard-cleaned in a
  // migration) are synthesized the same way, so the ledger is always fully
  // accounted for.
  const arms = await query(
    `SELECT arm_key, weight, is_control, archived FROM lb_split_arms
     WHERE test_id = $1 ORDER BY archived, arm_key`,
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
  // Dedupe arm definitions per key, preferring the live one (the partial
  // unique index only guards non-archived keys, so an archived 'a' can coexist
  // with a live 'a' — their ledger rows are one bucket either way).
  const armDefs = new Map();
  for (const a of arms) {
    const existing = armDefs.get(a.arm_key);
    if (!existing || (existing.archived && !a.archived)) armDefs.set(a.arm_key, a);
  }
  // Ledger keys with no arm row at all still get an entry — flagged archived.
  for (const key of byArm.keys()) {
    if (!armDefs.has(key)) {
      armDefs.set(key, { arm_key: key, weight: null, is_control: false, archived: true });
    }
  }
  const result = [...armDefs.values()]
    .sort((x, y) => String(x.arm_key).localeCompare(String(y.arm_key)))
    .map((a) => {
      const r = byArm.get(a.arm_key) || {};
      const exposures = Number(r.exposures || 0);
      const conversions = Number(r.conversions || 0);
      return {
        arm_key: a.arm_key,
        weight: a.weight === null ? null : Number(a.weight),
        is_control: a.is_control,
        archived: Boolean(a.archived),
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
