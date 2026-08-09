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
import { customNetworksFor } from './trackingCustomNetworks.js';

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

// Every server-side delivery target for ONE named event: the named-network
// lb_pixels rows above PLUS the operator's enabled custom S2S networks that
// are toggled on for this event (projected into the same pixel shape by
// trackingCustomNetworks.asPixel).
//
// FAIL-OPEN, DELIBERATELY. A custom network is an operator convenience; the
// named networks are the money rail. If the custom-network read throws (schema
// not yet ensured on a cold replica, a pool blip), the named pixels must still
// fire — so the failure is logged and the list degrades to the named ones
// rather than taking the whole conversion down with it.
async function serverTargets(funnelId, eventName) {
  const pixels = await serverPixels(funnelId);
  let customs = [];
  try {
    customs = await customNetworksFor(funnelId, eventName);
  } catch (err) {
    console.error('[tracking] custom network read failed (fail-open, named pixels still fire):', err.message);
  }
  return pixels.concat(customs);
}

// The funnel's GENERAL event options (funnels.settings.tracking — the panel in
// the Tracking settings section). Read at FIRE time, never cached: flipping a
// checkbox has to take effect on the next conversion, not the next deploy.
//
// jsonb DISCIPLINE: settings can be an object OR a double-encoded string
// depending on which writer last touched it, so both shapes are read.
//
// FAILS OPEN TO CURRENT BEHAVIOUR. Every flag below is read as
// `!== false` — an unreadable settings blob, a missing key, or a funnel row
// that no longer exists all mean "keep doing what we do today". An operator
// must have to ACT to change what is sent; a read failure must never silently
// degrade match quality.
export async function trackingFlags(funnelId) {
  try {
    const rows = await pgQuery(`SELECT settings FROM funnels WHERE id = $1`, [String(funnelId || '')]);
    let s = rows.length ? rows[0].settings : null;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return {}; } }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
    const tr = s.tracking;
    return (tr && typeof tr === 'object' && !Array.isArray(tr)) ? tr : {};
  } catch (err) {
    console.error('[tracking] settings read failed (fail-open to defaults):', err.message);
    return {};
  }
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
    const flags = await trackingFlags(s.funnel_id);
    const clickId = Object.values(clickIds)[0] || '';
    const { user_data, idk } = buildUserData({
      email: cust.email, phone: cust.phone,
      first_name: cust.first_name, last_name: cust.last_name,
      city: ship.city, state: ship.state, zip: ship.zip, country: ship.country,
      // GENERAL → "Send hashed external id". Absent/true = send (today's
      // behaviour); only an explicit false omits it.
      external_id: flags.send_external_id === false ? '' : s.id, fbp: net.fbp, fbc: net.fbc, ip: net.ip, ua: net.ua,
      click_id: clickId,
    });
    const customData = { value: Number(s.total), currency: s.currency, order_id: s.id };

    const pixels = await serverTargets(s.funnel_id, 'Purchase');
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

// Fire the deterministic UPSELL Purchase conversion for a settled post-purchase
// charge. event_id = pur_<session_id>_u_<charge_row_id> — distinct from the
// main Purchase (pur_<session_id>) so an accepted upsell is a SECOND
// conversion, and deterministic so a webhook redelivery / concurrent settle /
// double-fire all resolve to the same id and the lb_tracking_sent
// (pixel_id, event_id) claim dedupes to ONE send per pixel.
//
// Same posture as firePurchaseConversion: paid-gated (money only from
// settlement — the parent session must be 'paid'), FIRE-AND-FORGET (a delivery
// failure escalates for retry, never throws up the stack, DECISIONS #16).
// `value` is the upsell CHARGE amount (not the session total) — the caller
// (the checkoutSettle wiring, a later integrator task) passes the settled
// charge row id + its amount. No click re-stamp here: the main Purchase
// already stamped last-click attribution for this session.
export async function fireUpsellPurchaseConversion(sessionId, chargeRowId, value, { source = 'webhook' } = {}) {
  try {
    await ensureTrackingTables();
    const chargeId = String(chargeRowId || '').slice(0, 80);
    if (!chargeId) return { ok: false, reason: 'no_charge_row' };
    // Review MINOR #2: Number(null) === 0, so a caller passing null/undefined
    // would silently fire a $0 Purchase and pollute value-based optimization.
    // Refuse missing values explicitly; an EXPLICIT 0 stays legitimate.
    if (value == null) return { ok: false, reason: 'no_value' };
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: 'bad_value' };
    const rows = await pgQuery(
      `SELECT id, funnel_id, status, currency, customer, tracking_net, vid, click_vault
       FROM co_sessions WHERE id = $1`,
      [String(sessionId || '').slice(0, 80)]
    );
    if (!rows.length) return { ok: false, reason: 'session_not_found' };
    const s = rows[0];
    // Money only from settlement: an upsell fires only under a paid session.
    if (s.status !== 'paid') return { ok: false, reason: `not_paid:${s.status}` };

    const eventId = `pur_${s.id}_u_${chargeId}`;
    const net = (s.tracking_net && typeof s.tracking_net === 'object') ? s.tracking_net : {};
    const cust = (s.customer && typeof s.customer === 'object') ? s.customer : {};
    const ship = (cust.shipping && typeof cust.shipping === 'object') ? cust.shipping : {};
    const vault = (s.click_vault && typeof s.click_vault === 'object') ? s.click_vault : {};
    const clickIds = { ...vault };
    if (!Object.keys(clickIds).length) {
      const fbclid = fbclidFromFbc(net.fbc);
      if (fbclid) clickIds.fbclid = fbclid;
    }
    const flags = await trackingFlags(s.funnel_id);
    const clickId = Object.values(clickIds)[0] || '';
    const { user_data, idk } = buildUserData({
      email: cust.email, phone: cust.phone,
      first_name: cust.first_name, last_name: cust.last_name,
      city: ship.city, state: ship.state, zip: ship.zip, country: ship.country,
      // GENERAL → "Send hashed external id". Absent/true = send (today's
      // behaviour); only an explicit false omits it.
      external_id: flags.send_external_id === false ? '' : s.id, fbp: net.fbp, fbc: net.fbc, ip: net.ip, ua: net.ua,
      click_id: clickId,
    });
    // order_id carries the upsell suffix so platform-side reporting can tell
    // the second conversion from the main order without sharing an event_id.
    const customData = { value: amount, currency: s.currency, order_id: `${s.id}_u_${chargeId}` };

    const pixels = await serverTargets(s.funnel_id, 'Purchase');
    if (!pixels.length) {
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
    console.error('[tracking] fireUpsellPurchaseConversion failed (fail-open):', err.message);
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
export async function relayBrowserEvent({ funnelId, eventName, eventId, identity = {}, customData = {}, consent = 'granted', eventSourceUrl = '', vid = '' }) {
  if (!ALLOWED_CLIENT_EVENTS.has(eventName)) return { ok: false, reason: 'event_not_allowed' };
  try {
    await ensureTrackingTables();
    const rawId = String(eventId || `${eventName}_${Date.now()}`);
    const namespacedId = rawId.startsWith(CLIENT_EVENT_ID_PREFIX)
      ? rawId
      : `${CLIENT_EVENT_ID_PREFIX}${rawId}`;
    const { user_data, idk } = buildUserData(identity);
    const pixels = await serverTargets(funnelId, eventName);
    if (!pixels.length) return { ok: true, fired: 0, reason: 'no_server_pixel', idk };
    const results = [];
    for (const px of pixels) {
      const r = await deliverToPixel({
        funnelId, pixel: px, eventName, eventId: namespacedId,
        userData: user_data, idk, customData,
        source: 'relay', eventSourceUrl,
        // Visitor-scoped GA4 client id (server-read cookie, never client-named)
        vid,
      });
      results.push(r);
    }
    return { ok: true, fired: results.length, idk, consent, event_id: namespacedId };
  } catch (err) {
    console.error('[tracking] relayBrowserEvent failed (fail-open):', err.message);
    return { ok: false, reason: 'error' };
  }
}

export default { firePurchaseConversion, fireUpsellPurchaseConversion, relayBrowserEvent, ALLOWED_CLIENT_EVENTS };
