// Order journey — the full event trail for ONE order, aggregated across the
// four systems that touch a funnel checkout.
//
// STRICTLY READ-ONLY. Nothing in this module writes, and nothing in it calls a
// gateway. It is the porting of funnel-os's lb_order_journey_service into our
// data model: theirs assembles acquisition touches out of Mongo collections,
// ours assembles the post-checkout trail out of our Postgres tables.
//
// The link chain, and why it is what it is:
//   crm_orders.order_id  IS the Shopify order id (crm_orders is the Shopify
//   mirror). The checkout session that produced it is reachable ONLY through
//   co_orders, the settlement row, which carries both:
//       co_orders.shopify_order_id  →  co_orders.session_id
//   There is no other join. An order that was imported straight from Shopify
//   (no funnel checkout behind it) therefore has NO session, and that is a
//   legitimate answer — reported as linked:false with a reason, never as an
//   empty timeline that looks like data loss.
//
// Sources, once a session_id is known:
//   co_events            session_created / paid / upsell_settled / payment_failed /
//                        shopify_order_* …          (session_id = sid)
//   co_upsell_charges    one row per upsell charge ATTEMPT, accept and decline
//   lb_tracking_events   event_id = pur_<sid>  (base purchase conversion)
//                        event_id LIKE pur_<sid>_u_%   (per-upsell conversion)
//                        event_id LIKE cl_%<sid>%      (client-relayed, namespaced
//                                                       under CLIENT_EVENT_ID_PREFIX)
//   lb_integration_sends ref = ko_<sid>   Klaviyo 'Placed Order'
//                        ref = kl_<sid>   Klaviyo lead
//                        ref LIKE ku_<sid>_%  Klaviyo upsell
//   co_sessions.refunds  the refund ledger on the session
//
// Missing-table honesty: checkout may not be provisioned in a given deployment,
// so a source whose table does not exist is reported by NAME in
// `sources_unavailable` rather than contributing zero rows silently. An empty
// timeline and an unprovisioned system are different facts and the UI says so.
import { pgQuery } from '../db/pg.js';

// Every table this aggregation reads. Presence is probed once per call.
const SOURCE_TABLES = [
  'co_orders',
  'co_sessions',
  'co_events',
  'co_upsell_charges',
  'lb_tracking_events',
  'lb_integration_sends',
];

// Human titles for the co_events kinds our checkout actually emits. An unknown
// kind is NOT dropped — it falls through to a de-snaked label, so a new event
// kind shipped by the checkout lane shows up here the day it lands.
const EVENT_TITLES = {
  session_created: 'Checkout session created',
  paid: 'Payment captured',
  payment_failed: 'Payment failed',
  upsell_settled: 'Upsell settled',
  upsell_declined: 'Upsell declined',
  upsell_declined_by_user: 'Upsell declined by customer',
  shopify_order_created: 'Shopify order created',
  shopify_order_adopted: 'Shopify order adopted',
  shopify_order_needs_review: 'Shopify order needs review',
};

const titleize = (s) =>
  String(s || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

// Which co_upsell_charges statuses mean money moved vs a human owes attention.
const UPSELL_FAILED = new Set(['needs_review', 'canceled']);
const UPSELL_COLLECTED = new Set(['settled', 'charged', 'paid']);

async function existingTables() {
  const rows = await pgQuery(
    `SELECT t AS name, to_regclass(t) IS NOT NULL AS present
     FROM unnest($1::text[]) AS t`,
    [SOURCE_TABLES]
  );
  const present = new Set(rows.filter((r) => r.present).map((r) => r.name));
  return { present, missing: SOURCE_TABLES.filter((t) => !present.has(t)) };
}

// Resolve the checkout session behind a Shopify-mirrored order. Returns null
// when the order never came through our checkout (a plain Shopify import).
export async function sessionIdForOrder(orderId, present) {
  if (!present.has('co_orders')) return null;
  const rows = await pgQuery(
    `SELECT session_id, shopify_order_id, shopify_order_number, shopify_status,
            shopify_created_at, external_order_id, gateway, total, currency, created_at
     FROM co_orders
     WHERE shopify_order_id = $1::text
     ORDER BY created_at ASC
     LIMIT 1`,
    [String(orderId)]
  );
  return rows[0] || null;
}

function shopifyAdminUrl(shopifyOrderId) {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  if (!store || !shopifyOrderId) return null;
  return `https://${store}/admin/orders/${shopifyOrderId}`;
}

/**
 * Build the journey for one crm_orders row.
 *
 * @param {string|number} orderId  crm_orders.order_id (the Shopify order id)
 * @param {object} order           the already-loaded crm_orders row
 * @returns {Promise<object>}      { linked, session_id, shopify, entries[], counts, sources_unavailable }
 */
export async function buildOrderJourney(orderId, order = {}) {
  const { present, missing } = await existingTables();

  const link = await sessionIdForOrder(orderId, present);
  const sid = link?.session_id || null;

  const shopify = {
    order_id: order.shopify_order_id ? String(order.shopify_order_id) : String(orderId),
    order_number: order.order_number || link?.shopify_order_number || null,
    status: link?.shopify_status || null,
    admin_url: shopifyAdminUrl(order.shopify_order_id || orderId),
  };

  const entries = [];
  const counts = { checkout: 0, upsell: 0, tracking: 0, klaviyo: 0, refund: 0 };

  // The Shopify mirror itself is always a real, dateable fact about the order.
  entries.push({
    source: 'shopify',
    kind: 'shopify_order',
    ts: link?.shopify_created_at || order.created_at || null,
    title: 'Shopify order',
    detail: shopify.order_number ? `Order ${shopify.order_number}` : `Order ${shopify.order_id}`,
    payload: {
      shopify_order_id: shopify.order_id,
      shopify_status: shopify.status,
      admin_url: shopify.admin_url,
    },
  });

  if (!sid) {
    return {
      linked: false,
      link_reason: present.has('co_orders')
        ? 'No checkout session is linked to this Shopify order — it was imported directly from the store, not placed through a funnel checkout.'
        : 'The checkout tables are not provisioned in this deployment, so no session can be linked.',
      session_id: null,
      shopify,
      entries,
      counts,
      sources_unavailable: missing,
    };
  }

  // ── co_events: the checkout spine ────────────────────────────────────────
  if (present.has('co_events')) {
    const rows = await pgQuery(
      `SELECT id, kind, data, created_at FROM co_events
       WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [sid]
    );
    counts.checkout = rows.length;
    for (const r of rows) {
      entries.push({
        source: 'checkout',
        kind: r.kind,
        ts: r.created_at,
        title: EVENT_TITLES[r.kind] || titleize(r.kind),
        detail: null,
        payload: r.data || null,
      });
    }
  }

  // ── co_upsell_charges: one row per charge ATTEMPT (accept AND decline) ───
  if (present.has('co_upsell_charges')) {
    const rows = await pgQuery(
      `SELECT id, offer_id, charge_id, amount, currency, status,
              declined_by_user, created_at
       FROM co_upsell_charges
       WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [sid]
    );
    counts.upsell = rows.length;
    for (const r of rows) {
      const failed = UPSELL_FAILED.has(r.status);
      entries.push({
        source: 'upsell',
        kind: failed ? 'upsell_charge_failed' : 'upsell_charge',
        ts: r.created_at,
        title: r.declined_by_user
          ? 'Upsell declined by customer'
          : failed
            ? 'Upsell charge needs review'
            : UPSELL_COLLECTED.has(r.status)
              ? 'Upsell charged'
              : `Upsell ${titleize(r.status).toLowerCase()}`,
        detail: `${r.offer_id} · ${r.currency || 'USD'} ${Number(r.amount || 0).toFixed(2)}`,
        failed,
        payload: {
          offer_id: r.offer_id,
          charge_id: r.charge_id,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          declined_by_user: r.declined_by_user,
        },
      });
    }
  }

  // ── lb_tracking_events: the conversion sends keyed to this session ───────
  // event_id is minted as pur_<sid> (base) and pur_<sid>_u_<row> (upsell);
  // a client-relayed echo is namespaced 'cl_' ahead of whatever it claimed.
  if (present.has('lb_tracking_events')) {
    const rows = await pgQuery(
      `SELECT id, platform, pixel_id, event_name, event_id, status, source,
              emq, value, error, ts
       FROM lb_tracking_events
       WHERE event_id = $1 OR event_id LIKE $2 OR event_id LIKE $3
       ORDER BY ts ASC, id ASC`,
      [`pur_${sid}`, `pur_${sid}\\_u\\_%`, `cl\\_%${sid}%`]
    );
    counts.tracking = rows.length;
    for (const r of rows) {
      const failed = r.status === 'error' || !!r.error;
      entries.push({
        source: 'tracking',
        kind: failed ? 'tracking_failed' : 'tracking_sent',
        ts: r.ts,
        title: `${titleize(r.platform || 'pixel')} · ${r.event_name || 'event'}`,
        detail: [r.status, r.emq != null ? `EMQ ${r.emq}` : null].filter(Boolean).join(' · '),
        failed,
        payload: {
          platform: r.platform,
          pixel_id: r.pixel_id,
          event_id: r.event_id,
          status: r.status,
          source: r.source,
          emq: r.emq,
          value: r.value,
          error: r.error,
        },
      });
    }
  }

  // ── lb_integration_sends: Klaviyo claims (ko_ order, kl_ lead, ku_ upsell) ─
  if (present.has('lb_integration_sends')) {
    const rows = await pgQuery(
      `SELECT kind, ref, created_at FROM lb_integration_sends
       WHERE ref = $1 OR ref = $2 OR ref LIKE $3
       ORDER BY created_at ASC, ref ASC`,
      [`ko_${sid}`, `kl_${sid}`, `ku_${sid}\\_%`]
    );
    counts.klaviyo = rows.length;
    const REF_TITLE = { ko: 'Klaviyo · Placed Order', kl: 'Klaviyo · Lead', ku: 'Klaviyo · Upsell' };
    for (const r of rows) {
      const prefix = String(r.ref).slice(0, 2);
      entries.push({
        source: 'klaviyo',
        kind: 'integration_send',
        ts: r.created_at,
        title: REF_TITLE[prefix] || `${titleize(r.kind)} send`,
        detail: r.ref,
        payload: { kind: r.kind, ref: r.ref },
      });
    }
  }

  // ── co_sessions.refunds: the refund ledger carried on the session ────────
  let session = null;
  if (present.has('co_sessions')) {
    const rows = await pgQuery(
      `SELECT id, status, total, currency, gateway, refunds, needs_review_reason,
              paid_at, created_at
       FROM co_sessions WHERE id = $1`,
      [sid]
    );
    session = rows[0] || null;
    const refunds = Array.isArray(session?.refunds) ? session.refunds : [];
    counts.refund = refunds.length;
    for (const r of refunds) {
      entries.push({
        source: 'refund',
        kind: 'refund',
        ts: r.created_at || r.ts || r.at || null,
        title: 'Refund',
        detail: `${r.currency || session?.currency || 'USD'} ${Number(r.amount || 0).toFixed(2)}`,
        payload: r,
      });
    }
  }

  // Chronological. A null ts sorts LAST rather than pretending to be epoch 0 —
  // an undated fact is not an ancient one.
  entries.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : Number.POSITIVE_INFINITY;
    const tb = b.ts ? new Date(b.ts).getTime() : Number.POSITIVE_INFINITY;
    return ta - tb;
  });

  return {
    linked: true,
    link_reason: null,
    session_id: sid,
    session: session
      ? {
          id: session.id,
          status: session.status,
          total: session.total,
          currency: session.currency,
          gateway: session.gateway,
          needs_review_reason: session.needs_review_reason,
          paid_at: session.paid_at,
          created_at: session.created_at,
        }
      : null,
    shopify,
    entries,
    counts,
    sources_unavailable: missing,
  };
}

export default { buildOrderJourney, sessionIdForOrder };
