// Tracking maintenance cron — the PG-side replacement for Mongo TTL, plus the
// postback-queue drain. Started on module load (same pattern as moneySweeps),
// guarded so the test harness can drive the functions directly without a
// background timer racing its assertions (TRACKING_SWEEPS_DISABLED=1).
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';
import { runDelivery } from './trackingDelivery.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;   // hourly TTL prune
const DELIVERY_INTERVAL_MS = 15 * 60 * 1000; // ~15 min drain (matches reference)

// lb_tracking_events retention. trackingSchema calls this table "the capped
// debug feed", but nothing was enforcing a cap: funnel-os capped it by ROW
// COUNT per funnel (_LOG_CAP), which the Postgres port never carried over, so
// the table grew without bound and every windowed aggregate over it got slower
// forever.
//
// 180 days is deliberately GENEROUS rather than tight. services/orderJourney.js
// (:295) reads this table by event_id with NO time bound at all, to reconstruct
// the conversion trail for a single order — chargeback and dispute windows run
// to ~120 days, so a 30d or 90d prune would quietly destroy the evidence an
// operator needs most. 180d bounds the table while staying well clear of that,
// and well clear of this surface's own longest window (30d).
const EVENTS_RETENTION_DAYS = 180;

// The prune MUST be batched. The first version was a single unbounded
// `DELETE ... WHERE ts < NOW() - INTERVAL '180 days'`, which on a real table
// fails in a way that never self-heals:
//   1. No index served a bare `ts` predicate — only (funnel_id, ts DESC)
//      existed, so the planner chose a Seq Scan (EXPLAIN-confirmed).
//   2. pgQuery's timeout is a Promise.race (db/pg.js:73) — it rejects the JS
//      promise but does NOT cancel the server-side statement. So the call
//      "times out" at 8s while the DELETE keeps running.
//   3. The statement then hits the pool's statement_timeout (db/pg.js:22,
//      15s), aborts, and ROLLS BACK — deleting nothing.
//   4. The hourly sweep repeats that 15s of lock-burning work forever, and the
//      only symptom is one warn line an hour.
// Batching bounds each statement's work, the (ts) index below makes the
// subselect cheap, and the raised per-batch timeout stops step 2 from firing
// before the statement legitimately finishes.
const EVENTS_PRUNE_BATCH = 5000;          // rows per DELETE statement
const EVENTS_PRUNE_MAX_PER_TICK = 50_000; // ceiling per sweep tick — the rest waits for the next tick
const EVENTS_PRUNE_TIMEOUT_MS = 60_000;   // per-batch; must exceed pgQuery's 8s default

// A bare-`ts` index so the batch subselect is an index range, not a Seq Scan.
// Same non-fatal CONCURRENTLY recipe as routes/funnelTrackingExtras.js — an
// index is an optimization, never correctness, and CONCURRENTLY must not run
// inside a transaction (pgQuery issues statements outside one, so that holds).
// Retried on the next tick if it fails, since the flag only latches on success.
let eventsTsIndexReady = false;
async function ensureEventsTsIndex() {
  if (eventsTsIndexReady) return;
  try {
    await pgQuery(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lb_tracking_events_ts ON lb_tracking_events (ts)`,
      [],
      { timeout: EVENTS_PRUNE_TIMEOUT_MS }
    );
    eventsTsIndexReady = true;
  } catch (err) {
    console.warn('[tracking] idx_lb_tracking_events_ts build skipped (non-fatal):', err.message);
  }
}

// Delete aged rows in bounded batches. Returns the number actually deleted.
// Stops on a short batch (drained) or at the per-tick ceiling, so one sweep can
// never turn into an unbounded delete — the remainder is picked up next hour.
export async function pruneTrackingEvents() {
  await ensureEventsTsIndex();
  let deleted = 0;
  while (deleted < EVENTS_PRUNE_MAX_PER_TICK) {
    // Interpolated, not parameterised: Postgres rejects a bind parameter inside
    // an INTERVAL literal, and every value here is a module constant — never
    // request input.
    //
    // `ORDER BY id` stays, and the choice is MEASURED, not assumed
    // (EXPLAIN ANALYZE, 20k aged rows, scratch PG — see extras-e2e.mjs E21):
    //   populated, ORDER BY id : Index Scan on the PK,  317 buffers
    //   populated, no ORDER BY : SEQ SCAN,             1197 buffers  ← worse
    //   drained,   ORDER BY id : Index Scan on idx_lb_tracking_events_ts
    //                            (Index Cond) + Sort,   221 buffers
    //   drained,   no ORDER BY : Index Scan on idx_..._ts,  60 buffers
    // Dropping the ORDER BY to "let the ts index do the work" would actually
    // hand the populated case a Seq Scan — ts correlates with the BIGSERIAL id,
    // so walking the PK ascending finds the oldest rows immediately. The ts
    // index still earns its keep: it carries the DRAINED case, which is what
    // the hourly sweep runs in steady state.
    const batch = await pgQuery(
      `DELETE FROM lb_tracking_events
       WHERE id IN (
         SELECT id FROM lb_tracking_events
         WHERE ts < NOW() - INTERVAL '${EVENTS_RETENTION_DAYS} days'
         ORDER BY id
         LIMIT ${EVENTS_PRUNE_BATCH}
       )`,
      [],
      { timeout: EVENTS_PRUNE_TIMEOUT_MS }
    );
    const n = batch.count ?? 0;
    deleted += n;
    if (n < EVENTS_PRUNE_BATCH) break; // drained
  }
  return deleted;
}

// Delete rows past their expires_at. lb_visitor_firstseen is deliberately NOT
// pruned (DECISIONS #9). Never throws — a maintenance failure is non-fatal.
export async function pruneExpired() {
  try {
    await ensureTrackingTables();
    const t = await pgQuery(`DELETE FROM lb_touches WHERE expires_at < NOW()`);
    const c = await pgQuery(`DELETE FROM lb_clicks WHERE expires_at < NOW()`);
    // Trim done/dead queue rows older than 30d so the queue stays bounded.
    await pgQuery(`DELETE FROM lb_postback_queue WHERE status IN ('done','dead') AND created_at < NOW() - INTERVAL '30 days'`);
    // Enforce the "capped feed" the schema promises (see EVENTS_RETENTION_DAYS).
    const events = await pruneTrackingEvents();
    return { touches: t.count ?? 0, clicks: c.count ?? 0, events };
  } catch (err) {
    console.error('[tracking] pruneExpired failed (non-fatal):', err.message);
    // Same KEYS as the success path (review N2): a caller destructuring
    // `events` off the failure result must get 0, not undefined.
    return { touches: 0, clicks: 0, events: 0 };
  }
}

let started = false;
export function startTrackingSweeps() {
  if (started) return;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRACKING_SWEEPS_DISABLED || '').toLowerCase())) {
    return; // test isolation — the harness calls pruneExpired/runDelivery itself
  }
  started = true;
  const prune = setInterval(() => { pruneExpired().catch(() => {}); }, PRUNE_INTERVAL_MS);
  const drain = setInterval(() => { runDelivery().catch(() => {}); }, DELIVERY_INTERVAL_MS);
  if (prune.unref) prune.unref();
  if (drain.unref) drain.unref();
}

export default { startTrackingSweeps, pruneExpired, pruneTrackingEvents };
