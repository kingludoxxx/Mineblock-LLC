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
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureCheckoutTables } from '../services/checkoutSchema.js';
import { resolveCredential } from '../services/gatewayConfigs.js';
import {
  settleSessionPaid,
  settleUpsellCharge,
  failUpsellCharge,
} from '../services/checkoutSettle.js';
import * as stripeGw from '../services/gateways/stripe.js';
import * as whopGw from '../services/gateways/whop.js';
import { startMoneySweeps } from '../services/moneySweeps.js';
// TRACKING-LANE HOOK (feat/tracking-attribution): fire the deterministic
// Purchase conversion (event_id = pur_<session_id>) on a base settle. Idempotent
// via lb_tracking_sent (pixel_id, event_id) UNIQUE and FULLY fire-and-forget —
// a tracking failure can never block or fail settlement (DECISIONS #16). The
// two call sites below are the only tracking-lane edits in this file.
import { firePurchaseConversion } from '../services/trackingService.js';
// SPLIT-LANE HOOK: arm crediting fires from the same post-settle points as the
// Purchase relay (both idempotent; failures never touch the webhook response).
import { creditSessionConversions, voidSessionRefund } from '../services/splitCredits.js';

const router = Router();

// The 10-minute reconciliation cron rides this module's load (same pattern
// as brandSpy's media-mirror worker) — webhooks settle, the sweep catches
// what they missed.
startMoneySweeps();

// Raw-body capture. If an upstream parser already consumed the stream this
// is a no-op, req.rawBody stays undefined, and signature checks fail closed —
// a mis-mount can reject real events but can never let a forged one through.
router.use(json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Per-IP ceiling on webhook intake. These routes are unauthenticated (the
// signature is the auth) and each request costs DB round-trips BEFORE the
// signature can be checked — the session lookup and the credential load are
// needed to know WHICH secret verifies it. Without a ceiling that is a cheap
// DB-exhaustion vector. The limit is far above any real gateway's delivery
// rate, so genuine bursts (redeliveries, backfills) pass untouched.
router.use(async (req, res, next) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const { allowed, retryAfter } = await checkRateLimit(`gwhook:${ip}`, 600, 60);
    if (!allowed) {
      return res.status(429).json({ success: false, error: { code: 'rate_limited', retryAfter } });
    }
  } catch (err) {
    // Limiter trouble must never drop a real settlement event — fail open
    // here (the signature check is the actual security boundary).
    console.error('[gatewayWebhooks] rate limit check failed (fail-open):', err.message);
  }
  return next();
});

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

// ── Refund / dispute writeback (shared by both gateways) ───────────────────
// Appends an idempotent refund entry to co_sessions.refunds (keyed by the
// gateway's refund/dispute ref) and flips status to 'refunded' when the
// cumulative refunded amount covers the total — computed inside the UPDATE
// so concurrent partial refunds can't race the status. A dispute
// additionally parks the session and cancels outstanding upsell charges so
// a chargeback never triggers another off-session charge.
async function applyRefund({ sessionId, ref, amount, gateway, isDispute }) {
  if (amount === null || amount === undefined) {
    await pgQuery(
      `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
       WHERE id = $1 AND needs_review_reason IS NULL`,
      [sessionId, `refund_amount_unknown:${ref}`.slice(0, 300)]
    );
    return { ok: false, error: 'refund_amount_unknown' };
  }
  // Raw JS arrays — postgres.js serializes them to jsonb itself; a
  // JSON.stringify here double-encodes into string elements (repo-wide rule).
  const entry = [{
    id: ref,
    amount: Math.round(Number(amount) * 100) / 100,
    gateway,
    dispute: Boolean(isDispute),
    at: new Date().toISOString(),
  }];
  const guard = [{ id: ref }];
  const rows = await pgQuery(
    `UPDATE co_sessions
     SET refunds = refunds || $2::jsonb,
         status = CASE WHEN (
           SELECT COALESCE(SUM((r->>'amount')::numeric), 0)
           FROM jsonb_array_elements(refunds || $2::jsonb) r
         ) >= total - 0.01 THEN 'refunded' ELSE status END,
         updated_at = NOW()
     WHERE id = $1 AND NOT refunds @> $3::jsonb
     RETURNING status`,
    [sessionId, entry, guard]
  );
  if (rows.length) {
    try {
      await pgQuery(
        `INSERT INTO co_events (session_id, kind, data) VALUES ($1, $2, $3)`,
        [sessionId, isDispute ? 'dispute' : 'refund', { ref, amount: Number(amount), gateway }]
      );
    } catch { /* non-fatal */ }
  }
  if (isDispute) {
    await pgQuery(
      `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
       WHERE id = $1 AND needs_review_reason IS NULL`,
      [sessionId, `dispute:${ref}`.slice(0, 300)]
    );
    await pgQuery(
      `UPDATE co_upsell_charges SET status = 'canceled',
         error = 'canceled_by_dispute', updated_at = NOW()
       WHERE session_id = $1 AND status IN ('charging', 'pending_settlement')`,
      [sessionId]
    );
  }
  return { ok: true, duplicate: !rows.length, status: rows[0]?.status };
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
    const isRefund = etype === 'charge.refunded';
    if (etype !== 'payment_intent.succeeded' && !isRefund) {
      return res.json({ success: true, ignored: etype });
    }

    // Locate the session FIRST — its funnel decides which signing secret
    // verifies this event (per-funnel creds, env fallback). A refund's
    // charge object references the PI; sessions store that PI id.
    const sessionId = obj.metadata?.co_session_id || '';
    let sessions = sessionId
      ? await pgQuery(`SELECT id, funnel_id, status FROM co_sessions WHERE id = $1`, [sessionId])
      : [];
    if (!sessions.length && isRefund && obj.payment_intent) {
      sessions = await pgQuery(
        `SELECT id, funnel_id, status FROM co_sessions WHERE gateway_session_id = $1`,
        [String(obj.payment_intent)]
      );
    }
    const session = sessions[0] || null;

    const signingSecret = await resolveCredential(
      session?.funnel_id || '', 'stripe', 'webhook_secret'
    );
    if (!signingSecret || !stripeGw.verifyWebhookSignature(raw, sig, signingSecret)) {
      // Fail-closed: unverifiable events never touch money state.
      return res.status(403).json({ success: false, error: { code: 'bad_signature' } });
    }

    if (!session && isRefund) {
      // A refund for a session we don't know is money OUT, not in — nothing
      // to write back; ack so Stripe stops retrying.
      return res.json({ success: true, unknown_session: true, refund: true });
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

    // ── kind=upsell: settle/fail the 1-click charge row (mirrors the Whop
    // branch). Without this, a Stripe upsell whose sync response was lost is
    // settled by nothing — the session is already 'paid', so the base path
    // below would ack it as already_paid and drop it.
    if (!isRefund && (obj.metadata?.kind || '') === 'upsell') {
      const chargeRowId = String(obj.metadata?.charge_row || '');
      if (!chargeRowId) {
        if (eventId) await markProcessed('stripe', eventId, 'upsell_missing_charge_row');
        return res.json({ success: true, ignored: 'missing_charge_row' });
      }
      // Authoritative re-fetch — never trust the posted amount for money.
      const secretKeyUp = await resolveCredential(session.funnel_id || '', 'stripe', 'secret_key');
      const piUp = await stripeGw.retrievePaymentIntent(secretKeyUp, obj.id || '');
      if (!piUp.ok) {
        return res.status(502).json({ success: false, error: { code: 'pi_fetch_failed' } });
      }
      if (piUp.status !== 'succeeded') {
        if (eventId) await markProcessed('stripe', eventId, `upsell_pi_${piUp.status}`);
        return res.json({ success: true, ignored: `pi_status_${piUp.status}` });
      }
      const upRes = await settleUpsellCharge({
        chargeRowId,
        gatewayPaymentId: piUp.id,
        amount: piUp.amount,
        expectedSessionId: session.id,
      });
      if (eventId) {
        await markProcessed('stripe', eventId, upRes.ok ? (upRes.already ? 'upsell_already' : 'upsell_settled') : `upsell_${upRes.error}`);
      }
      // SPLIT-LANE HOOK: credit the offer-scope arm for this settled leg
      // (idempotent on (session, group, chargeRowId)).
      if (upRes.ok) {
        creditSessionConversions({
          sessionId: session.id, chargeId: chargeRowId,
          value: piUp.amount, currency: session.currency, scope: 'offer',
        }).catch(() => {});
      }
      return res.json({ success: true, upsell: upRes.ok ? 'settled' : upRes.error });
    }

    if (isRefund) {
      // Preferred: per-refund breakdown (re_… ids), each idempotent by its own
      // id — apply each. Fallback: current Stripe API versions omit
      // refunds.data, leaving only the CUMULATIVE amount_refunded. Booking
      // that cumulative figure as a fresh ledger entry on every event would
      // double-count across partial refunds ($10 then cumulative $30 → 40), so
      // instead book only the DELTA versus what this session already records
      // for Stripe.
      const refunds = obj.refunds?.data || [];
      let entries;
      if (refunds.length) {
        entries = refunds.map((r) => ({
          ref: String(r.id), amount: stripeGw.minorToAmount(r.amount, r.currency || obj.currency),
        }));
      } else {
        const cumulative = stripeGw.minorToAmount(obj.amount_refunded ?? 0, obj.currency);
        const [cur] = await pgQuery(`SELECT refunds FROM co_sessions WHERE id = $1`, [session.id]);
        const priorSum = (Array.isArray(cur?.refunds) ? cur.refunds : [])
          .filter((r) => r && r.gateway === 'stripe')
          .reduce((s, r) => s + Number(r.amount || 0), 0);
        const delta = Math.round((cumulative - priorSum) * 100) / 100;
        entries = delta > 0 ? [{ ref: eventId || `chrf_${obj.id}`, amount: delta }] : [];
      }
      let applied = 0;
      for (const e of entries) {
        const r = await applyRefund({
          sessionId: session.id, ref: e.ref, amount: e.amount, gateway: 'stripe', isDispute: false,
        });
        if (r.ok && !r.duplicate) {
          applied++;
          // SPLIT-LANE HOOK: net the refund against the base leg's arm credit
          // (idempotent per refundKey; per-leg capped inside voidSessionRefund).
          voidSessionRefund({
            sessionId: session.id, chargeId: `base:${session.id}`,
            amount: e.amount, refundKey: e.ref,
          }).catch(() => {});
        }
      }
      if (eventId) await markProcessed('stripe', eventId, `refund_applied_${applied}`);
      return res.json({ success: true, refund: true, applied });
    }

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
      // These outcomes are PERMANENT for this event — the session is parked
      // for a human (amount_mismatch) or is in a terminal state a redelivery
      // can never change (refunded/failed). ACK (200) so the gateway stops
      // retrying; retrying changes nothing and just floods the endpoint.
      if (result.error === 'amount_mismatch' || String(result.error).startsWith('unsettleable_status')) {
        return res.json({ success: true, needs_review: result.error === 'amount_mismatch', noop: true });
      }
      // Anything else is treated as transient → 500 so the gateway retries.
      return res.status(500).json({ success: false, error: { code: result.error } });
    }
    if (eventId) {
      await markProcessed('stripe', eventId, result.settled ? 'settled' : 'already_settled');
    }
    // TRACKING-LANE HOOK: fire Purchase (fire-and-forget, idempotent).
    if (result.ok) firePurchaseConversion(session.id).catch(() => {});
    // SPLIT-LANE HOOK: credit the page-scope arm for the base order (idempotent
    // on (session, group, base:<session>); fires on settled AND already).
    if (result.ok) {
      creditSessionConversions({
        sessionId: session.id, chargeId: `base:${session.id}`,
        value: Number(session.total), currency: session.currency, scope: 'page',
      }).catch(() => {});
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
    let sessions = sessionId
      ? await pgQuery(
        `SELECT id, funnel_id, status, total, currency FROM co_sessions WHERE id = $1`,
        [sessionId]
      )
      : [];
    // Refund/dispute events routinely omit our metadata, so resolve the funnel
    // (for the per-funnel secret) via the referenced payment id — otherwise a
    // per-funnel deployment with no env fallback would 401 every reversal.
    // This is a READ to pick the verification key; nothing acts on it until
    // after the signature passes.
    if (!sessions.length) {
      const refPaymentId = String(
        data.payment_id || (typeof data.payment === 'object' && data.payment?.id) || ''
      );
      if (refPaymentId) {
        sessions = await pgQuery(
          `SELECT id, funnel_id, status, total, currency FROM co_sessions
           WHERE gateway_session_id = $1 AND gateway = 'whop'`,
          [refPaymentId]
        );
      }
    }
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

    // Refund / dispute writeback: reverses money out-of-band and routinely
    // lacks our metadata — resolve the session by the referenced payment id
    // when metadata is absent.
    const et = String(eventType).toLowerCase();
    const isWhopRefund = et.startsWith('refund.') || et === 'payment.refunded';
    const isWhopDispute = et.startsWith('dispute.') || et.startsWith('charge.dispute') || et === 'payment.disputed';
    if (isWhopRefund || isWhopDispute) {
      let target = session;
      const refPaymentId = String(
        data.payment_id || (typeof data.payment === 'object' && data.payment?.id) || ''
      );
      if (!target && refPaymentId) {
        const bySession = await pgQuery(
          `SELECT id, funnel_id, status FROM co_sessions WHERE gateway_session_id = $1 AND gateway = 'whop'`,
          [refPaymentId]
        );
        target = bySession[0] || null;
      }
      if (!target) {
        await markProcessed('whop', webhookId, 'reversal_unknown_session');
        return res.json({ success: true, unknown_session: true, reversal: true });
      }
      const ref = String(data.id || webhookId);
      const amount = whopGw.extractGrossAmount(data);
      const r = await applyRefund({
        sessionId: target.id, ref,
        amount: isWhopDispute && amount === null ? 0 : amount, // a dispute parks even amount-less
        gateway: 'whop', isDispute: isWhopDispute,
      });
      await markProcessed('whop', webhookId, isWhopDispute ? 'dispute_applied' : `refund_${r.ok ? 'applied' : r.error}`);
      return res.json({ success: true, reversal: true, dispute: isWhopDispute, applied: r.ok && !r.duplicate });
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
      // The charge row is scoped to the session the signature authenticated —
      // an upsell event MUST carry a resolvable co_session_id, and the row
      // must belong to it. Without a verified session there is nothing to
      // scope the body-supplied charge_row against, so refuse.
      if (!session) {
        await markProcessed('whop', webhookId, 'upsell_unknown_session');
        return res.json({ success: true, unknown_session: true });
      }
      const chargeRowId = String(metadata.charge_row || '');
      if (!chargeRowId) {
        await markProcessed('whop', webhookId, 'upsell_missing_charge_row');
        return res.json({ success: true, ignored: 'missing_charge_row' });
      }
      if (eventType === 'payment.failed') {
        const { reason } = whopGw.extractDecline(data);
        await failUpsellCharge({ chargeRowId, reason: reason || 'payment_failed', expectedSessionId: session.id });
        await markProcessed('whop', webhookId, 'upsell_failed');
        return res.json({ success: true, upsell: 'failed' });
      }
      const result = await settleUpsellCharge({
        chargeRowId,
        gatewayPaymentId: paymentId,
        amount: whopGw.extractGrossAmount(data),
        expectedSessionId: session.id,
      });
      // Money moved but the row is already terminal (a prior async failure /
      // sweep decline flipped it): recording NOTHING would make a real charge
      // invisible. Queue it for an operator instead of silently acking.
      if (!result.ok && String(result.error).startsWith('unsettleable_status')) {
        await recordUnmatched(
          paymentId || `whupx_${webhookId}`, 'whop',
          whopGw.extractGrossAmount(data), String(data.currency || 'USD').toUpperCase(),
          event, `upsell_settled_on_terminal_row:${chargeRowId}:${result.error}`
        );
      }
      await markProcessed(
        'whop', webhookId,
        result.ok ? (result.already ? 'upsell_already' : 'upsell_settled') : `upsell_${result.error}`
      );
      // SPLIT-LANE HOOK: credit the offer-scope arm for this settled leg
      // (idempotent on (session, group, chargeRowId)).
      if (result.ok) {
        creditSessionConversions({
          sessionId: session.id, chargeId: chargeRowId,
          value: whopGw.extractGrossAmount(data),
          currency: String(data.currency || session.currency || 'USD').toUpperCase(),
          scope: 'offer',
        }).catch(() => {});
      }
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

    // The order key is derived from the SAME value stored in
    // gateway_session_id, so the sweep's backfill (`wh_${gateway_session_id}`)
    // reconstructs an identical key. Deriving them differently would let a
    // crash-then-redeliver sequence write two orders for one payment.
    const whopGatewayId = paymentId || `whwh_${webhookId}`;
    const result = await settleSessionPaid({
      sessionId: session.id,
      gateway: 'whop',
      gatewayId: whopGatewayId,
      idempotencyKey: `wh_${whopGatewayId}`,
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
      // A terminal session state (refunded/failed) can't be settled by a
      // redelivery — ACK so Whop stops retrying. Anything else is transient.
      if (String(result.error).startsWith('unsettleable_status')) {
        return res.json({ success: true, noop: true });
      }
      return res.status(500).json({ success: false, error: { code: result.error } });
    }
    // TRACKING-LANE HOOK: fire Purchase (fire-and-forget, idempotent).
    if (result.ok) firePurchaseConversion(session.id).catch(() => {});
    // SPLIT-LANE HOOK: credit the page-scope arm for the base order (idempotent
    // on (session, group, base:<session>); fires on settled AND already).
    if (result.ok) {
      creditSessionConversions({
        sessionId: session.id, chargeId: `base:${session.id}`,
        value: Number(session.total), currency: session.currency, scope: 'page',
      }).catch(() => {});
    }
    return res.json({ success: true, settled: result.settled, already: result.already });
  } catch (err) {
    console.error('[gatewayWebhooks] whop failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
