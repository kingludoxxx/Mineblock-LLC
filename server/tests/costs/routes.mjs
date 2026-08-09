// ROUTE-SURFACE verification — drives the REAL /api/v1/funnel-costs router
// (real authenticate + requirePermission + ensure-on-demand + spend ticker)
// against embedded PG, exactly like the tracking admin-crud harness.
//
// Proves by execution: unauthenticated requests are 401; every endpoint in
// the work-order table answers; a blank COGS arrives at the DB as NULL
// (never coerced 0) through the HTTP door; malformed writes are 4xx with
// {success:false, error:{code}}; PATCH /variants only accepts operator
// fields; the P&L endpoints withhold gp at zero coverage; the spend
// endpoints (status / background sync via mock Meta / campaign-map pin /
// manual spend) round-trip.
//
// Run:  node server/tests/costs/routes.mjs
import http from 'http';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_costs_routes';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.META_ACCESS_TOKEN = 'TEST_META_TOKEN_ROUTES';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_costs_routes`;
await admin`CREATE DATABASE puure_costs_routes`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// ── day helpers — REPORT-TZ calendar, the one the engine buckets in ─────────
// (a UTC slice here disagrees with the engine 22:00-24:00 UTC every day)
import { reportDaysAgo, reportDayStartIso } from '../../src/services/reportTz.js';
const day = (n) => reportDaysAgo(n); // n days ago as a report-day key
// An instant safely inside report-day day(n): 10h after report-tz midnight.
const dayInstant = (n) => new Date(Date.parse(reportDayStartIso(day(n))) + 10 * 3600e3).toISOString();

// ── mock Meta Graph (background sync target) ────────────────────────────────
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/me/adaccounts')) {
    return res.end(JSON.stringify({ data: [{ id: 'act_9', account_id: '9', name: 'A' }] }));
  }
  if (req.url.startsWith('/act_9/insights')) {
    return res.end(JSON.stringify({ data: [
      { campaign_id: 'CR1', campaign_name: 'Routes Camp', spend: '77.70', date_start: day(1), date_stop: day(1) },
    ] }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.META_GRAPH_OVERRIDE_URL = `http://127.0.0.1:${mock.address().port}`;

// ── seed auth: minimal users/roles + a funnels:access user ──────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_cost', 'costs@local.test', 'Cost', 'Tester')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_cost', 'costs-tester', '{"funnels": ["access"]}')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_cost', 'r_cost')`;

import express from 'express';
import jwt from 'jsonwebtoken';
const funnelCostsRouter = (await import('../../src/routes/funnelCosts.js')).default;
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
await ensureCheckoutTables();
await ensureTrackingTables();

const app = express();
app.use(express.json());
app.use('/api/v1/funnel-costs', funnelCostsRouter);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/funnel-costs`;
const token = jwt.sign({ userId: 'u_cost' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

const V1 = '555555555555';
const V2 = '666666666666';

// seed money: f_r1 sells V1 (2 sessions), f_r2 sells V2, all inside 7d
const mkSess = (id, fid, n, lines, total, refunds = []) => sql`
  INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
  VALUES (${id}, ${fid}, 'paid', ${sql.json(lines)}, ${total}, ${sql.json(refunds)},
          ${dayInstant(n)},
          ${dayInstant(n)})`;
await mkSess('rt_1', 'f_r1', 1, [{ variant_id: V1, quantity: 1, price: 100, product_title: 'Lift' }], 100);
await mkSess('rt_2', 'f_r1', 2, [{ variant_id: V1, quantity: 2, price: 100 }], 200);
await mkSess('rt_3', 'f_r2', 1, [{ variant_id: V2, quantity: 1, price: 50 }], 50);

// ═══ R1: auth gate ══════════════════════════════════════════════════════════
{
  const bare = { 'Content-Type': 'application/json' };
  for (const [m, p, b] of [
    ['GET', '/variants', undefined], ['GET', '/pnl/overview?start=2026-01-01&end=2026-01-02', undefined],
    ['POST', '/rates', { variant_id: V1, unit_cogs: 1 }], ['POST', '/detect', undefined],
    ['GET', '/spend/status', undefined], ['PATCH', '/fee-settings', {}],
  ]) {
    const r = await req(m, p, b, bare);
    ok(r.status === 401, `R1 ${m} ${p.split('?')[0]} without token → 401`, String(r.status));
  }
}

// ═══ R2: detect + catalog reads ═════════════════════════════════════════════
{
  const r = await req('POST', '/detect?days=90');
  ok(r.status === 200 && r.j.success && r.j.data.variants === 2, `R2 detect swept 2 variants (${JSON.stringify(r.j.data).slice(0, 120)})`);
  const rv = await req('GET', '/variants');
  ok(rv.status === 200 && rv.j.data.total === 2, 'R2 GET /variants lists both');
  ok(rv.j.data.items[0].variant_id === V1, 'R2 sorted by revenue desc (V1 $300 first)');
  ok(rv.j.data.items[0].unit_cogs === null, 'R2 uncosted row (FLAT) resolves null COGS (dash), never 0');
  const rf = await req('GET', `/variants?funnel_id=f_r2`);
  ok(rf.j.data.total === 1 && rf.j.data.items[0].variant_id === V2, 'R2 funnel_id filter');
  const rq = await req('GET', `/variants?q=lift`);
  ok(rq.j.data.total === 1, 'R2 q filter matches product title');
  const rb = await req('GET', '/by-funnel');
  const f1 = rb.j.data.funnels.find((f) => f.funnel_id === 'f_r1');
  ok(rb.status === 200 && f1 && f1.revenue_30d === 300, 'R2 by-funnel credits f_r1 its own $300');
  const rc = await req('GET', '/coverage-summary');
  ok(rc.status === 200 && rc.j.data.needs_cost === 2 && rc.j.data.revenue_at_risk_30d === 350, `R2 coverage summary at_risk=350 (${rc.j.data.revenue_at_risk_30d})`);
  const rbad = await req('POST', '/detect?days=9999');
  ok(rbad.status === 400 && rbad.j.error.code === 'window_too_large', 'R2 detect days > 400 → 400 window_too_large');
  const rsmall = await req('POST', '/detect?days=5');
  ok(rsmall.status === 400 && rsmall.j.error.code === 'window_too_small', 'R2 detect days < 30 → 400 window_too_small');
}

// ═══ R3: rates through the HTTP door — null preserved, malformed 4xx ═══════
{
  // blank COGS + ship map: null must survive the whole HTTP → DB path
  const r1 = await req('POST', '/rates', { variant_id: V1, unit_cogs: null, ship: { main: 4.5, upsell: null } });
  ok(r1.status === 200 && r1.j.data.rate.unit_cogs === null, 'R3 blank unit_cogs arrives and RETURNS as null');
  const [dbRow] = await sql`SELECT unit_cogs, ship FROM lb_cost_rates WHERE id = ${r1.j.data.rate.id}`;
  ok(dbRow.unit_cogs === null, 'R3 DB row: unit_cogs IS NULL (never coerced 0)');
  ok(Number(dbRow.ship.main) === 4.5 && dbRow.ship.upsell === null && dbRow.ship.default === null,
    'R3 DB ship map: 4.5 set, blanks null');
  // known-free is an EXPLICIT zero. Backdated to the first sale so the P&L
  // window's sessions price at THIS rate (the later write wins the same-day
  // tie against the null-cogs row above — engine T3 semantics).
  const r2 = await req('POST', '/rates', { variant_id: V1, unit_cogs: 20, ship: { default: 0 }, effective_from: day(2) });
  ok(r2.status === 200 && Number(r2.j.data.rate.ship.default) === 0, 'R3 explicit ship 0 stored as 0 (known free)');
  // malformed → 4xx {error:{code}}
  const m1 = await req('POST', '/rates', { variant_id: V1, unit_cogs: 'abc' });
  ok(m1.status === 422 && m1.j.error.code === 'bad_amount', `R3 unit_cogs "abc" → 422 bad_amount (${JSON.stringify(m1.j)})`);
  const m2 = await req('POST', '/rates', { variant_id: V1, unit_cogs: -5 });
  ok(m2.status === 422 && m2.j.error.code === 'negative_amount', 'R3 negative → 422');
  const m3 = await req('POST', '/rates', { variant_id: 'not-a-variant', unit_cogs: 1 });
  ok(m3.status === 422 && m3.j.error.code === 'bad_variant_id', 'R3 free-text variant id → 422');
  const m4 = await req('POST', '/rates', { unit_cogs: 1 });
  ok(m4.status === 422 && m4.j.error.code === 'variant_id_required', 'R3 missing ref → 422');
  const m5 = await req('POST', '/rates', { variant_id: V1 });
  ok(m5.status === 422 && m5.j.error.code === 'empty_rate', 'R3 all-blank rate → 422 empty_rate');
  const m6 = await req('POST', '/rates', { variant_id: V1, unit_cogs: 1, effective_from: '08/01/2026' });
  ok(m6.status === 422 && m6.j.error.code === 'bad_effective_from', 'R3 bad date format → 422');
  // history + list
  const h = await req('GET', `/rates/history/${V1}`);
  ok(h.status === 200 && h.j.data.count === 2, 'R3 history shows both appended rows');
  const l = await req('GET', `/rates?variant_id=${V1}`);
  ok(l.status === 200 && l.j.data.count === 2, 'R3 GET /rates filters by variant');
  // coverage flipped by the write
  const cv = await req('GET', '/coverage-summary');
  ok(cv.j.data.ready === 1 && cv.j.data.revenue_at_risk_30d === 50, 'R3 rate write flipped V1 → ready; at_risk now only V2');
}

// ═══ R4: PATCH /variants — operator fields only ════════════════════════════
{
  const r1 = await req('PATCH', `/variants/${V2}`, { pays_shipping: false, kind_override: 'upsell' });
  ok(r1.status === 200 && r1.j.data.variant.pays_shipping === false && r1.j.data.variant.kind_override === 'upsell',
    'R4 operator fields patched');
  const r2 = await req('PATCH', `/variants/${V2}`, { revenue_30d: 999999 });
  ok(r2.status === 422 && r2.j.error.code === 'unknown_field', 'R4 sweep-owned field REFUSED (unknown_field)');
  const r3 = await req('PATCH', `/variants/${V2}`, { ignored: true });
  ok(r3.status === 200 && r3.j.data.variant.coverage === 'ignored', 'R4 ignore sets coverage=ignored');
  const r4 = await req('PATCH', `/variants/${V2}`, { ignored: false });
  ok(r4.status === 200 && r4.j.data.variant.coverage === 'needs_cost', 'R4 un-ignore recomputes from the ledger');
  const r5 = await req('PATCH', `/variants/${V2}`, { kind_override: 'sideways' });
  ok(r5.status === 422 && r5.j.error.code === 'bad_kind_override', 'R4 bad kind refused');
  const r6 = await req('PATCH', '/variants/999999999999', { ignored: true });
  ok(r6.status === 422 && r6.j.error.code === 'variant_not_found', 'R4 unknown variant → 422');
}

// ═══ R5: fee settings round-trip ═══════════════════════════════════════════
{
  const g = await req('GET', '/fee-settings');
  ok(g.status === 200 && g.j.data.default.pct === 6 && g.j.data.gateways.whop === null, 'R5 defaults seeded (nested), rails present-but-null');
  const p = await req('PATCH', '/fee-settings', { default: { pct: 5 }, gateways: { stripe: { pct: 2.9, fixed: 0.3 } } });
  ok(p.status === 200 && p.j.data.default.pct === 5 && p.j.data.gateways.stripe.pct === 2.9, 'R5 nested patch stores default + override');
  const p2 = await req('PATCH', '/fee-settings', { gateways: { stripe: null } });
  ok(p2.status === 200 && p2.j.data.gateways.stripe === null, 'R5 null clears the override back to inherit');
  const bad = await req('PATCH', '/fee-settings', { default: { pct: 500 } });
  ok(bad.status === 422 && bad.j.error.code === 'bad_pct', 'R5 pct 500 refused');
  await req('PATCH', '/fee-settings', { default: { pct: 6 } });
}

// ═══ R6: P&L endpoints ═════════════════════════════════════════════════════
{
  const start = day(7);
  const end = day(0);
  const ov = await req('GET', `/pnl/overview?start=${start}&end=${end}`);
  ok(ov.status === 200 && ov.j.data.rows.length === 2, 'R6 overview has both funnels');
  const f1 = ov.j.data.rows.find((r) => r.fid === 'f_r1');
  const f2 = ov.j.data.rows.find((r) => r.fid === 'f_r2');
  ok(f1.revenue === 300 && f1.cogs === 60 && f1.cost_coverage_pct === 100, `R6 f_r1 costed: rev 300 cogs 60 (${f1.cogs})`);
  ok(f1.gp === Math.round((300 - 60 - 0 - f1.fees) * 100) / 100, 'R6 gp identity holds through HTTP');
  ok(f2.gp === null && f2.gp_margin === null, 'R6 uncosted funnel gp WITHHELD (null) in the API');
  ok(f1.spend_known === false && f1.net_profit === null, 'R6 spend unknown → net_profit null');
  ok(ov.j.data.rows[0].fid === 'f_r1', 'R6 sorted by revenue');
  const bad = await req('GET', '/pnl/overview?start=2026-01-01');
  ok(bad.status === 422 && bad.j.error.code === 'bad_day', 'R6 missing end → 422 bad_day');
  // drill-in + manual spend
  const ms = await req('POST', '/pnl/funnel/f_r1/spend-manual', { day: day(1), spend: 40, note: 'agency' });
  ok(ms.status === 200 && ms.j.data.spend === 40, 'R6 manual spend upserted');
  const fp = await req('GET', `/pnl/funnel/f_r1?start=${start}&end=${end}`);
  ok(fp.status === 200 && fp.j.data.totals.spend === 40 && fp.j.data.totals.spend_known === true,
    `R6 drill-in: manual spend makes spend KNOWN (${fp.j.data.totals.spend})`);
  ok(fp.j.data.totals.net_profit === Math.round((fp.j.data.totals.gp - 40) * 100) / 100, 'R6 net_profit = gp − spend once known');
  ok(fp.j.data.daily.length === 2 && fp.j.data.manual_entries.length === 1, 'R6 daily series + manual entries');
  const msBad = await req('POST', '/pnl/funnel/f_r1/spend-manual', { day: 'yesterday', spend: 1 });
  ok(msBad.status === 422 && msBad.j.error.code === 'bad_day', 'R6 bad manual day → 422');
  const msBad2 = await req('POST', '/pnl/funnel/f_r1/spend-manual', { day: day(1), spend: 'lots' });
  ok(msBad2.status === 422 && msBad2.j.error.code === 'bad_spend', 'R6 bad manual spend → 422 bad_spend');
  const del = await req('DELETE', `/pnl/funnel/f_r1/spend-manual/${day(1)}`);
  ok(del.status === 200 && del.j.data.deleted === true, 'R6 manual spend deleted');
  const fp2 = await req('GET', `/pnl/funnel/f_r1?start=${start}&end=${end}`);
  ok(fp2.j.data.totals.spend_known === false, 'R6 after delete spend is unknown again');
}

// ═══ R7: spend endpoints — status, background sync, campaign pin ═══════════
{
  const st0 = await req('GET', '/spend/status');
  ok(st0.status === 200 && st0.j.data.sources[0].configured === true, 'R7 status sources[]: configured (mock token)');
  const sy = await req('POST', '/spend/sync?days=7');
  ok(sy.status === 200 && sy.j.data.started === true, 'R7 sync starts in the background');
  // poll for the background sync to land
  let rows = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 150));
    rows = await sql`SELECT * FROM lb_ad_spend_daily WHERE source = 'meta'`;
  }
  ok(rows.length === 1 && Number(rows[0].spend) === 77.7, `R7 background sync landed CR1 spend (${rows.length})`);
  const st1 = await req('GET', '/spend/status');
  ok(st1.j.data.sources[0].last_ok === true && st1.j.data.sources[0].stale === false, 'R7 status sources[] reflects the success');
  const syBad = await req('POST', '/spend/sync?days=180');
  ok(syBad.status === 422 && syBad.j.error.code === 'bad_days', 'R7 days > 90 refused (Meta would reject the range)');
  // campaign pin → spend routes to the pinned funnel
  const pin = await req('POST', '/campaign-map', { campaign_id: 'CR1', funnel_id: 'f_r2', action: 'pin' });
  ok(pin.status === 200 && pin.j.data.pinned === true, 'R7 pin stored');
  const ov = await req('GET', `/pnl/overview?start=${day(7)}&end=${day(0)}`);
  const f2 = ov.j.data.rows.find((r) => r.fid === 'f_r2');
  ok(f2.spend === 77.7 && f2.spend_known === true, `R7 pinned campaign spend lands on f_r2 (${f2.spend})`);
  const unpin = await req('POST', '/campaign-map', { campaign_id: 'CR1', action: 'unpin' });
  ok(unpin.status === 200 && unpin.j.data.pinned === false, 'R7 unpin');
  const ov2 = await req('GET', `/pnl/overview?start=${day(7)}&end=${day(0)}`);
  const f2b = ov2.j.data.rows.find((r) => r.fid === 'f_r2');
  ok(f2b.spend_known === false, 'R7 after unpin (no clicks to derive from) spend unknown again');
  const pinBad = await req('POST', '/campaign-map', { campaign_id: 'CR1', action: 'pin' });
  ok(pinBad.status === 422 && pinBad.j.error.code === 'funnel_id_required', 'R7 pin without funnel_id → 422');
  const pinBad2 = await req('POST', '/campaign-map', { action: 'pin', funnel_id: 'f' });
  ok(pinBad2.status === 422 && pinBad2.j.error.code === 'campaign_id_required', 'R7 pin without campaign_id → 422');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
server.close();
mock.close();
process.exit(fail ? 1 : 0);
