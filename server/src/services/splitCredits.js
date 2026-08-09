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
import { computeSplitStatistics } from './splitStats.js';

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
 * SUFFICIENT STATISTICS for revenue per visitor, straight out of the ledger.
 *
 * Returns per arm `{ money_sessions, sum_x, sum_x2 }` where x is ONE SESSION's
 * NET value — every credit leg it carries, minus every void row against those
 * legs. Three decisions are load-bearing here:
 *
 *   • PER SESSION, NOT PER LEG. The unit of observation must be the unit of
 *     randomisation, and the ledger randomises SESSIONS onto arms. Summing legs
 *     would give a buyer with three upsells three observations, which
 *     understates the variance and manufactures confidence — the exact defect
 *     funnel-os documented on its incremental path (22% of its production
 *     buyers carry 2-5 legs). `readResults` already counts `conversions` as
 *     DISTINCT sessions for the same reason; these moments now match it.
 *   • NET, NOT GROSS. `kind IN ('credit','void')` so a refunded order stops
 *     counting as revenue AND stops inflating the variance. Σx therefore equals
 *     the `net_revenue` column up to float rounding — the mean and the variance
 *     come from ONE series, which is what makes the t statistic coherent.
 *   • NON-CONVERTERS ARE NOT HERE, AND THAT IS CORRECT. A visitor who bought
 *     nothing is a genuine 0 observation: it adds nothing to Σx or Σx² but it
 *     DOES enlarge n. The caller passes n = exposures, so `varianceFromSums`
 *     picks the zeros up from the denominator. Filtering them out of n instead
 *     would compare only buyers, i.e. AOV, not revenue per visitor.
 *
 * NUMERIC columns arrive from postgres.js as STRINGS. Coerced at the boundary
 * here rather than deep in the statistics, so a string can never reach an
 * arithmetic operator and silently concatenate.
 */
async function readArmMoments(testId, query) {
  const rows = await query(
    `WITH per_session AS (
       SELECT arm_key, session_id, SUM(value) AS net
       FROM lb_split_credits
       WHERE group_id = $1 AND kind IN ('credit', 'void')
       GROUP BY arm_key, session_id
     )
     SELECT arm_key,
            COUNT(*)::int                     AS money_sessions,
            COALESCE(SUM(net), 0)             AS sum_x,
            COALESCE(SUM(net * net), 0)       AS sum_x2
     FROM per_session
     GROUP BY arm_key`,
    [String(testId)]
  );
  return new Map(rows.map((r) => [r.arm_key, {
    money_sessions: Number(r.money_sessions || 0),
    sum_x: Number(r.sum_x || 0),
    sum_x2: Number(r.sum_x2 || 0),
  }]));
}

/**
 * EXPOSURES PER DAY — the rate that makes "time to decision" a real number.
 *
 * Without it `timeToDecisionDays` returns null on every call and the whole
 * feature is dead prose. The rate is derived from timestamps the ledger already
 * carries, so it costs one cheap aggregate and no new column.
 *
 * THE WINDOW IS first→last EXPOSURE, and the choice is deliberate:
 *
 *   • NOT first-exposure→NOW. A concluded or paused test would keep aging while
 *     taking no traffic, so its rate would decay toward zero and the estimate
 *     toward infinity — the panel would tell an operator a finished test needs
 *     another 400 days.
 *   • NOT a trailing 7 days. The exposure ledger is the only source here and a
 *     test younger than the window would divide by a span it never lived
 *     through, understating the rate and overstating the wait.
 *
 * The known bias, stated: a test that took traffic for two days and then went
 * quiet for eight still reports the two-day rate, because `last_at` stops
 * moving. That overstates the rate and UNDERSTATES the wait. It is the
 * optimistic direction, which is why the estimate is labelled "roughly" and why
 * `required_sample_per_arm` — a hard floor that does not depend on this rate —
 * is always shown beside it.
 *
 * A span shorter than a day is FLOORED at one day rather than extrapolated: 40
 * exposures in the first ten minutes of a test is not "5,760 per day", and
 * dividing by the true fraction would print exactly that.
 *
 * Returns null (never 0) when there is nothing to measure — an unknown rate must
 * read as unknown, and 0 would make every estimate infinite.
 */
async function readExposureRate(testId, query) {
  const rows = await query(
    `SELECT COUNT(*)::int AS n,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at
     FROM lb_split_credits
     WHERE group_id = $1 AND kind = 'exposure'`,
    [String(testId)]
  );
  const row = rows[0] || {};
  const n = Number(row.n || 0);
  if (!n || !row.first_at || !row.last_at) return null;
  const first = new Date(row.first_at).getTime();
  const last = new Date(row.last_at).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const spanDays = Math.max(1, (last - first) / 86400000);
  const rate = n / spanDays;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * PER-ARM OPT-IN SUBMITS — real numbers or an honest refusal, never a guess.
 *
 * `optin_leads` carries `page_id` and no session or arm, so the only available
 * attribution is "this lead was submitted on the page this arm serves". That is
 * a REAL join, and it is also a fragile one, so it is guarded three ways and
 * REFUSES rather than degrading to a plausible number:
 *
 *   • THE TABLE MAY NOT EXIST. A fresh install has no optin_leads, and a hard
 *     join would throw inside a read the results modal depends on. Presence is
 *     checked with to_regclass first — the same pattern funnelAnalytics already
 *     uses for lb_split_credits.
 *   • ARMS MUST HAVE DISTINCT PAGES. If two arms share a page_id, or any arm has
 *     none, a page-keyed count cannot be assigned to one arm — it would silently
 *     credit both. That returns `{ available: false, reason }` and the panel
 *     prints an em-dash with the reason, which is the truth.
 *   • THE WINDOW STARTS AT THE TEST'S FIRST EXPOSURE. A lander that existed
 *     before the test carries opt-ins that have nothing to do with it, and
 *     counting them would hand the older arm a lead made entirely of pre-test
 *     history — the exact bias the lifetime/experiment split exists to expose.
 *
 * Never throws: every failure path returns `available: false` with a reason.
 */
async function readArmSubmits(testId, query) {
  try {
    const [reg] = await query(`SELECT to_regclass('public.optin_leads') IS NOT NULL AS present`);
    if (!reg?.present) return { available: false, reason: 'optin_leads_absent', by_arm: {} };

    const arms = await query(
      `SELECT arm_key, page_id FROM lb_split_arms WHERE test_id = $1`,
      [String(testId)]
    );
    if (!arms.length) return { available: false, reason: 'no_arms', by_arm: {} };
    if (arms.some((a) => !a.page_id)) {
      return { available: false, reason: 'arm_without_page', by_arm: {} };
    }
    const pageIds = arms.map((a) => String(a.page_id));
    if (new Set(pageIds).size !== pageIds.length) {
      // Two arms on one page: a page-keyed count cannot be split between them.
      return { available: false, reason: 'arms_share_a_page', by_arm: {} };
    }

    const [span] = await query(
      `SELECT MIN(created_at) AS first_at FROM lb_split_credits
       WHERE group_id = $1 AND kind = 'exposure'`,
      [String(testId)]
    );
    if (!span?.first_at) return { available: false, reason: 'no_exposures_yet', by_arm: {} };

    const rows = await query(
      `SELECT page_id, COUNT(*)::int AS submits
       FROM optin_leads
       WHERE page_id = ANY($1) AND created_at >= $2
       GROUP BY page_id`,
      [pageIds, span.first_at]
    );
    const byPage = new Map(rows.map((r) => [String(r.page_id), Number(r.submits || 0)]));
    const byArm = {};
    for (const a of arms) byArm[a.arm_key] = byPage.get(String(a.page_id)) || 0;
    return { available: true, reason: null, since: span.first_at, by_arm: byArm };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitCredits] readArmSubmits failed:', err.message);
    return { available: false, reason: 'read_failed', by_arm: {} };
  }
}

/**
 * THE DAY-BY-DAY SERIES — net revenue per exposure, per arm, per day.
 *
 * WHY A SHAPE AND NOT JUST A TOTAL. A single revenue-per-exposure figure cannot
 * distinguish an arm that led steadily for eight days from one that spiked on a
 * single day and trailed for the other seven. Those are the same average and
 * completely different evidence: the second is usually one large order, and an
 * operator who ships it is shipping a coincidence. The totals above cannot show
 * that; this can.
 *
 * THE DAY IS THE EXPOSURE ROW'S DAY, on both sides. `creditConversion` rolls a
 * credit up on the day cell that carries its exposure (so a leg settling after
 * midnight lands with the visit that earned it), which is what makes the
 * numerator and denominator here describe the same cohort. A calendar join on
 * the credit's own date would drift them apart by exactly the orders that
 * settled overnight.
 *
 * FULL OUTER JOIN, deliberately: a day with exposures and no money is a real
 * data point (it is what a dead arm looks like), and a day with money whose
 * exposure landed earlier must not silently vanish either.
 *
 * Returns newest-first, which is the order the panel reads in.
 */
async function readDailySeries(testId, query) {
  const rows = await query(
    `WITH per_session AS (
       SELECT arm_key, day, session_id, SUM(value) AS net
       FROM lb_split_credits
       WHERE group_id = $1 AND kind IN ('credit', 'void')
       GROUP BY arm_key, day, session_id
     ),
     money AS (
       SELECT arm_key, day,
              COUNT(*)::int          AS orders,
              COALESCE(SUM(net), 0)  AS net_revenue
       FROM per_session
       GROUP BY arm_key, day
     ),
     exposures AS (
       SELECT arm_key, day, COUNT(*)::int AS exposures
       FROM lb_split_credits
       WHERE group_id = $1 AND kind = 'exposure'
       GROUP BY arm_key, day
     )
     SELECT COALESCE(e.day, m.day)         AS day,
            COALESCE(e.arm_key, m.arm_key) AS arm_key,
            COALESCE(e.exposures, 0)       AS exposures,
            COALESCE(m.orders, 0)          AS orders,
            COALESCE(m.net_revenue, 0)     AS net_revenue
     FROM exposures e
     FULL OUTER JOIN money m ON m.arm_key = e.arm_key AND m.day = e.day
     ORDER BY 1 DESC, 2 ASC`,
    [String(testId)]
  );

  const byDay = new Map();
  for (const r of rows) {
    const day = r.day ? new Date(r.day).toISOString().slice(0, 10) : null;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, { day, arms: {} });
    const exposures = Number(r.exposures || 0);
    const net = Number(r.net_revenue || 0);
    byDay.get(day).arms[r.arm_key] = {
      exposures,
      orders: Number(r.orders || 0),
      net_revenue: Math.round(net * 100) / 100,
      // NOT withheld below the statistics floor, and that is a considered
      // exception rather than an oversight: a daily cell is a SHAPE reading, not
      // a verdict input, and its denominator is printed directly beside it. The
      // floor exists to stop a rate being read as precision when the sample is
      // invisible — here the sample is the next thing on the line. Nothing in
      // the verdict reads this series.
      rev_per_exposure: exposures > 0 ? Math.round((net / exposures) * 10000) / 10000 : null,
    };
  }
  return [...byDay.values()];
}

/**
 * DERIVED results per arm — exposures vs credited conversions, netted against
 * refunds. Counters are computed from the ledger, never stored. Both sides of
 * the take rate are SESSIONS (funnel-os invariant: accepts<=offers holds only
 * because both count sessions), so `conversions` counts DISTINCT converting
 * sessions, not money legs — while revenue SUMS every leg.
 *
 * ── THE STATISTICS BLOCK IS PURELY ADDITIVE ────────────────────────────────
 *
 * Every key this function returned before — `arm_key, weight, is_control,
 * archived, visitors, exposures, conversions, credited_legs, gross_revenue,
 * refunded, net_revenue, take_rate` and the whole `totals` object — is
 * UNCHANGED, in value and in type. Two things are ADDED and nothing is moved:
 *
 *   • `arms[i].stats` — per-arm significance, readiness and incremental lift;
 *   • `verdict` — the test-level verdict block, plus `floors` and `method`.
 *
 * The harness (server/tests/split/statistics.mjs) pins this by asserting the
 * pre-change key set is a strict subset of the post-change one with identical
 * values, because the canvas tile reader (FunnelCanvasPage's lifetime fallback)
 * consumes the raw counts and must not notice this change at all.
 *
 * THE DENOMINATOR IS `exposures`, NOT `visitors`, AND THE CHOICE IS FORCED.
 * `visitors` counts delivered page renders (lb_split_views); `exposures` counts
 * the checkout-attributable sessions the money moments are summed over. Mixing
 * them would put a mean over one population and a variance over another, and
 * the t statistic would be describing neither. `visitors` is still reported
 * untouched — it is a real number, just not this test's denominator.
 *
 * ARCHIVED ARMS STAY IN THE PAYLOAD, AND THE STATISTICS SCOPE THEMSELVES.
 * Excluding an archived arm's rows would make the same ledger score differently
 * before and after an operator retires a loser — a verdict that moves when
 * nothing about the money moved. So every arm is still returned and still
 * carries a stats block.
 *
 * What CHANGED after review: an archived (or brand-new) arm below the statistics
 * floor no longer poisons the whole test. `computeSplitStatistics` scopes the
 * comparison to arms at or above `MIN_STATS_SAMPLE` exposures and reports the
 * rest in `verdict.pending_arms`. Before that fix, a zero-traffic archived arm —
 * which this function returns on essentially every concluded test — nulled every
 * figure on a test with tens of thousands of exposures.
 *
 * @param {{testId: string}} args
 * @param {{query?: Function, withStats?: boolean}} [deps] — `withStats: false`
 *   returns the raw counts ONLY and skips both extra reads and the verdict. Used
 *   by funnelAnalytics, which calls this for ledger RECONCILIATION on its own
 *   windowed request and never reads the lifetime verdict; computing one there
 *   made every windowed page-load pay for a second moments query and a second
 *   verdict nothing rendered.
 * @returns {Promise<{testId, arms: Array, totals: object, verdict?: object,
 *                    floors?: object, method?: object}>}
 */
export async function readResults({ testId }, { query = pgQuery, withStats = true } = {}) {
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
  // Delivery views — the page-scope "Visitors" denominator (lb_split_views,
  // one row per test+visitor, written on the delivered render). Zero for
  // offer-scope tests and for tests created before delivery wiring; exposures
  // remain the MONEY denominator either way.
  const views = await query(
    `SELECT arm_key, COUNT(*)::int AS visitors
     FROM lb_split_views WHERE test_id = $1 GROUP BY arm_key`,
    [String(testId)]
  );
  // Sufficient statistics for the Welch t on revenue per visitor. A FOURTH
  // read, in the same failure domain as the three above: if the ledger is
  // unreachable they all throw together and the route answers 500, exactly as
  // it did before this block existed. Deliberately NOT wrapped in a try that
  // would degrade the stats to zeros — a zeroed moment is not "no statistics",
  // it is a variance of 0, which reads as a perfectly consistent arm and is the
  // one input that can manufacture false confidence.
  const momentsByArm = withStats ? await readArmMoments(testId, query) : new Map();
  const viewsByArm = new Map(views.map((r) => [r.arm_key, Number(r.visitors || 0)]));
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
        visitors: viewsByArm.get(a.arm_key) || 0,
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
      visitors: t.visitors + a.visitors,
      exposures: t.exposures + a.exposures,
      conversions: t.conversions + a.conversions,
      credited_legs: t.credited_legs + a.credited_legs,
      gross_revenue: Math.round((t.gross_revenue + a.gross_revenue) * 100) / 100,
      refunded: Math.round((t.refunded + a.refunded) * 100) / 100,
      net_revenue: Math.round((t.net_revenue + a.net_revenue) * 100) / 100,
    }),
    { visitors: 0, exposures: 0, conversions: 0, credited_legs: 0, gross_revenue: 0, refunded: 0, net_revenue: 0 }
  );

  // The RAW payload — byte-identical to what this function returned before the
  // statistics landed, and what `withStats: false` callers get.
  if (!withStats) return { testId: String(testId), arms: result, totals };

  // ── ADDITIVE STATISTICS ──────────────────────────────────────────────────
  // computeSplitStatistics is PURE and total — the harness pins that no input
  // (empty, one arm, zero variance, corrupt sums) makes it throw or emit
  // NaN/Infinity — so there is nothing here to catch and nothing to default.
  //
  // The exposure RATE is read here rather than inside the statistics, which
  // have no clock and no database by construction.
  const exposuresPerDay = await readExposureRate(testId, query);
  const daily = await readDailySeries(testId, query);
  const submits = await readArmSubmits(testId, query);
  const stats = computeSplitStatistics(
    result.map((a) => {
      const m = momentsByArm.get(a.arm_key) || { sum_x: 0, sum_x2: 0 };
      return {
        arm_key: a.arm_key,
        is_control: a.is_control,
        // `exposures`, not `visitors` — the ledger's attributable checkout
        // sessions, which is the population the moments below are summed over.
        // `visitors` (lb_split_views, delivered renders) is a different number
        // and is deliberately NOT this denominator.
        exposures: a.exposures,
        conversions: a.conversions,
        // Σx from the MOMENTS, not from the net_revenue column. They agree to
        // float rounding, but the t statistic must take its mean and its
        // variance from one series or it is describing a distribution that
        // does not exist.
        net_revenue: m.sum_x,
        net_revenue_sum_squares: m.sum_x2,
      };
    }),
    { exposuresPerDay }
  );

  // Attached per arm rather than returned as a parallel map, so a renderer that
  // walks `arms` cannot get the two out of step.
  for (const a of result) {
    const m = momentsByArm.get(a.arm_key) || { money_sessions: 0, sum_x: 0, sum_x2: 0 };
    a.stats = {
      ...(stats.arms[a.arm_key] || {}),
      // The raw moments travel with the block so the verdict is reproducible
      // from the response alone — an operator (or a reviewer) can recompute
      // every p-value on this page without a database.
      money_sessions: m.money_sessions,
      net_revenue_sum: Math.round(m.sum_x * 100) / 100,
      net_revenue_sum_squares: m.sum_x2,
    };
  }

  return {
    testId: String(testId),
    arms: result,
    totals,
    verdict: stats.verdict,
    floors: stats.floors,
    method: stats.method,
    // Reported so the "roughly N more days" figure on the panel is checkable
    // rather than magic. Null when the ledger had nothing to measure.
    exposures_per_day: exposuresPerDay === null ? null : Math.round(exposuresPerDay * 100) / 100,
    // Newest-first per-day shape. Never read by the verdict — it exists so an
    // operator can see whether a lead was steady or a single day's spike.
    daily,
    // Real per-arm opt-in counts, or `available: false` with the reason why not.
    // Never a fabricated number and never a silent zero.
    submits,
  };
}
