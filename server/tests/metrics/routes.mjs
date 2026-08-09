// ROUTE-SURFACE verification — drives the REAL /api/v1/funnel-metrics router
// (real authenticate + requirePermission) against embedded PG, exactly like
// the costs route harness.
//
// Proves by execution: unauthenticated requests are 401; every endpoint in the
// work-order table answers; an illegal metric × dimension is 422 THROUGH THE
// HTTP DOOR (not just in the service); the CSV download is injection-guarded
// and carries attachment headers; EVERY preset POSTs to /query without a 422;
// and routes/index.js still mounts the whole app (a dangling import here would
// take the server down at boot, not at request time).
//
// Run:  node server/tests/metrics/routes.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_metrics_routes';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = 'Europe/Madrid';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_metrics_routes`;
await admin`CREATE DATABASE puure_metrics_routes`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

// ── auth fixture: minimal users/roles + one funnels:access user ─────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_m','metrics@local.test','M','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_m','metrics-tester','{"funnels": ["access"]}')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_m','r_m')`;
// A user with NO permissions at all — proves the gate is a gate.
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

const { todayInTz, zonedDayStart, reportPresets } = await import('../../src/services/funnelMetrics.js');
const T0 = todayInTz();
const D = (n) => new Date(new Date(`${T0}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
const at = (day, h) => new Date(zonedDayStart(day).getTime() + h * 3600000).toISOString();

// A funnel name carrying a SPREADSHEET FORMULA — the CSV guard's real target.
await q(`INSERT INTO funnels (id, slug, name, status) VALUES ('f1','alpha','Alpha','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type) VALUES ('p1','f1','checkout','checkout')`);
await q(
  `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, total, currency, customer, gateway, vid, refunds, paid_at, created_at)
   VALUES ('s1','=cmd|calc!A1','p1','paid',$1,150,'USD',$2,'whop','v1','[]'::jsonb,$3,$3)`,
  [[{ variant_id: 'v_a', quantity: 1, price: 150 }], { email: 'a@x.com', shipping: { country: 'ES' } }, at(D(1), 10)]
);
await q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, ts, expires_at)
   VALUES ('v1','=cmd|calc!A1','p1','https://a.com/lp',NULL,$1,$2,NOW() + interval '90 days')`,
  [{ utm_source: 'meta' }, at(D(1), 9)]
);

import express from 'express';
import jwt from 'jsonwebtoken';

const metricsRouter = (await import('../../src/routes/funnelMetrics.js')).default;
const app = express();
app.use(express.json());
app.use('/api/v1/funnel-metrics', metricsRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error', message: String(err?.message || err) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/funnel-metrics`;

const tokenFor = (uid) => jwt.sign({ userId: uid }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${tokenFor('u_m')}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* CSV / non-JSON */ }
  return { status: r.status, j, text, headers: r.headers };
};

const W = { start_day: D(3), end_day: D(0) };

// ═══ AUTH ═══════════════════════════════════════════════════════════════════
{
  for (const [m, p] of [['POST', '/query'], ['GET', '/dashboard'], ['GET', '/presets'], ['GET', '/definitions'], ['GET', '/query.csv?q=%7B%7D']]) {
    const r = await req(m, p, m === 'POST' ? { metrics: ['orders'], window: W } : undefined, { 'Content-Type': 'application/json' });
    ok(r.status === 401, `AUTH ${m} ${p.split('?')[0]} is 401 without a token`, r.status);
  }
  const noPerm = { Authorization: `Bearer ${tokenFor('u_none')}`, 'Content-Type': 'application/json' };
  const r = await req('POST', '/query', { metrics: ['orders'], window: W }, noPerm);
  ok(r.status === 403, 'AUTH a token WITHOUT funnels:access is 403, not 200', r.status);
}

// ═══ POST /query ════════════════════════════════════════════════════════════
{
  const r = await req('POST', '/query', { metrics: ['orders', 'gross_sales', 'net_sales'], window: W });
  ok(r.status === 200, 'Q1 POST /query answers 200', `${r.status} ${r.text.slice(0, 200)}`);
  ok(Array.isArray(r.j.series) && r.j.totals, 'Q2 …with a series and totals');
  ok(r.j.totals.orders === 1 && r.j.totals.gross_sales === 150, 'Q3 …carrying the seeded money', JSON.stringify(r.j.totals));
  ok(r.j.meta.timezone === 'Europe/Madrid', 'Q4 …and meta.timezone', r.j.meta.timezone);
  ok(typeof r.j.meta.computed_ms === 'number' && typeof r.j.meta.rows_scanned === 'number',
    'Q5 …and computed_ms + rows_scanned');

  const b = await req('POST', '/query', { metrics: ['orders', 'net_sales'], dimension: 'funnel', window: W, compare: true });
  ok(b.status === 200 && Array.isArray(b.j.rows) && b.j.previous, 'Q6 a breakdown with compare answers rows + previous');
  ok(b.j.meta.basis === 'gross' && b.j.meta.basis_label.length > 10, 'Q7 …naming its basis', b.j.meta.basis);

  // Legality, THROUGH THE HTTP DOOR
  const illegal = [
    [{ metrics: ['spend'], dimension: 'country', window: W }, 'illegal_metric_for_dimension'],
    [{ metrics: ['pageviews'], dimension: 'country', window: W }, 'illegal_metric_for_dimension'],
    [{ metrics: ['sessions'], dimension: 'device', window: W }, 'dimension_unavailable'],
    [{ metrics: ['nope'], window: W }, 'unknown_metric'],
    [{ metrics: ['orders'], window: { start_day: 'x', end_day: D(0) } }, 'invalid_date_format'],
    [{ metrics: ['orders'], window: { start_day: D(400), end_day: D(0) } }, 'window_too_large'],
    [{ metrics: ['orders'], window: W, granularity: 'hour' }, 'hour_requires_single_day'],
  ];
  for (const [body, code] of illegal) {
    const x = await req('POST', '/query', body);
    ok(x.status === 422 && x.j?.error === code, `Q8 422 ${code}`, `${x.status} ${x.j?.error}`);
  }
  const dev = await req('POST', '/query', { metrics: ['sessions'], dimension: 'device', window: W });
  ok(dev.j.detail?.reason === 'device_not_collected', 'Q9 the unavailable dimension explains ITSELF, not just "no"', JSON.stringify(dev.j.detail));
  const empty = await req('POST', '/query', {});
  ok(empty.status === 422, 'Q10 an empty body is 422, never a 500', empty.status);
  const junk = await req('POST', '/query', [1, 2, 3]);
  ok(junk.status === 422, 'Q11 a non-object body is 422, never a 500', junk.status);
}

// ═══ GET /query.csv ═════════════════════════════════════════════════════════
{
  const body = { metrics: ['orders', 'net_sales'], dimension: 'funnel', window: W };
  const r = await req('GET', `/query.csv?q=${encodeURIComponent(JSON.stringify(body))}`);
  ok(r.status === 200, 'CSV1 answers 200', r.status);
  ok((r.headers.get('content-type') || '').startsWith('text/csv'), 'CSV2 content-type is text/csv', r.headers.get('content-type'));
  ok((r.headers.get('content-disposition') || '').includes('attachment'), 'CSV3 …as an attachment');
  ok((r.headers.get('x-content-type-options') || '') === 'nosniff', 'CSV4 …with nosniff');
  ok(r.text.split('\n')[0] === 'key,label,orders,net_sales', 'CSV5 header row', r.text.split('\n')[0]);
  // The funnel id IS a formula. It must arrive quoted-and-neutralised.
  // The apostrophe is the neutralisation; the quoting only kicks in for
  // characters CSV itself needs escaped, and this string has none of them.
  ok(r.text.includes(`'=cmd|calc!A1`), 'CSV6 an attacker-supplied formula is neutralised in the download', r.text.split('\n')[1]);
  ok(!/^=/m.test(r.text), 'CSV7 …and no line begins with a bare formula prefix');
  ok(r.text.includes('totals,'), 'CSV8 a totals row is present');

  const bad = await req('GET', '/query.csv?q=notjson');
  ok(bad.status === 422 && bad.j?.error === 'bad_q', 'CSV9 malformed q is 422 JSON, not a half-written download', `${bad.status} ${bad.j?.error}`);
  const illegal = await req('GET', `/query.csv?q=${encodeURIComponent(JSON.stringify({ metrics: ['spend'], dimension: 'country', window: W }))}`);
  ok(illegal.status === 422 && illegal.j?.error === 'illegal_metric_for_dimension',
    'CSV10 the CSV door enforces the SAME legality as the JSON one', `${illegal.status} ${illegal.j?.error}`);
  ok(!(illegal.headers.get('content-type') || '').startsWith('text/csv'),
    'CSV11 …and a refusal is never sent with CSV headers');
  const huge = await req('GET', `/query.csv?q=${'a'.repeat(9000)}`);
  ok(huge.status === 422, 'CSV12 an oversized q is refused', huge.status);
}

// ═══ GET /dashboard ═════════════════════════════════════════════════════════
{
  const r = await req('GET', `/dashboard?start=${D(3)}&end=${D(0)}`);
  ok(r.status === 200, 'DASH1 answers 200', `${r.status} ${r.text.slice(0, 300)}`);
  for (const k of ['band', 'kpis', 'series', 'prev_series', 'breakdown_summary', 'waterfall', 'movers', 'window', 'meta']) {
    ok(Object.prototype.hasOwnProperty.call(r.j, k), `DASH2 ships '${k}'`);
  }
  ok(r.j.window.timezone === 'Europe/Madrid', 'DASH3 window names the reporting timezone', r.j.window.timezone);
  ok(r.j.kpis.upsell_lines, 'DASH4 kpis carry the upsell_lines block');
  ok(Object.values(r.j.breakdown_summary).every((b) => b.basis && b.basis_label),
    'DASH5 every breakdown in the composite names its basis');
  const def = await req('GET', '/dashboard');
  ok(def.status === 200 && def.j.window.days === 30, 'DASH6 the default window is the last 30 REPORT_TZ days', def.j.window?.days);
  const badWin = await req('GET', `/dashboard?start=nope&end=${D(0)}`);
  ok(badWin.status === 422, 'DASH7 a malformed window is 422, never a 500', badWin.status);
  const scoped = await req('GET', `/dashboard?start=${D(3)}&end=${D(0)}&funnel_id=%3Dcmd%7Ccalc%21A1`);
  ok(scoped.status === 200 && scoped.j.kpis.orders === 1, 'DASH8 funnel scoping works (and a hostile id is just a bound parameter)', scoped.j.kpis?.orders);
}

// ═══ GET /presets — EVERY preset must survive the HTTP door ═════════════════
{
  const r = await req('GET', '/presets');
  ok(r.status === 200 && r.j.count === 16, 'PR1 /presets answers 16 reports', r.j?.count);
  ok(Array.isArray(r.j.unservable) && r.j.unservable.length === 4,
    'PR2 …and NAMES the four reference reports that did not survive the port', r.j?.unservable?.length);
  ok(r.j.unservable.every((u) => u.id && u.reason), 'PR3 …each with a reason, not just an absence');
  let bad = 0;
  for (const p of r.j.presets) {
    const x = await req('POST', '/query', p.query);
    if (x.status !== 200) { bad += 1; console.log('  preset failed:', p.id, x.status, x.j?.error); }
  }
  ok(bad === 0, 'PR4 EVERY preset POSTs to /query and answers 200 — none 422s', `${bad} failed`);
  const csvOne = await req('GET', `/query.csv?q=${encodeURIComponent(JSON.stringify(r.j.presets[0].query))}`);
  ok(csvOne.status === 200, 'PR5 a preset also downloads as CSV verbatim', csvOne.status);
}

// ═══ GET /definitions — the contract the client intersects against ══════════
{
  const r = await req('GET', '/definitions');
  ok(r.status === 200, 'DEF1 answers 200', r.status);
  for (const k of ['metrics', 'dimensions', 'dim_metrics', 'hour_only_exclusions', 'max_window_days', 'timezone']) {
    ok(Object.prototype.hasOwnProperty.call(r.j, k), `DEF2 ships '${k}'`);
  }
  ok(r.j.metrics.length === 26, 'DEF3 publishes all 26 v1 metrics', r.j.metrics?.length);
  ok(r.j.dimensions.length === 10, 'DEF4 publishes all 10 registered dimensions', r.j.dimensions?.length);
  const dev = r.j.dimensions.find((d) => d.id === 'device');
  ok(dev.unavailable === true && dev.legal_metrics.length === 0,
    'DEF5 device is REGISTERED and flagged unavailable — listed, never silently dropped');
  const country = r.j.dimensions.find((d) => d.id === 'country');
  ok(country.report_label === 'Sales by country' && !country.legal_metrics.includes('pageviews'),
    'DEF6 country is "Sales by country" and refuses pageviews', country.report_label);
  ok(r.j.dimensions.every((d) => d.basis && d.basis_label), 'DEF7 every dimension ships basis + label');
  ok(r.j.timezone === 'Europe/Madrid' && r.j.max_window_days === 400, 'DEF8 timezone + window cap published');
  ok(Object.prototype.hasOwnProperty.call(r.j.dim_metrics, '__timeseries__'),
    'DEF9 the matrix includes the no-dimension case a client also has to intersect');

  // The served matrix must BE the engine's, not a copy that can drift — that
  // drift is the exact bug this endpoint exists to make impossible.
  const eng = await import('../../src/services/funnelMetrics.js');
  const sorted = (x) => [...x].sort().join(',');
  ok(r.j.dimensions.every((d) => sorted(eng.DIM_METRICS[d.id]) === sorted(d.legal_metrics)),
    'DEF10 dimensions[].legal_metrics IS the engine\'s matrix');
  ok(Object.entries(r.j.dim_metrics).every(([k, v]) => sorted(eng.DIM_METRICS[k]) === sorted(v)),
    'DEF11 dim_metrics IS the engine\'s matrix, key for key');
  ok(sorted(r.j.hour_only_exclusions) === sorted(eng.HOUR_ONLY_EXCLUSIONS),
    'DEF12 hour_only_exclusions IS the engine\'s list');

  // …and the SERVER really refuses what the document says it refuses. Serving
  // an accurate matrix that the validator disagrees with would be the same bug
  // wearing a badge.
  const oneDay = { start_day: D(1), end_day: D(1) };
  let refused = 0;
  for (const m of r.j.hour_only_exclusions) {
    const x = await req('POST', '/query', { metrics: [m], window: oneDay, granularity: 'hour' });
    if (x.status === 422 && x.j?.error === 'metric_not_available_hourly') refused += 1;
  }
  ok(refused === r.j.hour_only_exclusions.length,
    'DEF13 the server REFUSES every metric the document says is day-only', `${refused}/${r.j.hour_only_exclusions.length}`);
  const withDim = await req('POST', '/query', { metrics: ['spend'], dimension: 'funnel', window: oneDay, granularity: 'hour' });
  ok(withDim.status === 422 && withDim.j?.error === 'metric_not_available_hourly',
    'DEF14 …regardless of dimension (the case a mirroring client gets wrong)', `${withDim.status} ${withDim.j?.error}`);
  ok(Array.isArray(withDim.j.detail?.hour_only_exclusions),
    'DEF15 …and the refusal hands back the list, so a stale client can self-correct');

  // A metric the document says IS hourly-legal must actually be served.
  const legalHourly = await req('POST', '/query', { metrics: ['orders', 'gross_sales'], window: oneDay, granularity: 'hour' });
  ok(legalHourly.status === 200, 'DEF16 an hourly-legal list is still served hourly', legalHourly.status);
}

// ═══ CONTRACT — the payload keys the client is coded against ════════════════
{
  const r = await req('POST', '/query', { metrics: ['orders', 'net_sales'], window: W, compare: true });
  ok(Array.isArray(r.j.previous?.series) && r.j.prev_series === undefined,
    'CT1 /query compare ships previous.series (prev_series is the dashboard key only)');
  ok(r.j.meta.window.start === W.start_day && r.j.meta.window.end === W.end_day
    && r.j.meta.window.timezone === 'Europe/Madrid',
  'CT2 every response echoes {start,end,timezone}', JSON.stringify(r.j.meta.window));
  const b = await req('POST', '/query', { metrics: ['net_sales'], dimension: 'gateway', window: W, limit: 1 });
  ok(b.j.rows.length === 1 && typeof b.j.meta.rows_total === 'number',
    'CT3 limit honoured with rows_total for the Top-N-of-M footer', `${b.j.rows.length}/${b.j.meta.rows_total}`);
  ok(typeof b.j.meta.basis_label === 'string' && b.j.meta.basis_label.length > 10,
    'CT4 basis_label on every breakdown response');
  const d = await req('GET', `/dashboard?start=${W.start_day}&end=${W.end_day}`);
  ok(Array.isArray(d.j.prev_series) && d.j.previous === undefined,
    'CT5 the dashboard ships prev_series (flat) — documented, and different on purpose');
  ok(d.j.meta.window.timezone === 'Europe/Madrid', 'CT6 the dashboard carries the same meta.window echo');
  ok(Object.values(d.j.breakdown_summary).every((s) => typeof s.rows_total === 'number'),
    'CT7 every composite breakdown ships rows_total');
}

// ═══ APP BOOT — the one mount line must not break the whole server ══════════
{
  const mountRoutes = (await import('../../src/routes/index.js')).default;
  const probe = express();
  probe.use(express.json());
  let booted = true;
  let bootErr = '';
  try { mountRoutes(probe); } catch (e) { booted = false; bootErr = String(e?.message || e); }
  ok(booted, 'BOOT routes/index.js mounts the FULL app with the new route (no dangling import)', bootErr);
  // Prove the mount by USING it, not by reading Express internals (which moved
  // between major versions): an unmounted path 404s, a mounted authed one 401s.
  const probeServer = probe.listen(0);
  const base = `http://127.0.0.1:${probeServer.address().port}`;
  const mounted = await fetch(`${base}/api/v1/funnel-metrics/definitions`);
  const absent = await fetch(`${base}/api/v1/funnel-metrics-nope/definitions`);
  ok(mounted.status === 401, 'BOOT …and /api/v1/funnel-metrics is reachable through the real mount (401, not 404)', mounted.status);
  ok(absent.status === 404, 'BOOT …while an unmounted sibling path 404s (the probe can tell the difference)', absent.status);
  probeServer.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await sql.end();
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');
await closeAnalyticsPool().catch(() => {});
process.exit(fail ? 1 : 0);
