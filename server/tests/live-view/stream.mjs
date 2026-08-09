// Route-level verification for /api/v1/live (Live View): the REAL router
// (REAL authenticate + requirePermission + the REAL hub/queries) mounted on a
// minimal express host against a fresh embedded-PG database — same pattern as
// server/tests/funnels/page-thumbnails-route.mjs (the full app.js is not used
// so other services' boot-recovery queries can't flap the shared breaker).
//
// Asserts, in order:
//   1. 401 without a token (snapshot AND stream)
//   2. snapshot shape with seeded rows: live/unique counts, by_funnel with
//      funnel names, events (view/checkout_start/purchase) with values,
//      geo.available === false (the honesty rule), basis strings
//   3. malformed params → 400 (snapshot ?limit=abc / 0 / 9999; stream ?limit)
//   4. SSE stream delivers a seeded NEW event within the poll interval
//      (LIVE_VIEW_POLL_MS=400 here), and does NOT replay history as a delta
//   5. connection cleanup — after the client aborts, _liveStats() shows
//      0 clients and the poll timer stopped (no leaked intervals)
//   6. connection cap — LIVE_VIEW_MAX_CLIENTS=2 → the 3rd stream gets 503
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
  LIVE_VIEW_POLL_MS: '400', LIVE_VIEW_MAX_CLIENTS: '2',
});

const { default: express } = await import('express');
const { default: liveViewRoutes } = await import('../../src/routes/liveView.js');
const { _liveStats, LIVE_VIEW_LIMITS } = await import('../../src/services/liveViewHub.js');
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');

const app = express();
app.use('/api/v1/live', liveViewRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');

// ---- Minimal tables the route touches (auth + the four data sources) ------
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_lv','lv@t.co','L','V')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_lv','funnels-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_lv','r_lv')`;
const TOKEN = signAccessToken({ userId: 'u_lv' });

await sql.unsafe(`CREATE TABLE IF NOT EXISTS lb_touches (
  id BIGSERIAL PRIMARY KEY, vid TEXT NOT NULL, funnel_id TEXT, page_id TEXT,
  url TEXT, referrer TEXT, utm JSONB NOT NULL DEFAULT '{}',
  click_ids JSONB NOT NULL DEFAULT '{}',
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
)`);
await sql.unsafe(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE
)`);
await sql.unsafe(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT ''
)`);
await sql.unsafe(`CREATE TABLE IF NOT EXISTS co_sessions (
  id TEXT PRIMARY KEY, funnel_id TEXT, page_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing', total NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD', vid TEXT, paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await sql.unsafe(`CREATE TABLE IF NOT EXISTS co_events (
  id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  data JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

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

// Money: one paid session on F1 ($49.90, paid today) + one open checkout.
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid, paid_at)
  VALUES ('cs_lv_paid', ${F1}, 'pg_lv_lp', 'paid', 49.90, 'v_lv_2', NOW() - INTERVAL '10 minutes')`;
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, vid)
  VALUES ('cs_lv_open', ${F1}, 'pg_lv_lp', 'processing', 19.90, 'v_lv_1')`;
await sql`INSERT INTO co_events (session_id, kind, data) VALUES
  ('cs_lv_paid', 'session_created', '{}'),
  ('cs_lv_paid', 'paid', '{}'),
  ('cs_lv_open', 'session_created', '{}')`;

const get = (path, auth = true) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });

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
  ok(Math.abs(Number(s.revenue_today) - 49.9) < 0.005, 'revenue_today = 49.90', `got ${s.revenue_today}`);

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

  ok(s.geo && s.geo.available === false && /hash/i.test(s.geo.reason || ''),
    'geo.available === false with an honest reason', JSON.stringify(s.geo));
  ok(s.basis && /5 minutes/.test(s.basis.live), 'basis.live names the 5-minute window', JSON.stringify(s.basis));
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

// ═══ 4. SSE STREAM — a NEW event arrives within the poll interval ═══════════
// (and history is NOT replayed as a delta: the watermark seeds at max id)
async function openStream() {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/live/stream`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
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
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
};

{
  const s1 = await openStream();
  ok(s1.res.status === 200 && /text\/event-stream/.test(s1.res.headers.get('content-type') || ''),
    'stream authed → 200 text/event-stream', `${s1.res.status} ${s1.res.headers.get('content-type')}`);

  // First snapshot frame ⇒ the poller ran a tick and the watermark is seeded.
  const gotSnap = await waitFor(() => s1.frames.some((f) => f.event === 'snapshot'), 3000);
  ok(gotSnap, 'stream delivers a snapshot frame within ~2 ticks');
  const preDeltaEvents = s1.frames.filter((f) => f.event === 'events').length;
  ok(preDeltaEvents === 0, 'history was NOT replayed as an events delta', `got ${preDeltaEvents} events frames`);

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

  // Live counter moved on the NEXT snapshot frame (4 live vids now).
  const bumped = await waitFor(() => {
    const snaps = s1.frames.filter((f) => f.event === 'snapshot');
    if (snaps.length === 0) return false;
    return JSON.parse(snaps[snaps.length - 1].data).live_total === 4;
  }, 2500);
  ok(bumped, 'next snapshot frame shows live_total = 4');

  // ═══ 6. CONNECTION CAP (while s1 is still attached) ═══════════════════════
  const s2 = await openStream();
  await waitFor(() => _liveStats().clients === 2, 1500);
  ok(_liveStats().clients === 2, 'two clients attached', JSON.stringify(_liveStats()));
  const r3 = await get('/api/v1/live/stream');
  ok(r3.status === 503, `3rd stream over the cap (${LIVE_VIEW_LIMITS.maxClients}) → 503`, `got ${r3.status}`);
  const b3 = await r3.json();
  ok(b3.error === 'too_many_live_connections', '503 body names the cap', JSON.stringify(b3));

  // ═══ 5. CLEANUP — no leaked clients or poll timer after disconnect ════════
  s1.controller.abort();
  s2.controller.abort();
  await s1.done; await s2.done;
  const cleaned = await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
  ok(cleaned, 'after disconnect: 0 clients + poll timer stopped', JSON.stringify(_liveStats()));
  ok(_liveStats().watermarksSeeded === false, 'watermarks reset for the next first-subscriber', JSON.stringify(_liveStats()));

  // A fresh subscriber restarts the poller cleanly.
  const s3 = await openStream();
  const restarted = await waitFor(() => _liveStats().pollerActive && s3.frames.some((f) => f.event === 'snapshot'), 3000);
  ok(restarted, 'a later subscriber restarts the poller and gets snapshots');
  s3.controller.abort();
  await s3.done;
  await waitFor(() => _liveStats().clients === 0 && !_liveStats().pollerActive, 3000);
}

// ---- Teardown -------------------------------------------------------------
await closeAnalyticsPool();
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
