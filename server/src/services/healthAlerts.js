// HEALTH ALERTS — a durable, acknowledgeable record of operational faults.
//
// Ported in CAPABILITY from funnel-os's system-alert surface. The shape of the
// idea is the same (a row per fault, a severity, an acknowledgement), but the
// decisions below are deliberately different because each one is a defect this
// port is not obliged to inherit:
//
//   1. DEDUP / COOLDOWN. A monitor that runs on a timer and writes a row every
//      time a condition is still true does not produce an alert list — it
//      produces a log nobody reads. A stale spend feed left over a weekend at a
//      5-minute sweep is 576 identical rows. Here every write goes through a
//      per-KIND cooldown (`DEFAULT_COOLDOWN_MS`), so a persistent condition
//      costs one row per hour, and `recordAlert` REPORTS the suppression
//      (`{ created: false, suppressed_by }`) rather than lying about having
//      written one.
//   2. CAPS. `message` and `context` arrive from call sites that are, by
//      definition, already having a bad day — a 4MB error body pasted into an
//      alert context is exactly the sort of thing a failure path does. Both are
//      bounded here, and an over-cap context is REPLACED with a marker that
//      says so rather than silently truncated into invalid JSON.
//   3. THE SWEEP CANNOT TAKE THE PROCESS DOWN. Every check is independently
//      guarded and a missing table (42P01 — a deployment where that lane has
//      never run) is a SKIPPED check with a reason, not an exception. The
//      monitor must never be the thing that breaks.
//   4. NO ABSOLUTE COUNT IS REPORTED AS A TREND. "needs_review count rising"
//      is a claim about TWO observations. On the first sweep after boot there
//      is only one, so the check records a baseline and emits NOTHING. A
//      restart can therefore never manufacture a false rise — it can only
//      delay a true one by one interval, which is the conservative direction.
//   5. THE SWEEP IS ON AN IN-PROCESS TIMER. funnel-os's equivalent
//      (lb_alerts_service.run_all) has NO schedule at all — its only caller is
//      an HTTP cron endpoint bolted onto the PayPal router, so on a deployment
//      where that external cron was never configured, alerting silently never
//      ran. The timer here starts from the route module on load and is turned
//      off by env, not by omission.
//   6. ACK IS IDEMPOTENT. funnel-os's ack matches `status: "open"` only and
//      404s on a second ack (lb_alerts_service.py:397), conflating "already
//      acknowledged" with "does not exist" — a double-click reads as a bug.
//      Here a repeat ack answers 200 and preserves the ORIGINAL acked_by.
//   7. SEVERITY IS AN ENUM. funnel-os's is a free string set at three call
//      sites with no validation, so a typo makes an alert unfilterable.
//
// ⚠️ DEFERRED, STATED PLAINLY: there is NO retention/purge on lb_health_alerts.
// funnel-os has none either and its table grows forever. The cooldown bounds
// the rate hard (one row per kind per hour ⇒ a worst case of ~24 rows per kind
// per day), so this is a slow leak rather than an open tap, but a retention
// sweep is real remaining work and is NOT pretended to exist here.
//
// ─────────────────────────────────────────────────────────────────────────────
// FOR CALL SITES
//   import { recordAlert } from '../services/healthAlerts.js';
//   await recordAlert('tracking_breaker_open', 'critical',
//     `Postback breaker opened for ${scopeId}`, { scope_id: scopeId, fails });
//
// `recordAlert` THROWS on a programmer error (unknown severity, missing kind)
// — that is a bug in the call site and must not be swallowed. It does NOT
// throw on the cooldown path. A call site on a failure path should still wrap
// it, because an alert that fails to write must never break the thing it was
// watching:
//   try { await recordAlert(...); } catch (e) { console.error(...); }
//
// DORMANT CALL SITES — wired by the integrator, NOT by this lane (each lives in
// a file this lane's fence does not admit):
//   • services/trackingDelivery.js — when a postback breaker OPENS
//     ('tracking_breaker_open', 'critical')
//   • services/funnelSpend.js      — when a source's fail_streak reaches 3
//     ('spend_sync_failing', 'warn')
//   • services/mediaService.js     — on a 503 from media storage
//     ('media_storage_unavailable', 'warn')
//   • services/trackingSweeps.js   — when the drain moves rows to 'dead'
//     ('postback_dead_letters', 'warn')
// Until those land, the 5-minute sweep below is the LIVE producer: it needs no
// call site because it reads state the app already keeps.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'crypto';
import { pgQuery } from '../db/pg.js';

const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`; // matches funnels.js

export const SEVERITIES = ['info', 'warn', 'critical'];
const SEVERITY_SET = new Set(SEVERITIES);

// ── Caps ───────────────────────────────────────────────────────────────────
export const MAX_KIND_LEN = 120;
export const MAX_MESSAGE_LEN = 2000;
export const MAX_CONTEXT_BYTES = 16 * 1024; // 16KB
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

// One alert per kind per hour, unless a call site asks for tighter/looser.
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

// ── Sweep thresholds (the LIVE producer) ───────────────────────────────────
export const POSTBACK_QUEUE_DEPTH_THRESHOLD = 100;
export const SPEND_STALE_HOURS = 12;
// A rise smaller than this is noise — needs_review moves by one all day long.
export const NEEDS_REVIEW_RISE_MIN = 5;
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const UNDEFINED_TABLE = '42P01';

let ensured = false;

/**
 * Create the alert table on demand. Same posture as funnels.js ensureTables /
 * trackingSchema.js — this lane owns `lb_health_alerts` and no migration file
 * is touched (migrations are a shared, coordinated surface).
 */
export async function ensureHealthAlertTables() {
  if (ensured) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_health_alerts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      context JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acked_at TIMESTAMPTZ,
      acked_by TEXT
    )
  `);
  // The list endpoint orders unacked-first then newest-first; the cooldown read
  // asks "most recent row of this kind". Both are covered here.
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_health_alerts_feed ON lb_health_alerts (created_at DESC)`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_health_alerts_kind ON lb_health_alerts (kind, created_at DESC)`
  );
  ensured = true;
}

// Test seam: the harness drops and recreates the database between runs, so the
// module-level "already ensured" latch has to be resettable.
export function _resetEnsured() {
  ensured = false;
}

function boundedContext(context) {
  if (context === undefined || context === null) return {};
  if (typeof context !== 'object' || Array.isArray(context)) {
    // A non-object context is a call-site mistake that must not cost the alert.
    return { value: String(context).slice(0, 500) };
  }
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
  } catch {
    return { context_unserializable: true };
  }
  if (bytes > MAX_CONTEXT_BYTES) {
    // REPLACED, not truncated: half a JSON document is worse than an honest
    // marker, and the operator needs to know the detail did not survive.
    return { context_too_large: true, bytes, limit: MAX_CONTEXT_BYTES };
  }
  return context;
}

/**
 * Record one alert, subject to a per-kind cooldown.
 *
 * @param {string} kind      stable machine key, e.g. 'spend_sync_stale:meta'
 * @param {'info'|'warn'|'critical'} severity
 * @param {string} message   operator-language sentence
 * @param {object} [context] structured detail (bounded, see MAX_CONTEXT_BYTES)
 * @param {{cooldownMs?: number}} [opts]
 * @returns {Promise<{created: true, alert: object} | {created: false, reason: 'cooldown', suppressed_by: string, cooldown_ms: number}>}
 * @throws {TypeError} on an unknown severity or an empty kind — a call-site bug
 */
export async function recordAlert(kind, severity, message, context, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const k = String(kind ?? '').trim().slice(0, MAX_KIND_LEN);
  if (!k) throw new TypeError('recordAlert: kind is required');
  if (!SEVERITY_SET.has(severity)) {
    throw new TypeError(`recordAlert: severity must be one of ${SEVERITIES.join(', ')} (got ${JSON.stringify(severity)})`);
  }
  const msg = String(message ?? '').slice(0, MAX_MESSAGE_LEN);
  const ctx = boundedContext(context);

  await ensureHealthAlertTables();

  const cool = Number.isFinite(Number(cooldownMs)) && Number(cooldownMs) >= 0
    ? Number(cooldownMs)
    : DEFAULT_COOLDOWN_MS;

  if (cool > 0) {
    // THE COOLDOWN IS PER KIND AND IGNORES ACK STATE. An acked alert still
    // proves an operator was told within the window; re-raising immediately
    // after an ack would make acknowledging the loudest way to get more noise.
    const [recent] = await pgQuery(
      `SELECT id FROM lb_health_alerts
       WHERE kind = $1 AND created_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')
       ORDER BY created_at DESC LIMIT 1`,
      [k, Math.round(cool)]
    );
    if (recent) {
      return { created: false, reason: 'cooldown', suppressed_by: recent.id, cooldown_ms: cool };
    }
  }

  const [row] = await pgQuery(
    `INSERT INTO lb_health_alerts (id, kind, severity, message, context)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, severity, message, context, created_at, acked_at, acked_by`,
    // Raw object — postgres.js serializes JSONB itself. JSON.stringify here
    // would store the TEXT as a jsonb STRING scalar (funnelTransfer.js:669).
    [genId('hal'), k, severity, msg, ctx]
  );
  return { created: true, alert: row };
}

/**
 * Page the alert feed. UNACKED FIRST, then newest first — an operator opening
 * this surface is looking for what still needs them, not for history.
 *
 * @returns {Promise<{items: object[], total: number, unacked: number, limit: number, offset: number, has_more: boolean}>}
 */
export async function listAlerts({ limit, offset, severity, acked } = {}) {
  await ensureHealthAlertTables();

  const lim = Math.min(
    Math.max(Number.isFinite(Number(limit)) && limit !== undefined && limit !== '' ? Math.trunc(Number(limit)) : DEFAULT_PAGE_LIMIT, 1),
    MAX_PAGE_LIMIT
  );
  const off = Math.max(
    Number.isFinite(Number(offset)) && offset !== undefined && offset !== '' ? Math.trunc(Number(offset)) : 0,
    0
  );

  const where = [];
  const params = [];
  if (severity !== undefined && severity !== null && severity !== '') {
    if (!SEVERITY_SET.has(severity)) {
      return { ok: false, status: 400, error: 'invalid_severity', detail: `severity must be one of ${SEVERITIES.join(', ')}` };
    }
    params.push(severity);
    where.push(`severity = $${params.length}`);
  }
  if (acked === true) where.push('acked_at IS NOT NULL');
  else if (acked === false) where.push('acked_at IS NULL');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = await pgQuery(
    `SELECT id, kind, severity, message, context, created_at, acked_at, acked_by
     FROM lb_health_alerts ${whereSql}
     ORDER BY (acked_at IS NULL) DESC, created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, off]
  );
  const [{ n: total }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM lb_health_alerts ${whereSql}`,
    params
  );
  // `unacked` is deliberately UNFILTERED — it is the badge count for the whole
  // surface, so a severity filter must not make it shrink and read as progress.
  const [{ n: unacked }] = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM lb_health_alerts WHERE acked_at IS NULL`
  );

  return { ok: true, items, total, unacked, limit: lim, offset: off, has_more: off + items.length < total };
}

/**
 * Acknowledge one alert. IDEMPOTENT: a second ack answers 200 with the row
 * unchanged — the original acked_at and acked_by are preserved, so the record
 * keeps naming whoever actually looked first.
 */
export async function ackAlert(id, userId) {
  await ensureHealthAlertTables();
  const alertId = String(id ?? '').slice(0, 120);
  if (!alertId) return { ok: false, status: 400, error: 'alert_id_required' };

  const [updated] = await pgQuery(
    `UPDATE lb_health_alerts SET acked_at = NOW(), acked_by = $2
     WHERE id = $1 AND acked_at IS NULL
     RETURNING id, kind, severity, message, context, created_at, acked_at, acked_by`,
    [alertId, String(userId ?? '').slice(0, 120) || null]
  );
  if (updated) return { ok: true, alert: updated, already_acked: false };

  // Zero rows means EITHER unknown id OR already acked — two different answers.
  const [existing] = await pgQuery(
    `SELECT id, kind, severity, message, context, created_at, acked_at, acked_by
     FROM lb_health_alerts WHERE id = $1`,
    [alertId]
  );
  if (!existing) return { ok: false, status: 404, error: 'alert_not_found' };
  return { ok: true, alert: existing, already_acked: true };
}

// ── THE SWEEP ──────────────────────────────────────────────────────────────

// Previous observation of the needs_review backlog. null = "no baseline yet".
// See decision 4 at the top of this file: an absolute count is not a trend.
let lastNeedsReview = null;
export function _resetSweepState() { lastNeedsReview = null; }

// A check whose table does not exist on THIS deployment is skipped, not failed:
// the lane that owns the table may simply never have run here.
async function guarded(name, fn, out) {
  try {
    await fn();
  } catch (err) {
    if (err?.code === UNDEFINED_TABLE) {
      out.skipped.push({ check: name, reason: 'table_missing' });
      return;
    }
    // Any OTHER error is a real fault in the monitor. It is reported and the
    // remaining checks still run — one broken check must not blind the others.
    out.errors.push({ check: name, error: err?.message || String(err) });
  }
}

/**
 * Run every rule once. Safe to call directly (the harness does) and safe to
 * call on a timer (startHealthAlertSweep does).
 *
 * @returns {Promise<{alerts: object[], observations: object, skipped: object[], errors: object[]}>}
 */
export async function runHealthAlertSweep() {
  const out = { alerts: [], observations: {}, skipped: [], errors: [] };
  await ensureHealthAlertTables();

  const raise = async (kind, severity, message, context) => {
    const r = await recordAlert(kind, severity, message, context);
    if (r.created) out.alerts.push(r.alert);
    else out.skipped.push({ check: kind, reason: 'cooldown', suppressed_by: r.suppressed_by });
  };

  // ── 1. Postback queue depth ──────────────────────────────────────────────
  // 'queued' + 'sending' is the BACKLOG. 'done' and 'dead' are terminal and
  // are pruned on their own schedule (trackingSweeps.js:20) — counting them
  // would make the alert fire on history instead of on a stuck drain.
  await guarded('postback_queue_depth', async () => {
    const [{ n }] = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM lb_postback_queue WHERE status IN ('queued','sending')`
    );
    out.observations.postback_queue_depth = n;
    if (n > POSTBACK_QUEUE_DEPTH_THRESHOLD) {
      await raise(
        'postback_queue_depth', 'warn',
        `Postback queue backlog is ${n} (threshold ${POSTBACK_QUEUE_DEPTH_THRESHOLD}) — deliveries are not draining.`,
        { depth: n, threshold: POSTBACK_QUEUE_DEPTH_THRESHOLD }
      );
    }
  }, out);

  // ── 2. Spend sync staleness ──────────────────────────────────────────────
  // PER SOURCE, because "spend is stale" without naming the feed is not
  // actionable. A source that has NEVER synced (last_sync IS NULL) counts as
  // stale — a feed configured and never delivering is the failure, not a
  // missing baseline.
  await guarded('spend_sync_stale', async () => {
    const rows = await pgQuery(
      `SELECT source, last_sync, last_attempt, fail_streak,
              EXTRACT(EPOCH FROM (NOW() - last_sync)) / 3600.0 AS hours_stale
       FROM lb_spend_sync_state
       WHERE last_sync IS NULL OR last_sync < NOW() - ($1::double precision * INTERVAL '1 hour')
       ORDER BY source ASC`,
      [SPEND_STALE_HOURS]
    );
    out.observations.spend_sync_stale_sources = rows.map((r) => r.source);
    for (const r of rows) {
      const hours = r.hours_stale === null || r.hours_stale === undefined
        ? null : Math.round(Number(r.hours_stale) * 10) / 10;
      // eslint-disable-next-line no-await-in-loop
      await raise(
        `spend_sync_stale:${r.source}`, 'warn',
        hours === null
          ? `Spend feed "${r.source}" has never synced successfully.`
          : `Spend feed "${r.source}" has not synced for ${hours}h (threshold ${SPEND_STALE_HOURS}h).`,
        { source: r.source, hours_stale: hours, fail_streak: Number(r.fail_streak || 0), threshold_hours: SPEND_STALE_HOURS }
      );
    }
  }, out);

  // ── 3. needs_review backlog RISING ───────────────────────────────────────
  // A count is not a trend. The first sweep after boot only sets the baseline.
  await guarded('needs_review_rising', async () => {
    const [{ n }] = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM co_sessions WHERE needs_review_reason IS NOT NULL`
    );
    const previous = lastNeedsReview;
    out.observations.needs_review = { count: n, previous };
    lastNeedsReview = n;
    if (previous === null) {
      out.skipped.push({ check: 'needs_review_rising', reason: 'baseline_only' });
      return;
    }
    const delta = n - previous;
    if (delta >= NEEDS_REVIEW_RISE_MIN) {
      await raise(
        'needs_review_rising', 'warn',
        `Checkout sessions needing review rose by ${delta} (${previous} → ${n}) since the last sweep.`,
        { count: n, previous, delta, min_rise: NEEDS_REVIEW_RISE_MIN }
      );
    }
  }, out);

  return out;
}

let sweepStarted = false;

/**
 * Start the 5-minute sweep. Called once from routes/healthAlerts.js on module
 * load (the same "started from the route" posture as domainHub's verifySweep
 * and trackingPublic's tracking sweeps). HEALTH_ALERTS_SWEEP_DISABLED=1 turns
 * it off without a deploy, and the harness sets it so a background timer can
 * never race its assertions.
 */
export function startHealthAlertSweep() {
  if (sweepStarted) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.HEALTH_ALERTS_SWEEP_DISABLED || '').toLowerCase())) {
    console.log('[healthAlerts] sweep disabled via HEALTH_ALERTS_SWEEP_DISABLED');
    return false;
  }
  sweepStarted = true;
  const t = setInterval(() => {
    runHealthAlertSweep().catch((err) => {
      console.error('[healthAlerts] sweep failed (non-fatal):', err.message);
    });
  }, SWEEP_INTERVAL_MS);
  if (t.unref) t.unref(); // never hold the process open
  return true;
}

export default {
  ensureHealthAlertTables, recordAlert, listAlerts, ackAlert,
  runHealthAlertSweep, startHealthAlertSweep, SEVERITIES,
};
