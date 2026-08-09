// HEALTH ALERTS — a durable, acknowledgeable record of operational faults.
//
// Ported in CAPABILITY from funnel-os's system-alert surface. The shape of the
// idea is the same (a row per fault, a severity, an acknowledgement), but the
// decisions below are deliberately different because each one is a defect this
// port is not obliged to inherit:
//
//   1. DEDUP / COOLDOWN, SCOPED. A monitor that runs on a timer and writes a
//      row every time a condition is still true does not produce an alert list
//      — it produces a log nobody reads. A stale spend feed left over a weekend
//      at a 5-minute sweep is 576 identical rows. Every write goes through a
//      cooldown, and `recordAlert` REPORTS the suppression
//      (`{ created: false, suppressed_by }`) rather than lying about having
//      written one.
//      ⚠️ THE COOLDOWN KEY IS (kind, scope_id), NOT kind alone. Keying on kind
//      alone silently swallowed the second, third and fourth funnel's breaker
//      opening inside one window — the operator saw ONE alert naming ONE funnel
//      and had no way to learn the others existed. `scope_id` is a first-class
//      parameter for exactly this reason (see THE CALL-SITE CONTRACT below).
//   2. THE COOLDOWN CHECK IS ATOMIC. A read-then-insert is not a cooldown under
//      concurrency: at READ COMMITTED two sessions both see "no recent row" and
//      both insert. Four workers reacting to one outage produced four rows.
//      ⚠️ AND NEITHER IS A SINGLE `INSERT … WHERE NOT EXISTS`, EVEN HOLDING AN
//      ADVISORY LOCK — also measured at four rows, because a statement's
//      snapshot is taken before it blocks on the lock, so the waiter cannot see
//      the row it waited for. The check and the write are a SEPARATE STATEMENT
//      from the lock, inside one transaction, so the read gets a fresh
//      snapshot. See the long note in recordAlert.
//   3. CAPS. `message` and `context` arrive from call sites that are, by
//      definition, already having a bad day — a 4MB error body pasted into an
//      alert context is exactly the sort of thing a failure path does. Both are
//      bounded here, and an over-cap context is REPLACED with a marker that
//      says so rather than silently truncated into invalid JSON.
//   4. THE SWEEP CANNOT TAKE THE PROCESS DOWN. Every check is independently
//      guarded and a missing table (42P01 — a deployment where that lane has
//      never run) is a SKIPPED check with a reason, not an exception.
//   5. NO ABSOLUTE COUNT IS REPORTED AS A TREND, AND NO TREND HIDES A
//      STANDING BACKLOG. "needs_review rising" is a claim about TWO
//      observations, so the baseline is PERSISTED (lb_health_alert_state) and
//      survives a restart — an earlier version kept it in a module variable,
//      which meant a deploy at the wrong moment silently re-baselined a growing
//      backlog and the rise was never reported at all. Separately, a backlog
//      that is already large but no longer GROWING is still a backlog, so an
//      absolute FLOOR alerts regardless of delta.
//   6. EVALUATION AND ANCHORING ARE SEPARATE. Re-running the checks must not
//      consume the baseline: a human clicking Refresh three times would
//      otherwise re-anchor between clicks and erase the very rise the panel
//      exists to show. `runHealthAlertSweep({ anchor })` splits them — the
//      TIMER anchors, an operator-triggered run does not (see routes).
//   7. THE SWEEP IS ON AN IN-PROCESS TIMER. funnel-os's equivalent
//      (lb_alerts_service.run_all) has NO schedule at all — its only caller is
//      an HTTP cron endpoint bolted onto the PayPal router, so on a deployment
//      where that external cron was never configured, alerting silently never
//      ran. The timer here starts from the route module on load and is turned
//      off by env, not by omission.
//   8. ACK IS IDEMPOTENT. funnel-os's ack matches `status: "open"` only and
//      404s on a second ack, conflating "already acknowledged" with "does not
//      exist". Here a repeat ack answers 200 and preserves the ORIGINAL acker.
//   9. SEVERITY IS AN ENUM. funnel-os's is a free string set at three call
//      sites with no validation, so a typo makes an alert unfilterable.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CALL-SITE CONTRACT
//
//   import { recordAlert } from '../services/healthAlerts.js';
//   await recordAlert(
//     'tracking_breaker_open',                  // kind: stable machine key
//     'critical',                               // severity: info|warn|critical
//     `Postback breaker opened for ${scopeId}`, // operator-language sentence
//     { fails, open_until },                    // structured context
//     { scopeId }                               // ⚠️ THE THING IT IS ABOUT
//   );
//
// `scopeId` NAMES THE SUBJECT — the funnel id, the pixel scope, the feed name.
// Two different subjects failing inside one cooldown window are TWO alerts.
// Omit it only when the condition is genuinely global (one queue, one process).
//
// ⛔ NO PII IN `message` OR `context`. These rows are read by every operator
// who holds health-alerts:read and are not redacted on the way out. Carry IDs,
// counts, durations, status codes and error CLASSES. Never a customer email,
// name, address, phone, card fragment, IP, or a raw request/response body that
// might contain one — and never a credential or token, whatever its shape.
// If you need the detail to debug, log it and put the LOG's identifier here.
//
// `recordAlert` THROWS on a programmer error (unknown severity, missing kind).
// A call site on a failure path should still wrap it, because an alert that
// fails to write must never break the thing it was watching:
//   try { await recordAlert(...); } catch (e) { console.error(...); }
//
// DORMANT CALL SITES — wired by the integrator, NOT by this lane (each lives in
// a file this lane's fence does not admit):
//   • services/trackingDelivery.js — when a postback breaker OPENS
//     ('tracking_breaker_open', 'critical', { scopeId: scope_id })
//   • services/funnelSpend.js      — when a source's fail_streak reaches 3
//     ('spend_sync_failing', 'warn', { scopeId: source })
//   • services/mediaService.js     — on a 503 from media storage
//     ('media_storage_unavailable', 'warn', { scopeId: bucket })
//   • services/trackingSweeps.js   — when the drain moves rows to 'dead'
//     ('postback_dead_letters', 'warn', { scopeId: scope_id })
// Until those land, the 5-minute sweep below is the LIVE producer: it needs no
// call site because it reads state the app already keeps.
//
// ⚠️ DEFERRED, STATED PLAINLY: there is NO retention/purge on lb_health_alerts.
// funnel-os has none either and its table grows forever. The cooldown bounds
// the rate hard (one row per kind+scope per hour), so this is a slow leak
// rather than an open tap, but a retention sweep is real remaining work and is
// NOT pretended to exist here.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'crypto';
import { pgQuery, client as pgClient } from '../db/pg.js';

const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`; // matches funnels.js

export const SEVERITIES = ['info', 'warn', 'critical'];
const SEVERITY_SET = new Set(SEVERITIES);

// ── Caps ───────────────────────────────────────────────────────────────────
export const MAX_KIND_LEN = 120;
export const MAX_SCOPE_LEN = 200;
export const MAX_MESSAGE_LEN = 2000;
export const MAX_CONTEXT_BYTES = 16 * 1024; // 16KB
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;
// An offset past this is a client bug or a probe, not a page an operator wants.
// Uncapped it is a free full-table scan per request.
export const MAX_PAGE_OFFSET = 100_000;

// One alert per (kind, scope) per hour, unless a call site asks for tighter.
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

// ── Sweep thresholds (the LIVE producer) ───────────────────────────────────
export const POSTBACK_QUEUE_DEPTH_THRESHOLD = 100;
export const SPEND_STALE_HOURS = 12;
// A rise smaller than this is noise — needs_review moves by one all day long.
export const NEEDS_REVIEW_RISE_MIN = 5;
// …but a backlog that has STOPPED growing is still a backlog. Env-tunable so a
// deployment with a different order volume can move it without a code change.
export const NEEDS_REVIEW_FLOOR = (() => {
  const raw = Number(process.env.HEALTH_ALERTS_NEEDS_REVIEW_FLOOR);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 50;
})();
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const UNDEFINED_TABLE = '42P01';
const STATE_NEEDS_REVIEW = 'needs_review';

let ensured = false;

/**
 * Create this lane's tables on demand. Same posture as funnels.js ensureTables
 * / trackingSchema.js — no migration file is touched for TABLES (migrations are
 * a shared, coordinated surface). The one migration this lane does ship
 * (091_add_health_alerts_permission.sql) grants a ROLE PERMISSION, which is
 * data the app cannot invent for itself.
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
  // asks "most recent row of this kind AND scope". Both are covered here.
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_health_alerts_feed ON lb_health_alerts (created_at DESC)`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_health_alerts_kind_scope
     ON lb_health_alerts (kind, (context->>'scope_id'), created_at DESC)`
  );
  // ── THE BASELINE STORE (M2) ──────────────────────────────────────────────
  // One row per stateful check. A module variable could not survive the deploy
  // that happens in the middle of a growing backlog — which is precisely when
  // the rise most needs reporting.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_health_alert_state (
      kind TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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
 * Record one alert, subject to a per-(kind, scope) cooldown.
 *
 * @param {string} kind      stable machine key, e.g. 'tracking_breaker_open'
 * @param {'info'|'warn'|'critical'} severity
 * @param {string} message   operator-language sentence (⛔ no PII — see header)
 * @param {object} [context] structured detail (bounded; ⛔ no PII)
 * @param {{scopeId?: string, cooldownMs?: number}} [opts]
 *   scopeId — WHAT the alert is about (funnel id, feed name, pixel scope).
 *             Two subjects failing in one window are two alerts.
 * @returns {Promise<{created: true, alert: object} | {created: false, reason: 'cooldown', suppressed_by: string|null, cooldown_ms: number}>}
 * @throws {TypeError} on an unknown severity or an empty kind — a call-site bug
 */
export async function recordAlert(kind, severity, message, context, { scopeId, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const k = String(kind ?? '').trim().slice(0, MAX_KIND_LEN);
  if (!k) throw new TypeError('recordAlert: kind is required');
  if (!SEVERITY_SET.has(severity)) {
    throw new TypeError(`recordAlert: severity must be one of ${SEVERITIES.join(', ')} (got ${JSON.stringify(severity)})`);
  }
  const msg = String(message ?? '').slice(0, MAX_MESSAGE_LEN);
  const scope = scopeId === undefined || scopeId === null ? '' : String(scopeId).slice(0, MAX_SCOPE_LEN);

  let ctx = boundedContext(context);
  // scope_id is stored INSIDE context (that is what the cooldown predicate and
  // the partial index read) so there is exactly one place it can live, and a
  // reader of a row can always see what the alert was about. The parameter
  // WINS over any scope_id a caller also put in the context blob.
  if (scope) ctx = { ...ctx, scope_id: scope };

  await ensureHealthAlertTables();

  const cool = Number.isFinite(Number(cooldownMs)) && Number(cooldownMs) >= 0
    ? Number(cooldownMs)
    : DEFAULT_COOLDOWN_MS;

  // ── THE COOLDOWN: LOCK IN ONE STATEMENT, CHECK AND WRITE IN THE NEXT ────
  //
  // ⚠️ A SINGLE `INSERT … SELECT … WHERE NOT EXISTS` CANNOT DO THIS, WITH OR
  // WITHOUT AN ADVISORY LOCK. Both were measured with four parallel processes
  // contending for one (kind, scope):
  //
  //   • Bare `WHERE NOT EXISTS`         → 4 rows. Under READ COMMITTED each
  //     session evaluates the predicate against a snapshot taken before any of
  //     the inserts, so all four find nothing.
  //   • `WITH gate AS (SELECT pg_advisory_xact_lock(…)) INSERT … WHERE NOT
  //     EXISTS`                         → STILL 4 rows. The lock serialises the
  //     sessions correctly, but a statement's snapshot is taken when the
  //     STATEMENT STARTS — before it blocks on the lock. The waiter acquires
  //     the lock and then evaluates NOT EXISTS against its own stale snapshot,
  //     which predates the winner's commit. It cannot see the row it is
  //     waiting for. The lock was doing its job; the snapshot was the problem.
  //
  // The fix is to put a STATEMENT BOUNDARY between acquiring the lock and
  // reading: in READ COMMITTED every statement takes a FRESH snapshot at its
  // own start, so the SELECT below — issued after the lock is held — sees
  // everything committed by whoever held it first. The lock is transaction-
  // scoped, so `begin` is what keeps it held across those statements and
  // releasing it needs no unlock path that could leak.
  //
  // The cooldown IGNORES ACK STATE. An acked alert still proves an operator was
  // told within the window; re-raising immediately after an ack would make
  // acknowledging the loudest way to get more noise.
  const outcome = await pgClient.begin(async (tx) => {
    const q = (text, params = []) => tx.unsafe(text, params);
    // Statement 1: take the lock. Two int4 keys, so (kind, scope) needs no
    // key-packing in JS and cannot collide across kinds by arithmetic accident.
    await q(`SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`, [k, scope]);

    // Statement 2: FRESH SNAPSHOT. This is the line the single-statement
    // versions could not express.
    if (cool > 0) {
      const recent = await q(
        `SELECT id FROM lb_health_alerts
         WHERE kind = $1 AND COALESCE(context->>'scope_id', '') = $2
           AND created_at > NOW() - ($3::double precision * INTERVAL '1 millisecond')
         ORDER BY created_at DESC LIMIT 1`,
        [k, scope, cool]
      );
      if (recent.length) return { suppressed_by: recent[0].id };
    }

    const rows = await q(
      `INSERT INTO lb_health_alerts (id, kind, severity, message, context)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, severity, message, context, created_at, acked_at, acked_by`,
      // ⚠️ RAW OBJECT, NOT JSON.stringify. postgres.js serialises a JS object
      // into JSONB itself. Stringifying sends TEXT which postgres.js encodes
      // AGAIN — the row then holds the jsonb STRING SCALAR "{\"a\":1}" instead
      // of an object, `context->>'scope_id'` is NULL for every row, and the
      // predicate above silently matches NOTHING. Measured: every alert wrote a
      // new row and the scoped-cooldown tests all failed at once. Same trap
      // funnelTransfer.js:669 documents.
      [genId('hal'), k, severity, msg, ctx]
    );
    return { alert: rows[0] };
  });

  if (outcome.alert) return { created: true, alert: outcome.alert };
  return { created: false, reason: 'cooldown', suppressed_by: outcome.suppressed_by ?? null, cooldown_ms: cool };
}

// Paging params arrive from a query string (always strings or undefined) AND
// from direct callers (which pass real values, including null). `Number(null)`
// is 0, so a naive parse turned `limit: null` into a clamped 1 — a caller
// asking for "the default" got a single row.
function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/**
 * Page the alert feed. UNACKED FIRST, then newest first — an operator opening
 * this surface is looking for what still needs them, not for history.
 */
export async function listAlerts({ limit, offset, severity, acked } = {}) {
  await ensureHealthAlertTables();

  const lim = Math.min(Math.max(intOr(limit, DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
  const off = Math.min(Math.max(intOr(offset, 0), 0), MAX_PAGE_OFFSET);

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

  // An acknowledgement with no acknowledger is a dismissal wearing its name.
  // The route is authenticated so this should be unreachable — which is exactly
  // why it must not be assumed: a future unauthenticated mount would otherwise
  // start writing anonymous acks and nothing would say so.
  const actor = String(userId ?? '').slice(0, 120);
  if (!actor) return { ok: false, status: 401, error: 'acking_user_required' };

  const [updated] = await pgQuery(
    `UPDATE lb_health_alerts SET acked_at = NOW(), acked_by = $2
     WHERE id = $1 AND acked_at IS NULL
     RETURNING id, kind, severity, message, context, created_at, acked_at, acked_by`,
    [alertId, actor]
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

// ── PERSISTED CHECK STATE ──────────────────────────────────────────────────

async function readState(kind) {
  const [row] = await pgQuery(`SELECT state FROM lb_health_alert_state WHERE kind = $1`, [kind]);
  return row?.state ?? null;
}

async function writeState(kind, state) {
  await pgQuery(
    `INSERT INTO lb_health_alert_state (kind, state, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (kind) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    // Raw object — same JSONB rule as recordAlert. A stringified state read
    // back as a jsonb string scalar made `state.count` undefined, which the
    // baseline check read as "no baseline" and re-anchored on every sweep.
    [kind, state]
  );
}

// Test seam only — production has no reason to forget a baseline.
export async function _resetSweepState() {
  await ensureHealthAlertTables();
  await pgQuery(`DELETE FROM lb_health_alert_state`);
}

// ── THE SWEEP ──────────────────────────────────────────────────────────────

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
 * Run every rule once.
 *
 * @param {{anchor?: boolean}} [opts]
 *   anchor — whether this run may MOVE the persisted baselines. TRUE for the
 *   timer (the series is its own). FALSE for an operator-triggered run: a
 *   person clicking Refresh must not consume the comparison point that the
 *   next timer tick needs. Alerts are still evaluated and still written either
 *   way — "dry" here means "does not re-anchor", NOT "does not alert".
 */
export async function runHealthAlertSweep({ anchor = true } = {}) {
  const out = { alerts: [], observations: {}, skipped: [], errors: [], anchored: anchor };
  await ensureHealthAlertTables();

  const raise = async (kind, severity, message, context, opts) => {
    const r = await recordAlert(kind, severity, message, context, opts);
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
      // Genuinely global — there is one queue — so no scopeId.
      await raise(
        'postback_queue_depth', 'warn',
        `Postback queue backlog is ${n} (threshold ${POSTBACK_QUEUE_DEPTH_THRESHOLD}) — deliveries are not draining.`,
        { depth: n, threshold: POSTBACK_QUEUE_DEPTH_THRESHOLD }
      );
    }
  }, out);

  // ── 2. Spend sync staleness ──────────────────────────────────────────────
  // PER SOURCE, because "spend is stale" without naming the feed is not
  // actionable. The SOURCE is already in the kind, so each feed has its own
  // cooldown series without needing a scope. A source that has NEVER synced
  // counts as stale — a feed configured and never delivering is the failure.
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
        { source: r.source, hours_stale: hours, fail_streak: Number(r.fail_streak || 0), threshold_hours: SPEND_STALE_HOURS },
        { scopeId: r.source }
      );
    }
  }, out);

  // ── 3. needs_review — RISING, and the standing FLOOR ─────────────────────
  await guarded('needs_review', async () => {
    const [{ n }] = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM co_sessions WHERE needs_review_reason IS NOT NULL`
    );
    const prior = await readState(STATE_NEEDS_REVIEW);
    const previous = Number.isFinite(Number(prior?.count)) ? Number(prior.count) : null;
    out.observations.needs_review = { count: n, previous, floor: NEEDS_REVIEW_FLOOR };

    // ANCHORING IS SEPARATE FROM EVALUATING (decision 6). Only a run that owns
    // the series moves the comparison point.
    if (anchor) await writeState(STATE_NEEDS_REVIEW, { count: n, at: new Date().toISOString() });

    // (a) THE FLOOR — independent of any baseline, so it fires on the very
    // first sweep after a restart if the backlog is already large. A backlog
    // that stopped growing is still a backlog.
    if (n > NEEDS_REVIEW_FLOOR) {
      await raise(
        'needs_review_backlog', 'warn',
        `${n} checkout sessions are waiting for review (floor ${NEEDS_REVIEW_FLOOR}).`,
        { count: n, floor: NEEDS_REVIEW_FLOOR }
      );
    }

    // (b) THE RISE — needs two observations. Without a baseline this run only
    // establishes one, and says so.
    if (previous === null) {
      out.skipped.push({ check: 'needs_review_rising', reason: 'baseline_only' });
      return;
    }
    const delta = n - previous;
    if (delta >= NEEDS_REVIEW_RISE_MIN) {
      await raise(
        'needs_review_rising', 'warn',
        `Checkout sessions needing review rose by ${delta} (${previous} → ${n}) since the last anchored sweep.`,
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
 *
 * THE TIMER IS THE ANCHORING PATH — it owns the observation series.
 */
export function startHealthAlertSweep() {
  if (sweepStarted) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.HEALTH_ALERTS_SWEEP_DISABLED || '').toLowerCase())) {
    console.log('[healthAlerts] sweep disabled via HEALTH_ALERTS_SWEEP_DISABLED');
    return false;
  }
  sweepStarted = true;
  const t = setInterval(() => {
    runHealthAlertSweep({ anchor: true }).catch((err) => {
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
