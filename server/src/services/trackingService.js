// Tracking engine — the deterministic Purchase conversion + the browser-beacon
// relay. Port of the money-event half of funnel-os lb_tracking_service.py.
//
// Dual-rail with event-id dedup (TRACKING.md §1):
//   • the browser pixel fires with an event_id;
//   • the page beacons the same payload to /track/collect → relayed with the
//     SAME id;
//   • the settlement webhook fires Purchase with a DETERMINISTIC id
//     (pur_<session_id>), which the thank-you page also derives.
// Idempotent per (pixel_id, event_id) via lb_tracking_sent → webhook + browser
// + relay can never triple-count.
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';
import { deliverToPixel, buildUserData } from './trackingDelivery.js';
import { stampConversion, fbclidFromFbc } from './trackingClicks.js';

// The relay's fixed allow-list. A forged beacon must not let a stranger drive
// arbitrary conversion-API calls on the ad account (TRACKING.md §1).
//
// SECURITY (review fix #1a): 'Purchase' is DELIBERATELY ABSENT. Money events
// are owned exclusively by the deterministic server path
// (firePurchaseConversion, event_id = pur_<session_id>, fired from the
// settlement webhook). A client-relayable Purchase would let anyone with a
// funnel_id inject forged server-trusted Purchase events (arbitrary
// value/email) into the operator's CAPI. The browser pixel may still fire
// its own native Purchase with the derived pur_<session> id — the shared
// lb_tracking_sent claim dedupes it against the webhook — but the SERVER
// relay never mints one from a beacon.
export const ALLOWED_CLIENT_EVENTS = new Set([
  'PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout',
  'AddPaymentInfo', 'Lead', 'CompleteRegistration', 'UpsellView',
]);

// SECURITY (review fix #1b): every client-relayed event_id is namespaced with
// this prefix so a beacon can NEVER collide with — and therefore never
// pre-claim/suppress — a server-derived id like pur_<session_id> in the
// shared lb_tracking_sent (pixel_id, event_id) ledger.
export const CLIENT_EVENT_ID_PREFIX = 'cl_';

// Server-side pixels for a funnel = enabled pixels whose mode relays server
// events ('s2s' or 'hybrid'). 'native' pixels fire browser-only.
async function serverPixels(funnelId) {
  const rows = await pgQuery(
    `SELECT id, funnel_id, kind, pixel_id, mode, config FROM lb_pixels
     WHERE funnel_id = $1 AND enabled = TRUE AND mode IN ('s2s', 'hybrid')`,
    [String(funnelId || '')]
  );
  return rows;
}

// Fire the deterministic Purchase conversion for a settled (paid) session.
// event_id = pur_<session_id>. Idempotent by construction: a redelivery, a
// concurrent settle and the thank-you page all resolve to the same id and the
// lb_tracking_sent (pixel_id, event_id) unique claim dedupes to ONE send per
// pixel. FIRE-AND-FORGET — a delivery failure escalates for retry, it never
// blocks settlement (DECISIONS #16 + #3).
//
// processing != paid: refuses to fire for a session that is not 'paid'.
export async function firePurchaseConversion(sessionId, { source = 'webhook' } = {}) {
  try {
    await ensureTrackingTables();
    const rows = await pgQuery(
      `SELECT id, funnel_id, status, total, currency, customer, tracking_net, vid, click_vault
       FROM co_sessions WHERE id = $1`,
      [String(sessionId || '').slice(0, 80)]
    );
    if (!rows.length) return { ok: false, reason: 'session_not_found' };
    const s = rows[0];
    // Money only from settlement: only a paid session fires Purchase.
    if (s.status !== 'paid') return { ok: false, reason: `not_paid:${s.status}` };

    const eventId = `pur_${s.id}`;
    const net = (s.tracking_net && typeof s.tracking_net === 'object') ? s.tracking_net : {};
    const cust = (s.customer && typeof s.customer === 'object') ? s.customer : {};
    const ship = (cust.shipping && typeof cust.shipping === 'object') ? cust.shipping : {};
    const vault = (s.click_vault && typeof s.click_vault === 'object') ? s.click_vault : {};

    // Last-click revenue attribution (DECISIONS #8/#10). Prefer the session's
    // captured click vault; fall back to the fbclid embedded in the _fbc
    // cookie snapshot so revenue still attributes without a persisted vid.
    const clickIds = { ...vault };
    if (!Object.keys(clickIds).length) {
      const fbclid = fbclidFromFbc(net.fbc);
      if (fbclid) clickIds.fbclid = fbclid;
    }
    const vids = s.vid ? [s.vid] : [];
    await stampConversion(s.id, vids, clickIds, { funnelId: s.funnel_id || '' });

    // Build the hashed identity + PII-free idk once; reuse per pixel.
    const clickId = Object.values(clickIds)[0] || '';
    const { user_data, idk } = buildUserData({
      email: cust.email, phone: cust.phone,
      first_name: cust.first_name, last_name: cust.last_name,
      city: ship.city, state: ship.state, zip: ship.zip, country: ship.country,
      external_id: s.id, fbp: net.fbp, fbc: net.fbc, ip: net.ip, ua: net.ua,
      click_id: clickId,
    });
    const customData = { value: Number(s.total), currency: s.currency, order_id: s.id };

    const pixels = await serverPixels(s.funnel_id);
    if (!pixels.length) {
      // No server pixel configured — nothing to relay. The stamp above still
      // ran; report so callers/tests can see the (expected) no-op.
      return { ok: true, fired: 0, event_id: eventId, reason: 'no_server_pixel' };
    }
    const results = [];
    for (const px of pixels) {
      const r = await deliverToPixel({
        funnelId: s.funnel_id, pixel: px, eventName: 'Purchase', eventId,
        userData: user_data, idk, customData, source, eventSourceUrl: net.url || '',
      });
      results.push({ pixel: px.pixel_id, result: r });
    }
    return { ok: true, fired: results.length, event_id: eventId, results };
  } catch (err) {
    // Never propagate — a tracking failure must never break settlement.
    console.error('[tracking] firePurchaseConversion failed (fail-open):', err.message);
    return { ok: false, reason: 'error' };
  }
}

// Relay a browser-beaconed event (/track/collect). The event NAME is checked
// against the allow-list; the event_id echoes the browser's so native+relay
// dedupe. Consent-denied beacons legitimately carry no identity → the delivery
// layer records them as skipped 'no_identity' WITHOUT tripping the breaker.
//
// SECURITY (review fix #1b): the client-supplied event_id is ALWAYS namespaced
// under CLIENT_EVENT_ID_PREFIX before it reaches the lb_tracking_sent ledger.
// A beacon claiming event_id 'pur_<session>' is therefore stored as
// 'cl_pur_<session>' and can never pre-claim (suppress) the real webhook
// Purchase. Browser-native pixels that need the pur_ id for platform-side
// dedupe fire it client-side; the SERVER ledger namespace stays partitioned.
export async function relayBrowserEvent({ funnelId, eventName, eventId, identity = {}, customData = {}, consent = 'granted', eventSourceUrl = '' }) {
  if (!ALLOWED_CLIENT_EVENTS.has(eventName)) return { ok: false, reason: 'event_not_allowed' };
  try {
    await ensureTrackingTables();
    const rawId = String(eventId || `${eventName}_${Date.now()}`);
    const namespacedId = rawId.startsWith(CLIENT_EVENT_ID_PREFIX)
      ? rawId
      : `${CLIENT_EVENT_ID_PREFIX}${rawId}`;
    const { user_data, idk } = buildUserData(identity);
    const pixels = await serverPixels(funnelId);
    if (!pixels.length) return { ok: true, fired: 0, reason: 'no_server_pixel', idk };
    const results = [];
    for (const px of pixels) {
      const r = await deliverToPixel({
        funnelId, pixel: px, eventName, eventId: namespacedId,
        userData: user_data, idk, customData,
        source: 'relay', eventSourceUrl,
      });
      results.push(r);
    }
    return { ok: true, fired: results.length, idk, consent, event_id: namespacedId };
  } catch (err) {
    console.error('[tracking] relayBrowserEvent failed (fail-open):', err.message);
    return { ok: false, reason: 'error' };
  }
}

export default { firePurchaseConversion, relayBrowserEvent, ALLOWED_CLIENT_EVENTS };
