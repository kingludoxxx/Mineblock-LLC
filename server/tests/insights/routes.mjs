// ROUTE-SURFACE verification — drives the REAL /api/v1/funnel-insights router
// (real authenticate + requirePermission) against embedded PG, exactly like the
// metrics route harness it is modelled on.
//
// Proves BY EXECUTION, through the HTTP door rather than in the service:
//   · every endpoint is 401 without a token and 403 without funnels:access;
//   · a malformed / impossible / future day is a 422 with a MACHINE CODE the
//     client's error table can key on — never a 500 and never an empty strip;
//   · the CSV download carries attachment headers, is injection-guarded, and
//     REFUSES BEFORE it starts writing a file;
//   · /definitions serves the rule table the strip explains itself with;
//   · the shared read budget is per USER and covers BOTH analytics routers;
//   · routes/index.js still mounts the whole app with the new line.
//
// Run:  node server/tests/insights/routes.mjs
import postgres from 'postgres';
import express from 'express';
import jwt from 'jsonwebtoken';

const DB = 'postgres://puure@127.0.0.1:5433/puure_insights_routes';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = 'Europe/Madrid';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.METRICS_READ_LIMIT = '100000';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_insights_routes`;
await admin`CREATE DATABASE puure_insights_routes`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

// ── auth fixture ────────────────────────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_i','insights@local.test','I','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_i','insights-tester','{"funnels": ["access"]}')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_i','r_i')`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_none','none@local.test','N','P')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_none','no-perms','{}')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_none','r_none')`;

const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
await ensureCheckoutTables();
await ensureTrackingTables();
await ensureFunnelCostsTables();
await q(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT '',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

const { todayInTz, zonedDayStart } = await import('../../src/services/funnelMetrics.js');
const T0 = todayInTz();
const D = (n) => new Date(new Date(`${T0}T12:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
const at = (day, h) => new Date(zonedDayStart(day).getTime() + h * 3_600_000).toISOString();

// A CAMPAIGN NAMED AS A SPREADSHEET FORMULA. The campaign string lands in the
// cohort CSV's label column verbatim, and it is the most attacker-reachable
// value on this surface (it comes off a URL). This is the sink, so this is the
// fixture.
await q(`INSERT INTO funnels (id, slug, name, status) VALUES ('f1','alpha','Alpha funnel','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type) VALUES ('p1','f1','prod','product')`);
await q(
  `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, currency, customer, gateway, vid, paid_at, created_at)
   VALUES ('s1','f1','p1','paid',150,'USD',jsonb_build_object('email','a@x.com'),'whop','v1',$1,$1)`,
  [at(D(5), 10)]
);
await q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, url, utm, ts, expires_at)
   VALUES ('v1','f1','p1','https://a.com/lp',jsonb_build_object('utm_campaign','=cmd|calc!A1'),$1,NOW() + interval '90 days')`,
  [at(D(5), 9)]
);

const insightsRouter = (await import('../../src/routes/funnelInsights.js')).default;
const app = express();
app.use(express.json());
app.use('/api/v1/funnel-insights', insightsRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error', message: String(err?.message || err) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/funnel-insights`;

const tokenFor = (uid) => jwt.sign({ userId: uid }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${tokenFor('u_i')}`, 'Content-Type': 'application/json' };
const req = async (path, headers = H) => {
  const r = await fetch(`${B}${path}`, { method: 'GET', headers });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* CSV / non-JSON */ }
  return { status: r.status, j, text, headers: r.headers };
};

console.log(`\n== insight route surface ==  today=${T0}\n`);

// ═══ AUTH ═══════════════════════════════════════════════════════════════════
{
  for (const p of ['/insights', '/cohorts', '/cohorts.csv', '/definitions']) {
    const r = await req(p, { 'Content-Type': 'application/json' });
    ok(r.status === 401, `AUTH GET ${p} is 401 without a token`, r.status);
  }
  const noPerm = { Authorization: `Bearer ${tokenFor('u_none')}`, 'Content-Type': 'application/json' };
  for (const p of ['/insights', '/cohorts', '/cohorts.csv', '/definitions']) {
    const r = await req(p, noPerm);
    ok(r.status === 403, `AUTH GET ${p} is 403 without funnels:access`, r.status);
  }
}

// ═══ GET /insights ══════════════════════════════════════════════════════════
{
  const r = await req('/insights');
  ok(r.status === 200, 'I1 GET /insights answers 200', `${r.status} ${r.text.slice(0, 200)}`);
  ok(Array.isArray(r.j.insights), 'I2 …with an insights array');
  ok(r.j.day === T0, 'I3 …defaulting to today in REPORT_TZ', r.j.day);
  ok(r.j.timezone === 'Europe/Madrid', 'I4 …and naming the zone', r.j.timezone);
  ok(Array.isArray(r.j.detectors) && r.j.detectors.length === 6,
    'I5 …reporting all six detectors, fired or not');
  ok(r.j.last_60 && Array.isArray(r.j.last_60.series) && r.j.last_60.series.length === 60,
    'I6 …and a 60-bucket series for the last-60 card');
  ok(r.j.thresholds && r.j.thresholds.anomaly_min_baseline.value === 7,
    'I7 …with the thresholds the cards were judged by, on the payload');
  ok(Array.isArray(r.j.meta.warnings) && Array.isArray(r.j.meta.degraded),
    'I8 …and both disclosure channels present');

  const scoped = await req(`/insights?funnel_id=f1&day=${D(1)}`);
  ok(scoped.status === 200 && scoped.j.day === D(1), 'I9 an explicit day and scope are honoured', scoped.j?.day);

  for (const [qs, code] of [
    ['?day=nope', 'invalid_day'],
    ['?day=2026-02-30', 'invalid_day'],
    [`?day=${D(-1)}`, 'day_in_future'],
  ]) {
    const bad = await req(`/insights${qs}`);
    ok(bad.status === 422 && bad.j.error === code,
      `I10 GET /insights${qs} is 422 '${code}' — a refusal, never a 500 and never an empty strip`,
      `${bad.status} ${bad.text.slice(0, 120)}`);
  }
}

// ═══ GET /cohorts ═══════════════════════════════════════════════════════════
{
  const r = await req(`/cohorts?start=${D(10)}&end=${T0}`);
  ok(r.status === 200, 'C1 GET /cohorts answers 200', `${r.status} ${r.text.slice(0, 200)}`);
  ok(Array.isArray(r.j.cohorts) && r.j.average && Array.isArray(r.j.horizons),
    'C2 …with cohorts, horizons and the weighted average');
  ok(r.j.range.timezone === 'Europe/Madrid' && r.j.range.today === T0,
    'C3 …echoing the window, the zone and the aging clock');
  ok(typeof r.j.basis === 'string' && r.j.basis.length > 20,
    'C4 …and stating its basis in words, not just in a flag');
  ok(r.j.cohorts.length === 1 && r.j.cohorts[0].size === 1,
    'C5 the seeded buyer is one new acquisition', JSON.stringify(r.j.totals));

  const byCampaign = await req(`/cohorts?start=${D(10)}&end=${T0}&group_by=campaign`);
  ok(byCampaign.status === 200 && byCampaign.j.cohorts[0].key === '=cmd|calc!A1',
    'C6 group_by=campaign keys on the raw campaign — the hostile string is NOT rewritten on the wire',
    JSON.stringify(byCampaign.j?.cohorts?.[0]?.key));

  const horizons = await req(`/cohorts?start=${D(10)}&end=${T0}&horizons=0,3`);
  ok(horizons.status === 200 && JSON.stringify(horizons.j.horizons) === '[0,3]',
    'C7 explicit horizons are honoured', JSON.stringify(horizons.j?.horizons));

  for (const [qs, code] of [
    ['?start=nope', 'invalid_date_format'],
    ['?start=2026-02-30&end=2026-03-01', 'invalid_date'],
    [`?start=${T0}&end=${D(5)}`, 'to_before_from'],
    ['?start=2020-01-01&end=2026-01-01', 'window_too_large'],
    ['?group_by=zodiac', 'unknown_group_by'],
    ['?horizons=-1', 'bad_horizon'],
    ['?horizons=1,2,3,4,5,6,7,8,9', 'too_many_horizons'],
  ]) {
    const bad = await req(`/cohorts${qs}`);
    ok(bad.status === 422 && bad.j.error === code,
      `C8 GET /cohorts${qs} is 422 '${code}'`, `${bad.status} ${bad.text.slice(0, 120)}`);
  }
}

// ═══ GET /cohorts.csv ═══════════════════════════════════════════════════════
{
  const r = await req(`/cohorts.csv?start=${D(10)}&end=${T0}&group_by=campaign`);
  ok(r.status === 200, 'V1 GET /cohorts.csv answers 200', r.status);
  ok((r.headers.get('content-type') || '').includes('text/csv'), 'V2 …as text/csv', r.headers.get('content-type'));
  ok((r.headers.get('content-disposition') || '').includes('attachment; filename="cohorts_campaign_'),
    'V3 …with an attachment filename naming the grouping and the window', r.headers.get('content-disposition'));
  ok(r.headers.get('x-content-type-options') === 'nosniff', 'V4 …and nosniff');
  ok(r.text.startsWith('cohort,size,ltv_d0'), 'V5 …a real header row', r.text.slice(0, 60));
  // THE SINK. The campaign is '=cmd|calc!A1' and must arrive neutralised.
  ok(r.text.includes("'=cmd|calc!A1"),
    'V6 INJECTION the formula-shaped campaign is neutralised with a leading quote', r.text.slice(0, 200));
  ok(!r.text.split('\n').some((l) => /^=/.test(l)),
    'V7 INJECTION no CSV line begins with a formula character');

  // A refusal must arrive as JSON, NOT as a half-written download.
  const bad = await req('/cohorts.csv?group_by=zodiac');
  ok(bad.status === 422 && bad.j && bad.j.error === 'unknown_group_by',
    'V8 a rejected CSV request is a 422 JSON body', `${bad.status} ${bad.text.slice(0, 120)}`);
  ok(!(bad.headers.get('content-disposition') || '').includes('attachment'),
    'V8 …and the browser was NEVER told to save a file', bad.headers.get('content-disposition'));
}

// ═══ GET /definitions ═══════════════════════════════════════════════════════
{
  const r = await req('/definitions');
  ok(r.status === 200, 'D1 GET /definitions answers 200', r.status);
  ok(Array.isArray(r.j.rules) && r.j.rules.length === 6, 'D2 …serving all six rules');
  ok(Array.isArray(r.j.dropped) && r.j.dropped.length >= 2,
    'D3 …and what did NOT survive the port, with reasons');
  ok(r.j.thresholds && r.j.cohorts && r.j.timezone === 'Europe/Madrid',
    'D4 …plus the thresholds, the cohort caps and the zone');
  ok(r.j.rules.every((x) => x.floors.every((f) => Object.prototype.hasOwnProperty.call(r.j.thresholds, f))),
    'D5 every floor a rule names is a threshold the same payload publishes');
}

// ═══ THE SHARED READ BUDGET ═════════════════════════════════════════════════
{
  process.env.METRICS_READ_LIMIT = '3';
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await req('/definitions')).status);
  ok(codes.includes(429), `RL1 the limiter engages (${codes.join(',')})`);

  // THE SHARED BUCKET, PROVEN: the metrics router must see the SAME budget, or
  // one operator could spend 2× the ceiling through two doors that each
  // believed they were allowing the limit.
  const metricsRouter = (await import('../../src/routes/funnelMetrics.js')).default;
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/v1/funnel-metrics', metricsRouter);
  const s2 = app2.listen(0);
  const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/v1/funnel-metrics/definitions`, { headers: H });
  ok(r2.status === 429,
    'RL2 …and the metrics router is ALREADY over budget — one engine, one per-user budget', r2.status);
  s2.close();

  const other = await req('/definitions', { Authorization: `Bearer ${tokenFor('u_none')}`, 'Content-Type': 'application/json' });
  ok(other.status === 403, 'RL3 the limit is per-user — another operator is not collateral', other.status);
  process.env.METRICS_READ_LIMIT = '100000';
}

// ═══ APP BOOT ═══════════════════════════════════════════════════════════════
{
  const mountRoutes = (await import('../../src/routes/index.js')).default;
  const probe = express();
  probe.use(express.json());
  let booted = true;
  let bootErr = '';
  try { mountRoutes(probe); } catch (e) { booted = false; bootErr = String(e?.message || e); }
  ok(booted, 'BOOT routes/index.js mounts the FULL app with the new line (no dangling import)', bootErr);
  const probeServer = probe.listen(0);
  const base = `http://127.0.0.1:${probeServer.address().port}`;
  const mounted = await fetch(`${base}/api/v1/funnel-insights/definitions`);
  const absent = await fetch(`${base}/api/v1/funnel-insights-nope/definitions`);
  const sibling = await fetch(`${base}/api/v1/funnel-metrics/definitions`);
  ok(mounted.status === 401, 'BOOT …/api/v1/funnel-insights is reachable through the real mount (401, not 404)', mounted.status);
  ok(absent.status === 404, 'BOOT …while an unmounted sibling path 404s (the probe can tell the difference)', absent.status);
  ok(sibling.status === 401, 'BOOT …and the pre-existing metrics mount is untouched', sibling.status);
  probeServer.close();
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
server.close();
await sql.end();
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');
await closeAnalyticsPool().catch(() => {});
process.exit(fail ? 1 : 0);
