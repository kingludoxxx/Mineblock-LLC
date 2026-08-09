// Klaviyo event pipeline — DORMANT call-sites edition. The fire functions
// are exported for the integrator to wire into the money path with ONE line
// each (house pattern, same as firePurchaseConversion — see the call-site map
// at the bottom). Nothing imports this file yet; shipping it cannot change
// money behavior.
//
// Idempotency is TWO-LAYER:
//   1. ours — lb_integration_sends (kind, ref) atomic claim taken BEFORE the
//      network call (money-path claim style); a redelivered webhook or double
//      settle dedups at the DB. A claim whose send did NOT reach Klaviyo is
//      RELEASED — on the {ok:false} path AND in the catch (review fix MED#2:
//      a throw between claim and send used to orphan the claim, turning every
//      retry into deduped:true while Klaviyo had received nothing). All DB
//      reads now happen BEFORE the claim, so the claim-to-send window holds
//      only the send calls themselves.
//   2. Klaviyo's — the same id rides the Events API unique_id, so even a
//      release/re-claim race can't double-count on their side.
//
// FIRE-AND-FORGET, NON-RETRYING (review #4, accepted posture — matches
// tracking): both functions NEVER throw (every path returns { ok, … }), and
// there is NO retry queue — a Klaviyo outage DROPS marketing events by
// design; a released claim only means a caller-side redelivery (webhook
// replay, sweep) may re-attempt. Callers should still detach house-style:
// `fireKlaviyoOrderEvent(session.id).catch(() => {});`
//
// PII SCOPE (review fix MED#3 — DECISION MADE, conservative, flagged for
// operator review): the non-paid 'Started Checkout' lead path upserts the
// profile with EMAIL ONLY (no name/phone/address) and strips event
// properties to { item_count, funnel_id } (plus the value attribute). Full
// contact PII ships only on the PAID paths ('Placed Order' /
// 'Placed Upsell Order'), where the buyer has completed a purchase.
import { pgQuery } from '../db/pg.js';
import { claimSend, releaseSend } from './integrationsSchema.js';
import { getKlaviyoConfig, upsertProfile, trackEvent } from './klaviyoService.js';

const KIND = 'klaviyo';

// Test seam (review MED#2 harness): fireCore delivers through this mutable
// indirection so the harness can force a THROW between claim and send and
// prove the claim gets released. Production behavior is identical.
export const _deps = { upsertProfile, trackEvent };

async function loadSession(sessionId) {
  const rows = await pgQuery(
    `SELECT id, funnel_id, status, line_items, total, currency, customer, paid_at, created_at
     FROM co_sessions WHERE id = $1`,
    [String(sessionId || '').slice(0, 80)]
  );
  return rows.length ? rows[0] : null;
}

function customerBits(session) {
  const c = session.customer && typeof session.customer === 'object' ? session.customer : {};
  const ship = c.shipping && typeof c.shipping === 'object' ? c.shipping : {};
  return {
    email: typeof c.email === 'string' ? c.email : '',
    first_name: typeof c.first_name === 'string' ? c.first_name : '',
    last_name: typeof c.last_name === 'string' ? c.last_name : '',
    phone: typeof c.phone === 'string' ? c.phone : '',
    city: typeof ship.city === 'string' ? ship.city : '',
    country: typeof ship.country === 'string' ? ship.country : '',
  };
}

function itemsSummary(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  return items.slice(0, 50).map((it) => ({
    title: typeof it.title === 'string' ? it.title.slice(0, 200) : '',
    variant_id: it.variant_id !== undefined ? String(it.variant_id).slice(0, 64) : '',
    quantity: Number(it.quantity) || 0,
    price: Number(it.price) || 0,
  }));
}

function itemCount(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  return items.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
}

// Loud, greppable orphan report — a claim that could not be released blocks
// its event until the lb_integration_sends row is deleted by hand.
async function releaseOrReport(ref, where) {
  try {
    await releaseSend(KIND, ref);
  } catch (relErr) {
    console.error(`[klaviyoEvents] ORPHANED CLAIM ${KIND}/${ref} — ${where} release failed (${relErr.message}); delete the lb_integration_sends row by hand to re-enable this event`);
  }
}

// Shared core. Wrappers resolve config first and go quiet when the
// integration is off — an unconfigured Klaviyo must cost the caller nothing.
// `lean` = email-only profile + stripped properties (the MED#3 lead scope).
async function fireCore(sessionId, { ref, metric, requirePaid, lean = false, value, extraProps = {} }) {
  let claimed = false;
  let delivered = false;
  try {
    const cfg = await getKlaviyoConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, skipped: true, error: 'not_configured' };

    const session = await loadSession(sessionId);
    if (!session) return { ok: false, error: 'session_not_found' };
    // Money truth: paid metrics only for a PAID session (processing != paid).
    if (requirePaid && session.status !== 'paid') {
      return { ok: false, error: `not_paid:${session.status}` };
    }
    const who = customerBits(session);
    if (!who.email) return { ok: false, error: 'no_email' };

    // Everything is read + shaped BEFORE the claim (review MED#2): the window
    // between claim and send holds only the send calls themselves.
    let orderId = '';
    if (!lean) {
      const orders = await pgQuery(
        `SELECT id FROM co_orders WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [session.id]
      );
      orderId = orders.length ? orders[0].id : '';
    }
    const when = session.paid_at || session.created_at;
    const profilePayload = lean
      ? { email: who.email } // MED#3: lead path is email-only
      : {
          email: who.email,
          first_name: who.first_name,
          last_name: who.last_name,
          phone: who.phone,
          properties: {
            ...(who.city ? { city: who.city } : {}),
            ...(who.country ? { country: who.country } : {}),
          },
        };
    const eventProps = lean
      ? { item_count: itemCount(session.line_items), funnel_id: session.funnel_id || '' }
      : {
          session_id: session.id,
          funnel_id: session.funnel_id || '',
          currency: session.currency || 'USD',
          items: itemsSummary(session.line_items),
          ...(orderId ? { order_id: orderId } : {}),
          ...extraProps,
        };

    // Exactly-once at OUR layer: claim before the network calls.
    claimed = await claimSend(KIND, ref);
    if (!claimed) return { ok: true, deduped: true };

    // Profile first (best-effort — an event still attributes by email even
    // if the profile upsert hiccuped, so a profile failure does not abort).
    const prof = await _deps.upsertProfile(profilePayload, { apiKey: cfg.apiKey });

    const sent = await _deps.trackEvent({
      metric_name: metric,
      email: who.email,
      value: value !== undefined ? value : Number(session.total) || 0,
      unique_id: ref,
      time: when instanceof Date ? when.toISOString() : undefined,
      properties: eventProps,
    }, { apiKey: cfg.apiKey });
    delivered = sent.ok;

    if (!sent.ok) {
      // The event never landed: release the claim so a retry can re-attempt.
      // Klaviyo's unique_id dedup backstops any race.
      await releaseOrReport(ref, 'failed-send');
      return { ok: false, error: sent.error, profile_ok: prof.ok };
    }
    return { ok: true, profile_ok: prof.ok };
  } catch (err) {
    // Never throw into a caller — a marketing failure must not touch money.
    console.error(`[klaviyoEvents] ${metric} for ${String(sessionId).slice(0, 80)} failed:`, err.message);
    // Review MED#2: a throw after the claim but before a delivered send must
    // release the claim, or the event is lost forever behind deduped:true.
    if (claimed && !delivered) await releaseOrReport(ref, 'error-path');
    return { ok: false, error: `internal:${err.code || err.name || 'error'}` };
  }
}

// 'Placed Order' for a SETTLED (paid) session. unique_id ko_<session_id>.
export function fireKlaviyoOrderEvent(sessionId) {
  return fireCore(sessionId, {
    ref: `ko_${String(sessionId || '').slice(0, 80)}`,
    metric: 'Placed Order',
    requirePaid: true,
  });
}

// 'Started Checkout' for an email-captured-but-not-paid session. unique_id
// kl_<session_id>. No paid gate — a lead is a lead. LEAN scope (MED#3):
// email-only profile, properties { item_count, funnel_id } only.
export function fireKlaviyoLeadEvent(sessionId) {
  return fireCore(sessionId, {
    ref: `kl_${String(sessionId || '').slice(0, 80)}`,
    metric: 'Started Checkout',
    requirePaid: false,
    lean: true,
  });
}

// 'Placed Upsell Order' for a settled upsell charge (review #5). Paid-gated
// on the PARENT session; unique_id ku_<session_id>_<chargeRowId> — the same
// (session, charge-row) granularity as the tracking twin
// (fireUpsellPurchaseConversion, pur_<sid>_u_<chargeRowId>), so a replayed
// settle dedups per charge row while two DIFFERENT upsells both send. Value
// is the upsell charge amount, not the session total.
export function fireKlaviyoUpsellEvent(sessionId, chargeRowId, amount) {
  const sid = String(sessionId || '').slice(0, 80);
  const row = String(chargeRowId || '').slice(0, 64);
  if (!row) return Promise.resolve({ ok: false, error: 'charge_row_required' });
  return fireCore(sid, {
    ref: `ku_${sid}_${row}`,
    metric: 'Placed Upsell Order',
    requirePaid: true,
    value: Number(amount) || 0,
    extraProps: { charge_row: row },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// INTEGRATOR CALL-SITE MAP (one line each; this branch touches none of these
// files — line refs are the main-branch 553576f region; anchor on the named
// existing call, not the line number).
//
// import lines (top of each file):
//   import { fireKlaviyoOrderEvent } from '../services/klaviyoEvents.js';
//   import { fireKlaviyoLeadEvent } from '../services/klaviyoEvents.js';
//   import { fireKlaviyoUpsellEvent } from './klaviyoEvents.js';   // from checkoutSettle.js
//
// 1. Placed Order — server/src/routes/gatewayWebhooks.js, NEXT TO each of the
//    two existing firePurchaseConversion calls (:410 and :722):
//      if (result.ok) fireKlaviyoOrderEvent(session.id).catch(() => {});
//
// 2. Placed Upsell Order — server/src/services/checkoutSettle.js, next to the
//    existing fireUpsellPurchaseConversion call (~:206 region; variables
//    `row`, `chargeRowId`):
//      fireKlaviyoUpsellEvent(row.session_id, chargeRowId, Number(row.amount)).catch(() => {});
//
// 3. Started Checkout — server/src/routes/checkoutPublic.js, TWO sites:
//    a. create-session, right after the co_sessions INSERT succeeds
//       (variables `sessionId`, `body` — customer comes from cleanCustomer):
//         if (cleanCustomer(body).email) fireKlaviyoLeadEvent(sessionId).catch(() => {});
//    b. POST /session/:id/customer, right after the customer UPDATE
//       (variables `customer`, `id`):
//         if (customer.email) fireKlaviyoLeadEvent(id).catch(() => {});
// ────────────────────────────────────────────────────────────────────────────

export default { fireKlaviyoOrderEvent, fireKlaviyoLeadEvent, fireKlaviyoUpsellEvent };
