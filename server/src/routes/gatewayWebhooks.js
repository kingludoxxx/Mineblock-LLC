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
import {
  settleSessionPaid,
  settleUpsellCharge,
  failUpsellCharge,
} from '../services/checkoutSettle.js';
import * as stripeGw from '../services/gateways/stripe.js';
import * as whopGw from '../services/gateways/whop.js';

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

// ── Whop: payment.succeeded / payment.failed (Standard-Webhooks signed) ────
// metadata.kind discriminates WHICH charge settled: absent/'0' = the base
// checkout payment, 'upsell' = an async 1-click charge previously held at
// pending_settlement. The webhook is the authority that settles or fails it.
router.post('/whop', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const raw = req.rawBody;
    const event = req.body;
    if (!raw || !event || typeof event !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'bad_payload' } });
    }
    const eventType = event.type || '';
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const webhookId = req.get('webhook-id') || '';

    // The trust anchor is NEVER body-picked: the session referenced by
    // metadata.co_session_id resolves (server-side) to its funnel, whose
    // stored secret — or the platform env secret — verifies the event.
    const sessionId = String(metadata.co_session_id || '');
    const sessions = sessionId
      ? await pgQuery(
        `SELECT id, funnel_id, status, total, currency FROM co_sessions WHERE id = $1`,
        [sessionId]
      )
      : [];
    const session = sessions[0] || null;
    const secret = await resolveCredential(session?.funnel_id || '', 'whop', 'webhook_secret');
    if (!secret || !whopGw.verifyWebhookSignature(raw, req.headers, secret)) {
      return res.status(401).json({ success: false, error: { code: 'invalid_signature' } });
    }
    if (!webhookId) {
      // Verified but nothing to dedupe on — refuse rather than risk a double
      // fulfillment (Whop always sends webhook-id; absence is anomalous).
      return res.status(400).json({ success: false, error: { code: 'missing_webhook_id' } });
    }

    // Idempotency on the webhook id: first delivery inserts, a redelivery of
    // a PROCESSED id acks; a redelivery of an unprocessed id (prior attempt
    // died mid-flight) re-drives the handler — every handler is idempotent on
    // its own per-charge key, so a re-drive can never double-move money.
    const fresh = await recordWebhookEvent('whop', webhookId, eventType, event);
    if (!fresh) {
      const [existing] = await pgQuery(
        `SELECT processed_at FROM co_webhook_events WHERE gateway = 'whop' AND id = $1`,
        [webhookId]
      );
      if (existing?.processed_at) {
        return res.json({ success: true, duplicate: true });
      }
    }

    if (eventType !== 'payment.succeeded' && eventType !== 'payment.failed') {
      await markProcessed('whop', webhookId, `ignored_${eventType || 'unknown'}`);
      return res.json({ success: true, ignored: eventType });
    }

    const kindRaw = String(metadata.kind || '').trim();
    const kind = kindRaw === '0' ? '' : kindRaw;
    const paymentId = String(data.id || '');

    // ── kind=upsell: settle/fail the pending 1-click charge row ──
    if (kind === 'upsell') {
      const chargeRowId = String(metadata.charge_row || '');
      if (!chargeRowId) {
        await markProcessed('whop', webhookId, 'upsell_missing_charge_row');
        return res.json({ success: true, ignored: 'missing_charge_row' });
      }
      if (eventType === 'payment.failed') {
        const { reason } = whopGw.extractDecline(data);
        await failUpsellCharge({ chargeRowId, reason: reason || 'payment_failed' });
        await markProcessed('whop', webhookId, 'upsell_failed');
        return res.json({ success: true, upsell: 'failed' });
      }
      const result = await settleUpsellCharge({
        chargeRowId,
        gatewayPaymentId: paymentId,
        amount: whopGw.extractGrossAmount(data),
      });
      await markProcessed(
        'whop', webhookId,
        result.ok ? (result.already ? 'upsell_already' : 'upsell_settled') : `upsell_${result.error}`
      );
      return res.json({ success: true, upsell: result.ok ? 'settled' : result.error });
    }

    // ── base payment ──
    if (!session) {
      if (eventType === 'payment.succeeded') {
        await recordUnmatched(
          webhookId, 'whop',
          whopGw.extractGrossAmount(data) ?? whopGw.extractAmountAfterFees(data),
          String(data.currency || 'USD').toUpperCase(),
          event, sessionId ? 'unknown_session' : 'no_session_metadata'
        );
      }
      await markProcessed('whop', webhookId, 'unknown_session');
      return res.json({ success: true, unknown_session: true });
    }

    if (eventType === 'payment.failed') {
      // Not money moved — remember the failed payment id (recovered-payment
      // matching) and leave the session at processing.
      await pgQuery(
        `UPDATE co_sessions SET last_failed_payment_id = $2, updated_at = NOW() WHERE id = $1`,
        [session.id, paymentId || null]
      );
      try {
        const { reason } = whopGw.extractDecline(data);
        await pgQuery(
          `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'payment_failed', $2)`,
          [session.id, { gateway: 'whop', payment_id: paymentId, reason }]
        );
      } catch { /* non-fatal */ }
      await markProcessed('whop', webhookId, 'payment_failed');
      return res.json({ success: true, failed: true });
    }

    if (session.status === 'paid') {
      await markProcessed('whop', webhookId, 'already_paid');
      return res.json({ success: true, already: true });
    }

    // Amount authority: the Whop-reported amount reconciles against the
    // session snapshot (gross exact; net within the fee band). A mismatch
    // parks for a human and ACKS — a redelivery cannot fix a wrong amount.
    const recon = whopGw.reconcileAmount({
      expectedTotal: Number(session.total),
      grossCharged: whopGw.extractGrossAmount(data),
      amountAfterFees: whopGw.extractAmountAfterFees(data),
    });
    if (!recon.ok) {
      await pgQuery(
        `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
         WHERE id = $1 AND needs_review_reason IS NULL`,
        [session.id, `whop_${recon.reason}`.slice(0, 300)]
      );
      await markProcessed('whop', webhookId, `amount_mismatch`);
      return res.json({ success: true, needs_review: true });
    }

    const result = await settleSessionPaid({
      sessionId: session.id,
      gateway: 'whop',
      gatewayId: paymentId || `whwh_${webhookId}`,
      idempotencyKey: `wh_${paymentId || webhookId}`,
      amount: Number(session.total), // reconciled above — snapshot is the book value
      currency: session.currency,
      paymentMethodId: whopGw.extractPaymentMethodId(data),
      paymentMethodType: '', // Whop saved methods are card-backed; '' fails open to save
      customerId: whopGw.extractMemberId(data),
      payerEmail: data.user?.email || '',
    });
    await markProcessed(
      'whop', webhookId,
      result.ok ? (result.settled ? 'settled' : 'already_settled') : `error_${result.error}`
    );
    if (!result.ok) {
      return res.status(500).json({ success: false, error: { code: result.error } });
    }
    return res.json({ success: true, settled: result.settled, already: result.already });
  } catch (err) {
    console.error('[gatewayWebhooks] whop failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
