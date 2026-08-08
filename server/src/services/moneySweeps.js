// Money sweeps — the 10-minute reconciliation cron. The gateway webhooks are
// the PRIMARY settlers; this sweep only reconciles what a lost or late
// webhook stranded, and it does so by calling the webhook's OWN money
// helpers (checkoutSettle) — never re-implemented arithmetic.
//
// Per DECISIONS rule 3: the sweep never auto-retries a write it cannot prove
// failed. Anything ambiguous parks at needs_review for a human.
//
// In-process, single instance (this repo deploys one web service). Started
// from gatewayWebhooks.js at module load, same pattern as the brand-spy
// media mirror worker; MONEY_SWEEP_DISABLED=1 turns it off without a deploy.
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';
import {
  settleSessionPaid,
  settleUpsellCharge,
  failUpsellCharge,
} from './checkoutSettle.js';
import { resolveCredential } from './gatewayConfigs.js';
import * as whopGw from './gateways/whop.js';
import * as stripeGw from './gateways/stripe.js';
// SPLIT-LANE HOOK: sweep-settled legs must credit identically to
// webhook-settled ones, and parked pending credits get retried each tick.
import { creditSessionConversions, retrySplitPendingCredits } from './splitCredits.js';

// Env-tunable, but CLAMPED: a garbage or "0" value must never turn the sweep
// into a tight loop hammering the DB and gateway APIs. posInt(v, default, min).
function posInt(raw, dflt, min) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}
const TICK_MS = posInt(process.env.MONEY_SWEEP_TICK_MS, 10 * 60 * 1000, 30_000);
// A pending charge younger than this is normal async latency — leave it.
const PENDING_MIN_AGE_MIN = posInt(process.env.MONEY_SWEEP_PENDING_MIN_AGE_MIN, 5, 1);
// A pending charge with NO gateway payment id can never be reconciled; after
// this long it parks for a human.
const ORPHAN_PARK_AGE_HOURS = 24;
// A 'charging' claim this old means the charging request died mid-flight —
// we cannot prove whether the gateway charged, so it parks (never retries).
const STALE_CHARGING_AGE_MIN = 30;
// A session still 'processing' this long after its gateway reference was
// minted is a candidate for a lost settlement webhook. Generous, because most
// started checkouts are simply never paid (that is the normal case).
const STRANDED_MIN_AGE_MIN = posInt(process.env.MONEY_SWEEP_STRANDED_MIN_AGE_MIN, 30, 5);

// Whop statuses that are terminal failures (safe to mark declined).
const WHOP_FAILED_STATUSES = new Set(['failed', 'declined', 'canceled', 'cancelled', 'refunded']);

async function whopCredsFor(funnelId) {
  return {
    api_key: await resolveCredential(funnelId || '', 'whop', 'api_key'),
    company_id: await resolveCredential(funnelId || '', 'whop', 'company_id'),
  };
}

// 1. Charges the gateway ACCEPTED that never got their settlement webhook:
// read the payment's current status from the gateway (read-only — never a
// charge) and settle/fail through the shared helpers.
async function reconcilePendingSettlements(stats) {
  const rows = await pgQuery(`
    SELECT c.id, c.session_id, c.gateway_payment_id, c.amount, c.created_at,
           s.funnel_id, s.gateway
    FROM co_upsell_charges c
    JOIN co_sessions s ON s.id = c.session_id
    WHERE c.status = 'pending_settlement'
      AND c.updated_at < NOW() - make_interval(mins => $1)
    ORDER BY c.updated_at ASC
    LIMIT 50
  `, [PENDING_MIN_AGE_MIN]);
  for (const row of rows) {
    try {
      if (!row.gateway_payment_id) {
        // Nothing to reconcile against — park after the grace window.
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (ageMs > ORPHAN_PARK_AGE_HOURS * 3600_000) {
          await pgQuery(
            `UPDATE co_upsell_charges SET status = 'needs_review',
               error = 'pending_without_payment_id', updated_at = NOW()
             WHERE id = $1 AND status = 'pending_settlement'`, [row.id]
          );
          stats.parked++;
        }
        continue;
      }
      if (row.gateway === 'whop') {
        const creds = await whopCredsFor(row.funnel_id);
        const pay = await whopGw.getPayment(creds, row.gateway_payment_id);
        if (!pay.ok) { stats.unreachable++; continue; } // transient — next tick retries the READ
        if (whopGw.SETTLED_PAYMENT_STATUSES.has(pay.status)) {
          const res = await settleUpsellCharge({
            chargeRowId: row.id,
            gatewayPaymentId: row.gateway_payment_id,
            amount: whopGw.extractGrossAmount(pay.json) ?? Number(row.amount),
            expectedSessionId: row.session_id,
          });
          if (res.ok) {
            stats.settled++;
            // SPLIT-LANE HOOK: offer-scope arm credit (idempotent on the triple).
            creditSessionConversions({
              sessionId: row.session_id, chargeId: row.id,
              value: Number(row.amount), scope: 'offer',
            }).catch(() => {});
          }
        } else if (pay.status === 'refunded') {
          // Money MOVED and was returned — 'declined' would erase that trail.
          // Settle it (so the books show the charge) and let the refund
          // webhook/ledger record the reversal.
          const res = await settleUpsellCharge({
            chargeRowId: row.id,
            gatewayPaymentId: row.gateway_payment_id,
            amount: whopGw.extractGrossAmount(pay.json) ?? Number(row.amount),
            expectedSessionId: row.session_id,
          });
          if (res.ok) {
            stats.settled++;
            // SPLIT-LANE HOOK: offer-scope arm credit (idempotent on the triple).
            creditSessionConversions({
              sessionId: row.session_id, chargeId: row.id,
              value: Number(row.amount), scope: 'offer',
            }).catch(() => {});
          }
        } else if (WHOP_FAILED_STATUSES.has(pay.status)) {
          await failUpsellCharge({
            chargeRowId: row.id, reason: `sweep:${pay.status}`, expectedSessionId: row.session_id,
          });
          stats.failed++;
        } else if (Date.now() - new Date(row.created_at).getTime() > ORPHAN_PARK_AGE_HOURS * 3600_000) {
          // Still non-terminal at the gateway a full day later — it will not
          // resolve on its own. Park it rather than loop forever.
          await pgQuery(
            `UPDATE co_upsell_charges SET status = 'needs_review',
               error = $2, updated_at = NOW()
             WHERE id = $1 AND status = 'pending_settlement'`,
            [row.id, `pending_at_gateway_over_${ORPHAN_PARK_AGE_HOURS}h:${pay.status || 'unknown'}`]
          );
          stats.parked++;
        }
        // still pending inside the window → leave for the next tick
      } else if (row.gateway === 'stripe') {
        const secretKey = await resolveCredential(row.funnel_id || '', 'stripe', 'secret_key');
        const pi = await stripeGw.retrievePaymentIntent(secretKey, row.gateway_payment_id);
        if (!pi.ok) { stats.unreachable++; continue; }
        if (pi.status === 'succeeded') {
          const res = await settleUpsellCharge({
            chargeRowId: row.id, gatewayPaymentId: pi.id, amount: pi.amount,
            expectedSessionId: row.session_id,
          });
          if (res.ok) {
            stats.settled++;
            // SPLIT-LANE HOOK: offer-scope arm credit (idempotent on the triple).
            creditSessionConversions({
              sessionId: row.session_id, chargeId: row.id,
              value: Number(row.amount), scope: 'offer',
            }).catch(() => {});
          }
        } else if (['canceled', 'requires_payment_method'].includes(pi.status)) {
          await failUpsellCharge({
            chargeRowId: row.id, reason: `sweep:pi_${pi.status}`, expectedSessionId: row.session_id,
          });
          stats.failed++;
        }
      }
    } catch (err) {
      console.error(`[money-sweep] pending charge ${row.id} reconcile error:`, err.message);
    }
  }
}

// 2. 'charging' claims whose request died mid-flight. We cannot prove whether
// the gateway received the charge, so parking is the ONLY safe move.
async function parkStaleChargingClaims(stats) {
  const rows = await pgQuery(`
    UPDATE co_upsell_charges SET status = 'needs_review',
      error = 'stale_charging_claim', updated_at = NOW()
    WHERE status = 'charging'
      AND updated_at < NOW() - make_interval(mins => $1)
    RETURNING id
  `, [STALE_CHARGING_AGE_MIN]);
  stats.parked += rows.length;
}

// 3. Paid sessions whose order write was lost (crash between the status flip
// and the order insert). settleSessionPaid handles the already-paid case by
// re-running only the idempotent order insert.
async function backfillMissingOrders(stats) {
  const rows = await pgQuery(`
    SELECT s.id, s.gateway, s.gateway_session_id, s.total, s.currency
    FROM co_sessions s
    WHERE s.status = 'paid'
      AND s.gateway_session_id IS NOT NULL
      AND s.paid_at < NOW() - INTERVAL '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM co_orders o WHERE o.session_id = s.id)
    ORDER BY s.paid_at ASC
    LIMIT 50
  `);
  for (const s of rows) {
    try {
      const prefix = s.gateway === 'stripe' ? 'st' : 'wh';
      const res = await settleSessionPaid({
        sessionId: s.id,
        gateway: s.gateway,
        gatewayId: s.gateway_session_id,
        idempotencyKey: `${prefix}_${s.gateway_session_id}`,
        amount: Number(s.total),
        currency: s.currency,
      });
      if (res.ok && res.orderId) stats.ordersBackfilled++;
      // SPLIT-LANE HOOK: page-scope base credit, parity with the webhook path.
      if (res.ok) {
        creditSessionConversions({
          sessionId: s.id, chargeId: `base:${s.id}`,
          value: Number(s.total), currency: s.currency, scope: 'page',
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[money-sweep] order backfill ${s.id} error:`, err.message);
    }
  }
}

// 4. Base payments whose settlement webhook never arrived (misconfigured or
// rotated webhook secret, an outage that outlasted the gateway's retries).
// The money is captured at the gateway but the session sits at 'processing'
// forever — silent revenue loss and an unfulfilled buyer. We ASK the gateway
// (read-only) and settle through the same helper the webhook uses.
async function reconcileStrandedSessions(stats) {
  const rows = await pgQuery(`
    SELECT id, funnel_id, gateway, gateway_session_id, total, currency, created_at
    FROM co_sessions
    WHERE status = 'processing'
      AND gateway_session_id IS NOT NULL
      AND created_at < NOW() - make_interval(mins => $1)
      AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC
    LIMIT 50
  `, [STRANDED_MIN_AGE_MIN]);
  for (const s of rows) {
    try {
      if (s.gateway === 'stripe') {
        const secretKey = await resolveCredential(s.funnel_id || '', 'stripe', 'secret_key');
        const pi = await stripeGw.retrievePaymentIntent(secretKey, s.gateway_session_id);
        if (!pi.ok) { stats.unreachable++; continue; }
        if (pi.status !== 'succeeded') continue; // genuinely unpaid — normal
        const res = await settleSessionPaid({
          sessionId: s.id,
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
        if (res.ok && res.settled) stats.strandedSettled++;
        // SPLIT-LANE HOOK: page-scope base credit, parity with the webhook path.
        if (res.ok) {
          creditSessionConversions({
            sessionId: s.id, chargeId: `base:${s.id}`,
            value: Number(s.total), currency: s.currency, scope: 'page',
          }).catch(() => {});
        }
      } else if (s.gateway === 'whop') {
        // A Whop session id is the checkout config (ch_…), not a payment, so
        // there is nothing read-only to resolve it to a payment here. Park it
        // for an operator rather than leave captured money invisible.
        const ageMs = Date.now() - new Date(s.created_at || Date.now()).getTime();
        if (ageMs > ORPHAN_PARK_AGE_HOURS * 3600_000) {
          const parked = await pgQuery(
            `UPDATE co_sessions SET needs_review_reason = $2, updated_at = NOW()
             WHERE id = $1 AND status = 'processing' AND needs_review_reason IS NULL
             RETURNING id`,
            [s.id, 'processing_over_24h_with_gateway_session — check Whop for a captured payment']
          );
          if (parked.length) stats.parked++;
        }
      }
    } catch (err) {
      console.error(`[money-sweep] stranded session ${s.id} reconcile error:`, err.message);
    }
  }
}

// In-flight guard: a tick that runs long (up to 50 gateway reads at 6-20s
// each can exceed the interval) must never overlap the next tick — overlapping
// runs double the gateway reads and interleave stats for no benefit (settles
// are idempotent, so it's not unsafe, just wasteful). A concurrent call
// returns the sentinel instead of starting a second pass.
let sweepInFlight = false;

export async function runMoneySweepOnce() {
  if (sweepInFlight) return { skipped: 'in_flight' };
  sweepInFlight = true;
  const stats = {
    settled: 0, failed: 0, parked: 0, ordersBackfilled: 0,
    strandedSettled: 0, unreachable: 0,
  };
  try {
    await ensureCheckoutTables();
    await reconcilePendingSettlements(stats);
    await parkStaleChargingClaims(stats);
    await reconcileStrandedSessions(stats);
    await backfillMissingOrders(stats);
    // SPLIT-LANE HOOK: re-credit legs that settled before their exposure row
    // landed (parked as pending; exactly-once still held by the unique triple).
    try { await retrySplitPendingCredits(); } catch { /* fail-open: next tick */ }
    const summary = Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ');
    if (Object.values(stats).some(Boolean)) console.log(`[money-sweep] ${summary}`);
    return stats;
  } finally {
    sweepInFlight = false;
  }
}

let started = false;
export function startMoneySweeps() {
  if (started) return;
  started = true;
  if (process.env.MONEY_SWEEP_DISABLED === '1') {
    console.log('[money-sweep] disabled via MONEY_SWEEP_DISABLED');
    return;
  }
  console.log(`[money-sweep] scheduled every ${Math.round(TICK_MS / 1000)}s`);
  // First tick after a settle-in delay, then the steady interval.
  const first = setTimeout(() => {
    runMoneySweepOnce().catch((err) => console.error('[money-sweep] tick error:', err.message));
    setInterval(() => {
      runMoneySweepOnce().catch((err) => console.error('[money-sweep] tick error:', err.message));
    }, TICK_MS).unref?.();
  }, 60_000);
  first.unref?.();
}
