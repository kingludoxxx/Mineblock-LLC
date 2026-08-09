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
// The harness makes far more reads than a human ever would; the limiter's own
// behaviour is exercised in its dedicated block below by lowering this.
process.env.METRICS_READ_LIMIT = '100000';

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

// A funnel whose ID is a SPREADSHEET FORMULA — hostile in the one column that
// becomes a CSV cell verbatim (`key`), while its `name` is ordinary. That
// exercises the CSV guard AND the funnels.name join in the same row, and pins
// that the join keys on the ID rather than on the display string.
await q(`INSERT INTO funnels (id, slug, name, status) VALUES ('=cmd|calc!A1','alpha','Alpha','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type) VALUES ('p1','=cmd|calc!A1','checkout','checkout')`);
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
  for (const [m, p] of [['POST', '/query'], ['GET', '/dashboard'], ['GET', '/band'], ['GET', '/presets'], ['GET', '/definitions'], ['GET', '/query.csv?q=%7B%7D']]) {
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

// ═══ GET /band — the 15s repoll target ══════════════════════════════════════
{
  const r = await req('GET', '/band');
  ok(r.status === 200, 'BND1 answers 200', `${r.status} ${r.text.slice(0, 200)}`);
  for (const k of ['live', 'unique_today', 'today', 'yesterday', 'timezone', 'meta']) {
    ok(Object.prototype.hasOwnProperty.call(r.j, k), `BND2 ships '${k}'`);
  }
  for (const k of ['day', 'orders', 'revenue', 'spend', 'net']) {
    ok(Object.prototype.hasOwnProperty.call(r.j.today, k), `BND3 today block ships '${k}'`);
  }
  ok(r.j.timezone === 'Europe/Madrid', 'BND4 names the reporting timezone', r.j.timezone);
  ok(r.j.today.spend === null || typeof r.j.today.spend === 'number',
    'BND5 spend is a number or NULL — never a fabricated 0', r.j.today.spend);

  // The dashboard must serve the IDENTICAL block through the same door, or the
  // first paint and the poll disagree on screen.
  const d = await req('GET', `/dashboard?start=${W.start_day}&end=${W.end_day}`);
  ok(JSON.stringify(d.j.band.today) === JSON.stringify(r.j.today)
    && JSON.stringify(d.j.band.yesterday) === JSON.stringify(r.j.yesterday),
  'BND6 the dashboard band is byte-identical to GET /band over HTTP',
  `${JSON.stringify(d.j.band.today)} vs ${JSON.stringify(r.j.today)}`);
  ok(typeof d.j.band.in_window === 'boolean', 'BND7 …plus in_window on the composite');

  // Cheapness is the point of the route existing at all.
  ok(r.j.meta.computed_ms <= d.j.meta.computed_ms,
    `BND8 the band is cheaper than the composite it replaces (${r.j.meta.computed_ms}ms vs ${d.j.meta.computed_ms}ms)`);
  const scoped = await req('GET', '/band?funnel_id=%3Dcmd%7Ccalc%21A1');
  ok(scoped.status === 200, 'BND9 funnel scoping works (hostile id is a bound parameter)', scoped.status);
  const noAuth = await fetch(`${B}/band`);
  ok(noAuth.status === 401, 'BND10 …and it is authed like its siblings', noAuth.status);
}

// ═══ SECOND-BATCH WIRE KEYS, over HTTP ══════════════════════════════════════
{
  // basis_label follows the metric actually folded
  const net = await req('POST', '/query', { metrics: ['net_sales'], dimension: 'funnel', window: W });
  ok(net.j.meta.basis_label.startsWith('Net sales') && !/gross sales/i.test(net.j.meta.basis_label),
    'WK1 a net_sales breakdown does not say "Gross sales"', net.j.meta.basis_label);
  ok(net.j.meta.basis_metric === 'net_sales', 'WK2 basis_metric names the figure');
  // funnel rows carry name; key stays the id
  const row = net.j.rows.find((x) => x.key === '=cmd|calc!A1');
  ok(row && row.name === 'Alpha' && row.key === '=cmd|calc!A1',
    'WK3 funnel rows carry name while key stays the funnel id', JSON.stringify(row && { k: row.key, n: row.name }));
  // scalar total + rows_total
  ok(typeof net.j.meta.total === 'number' && net.j.meta.total_metric === 'net_sales'
    && typeof net.j.meta.rows_total === 'number',
  'WK4 breakdowns carry a scalar total + total_metric + rows_total');
  // sessions_unknown on the wire
  ok(typeof net.j.meta.sessions_unknown === 'boolean', 'WK5 meta.sessions_unknown is on the wire', net.j.meta.sessions_unknown);
  // warnings all carry a string reason
  const all = [net, await req('POST', '/query', { metrics: ['orders'], dimension: 'product', window: W })]
    .flatMap((x) => x.j.meta.warnings);
  ok(all.every((w) => typeof w.reason === 'string' && w.reason.length > 0
    && typeof w.source === 'string' && w.source.length > 0),
  'WK6 every warning over HTTP carries string source + reason', JSON.stringify(all));
  // future buckets are null
  const fwd = new Date(new Date(`${T0}T12:00:00Z`).getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const fut = await req('POST', '/query', { metrics: ['orders', 'net_sales'], window: { start_day: T0, end_day: fwd } });
  const ahead = fut.j.series.filter((p) => p.key > T0);
  ok(ahead.length === 2 && ahead.every((p) => p.future === true && p.orders === null && p.net_sales === null),
    'WK7 unstarted report-days serialise as null, not 0', JSON.stringify(ahead));
  ok(fut.j.series.find((p) => p.key === T0).future === false, 'WK8 today is not future');
  // composite blocks
  const d = await req('GET', `/dashboard?start=${W.start_day}&end=${W.end_day}`);
  ok(Object.values(d.j.breakdown_summary).every((s) => typeof s.rows_total === 'number'
    && s.total_metric && (s.total === null || typeof s.total === 'number')),
  'WK9 every composite breakdown ships total + total_metric + rows_total');
  ok(d.j.breakdown_summary.funnels.rows.every((x) => 'name' in x), 'WK10 composite funnel rows carry name');
  ok(typeof d.j.meta.sessions_unknown === 'boolean', 'WK11 the dashboard surfaces sessions_unknown');
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

// ═══ ADVERSARIAL-REVIEW FIXES, over HTTP ════════════════════════════════════
{
  // BLOCKER 1 — a corrupt line_items row must be a 200 with a warning, not a 500.
  await q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, total, currency, customer, gateway, vid, refunds, paid_at, created_at)
     VALUES ('bad1','=cmd|calc!A1','p1','paid','"garbage"'::jsonb,90,'USD',$1,'whop','v9','[]'::jsonb,$2,$2)`,
    [{ email: 'bad@x.com', shipping: { country: 'ES' } }, at(D(1), 12)]
  );
  const r = await req('POST', '/query', { metrics: ['net_sales', 'cogs', 'net_after_cogs'], window: W });
  ok(r.status === 200, 'FX1 a corrupt line_items row returns 200, not 500', `${r.status} ${r.text.slice(0, 160)}`);
  ok(r.j.meta.warnings.some((w) => w.source === 'malformed_line_items'),
    'FX2 …with malformed_line_items named in the warnings',
    JSON.stringify(r.j.meta.warnings.map((w) => w.source)));
  const d = await req('GET', `/dashboard?start=${W.start_day}&end=${W.end_day}`);
  ok(d.status === 200 && d.j.meta.warnings.some((w) => w.source === 'malformed_line_items'),
    'FX3 …and the dashboard survives it too, with the same disclosure', d.status);
  const b = await req('GET', '/band');
  ok(b.status === 200, 'FX4 …and so does the band (the row is inside its 48h window)', b.status);

  // BLOCKER 2 — withheld ratios over the wire.
  const gw = await req('POST', '/query', {
    metrics: ['orders', 'sessions', 'conv_pct'],
    filters: { gateway: 'whop' }, window: W,
  });
  ok(gw.j.totals.conv_pct === null && gw.j.totals.sessions === null,
    'FX5 a gateway filter withholds conv_pct and sessions', JSON.stringify(gw.j.totals));
  ok(gw.j.meta.withheld?.conv_pct?.includes('gateway'), 'FX6 …and meta.withheld names why', JSON.stringify(gw.j.meta.withheld));
  ok(gw.j.totals.orders !== null, 'FX7 …while the fold the filter CAN narrow still answers');

  // BLOCKER 3 / #10 / #5-7 — wire keys.
  ok(typeof r.j.meta.currency === 'string' || r.j.meta.currency === null, 'FX8 meta.currency is published');
  ok(typeof r.j.meta.mixed_currency === 'boolean', 'FX9 meta.mixed_currency is published');
  ok(r.j.meta.reconciliation?.notes?.length === 3, 'FX10 meta.reconciliation names all three divergences');
  ok(Array.isArray(r.j.meta.reconciliation.utc_surfaces), 'FX11 …and the surfaces still on UTC');
  ok(b.j.meta.window?.timezone === 'Europe/Madrid' && b.j.meta.window.days === 2,
    'FX12 /band ships meta.window like its siblings', JSON.stringify(b.j.meta?.window));
  ok(b.j.meta.reconciliation?.notes?.length === 3, 'FX13 …and the reconciliation block');

  // BLOCKER 4 — the shipped preset's footer, verbatim, through the door.
  const pres = await req('GET', '/presets');
  const sbp = pres.j.presets.find((p) => p.id === 'sales_by_product');
  const prodRes = await req('POST', '/query', sbp.query);
  ok(prodRes.status === 200 && prodRes.j.meta.total_metric === 'gross_sales',
    'FX14 sales_by_product footers on a CURRENCY metric', prodRes.j.meta?.total_metric);
  ok(prodRes.j.meta.total > 0, 'FX15 …and the scalar is real money, not 0', prodRes.j.meta?.total);

  // #12 — /presets validates BOTH params through the real window validator.
  const badEnd = await req('GET', '/presets?end=nope');
  ok(badEnd.status === 422 && badEnd.j?.error === 'invalid_date_format',
    'FX16 /presets refuses a malformed end (422, not 500)', `${badEnd.status} ${badEnd.j?.error}`);
  const badRange = await req('GET', `/presets?start=${D(400)}&end=${D(0)}`);
  ok(badRange.status === 422 && badRange.j?.error === 'window_too_large',
    'FX17 …and a window past the cap', `${badRange.status} ${badRange.j?.error}`);
  const goodPresets = await req('GET', `/presets?start=${D(3)}&end=${D(0)}`);
  let unpostable = 0;
  for (const p of goodPresets.j.presets) {
    const x = await req('POST', '/query', p.query);
    if (x.status !== 200) unpostable += 1;
  }
  ok(unpostable === 0, 'FX18 …so every EMITTED preset is still POSTable', `${unpostable} failed`);

  // #14 — honest metric labels on /definitions
  const defs = await req('GET', '/definitions');
  const nc = defs.j.metrics.find((m) => m.id === 'new_customers');
  ok(nc.label === 'Orders from new customers', 'FX19 new_customers is labelled as ORDERS, not people', nc.label);
  ok(defs.j.reconciliation?.notes?.length === 3, 'FX20 /definitions carries the reconciliation block too');

  // The 18-column funnel table, over HTTP.
  const cols = ['sessions', 'orders', 'conv_pct', 'gross_sales', 'net_sales', 'aov', 'rev_per_session',
    'refunds', 'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
    'spend', 'net_profit', 'roas', 'cpa'];
  const frow = d.j.breakdown_summary.funnels.rows[0];
  ok(cols.every((c) => c in frow), 'FX21 the dashboard funnel table ships all 18 columns',
    cols.filter((c) => !(c in frow)).join(','));
  ok('name' in frow && 'spend_known' in frow, 'FX22 …plus name and spend_known');

  await q(`DELETE FROM co_sessions WHERE id = 'bad1'`);
}

// ═══ #19 — RATE LIMIT ═══════════════════════════════════════════════════════
{
  process.env.METRICS_READ_LIMIT = '3';
  // A fresh user so the earlier blocks' requests are not in this budget.
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_rl','rl@local.test','R','L')`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_rl','r_m')`;
  const H2 = { Authorization: `Bearer ${tokenFor('u_rl')}`, 'Content-Type': 'application/json' };
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const x = await req('GET', '/definitions', undefined, H2);
    codes.push(x.status);
  }
  ok(codes.slice(0, 3).every((c) => c === 200), 'RL1 the first three reads are allowed', codes.join(','));
  ok(codes.slice(3).every((c) => c === 429), 'RL2 …and the rest are 429', codes.join(','));
  const last = await req('GET', '/definitions', undefined, H2);
  ok(last.j?.error === 'rate_limited' && typeof last.j.retry_after === 'number',
    'RL3 the refusal is a named JSON error with a retry hint', JSON.stringify(last.j));
  // Per USER, not global: a different operator is unaffected. Uses a THIRD
  // fresh user — the default harness user has already spent a few hundred
  // reads in the blocks above, so it is not a valid control.
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_rl2','rl2@local.test','R','L')`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_rl2','r_m')`;
  const H3 = { Authorization: `Bearer ${tokenFor('u_rl2')}`, 'Content-Type': 'application/json' };
  const other = await req('GET', '/definitions', undefined, H3);
  ok(other.status === 200, 'RL4 the limit is per-user — another operator is not collateral', other.status);
  process.env.METRICS_READ_LIMIT = '100000';
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
