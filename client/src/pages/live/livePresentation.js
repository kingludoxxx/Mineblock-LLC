// livePresentation — the PURE logic behind the Live View presentation layer.
//
// Nothing in this file touches React, the DOM, WebAudio, localStorage or the
// clock-by-default. Every function is (inputs) → output, so the whole of the
// tricky part — toast queue bounding, alert gating, country→centroid lookup,
// the globe projection and the "who just arrived" diff — is exercised by
// `node server/tests/live-view/presentation.mjs` with no browser.
//
// Ported from funnel-os's liveview kit (usePaymentToasts.js, useSaleAlerts.js,
// LiveGlobe.jsx, RailCards.jsx), with the constants kept identical where they
// were load-bearing there:
//   TOAST_MAX 3 · TOAST_TTL_MS 8000 · TOAST_EXIT_MS 240 · SEEN_MAX 256
//   BUFFER_SAMPLE 2 · ALERT_DEDUPE_MAX 256
//
// THE HONESTY RULE (inherited from liveViewQueries.js, and the reason this
// file has as many guards as it does): a country code is not a latitude. Where
// the wire has no location, nothing is plotted and the gap is COUNTED, never
// defaulted to (0, 0) and never quietly dropped.
import COUNTRY_CENTROIDS from './countryCentroids.js';

// ── constants ───────────────────────────────────────────────────────────────
export const TOAST_MAX = 3;         // stack cap: a burst can never blanket the page
export const TOAST_TTL_MS = 8_000;  // auto-dismiss
export const TOAST_EXIT_MS = 240;   // must exceed the 220ms lv-toast-out animation
export const SEEN_MAX = 256;        // bound on the dedupe set
export const BUFFER_SAMPLE = 2;     // hidden-tab events replayed verbatim below this
export const ALERT_DEDUPE_MAX = 256;
export const FRESH_MS = 5_200;      // how long a rail row keeps its "new" flash

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const VOLUME_DEFAULT = 0.5;

// ── formatters ──────────────────────────────────────────────────────────────
// (These lived in EventRail.jsx. Moving them here is not tidying: a file that
// exports both components and helpers trips react-refresh/only-export-components,
// which was a standing lint error on this page.)

/** null/NaN → null, NEVER 0. A dash means "not measured"; 0 means "none". */
export function fmtMoney(v, currency = 'USD') {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const code = String(currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(Number(v));
  } catch {
    // Intl throws RangeError on a bogus ISO code — a bad currency string must
    // not blank out a real amount.
    return `${code} ${Number(v).toFixed(2)}`;
  }
}

export function fmtInt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(v));
}

export function timeAgo(ts, nowMs) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor(((nowMs ?? Date.now()) - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

let _regionNames = null;
try {
  _regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch { _regionNames = null; }

/** ISO alpha-2 → English name via the platform's own CLDR data. */
export function countryLabel(cc) {
  if (!cc) return '';
  try { return _regionNames?.of(cc) || cc; } catch { return cc; }
}

// ── country → centroid ──────────────────────────────────────────────────────

/**
 * Look up a plottable point for an ISO alpha-2 code.
 * Returns null for anything the generated table does not know — the caller
 * MUST surface that as an off-map count rather than inventing a coordinate.
 */
export function lookupCentroid(code) {
  if (typeof code !== 'string') return null;
  const cc = code.trim().toUpperCase();
  if (cc.length !== 2) return null;
  const hit = COUNTRY_CENTROIDS[cc];
  if (!hit) return null;
  return { lat: hit[0], lon: hit[1] };
}

export function hasCentroid(code) {
  return lookupCentroid(code) !== null;
}

/**
 * snapshot.geo → what the globe can actually draw.
 *
 * Returns { points, offMap, offMapVisitors, plotted, total } where `points` is
 * sorted by visitors DESC (so the biggest markers are painted last / on top)
 * and every entry carries its own centroid. `offMap` names the codes with no
 * centroid — Natural Earth 110m has no polygon for them and no supplement was
 * entered — so the UI can say "3 countries not on the map" instead of lying by
 * omission.
 */
export function deriveGeoPoints(geo) {
  const rows = Array.isArray(geo?.by_country) ? geo.by_country : [];
  const points = [];
  const offMap = [];
  let offMapVisitors = 0;
  let total = 0;

  for (const r of rows) {
    const cc = typeof r?.country === 'string' ? r.country.trim().toUpperCase() : '';
    const visitors = Number(r?.visitors);
    const n = Number.isFinite(visitors) && visitors > 0 ? visitors : 0;
    if (!cc) continue;
    total += n;
    const c = lookupCentroid(cc);
    if (!c) {
      offMap.push(cc);
      offMapVisitors += n;
      continue;
    }
    points.push({ country: cc, label: countryLabel(cc), visitors: n, lat: c.lat, lon: c.lon });
  }

  points.sort((a, b) => a.visitors - b.visitors || a.country.localeCompare(b.country));
  return {
    points,
    offMap,
    offMapVisitors,
    plotted: points.length,
    total,
  };
}

/**
 * Which countries GAINED visitors between two snapshots.
 *
 * This is the whole reason the globe can pulse without a per-event country on
 * the wire: our SSE feed events carry no geo (server/src/services/
 * liveViewQueries.js mapTouchRow/mapCoEventRow), but the snapshot's per-country
 * visitor counts do move. A count that RISES is a true statement — "at least
 * one new visitor from X" — and it is the only arrival claim the payload
 * supports.
 *
 * Deliberately one-directional: a FALL is a UTC-midnight rollover or a
 * degraded read, never a departure, so it pulses nothing. A country absent
 * from `prev` entirely is only an arrival when `prev` was a real reading —
 * on the very first snapshot every country would otherwise "arrive" at once.
 */
export function diffArrivals(prev, next) {
  const out = [];
  if (!Array.isArray(next)) return out;
  const isFirst = !Array.isArray(prev);
  if (isFirst) return out;

  const before = new Map();
  for (const p of prev) {
    if (p && typeof p.country === 'string') before.set(p.country, Number(p.visitors) || 0);
  }
  for (const p of next) {
    if (!p || typeof p.country !== 'string') continue;
    const was = before.get(p.country) ?? 0;
    const now = Number(p.visitors) || 0;
    if (now > was) out.push({ ...p, gained: now - was });
  }
  return out;
}

// ── orthographic projection ─────────────────────────────────────────────────
const DEG = Math.PI / 180;

/**
 * Orthographic (globe-from-space) projection.
 *
 * The reference renders with globe.gl/three (WebGL). We have `three` but not
 * `globe.gl`, and adding a dependency for one card is not worth it — so this
 * is the same picture done as plain 2D canvas maths.
 *
 * `rotation` spins the sphere about its axis (degrees of longitude at the
 * centre of the disc); `tilt` leans the north pole toward the viewer.
 * `visible` is false for the far hemisphere — the caller must not draw those,
 * or the back of the globe bleeds through the front.
 */
export function project(lat, lon, { rotation = 0, tilt = 0, radius = 1, cx = 0, cy = 0 } = {}) {
  const phi = lat * DEG;
  const lambda = (lon + rotation) * DEG;
  const t = tilt * DEG;

  const cosPhi = Math.cos(phi);
  // Unit sphere, +z toward the viewer.
  const x = cosPhi * Math.sin(lambda);
  const y = Math.sin(phi);
  const z = cosPhi * Math.cos(lambda);

  // Lean about the X axis.
  const y2 = y * Math.cos(t) - z * Math.sin(t);
  const z2 = y * Math.sin(t) + z * Math.cos(t);

  return {
    x: cx + radius * x,
    y: cy - radius * y2, // canvas Y grows downward
    z: z2,
    visible: z2 >= 0,
  };
}

// ── payment events ──────────────────────────────────────────────────────────

/**
 * Is this feed row a money moment?
 *
 * Our wire types (liveViewQueries.js) are 'view' | 'checkout_start' |
 * 'purchase'. Only 'purchase' is money — a checkout START is an intention, and
 * toasting it would inflate a board people read as revenue.
 */
export function isPaymentEvent(ev) {
  return Boolean(ev) && ev.type === 'purchase';
}

/** Upsell detection. `upsell` is a BOOLEAN on our wire, never a count. */
export function isUpsellEvent(ev) {
  return Boolean(ev) && ev.upsell === true;
}

/**
 * Stable dedupe key, kind-prefixed so an order and its upsell both ring.
 * Returns null when the row has no id — an un-keyable event cannot be deduped,
 * and emitting it would let one reconnect replay the whole afternoon.
 */
export function toastKeyOf(ev) {
  if (!ev) return null;
  const id = ev.id ?? ev.event_id ?? ev.order_id;
  if (id == null || id === '') return null;
  return `${isUpsellEvent(ev) ? 'upsell' : 'paid'}:${id}`;
}

/**
 * Feed row → toast view-model.
 *
 * WHAT WE HONESTLY HAVE, and what the reference had that we do not:
 *   • amount/currency — yes (co_sessions.total / .currency).
 *   • product         — NOT on the wire. co_sessions.line_items is never
 *     selected into a feed event, so `where` carries the funnel + page instead
 *     of a product name. Naming a product we did not read would be a guess.
 *   • location        — NOT on the wire for purchases. lb_touches.country
 *     exists, co_sessions has no country at all, and the two are not joined.
 *     `country` is read opportunistically so the line lights up for free if a
 *     future additive server field supplies it; until then it stays null and
 *     the row simply is not rendered.
 */
export function toastFromEvent(ev) {
  const upsell = isUpsellEvent(ev);
  // `== null` FIRST: Number(null) is 0 and Number.isFinite(0) is true, so a
  // finite-check alone turns "amount not recorded" into "$0.00 — it was free".
  // That is the exact confusion mapCoEventRow's own comment warns about.
  const raw = ev?.value;
  const amount = raw == null || raw === '' ? null : Number(raw);
  const cc = typeof ev?.country === 'string' && ev.country.trim() ? ev.country.trim().toUpperCase() : null;
  return {
    upsell,
    amount: Number.isFinite(amount) ? amount : null, // null = unrecorded, NOT free
    currency: ev?.currency || 'USD',
    where: ev?.funnel_name || (ev?.funnel_id ? `funnel ${String(ev.funnel_id).slice(0, 12)}…` : ''),
    page: ev?.page_title || ev?.page_slug || '',
    country: cc,
    countryLabel: cc ? countryLabel(cc) : null,
    ts: ev?.ts || null,
    aggregate: false,
    count: 1,
  };
}

// ── toast queue ─────────────────────────────────────────────────────────────

/** Fresh, empty queue state. */
export function createToastState() {
  return { toasts: [], seen: [], seq: 0, buffer: null };
}

function evictSeen(seen) {
  // FIFO: the OLDEST key goes. A Set preserves insertion order, but this
  // module keeps an array so the state stays plain-JSON and diffable in tests.
  while (seen.length > SEEN_MAX) seen.shift();
  return seen;
}

/** Seed the dedupe set from a snapshot so a reconnect never re-toasts history. */
export function seedSeen(state, events) {
  const seen = state.seen.slice();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isPaymentEvent(ev)) continue;
    const k = toastKeyOf(ev);
    if (k && !seen.includes(k)) seen.push(k);
  }
  return { ...state, seen: evictSeen(seen) };
}

function emit(state, toast, max) {
  const seq = state.seq + 1;
  const item = { ...toast, key: `pt${seq}`, exiting: false };
  const cap = Math.max(1, max);
  // Newest on top; the cap drops the OLDEST. `dropped` is returned so the
  // caller can clear that toast's timers instead of leaking them (the
  // reference reaped these in an effect; returning them is cheaper and exact).
  const next = [item, ...state.toasts];
  const dropped = next.slice(cap).map((t) => t.key);
  return { state: { ...state, toasts: next.slice(0, cap), seq }, emitted: item, dropped };
}

/**
 * Offer an event to the toast stack.
 *
 * Returns { state, emitted, dropped, reason }. `emitted` is the new toast (or
 * null), `dropped` lists keys evicted by the cap, and `reason` names WHY
 * nothing was emitted so the caller — and the harness — can tell "suppressed"
 * apart from "buffered".
 *
 * Gates, in order (same order as the reference):
 *   1. armed  — nothing before the first snapshot has been applied, or a
 *               reconnect replays the day as a fireworks show
 *   2. kind   — purchases only
 *   3. key    — un-keyable events cannot be deduped
 *   4. seen   — FIFO-bounded at SEEN_MAX
 *   5. hidden — a background tab COALESCES instead of stacking
 */
export function pushToast(state, ev, opts = {}) {
  const { armed = true, hidden = false, max = TOAST_MAX } = opts;
  if (!armed) return { state, emitted: null, dropped: [], reason: 'not_armed' };
  if (!isPaymentEvent(ev)) return { state, emitted: null, dropped: [], reason: 'not_payment' };

  const key = toastKeyOf(ev);
  if (!key) return { state, emitted: null, dropped: [], reason: 'no_key' };
  if (state.seen.includes(key)) return { state, emitted: null, dropped: [], reason: 'duplicate' };

  const seen = evictSeen([...state.seen, key]);
  const toast = toastFromEvent(ev);

  if (hidden) {
    const buf = state.buffer || { count: 0, total: 0, items: [], allUpsell: true, currency: null };
    const next = {
      count: buf.count + 1,
      // A null amount is "unrecorded" — it must not be summed as 0, or the
      // "collected while you were away" total silently understates itself.
      total: buf.total + (toast.amount ?? 0),
      unpriced: (buf.unpriced || 0) + (toast.amount == null ? 1 : 0),
      items: buf.items.length < BUFFER_SAMPLE ? [...buf.items, toast] : buf.items,
      allUpsell: buf.allUpsell && toast.upsell,
      currency: buf.currency || toast.currency,
    };
    return { state: { ...state, seen, buffer: next }, emitted: null, dropped: [], reason: 'buffered' };
  }

  const r = emit({ ...state, seen }, toast, max);
  return { ...r, reason: 'emitted' };
}

/**
 * Drain the hidden-tab buffer. Below BUFFER_SAMPLE the events replay verbatim
 * (oldest first, so the newest lands on top); above it they coalesce into one
 * "N payments" row — three toasts is a summary, thirty is a denial-of-service
 * on the operator's attention.
 */
export function flushBuffer(state, opts = {}) {
  const { max = TOAST_MAX } = opts;
  const buf = state.buffer;
  if (!buf || buf.count === 0) return { state: { ...state, buffer: null }, emitted: [], dropped: [] };

  let s = { ...state, buffer: null };
  const emitted = [];
  const dropped = [];

  if (buf.count <= BUFFER_SAMPLE) {
    for (const t of buf.items) {
      const r = emit(s, t, max);
      s = r.state;
      emitted.push(r.emitted);
      dropped.push(...r.dropped);
    }
  } else {
    const r = emit(s, {
      aggregate: true,
      count: buf.count,
      upsell: buf.allUpsell,
      amount: buf.total,
      currency: buf.currency || 'USD',
      // The aggregate total is only the whole story when every event carried a
      // price. Carry the shortfall rather than presenting a partial sum as one.
      unpriced: buf.unpriced || 0,
      where: '',
      page: '',
      country: null,
      countryLabel: null,
      ts: null,
    }, max);
    s = r.state;
    emitted.push(r.emitted);
    dropped.push(...r.dropped);
  }
  return { state: s, emitted, dropped };
}

/** Mark a toast as exiting (it stays mounted for TOAST_EXIT_MS of animation). */
export function markExiting(state, key) {
  return {
    ...state,
    toasts: state.toasts.map((t) => (t.key === key ? { ...t, exiting: true } : t)),
  };
}

/** Remove a toast outright. */
export function removeToast(state, key) {
  return { ...state, toasts: state.toasts.filter((t) => t.key !== key) };
}

// ── sale-alert gating ───────────────────────────────────────────────────────

export function clampVolume(v) {
  // Same trap as toastFromEvent: Number(null) is 0, so a bare finite-check
  // reads "no stored preference" as "the operator set it to silent".
  if (v == null || v === '' || typeof v === 'boolean') return VOLUME_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return VOLUME_DEFAULT;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, n));
}

/** Fresh gate state. `fired` is the bounded dedupe list. */
export function createAlertState() {
  return { fired: [] };
}

/**
 * Should this event ring?
 *
 * Returns { state, allowed, reason }. Distinct from the toast gate on purpose:
 * a muted operator still wants the toast, and a zero volume is not the same
 * decision as a mute (one is a slider at rest, the other is an intent) — but
 * both are silent, and saying so by name is what lets the harness prove the
 * difference exists.
 */
export function shouldAlert(state, ev, opts = {}) {
  const { muted = false, volume = VOLUME_DEFAULT, armed = true, supported = true } = opts;
  const deny = (reason) => ({ state, allowed: false, reason });

  if (!armed) return deny('not_armed');
  if (!supported) return deny('unsupported');
  if (!isPaymentEvent(ev)) return deny('not_payment');
  if (muted) return deny('muted');
  if (clampVolume(volume) <= 0) return deny('zero_volume');

  const key = toastKeyOf(ev);
  if (!key) return deny('no_key');
  if (state.fired.includes(key)) return deny('duplicate');

  const fired = [...state.fired, key];
  while (fired.length > ALERT_DEDUPE_MAX) fired.shift();
  return { state: { ...state, fired }, allowed: true, reason: 'allowed' };
}

// ── rail freshness ──────────────────────────────────────────────────────────

/**
 * Which rail rows are NEW since the last render.
 *
 * `prevIds === null` means first paint: the whole backfilled feed is the
 * baseline and NOTHING flashes. Without that rule, opening the page at 6pm
 * lights up every purchase of the day as if it had just landed.
 */
export function diffFreshIds(prevIds, feed) {
  const ids = (Array.isArray(feed) ? feed : []).map((e) => e?.id).filter((id) => id != null);
  if (prevIds === null || prevIds === undefined) return { ids, fresh: [] };
  const before = new Set(prevIds);
  return { ids, fresh: ids.filter((id) => !before.has(id)) };
}
