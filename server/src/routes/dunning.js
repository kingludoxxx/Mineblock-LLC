// DUNNING — the failed-payment queue's admin surface.
//
// Mounted at /api/v1/dunning behind the same authenticate + orders:access
// chain as the rest of the CRM.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MONEY SEAM — READ THIS BEFORE WIRING A RE-CHARGE
//
// POST /failed-payments/:id/retry RECORDS AN INTENT. It does not call a
// gateway, does not touch a card, and returns `money_moved: false` in the
// response body so no client can mistake it for a charge.
//
// What it DOES do, atomically, in one conditional UPDATE:
//   - refuses unless the row is state='scheduled', retryable=TRUE and under
//     the attempt cap (each refusal is named, never a generic failure);
//   - mints the next attempt number;
//   - advances the ladder (1h → 24h → 72h) or marks the row 'exhausted';
//   - writes an immutable row to co_dunning_retry_requests, guarded by
//     UNIQUE (queue_id, attempt_no).
//
// The contract for the integrator who wires the actual charge:
//
//   TRIGGER    a row in co_dunning_retry_requests. It carries queue_id,
//              session_id, attempt_no, amount and currency — everything the
//              charge needs, and nothing it must re-derive.
//
//   PRECONDITION  GET /failed-payments/:id returns `retry_possible` and, when
//              false, the exact `retry_blocked_reason` ('no_saved_payment_
//              method' | 'attempts_exhausted' | 'state:<state>'). Refuse on it
//              rather than discovering it at the gateway — a retry with no
//              vaulted credential is a guaranteed decline that still burns a
//              ladder rung and still emails the buyer.
//
//   CHARGE     idempotency key `dun_<queue_id>_<attempt_no>`. Deterministic and
//              unique by construction: the attempt number is minted by the
//              atomic claim, so re-running an attempt cannot double-charge.
//              Metadata MUST mirror the original accept path —
//                { co_session_id, kind, charge_row, dunning: true, attempt }
//              where `kind`/`charge_row` are what the first charge sent. Get
//              this wrong and an async settlement webhook routes to the
//              base-order handler and corrupts a paid order.
//
//   REPORT     report the outcome through the EXISTING money-path functions in
//              services/checkoutSettle.js — settleUpsellCharge on success,
//              failUpsellCharge on decline. This lane must never UPDATE a
//              charge status itself: the queue reads that ledger, and a reader
//              that can also write it is a second source of truth about money.
//              Then call closeQueueRow({ queueId, state: 'recovered' }).
//
//   RE-VERIFY   at charge time, the charger MUST re-read the underlying charge
//              and confirm it is STILL declined before charging — the queue is
//              built by a scan, so a payment recovered out-of-band (a webhook,
//              a manual settle) between the last scan and the charge would
//              otherwise be collected twice. The scheduled retry window (up to
//              72h) is wide enough that this lag is the expected case, not an
//              edge one.
//
//   NEVER      add an automatic retry loop that fires without an intent row.
//              The intent row is the only record that a human (or a scheduled
//              job identifying itself as origin='scheduled') asked for this.
//
// The buyer-facing dunning email is already wired: services/dunningService.js
// sends ONE 'Payment Failed' Klaviyo event per queued failure, exactly-once via
// the lb_integration_sends claim (ref `kdf_<queue_id>`), claim-before-send with
// release-on-failure — the same protocol abandonedRecovery.js uses.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  ensureDunningTables,
  scanFailures,
  listQueue,
  readQueueRow,
  requestRetry,
  closeQueueRow,
  QUEUE_STATES,
  MAX_ATTEMPTS,
  RETRY_DELAYS_H,
  RETRY_MIN_SPACING_SECONDS,
} from '../services/dunningService.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

const actorOf = (req) =>
  [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
  req.user?.email ||
  req.user?.id ||
  'staff';

const QUEUE_ID_RE = /^[A-Za-z0-9_:.-]{1,140}$/;

// The retry ladder, published so the UI never hard-codes a second copy of it.
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      max_attempts: MAX_ATTEMPTS,
      retry_delays_hours: RETRY_DELAYS_H,
      retry_min_spacing_seconds: RETRY_MIN_SPACING_SECONDS,
      states: QUEUE_STATES,
      // Said in the payload, not just in a comment, so a client cannot ship a
      // "Retry charge" button under a false belief about what it does.
      retry_charges_card: false,
      retry_records_intent_only: true,
    },
  });
});

// LIST — windowed on first_failed_at. `days` is capped server-side; an
// unbounded window over a growing ledger is a query that degrades forever.
router.get('/failed-payments', async (req, res) => {
  try {
    await ensureDunningTables();
    const out = await listQueue({
      days: req.query.days,
      state: req.query.state ? String(req.query.state) : 'open',
      bucket: req.query.bucket ? String(req.query.bucket) : '',
      limit: req.query.limit,
      offset: req.query.offset,
    });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('[dunning] list failed:', err);
    res.status(500).json({ error: 'Failed to load the failed-payment queue' });
  }
});

// SCAN — project money-path failures into the queue. Idempotent, so a cron and
// an operator button can both call it. READ-ONLY over co_upsell_charges /
// co_sessions; it writes only the dunning tables.
router.post('/scan', async (req, res) => {
  try {
    const out = await scanFailures({
      days: req.body?.days,
      limit: req.body?.limit,
      // Default ON: the point of the scan is to notice a failure and tell the
      // buyer. `notify:false` exists for a dry run.
      notify: req.body?.notify !== false,
    });
    res.json({ success: true, data: out, money_moved: false });
  } catch (err) {
    console.error('[dunning] scan failed:', err);
    res.status(500).json({ error: 'Failed to scan for failed payments' });
  }
});

router.get('/failed-payments/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!QUEUE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const out = await readQueueRow(id);
    if (!out.ok) return res.status(404).json({ error: out.error });
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('[dunning] detail failed:', err);
    res.status(500).json({ error: 'Failed to load the failed payment' });
  }
});

// RETRY — records intent. Charges NOTHING. See the MONEY SEAM block above.
router.post('/failed-payments/:id/retry', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!QUEUE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const out = await requestRetry({
      queueId: id,
      actor: actorOf(req),
      origin: req.body?.origin === 'scheduled' ? 'scheduled' : 'manual',
      note: req.body?.note,
    });
    if (!out.ok) {
      const { status, ...rest } = out;
      return res.status(status || 409).json({ error: out.error, ...rest });
    }
    res.json({ success: true, data: out, money_moved: false });
  } catch (err) {
    console.error('[dunning] retry request failed:', err);
    res.status(500).json({ error: 'Failed to record the retry request' });
  }
});

// CLOSE — the failure resolved outside this lane (paid another way, refunded,
// settled late). Records the reason; a closed row with no reason is
// indistinguishable from a bug.
router.post('/failed-payments/:id/close', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!QUEUE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const out = await closeQueueRow({
      queueId: id,
      state: req.body?.state === 'recovered' ? 'recovered' : 'closed',
      actor: actorOf(req),
      reason: req.body?.reason,
    });
    if (!out.ok) {
      const { status, ...rest } = out;
      return res.status(status || 409).json({ error: out.error, ...rest });
    }
    res.json({ success: true, data: out.queue });
  } catch (err) {
    console.error('[dunning] close failed:', err);
    res.status(500).json({ error: 'Failed to close the queue row' });
  }
});

export default router;
