// Gateway settlement webhooks — the PRIMARY settlers of the money path.
// Everything else that settles money (the sweep cron) is a reconciliation of
// what these missed, and reuses the same checkoutSettle helpers.
//
// Mount (integrator-owned, app.js): BEFORE the global express.json parser and
// BEFORE the global rate limiter, exactly like shopify-webhook — this router
// parses its own body with rawBody capture for signature verification:
//   app.use('/api/v1/gateway-webhooks', gatewayWebhookRoutes);
//
// Fail-closed: a request whose signature cannot be verified never touches
// money state. Unknown-but-authentic payments land in co_unmatched_payments
// (an operator queue), never a silent drop.
import { Router, json } from 'express';
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from '../services/checkoutSchema.js';
import { resolveCredential } from '../services/gatewayConfigs.js';
import { settleSessionPaid } from '../services/checkoutSettle.js';
import * as stripeGw from '../services/gateways/stripe.js';

const router = Router();

// Raw-body capture. If an upstream parser already consumed the stream this
// is a no-op, req.rawBody stays undefined, and signature checks fail closed —
// a mis-mount can reject real events but can never let a forged one through.
router.use(json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Forensics row for an AUTHENTIC webhook (post-signature). Idempotent on
// (gateway, id); returns false when the event id was already recorded AND
// fully processed — the caller may then skip straight to the ack.
async function recordWebhookEvent(gateway, eventId, eventType, payload) {
  const rows = await pgQuery(
    `INSERT INTO co_webhook_events (gateway, id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (gateway, id) DO NOTHING
     RETURNING id`,
    [gateway, eventId, eventType, payload]
  );
  return rows.length > 0;
}

async function markProcessed(gateway, eventId, outcome) {
  // First outcome wins — a redelivery must not overwrite the forensic record
  // of what the original delivery actually did.
  await pgQuery(
    `UPDATE co_webhook_events
     SET processed_at = COALESCE(processed_at, NOW()),
         outcome = COALESCE(outcome, $3)
     WHERE gateway = $1 AND id = $2`,
    [gateway, eventId, outcome]
  );
}

// Idempotent operator-queue write for real money we cannot attribute.
async function recordUnmatched(webhookId, gateway, amount, currency, payload, reason) {
  await pgQuery(
    `INSERT INTO co_unmatched_payments (webhook_id, gateway, amount, currency, payload, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (webhook_id) DO NOTHING`,
    [webhookId, gateway, amount, currency, payload, reason]
  );
}

// ── Stripe: payment_intent.succeeded → settle processing → paid ────────────
router.post('/stripe', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const raw = req.rawBody;
    const sig = req.get('stripe-signature') || '';
    const event = req.body;
    if (!raw || !event || typeof event !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'bad_payload' } });
    }
    const etype = event.type || '';
    const eventId = String(event.id || '');
    const obj = event.data?.object || {};
    if (etype !== 'payment_intent.succeeded') {
      return res.json({ success: true, ignored: etype });
    }

    // Locate the session FIRST — its funnel decides which signing secret
    // verifies this event (per-funnel creds, env fallback).
    const sessionId = obj.metadata?.co_session_id || '';
    const sessions = sessionId
      ? await pgQuery(`SELECT id, funnel_id, status FROM co_sessions WHERE id = $1`, [sessionId])
      : [];
    const session = sessions[0] || null;

    const signingSecret = await resolveCredential(
      session?.funnel_id || '', 'stripe', 'webhook_secret'
    );
    if (!signingSecret || !stripeGw.verifyWebhookSignature(raw, sig, signingSecret)) {
      // Fail-closed: unverifiable events never touch money state.
      return res.status(403).json({ success: false, error: { code: 'bad_signature' } });
    }

    if (!session) {
      // AUTHENTIC payment with no session we know — real money we cannot
      // attribute. Queue for an operator, ack so Stripe stops retrying.
      await recordUnmatched(
        eventId || `pi:${obj.id || 'unknown'}`, 'stripe',
        stripeGw.minorToAmount(obj.amount_received ?? obj.amount ?? 0, obj.currency || 'usd'),
        String(obj.currency || 'usd').toUpperCase(),
        event, sessionId ? 'unknown_session' : 'no_session_metadata'
      );
      return res.json({ success: true, unknown_session: true });
    }

    if (eventId) await recordWebhookEvent('stripe', eventId, etype, event);

    if (session.status === 'paid') {
      // Redelivery guard — settle already ran for this session.
      if (eventId) await markProcessed('stripe', eventId, 'already_paid');
      return res.json({ success: true, already: true });
    }

    // Re-fetch the AUTHORITATIVE PI (amount/PM/customer) with the secret key —
    // the posted payload's numbers are never trusted for money.
    const secretKey = await resolveCredential(session.funnel_id || '', 'stripe', 'secret_key');
    const pi = await stripeGw.retrievePaymentIntent(secretKey, obj.id || '');
    if (!pi.ok) {
      // Transient — 502 so Stripe redelivers; nothing was written.
      return res.status(502).json({ success: false, error: { code: 'pi_fetch_failed' } });
    }
    if (pi.status !== 'succeeded') {
      if (eventId) await markProcessed('stripe', eventId, `pi_status_${pi.status}`);
      return res.json({ success: true, ignored: `pi_status_${pi.status}` });
    }

    const result = await settleSessionPaid({
      sessionId: session.id,
      gateway: 'stripe',
      gatewayId: pi.id,
      idempotencyKey: `st_${pi.id}`,
      amount: pi.amount,
      currency: pi.currency,
      paymentMethodId: pi.payment_method_id,
      paymentMethodType: pi.payment_method_type,
      customerId: pi.customer_id,
      payerEmail: pi.payer_email,
    });

    if (!result.ok) {
      if (eventId) await markProcessed('stripe', eventId, `error_${result.error}`);
      if (result.error === 'amount_mismatch') {
        // Parked at needs_review — ack (409 would make Stripe hammer a
        // mismatch that needs a human, not a retry).
        return res.status(409).json({ success: false, error: { code: 'amount_mismatch' } });
      }
      return res.status(500).json({ success: false, error: { code: result.error } });
    }
    if (eventId) {
      await markProcessed('stripe', eventId, result.settled ? 'settled' : 'already_settled');
    }
    return res.json({ success: true, settled: result.settled, already: result.already });
  } catch (err) {
    console.error('[gatewayWebhooks] stripe failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
