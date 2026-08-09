// Route-level verification for /api/v1/live (Live View): the REAL router
// (REAL authenticate + requirePermission + the REAL hub/queries + the REAL
// schema ensures, so the new index DDL executes) mounted on a minimal express
// host against a fresh embedded-PG database — same pattern as
// server/tests/funnels/page-thumbnails-route.mjs (the full app.js is not used
// so other services' boot-recovery queries can't flap the shared breaker).
//
// Asserts, in order:
//   1. 401 without a token (snapshot AND stream)
//   2. snapshot shape with seeded rows: live/unique counts, by_funnel with
//      funnel names, events (view/checkout_start/purchase) with values,
//      revenue_today INCLUDING settled upsell dollars (review M3),
//      geo.available === false (the honesty rule), basis strings
//   3. malformed params → 400 (snapshot ?limit variants; stream ?limit)
//   4. EXPLAIN (review H1): the per-tick hot statements use an Index scan and
//      no Seq Scan. CAVEAT: embedded PG here may differ from prod PG 16, and
//      at harness row counts the cost model would prefer seq scans anyway —
//      so the session sets enable_seqscan=off first. The assertion therefore
//      proves the indexes EXIST and are APPLICABLE to these exact predicates
//      (which is what makes them usable at prod volumes), not that this tiny
//      dataset's planner would naturally pick them.
//   5. backpressure (review H2): a connected-but-never-draining fake socket
//      (write() → false, huge writableLength) is dropped by the next tick's
//      sweep with a named reason; gauges return to zero
//   6. SSE stream delivers a seeded NEW event within the poll interval
//      (LIVE_VIEW_POLL_MS=400 here), and does NOT replay history as a delta
//   7. connection caps: per-user (2 here) → 503 too_many_user_connections;
//      global (4 here) → 503 too_many_live_connections
//   8. cleanup — after every client aborts, _liveStats() shows 0 clients,
//      the poll timer stopped, watermarks reset; a later subscriber restarts
//   9. M2 interleave: a row whose txn takes an EARLIER id but commits AFTER a
//      later id was already observed still emits (overlap draw + dedupe)
//  10. M4: a stream opened with a 2s-exp token receives a final auth_expired
//      event and is closed once the token lapses
//  11. L6 handle census: active 'Timeout' resource count returns to its
//      pre-stream baseline (+1 tolerance — postgres.js keeps its own idle
//      timers; the flag asserts in #8 are the strict gauge)
//
// Run:  node server/tests/live-view/stream.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_liveview';
const PORT = 48922;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_liveview`;
await admin`CREATE DATABASE puure_liveview`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
  LIVE_VIEW_POLL_MS: '400', LIVE_VIEW_MAX_CLIENTS: '4', LIVE_VIEW_MAX_PER_USER: '2',
});

const { default: express } = await import('express');
const { default: liveViewRoutes } = await import('../../src/routes/liveView.js');
const hub = await import('../../src/services/liveViewHub.js');
const { _liveStats, LIVE_VIEW_LIMITS, subscribe } = hub;
const { _HOT_SQL } = await import('../../src/services/liveViewQueries.js');
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');
const { EventEmitter } = await import('node:events');

const app = express();
app.use('/api/v1/live', liveViewRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');

// ---- REAL schema ensures — executes the new H1 index DDL for real ---------
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTables: ensureFunnelTables } = await import('../../src/routes/funnels.js');
await ensureTrackingTables();
await ensureCheckoutTables();
await ensureFunnelTables();
const idx = await sql`SELECT indexname FROM pg_indexes
  WHERE indexname IN ('idx_lb_touches_ts','idx_co_events_kind_created')`;
ok(idx.length === 2, 'H1 DDL: both new indexes exist after the real ensures',
  JSON.stringify(idx));

// ---- Auth fixtures (minimal tables the auth query touches) ----------------
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_lv','lv@t.co','L','V'), ('u_lv2','lv2@t.co','L','V'), ('u_lv3','lv3@t.co','L','V')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_lv','funnels-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_lv','r_lv'),('u_lv2','r_lv'),('u_lv3','r_lv')`;
const TOKEN = signAccessToken({ userId: 'u_lv' });
const TOKEN2 = signAccessToken({ userId: 'u_lv2' });
const TOKEN3 = signAccessToken({ userId: 'u_lv3' });

// ---- Seed fixtures --------------------------------------------------------
const F1 = 'fnl_lv_alpha', F2 = 'fnl_lv_beta';
await sql`INSERT INTO funnels (id, slug, name) VALUES
  (${F1}, 'lv-alpha', 'LV Alpha'), (${F2}, 'lv-beta', 'LV Beta')`;
await sql`INSERT INTO funnel_pages (id, funnel_id, slug, title) VALUES
  ('pg_lv_lp', ${F1}, '/', 'Alpha Lander')`;

const touch = (vid, funnel, minsAgo, page = 'pg_lv_lp') => sql.unsafe(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, ts, expires_at)
   VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval, NOW() + INTERVAL '90 days')`,
  [vid, funnel, page, String(minsAgo)]
);
// F1: 2 live vids (one touching twice — distinct must not double), 1 earlier-today vid.
await touch('v_lv_1', F1, 1);
await touch('v_lv_1', F1, 2);
await touch('v_lv_2', F1, 3);
await touch('v_lv_old', F1, 30);
// F2: 1 live vid.
await touch('v_lv_3', F2, 1);

// Money: one paid session on F1 ($49.90, paid today) + one open checkout +
// one SETTLED upsell charge ($10.10 — review M3: revenue must include it).
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, paid_at)
  VALUES ('cs_lv_paid', ${F1}, 'pg_lv_lp', 'paid', 49.90, 'v_lv_2', NOW() - INTERVAL '10 minutes')`;
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid)
  VALUES ('cs_lv_open', ${F1}, 'pg_lv_lp', 'processing', 19.90, 'v_lv_1')`;
await sql`INSERT INTO co_events (session_id, kind, data) VALUES
  ('cs_lv_paid', 'session_created', '{}'),
  ('cs_lv_paid', 'paid', '{}'),
  ('cs_lv_open', 'session_created', '{}')`;
await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status)
  VALUES ('uc_lv_1', 'cs_lv_paid', 'offer_1', 'v:1', 10.10, 'settled')`;

const get = (path, auth = true, token = TOKEN) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: auth ? { authorization: `Bearer ${token}` } : {},
  });

const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
};

// ═══ 1. AUTH ════════════════════════════════════════════════════════════════
{
  const r1 = await get('/api/v1/live/snapshot', false);
  ok(r1.status === 401, 'snapshot without token → 401', `got ${r1.status}`);
  const r2 = await get('/api/v1/live/stream', false);
  ok(r2.status === 401, 'stream without token → 401', `got ${r2.status}`);
}

// ═══ 2. SNAPSHOT SHAPE ══════════════════════════════════════════════════════
{
  const r = await get('/api/v1/live/snapshot');
  ok(r.status === 200, 'snapshot authed → 200', `got ${r.status}`);
  const s = await r.json();
  ok(s.live_total === 3, 'live_total = 3 distinct vids in 5min', `got ${s.live_total}`);
  ok(s.unique_today_total === 4, 'unique_today_total = 4 distinct vids', `got ${s.unique_today_total}`);
  ok(s.checkout_starts_today === 2, 'checkout_starts_today = 2', `got ${s.checkout_starts_today}`);
  ok(s.purchases_today === 1, 'purchases_today = 1', `got ${s.purchases_today}`);
  ok(Math.abs(Number(s.revenue_today) - 60.0) < 0.005,
    'revenue_today = 60.00 (49.90 base + 10.10 settled upsell — M3)', `got ${s.revenue_today}`);

  const alpha = (s.by_funnel || []).find((f) => f.funnel_id === F1);
  const beta = (s.by_funnel || []).find((f) => f.funnel_id === F2);
  ok(alpha && alpha.live === 2 && alpha.unique_today === 3 && alpha.name === 'LV Alpha',
    'by_funnel alpha {live:2, unique_today:3, name}', JSON.stringify(alpha));
  ok(beta && beta.live === 1 && beta.name === 'LV Beta', 'by_funnel beta {live:1, name}', JSON.stringify(beta));

  const types = new Set((s.events || []).map((e) => e.type));
  ok(types.has('view') && types.has('checkout_start') && types.has('purchase'),
    'events carry view + checkout_start + purchase', [...types].join(','));
  const purchase = (s.events || []).find((e) => e.type === 'purchase');
  ok(purchase && Math.abs(Number(purchase.value) - 49.9) < 0.005 && purchase.funnel_name === 'LV Alpha',
    'purchase event has value 49.90 + funnel name', JSON.stringify(purchase));
  const view = (s.events || []).find((e) => e.type === 'view');
  ok(view && view.funnel_name && view.page_title === 'Alpha Lander',
    'view event resolves funnel + page title', JSON.stringify(view));

  // ANALYTICS LANE 5 flipped the source of this card: country IS captured now
  // (lb_touches.country), so the old reason ("salted IP hashes only") is no
  // longer true and the assertion can no longer look for "hash". These touches
  // are seeded by direct INSERT with no country, so the honest state here is
  // still available:false — but now it must ALSO carry coverage, which is the
  // guard against a thin sample rendering as a census.
  ok(s.geo && s.geo.available === false && Array.isArray(s.geo.by_country) && s.geo.by_country.length === 0
     && /country/i.test(s.geo.reason || '')
     && s.geo.coverage && s.geo.coverage.resolved_visitors === 0 && s.geo.coverage.total_visitors > 0,
    'geo.available === false with an honest reason + coverage', JSON.stringify(s.geo));
  ok(s.basis && /5 minutes/.test(s.basis.live), 'basis.live names the 5-minute window', JSON.stringify(s.basis));
  ok(/co_upsell_charges/.test(s.basis?.revenue_today || ''),
    'basis.revenue_today names the upsell component (M3)', s.basis?.revenue_today);
  ok(Array.isArray(s.warnings) && s.warnings.length === 0 && s.degraded === false,
    'no warnings / not degraded on a healthy DB', JSON.stringify(s.warnings));
}

// ═══ 3. MALFORMED PARAMS ════════════════════════════════════════════════════
{
  for (const bad of ['abc', '0', '9999', '-5', '1.5']) {
    const r = await get(`/api/v1/live/snapshot?limit=${encodeURIComponent(bad)}`);
    ok(r.status === 400, `snapshot ?limit=${bad} → 400`, `got ${r.status}`);
  }
  const r2 = await get('/api/v1/live/snapshot?limit=2');
  const s2 = await r2.json();
  ok(r2.status === 200 && s2.events.length === 2, 'snapshot ?limit=2 → 200 with 2 events', `${r2.status}/${s2.events?.length}`);
  const r3 = await get('/api/v1/live/stream?limit=5');
  ok(r3.status === 400, 'stream ?limit → 400 (stream takes no params)', `got ${r3.status}`);
}

// ═══ 4. EXPLAIN — the hot statements ride the new indexes (H1) ══════════════
// enable_seqscan=off: see the file-header caveat — this proves index
// EXISTENCE + APPLICABILITY, which tiny-fixture costing would otherwise hide.
{
  const KINDS_LIT = `ARRAY['session_created','paid','upsell_settled']`;
  const explainPlan = async (text) => {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL enable_seqscan = off`);
      return tx.unsafe(`EXPLAIN ${text}`);
    });
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };
  const cases = [
    ['touch_rollup (totals + by_funnel, every tick)', _HOT_SQL.touch_rollup],
    ['co_events_delta (every tick)', _HOT_SQL.co_events_delta
      .replace('$1', KINDS_LIT).replace('$2', '0').replace('$3', '100')],
    ['co_events_tiles (every 15s)', _HOT_SQL.co_events_tiles.replace('$1', KINDS_LIT)],
  ];
  for (const [name, text] of cases) {
    const plan = await explainPlan(text);
    const usesIndex = /Index/.test(plan);
    const seqScans = plan.match(/Seq Scan/g) || [];
    ok(usesIndex && seqScans.length === 0,
      `EXPLAIN ${name}: Index scan, no Seq Scan`, `\n${plan}`);
    console.log(`      plan(${name.split(' ')[0]}): ${plan.split('\n')[0].trim()}`);
  }
}

// ═══ 5. BACKPRESSURE (H2) — a never-draining client is dropped ══════════════
{
  const fakeReq = new EventEmitter();
  const fakeRes = Object.assign(new EventEmitter(), {
    ended: false,
    writableLength: 0,
    status() { return this; },
    setHeader() {},
    flushHeaders() {},
    write() { this.writableLength = 1024 * 1024; return false; }, // never drains
    end() { this.ended = true; },
  });
  const r = subscribe(fakeReq, fakeRes, { userId: 'u_fake', authExpiresAt: null });
  ok(r.ok === true, 'fake non-draining client attaches', JSON.stringify(r));
  // The ': connected' seed write already returned false, so the client is
  // stalled from birth — the immediate first tick's sweep may drop it before
  // this line runs (stricter than the "by the NEXT tick" requirement).
  ok(_liveStats().clients <= 1, 'gauge shows ≤1 client (drop may already have run)', JSON.stringify(_liveStats()));
  const dropped = await waitFor(() => _liveStats().clients === 0, 2000);
  ok(dropped, 'non-draining client dropped by the next tick sweep (H2)', JSON.stringify(_liveStats()));
  ok(fakeRes.ended === true, 'dropped client response was ended', String(fakeRes.ended));
  ok(_liveStats().pollerActive === false, 'poller stopped after the forced drop', JSON.stringify(_liveStats()));
}

// ── SSE reader helper ───────────────────────────────────────────────────────
async function openStream(token = TOKEN) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/live/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const frames = [];
  let buffer = '';
  const done = (async () => {
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          const data = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            else if (line.startsWith(':')) { event = 'comment'; data.push(line.slice(1).trim()); }
          }
          frames.push({ event, data: data.join('\n') });
        }
      }
    } catch { /* aborted — expected */ }
  })();
  return { controller, res, frames, done };
}

// L6 baseline — Timeout resources before any stream is opened.
const timeoutCount = () =>
  process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
const baselineTimeouts = timeoutCount();

// ═══ 6. SSE STREAM — a NEW event arrives within the poll interval ═══════════
// (and history is NOT replayed as a delta: watermark seed + primed overlap)
{
  const s1 = await openStream();
  ok(s1.res.status === 200 && /text\/event-stream/.test(s1.res.headers.get('content-type') || ''),
    'stream authed → 200 text/event-stream', `${s1.res.status} ${s1.res.headers.get('content-type')}`);

  // First snapshot frame ⇒ the poller ran a tick and the watermark is seeded.
  const gotSnap = await waitFor(() => s1.frames.some((f) => f.event === 'snapshot'), 3000);
  ok(gotSnap, 'stream delivers a snapshot frame within ~2 ticks');
  const preDeltaEvents = s1.frames.filter((f) => f.event === 'events').length;
  ok(preDeltaEvents === 0, 'history was NOT replayed as an events delta (overlap primed)',
    `got ${preDeltaEvents} events frames`);

  // NEW activity while connected: a fresh pageview + a fresh purchase.
  await touch('v_lv_new', F1, 0);
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, paid_at)
    VALUES ('cs_lv_live', ${F1}, 'pg_lv_lp', 'paid', 15.00, 'v_lv_new', NOW())`;
  await sql`INSERT INTO co_events (session_id, kind, data) VALUES ('cs_lv_live', 'paid', '{}')`;

  const gotDelta = await waitFor(() => s1.frames.some((f) => f.event === 'events'), 2500);
  ok(gotDelta, `stream delivers the new events within the poll interval (${LIVE_VIEW_LIMITS.pollMs}ms)`);
  if (gotDelta) {
    const payload = JSON.parse(s1.frames.filter((f) => f.event === 'events').pop().data);
    const kinds = payload.events.map((e) => e.type).sort();
    ok(kinds.includes('view') && kinds.includes('purchase'),
      'delta carries the new view + purchase', kinds.join(','));
    const p = payload.events.find((e) => e.type === 'purchase');
    ok(p && Math.abs(Number(p.value) - 15) < 0.005, 'delta purchase carries value 15.00', JSON.stringify(p));
  }

  // The overlap draw must not RE-emit those rows on later ticks (M2 dedupe).
  const framesAfter = s1.frames.filter((f) => f.event === 'events').length;
  await new Promise((r) => setTimeout(r, 1000)); // ≥2 more ticks
  const framesLater = s1.frames.filter((f) => f.event === 'events').length;
  ok(framesLater === framesAfter, 'overlap window does not re-emit already-sent events',
    `${framesAfter} → ${framesLater}`);

  // Live counter moved on the NEXT snapshot frame (4 live vids now).
  const bumped = await waitFor(() => {
    const snaps = s1.frames.filter((f) => f.event === 'snapshot');
    if (snaps.length === 0) return false;
    return JSON.parse(snaps[snaps.length - 1].data).live_total === 4;
  }, 2500);
  ok(bumped, 'next snapshot frame shows live_total = 4');

  // ═══ 7. CONNECTION CAPS (while s1 is still attached) ══════════════════════
  const s2 = await openStream(); // u_lv's 2nd — at the per-user cap now
  await waitFor(() => _liveStats().clients === 2, 1500);
  ok(_liveStats().clients === 2, 'two clients attached', JSON.stringify(_liveStats()));
  const rUser = await get('/api/v1/live/stream'); // u_lv's 3rd
  ok(rUser.status === 503, `3rd same-user stream over per-user cap (${LIVE_VIEW_LIMITS.maxPerUser}) → 503`, `got ${rUser.status}`);
  const bUser = await rUser.json();
  ok(bUser.error === 'too_many_user_connections', '503 body names the user cap', JSON.stringify(bUser));

  const s3 = await openStream(TOKEN2);
  const s4 = await openStream(TOKEN3);
  await waitFor(() => _liveStats().clients === 4, 1500);
  ok(_liveStats().clients === 4, 'four clients attached (global cap reached)', JSON.stringify(_liveStats()));
  const rGlob = await get('/api/v1/live/stream', true, TOKEN2); // u2's 2nd, but server full
  ok(rGlob.status === 503, `stream over global cap (${LIVE_VIEW_LIMITS.maxClients}) → 503`, `got ${rGlob.status}`);
  const bGlob = await rGlob.json();
  ok(bGlob.error === 'too_many_live_connections', '503 body names the global cap', JSON.stringify(bGlob));

  // ═══ 8. CLEANUP — no leaked clients or poll timer after disconnect ════════
  for (const s of [s1, s2, s3, s4]) s.controller.abort();
  await Promise.all([s1.done, s2.done, s3.done, s4.done]);
  const cleaned = await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
  ok(cleaned, 'after disconnect: 0 clients + poll timer stopped', JSON.stringify(_liveStats()));
  ok(_liveStats().watermarksSeeded === false, 'watermarks reset for the next first-subscriber', JSON.stringify(_liveStats()));
  ok(_liveStats().emittedIds === 0, 'emitted-id memory cleared on poller stop', JSON.stringify(_liveStats()));

  // A fresh subscriber restarts the poller cleanly.
  const s5 = await openStream();
  const restarted = await waitFor(() => _liveStats().pollerActive && s5.frames.some((f) => f.event === 'snapshot'), 3000);
  ok(restarted, 'a later subscriber restarts the poller and gets snapshots');
  s5.controller.abort();
  await s5.done;
  await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
}

// ═══ 9. M2 — a row committing LATE (earlier id, later commit) still emits ═══
{
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, paid_at)
    VALUES ('cs_lv_late', ${F1}, 'pg_lv_lp', 'paid', 77.00, 'v_m2', NOW()),
           ('cs_lv_after', ${F1}, 'pg_lv_lp', 'paid', 88.00, 'v_m2', NOW())`;

  const s = await openStream();
  await waitFor(() => s.frames.some((f) => f.event === 'snapshot'), 3000);

  // Txn A takes the EARLIER co_events id and holds it uncommitted…
  let releaseA;
  const holdA = new Promise((r) => { releaseA = r; });
  const txnA = sql.begin(async (tx) => {
    await tx`INSERT INTO co_events (session_id, kind, data) VALUES ('cs_lv_late', 'paid', '{}')`;
    await holdA;
  });
  await new Promise((r) => setTimeout(r, 100)); // A's insert (and id) is taken
  // …then a LATER id commits first and gets observed by the watermark.
  await sql`INSERT INTO co_events (session_id, kind, data) VALUES ('cs_lv_after', 'paid', '{}')`;

  const findPurchase = (v) => s.frames
    .filter((f) => f.event === 'events')
    .flatMap((f) => JSON.parse(f.data).events)
    .find((e) => e.type === 'purchase' && Math.abs(Number(e.value) - v) < 0.005);

  const got88 = await waitFor(() => Boolean(findPurchase(88)), 2500);
  ok(got88, 'later-id purchase (88.00) emitted while the earlier id is uncommitted');
  ok(!findPurchase(77), 'uncommitted earlier-id purchase (77.00) not emitted yet');

  releaseA();
  await txnA; // txn A commits — its id is now BELOW the observed watermark
  const got77 = await waitFor(() => Boolean(findPurchase(77)), 2500);
  ok(got77, 'late-committing earlier-id purchase (77.00) still emitted (M2 overlap)');

  s.controller.abort();
  await s.done;
  await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
}

// ═══ 10. M4 — mid-stream token expiry ends the stream with auth_expired ═════
{
  const SHORT = signAccessToken({ userId: 'u_lv' }, '2s');
  const s = await openStream(SHORT);
  ok(s.res.status === 200, 'short-exp token stream opens (still valid at connect)', `got ${s.res.status}`);
  await waitFor(() => s.frames.some((f) => f.event === 'snapshot'), 3000);
  const gotExpired = await waitFor(() => s.frames.some((f) => f.event === 'auth_expired'), 4000);
  ok(gotExpired, 'auth_expired frame delivered once the JWT lapsed (M4)');
  await s.done; // server ended the response — the reader finishes on its own
  const closed = await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
  ok(closed, 'expired client swept: 0 clients + poller stopped', JSON.stringify(_liveStats()));
  s.controller.abort(); // belt-and-braces; the stream is already done
}

// ═══ 11. L6 — handle census back at baseline ════════════════════════════════
{
  await new Promise((r) => setTimeout(r, 300)); // let closed sockets settle
  const after = timeoutCount();
  ok(after <= baselineTimeouts + 1,
    `Timeout resources at/below baseline+1 after all streams closed (${baselineTimeouts} → ${after})`,
    process.getActiveResourcesInfo().join(','));
}

// ---- Teardown -------------------------------------------------------------
await closeAnalyticsPool();
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
