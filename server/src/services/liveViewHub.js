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
//   1. drops expired-auth clients (review M4) and backpressured clients
//      (review H2) BEFORE doing any DB work for them;
//   2. builds ONE snapshot (buildLiveSnapshot) and writes the SAME serialized
//      frame to every client — one JSON.stringify per tick, not per client
//      (the reference router's frame-cache idea, done at the source);
//   3. draws the id-watermarked delta (readNewEvents, K-id overlap per review
//      M2), filters already-emitted ids, and fans out one "events" frame.
//
// Resilience contract (mirrors the reference):
//   • A failed tick NEVER kills the feed — it logs, and a ": keepalive"
//     comment goes out if nothing has been written for HEARTBEAT_MS, so
//     proxies don't idle the sockets out while the DB recovers.
//   • Watermarks are seeded BEFORE the first emit; seeding failure defers to
//     the next tick (never emit with no watermark — that would replay
//     history as live pushes).
//   • BACKPRESSURE (review H2): res.write()'s return value is tracked per
//     client; a client still un-drained at the next fan-out — or whose
//     kernel-buffer backlog exceeds BACKPRESSURE_MAX_BYTES — is dropped with
//     a named reason instead of buffering frames in user space forever.
//   • MID-TICK STOP (review M1): every await in tick() re-checks the poller
//     generation before touching shared state — a last-client disconnect
//     mid-tick can never resurrect a stale watermark for the next subscriber.
//   • AUTH EXPIRY (review M4): each client records its JWT exp at subscribe;
//     once past it the hub sends a final `auth_expired` event and ends the
//     response, so the client reconnects through the normal (re-)auth path.
//
// Wire contract (client/src/pages/live/useLiveFeed.js):
//   event: snapshot     data: <buildLiveSnapshot payload>   (~every POLL_MS)
//   event: events       data: {events:[...oldest-first...]} (only when new)
//   event: auth_expired data: {"type":"auth_expired"}       (final frame)
//   : keepalive                                             (idle comment)
import { buildLiveSnapshot, readNewEvents, readWatermarks } from './liveViewQueries.js';

// Tunables — env-overridable so the verification harness can tighten the poll
// without patching module internals. Read at module load, like the pool caps
// in analyticsDb.js.
const POLL_MS = clampInt(process.env.LIVE_VIEW_POLL_MS, 3_000, 250, 60_000);
const HEARTBEAT_MS = clampInt(process.env.LIVE_VIEW_HEARTBEAT_MS, 15_000, 1_000, 120_000);
const MAX_CLIENTS = clampInt(process.env.LIVE_VIEW_MAX_CLIENTS, 20, 1, 200);
const MAX_PER_USER = clampInt(process.env.LIVE_VIEW_MAX_PER_USER, 5, 1, 50);
const BACKPRESSURE_MAX_BYTES = 512 * 1024;
const SNAPSHOT_EVENT_LIMIT = 50;
const EMITTED_IDS_MAX = 1_000; // bound on the M2 re-emit-suppression set

function clampInt(raw, dflt, lo, hi) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

// ── module-level hub state ──────────────────────────────────────────────────
const clients = new Set(); // Set<{id, userId, res, alive, stalled, authExpiresAt}>
let pollTimer = null;
let pollGen = 0; // bumped on every stopPoller — in-flight ticks check it (M1)
let polling = false; // reentrancy guard: a slow tick must not stack
let watermarks = null; // { touchId, coEventId } | null (null ⇒ not yet seeded)
let lastWriteTs = 0;
let nextClientId = 1;
// M2: ids the hub has already fanned out — the overlap draw re-reads the last
// K ids every tick, and this set is what keeps those from re-emitting.
let emittedIds = new Set();
let emittedOrder = [];

export const LIVE_VIEW_LIMITS = Object.freeze({
  pollMs: POLL_MS,
  heartbeatMs: HEARTBEAT_MS,
  maxClients: MAX_CLIENTS,
  maxPerUser: MAX_PER_USER,
});

/** Internal gauges for the verification harness. */
export function _liveStats() {
  return {
    clients: clients.size,
    pollerActive: pollTimer !== null,
    watermarksSeeded: watermarks !== null,
    emittedIds: emittedIds.size,
  };
}

function rememberEmitted(ids) {
  for (const id of ids) {
    if (emittedIds.has(id)) continue;
    emittedIds.add(id);
    emittedOrder.push(id);
  }
  while (emittedOrder.length > EMITTED_IDS_MAX) {
    emittedIds.delete(emittedOrder.shift());
  }
}

function writeFrame(client, frame) {
  if (!client.alive) return;
  try {
    const flushed = client.res.write(frame);
    if (flushed === false && !client.stalled) {
      // Track the un-drained state (H2). 'drain' clears it; if it is still
      // set when the next fan-out comes around, the client is dropped.
      client.stalled = true;
      client.res.once('drain', () => {
        client.stalled = false;
      });
    }
  } catch (err) {
    // A dead socket mid-write: drop the client; the 'close' handler may or
    // may not still fire, so drop defensively here too.
    console.error('[live-view] SSE write failed, dropping client:', err.message);
    dropClient(client, 'write_failed');
  }
}

/** H2: true when this client must be dropped instead of written to. */
function isBackpressured(client) {
  if (client.stalled) return true;
  const buffered = Number(client.res.writableLength ?? client.res.socket?.writableLength ?? 0);
  return buffered > BACKPRESSURE_MAX_BYTES;
}

/** M4: drop clients whose JWT expired; H2: drop clients that stopped reading. */
function sweepClients() {
  const now = Date.now();
  for (const c of [...clients]) {
    if (c.authExpiresAt && now >= c.authExpiresAt) {
      // Final frame THEN close: the client reconnects, and the reconnect's
      // snapshot GET goes through the app's normal token-refresh machinery.
      writeFrame(c, 'event: auth_expired\ndata: {"type":"auth_expired"}\n\n');
      dropClient(c, 'auth_expired');
    } else if (isBackpressured(c)) {
      dropClient(c, 'backpressure');
    }
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
  const gen = pollGen; // M1: any stopPoller() bumps this; stale ticks bail
  let wrote = false;
  try {
    sweepClients(); // M4 expiries + H2 backpressure, before any DB work
    if (clients.size === 0) return; // sweep may have emptied the hub

    // Seed watermarks BEFORE the first emit (never emit with no watermark —
    // that would replay history). Then PRIME the emitted-id set with the
    // overlap window: the M2 overlap draw re-reads the last K ids every tick,
    // and without priming the first tick would see all K historical rows as
    // "fresh" and replay them. Only ids AT/BELOW the seed watermark are
    // primed — a row landing during this very await stays unprimed and is
    // emitted by the next tick's overlap draw.
    if (watermarks === null) {
      const seeded = await readWatermarks();
      if (gen !== pollGen) return; // stopped mid-await — never resurrect (M1)
      const prime = await readNewEvents({
        touchId: seeded.touchId,
        coEventId: seeded.coEventId,
      });
      if (gen !== pollGen) return;
      rememberEmitted(prime.events
        .filter((ev) => {
          const n = Number(ev.id.slice(2)); // 't_<id>' | 'c_<id>'
          return ev.id.startsWith('t_') ? n <= seeded.touchId : n <= seeded.coEventId;
        })
        .map((ev) => ev.id));
      watermarks = { touchId: prime.touchId, coEventId: prime.coEventId };
    }

    const snap = await buildLiveSnapshot({ limit: SNAPSHOT_EVENT_LIMIT });
    if (gen !== pollGen) return;
    if (clients.size > 0) {
      fanOut('snapshot', snap);
      wrote = true;
    }

    const delta = await readNewEvents({
      touchId: watermarks.touchId,
      coEventId: watermarks.coEventId,
    });
    if (gen !== pollGen) return;
    watermarks = { touchId: delta.touchId, coEventId: delta.coEventId };
    // M2: the overlap draw re-reads the last K ids on purpose — suppress the
    // ones already fanned out; only genuinely-new rows go to the wire.
    const fresh = delta.events.filter((ev) => !emittedIds.has(ev.id));
    rememberEmitted(delta.events.map((ev) => ev.id));
    if (fresh.length > 0 && clients.size > 0) {
      fanOut('events', { events: fresh });
      wrote = true;
    }
  } catch (err) {
    // One failing tick must never kill the feed. Log loudly, keep the loop.
    console.error('[live-view] poll tick failed:', err.message);
  } finally {
    polling = false;
  }
  if (gen === pollGen && !wrote && clients.size > 0
      && Date.now() - lastWriteTs > HEARTBEAT_MS) {
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
  pollGen += 1; // M1: any in-flight tick sees the bump and bails
  // Reset the watermark + emit memory so a later first-subscriber re-seeds at
  // "now" — events that happened while nobody watched are history, not live
  // pushes (and their ids must not linger in the dedupe set).
  watermarks = null;
  emittedIds = new Set();
  emittedOrder = [];
}

function dropClient(client, reason = 'closed') {
  if (!client.alive && !clients.has(client)) return;
  client.alive = false;
  clients.delete(client);
  if (reason !== 'closed') {
    console.warn(`[live-view] dropped SSE client (${reason}) user=${client.userId}`);
    try { client.res.end(); } catch { /* socket already gone */ }
  }
  if (clients.size === 0) stopPoller();
}

function userClientCount(userId) {
  let n = 0;
  for (const c of clients) if (c.userId === userId) n += 1;
  return n;
}

/**
 * Attach one SSE consumer to an Express response the ROUTE has already
 * authenticated. Returns {ok:true} on success, or {ok:false, reason} when a
 * cap refuses it (the route maps reasons onto status codes). On success the
 * hub owns the response lifecycle: headers, the seed comment, close-cleanup,
 * poller start/stop.
 *
 * `userId` drives the per-user sub-cap (review L1); `authExpiresAt` (ms
 * epoch, from the JWT's exp) drives the mid-stream expiry sweep (review M4) —
 * null means "no expiry known", which only unauthenticated internal callers
 * (the harness) can produce, since the route always passes the real exp.
 */
export function subscribe(req, res, { userId = 'unknown', authExpiresAt = null } = {}) {
  if (clients.size >= MAX_CLIENTS) return { ok: false, reason: 'server_cap' };
  if (userClientCount(userId) >= MAX_PER_USER) return { ok: false, reason: 'user_cap' };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = {
    id: nextClientId++,
    userId: String(userId),
    res,
    alive: true,
    stalled: false,
    authExpiresAt: Number.isFinite(authExpiresAt) ? authExpiresAt : null,
  };
  clients.add(client);

  // An immediate comment so the client's fetch resolves its first read and
  // can flip the UI to "live" before the first tick lands.
  writeFrame(client, ': connected\n\n');

  // Cleanup on EVERY way a socket dies: close covers client aborts and
  // network drops; 'error' covers mid-write resets.
  const cleanup = () => dropClient(client, 'closed');
  req.on('close', cleanup);
  res.on('error', cleanup);

  startPoller();
  return { ok: true };
}
