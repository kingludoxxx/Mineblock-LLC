/**
 * Statics Queue Worker — server-owned pipeline for statics generation.
 *
 * Replaces the client-side React queue that vanished on tab close, leaving
 * in-flight generations to run on the server but never persist to
 * spy_creatives. This worker claims rows from `statics_queue`, fans out one
 * /generate HTTP loopback call per reference in the item, and updates the
 * row's progress + result columns as each reference completes.
 *
 * Auth for the internal loopback: the worker mints a short-lived JWT with
 * signAccessToken({ userId: row.user_id }) — reuses the exact same auth
 * machinery /generate already validates, no new middleware, no new env
 * secret. The user must exist and be active in the DB (which they are —
 * they enqueued the row).
 *
 * Mirrors brandSpyWorker.js patterns: module-level state, exported
 * start/shutdown functions, boot recovery for stuck rows, watchdog for
 * hung items, SIGTERM-safe drain.
 */

import { pgQuery } from '../db/pg.js';
import { signAccessToken } from '../utils/jwt.js';
import env from '../config/env.js';

// ---------------------------------------------------------------------------
// Tunables (env-overridable)
// ---------------------------------------------------------------------------

// How often the claim loop runs. 4s matches the client's polling cadence
// so an operator's UI updates within one tick of a status change.
const TICK_MS = parseInt(process.env.STATICS_QUEUE_TICK_MS, 10) || 4000;

// Max items generating concurrently. Matches the previous client-side
// MAX_CONCURRENT_QUEUE_ITEMS = 2 that the operator has been running at
// without complaint. Each item can itself fan out to references.length
// /generate calls, but those are gated upstream by NanoBanana's rate limit.
const CONCURRENCY = parseInt(process.env.STATICS_QUEUE_CONCURRENCY, 10) || 2;

// Watchdog: any item stuck in 'generating' longer than this gets force-errored.
// 20 min > /generate's 8 min WATCHDOG_MS × up to 6 refs at concurrency 2.
const WATCHDOG_MS = 20 * 60 * 1000;

// Boot recovery: rows left 'generating' from a previous deploy get re-queued
// after this many minutes with no activity.
// MUST exceed WATCHDOG_MS — a Render rolling restart can send SIGTERM to the
// old dyno while the new one boots and immediately runs recoverStuckRows.
// If this window is shorter than WATCHDOG_MS, the new dyno re-queues rows the
// old dyno is still legitimately working on (double-generation, wasted spend).
// Any row still 'generating' longer than 25m is dead — the pipeline's own
// 12m poll cap × ~2 refs at concurrency 2 cannot legitimately exceed this.
const STUCK_RECOVERY_MS = 25 * 60 * 1000;

// Per-reference /generate poll cadence + hard cap.
const GENERATE_POLL_MS = 3000;
const GENERATE_MAX_POLL_MS = 12 * 60 * 1000; // 12m — inner watchdog is 8m

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const inFlight = new Set(); // row ids currently being processed
let tickTimer = null;
let watchdogTimer = null;
let shutdownRequested = false;

/** Signal from server.js: SIGTERM received, stop claiming new rows. */
export function requestShutdown() {
  shutdownRequested = true;
  console.log('[statics-queue] shutdown requested — will stop claiming after current tick');
  if (tickTimer) clearInterval(tickTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function internalBaseUrl() {
  const port = env.PORT || process.env.PORT || 3000;
  return `http://127.0.0.1:${port}`;
}

/**
 * Boot recovery — flip rows left 'generating' from a killed worker back to
 * 'queued' so they get retried. Mirrors brandSpyWorker.recoverStuckScrapes.
 */
async function recoverStuckRows() {
  try {
    const rows = await pgQuery(
      `UPDATE statics_queue
          SET status = 'queued', started_at = NULL
        WHERE status = 'generating'
          AND (started_at IS NULL OR started_at < NOW() - ($1::text || ' milliseconds')::INTERVAL)
        RETURNING id`,
      [String(STUCK_RECOVERY_MS)],
    );
    if (rows.length) {
      console.log(`[statics-queue] boot recovery: re-queued ${rows.length} stuck row(s): ${rows.map(r => r.id).join(', ')}`);
    }
  } catch (err) {
    console.error('[statics-queue] boot recovery failed:', err.message);
  }
}

/**
 * Claim up to `n` rows atomically via FOR UPDATE SKIP LOCKED. SKIP LOCKED
 * is essential when multiple Render web dyno replicas run this worker: they
 * would otherwise fight over the same rows. Harmless if single-dyno.
 */
async function claimRows(n) {
  if (n <= 0) return [];
  try {
    const rows = await pgQuery(
      `WITH picked AS (
         SELECT id FROM statics_queue
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE statics_queue q
          SET status = 'generating', started_at = NOW()
         FROM picked
        WHERE q.id = picked.id
       RETURNING q.*`,
      [n],
    );
    return rows;
  } catch (err) {
    console.error('[statics-queue] claim query failed:', err.message);
    return [];
  }
}

// All terminal + progress writes gate on status='generating' so a row the
// operator cancelled (or an earlier watchdog force-errored) can't be revived
// by a straggling worker completion. RETURNING id + empty-check surfaces the
// race in ops logs rather than silently discarding the result.
async function markDone(rowId, result) {
  try {
    const rows = await pgQuery(
      `UPDATE statics_queue
          SET status = 'done', result = $2::jsonb, finished_at = NOW()
        WHERE id = $1 AND status = 'generating'
       RETURNING id`,
      [rowId, JSON.stringify(result)],
    );
    if (!rows.length) {
      console.warn(`[statics-queue] markDone no-op for ${rowId} — row not in 'generating' (cancelled/errored/done already)`);
    }
  } catch (err) {
    console.error(`[statics-queue] markDone failed for ${rowId}:`, err.message);
  }
}

async function markError(rowId, errMessage, partialResult) {
  try {
    const rows = await pgQuery(
      `UPDATE statics_queue
          SET status = 'error', error = $2, result = $3::jsonb, finished_at = NOW()
        WHERE id = $1 AND status = 'generating'
       RETURNING id`,
      [rowId, String(errMessage || 'unknown').slice(0, 2000), partialResult ? JSON.stringify(partialResult) : null],
    );
    if (!rows.length) {
      console.warn(`[statics-queue] markError no-op for ${rowId} — row not in 'generating' (cancelled/errored/done already)`);
    }
  } catch (err) {
    console.error(`[statics-queue] markError failed for ${rowId}:`, err.message);
  }
}

async function bumpRefsDone(rowId) {
  try {
    const rows = await pgQuery(
      `UPDATE statics_queue SET refs_done = refs_done + 1
        WHERE id = $1 AND status = 'generating'
       RETURNING id`,
      [rowId],
    );
    if (!rows.length) {
      console.warn(`[statics-queue] bumpRefsDone no-op for ${rowId} — row not in 'generating' (cancelled/errored/done)`);
    }
  } catch (err) {
    console.error(`[statics-queue] bumpRefsDone failed for ${rowId}:`, err.message);
  }
}

async function appendTaskIds(rowId, ids) {
  if (!ids || !ids.length) return;
  try {
    await pgQuery(
      `UPDATE statics_queue
          SET task_ids = COALESCE(task_ids, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [rowId, JSON.stringify(ids)],
    );
  } catch (err) {
    console.error(`[statics-queue] appendTaskIds failed for ${rowId}:`, err.message);
  }
}

/**
 * POST /generate for one reference, poll each child task to completion,
 * return the parent + child creative ids the auto-save block persisted.
 *
 * The auto-save patch in /generate (Phase 2) is what actually writes to
 * spy_creatives — the worker just triggers /generate and waits.
 */
async function runOneReference({ row, reference, freshToken }) {
  const base = internalBaseUrl();

  // Build the /generate body from the queue row's payload + this reference.
  const body = {
    reference_image_url: reference?.image_url || reference?.thumbnail || null,
    product: row.product_payload || { id: row.product_id, name: row.product_name },
    product_id: row.product_id,
    product_image_index: row.product_image_index,
    angle: row.angle,
    angle_data: row.angle_data,
    custom_angle: row.custom_angle,
    image_engine: row.image_engine || 'nanobanana',
    ratio: 'all',
    // Enqueue-time signal: worker path. Auto-save reads this via req.body
    // to stamp source_label; harmless if ignored.
    source_label: 'queue',
    // Reference metadata passed through for auto-save's reference_thumbnail.
    reference_name: reference?.name || null,
    reference_thumbnail: reference?.thumbnail || null,
  };

  const submitRes = await fetch(`${base}/api/v1/statics-generation/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Re-mint before each fetch — an item can run 20+ min and a 15-min
      // JWT would 401 mid-poll. See F1 in the queue forever-fix brief.
      Authorization: `Bearer ${freshToken()}`,
    },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const txt = await submitRes.text().catch(() => '');
    throw new Error(`/generate returned ${submitRes.status}: ${txt.slice(0, 300)}`);
  }
  const submitJson = await submitRes.json();
  const data = submitJson?.data || {};
  const parentTaskId = data.taskId;
  const childTasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!parentTaskId) throw new Error('/generate response missing taskId');

  await appendTaskIds(row.id, [parentTaskId, ...childTasks.map(t => t.taskId).filter(Boolean)]);

  // Poll each child task until completed or errored. The parent task also
  // reports 'completed' once all children finish, but we watch the children
  // directly to detect per-ratio failures early.
  const started = Date.now();
  const childResults = new Map(); // taskId → { status, resultImageUrl }
  const pending = new Set(childTasks.map(t => t.taskId));

  while (pending.size > 0) {
    if (shutdownRequested) throw new Error('Shutdown requested mid-generation');
    if (Date.now() - started > GENERATE_MAX_POLL_MS) {
      throw new Error(`Generation exceeded ${GENERATE_MAX_POLL_MS / 60000}m poll cap`);
    }
    await new Promise(r => setTimeout(r, GENERATE_POLL_MS));

    for (const taskId of Array.from(pending)) {
      try {
        const r = await fetch(`${base}/api/v1/statics-generation/status/${taskId}`, {
          headers: { Authorization: `Bearer ${freshToken()}` },
        });
        if (!r.ok) continue;
        const j = await r.json();
        const d = j?.data || {};
        if (d.status === 'processing') continue;
        childResults.set(taskId, d);
        pending.delete(taskId);
      } catch (err) {
        console.warn(`[statics-queue] poll ${taskId} failed (retrying):`, err.message);
      }
    }
  }

  // Auto-save has already persisted the spy_creatives rows (Phase 2). We
  // look them up by generation_task_id so the queue result can point at
  // them. The client can then navigate directly to the finished creatives.
  const parentTaskIds = [];
  const allTaskIds = [];
  for (const [taskId, d] of childResults.entries()) {
    allTaskIds.push(taskId);
    if (d.status === 'completed' && d.resultImageUrl) {
      parentTaskIds.push(taskId);
    }
  }

  let parentCreativeId = null;
  let childCreativeIds = [];
  if (parentTaskIds.length > 0) {
    try {
      // The parent is the row with parent_creative_id IS NULL; children link back.
      const creatives = await pgQuery(
        `SELECT id, parent_creative_id, generation_task_id
           FROM spy_creatives
          WHERE generation_task_id = ANY($1::text[])`,
        [allTaskIds],
      );
      const parent = creatives.find(c => c.parent_creative_id == null);
      if (parent) {
        parentCreativeId = parent.id;
        childCreativeIds = creatives.filter(c => c.parent_creative_id === parent.id).map(c => c.id);
      }
    } catch (err) {
      console.warn('[statics-queue] result-id lookup failed:', err.message);
    }
  }

  const anyErrored = Array.from(childResults.values()).some(d => d.status === 'failed' || d.status === 'error');
  return {
    parent_creative_id: parentCreativeId,
    child_creative_ids: childCreativeIds,
    task_ids: allTaskIds,
    error: anyErrored
      ? Array.from(childResults.values()).find(d => d.error)?.error || 'One or more ratios failed'
      : null,
  };
}

/**
 * Full per-row runner. Iterates references[], calls /generate for each,
 * bumps refs_done as each completes, writes final status.
 */
async function runQueueItem(row) {
  const refs = Array.isArray(row.references) ? row.references : [];
  if (!row.user_id) {
    console.error(`[statics-queue] row ${row.id} missing user_id — cannot mint JWT`);
    await markError(row.id, 'queue row missing user_id — cannot mint JWT');
    return;
  }
  // Fresh 30-min JWT per fetch. A queue item can run 20+ min across many refs
  // and the default 15-min access token expires mid-flight → 401 storm. See F1.
  const freshToken = () => signAccessToken({ userId: row.user_id }, '30m');
  try {
    // Sanity-mint once to fail fast if signing itself is broken.
    freshToken();
  } catch (err) {
    console.error(`[statics-queue] JWT mint failed for row ${row.id}:`, err.message);
    await markError(row.id, `JWT mint failed: ${err.message}`);
    return;
  }

  const perRef = [];
  let hadFatal = false;
  for (let i = 0; i < refs.length; i++) {
    const reference = refs[i];
    try {
      const outcome = await runOneReference({ row, reference, freshToken });
      perRef.push(outcome);
    } catch (err) {
      console.error(`[statics-queue] row ${row.id} ref ${i} failed:`, err.message);
      perRef.push({ parent_creative_id: null, child_creative_ids: [], task_ids: [], error: err.message });
      // Fatal only if it's a shutdown — otherwise per-ref failures are
      // tolerated and refs_done still bumps so refs_done=refs_total remains
      // reachable.
      if (/Shutdown requested/i.test(err.message)) hadFatal = true;
    }
    await bumpRefsDone(row.id);
    if (hadFatal) break;
  }

  const result = { creatives: perRef };
  if (hadFatal) {
    await markError(row.id, 'Worker shutdown mid-item', result);
  } else {
    await markDone(row.id, result);
  }
}

// ---------------------------------------------------------------------------
// Tick loop — claim + fire runQueueItem in the background.
// ---------------------------------------------------------------------------

async function tick() {
  if (shutdownRequested) return;
  const capacity = CONCURRENCY - inFlight.size;
  if (capacity <= 0) return;

  let claimed = [];
  try {
    claimed = await claimRows(capacity);
  } catch (err) {
    console.error('[statics-queue] tick claim failed:', err.message);
    return;
  }

  for (const row of claimed) {
    inFlight.add(row.id);
    // Fire and forget — do NOT await inside the tick loop. One long
    // generation would freeze the polling cadence otherwise.
    runQueueItem(row)
      .catch((err) => {
        console.error(`[statics-queue] runQueueItem crashed for ${row.id}:`, err.message);
        return markError(row.id, err?.message || 'unknown crash');
      })
      .finally(() => {
        inFlight.delete(row.id);
      });
  }
}

async function watchdog() {
  try {
    const rows = await pgQuery(
      `UPDATE statics_queue
          SET status = 'error',
              error = 'Worker watchdog: exceeded ' || $1 || ' min',
              finished_at = NOW()
        WHERE status = 'generating'
          AND started_at < NOW() - ($2::text || ' milliseconds')::INTERVAL
       RETURNING id`,
      [String(WATCHDOG_MS / 60000), String(WATCHDOG_MS)],
    );
    if (rows.length) {
      console.warn(`[statics-queue] watchdog fired: force-errored ${rows.length} row(s): ${rows.map(r => r.id).join(', ')}`);
    }
  } catch (err) {
    console.error('[statics-queue] watchdog query failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public start/stop
// ---------------------------------------------------------------------------

export async function startStaticsQueueWorker() {
  if (tickTimer) {
    console.warn('[statics-queue] worker already started');
    return;
  }
  shutdownRequested = false;
  await recoverStuckRows();
  tickTimer = setInterval(() => {
    tick().catch((err) => console.error('[statics-queue] tick crash:', err.message));
  }, TICK_MS);
  watchdogTimer = setInterval(() => {
    watchdog().catch((err) => console.error('[statics-queue] watchdog crash:', err.message));
  }, 60_000);
  console.log(`[statics-queue] worker started (tick=${TICK_MS}ms, concurrency=${CONCURRENCY})`);
}
