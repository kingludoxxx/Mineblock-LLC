// Live View — SSE hub (SELF-CONTAINED, NEW FILE).
//
// Port of funnel-os's live_view_service.py hub onto Express/Postgres, minus
// what our stack can't honestly do (Mongo change streams → we POLL; that is
// the reference's own fallback mode, promoted to the only mode — no
// LISTEN/NOTIFY, no schema changes).
//
// One module-level hub owns every connected SSE response and ONE poll loop,
// started lazily on the first subscriber and stopped when the last leaves
// (same lifecycle as the reference). Each tick:
//   1. builds ONE snapshot (buildLiveSnapshot) and writes the SAME serialized
//      frame to every client — one JSON.stringify per tick, not per client
//      (the reference router's frame-cache idea, done at the source);
//   2. draws the id-watermarked delta (readNewEvents) and, if any, fans out
//      one "events" frame.
//
// Resilience contract (mirrors the reference):
//   • A failed tick NEVER kills the feed — it logs, and a ": keepalive"
//     comment goes out if nothing has been written for HEARTBEAT_MS, so
//     proxies don't idle the sockets out while the DB recovers.
//   • Watermarks are seeded BEFORE the first emit; seeding failure defers to
//     the next tick (never emit with no watermark — that would replay
//     history as live pushes).
//   • A client whose socket write fails is dropped immediately.
//
// Wire contract (client/src/pages/live/useLiveFeed.js):
//   event: snapshot  data: <buildLiveSnapshot payload>     (~every POLL_MS)
//   event: events    data: {events: [...oldest-first...]}  (only when new)
//   : keepalive                                            (idle comment)
import { buildLiveSnapshot, readNewEvents } from './liveViewQueries.js';

// Tunables — env-overridable so the verification harness can tighten the poll
// without patching module internals. Read at module load, like the pool caps
// in analyticsDb.js.
const POLL_MS = clampInt(process.env.LIVE_VIEW_POLL_MS, 3_000, 250, 60_000);
const HEARTBEAT_MS = clampInt(process.env.LIVE_VIEW_HEARTBEAT_MS, 15_000, 1_000, 120_000);
const MAX_CLIENTS = clampInt(process.env.LIVE_VIEW_MAX_CLIENTS, 20, 1, 200);
const SNAPSHOT_EVENT_LIMIT = 50;

function clampInt(raw, dflt, lo, hi) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

// ── module-level hub state ──────────────────────────────────────────────────
const clients = new Set(); // Set<{ id, res, alive }>
let pollTimer = null;
let polling = false; // reentrancy guard: a slow tick must not stack
let watermarks = null; // { touchId, coEventId } | null (null ⇒ not yet seeded)
let lastWriteTs = 0;
let nextClientId = 1;

export const LIVE_VIEW_LIMITS = Object.freeze({
  pollMs: POLL_MS,
  heartbeatMs: HEARTBEAT_MS,
  maxClients: MAX_CLIENTS,
});

/** Internal gauges for the verification harness. */
export function _liveStats() {
  return {
    clients: clients.size,
    pollerActive: pollTimer !== null,
    watermarksSeeded: watermarks !== null,
  };
}

function writeFrame(client, frame) {
  if (!client.alive) return;
  try {
    client.res.write(frame);
  } catch (err) {
    // A dead socket mid-write: drop the client; the 'close' handler may or
    // may not still fire, so drop defensively here too.
    console.error('[live-view] SSE write failed, dropping client:', err.message);
    dropClient(client);
  }
}

function fanOut(event, data) {
  if (clients.size === 0) return;
  // ONE serialization per tick, shared across every client.
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of [...clients]) writeFrame(c, frame);
  lastWriteTs = Date.now();
}

function fanOutKeepalive() {
  for (const c of [...clients]) writeFrame(c, ': keepalive\n\n');
  lastWriteTs = Date.now();
}

async function tick() {
  if (polling) return; // previous tick still on the DB — skip, never stack
  polling = true;
  let wrote = false;
  try {
    // Seed watermarks BEFORE the first emit. If seeding failed at subscribe
    // time (DB blip), retry here; until it succeeds we emit snapshots only
    // (counts are idempotent; deltas without a watermark would replay history).
    if (watermarks === null) {
      const { readWatermarks } = await import('./liveViewQueries.js');
      watermarks = await readWatermarks();
    }

    const snap = await buildLiveSnapshot({ limit: SNAPSHOT_EVENT_LIMIT });
    if (clients.size > 0) {
      fanOut('snapshot', snap);
      wrote = true;
    }

    const delta = await readNewEvents({
      touchId: watermarks.touchId,
      coEventId: watermarks.coEventId,
    });
    watermarks = { touchId: delta.touchId, coEventId: delta.coEventId };
    if (delta.events.length > 0 && clients.size > 0) {
      fanOut('events', { events: delta.events });
      wrote = true;
    }
  } catch (err) {
    // One failing tick must never kill the feed. Log loudly, keep the loop.
    console.error('[live-view] poll tick failed:', err.message);
  } finally {
    polling = false;
  }
  if (!wrote && clients.size > 0 && Date.now() - lastWriteTs > HEARTBEAT_MS) {
    fanOutKeepalive();
  }
}

function startPoller() {
  if (pollTimer !== null) return;
  lastWriteTs = Date.now();
  pollTimer = setInterval(tick, POLL_MS);
  // The hub must never hold the process open on its own (harness exit,
  // graceful shutdown): the poller only matters while sockets are connected.
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  // Immediate first tick so a fresh subscriber sees data in ~one query's
  // time, not after a full POLL_MS.
  tick();
}

function stopPoller() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Reset the watermark so a later first-subscriber re-seeds at "now" —
  // events that happened while nobody watched are history, not live pushes.
  watermarks = null;
}

function dropClient(client) {
  client.alive = false;
  clients.delete(client);
  if (clients.size === 0) stopPoller();
}

/**
 * Attach one SSE consumer to an Express response the ROUTE has already
 * authenticated. Returns false when the hub is at capacity (the route answers
 * 503); on success takes ownership of the response lifecycle: headers, the
 * seed comment, close-cleanup, poller start/stop.
 */
export function subscribe(req, res) {
  if (clients.size >= MAX_CLIENTS) return false;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = { id: nextClientId++, res, alive: true };
  clients.add(client);

  // An immediate comment so the client's fetch resolves its first read and
  // can flip the UI to "live" before the first tick lands.
  writeFrame(client, ': connected\n\n');

  // Cleanup on EVERY way a socket dies: close covers client aborts and
  // network drops; 'error' covers mid-write resets.
  const cleanup = () => dropClient(client);
  req.on('close', cleanup);
  res.on('error', cleanup);

  startPoller();
  return true;
}
