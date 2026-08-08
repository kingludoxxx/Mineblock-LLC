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

const TICK_MS = Number(process.env.MONEY_SWEEP_TICK_MS || 10 * 60 * 1000);
// A pending charge younger than this is normal async latency — leave it.
const PENDING_MIN_AGE_MIN = Number(process.env.MONEY_SWEEP_PENDING_MIN_AGE_MIN || 5);
// A pending charge with NO gateway payment id can never be reconciled; after
// this long it parks for a human.
const ORPHAN_PARK_AGE_HOURS = 24;
// A 'charging' claim this old means the charging request died mid-flight —
// we cannot prove whether the gateway charged, so it parks (never retries).
const STALE_CHARGING_AGE_MIN = 30;

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
          });
          if (res.ok) stats.settled++;
        } else if (WHOP_FAILED_STATUSES.has(pay.status)) {
          await failUpsellCharge({ chargeRowId: row.id, reason: `sweep:${pay.status}` });
          stats.failed++;
        }
        // still pending at the gateway → leave for the next tick
      } else if (row.gateway === 'stripe') {
        const secretKey = await resolveCredential(row.funnel_id || '', 'stripe', 'secret_key');
        const pi = await stripeGw.retrievePaymentIntent(secretKey, row.gateway_payment_id);
        if (!pi.ok) { stats.unreachable++; continue; }
        if (pi.status === 'succeeded') {
          const res = await settleUpsellCharge({
            chargeRowId: row.id, gatewayPaymentId: pi.id, amount: pi.amount,
          });
          if (res.ok) stats.settled++;
        } else if (['canceled', 'requires_payment_method'].includes(pi.status)) {
          await failUpsellCharge({ chargeRowId: row.id, reason: `sweep:pi_${pi.status}` });
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
    } catch (err) {
      console.error(`[money-sweep] order backfill ${s.id} error:`, err.message);
    }
  }
}

export async function runMoneySweepOnce() {
  const stats = { settled: 0, failed: 0, parked: 0, ordersBackfilled: 0, unreachable: 0 };
  await ensureCheckoutTables();
  await reconcilePendingSettlements(stats);
  await parkStaleChargingClaims(stats);
  await backfillMissingOrders(stats);
  const summary = Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ');
  if (Object.values(stats).some(Boolean)) console.log(`[money-sweep] ${summary}`);
  return stats;
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
