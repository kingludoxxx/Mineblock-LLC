// Klaviyo event pipeline — DORMANT call-sites edition. The two fire functions
// are exported for the integrator to wire into the money path with ONE line
// each (house pattern, same as firePurchaseConversion — see the call-site map
// at the bottom). Nothing imports this file yet; shipping it cannot change
// money behavior.
//
// Idempotency is TWO-LAYER:
//   1. ours — lb_integration_sends (kind, ref) atomic claim taken BEFORE the
//      network call (money-path claim style); a redelivered webhook or double
//      settle dedups at the DB. A FAILED send releases its claim for retry.
//   2. Klaviyo's — the same id rides the Events API unique_id, so even a
//      release/re-claim race can't double-count on their side.
//
// FIRE-AND-FORGET: both functions NEVER throw (every path returns
// { ok, … }), and callers should still detach them house-style:
// `fireKlaviyoOrderEvent(session.id).catch(() => {});`
import { pgQuery } from '../db/pg.js';
import { claimSend, releaseSend } from './integrationsSchema.js';
import { getKlaviyoConfig, upsertProfile, trackEvent } from './klaviyoService.js';

const KIND = 'klaviyo';

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

// Shared core. Both wrappers resolve config first and go quiet when the
// integration is off — an unconfigured Klaviyo must cost the caller nothing.
async function fireCore(sessionId, { ref, metric, requirePaid }) {
  try {
    const cfg = await getKlaviyoConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, skipped: true, error: 'not_configured' };

    const session = await loadSession(sessionId);
    if (!session) return { ok: false, error: 'session_not_found' };
    // Money truth: 'Placed Order' only for a PAID session (processing != paid).
    if (requirePaid && session.status !== 'paid') {
      return { ok: false, error: `not_paid:${session.status}` };
    }
    const who = customerBits(session);
    if (!who.email) return { ok: false, error: 'no_email' };

    // Exactly-once at OUR layer: claim before the network call.
    const claimed = await claimSend(KIND, ref);
    if (!claimed) return { ok: true, deduped: true };

    // Profile first (best-effort — an event still attributes by email even
    // if the profile upsert hiccuped, so a profile failure does not abort).
    const prof = await upsertProfile({
      email: who.email,
      first_name: who.first_name,
      last_name: who.last_name,
      phone: who.phone,
      properties: {
        ...(who.city ? { city: who.city } : {}),
        ...(who.country ? { country: who.country } : {}),
      },
    }, { apiKey: cfg.apiKey });

    const orders = await pgQuery(
      `SELECT id FROM co_orders WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [session.id]
    );
    const when = session.paid_at || session.created_at;
    const sent = await trackEvent({
      metric_name: metric,
      email: who.email,
      value: Number(session.total) || 0,
      unique_id: ref,
      time: when instanceof Date ? when.toISOString() : undefined,
      properties: {
        session_id: session.id,
        funnel_id: session.funnel_id || '',
        currency: session.currency || 'USD',
        items: itemsSummary(session.line_items),
        ...(orders.length ? { order_id: orders[0].id } : {}),
      },
    }, { apiKey: cfg.apiKey });

    if (!sent.ok) {
      // The event never landed: release the claim so a retry can re-attempt.
      // Klaviyo's unique_id dedup backstops any race.
      await releaseSend(KIND, ref).catch(() => {});
      return { ok: false, error: sent.error, profile_ok: prof.ok };
    }
    return { ok: true, profile_ok: prof.ok };
  } catch (err) {
    // Never throw into a caller — a marketing failure must not touch money.
    console.error(`[klaviyoEvents] ${metric} for ${String(sessionId).slice(0, 80)} failed:`, err.message);
    return { ok: false, error: `internal:${err.code || err.name || 'error'}` };
  }
}

// 'Placed Order' for a SETTLED (paid) session. unique_id ko_<session_id>.
//
// INTEGRATOR CALL-SITES (one line each, NEXT TO the existing
// firePurchaseConversion calls — this branch does not touch those files):
//   server/src/routes/gatewayWebhooks.js:410
//     if (result.ok) fireKlaviyoOrderEvent(session.id).catch(() => {});
//   server/src/routes/gatewayWebhooks.js:722
//     if (result.ok) fireKlaviyoOrderEvent(session.id).catch(() => {});
//   (import: `import { fireKlaviyoOrderEvent } from '../services/klaviyoEvents.js';`)
export function fireKlaviyoOrderEvent(sessionId) {
  return fireCore(sessionId, {
    ref: `ko_${String(sessionId || '').slice(0, 80)}`,
    metric: 'Placed Order',
    requirePaid: true,
  });
}

// 'Started Checkout' for an email-captured-but-not-paid session. unique_id
// kl_<session_id>. No paid gate — a lead is a lead.
//
// INTEGRATOR CALL-SITE (one line, in checkoutPublic.js where create-session /
// update-customer first persists a non-empty customer.email):
//     if (customer.email) fireKlaviyoLeadEvent(session.id).catch(() => {});
//   (import: `import { fireKlaviyoLeadEvent } from '../services/klaviyoEvents.js';`)
export function fireKlaviyoLeadEvent(sessionId) {
  return fireCore(sessionId, {
    ref: `kl_${String(sessionId || '').slice(0, 80)}`,
    metric: 'Started Checkout',
    requirePaid: false,
  });
}

export default { fireKlaviyoOrderEvent, fireKlaviyoLeadEvent };
