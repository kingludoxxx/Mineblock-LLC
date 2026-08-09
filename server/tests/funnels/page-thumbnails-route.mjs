// Route-level verification for /api/v1/page-thumbnails: the REAL router file
// (REAL authenticate + requirePermission + chromium) mounted on a minimal
// express host, against a fresh embedded-PG database. The full app.js was
// NOT used deliberately: its other services' boot-recovery/interval queries
// fail against a bare DB and flap db/pg.js's shared circuit breaker, which
// makes every DB-backed route (correctly) fail open — that measures the boot
// storm, not this route. (A full-app run DID prove the mount: unauthed 401
// and authed 200 image/jpeg before the breaker opened.)
// Asserts: 401 without a token, 200 image/jpeg with Cache-Control for an
// authed request, cache hit on the second request (screenshot count frozen),
// 404 for a missing page, and 202 {pending} when both screenshot slots are
// busy. The canvas must never see a 500 from this route.
//
// Run:  node server/tests/funnels/page-thumbnails-route.mjs
import crypto from 'crypto';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_thumbroute';
const PORT = 48910;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_thumbroute`;
await admin`CREATE DATABASE puure_thumbroute`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: pageThumbnailsRoutes } = await import('../../src/routes/pageThumbnails.js');
const app = express();
app.use('/api/v1/page-thumbnails', pageThumbnailsRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 300));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
const { ensureTables } = await import('../../src/routes/funnels.js');
const { _stats } = await import('../../src/routes/pageThumbnails.js');
await ensureTables();

// ---- Seed: user + funnels role (minimal tables the auth query touches) ----
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_thumb','t@t.co','T','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_thumb','funnels-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_thumb','r_thumb')`;
const TOKEN = signAccessToken({ userId: 'u_thumb' });

// ---- Seed: funnel + pages -------------------------------------------------
const FID = 'fnl_rt';
const BLOCKS = JSON.stringify([
  { id: 'b1', type: 'heading', props: { text: 'Route Test' } },
  { id: 'b2', type: 'text', props: { text: 'Rendered by the thumbnail route.' } },
]);
await sql`INSERT INTO funnels (id, slug, name) VALUES (${FID}, 'rt', 'Route Test')`;
for (let i = 0; i < 5; i++) {
  await sql.unsafe(
    `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, blocks)
     VALUES ($1, $2, $3, 'lead', $4, 'published', $5)`,
    [`pg_rt_${i}`, FID, `/p${i}`, `Page ${i}`, BLOCKS]
  );
}

const get = (path, auth = true) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });

// ---- Warmup: other services' boot-recovery queries fail against this bare
// DB and can trip db/pg.js's shared circuit breaker (opens after 5
// consecutive failures, resets after 30s). The route correctly fails OPEN
// (204) while it's open — poll until boot noise clears and a real 200
// arrives, so the assertions below measure the route, not the boot storm.
{
  const deadline = Date.now() + 90_000;
  let warm = null;
  while (Date.now() < deadline) {
    warm = await get(`/api/v1/page-thumbnails/${FID}/pg_rt_0.png`);
    if (warm.status === 200) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok(warm?.status === 200, `warmup reached 200 before deadline (last=${warm?.status})`);
}

// ---- T1: no token → 401 ---------------------------------------------------
const r401 = await get(`/api/v1/page-thumbnails/${FID}/pg_rt_0.png`, false);
ok(r401.status === 401, `T1 unauthenticated → 401 (got ${r401.status})`);

// ---- T2: authed → 200 image/jpeg + Cache-Control --------------------------
const r200 = await get(`/api/v1/page-thumbnails/${FID}/pg_rt_0.png`);
const body = Buffer.from(await r200.arrayBuffer());
ok(r200.status === 200, `T2 authed → 200 (got ${r200.status})`);
ok((r200.headers.get('content-type') || '').includes('image/jpeg'),
  `T2 content-type image/jpeg (got ${r200.headers.get('content-type')})`);
ok((r200.headers.get('cache-control') || '').includes('private') &&
   (r200.headers.get('cache-control') || '').includes('max-age=300'),
  `T2 Cache-Control private, max-age=300 (got ${r200.headers.get('cache-control')})`);
ok(body.length > 1024 && body[0] === 0xff && body[1] === 0xd8,
  `T2 JPEG body > 1KB (len=${body.length}, magic=${body.subarray(0, 2).toString('hex')})`);

// ---- T3: second request → cache hit, NO new screenshot --------------------
const shotsBefore = _stats.screenshots;
const rCached = await get(`/api/v1/page-thumbnails/${FID}/pg_rt_0.png`);
const cachedBody = Buffer.from(await rCached.arrayBuffer());
ok(rCached.status === 200 && cachedBody.equals(body), 'T3 second request → 200, byte-identical body');
ok(_stats.screenshots === shotsBefore,
  `T3 cache hit took NO new screenshot (${shotsBefore} -> ${_stats.screenshots})`);

// ---- T4: unknown page / funnel → 404, never 500 ---------------------------
const r404p = await get(`/api/v1/page-thumbnails/${FID}/pg_nope.png`);
ok(r404p.status === 404, `T4 unknown page → 404 (got ${r404p.status})`);
const r404f = await get(`/api/v1/page-thumbnails/fnl_nope/pg_rt_0.png`);
ok(r404f.status === 404, `T4 unknown funnel → 404 (got ${r404f.status})`);

// ---- T5: 4 uncached thumbs at once, 2 slots → some 202 {pending} ----------
const burst = await Promise.all(
  [1, 2, 3, 4].map((i) => get(`/api/v1/page-thumbnails/${FID}/pg_rt_${i}.png`).then(async (r) => ({
    status: r.status,
    json: r.status === 202 ? await r.json().catch(() => null) : null,
  })))
);
const statuses = burst.map((b) => b.status);
ok(statuses.every((s) => s === 200 || s === 202), `T5 burst answers only 200/202 (got ${statuses.join(',')})`);
ok(statuses.includes(202), `T5 overflow got 202 (got ${statuses.join(',')})`);
const a202 = burst.find((b) => b.status === 202);
ok(!a202 || a202.json?.pending === true, `T5 202 body is {pending:true} (got ${JSON.stringify(a202?.json)})`);

// ---- T6: a 202'd page succeeds on retry (client behavior) -----------------
const retryIdx = statuses.findIndex((s) => s === 202);
if (retryIdx >= 0) {
  await new Promise((r) => setTimeout(r, 2000));
  const rRetry = await get(`/api/v1/page-thumbnails/${FID}/pg_rt_${retryIdx + 1}.png`);
  ok(rRetry.status === 200, `T6 retry after 202 → 200 (got ${rRetry.status})`);
} else {
  ok(true, 'T6 skipped (no 202 in burst)');
}

// ---- cleanup --------------------------------------------------------------
const { closeBrowser } = await import('../../src/routes/pageThumbnails.js');
await closeBrowser();
await sql.end();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
