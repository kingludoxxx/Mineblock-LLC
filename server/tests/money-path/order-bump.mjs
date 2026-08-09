// Verify POST /session/:id/bump by EXECUTION against the real app.
//   B1  add bump → priced server-side, line carries is_bump + bump_block_id
//   B2  re-add is idempotent (no duplicate line)
//   B3  remove restores totals; second remove is a no-op
//   B4  display-only bump (no variant wired) → 422 bump_not_chargeable
//   B5  wrong page/block/funnel scope → 404s; draft page refused
//   B6  auth: no confirm cookie → 403
//   B7  applied percentage discount recomputes on add; a min-subtotal code is
//       DROPPED on remove with discount_dropped reason
//   B8  pricing outage → 503, session untouched
// Own DB + port; in-process fetch mock for Shopify GraphQL pricing + REST
// discount lookup. No production contact.
import crypto from 'crypto';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_bump';
const PORT = 48940;
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, extra); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_bump`;
await admin`CREATE DATABASE puure_bump`;
await admin.end();

process.env.DATABASE_URL = DB;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'localdev'; process.env.JWT_REFRESH_SECRET = 'localdev';
process.env.FUNNEL_PUBLIC_ENABLED = '1';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.TRACKING_SWEEPS_DISABLED = '1';
process.env.DOMAIN_SWEEP_DISABLED = '1';
process.env.SHOPIFY_ORDER_CREATE_ENABLED = '0';
process.env.PUURE_SHOPIFY_STORE = 'mock.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock';

// In-process Shopify mock: GraphQL pricing + REST discount lookup/price rule.
// PRICING_MODE 'ok' | 'outage' switches B8.
let PRICING_MODE = 'ok';
const VARIANTS = {
  'gid://shopify/ProductVariant/111': { title: 'Base', price: '25.0' },
  'gid://shopify/ProductVariant/222': { title: 'Bump Cream', price: '9.0' },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/graphql.json')) {
    if (PRICING_MODE === 'outage') {
      return new Response('{}', { status: 500 });
    }
    const vars = JSON.parse(init?.body || '{}')?.variables || {};
    const nodes = (vars.ids || []).map((gid) => VARIANTS[gid] ? ({
      id: gid, title: VARIANTS[gid].title, price: VARIANTS[gid].price, compareAtPrice: null,
      availableForSale: true, image: null,
      product: { id: 'gid://shopify/Product/1', title: VARIANTS[gid].title, status: 'ACTIVE', featuredImage: null },
    }) : null);
    return new Response(JSON.stringify({ data: { shop: { currencyCode: 'USD' }, nodes } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/discount_codes/lookup.json')) {
    const code = new URL(u).searchParams.get('code') || '';
    if (code === 'PCT10') return new Response(JSON.stringify({ discount_code: { code: 'PCT10', price_rule_id: 71, usage_count: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (code === 'MIN30') return new Response(JSON.stringify({ discount_code: { code: 'MIN30', price_rule_id: 72, usage_count: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }
  if (u.includes('/price_rules/71.json')) {
    return new Response(JSON.stringify({ price_rule: { id: 71, value_type: 'percentage', value: '-10.0', target_type: 'line_items' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/price_rules/72.json')) {
    return new Response(JSON.stringify({ price_rule: { id: 72, value_type: 'fixed_amount', value: '-5.0', target_type: 'line_items', prerequisite_subtotal_range: { greater_than_or_equal_to: '30.0' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const { default: app } = await import('/Users/ludo/Puure-integrator/server/src/app.js');
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 4000));

const sql = postgres(DB, { ssl: false });
const { ensureCheckoutTables } = await import('/Users/ludo/Puure-integrator/server/src/services/checkoutSchema.js');
const { ensureTables: ensureFunnelTables } = await import('/Users/ludo/Puure-integrator/server/src/routes/funnels.js');
await ensureCheckoutTables();
await ensureFunnelTables();

// Fixtures: funnel + published checkout page carrying a wired bump block, a
// display-only bump block, and a second funnel/page for scope tests.
// LET IT THROW — a failed fixture must fail the run, never silently skip.
await sql`INSERT INTO funnels (id, name, slug, status) VALUES
  ('fn_b', 'B', 'b', 'published'), ('fn_other', 'O', 'o', 'published')
  ON CONFLICT (id) DO NOTHING`;
const BLOCKS = [
  { id: 'blk_bump1', type: 'order_bump', props: { label: 'Add the cream', variant_id: '222', quantity: 1 } },
  { id: 'blk_bump_display', type: 'order_bump', props: { label: 'Display only' } },
  { id: 'blk_bump_cold', type: 'order_bump', props: { label: 'Cold variant', variant_id: '333', quantity: 1 } },
];
await sql`INSERT INTO funnel_pages (id, funnel_id, title, slug, type, status, blocks)
  VALUES ('pg_b', 'fn_b', 'Checkout', '/co', 'checkout', 'published', ${sql.json(BLOCKS)}),
         ('pg_draft', 'fn_b', 'Draft', '/dr', 'checkout', 'draft', ${sql.json(BLOCKS)}),
         ('pg_other', 'fn_other', 'Other', '/oc', 'checkout', 'published', ${sql.json(BLOCKS)})
  ON CONFLICT (id) DO NOTHING`;

const B = `http://127.0.0.1:${PORT}/api/v1/checkout/public`;
async function mint() {
  const res = await realFetch(`${B}/create-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ funnel_id: 'fn_b', page_id: 'pg_b', line_items: [{ variant_id: '111', quantity: 1 }] }),
  });
  const j = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { sid: j?.data?.session_id, cookie };
}
async function toggle(sid, cookie, body) {
  const res = await realFetch(`${B}/session/${sid}/bump`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
const sessionRow = async (sid) => (await sql`SELECT line_items, subtotal, total, discount_code, discount_amount FROM co_sessions WHERE id = ${sid}`)[0];

// B1 — add
{
  const { sid, cookie } = await mint();
  const r = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: true });
  ok(r.status === 200, 'B1 add bump 200', JSON.stringify(r.j).slice(0, 200));
  ok(r.j?.data?.totals?.subtotal === 34, 'B1 subtotal 25+9=34', JSON.stringify(r.j?.data?.totals));
  const row = await sessionRow(sid);
  const bl = (row.line_items || []).find((l) => l.is_bump);
  ok(!!bl && bl.bump_block_id === 'blk_bump1' && Number(bl.price) === 9, 'B1 bump line priced server-side', JSON.stringify(bl));
  // B2 — idempotent re-add
  const r2 = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: true });
  const row2 = await sessionRow(sid);
  ok(r2.status === 200 && (row2.line_items || []).filter((l) => l.is_bump).length === 1, 'B2 re-add adds nothing');
  // B3 — remove
  const r3 = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: false });
  const row3 = await sessionRow(sid);
  ok(r3.status === 200 && Number(row3.subtotal) === 25 && !(row3.line_items || []).some((l) => l.is_bump), 'B3 remove restores cart');
  const r3b = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: false });
  ok(r3b.status === 200, 'B3 second remove is a clean no-op');
}
// B4 — display-only
{
  const { sid, cookie } = await mint();
  const r = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump_display', selected: true });
  ok(r.status === 422 && r.j?.error?.code === 'bump_not_chargeable', 'B4 display-only bump refused', JSON.stringify(r.j));
}
// B5 — scope: other funnel's page, unknown block, draft page
{
  const { sid, cookie } = await mint();
  const a = await toggle(sid, cookie, { page_id: 'pg_other', block_id: 'blk_bump1', selected: true });
  ok(a.status === 404, 'B5 other-funnel page 404', String(a.status));
  const b = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_nope', selected: true });
  ok(b.status === 404 && b.j?.error?.code === 'bump_block_not_found', 'B5 unknown block 404');
  const c = await toggle(sid, cookie, { page_id: 'pg_draft', block_id: 'blk_bump1', selected: true });
  ok(c.status === 404, 'B5 draft page refused', String(c.status));
}
// B6 — no cookie
{
  const { sid } = await mint();
  const r = await toggle(sid, null, { page_id: 'pg_b', block_id: 'blk_bump1', selected: true });
  ok(r.status === 403 && r.j?.error?.code === 'confirmation_required', 'B6 missing confirm cookie 403');
}
// B7 — discount interplay
{
  const { sid, cookie } = await mint();
  // apply 10% code on 25 → 2.50 off
  const d = await realFetch(`${B}/session/${sid}/discount`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code: 'PCT10' }),
  });
  const dj = await d.json();
  ok(d.status === 200 && dj?.data?.discount_amount === 2.5, 'B7 PCT10 applied at 2.50', JSON.stringify(dj?.data));
  // add bump → subtotal 34 → discount recomputes to 3.40
  const r = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: true });
  ok(r.status === 200 && r.j?.data?.discount_amount === 3.4 && r.j?.data?.totals?.total === 30.6,
    'B7 percentage discount recomputed on add (3.40 off, total 30.60)', JSON.stringify(r.j?.data));
  // switch to MIN30 (requires subtotal ≥30 — valid at 34)
  const d2 = await realFetch(`${B}/session/${sid}/discount`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code: 'MIN30' }),
  });
  const d2j = await d2.json();
  ok(d2.status === 200 && d2j?.data?.discount_amount === 5, 'B7 MIN30 applied at 34 subtotal', JSON.stringify(d2j?.data));
  // remove bump → subtotal 25 < 30 → code dropped, reason surfaces
  const r2 = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump1', selected: false });
  ok(r2.status === 200 && r2.j?.data?.discount_code === null
    && String(r2.j?.data?.discount_dropped || '').startsWith('code_min_subtotal'),
    'B7 min-subtotal code dropped on remove with reason', JSON.stringify(r2.j?.data));
  const row = await sessionRow(sid);
  ok(row.discount_code === null && Number(row.total) === 25, 'B7 session persisted the drop (total back to 25)');
}
// B8 — pricing outage
{
  const { sid, cookie } = await mint();
  PRICING_MODE = 'outage';
  // variant 333 is never priced elsewhere — the 60s price cache can't mask the outage
  const r = await toggle(sid, cookie, { page_id: 'pg_b', block_id: 'blk_bump_cold', selected: true });
  PRICING_MODE = 'ok';
  ok(r.status === 503 && r.j?.error?.code === 'pricing_unavailable', 'B8 outage 503');
  const row = await sessionRow(sid);
  ok(Number(row.subtotal) === 25 && !(row.line_items || []).some((l) => l.is_bump), 'B8 session untouched on outage');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close();
await sql.end();
process.exit(fail ? 1 : 0);
