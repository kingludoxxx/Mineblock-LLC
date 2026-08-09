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
    // Interpolated, not parameterised: Postgres will not accept a bind
    // parameter inside an INTERVAL literal, and the value is a module constant
    // — never request input.
    const e = await pgQuery(
      `DELETE FROM lb_tracking_events WHERE ts < NOW() - INTERVAL '${EVENTS_RETENTION_DAYS} days'`
    );
    return { touches: t.count ?? 0, clicks: c.count ?? 0, events: e.count ?? 0 };
  } catch (err) {
    console.error('[tracking] pruneExpired failed (non-fatal):', err.message);
    return { touches: 0, clicks: 0 };
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

export default { startTrackingSweeps, pruneExpired };
