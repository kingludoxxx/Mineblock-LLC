// DUNNING — the failed-payment queue.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND THE ONE LINE IT DOES NOT CROSS
//
// The money path already records every payment failure it sees. Nothing reads
// those records, so a declined upsell is money that quietly evaporates. This
// module PROJECTS those failures into a queue with retry-schedule metadata,
// classifies them, surfaces them to an operator, sends the buyer one dunning
// email, and records a RETRY INTENT when an operator asks for one.
//
// It does NOT re-charge. Charging a saved payment method is the integrator's
// lane (see the contract at the bottom of this file). A retry request writes an
// immutable intent row and advances the schedule; the actual gateway call is
// one function away and deliberately absent.
//
// STRICTLY READ-ONLY over the money path: this module SELECTs from
// co_upsell_charges, co_sessions and co_events and writes only its own two
// tables. It never flips a charge status, because a queue that can rewrite the
// ledger it reads is a queue that can lose money.
//
// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION — what counts as dunnable
//
// Our status vocabulary (co_upsell_charges.status, written by checkoutPublic /
// checkoutSettle / gatewayWebhooks):
//   'charging'            claim taken, gateway call in flight     → NOT dunnable
//   'pending_settlement'  accepted, awaiting settlement            → NOT dunnable
//   'settled'             money moved                              → NOT dunnable
//   'declined'            the gateway said no                      → DUNNABLE
//   'needs_review'        a human already owns it                  → NOT dunnable
//   'canceled'            a dispute/refund killed it               → NOT dunnable
//   'refunded'            money returned                           → NOT dunnable
//
// The trap our schema makes visible and the reference's did not:
// `declined_by_user = TRUE` is a $0 marker row meaning THE BUYER SAID NO. It
// carries status 'declined' like a real decline. Dunning it would email a
// customer about a purchase they explicitly refused and burn a gateway retry
// on nothing. It is excluded on the boolean, not on the amount — an amount
// test would also have worked here, but only by accident.
//
// Base-order failures come from co_sessions.last_failed_payment_id (set by the
// payment.failed webhook) on a session still at 'processing'. A session that
// later reached 'paid' recovered on its own and is closed, not dunned.
//
// ─────────────────────────────────────────────────────────────────────────────
// RETRY SCHEDULE — a fixed ladder, materialised at write time
//
// 1h → 24h → 72h, three attempts, measured from the moment of the failure that
// produced the attempt. The ladder is written into next_retry_at rather than
// derived at read time, so "when does this retry" is a stored fact an operator
// and a cron agree on, not two independent recomputations that can drift.
//
// A schedule that is SPENT stores next_retry_at = NULL and state 'exhausted'.
// The reference infers exhaustion from a null and cannot tell it apart from
// "never scheduled"; we carry an explicit state so the two are distinguishable
// in one column read.
import { pgQuery } from '../db/pg.js';
import { ensureCheckoutTables } from './checkoutSchema.js';
import { claimSend, releaseSend } from './integrationsSchema.js';
import { getKlaviyoConfig, upsertProfile, trackEvent } from './klaviyoService.js';

const KLAVIYO_KIND = 'klaviyo';
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Test seam — the harness swaps these to prove the claim/release protocol
// without a network. Production behaviour is identical (same pattern as
// klaviyoEvents._deps / abandonedRecovery._deps).
export const _deps = { upsertProfile, trackEvent, getKlaviyoConfig, claimSend, releaseSend };

export const DUNNING_METRIC = 'Payment Failed';
export const MAX_ATTEMPTS = 3;
// Hours after the failure, indexed by attempts ALREADY made.
export const RETRY_DELAYS_H = [1, 24, 72];
// A decline older than this has outlived its own ladder: the card situation
// that caused it is stale and a retry is a cold call. Recorded, never scheduled.
export const MAX_DECLINE_AGE_DAYS = 3;
// Below this a retry costs more in gateway fees and buyer confusion than it can
// recover. Also excludes the $0 decline markers by arithmetic as well as by the
// declined_by_user boolean — two independent guards on the same trap.
export const MIN_RETRY_AMOUNT = 1.0;
// Minimum spacing between two consecutive retry REQUESTS on one row.
//
// Without it, a double-clicked Retry button burns two of the three rungs in
// under a second — each click is a genuinely separate request, so the atomic
// claim alone (which only guarantees DISTINCT attempt numbers) cannot refuse
// the second. The ladder exists to space attempts out; a spacing floor is the
// ladder defending itself against the UI.
export const RETRY_MIN_SPACING_SECONDS = 60;

// Queue lifecycle. Only 'scheduled' is retryable.
export const QUEUE_STATES = ['scheduled', 'exhausted', 'not_retryable', 'stale', 'recovered', 'closed'];

export const DUNNING_SOURCES = ['upsell_charge', 'session'];

// ── Hard-decline denylist ────────────────────────────────────────────────────
// A SUBSTRING denylist over the lower-cased reason, covering both human
// phrasing and snake_case gateway codes. Anything NOT matched is retryable —
// including insufficient_funds, processing_error and a bare generic decline,
// which are precisely the ones worth retrying.
//
// ONE table, used by every retry decision in this module. The reference keeps
// two tables of different sizes in two engines, so the same card is retryable
// in one and not the other; that divergence is a bug, not a feature.
export const HARD_DECLINE_MARKERS = [
  'stolen', 'lost', 'fraud',
  'pickup', 'pick_up', 'pick up',
  'restricted',
  'invalid account', 'invalid_account',
  'closed account', 'closed_account',
  'do not honor', 'do_not_honor', 'do not honour', 'do_not_honour',
  'blocked',
  'expired card', 'expired_card', 'card_expired', 'card expired',
  'invalid card', 'invalid_card',
  'revoked', 'revocation',
];

export function isRetryableReason(reason) {
  const r = String(reason || '').toLowerCase();
  return !HARD_DECLINE_MARKERS.some((m) => r.includes(m));
}

// ── Reporting taxonomy (separate from the retry decision) ────────────────────
// Ordering is load-bearing: 'card_declined' is last because a real gateway
// message usually contains the word "declined" ALONGSIDE its actual reason, so
// an earlier position would swallow every other bucket.
export const DECLINE_BUCKETS = [
  ['insufficient_funds', ['insufficient funds', 'insufficient fund', 'insufficient balance', 'not sufficient funds', 'nsf']],
  ['expired_card', ['expired card', 'card expired']],
  ['payment_method_revoked', ['revoked', 'revocation', 'revoke authorization']],
  ['fraud_suspected', ['fraud', 'stolen', 'lost card', 'card lost', 'pickup', 'pick up', 'security violation']],
  ['invalid_payment_method', ['invalid account', 'closed account', 'invalid card', 'invalid number', 'incorrect number', 'invalid cvc', 'incorrect cvc', 'invalid expiry', 'incorrect expiry', 'no such customer', 'no such payment', 'no saved payment', 'no saved pm', 'payment method not found', 'missing payment method', 'invalid payment method']],
  ['do_not_honor', ['do not honor', 'do not honour']],
  ['retry_declined', ['retry declined', 'do not try again', 'try again later']],
  ['invalid_purchase_type', ['invalid purchase', 'transaction not allowed', 'not permitted', 'unsupported', 'currency not supported', 'invalid amount', 'amount below minimum']],
  ['processing_error', ['processing error', 'issuer unavailable', 'system error', 'internal error', 'timeout', 'timed out', 'network', 'connection', 'temporarily unavailable', 'service unavailable', 'not configured', 'not connected', 'gateway error', 'not chargeable']],
  ['card_declined', ['declined', 'decline', 'charge failed', 'blocked', 'restricted', 'call issuer', 'authorization failed', 'generic decline', 'card not supported']],
];

/**
 * Bucket a raw decline reason for reporting. Normalizes '_' and '-' to spaces
 * first so 'insufficient_funds' and 'Insufficient Funds' land in one bucket —
 * otherwise the "top reason" statistic splits one cause across two rows and
 * under-reports it.
 * Returns 'unknown' for anything unmatched (including an empty reason), NEVER
 * a guess: 'unknown' is a real finding an operator can act on.
 */
export function classifyDecline(reason) {
  const r = String(reason || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!r) return 'unknown';
  for (const [bucket, needles] of DECLINE_BUCKETS) {
    if (needles.some((n) => r.includes(n))) return bucket;
  }
  return 'unknown';
}

/**
 * The next scheduled attempt, or null when the ladder is spent. PURE.
 * @param {Date|string} from  the moment of the failure that produced this attempt
 * @param {number} attemptsMade
 */
export function nextRetryAt(from, attemptsMade) {
  const made = parseInt(attemptsMade, 10) || 0;
  if (made >= MAX_ATTEMPTS) return null;
  const base = from instanceof Date ? from : new Date(from);
  const ms = Number.isFinite(base.getTime()) ? base.getTime() : Date.now();
  return new Date(ms + RETRY_DELAYS_H[made] * 3600_000);
}

/**
 * Decide the queue state for a freshly-observed failure. PURE — every input is
 * explicit so the harness can drive every branch without a database.
 */
export function classifyFailure({ reason, amount, declinedByUser, failedAt, now = new Date() }) {
  const bucket = classifyDecline(reason);
  if (declinedByUser) {
    return { dunnable: false, state: 'closed', bucket: 'declined_by_user', retryable: false, why: 'declined_by_user' };
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < MIN_RETRY_AMOUNT) {
    return { dunnable: false, state: 'closed', bucket, retryable: false, why: 'amount_below_minimum' };
  }
  if (!isRetryableReason(reason)) {
    return { dunnable: true, state: 'not_retryable', bucket, retryable: false, why: 'hard_decline' };
  }
  const failed = failedAt instanceof Date ? failedAt : new Date(failedAt);
  const ageDays = (now.getTime() - (Number.isFinite(failed.getTime()) ? failed.getTime() : now.getTime())) / 86_400_000;
  if (ageDays > MAX_DECLINE_AGE_DAYS) {
    return { dunnable: true, state: 'stale', bucket, retryable: false, why: 'decline_too_old', age_days: round2(ageDays) };
  }
  return { dunnable: true, state: 'scheduled', bucket, retryable: true, why: '' };
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════════════

let tablesReadyPromise = null;

export function ensureDunningTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await ensureCheckoutTables();

  // The queue. One row per failed payment we are tracking. `source` +
  // `source_id` is the natural key and is UNIQUE, so re-running the scan over
  // the same failure updates one row instead of growing the queue every sweep.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_dunning_queue (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      funnel_id TEXT,
      offer_id TEXT,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      customer_email TEXT,
      decline_reason TEXT,
      decline_bucket TEXT NOT NULL DEFAULT 'unknown',
      retryable BOOLEAN NOT NULL DEFAULT TRUE,
      state TEXT NOT NULL DEFAULT 'scheduled',
      state_reason TEXT,
      attempts INT NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      first_failed_at TIMESTAMPTZ NOT NULL,
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_co_dunning_queue_source
    ON co_dunning_queue (source, source_id)
  `);
  // The cron's hot path: everything due, nothing else.
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_dunning_queue_due
    ON co_dunning_queue (next_retry_at)
    WHERE state = 'scheduled' AND next_retry_at IS NOT NULL
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_dunning_queue_created ON co_dunning_queue (created_at DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_co_dunning_queue_session ON co_dunning_queue (session_id)`);

  // APPEND-ONLY intent ledger. A retry REQUEST is a fact that happened; it is
  // never updated. Mutable schedule state lives on the queue row, so this table
  // can be trusted as history. UNIQUE (queue_id, attempt_no) is the second
  // guard against a double-clicked Retry — the first is the atomic claim on the
  // queue row that mints the attempt number.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS co_dunning_retry_requests (
      id BIGSERIAL PRIMARY KEY,
      queue_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempt_no INT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      requested_by TEXT,
      origin TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_co_dunning_retry_attempt
    ON co_dunning_retry_requests (queue_id, attempt_no)
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_co_dunning_retry_queue
    ON co_dunning_retry_requests (queue_id, created_at DESC)
  `);
}

const queueId = (source, sourceId) => `dq_${source === 'session' ? 's' : 'u'}_${String(sourceId).slice(0, 100)}`;

// ════════════════════════════════════════════════════════════════════════════
// SCAN — project money-path failures into the queue. Idempotent. READ-ONLY
// over co_upsell_charges / co_sessions / co_events.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} p
 * @param {number} p.days   how far back to look (windowed — an unbounded scan
 *                          over a growing ledger is a query that gets slower
 *                          forever and eventually never finishes)
 * @param {number} p.limit  hard row cap per source
 * @param {boolean} p.notify send the dunning email for newly-queued rows
 */
export async function scanFailures({ days = 7, limit = 500, notify = true, now = new Date() } = {}) {
  await ensureDunningTables();
  const win = Math.max(1, Math.min(parseInt(days, 10) || 7, 90));
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 500, 2000));

  const stats = {
    scanned_upsell: 0, scanned_session: 0,
    queued: 0, updated: 0, skipped: 0, notified: 0, notify_failed: 0,
    by_state: {}, by_bucket: {},
  };

  // ── upsell charge declines ────────────────────────────────────────────────
  // declined_by_user is excluded IN THE QUERY, not after the read: a marker row
  // must never even be a candidate.
  const upsells = await pgQuery(
    `SELECT c.id, c.session_id, c.offer_id, c.amount, c.currency, c.error,
            c.declined_by_user, c.created_at, c.updated_at,
            s.funnel_id, s.status AS session_status, s.customer ->> 'email' AS customer_email
       FROM co_upsell_charges c
       LEFT JOIN co_sessions s ON s.id = c.session_id
      WHERE c.status = 'declined'
        AND c.declined_by_user = FALSE
        AND c.updated_at >= NOW() - ($1 || ' days')::interval
      ORDER BY c.updated_at DESC
      LIMIT $2`,
    [String(win), cap]
  );
  stats.scanned_upsell = upsells.length;
  for (const row of upsells) {
    const r = await upsertQueueRow({
      source: 'upsell_charge',
      sourceId: row.id,
      sessionId: row.session_id,
      funnelId: row.funnel_id,
      offerId: row.offer_id,
      amount: Number(row.amount),
      currency: row.currency || 'USD',
      customerEmail: row.customer_email || '',
      reason: row.error || '',
      declinedByUser: row.declined_by_user,
      failedAt: row.updated_at || row.created_at,
      now,
    }, stats);
    if (r.queued && notify) await maybeNotify(r.row, stats);
  }

  // ── base-order payment failures ───────────────────────────────────────────
  // Only sessions still at 'processing'. A session that reached 'paid' or
  // 'refunded' has a settled outcome; dunning it would chase money that is
  // already accounted for.
  const sessions = await pgQuery(
    `SELECT s.id, s.funnel_id, s.total, s.currency, s.status, s.updated_at, s.created_at,
            s.last_failed_payment_id, s.customer ->> 'email' AS customer_email,
            (SELECT e.data ->> 'reason' FROM co_events e
              WHERE e.session_id = s.id AND e.kind = 'payment_failed'
              ORDER BY e.created_at DESC LIMIT 1) AS reason,
            (SELECT e.created_at FROM co_events e
              WHERE e.session_id = s.id AND e.kind = 'payment_failed'
              ORDER BY e.created_at DESC LIMIT 1) AS failed_at
       FROM co_sessions s
      WHERE s.last_failed_payment_id IS NOT NULL
        AND s.status = 'processing'
        AND s.updated_at >= NOW() - ($1 || ' days')::interval
      ORDER BY s.updated_at DESC
      LIMIT $2`,
    [String(win), cap]
  );
  stats.scanned_session = sessions.length;
  for (const row of sessions) {
    const r = await upsertQueueRow({
      source: 'session',
      sourceId: row.id,
      sessionId: row.id,
      funnelId: row.funnel_id,
      offerId: null,
      amount: Number(row.total),
      currency: row.currency || 'USD',
      customerEmail: row.customer_email || '',
      reason: row.reason || '',
      declinedByUser: false,
      failedAt: row.failed_at || row.updated_at || row.created_at,
      now,
    }, stats);
    if (r.queued && notify) await maybeNotify(r.row, stats);
  }

  return { ok: true, days: win, ...stats };
}

async function upsertQueueRow(input, stats) {
  const cls = classifyFailure({
    reason: input.reason,
    amount: input.amount,
    declinedByUser: input.declinedByUser,
    failedAt: input.failedAt,
    now: input.now,
  });
  stats.by_bucket[cls.bucket] = (stats.by_bucket[cls.bucket] || 0) + 1;
  if (!cls.dunnable) {
    stats.skipped += 1;
    return { queued: false, row: null, classification: cls };
  }
  stats.by_state[cls.state] = (stats.by_state[cls.state] || 0) + 1;

  const id = queueId(input.source, input.sourceId);
  const failedAt = input.failedAt ? new Date(input.failedAt) : new Date();
  const next = cls.state === 'scheduled' ? nextRetryAt(failedAt, 0) : null;

  // ON CONFLICT updates ONLY the classification/identity columns. attempts,
  // last_attempt_at and notified_at are deliberately absent from the DO UPDATE
  // SET: a re-scan must never reset a ladder an operator already climbed, or
  // un-send an email. next_retry_at is likewise preserved once attempts have
  // been made — re-scanning is an observation, not a reschedule.
  const rows = await pgQuery(
    `INSERT INTO co_dunning_queue (
       id, source, source_id, session_id, funnel_id, offer_id, amount, currency,
       customer_email, decline_reason, decline_bucket, retryable, state, state_reason,
       attempts, next_retry_at, first_failed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15,$16)
     ON CONFLICT (source, source_id) DO UPDATE SET
       decline_reason = EXCLUDED.decline_reason,
       decline_bucket = EXCLUDED.decline_bucket,
       retryable = EXCLUDED.retryable,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       customer_email = COALESCE(NULLIF(EXCLUDED.customer_email, ''), co_dunning_queue.customer_email),
       state = CASE
         WHEN co_dunning_queue.state IN ('recovered', 'closed', 'exhausted') THEN co_dunning_queue.state
         ELSE EXCLUDED.state END,
       state_reason = EXCLUDED.state_reason,
       next_retry_at = CASE
         WHEN co_dunning_queue.attempts > 0 THEN co_dunning_queue.next_retry_at
         ELSE EXCLUDED.next_retry_at END,
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      id, input.source, String(input.sourceId), input.sessionId,
      input.funnelId || null, input.offerId || null,
      round2(input.amount), String(input.currency || 'USD').toUpperCase(),
      String(input.customerEmail || '').slice(0, 254),
      String(input.reason || '').slice(0, 300), cls.bucket, cls.retryable,
      cls.state, cls.why || null, next, failedAt,
    ]
  );
  const row = rows[0];
  if (row?.inserted) stats.queued += 1; else stats.updated += 1;
  return { queued: Boolean(row?.inserted), row, classification: cls };
}

// ════════════════════════════════════════════════════════════════════════════
// KLAVIYO DUNNING EVENT — exactly-once, claim-before-send
// ════════════════════════════════════════════════════════════════════════════

async function releaseOrReport(ref, where) {
  try {
    await _deps.releaseSend(KLAVIYO_KIND, ref);
  } catch (relErr) {
    console.error(`[dunning] ORPHANED CLAIM ${KLAVIYO_KIND}/${ref} — ${where} release failed (${relErr.message}); delete the lb_integration_sends row by hand to re-enable this event`);
  }
}

export const dunningSendRef = (queueRowId) => `kdf_${String(queueRowId || '').slice(0, 120)}`;

/**
 * Send ONE dunning email per queued failure, ever.
 *
 * Idempotency is two-layer, exactly as klaviyoEvents.js:
 *   1. ours   — lb_integration_sends (kind, ref) atomic claim taken BEFORE the
 *               network call, so an overlapping cron and a manual scan cannot
 *               both send.
 *   2. theirs — the same ref rides Klaviyo's unique_id, so even a
 *               release-then-reclaim race cannot double-count on their side.
 *
 * A claim whose send did NOT reach Klaviyo is RELEASED — on the {ok:false}
 * path AND in the catch. A throw between claim and send would otherwise orphan
 * the claim and turn every later attempt into deduped:true while the buyer
 * received nothing.
 *
 * NEVER throws. A marketing failure must not touch the money path.
 */
export async function sendDunningEvent(queueRow, { markRow = true } = {}) {
  const ref = dunningSendRef(queueRow?.id);
  let claimed = false;
  let delivered = false;
  try {
    if (!queueRow?.id) return { ok: false, error: 'bad_row' };
    const cfg = await _deps.getKlaviyoConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, skipped: true, error: 'not_configured' };

    const email = String(queueRow.customer_email || '').trim().toLowerCase();
    // Shape check only — the goal is to catch "no @" / "no dot", the typos that
    // would send a dunning email into the void.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return { ok: false, skipped: true, error: 'no_deliverable_email' };
    }
    // A hard decline gets no "we'll try again" email — the promise would be
    // false. The operator surface still shows the row.
    if (!queueRow.retryable) return { ok: false, skipped: true, error: 'not_retryable' };

    // Everything is read and shaped BEFORE the claim, so the claim-to-send
    // window holds only the send calls themselves.
    const props = {
      queue_id: queueRow.id,
      session_id: queueRow.session_id,
      source: queueRow.source,
      reason_bucket: queueRow.decline_bucket || 'unknown',
      reason: String(queueRow.decline_reason || '').slice(0, 200),
      currency: queueRow.currency || 'USD',
      attempts: Number(queueRow.attempts) || 0,
      next_retry_at: queueRow.next_retry_at ? new Date(queueRow.next_retry_at).toISOString() : null,
      funnel_id: queueRow.funnel_id || '',
    };

    claimed = await _deps.claimSend(KLAVIYO_KIND, ref);
    if (!claimed) return { ok: true, deduped: true };

    // Lead-scope PII: the buyer has NOT completed this purchase, so the profile
    // carries email only — same posture as klaviyoEvents' non-paid path.
    const prof = await _deps.upsertProfile({ email }, { apiKey: cfg.apiKey });
    const sent = await _deps.trackEvent({
      metric_name: DUNNING_METRIC,
      email,
      value: Number(queueRow.amount) || 0,
      unique_id: ref,
      properties: props,
    }, { apiKey: cfg.apiKey });
    delivered = Boolean(sent.ok);

    if (!sent.ok) {
      await releaseOrReport(ref, 'failed-send');
      return { ok: false, error: sent.error || 'send_failed', profile_ok: prof.ok };
    }
    if (markRow) {
      await pgQuery(
        `UPDATE co_dunning_queue SET notified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND notified_at IS NULL`,
        [queueRow.id]
      ).catch((err) => console.error('[dunning] notified_at stamp failed (non-fatal):', err.message));
    }
    return { ok: true, profile_ok: prof.ok };
  } catch (err) {
    console.error(`[dunning] ${DUNNING_METRIC} for ${String(queueRow?.id).slice(0, 80)} failed:`, err.message);
    if (claimed && !delivered) await releaseOrReport(ref, 'error-path');
    return { ok: false, error: `internal:${err.code || err.name || 'error'}` };
  }
}

async function maybeNotify(row, stats) {
  if (!row) return;
  const r = await sendDunningEvent(row);
  if (r.ok && !r.deduped) stats.notified += 1;
  else if (!r.ok && !r.skipped) stats.notify_failed += 1;
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

export async function listQueue({ days = 30, state = 'open', bucket = '', limit = 50, offset = 0 } = {}) {
  await ensureDunningTables();
  const win = Math.max(1, Math.min(parseInt(days, 10) || 30, 90));
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  const where = [`q.first_failed_at >= NOW() - ($1 || ' days')::interval`];
  const params = [String(win)];
  // 'open' is the operator's default question — everything still costing money.
  if (state === 'open') where.push(`q.state IN ('scheduled', 'not_retryable', 'stale', 'exhausted')`);
  else if (QUEUE_STATES.includes(state)) { params.push(state); where.push(`q.state = $${params.length}`); }
  else if (state && state !== 'all') return { rows: [], total: 0, limit: lim, offset: off, days: win, stats: emptyStats(), error: 'bad_state' };
  if (bucket) { params.push(String(bucket).slice(0, 64)); where.push(`q.decline_bucket = $${params.length}`); }
  const whereSql = where.join(' AND ');

  // has_saved_pm / retry_possible ride EVERY list row so the client's
  // "Request retry" button gates on the same precondition the write path
  // enforces. Without it the button gated on state==='scheduled' alone and
  // would offer a retry the server will (now) refuse — a button that lies
  // about what it can do. retry_possible mirrors requestRetry's claim WHERE
  // (scheduled + retryable + under the cap + a saved card); the spacing floor
  // is deliberately NOT folded in here — a row inside its cooldown is still
  // "retryable, just not this second", and the button's job is to show whether
  // a retry is possible at all, not to run a clock.
  const rows = await pgQuery(
    `SELECT q.*,
            (SELECT COUNT(*)::int FROM co_dunning_retry_requests r WHERE r.queue_id = q.id) AS retry_requests,
            (SELECT MAX(created_at) FROM co_dunning_retry_requests r WHERE r.queue_id = q.id) AS last_request_at,
            (COALESCE(s.payment_method_id, '') <> '') AS has_saved_pm,
            (q.state = 'scheduled' AND q.retryable = TRUE AND q.attempts < ${MAX_ATTEMPTS}
             AND COALESCE(s.payment_method_id, '') <> '') AS retry_possible
       FROM co_dunning_queue q
       LEFT JOIN co_sessions s ON s.id = q.session_id
      WHERE ${whereSql}
      ORDER BY q.first_failed_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  const [{ n }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM co_dunning_queue q WHERE ${whereSql}`, params
  );
  const [agg] = await pgQuery(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE q.state = 'scheduled')::int AS scheduled,
       COUNT(*) FILTER (WHERE q.state = 'exhausted')::int AS exhausted,
       COUNT(*) FILTER (WHERE q.state = 'not_retryable')::int AS not_retryable,
       COUNT(*) FILTER (WHERE q.state = 'stale')::int AS stale,
       COUNT(*) FILTER (WHERE q.state = 'recovered')::int AS recovered,
       COALESCE(SUM(q.amount) FILTER (WHERE q.state IN ('scheduled','not_retryable','stale','exhausted')), 0)::numeric AS at_risk,
       COALESCE(SUM(q.amount) FILTER (WHERE q.state = 'recovered'), 0)::numeric AS recovered_amount
     FROM co_dunning_queue q WHERE ${whereSql}`,
    params
  );
  const buckets = await pgQuery(
    `SELECT q.decline_bucket AS bucket, COUNT(*)::int AS n, COALESCE(SUM(q.amount),0)::numeric AS amount
       FROM co_dunning_queue q WHERE ${whereSql}
      GROUP BY q.decline_bucket ORDER BY n DESC LIMIT 12`,
    params
  );
  const failedTotal = agg.total || 0;
  const top = buckets[0] || null;
  return {
    rows,
    total: n,
    limit: lim,
    offset: off,
    days: win,
    state,
    stats: {
      total: agg.total,
      scheduled: agg.scheduled,
      exhausted: agg.exhausted,
      not_retryable: agg.not_retryable,
      stale: agg.stale,
      recovered: agg.recovered,
      at_risk: Number(agg.at_risk),
      recovered_amount: Number(agg.recovered_amount),
      buckets: buckets.map((b) => ({ bucket: b.bucket, count: b.n, amount: Number(b.amount) })),
      top_bucket: top?.bucket || '',
      // Guarded: a 0-row window must report 0%, not NaN%.
      top_bucket_pct: failedTotal > 0 && top ? Math.round((top.n * 100) / failedTotal) : 0,
    },
  };
}

function emptyStats() {
  return { total: 0, scheduled: 0, exhausted: 0, not_retryable: 0, stale: 0, recovered: 0, at_risk: 0, recovered_amount: 0, buckets: [], top_bucket: '', top_bucket_pct: 0 };
}

export async function readQueueRow(id) {
  await ensureDunningTables();
  const rows = await pgQuery(`SELECT * FROM co_dunning_queue WHERE id = $1`, [String(id || '').slice(0, 140)]);
  if (!rows.length) return { ok: false, error: 'not_found' };
  const q = rows[0];
  const [requests, session, source] = await Promise.all([
    pgQuery(
      `SELECT id, attempt_no, amount, currency, requested_by, origin, note, created_at
         FROM co_dunning_retry_requests WHERE queue_id = $1 ORDER BY attempt_no ASC LIMIT 50`,
      [q.id]
    ),
    pgQuery(
      `SELECT id, status, total, currency, gateway, payment_method_id IS NOT NULL AS has_saved_pm,
              customer ->> 'email' AS customer_email, created_at, paid_at
         FROM co_sessions WHERE id = $1`,
      [q.session_id]
    ),
    q.source === 'upsell_charge'
      ? pgQuery(
          `SELECT id, offer_id, charge_id, amount, currency, status, error, declined_by_user,
                  gateway_payment_id, created_at, updated_at
             FROM co_upsell_charges WHERE id = $1`,
          [q.source_id]
        )
      : Promise.resolve([]),
  ]);
  return {
    ok: true,
    queue: q,
    retry_requests: requests,
    session: session[0] || null,
    source_row: source[0] || null,
    // The integrator's precondition, surfaced so an operator is not told to
    // retry a charge that has no card behind it.
    retry_possible: q.state === 'scheduled'
      && q.attempts < MAX_ATTEMPTS
      && Boolean(session[0]?.has_saved_pm),
    retry_blocked_reason: q.state !== 'scheduled'
      ? `state:${q.state}`
      : q.attempts >= MAX_ATTEMPTS
        ? 'attempts_exhausted'
        : !session[0]?.has_saved_pm
          ? 'no_saved_payment_method'
          : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RETRY INTENT — records the ask, advances the ladder, charges NOTHING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Record a retry request.
 *
 * The claim is an atomic conditional UPDATE on the queue row: it mints the
 * attempt number AND enforces the ladder in one statement, so two operators
 * double-clicking Retry produce one intent row and one precise refusal. The
 * UNIQUE (queue_id, attempt_no) index is the second guard.
 *
 * NO GATEWAY CALL HAPPENS HERE. See MONEY SEAM at the bottom of this file.
 */
export async function requestRetry({ queueId: qid, actor = '', origin = 'manual', note = '' } = {}) {
  await ensureDunningTables();
  const id = String(qid || '').slice(0, 140);
  if (!id) return { ok: false, error: 'queue_id_required', status: 400 };

  const [existing] = await pgQuery(`SELECT * FROM co_dunning_queue WHERE id = $1`, [id]);
  if (!existing) return { ok: false, error: 'not_found', status: 404 };

  // The atomic claim. Every condition here is a refusal an operator needs
  // named, so the failure branch re-reads and reports the SPECIFIC one rather
  // than a generic "could not retry".
  //
  // The correlated EXISTS on co_sessions.payment_method_id is LOAD-BEARING, not
  // a nicety: the integrator contract says a retry with no vaulted card MUST be
  // refused, and this is the ONLY write-path enforcement of it. Without the
  // predicate in the WHERE, a scheduled row on a session with no saved card
  // would advance attempts and write a dishonest intent row — driving the row
  // to 'exhausted' against a card that could never have been charged. Enforcing
  // it in the claim (rather than a read-then-write) means a card removed
  // between the display flag and the click still refuses, and it never burns a
  // rung. NULL payment_method_id (no card) and '' are both treated as no card.
  const claimed = await pgQuery(
    `UPDATE co_dunning_queue q
        SET attempts = attempts + 1,
            last_attempt_at = NOW(),
            next_retry_at = CASE
              WHEN attempts + 1 >= $2 THEN NULL
              ELSE NOW() + (($3::int[])[attempts + 2] || ' hours')::interval END,
            state = CASE WHEN attempts + 1 >= $2 THEN 'exhausted' ELSE 'scheduled' END,
            updated_at = NOW()
      WHERE q.id = $1 AND q.state = 'scheduled' AND q.retryable = TRUE AND q.attempts < $2
        AND (q.last_attempt_at IS NULL
             OR q.last_attempt_at <= NOW() - ($4 || ' seconds')::interval)
        AND EXISTS (
          SELECT 1 FROM co_sessions s
           WHERE s.id = q.session_id
             AND COALESCE(s.payment_method_id, '') <> '')
      RETURNING *`,
    [id, MAX_ATTEMPTS, RETRY_DELAYS_H, String(RETRY_MIN_SPACING_SECONDS)]
  );
  if (!claimed.length) {
    // Re-read rather than reporting the pre-claim snapshot: a request that lost
    // a race must describe the world as it is NOW, not as it was when it
    // started. Reporting the stale row is how "attempts_exhausted" gets shown
    // for a row that is merely rate-limited. The has_saved_pm read is part of
    // this re-read so the missing-card refusal is named precisely.
    const [fresh] = await pgQuery(
      `SELECT q.*, (COALESCE(s.payment_method_id, '') <> '') AS has_saved_pm
         FROM co_dunning_queue q
         LEFT JOIN co_sessions s ON s.id = q.session_id
        WHERE q.id = $1`,
      [id]
    );
    const row = fresh || existing;
    const reason = row.state !== 'scheduled'
      ? `state:${row.state}`
      : !row.retryable
        ? 'hard_decline_not_retryable'
        : row.attempts >= MAX_ATTEMPTS
          ? 'attempts_exhausted'
          : !row.has_saved_pm
            ? 'no_saved_payment_method'
            : 'retry_too_soon';
    return { ok: false, error: reason, status: 409, queue: row, min_spacing_seconds: RETRY_MIN_SPACING_SECONDS };
  }
  const row = claimed[0];

  let request;
  try {
    const ins = await pgQuery(
      `INSERT INTO co_dunning_retry_requests
         (queue_id, session_id, attempt_no, amount, currency, requested_by, origin, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (queue_id, attempt_no) DO NOTHING
       RETURNING id, queue_id, attempt_no, amount, currency, requested_by, origin, created_at`,
      [row.id, row.session_id, row.attempts, row.amount, row.currency,
        String(actor || '').slice(0, 200),
        origin === 'scheduled' ? 'scheduled' : 'manual',
        String(note || '').slice(0, 1000)]
    );
    request = ins[0] || null;
  } catch (err) {
    console.error('[dunning] retry intent write failed:', err.message);
    return { ok: false, error: 'intent_write_failed', status: 500, queue: row };
  }

  try {
    await pgQuery(
      `INSERT INTO co_events (session_id, kind, data) VALUES ($1, 'dunning_retry_requested', $2)`,
      [row.session_id, {
        queue_id: row.id, source: row.source, source_id: row.source_id,
        attempt_no: row.attempts, amount: Number(row.amount), currency: row.currency,
        decline_bucket: row.decline_bucket, by: String(actor || '').slice(0, 200), origin,
      }]
    );
  } catch (err) {
    console.error('[dunning] retry event write failed (non-fatal):', err.message);
  }

  return {
    ok: true,
    // Said out loud in the payload so no caller can mistake an intent for a
    // charge. The UI renders this verbatim.
    charged: false,
    money_moved: false,
    queue: row,
    request,
    attempt_no: row.attempts,
    next_retry_at: row.next_retry_at,
    state: row.state,
  };
}

/**
 * Close a queue row. Used when a failure resolved outside this module (the
 * buyer paid another way, the operator refunded, the charge settled late).
 * Records WHY — a closed row with no reason is indistinguishable from a bug.
 */
export async function closeQueueRow({ queueId: qid, state = 'closed', actor = '', reason = '' } = {}) {
  await ensureDunningTables();
  const target = ['recovered', 'closed'].includes(state) ? state : null;
  if (!target) return { ok: false, error: 'bad_state', status: 400 };
  const rows = await pgQuery(
    `UPDATE co_dunning_queue
        SET state = $2, state_reason = $3, next_retry_at = NULL, updated_at = NOW()
      WHERE id = $1 AND state NOT IN ('recovered', 'closed')
      RETURNING *`,
    [String(qid || '').slice(0, 140), target, String(reason || `closed_by:${actor}`).slice(0, 300)]
  );
  if (!rows.length) {
    const [existing] = await pgQuery(`SELECT state FROM co_dunning_queue WHERE id = $1`, [String(qid || '').slice(0, 140)]);
    if (!existing) return { ok: false, error: 'not_found', status: 404 };
    return { ok: false, error: 'already_closed', status: 409, current_state: existing.state };
  }
  return { ok: true, queue: rows[0] };
}

// ════════════════════════════════════════════════════════════════════════════
// MONEY SEAM — THE CONTRACT FOR THE INTEGRATOR
//
// Everything above records INTENT. Nothing above calls a gateway. To make a
// retry actually charge, the integrator adds ONE function in the gateway lane
// (NOT in this file) with this shape:
//
//   async function chargeDunningRetry({ queueId, attemptNo }) → {ok, paymentId, declineReason}
//
// It must, in this order:
//   1. read the queue row + its session (readQueueRow gives both, plus
//      `retry_possible` and the exact `retry_blocked_reason`);
//   2. refuse unless session.payment_method_id is present AND the session
//      status is one where a saved credential may be reused — a dunning retry
//      on a session with no vaulted PM is a guaranteed decline that still
//      burns a ladder rung (this is now also enforced in requestRetry's claim,
//      but the charger must re-check: the card can be removed between the
//      intent and the charge);
//   2b. RE-VERIFY the underlying charge is STILL declined immediately before
//      charging. The queue is built by a periodic scan, so a payment recovered
//      out-of-band (webhook, manual settle, a late async settlement) between
//      the last scan and this charge would otherwise be collected a second
//      time. With a retry window up to 72h wide, that lag is the expected case;
//   3. charge with the idempotency key  `dun_<queue_id>_<attempt_no>`. That
//      key is DETERMINISTIC and already unique by construction, because the
//      attempt number is minted by the atomic claim in requestRetry() and
//      guarded by UNIQUE (queue_id, attempt_no). Re-running the same attempt
//      can never double-charge;
//   4. carry metadata that MIRRORS THE ORIGINAL ACCEPT PATH BYTE-FOR-BYTE. The
//      live webhook router keys STRICTLY on the literal string 'upsell'
//      (gatewayWebhooks.js: the Whop path at `kind === 'upsell'`, the Stripe
//      twin at `(metadata.kind || '') === 'upsell'`), and the accept path
//      stamps exactly these values (checkoutPublic.js):
//        - an UPSELL charge → `{ co_session_id, kind: 'upsell', charge_row: <source_id> }`
//        - a BASE charge    → `{ co_session_id, kind: '0' }`  (absent is also
//          treated as base — the router maps '0' → '' before matching)
//      ⛔ Do NOT invent a kind. A value like 'post_purchase_upsell' or 'base'
//      matches NOTHING: the webhook skips the upsell branch, falls through to
//      the base handler, finds the session already 'paid', acks already_paid,
//      and NEVER calls settleUpsellCharge — so the money is captured while the
//      charge row stays 'declined' and gets re-dunned. For a dunning retry the
//      source is an upsell charge row, so `kind: 'upsell'` + the row's own id
//      as `charge_row` is the correct, and only, value;
//   5. report the outcome back through the EXISTING money-path functions —
//      settleUpsellCharge / failUpsellCharge in checkoutSettle.js. This module
//      must NOT be the thing that flips a charge status. It then observes the
//      new status on its next scan;
//   6. call closeQueueRow({ queueId, state: 'recovered' }) on success.
//
// What must NOT be added here: a direct UPDATE of co_upsell_charges.status, a
// re-implementation of the amount reconciliation, or an automatic retry loop
// that fires without an intent row. Each of those makes this queue a second
// source of truth about money, and two sources of truth about money is the
// failure mode the whole checkout lane is built to avoid.
// ════════════════════════════════════════════════════════════════════════════

export default {
  ensureDunningTables,
  scanFailures,
  listQueue,
  readQueueRow,
  requestRetry,
  closeQueueRow,
  sendDunningEvent,
  dunningSendRef,
  classifyDecline,
  classifyFailure,
  isRetryableReason,
  nextRetryAt,
  MAX_ATTEMPTS,
  RETRY_DELAYS_H,
  QUEUE_STATES,
  HARD_DECLINE_MARKERS,
  DUNNING_METRIC,
  RETRY_MIN_SPACING_SECONDS,
  _deps,
};
