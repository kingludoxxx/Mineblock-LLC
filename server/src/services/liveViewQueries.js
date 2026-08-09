// Live View — read layer (SELF-CONTAINED, NEW FILE).
//
// Port of funnel-os's Live View board (backend/app/services/live_view_metrics.py
// + live_view_ingest.py) onto Puure's Postgres spine. Read-only, always.
//
// DATA SOURCES (all owned elsewhere — NO DDL here):
//   lb_touches   (trackingSchema.js)  — one row per delivered pageview beacon
//   co_events    (checkoutSchema.js)  — session trail: 'session_created',
//                                       'paid', 'upsell_settled', …
//   co_sessions  (checkoutSchema.js)  — funnel/value context for co_events
//   funnels / funnel_pages            — names for the feed rows
//
// DEFINITION OF "LIVE" — reused VERBATIM from the canvas live chip
// (funnelAnalytics.getFunnelLive): distinct lb_touches.vid in the last
// 5 minutes. "Unique today" = distinct vid since UTC midnight. The Live View
// page and the canvas chip must never disagree about what "live" means.
//
// GEO — HONESTY RULE. funnel-os geolocates via Cloudflare edge headers
// (cf-ipcountry/cf-iplatitude/…) captured at ingest. Puure's tracking runtime
// stores a SALTED IP HASH ONLY (trackingSchema.js: "Raw IP is NEVER stored")
// and captures no geo header anywhere (lb_clicks.country exists as a column
// but no code path populates it — recordClick is always called without it).
// There is therefore NO geo source, and this module says so explicitly in the
// payload (`geo: {available:false}`) instead of fabricating locations. The
// reference's globe/city cards are intentionally NOT ported.
//
// MONEY predicate for revenue_today mirrors ANALYTICS_METRIC_DEFINITIONS:
// paid_at IS NOT NULL AND status IN ('paid','refunded') — money that moved.
import { analyticsQuery } from './analyticsDb.js';

// Feed event types (the wire contract with client/src/pages/live/**):
//   view           — lb_touches row (a delivered pageview)
//   checkout_start — co_events kind 'session_created'
//   purchase       — co_events kind 'paid' (base) or 'upsell_settled' (upsell)
export const LIVE_EVENT_KINDS = Object.freeze([
  'session_created',
  'paid',
  'upsell_settled',
]);

export const LIVE_WINDOW_MINUTES = 5;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 200;

// UTC midnight expression — identical to getFunnelLive's, so "today" is the
// same day everywhere.
const UTC_MIDNIGHT = `date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;

const int = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

async function safeRead(label, warnings, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    warnings.push({ source: label, reason: String(err?.message || err).slice(0, 200) });
    return fallback;
  }
}

const iso = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

// ── Row → feed-event mapping (shared by snapshot AND the stream delta) ──────
export function mapTouchRow(r) {
  return {
    id: `t_${r.id}`,
    type: 'view',
    ts: iso(r.ts),
    funnel_id: r.funnel_id || null,
    funnel_name: r.funnel_name || null,
    page_id: r.page_id || null,
    page_title: r.page_title || null,
    page_slug: r.page_slug || null,
    value: null,
    currency: null,
    upsell: false,
  };
}

export function mapCoEventRow(r) {
  const kind = String(r.kind || '');
  const upsell = kind === 'upsell_settled';
  let value = null;
  if (kind === 'paid' || kind === 'session_created') {
    value = r.total == null ? null : money(r.total);
  } else if (upsell) {
    // upsell_settled's session total is the BASE order — the charge amount
    // rides in the event data. No amount recorded ⇒ null, never 0 (0 means
    // "free", null means "unknown").
    const amt = r.data && typeof r.data === 'object' ? Number(r.data.amount) : NaN;
    value = Number.isFinite(amt) ? money(amt) : null;
  }
  return {
    id: `c_${r.id}`,
    type: kind === 'session_created' ? 'checkout_start' : 'purchase',
    ts: iso(r.created_at),
    funnel_id: r.funnel_id || null,
    funnel_name: r.funnel_name || null,
    page_id: r.page_id || null,
    page_title: null,
    page_slug: null,
    value,
    currency: r.currency || null,
    upsell,
  };
}

const TOUCH_EVENTS_SQL = `
  SELECT t.id, t.funnel_id, t.page_id, t.ts,
         f.name AS funnel_name, p.title AS page_title, p.slug AS page_slug
  FROM lb_touches t
  LEFT JOIN funnels f ON f.id = t.funnel_id
  LEFT JOIN funnel_pages p ON p.id = t.page_id`;

const CO_EVENTS_SQL = `
  SELECT e.id, e.kind, e.created_at, e.data,
         s.funnel_id, s.page_id, s.total, s.currency,
         f.name AS funnel_name
  FROM co_events e
  LEFT JOIN co_sessions s ON s.id = e.session_id
  LEFT JOIN funnels f ON f.id = s.funnel_id
  WHERE e.kind = ANY($1)`;

/**
 * The initial-state payload (GET /api/v1/live/snapshot) and the per-tick
 * "snapshot" SSE frame. Every source is its own failure domain (safeRead):
 * a broken table degrades to a named warning + nulls, never a dead board.
 */
export async function buildLiveSnapshot({ query = analyticsQuery, limit = DEFAULT_EVENT_LIMIT } = {}) {
  const warnings = [];
  const lim = Math.min(Math.max(int(limit) || DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);

  // Totals — distinct-vid counts, NOT sums of the per-funnel rows (a vid that
  // touched two funnels counts once here, once per funnel below).
  const totals = await safeRead('lb_touches', warnings, async () => {
    const [r] = await query(
      `SELECT
         (SELECT COUNT(DISTINCT vid) FROM lb_touches
          WHERE ts >= NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes')::bigint AS live_total,
         (SELECT COUNT(DISTINCT vid) FROM lb_touches
          WHERE ts >= ${UTC_MIDNIGHT})::bigint AS unique_today_total`
    );
    return r;
  }, null);

  // Per-funnel breakdown. The scan floor is LEAST(midnight, now-5min) so a
  // just-after-midnight live visitor whose touch landed at 23:59 UTC still
  // counts as live (the live window can straddle the day boundary).
  const byFunnel = await safeRead('lb_touches_by_funnel', warnings, async () => {
    const rows = await query(
      `SELECT t.funnel_id, MAX(f.name) AS name, MAX(f.slug) AS slug,
              COUNT(DISTINCT t.vid) FILTER (
                WHERE t.ts >= NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes'
              )::bigint AS live,
              COUNT(DISTINCT t.vid) FILTER (
                WHERE t.ts >= ${UTC_MIDNIGHT}
              )::bigint AS unique_today
       FROM lb_touches t
       LEFT JOIN funnels f ON f.id = t.funnel_id
       WHERE t.ts >= LEAST(${UTC_MIDNIGHT}, NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes')
       GROUP BY t.funnel_id
       ORDER BY live DESC, unique_today DESC
       LIMIT 50`
    );
    return rows.map((r) => ({
      funnel_id: r.funnel_id || null,
      name: r.name || null,
      slug: r.slug || null,
      live: int(r.live),
      unique_today: int(r.unique_today),
    }));
  }, null);

  // Today's checkout activity + money moved (tiles).
  const checkout = await safeRead('co_events_today', warnings, async () => {
    const [r] = await query(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'session_created')::bigint AS checkout_starts_today,
         COUNT(*) FILTER (WHERE kind IN ('paid','upsell_settled'))::bigint AS purchases_today
       FROM co_events WHERE created_at >= ${UTC_MIDNIGHT}`
    );
    return r;
  }, null);

  const revenue = await safeRead('co_sessions_revenue', warnings, async () => {
    const [r] = await query(
      `SELECT COALESCE(SUM(total), 0) AS revenue_today
       FROM co_sessions
       WHERE paid_at IS NOT NULL AND status IN ('paid','refunded')
         AND paid_at >= ${UTC_MIDNIGHT}`
    );
    return r;
  }, null);

  // Recent events — the two sources drawn independently at the full limit,
  // merged, sorted by ts desc, cut to the limit.
  const touchEvents = await safeRead('lb_touches_feed', warnings, async () => {
    const rows = await query(`${TOUCH_EVENTS_SQL} ORDER BY t.id DESC LIMIT $1`, [lim]);
    return rows.map(mapTouchRow);
  }, []);

  const coEvents = await safeRead('co_events_feed', warnings, async () => {
    const rows = await query(
      `${CO_EVENTS_SQL} ORDER BY e.id DESC LIMIT $2`,
      [LIVE_EVENT_KINDS, lim]
    );
    return rows.map(mapCoEventRow);
  }, []);

  const events = [...touchEvents, ...coEvents]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, lim);

  return {
    as_of: new Date().toISOString(),
    live_total: totals ? int(totals.live_total) : null,
    unique_today_total: totals ? int(totals.unique_today_total) : null,
    checkout_starts_today: checkout ? int(checkout.checkout_starts_today) : null,
    purchases_today: checkout ? int(checkout.purchases_today) : null,
    revenue_today: revenue ? money(revenue.revenue_today) : null,
    by_funnel: byFunnel || [],
    events,
    // The honest replacement for the reference's globe. Never fabricate.
    geo: {
      available: false,
      reason: 'no geo source: tracking stores salted IP hashes only and no edge geo headers are captured',
    },
    basis: {
      live: `distinct lb_touches.vid, last ${LIVE_WINDOW_MINUTES} minutes`,
      unique_today: 'distinct lb_touches.vid since UTC midnight',
      revenue_today: "SUM(co_sessions.total) where paid_at >= UTC midnight and status in ('paid','refunded')",
      events: 'lb_touches (views) + co_events (session_created/paid/upsell_settled)',
    },
    warnings,
    degraded: warnings.length > 0,
  };
}

/**
 * Current high-water marks for the two feed sources. Seeded ONCE when the
 * poller starts so history is never replayed as live pushes (same rule as the
 * reference hub's order-watermark seeding). A read failure THROWS — the caller
 * must know the seed failed rather than silently start from 0 and replay
 * everything.
 */
export async function readWatermarks({ query = analyticsQuery } = {}) {
  const [t] = await query(`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM lb_touches`);
  const [c] = await query(`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM co_events`);
  return { touchId: Number(t.max_id) || 0, coEventId: Number(c.max_id) || 0 };
}

/**
 * Delta draw: every feed row NEWER than the watermarks (id-ordered — BIGSERIAL
 * ids are assigned monotonically by the single writer path, and unlike ts they
 * cannot collide). Returns the mapped events (ascending, oldest first — the
 * client prepends in order) plus the advanced watermarks.
 */
export async function readNewEvents({ query = analyticsQuery, touchId = 0, coEventId = 0, limit = 100 } = {}) {
  const lim = Math.min(Math.max(int(limit) || 100, 1), MAX_EVENT_LIMIT);

  const touchRows = await query(
    `${TOUCH_EVENTS_SQL} WHERE t.id > $1 ORDER BY t.id ASC LIMIT $2`,
    [touchId, lim]
  );
  const coRows = await query(
    `${CO_EVENTS_SQL} AND e.id > $2 ORDER BY e.id ASC LIMIT $3`,
    [LIVE_EVENT_KINDS, coEventId, lim]
  );

  let nextTouchId = touchId;
  for (const r of touchRows) nextTouchId = Math.max(nextTouchId, Number(r.id) || 0);
  let nextCoEventId = coEventId;
  for (const r of coRows) nextCoEventId = Math.max(nextCoEventId, Number(r.id) || 0);

  const events = [
    ...touchRows.map(mapTouchRow),
    ...coRows.map(mapCoEventRow),
  ].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  return { events, touchId: nextTouchId, coEventId: nextCoEventId };
}
