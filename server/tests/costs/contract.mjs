// CONTRACT TRIPWIRE — cogs-contract-v2.md enforced byte-for-byte against the
// REAL router. For EVERY endpoint this sends the EXACT request shape the
// contract specifies (including the {} empty-body cases the client sends)
// and asserts the response envelope AND payload key sets match the contract
// EXACTLY — exact key sets, never subsets. If either lane drifts from the
// written contract, this file fails before a human ever sees a blank page.
//
// Run:  node server/tests/costs/contract.mjs
import http from 'http';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_costs_contract';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.META_ACCESS_TOKEN = 'TEST_META_TOKEN_CONTRACT';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
// THE assertion of this file: exact key set, sorted, no subsets.
const keysEq = (name, obj, expected) => {
  const got = obj && typeof obj === 'object' ? Object.keys(obj).sort() : ['<not an object>'];
  const want = [...expected].sort();
  ok(JSON.stringify(got) === JSON.stringify(want), name,
    `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_costs_contract`;
await admin`CREATE DATABASE puure_costs_contract`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// ── day helpers — REPORT-TZ calendar, the one the engine buckets in ─────────
// (a UTC slice here disagrees with the engine 22:00-24:00 UTC every day)
import { reportDaysAgo, reportDayStartIso } from '../../src/services/reportTz.js';
const day = (n) => reportDaysAgo(n); // n days ago as a report-day key
// An instant safely inside report-day day(n): 10h after report-tz midnight.
const dayInstant = (n) => new Date(Date.parse(reportDayStartIso(day(n))) + 10 * 3600e3).toISOString();

// mock Meta so spend endpoints are exercised for real
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/me/adaccounts')) {
    return res.end(JSON.stringify({ data: [{ id: 'act_7', account_id: '7', name: 'A' }] }));
  }
  if (req.url.startsWith('/act_7/insights')) {
    return res.end(JSON.stringify({ data: [
      { campaign_id: 'CC1', campaign_name: 'Contract Camp', spend: '10.00', date_start: day(1), date_stop: day(1) },
    ] }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.META_GRAPH_OVERRIDE_URL = `http://127.0.0.1:${mock.address().port}`;

// seed auth
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email) VALUES ('u_ct', 'ct@local.test')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_ct', 'ct', '{"funnels": ["access"]}')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_ct', 'r_ct')`;

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
const token = jwt.sign({ userId: 'u_ct' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body) => {
  const r = await fetch(`${B}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = JSON.parse(await r.text()); } catch { /* non-JSON */ }
  return { status: r.status, j };
};

// ── seed money so every payload is non-empty ────────────────────────────────
const V1 = '777777777777';
const V2 = '888888888888';
await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
  VALUES ('ct_1', 'f_ct', 'paid', ${sql.json([{ variant_id: V1, quantity: 1, price: 100, product_title: 'Contract Cream' }])},
          100, '[]', ${dayInstant(1)}, ${dayInstant(1)})`;
// cross-window parent + recent upsell (M4 evidence in the same payloads)
await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, refunds, paid_at, created_at)
  VALUES ('ct_2', 'f_ct', 'paid', ${sql.json([{ variant_id: V1, quantity: 1, price: 60 }])},
          60, '[]', ${dayInstant(40)}, ${dayInstant(40)})`;
await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, status, line_items, created_at)
  VALUES ('ct_ux', 'ct_2', 'up', ${'v:' + V2}, 30, 'settled',
          ${sql.json([{ variant_id: V2, quantity: 1, unit_price: 30 }])},
          ${dayInstant(1)})`;

// ══ CONTRACT KEY SETS (cogs-contract-v2.md, verbatim) ══════════════════════
const ROW_KEYS = ['variant_id', 'product_title', 'variant_title', 'image_url', 'contexts', 'funnels',
  'revenue_30d', 'units_30d', 'price', 'coverage', 'pays_shipping', 'kind_override', 'cost_item_id', 'units_per',
  'first_sold', 'detected_at', 'updated_at', 'unit_cogs', 'cogs_source', 'ship', 'margin_pct'];
const SHIP_KEYS = ['default', 'main', 'upsell', 'addon', 'bump'];
const PNL_ROW_KEYS = ['fid', 'name', 'revenue', 'gross_sales', 'orders', 'cogs', 'fees', 'ship_cost',
  'gp', 'gp_margin', 'cost_coverage_pct', 'known_legs', 'missing_legs', 'missing_cogs_legs',
  'missing_ship_legs', 'spend', 'spend_known', 'net_profit', 'roas', 'cpa'];
const DAILY_KEYS = ['day', 'orders', 'revenue', 'cogs', 'fees', 'ship_cost', 'gp', 'spend', 'np', 'cost_coverage_pct'];
const CAMPAIGN_KEYS = ['campaign_id', 'name', 'spend', 'bound_via', 'split', 'sessions'];
const MANUAL_KEYS = ['day', 'spend', 'note'];
const RATE_KEYS = ['id', 'scope', 'variant_id', 'cost_item_id', 'effective_from', 'unit_cogs', 'ship',
  'currency', 'source', 'note', 'created_at'];
const SOURCE_KEYS = ['source', 'configured', 'last_sync', 'last_attempt', 'last_ok', 'stale', 'error', 'fail_streak'];

// ── POST /detect — client sends {} ──────────────────────────────────────────
{
  const r = await req('POST', '/detect?days=90', {});
  ok(r.status === 200 && r.j.success === true, 'detect: {} body → 200');
  keysEq('detect: envelope keys', r.j, ['success', 'data']);
  const small = await req('POST', '/detect?days=5', {});
  ok(small.status === 400 && small.j.error.code === 'window_too_small', 'detect: days<30 → 400 window_too_small');
  keysEq('error envelope keys', small.j, ['success', 'error']);
  keysEq('error object keys', small.j.error, ['code']);
}

// ── GET /variants ───────────────────────────────────────────────────────────
{
  const r = await req('GET', '/variants');
  keysEq('variants: data keys', r.j.data, ['items', 'total', 'limit', 'offset']);
  ok(r.j.data.items.length >= 2, `variants: seeded rows present (${r.j.data.items.length})`);
  keysEq('variants: ROW keys EXACT (flat, no nested resolved)', r.j.data.items[0], ROW_KEYS);
  keysEq('variants: ship map keys EXACT', r.j.data.items[0].ship, SHIP_KEYS);
  ok(r.j.data.items[0].unit_cogs === null && r.j.data.items[0].margin_pct === null,
    'variants: unknowns are null, never omitted');
}

// ── POST /rates (m13) + usd_only (m9) ───────────────────────────────────────
{
  const r = await req('POST', '/rates', { variant_id: V1, unit_cogs: 10, ship: { default: 0 } });
  keysEq('rates: data keys', r.j.data, ['rate']);
  keysEq('rates: rate keys EXACT', r.j.data.rate, RATE_KEYS);
  ok(typeof r.j.data.rate.effective_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.j.data.rate.effective_from),
    'rates: effective_from is a day key (the client confirmation line reads it)');
  const eur = await req('POST', '/rates', { variant_id: V1, unit_cogs: 5, currency: 'EUR' });
  ok(eur.status === 422 && eur.j.error.code === 'usd_only', 'rates: non-USD → 422 usd_only');
  const noRef = await req('POST', '/rates', { scope: 'item', unit_cogs: 5 });
  ok(noRef.status === 422 && noRef.j.error.code === 'cost_item_id_required', 'rates: item scope w/o ref → cost_item_id_required (n1)');
}

// ── GET /by-funnel (M1) ─────────────────────────────────────────────────────
{
  const r = await req('GET', '/by-funnel');
  keysEq('by-funnel: data keys', r.j.data, ['funnels']);
  const f = r.j.data.funnels.find((x) => x.funnel_id === 'f_ct');
  keysEq('by-funnel: funnel keys EXACT', f,
    ['funnel_id', 'name', 'revenue_30d', 'units_30d', 'revenue_at_risk_30d', 'counts', 'products']);
  keysEq('by-funnel: counts keys', f.counts, ['needs_cost', 'ready', 'ignored']);
  keysEq('by-funnel: product keys EXACT', f.products[0],
    ['product_title', 'shopify_product_id', 'avg_price', 'missing_count', 'variants']);
  keysEq('by-funnel: variant = ROW + own_* EXACT', f.products[0].variants[0],
    [...ROW_KEYS, 'own_revenue_30d', 'own_units_30d']);
  keysEq('by-funnel: variant ship keys', f.products[0].variants[0].ship, SHIP_KEYS);
}

// ── GET/PATCH /fee-settings (B5, nested both directions) ────────────────────
{
  const g = await req('GET', '/fee-settings');
  keysEq('fee-settings GET: data keys EXACT', g.j.data, ['default', 'gateways', 'updated_at']);
  keysEq('fee-settings: default keys', g.j.data.default, ['pct', 'fixed']);
  keysEq('fee-settings: seeded rails', g.j.data.gateways, ['whop', 'stripe', 'paypal', 'nmi']);
  const p = await req('PATCH', '/fee-settings', { default: { pct: 5, fixed: 0.1 }, gateways: { stripe: { pct: 2.9, fixed: 0.3 } } });
  keysEq('fee-settings PATCH: same nested shape back', p.j.data, ['default', 'gateways', 'updated_at']);
  ok(p.j.data.default.pct === 5 && p.j.data.gateways.stripe.pct === 2.9, 'fee-settings PATCH: nested body applied');
  const clear = await req('PATCH', '/fee-settings', { gateways: { stripe: null } });
  ok(clear.j.data.gateways.stripe === null, 'fee-settings: null clears to inherit');
  await req('PATCH', '/fee-settings', { default: { pct: 6, fixed: 0 } });
}

// ── GET /pnl/overview (M6 + window) ─────────────────────────────────────────
{
  const r = await req('GET', `/pnl/overview?start=${day(7)}&end=${day(0)}`);
  keysEq('overview: data keys EXACT', r.j.data, ['rows', 'totals', 'window']);
  keysEq('overview: window keys', r.j.data.window, ['start', 'end']);
  const row = r.j.data.rows.find((x) => x.fid === 'f_ct');
  keysEq('overview: row keys EXACT (M6 leg counters included)', row, PNL_ROW_KEYS);
  keysEq('overview: totals keys EXACT (same set)', r.j.data.totals, PNL_ROW_KEYS);
  // M4 evidence: the July-settled upsell of the June parent is IN this window
  ok(row.gross_sales === 130 && row.orders === 1,
    `overview M4: recent window = recent order (100) + cross-window upsell (30), 1 order (${row.gross_sales}/${row.orders})`);
  const big = await req('GET', '/pnl/overview?start=2024-01-01&end=2026-08-01');
  ok(big.status === 400 && big.j.error.code === 'window_too_large', 'overview: >400d window → 400 window_too_large (m2)');
}

// ── GET /pnl/funnel/:fid ────────────────────────────────────────────────────
{
  // manual spend first so manual_entries is non-empty (contract body: spend)
  const ms = await req('POST', '/pnl/funnel/f_ct/spend-manual', { day: day(1), spend: 12.5, note: 'x' });
  ok(ms.status === 200, 'spend-manual: {day, spend, note} body accepted (B3)');
  const legacy = await req('POST', '/pnl/funnel/f_ct/spend-manual', { day: day(1), amount: 12.5 });
  ok(legacy.status === 422 && legacy.j.error.code === 'bad_spend', 'spend-manual: legacy {amount} body REFUSED (drift tripwire)');
  const r = await req('GET', `/pnl/funnel/f_ct?start=${day(7)}&end=${day(0)}`);
  keysEq('pnl/funnel: data keys EXACT', r.j.data, ['totals', 'daily', 'campaigns', 'manual_entries']);
  keysEq('pnl/funnel: totals keys EXACT', r.j.data.totals, PNL_ROW_KEYS);
  ok(r.j.data.daily.length >= 1, 'pnl/funnel: daily non-empty');
  keysEq('pnl/funnel: daily row keys EXACT (np, not net_profit)', r.j.data.daily[0], DAILY_KEYS);
  keysEq('pnl/funnel: manual entry keys EXACT', r.j.data.manual_entries[0], MANUAL_KEYS);
  const del = await req('DELETE', `/pnl/funnel/f_ct/spend-manual/${day(1)}`);
  ok(del.status === 200, 'spend-manual DELETE unchanged');
}

// ── POST /spend/sync ({} body) + GET /spend/status (M2) ─────────────────────
{
  const sy = await req('POST', '/spend/sync?days=7', {});
  ok(sy.status === 200 && sy.j.data.started === true, 'spend/sync: {} body → started');
  let landed = [];
  for (let i = 0; i < 40 && landed.length === 0; i++) {
    await new Promise((r2) => setTimeout(r2, 150));
    landed = await sql`SELECT 1 FROM lb_ad_spend_daily WHERE source = 'meta'`;
  }
  ok(landed.length === 1, 'spend/sync: background sync landed (mock Meta)');
  const st = await req('GET', '/spend/status');
  keysEq('spend/status: data keys EXACT', st.j.data, ['sources']);
  ok(Array.isArray(st.j.data.sources) && st.j.data.sources.length === 1, 'spend/status: one source (meta)');
  keysEq('spend/status: source keys EXACT (M2)', st.j.data.sources[0], SOURCE_KEYS);
  ok(st.j.data.sources[0].source === 'meta', 'spend/status: source named');
}

// ── POST /campaign-map + campaigns[] shape (m5) ─────────────────────────────
{
  const pin = await req('POST', '/campaign-map', { campaign_id: 'CC1', funnel_id: 'f_ct', action: 'pin' });
  ok(pin.status === 200, 'campaign-map: pin accepted');
  const r = await req('GET', `/pnl/funnel/f_ct?start=${day(7)}&end=${day(0)}`);
  ok(r.j.data.campaigns.length === 1, 'pnl/funnel: pinned campaign listed');
  keysEq('pnl/funnel: campaign keys EXACT (bound_via + split + sessions)', r.j.data.campaigns[0], CAMPAIGN_KEYS);
  ok(r.j.data.campaigns[0].bound_via === 'pin', 'campaign row says HOW it is bound');
  ok(typeof r.j.data.campaigns[0].split === 'boolean' && typeof r.j.data.campaigns[0].sessions === 'number',
    'campaign row carries the tie evidence (m5)');
  await req('POST', '/campaign-map', { campaign_id: 'CC1', action: 'unpin' });
}

// ── PATCH /variants/:id (operator door, envelope) ───────────────────────────
{
  const r = await req('PATCH', `/variants/${V1}`, { pays_shipping: false });
  keysEq('variants PATCH: data keys', r.j.data, ['variant']);
  const bad = await req('PATCH', `/variants/${V1}`, { revenue_30d: 1 });
  ok(bad.status === 422 && bad.j.error.code === 'unknown_field', 'variants PATCH: sweep-owned field refused');
}

// ── GET /rates + /rates/history + /coverage-summary envelopes ───────────────
{
  const l = await req('GET', `/rates?variant_id=${V1}`);
  keysEq('rates list: data keys', l.j.data, ['items', 'count']);
  const h = await req('GET', `/rates/history/${V1}`);
  keysEq('rates history: data keys', h.j.data, ['variant_id', 'items', 'count']);
  const c = await req('GET', '/coverage-summary');
  keysEq('coverage-summary: data keys', c.j.data,
    ['total', 'needs_cost', 'ready', 'ignored', 'coverage_pct', 'revenue_at_risk_30d', 'units_at_risk_30d']);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
server.close();
mock.close();
process.exit(fail ? 1 : 0);
