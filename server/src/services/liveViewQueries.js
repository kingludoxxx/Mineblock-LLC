// Live View — read layer (SELF-CONTAINED, NEW FILE).
//
// Port of funnel-os's Live View board (backend/app/services/live_view_metrics.py
// + live_view_ingest.py) onto Puure's Postgres spine. Read-only, always.
//
// DATA SOURCES (all owned elsewhere — NO DDL here):
//   lb_touches   (trackingSchema.js)  — one row per delivered pageview beacon
//   co_events    (checkoutSchema.js)  — session trail: 'session_created',
//                                       'paid', 'upsell_settled', …
//   co_sessions / co_upsell_charges   — funnel/value context + settled upsells
//   funnels / funnel_pages            — names for the feed rows
//
// DEFINITION OF "LIVE" — reused VERBATIM from the canvas live chip
// (funnelAnalytics.getFunnelLive): distinct lb_touches.vid in the last
// 5 minutes. "Unique today" = distinct vid since UTC midnight. The Live View
// page and the canvas chip must never disagree about what "live" means.
//
// QUERY COST (review H1) — this module runs every poll tick on a shared
// 256MB PG instance, so:
//   • The all-funnel time scans ride idx_lb_touches_ts (trackingSchema.js) and
//     idx_co_events_kind_created (checkoutSchema.js) — the pre-existing
//     (funnel_id, ts) / (session_id, created_at) indexes cannot serve a scan
//     with no funnel/session filter. The harness EXPLAIN-asserts both.
//   • live_total / unique_today_total / by_funnel come from ONE GROUPING SETS
//     pass over lb_touches (not two scans). The () grouping-set row IS the
//     grand total — a real COUNT(DISTINCT) across all funnels, never a sum of
//     per-funnel rows (a vid touching two funnels must count once).
//   • The today tiles (checkout starts / purchases / revenue) are cached for
//     TILES_TTL_MS (15s) — they do not need 3s freshness. Failed reads are
//     NOT cached, so a degraded tick heals on the very next one.
//   • Every co_events read filters kind = ANY(LIVE_EVENT_KINDS) so the
//     (kind, created_at) index is applicable; co_events has no TTL and grows
//     unboundedly, so an unindexed scan there is forbidden.
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
// MONEY (review M3) — revenue_today mirrors the analytics page definition
// (ANALYTICS_METRIC_DEFINITIONS.revenue): SUM(co_sessions.total) over
// money-moved sessions (paid_at IS NOT NULL AND status IN ('paid','refunded'))
// PLUS settled upsell dollars — SUM(co_upsell_charges.amount) at status IN
// ('settled','refunded'), the same gross basis funnelAnalytics.js uses
// (a later-refunded leg still moved money today). Upsell legs are windowed on
// created_at (charge creation ≈ settlement moment for one-click upsells).
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

// Review M2 — BIGSERIAL ids become VISIBLE out of order: MAX(id) sees only
// committed rows, so a transaction that took id N but commits after a later
// id N+1 was observed would sit below the watermark forever. The delta draw
// therefore OVERLAPS the last K ids; the hub suppresses re-emits with its
// emitted-id set (and the client dedupes by id as a second belt). A commit
// arriving more than K ids behind the head is beyond this guard — K=50 ids
// of slack at a 3s poll is far past any real settle transaction.
export const WATERMARK_OVERLAP_IDS = 50;

// Today-tiles cache TTL (review H1b). Env-overridable for the harness.
const TILES_TTL_MS = (() => {
  const n = Math.floor(Number(process.env.LIVE_VIEW_TILES_TTL_MS));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300_000) : 15_000;
})();

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

// Shape the geo card from the raw geo read. THREE distinct states, never
// collapsed: the read FAILED (null), the read succeeded but nothing is
// captured yet (available:false + a reason that says WHY), or there are codes
// (available:true + rows + coverage). Zero countries is not an error, and an
// error is not zero countries.
function geoCard(geo) {
  if (!geo) {
    return {
      available: false,
      reason: 'country breakdown could not be read this tick (see warnings)',
      by_country: [],
      coverage: null,
    };
  }
  const coverage = {
    resolved_visitors: geo.resolved,
    total_visitors: geo.total,
    // Tri-state, per the honesty rule: no visitors at all ⇒ null, never 0%.
    resolved_pct: geo.total > 0 ? Math.round((geo.resolved / geo.total) * 1000) / 10 : null,
  };
  if (!geo.byCountry.length) {
    return {
      available: false,
      reason: geo.total > 0
        ? 'no country resolved for today\'s visitors yet — country is captured at write time only'
          + ' (touches written before capture landed stay NULL and are never guessed), and the IPv4'
          + ' lookup table cannot resolve an IPv6 visitor'
        : 'no visitors today yet',
      by_country: [],
      coverage,
    };
  }
  return { available: true, reason: null, by_country: geo.byCountry, coverage };
}

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

// ONE pass over lb_touches for totals AND the per-funnel breakdown (H1b).
// The scan floor is LEAST(midnight, now-5min) so a just-after-midnight live
// visitor whose touch landed at 23:59 UTC still counts as live.
// GROUPING(funnel_id)=1 marks the () grand-total row (a real NULL funnel_id
// data row groups with GROUPING()=0, so the two can never be confused).
const TOUCH_ROLLUP_SQL = `
  SELECT t.funnel_id,
         GROUPING(t.funnel_id) AS is_total,
         MAX(f.name) AS name, MAX(f.slug) AS slug,
         COUNT(DISTINCT t.vid) FILTER (
           WHERE t.ts >= NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes'
         )::bigint AS live,
         COUNT(DISTINCT t.vid) FILTER (
           WHERE t.ts >= ${UTC_MIDNIGHT}
         )::bigint AS unique_today
  FROM lb_touches t
  LEFT JOIN funnels f ON f.id = t.funnel_id
  WHERE t.ts >= LEAST(${UTC_MIDNIGHT}, NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes')
  GROUP BY GROUPING SETS ((t.funnel_id), ())`;

// GEO (ANALYTICS LANE 5) — today's visitors per ISO country code, plus the
// COVERAGE those codes were measured over. One GROUPING SETS pass on the same
// idx_lb_touches_ts scan the rollup uses; the () row is the grand total.
// `resolved` counts distinct vids that carry a country at all — publishing the
// country rows without it would let a 3%-coverage sample read as a census.
// NOTE a vid that touched from two countries counts in BOTH country rows, so
// the rows can sum ABOVE `resolved`; the basis string says so.
const TOUCH_GEO_SQL = `
  SELECT t.country,
         GROUPING(t.country) AS is_total,
         COUNT(DISTINCT t.vid)::bigint AS visitors,
         COUNT(DISTINCT t.vid) FILTER (WHERE t.country IS NOT NULL AND t.country <> '')::bigint AS resolved
  FROM lb_touches t
  WHERE t.ts >= ${UTC_MIDNIGHT}
  GROUP BY GROUPING SETS ((t.country), ())`;

const CO_EVENTS_TILES_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE kind = 'session_created')::bigint AS checkout_starts_today,
    COUNT(*) FILTER (WHERE kind IN ('paid','upsell_settled'))::bigint AS purchases_today
  FROM co_events
  WHERE kind = ANY($1) AND created_at >= ${UTC_MIDNIGHT}`;

// Exported for the harness ONLY — it EXPLAIN-asserts the REAL hot statements
// (the ones that run every tick) use an index scan, byte-identical to what
// runs here. Never call these from anywhere but this file + the harness.
export const _HOT_SQL = Object.freeze({
  touch_rollup: TOUCH_ROLLUP_SQL,
  co_events_delta: `${CO_EVENTS_SQL} AND e.id > $2 ORDER BY e.id ASC LIMIT $3`,
  co_events_tiles: CO_EVENTS_TILES_SQL,
});

// ── today-tiles cache (review H1b) ──────────────────────────────────────────
let _tilesCache = { at: 0, tiles: null };

/** Harness hook: force the next tiles read to hit the DB. */
export function _clearTilesCache() {
  _tilesCache = { at: 0, tiles: null };
}

async function readTodayTiles(query, warnings) {
  if (_tilesCache.tiles && Date.now() - _tilesCache.at < TILES_TTL_MS) {
    return _tilesCache.tiles;
  }
  const tileWarnings = [];

  const checkout = await safeRead('co_events_today', tileWarnings, async () => {
    const [r] = await query(CO_EVENTS_TILES_SQL, [[...LIVE_EVENT_KINDS]]);
    return r;
  }, null);

  const sessionRevenue = await safeRead('co_sessions_revenue', tileWarnings, async () => {
    const [r] = await query(
      `SELECT COALESCE(SUM(total), 0) AS revenue
       FROM co_sessions
       WHERE paid_at IS NOT NULL AND status IN ('paid','refunded')
         AND paid_at >= ${UTC_MIDNIGHT}`
    );
    return r;
  }, null);

  const upsellRevenue = await safeRead('co_upsell_revenue', tileWarnings, async () => {
    const [r] = await query(
      `SELECT COALESCE(SUM(amount), 0) AS revenue
       FROM co_upsell_charges
       WHERE status IN ('settled','refunded') AND created_at >= ${UTC_MIDNIGHT}`
    );
    return r;
  }, null);

  // Base revenue unreadable ⇒ the tile is null ("could not measure"). Base
  // readable but upsells not ⇒ publish the base with a named warning — the
  // degraded flag says the number is a lower bound this refresh.
  const tiles = {
    checkout_starts_today: checkout ? int(checkout.checkout_starts_today) : null,
    purchases_today: checkout ? int(checkout.purchases_today) : null,
    revenue_today: sessionRevenue
      ? money(Number(sessionRevenue.revenue) + (upsellRevenue ? Number(upsellRevenue.revenue) : 0))
      : null,
  };
  warnings.push(...tileWarnings);
  if (tileWarnings.length === 0) {
    _tilesCache = { at: Date.now(), tiles }; // never cache a degraded read
  }
  return tiles;
}

/**
 * The initial-state payload (GET /api/v1/live/snapshot) and the per-tick
 * "snapshot" SSE frame. Every source is its own failure domain (safeRead):
 * a broken table degrades to a named warning + nulls, never a dead board.
 */
export async function buildLiveSnapshot({ query = analyticsQuery, limit = DEFAULT_EVENT_LIMIT } = {}) {
  const warnings = [];
  const lim = Math.min(Math.max(int(limit) || DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);

  const rollup = await safeRead('lb_touches', warnings, async () => {
    const rows = await query(TOUCH_ROLLUP_SQL);
    const totalRow = rows.find((r) => Number(r.is_total) === 1) || null;
    const byFunnel = rows
      .filter((r) => Number(r.is_total) !== 1)
      .map((r) => ({
        funnel_id: r.funnel_id || null,
        name: r.name || null,
        slug: r.slug || null,
        live: int(r.live),
        unique_today: int(r.unique_today),
      }))
      .sort((a, b) => b.live - a.live || b.unique_today - a.unique_today)
      .slice(0, 50);
    return { totalRow, byFunnel };
  }, null);

  const geo = await safeRead('lb_touches_geo', warnings, async () => {
    const rows = await query(TOUCH_GEO_SQL);
    const totalRow = rows.find((r) => Number(r.is_total) === 1) || null;
    const byCountry = rows
      .filter((r) => Number(r.is_total) !== 1 && r.country)
      .map((r) => ({ country: String(r.country), visitors: int(r.visitors) }))
      .sort((a, b) => b.visitors - a.visitors || a.country.localeCompare(b.country))
      .slice(0, 50);
    return {
      byCountry,
      resolved: totalRow ? int(totalRow.resolved) : 0,
      total: totalRow ? int(totalRow.visitors) : 0,
    };
  }, null);

  const tiles = await readTodayTiles(query, warnings);

  // Recent events — the two sources drawn independently at the full limit,
  // merged, sorted by ts desc, cut to the limit.
  const touchEvents = await safeRead('lb_touches_feed', warnings, async () => {
    const rows = await query(`${TOUCH_EVENTS_SQL} ORDER BY t.id DESC LIMIT $1`, [lim]);
    return rows.map(mapTouchRow);
  }, []);

  const coEvents = await safeRead('co_events_feed', warnings, async () => {
    const rows = await query(
      `${CO_EVENTS_SQL} ORDER BY e.id DESC LIMIT $2`,
      [[...LIVE_EVENT_KINDS], lim]
    );
    return rows.map(mapCoEventRow);
  }, []);

  const events = [...touchEvents, ...coEvents]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, lim);

  return {
    as_of: new Date().toISOString(),
    live_total: rollup?.totalRow ? int(rollup.totalRow.live) : null,
    unique_today_total: rollup?.totalRow ? int(rollup.totalRow.unique_today) : null,
    checkout_starts_today: tiles.checkout_starts_today,
    purchases_today: tiles.purchases_today,
    revenue_today: tiles.revenue_today,
    by_funnel: rollup?.byFunnel || [],
    events,
    // Country capture landed in LANE 5 (lb_touches.country). Still never
    // fabricated: available ONLY when a code was actually stored in-window,
    // and always shipped WITH its coverage so a thin sample cannot read as a
    // census. The globe itself stays unported — a country code is not a
    // latitude, and inventing one would be the fabrication this card exists
    // to avoid.
    geo: geoCard(geo),
    basis: {
      live: `distinct lb_touches.vid, last ${LIVE_WINDOW_MINUTES} minutes`,
      unique_today: 'distinct lb_touches.vid since UTC midnight',
      revenue_today:
        "SUM(co_sessions.total) where paid_at >= UTC midnight and status in ('paid','refunded')"
        + " + SUM(co_upsell_charges.amount) where created_at >= UTC midnight and status in ('settled','refunded')",
      events: 'lb_touches (views) + co_events (session_created/paid/upsell_settled)',
      geo: 'distinct lb_touches.vid per lb_touches.country since UTC midnight'
        + ' — a vid seen from two countries counts in both rows, so the rows can'
        + ' sum above coverage.resolved_visitors; rows written before country'
        + ' capture landed are NULL and are counted only in coverage.total_visitors',
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
 * Delta draw: feed rows newer than (watermark − WATERMARK_OVERLAP_IDS) —
 * id-ordered (BIGSERIAL: monotonic assignment, no collisions), with the
 * overlap re-drawing the last K ids so a row whose transaction committed
 * AFTER a later id was observed still surfaces (review M2). The hub filters
 * re-draws through its emitted-id set; the client dedupes by id as well.
 * Returns mapped events (ascending, oldest first) + advanced watermarks
 * (never regressed below the input).
 */
export async function readNewEvents({ query = analyticsQuery, touchId = 0, coEventId = 0, limit = 100 } = {}) {
  const lim = Math.min(Math.max(int(limit) || 100, 1), MAX_EVENT_LIMIT);
  const touchFloor = Math.max(touchId - WATERMARK_OVERLAP_IDS, 0);
  const coFloor = Math.max(coEventId - WATERMARK_OVERLAP_IDS, 0);

  const touchRows = await query(
    `${TOUCH_EVENTS_SQL} WHERE t.id > $1 ORDER BY t.id ASC LIMIT $2`,
    [touchFloor, lim]
  );
  const coRows = await query(
    _HOT_SQL.co_events_delta,
    [[...LIVE_EVENT_KINDS], coFloor, lim]
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
