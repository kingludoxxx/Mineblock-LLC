// ORDERS EXTRAS verification — drives the REAL /api/v1/orders router (real
// authenticate + requirePermission + ensureTables) against embedded PG on 5433,
// same shape as server/tests/tracking/admin-crud.mjs.
//
// Proves BY EXECUTION:
//   T1  every new endpoint refuses an unauthenticated request (401)
//   T2  saved-views CRUD round-trips; the unique index arbitrates duplicates
//   T3  saved views are isolated PER USER — B cannot read, update or delete A's
//   T4  journey aggregation: all four sources present, ordered ascending
//   T5  journey for an order with no checkout session → linked:false + reason
//   T6  manual order writes ONE crm_orders row and ZERO rows to co_sessions /
//       co_orders / co_upsell_charges (runtime census, before vs after), never
//       populates a gateway/settlement field, and flows into list + export
//   T7  needs-review surfaces all three distress sources with their reasons
//   T8  edge cases: bad sort falls back, malformed manual body 400s,
//       non-numeric :id 404s instead of a BIGINT cast 500
//   T9  grep-proof: the orders module imports no checkout/gateway/settle code
//
// Run:  node server/tests/orders/orders-extras.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.PUURE_SHOPIFY_STORE = process.env.PUURE_SHOPIFY_STORE || 'test-shop.myshopify.com';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── seed auth: two DISTINCT users, both with orders:access ──────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_ord_a', 'orda@local.test', 'Ord', 'Alpha'),
  ('u_ord_b', 'ordb@local.test', 'Ord', 'Bravo')
  ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions)
  VALUES ('r_ord_test', 'orders-tester', '{"orders": ["access"]}')
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`DELETE FROM user_roles WHERE user_id IN ('u_ord_a','u_ord_b')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_ord_a','r_ord_test'), ('u_ord_b','r_ord_test')`;

const ordersRouter = (await import('../../src/routes/orders.js')).default;

const app = express();
app.use(express.json());
app.use('/api/v1/orders', ordersRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/orders`;

const mkHeaders = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' })}`,
  'Content-Type': 'application/json',
});
const HA = mkHeaders('u_ord_a');
const HB = mkHeaders('u_ord_b');
const NOAUTH = { 'Content-Type': 'application/json' };

const req = async (method, path, body, headers = HA) => {
  const r = await fetch(`${B}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON (CSV) */ }
  return { status: r.status, j, text };
};

// ── fixtures ────────────────────────────────────────────────────────────────
const SID = 'cs_ordextras_1';                 // the checkout session
const SHOPIFY_ID = 9900000000001;             // crm_orders.order_id == shopify id
const ORPHAN_ID = 9900000000002;              // a store order with NO session
const CO_ORDER_ID = 'co_ordextras_1';

// The tables the journey reads must exist for the seed to be meaningful — the
// checkout lane owns their DDL, so mirror it here exactly like the tracking
// harness mirrors lb_pixels. If the real schema module has already created
// them, IF NOT EXISTS makes this a no-op.
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
await ensureCheckoutTables();
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
await ensureTrackingTables();
const { ensureIntegrationTables } = await import('../../src/services/integrationsSchema.js');
await ensureIntegrationTables();

const cleanup = async () => {
  await sql`DELETE FROM lb_order_views WHERE user_id IN ('u_ord_a','u_ord_b')`;
  await sql`DELETE FROM crm_orders WHERE order_id IN (${SHOPIFY_ID}, ${ORPHAN_ID}) OR source = 'manual'`;
  await sql`DELETE FROM crm_order_events WHERE order_id IN (${SHOPIFY_ID}, ${ORPHAN_ID}) OR order_id < 0`;
  await sql`DELETE FROM co_events WHERE session_id = ${SID}`;
  await sql`DELETE FROM co_upsell_charges WHERE session_id = ${SID}`;
  await sql`DELETE FROM co_orders WHERE session_id = ${SID}`;
  await sql`DELETE FROM co_sessions WHERE id = ${SID}`;
  await sql`DELETE FROM lb_tracking_events WHERE event_id LIKE ${'%' + SID + '%'}`;
  await sql`DELETE FROM lb_integration_sends WHERE ref LIKE ${'%' + SID + '%'}`;
};

// One ensure pass so the DDL (incl. lb_order_views + crm_orders.source) exists
// before we seed rows into crm_orders.
await req('GET', '/views');
await cleanup();

const T0 = new Date('2026-03-01T10:00:00.000Z');
const at = (mins) => new Date(T0.getTime() + mins * 60_000);

// crm_orders: the mirrored store order + an orphan with no checkout session
await sql`INSERT INTO crm_orders (order_id, order_number, created_at, financial_status,
  total_price, currency, customer_email, item_count, shopify_order_id, source)
  VALUES (${SHOPIFY_ID}, '#1001', ${at(0)}, 'paid', 129.00, 'USD', 'buyer@local.test', 2, ${SHOPIFY_ID}, 'shopify'),
         (${ORPHAN_ID}, '#1002', ${at(0)}, 'paid', 49.00, 'USD', 'orphan@local.test', 1, ${ORPHAN_ID}, 'shopify')`;

// co_sessions + co_orders: the link chain
await sql`INSERT INTO co_sessions (id, status, total, currency, gateway, customer, refunds, paid_at, created_at)
  VALUES (${SID}, 'paid', 129.00, 'USD', 'whop',
          ${sql.json({ email: 'buyer@local.test' })},
          ${sql.json([{ amount: 20, currency: 'USD', created_at: at(50).toISOString() }])},
          ${at(2)}, ${at(0)})`;
await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency,
  shopify_order_id, shopify_order_number, shopify_status, shopify_created_at, created_at)
  VALUES (${CO_ORDER_ID}, ${SID}, ${'idem_' + SID}, 'whop', 129.00, 'USD',
          ${String(SHOPIFY_ID)}, '#1001', 'created', ${at(3)}, ${at(2)})`;

// Source 1 — co_events (deliberately inserted OUT of chronological order so the
// ascending sort is actually proved, not merely reproduced by insertion order)
await sql`INSERT INTO co_events (session_id, kind, data, created_at) VALUES
  (${SID}, 'paid', ${sql.json({ amount: 129 })}, ${at(2)}),
  (${SID}, 'session_created', ${sql.json({ funnel: 'f1' })}, ${at(0)}),
  (${SID}, 'upsell_settled', ${sql.json({ offer: 'o1' })}, ${at(6)})`;

// Source 2 — co_upsell_charges (one collected, one needing review)
await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status, created_at, updated_at) VALUES
  (${'uc_ok_' + SID}, ${SID}, 'offer_1', 'v:111', 39.00, 'USD', 'settled', ${at(5)}, ${at(5)}),
  (${'uc_nr_' + SID}, ${SID}, 'offer_2', 'v:222', 59.00, 'USD', 'needs_review', ${at(7)}, ${at(7)})`;

// Source 3 — lb_tracking_events (base purchase + per-upsell + a client relay)
await sql`INSERT INTO lb_tracking_events (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk, emq, value, ts) VALUES
  ('f1','meta','111','Purchase', ${'pur_' + SID}, 'sent','webhook','[]', 8, 129.00, ${at(3)}),
  ('f1','meta','111','Purchase', ${'pur_' + SID + '_u_uc_ok'}, 'sent','webhook','[]', 7, 39.00, ${at(6)}),
  ('f1','meta','111','Purchase', ${'cl_pur_' + SID}, 'sent','browser','[]', 5, 129.00, ${at(4)})`;

// Source 4 — lb_integration_sends (Klaviyo order + lead + upsell)
await sql`INSERT INTO lb_integration_sends (kind, ref, created_at) VALUES
  ('klaviyo', ${'ko_' + SID}, ${at(4)}),
  ('klaviyo', ${'kl_' + SID}, ${at(1)}),
  ('klaviyo', ${'ku_' + SID + '_uc_ok'}, ${at(8)})`;

// ── T1: auth gate on every NEW endpoint ─────────────────────────────────────
{
  const paths = [
    ['GET', '/views'], ['POST', '/views'], ['PUT', '/views/ov_x'], ['DELETE', '/views/ov_x'],
    ['GET', '/needs-review'], ['POST', '/manual'], ['GET', `/${SHOPIFY_ID}/journey`],
  ];
  let all401 = true; const bad = [];
  for (const [m, p] of paths) {
    const r = await req(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, NOAUTH);
    if (r.status !== 401) { all401 = false; bad.push(`${m} ${p}=${r.status}`); }
  }
  check('T1 all 7 new endpoints refuse anonymous with 401', all401, bad.join(', '));
}

// ── T2: saved-views CRUD ────────────────────────────────────────────────────
let viewId = null;
{
  const c = await req('POST', '/views', {
    name: 'Unfulfilled paid',
    filters: { payment: 'paid', fulfillment: 'unfulfilled', bogus_key: 'x' },
    sort: 'total_price:asc',
    columns: ['order_number', 'total_price'],
  });
  viewId = c.j?.data?.view?.id;
  check('T2 create → 201 with id', c.status === 201 && !!viewId, JSON.stringify(c.j));
  check('T2 unknown filter key stripped at write time',
    c.j?.data?.view?.filters?.bogus_key === undefined
    && c.j?.data?.view?.filters?.payment === 'paid', JSON.stringify(c.j?.data?.view?.filters));
  check('T2 sort normalized through the whitelist',
    c.j?.data?.view?.sort === 'total_price:asc', c.j?.data?.view?.sort);

  const dupe = await req('POST', '/views', { name: 'unfulfilled PAID' });
  check('T2 duplicate name (case-insensitive) → 409 from the unique index',
    dupe.status === 409, `${dupe.status} ${JSON.stringify(dupe.j)}`);

  const l = await req('GET', '/views');
  check('T2 list returns exactly the one view', l.status === 200
    && l.j?.data?.views?.length === 1 && l.j.data.views[0].id === viewId, JSON.stringify(l.j?.data));

  const u = await req('PUT', `/views/${viewId}`, { name: 'Renamed', sort: 'created_at:desc' });
  check('T2 update renames + re-sorts', u.status === 200
    && u.j?.data?.view?.name === 'Renamed' && u.j?.data?.view?.sort === 'created_at:desc',
    JSON.stringify(u.j?.data?.view));
  check('T2 update leaves omitted fields unchanged',
    u.j?.data?.view?.filters?.payment === 'paid', JSON.stringify(u.j?.data?.view?.filters));

  const bogus = await req('PUT', '/views/ov_does_not_exist', { name: 'x' });
  check('T2 update of a nonexistent view → 404', bogus.status === 404, String(bogus.status));
  const empty = await req('PUT', `/views/${viewId}`, {});
  check('T2 update with no fields → 400', empty.status === 400, String(empty.status));
}

// ── T3: PER-USER ISOLATION ──────────────────────────────────────────────────
{
  const bList = await req('GET', '/views', undefined, HB);
  check('T3 user B sees NONE of user A\'s views', bList.status === 200
    && (bList.j?.data?.views || []).length === 0, JSON.stringify(bList.j?.data));

  const bUpdate = await req('PUT', `/views/${viewId}`, { name: 'hijacked' }, HB);
  check('T3 user B cannot UPDATE user A\'s view (404, no disclosure)',
    bUpdate.status === 404, String(bUpdate.status));

  const bDelete = await req('DELETE', `/views/${viewId}`, undefined, HB);
  check('T3 user B cannot DELETE user A\'s view', bDelete.status === 404, String(bDelete.status));

  const [row] = await sql`SELECT name FROM lb_order_views WHERE id = ${viewId}`;
  check('T3 the row survived both attempts, unmodified', row?.name === 'Renamed', row?.name);

  // Same NAME is free for a different user — the unique index is (user_id, name)
  const bOwn = await req('POST', '/views', { name: 'Renamed' }, HB);
  check('T3 user B may reuse the same view NAME', bOwn.status === 201, String(bOwn.status));
  const bList2 = await req('GET', '/views', undefined, HB);
  check('T3 user B now sees exactly their OWN one view',
    bList2.j?.data?.views?.length === 1 && bList2.j.data.views[0].name === 'Renamed',
    JSON.stringify(bList2.j?.data?.views?.map((v) => v.name)));
  const aList = await req('GET', '/views');
  check('T3 user A still sees exactly one (B\'s did not leak in)',
    aList.j?.data?.views?.length === 1, JSON.stringify(aList.j?.data?.views?.length));
}

// ── T4: journey aggregation ─────────────────────────────────────────────────
{
  const r = await req('GET', `/${SHOPIFY_ID}/journey`);
  const d = r.j?.data;
  check('T4 journey 200 and linked to the checkout session',
    r.status === 200 && d?.linked === true && d?.session_id === SID, JSON.stringify(d?.session_id));

  const bySource = {};
  for (const e of d?.entries || []) bySource[e.source] = (bySource[e.source] || 0) + 1;
  check('T4 ALL FOUR sources present + shopify + refund',
    bySource.checkout === 3 && bySource.upsell === 2 && bySource.tracking === 3
    && bySource.klaviyo === 3 && bySource.shopify === 1 && bySource.refund === 1,
    JSON.stringify(bySource));

  const ts = (d?.entries || []).map((e) => new Date(e.ts).getTime());
  const ascending = ts.every((t, i) => i === 0 || t >= ts[i - 1]);
  check('T4 entries are in ASCENDING chronological order (seed was out of order)',
    ascending, JSON.stringify((d?.entries || []).map((e) => `${e.source}@${e.ts}`)));

  check('T4 counts block agrees with the entries',
    d?.counts?.checkout === 3 && d?.counts?.upsell === 2 && d?.counts?.tracking === 3
    && d?.counts?.klaviyo === 3 && d?.counts?.refund === 1, JSON.stringify(d?.counts));

  const first = (d.entries || [])[0];
  check('T4 the earliest entry is session_created', first?.kind === 'session_created',
    `${first?.source}/${first?.kind}`);

  const failed = (d.entries || []).filter((e) => e.failed);
  check('T4 the needs_review upsell charge is flagged failed',
    failed.length === 1 && failed[0].payload?.status === 'needs_review', JSON.stringify(failed.map((f) => f.kind)));

  check('T4 shopify entry carries an admin link',
    (d.entries || []).some((e) => e.source === 'shopify'
      && String(e.payload?.admin_url || '').includes(`/admin/orders/${SHOPIFY_ID}`)),
    JSON.stringify((d.entries || []).find((e) => e.source === 'shopify')?.payload));

  check('T4 klaviyo refs resolved to their human titles',
    (d.entries || []).some((e) => e.title === 'Klaviyo · Placed Order')
    && (d.entries || []).some((e) => e.title === 'Klaviyo · Lead')
    && (d.entries || []).some((e) => e.title === 'Klaviyo · Upsell'),
    JSON.stringify((d.entries || []).filter((e) => e.source === 'klaviyo').map((e) => e.title)));

  check('T4 tracking picked up base + upsell + client-relayed event ids',
    (d.entries || []).filter((e) => e.source === 'tracking').length === 3,
    JSON.stringify((d.entries || []).filter((e) => e.source === 'tracking').map((e) => e.payload.event_id)));

  check('T4 no source reported unavailable in a fully-provisioned DB',
    Array.isArray(d?.sources_unavailable) && d.sources_unavailable.length === 0,
    JSON.stringify(d?.sources_unavailable));
}

// ── T5: journey for an order with NO checkout session ───────────────────────
{
  const r = await req('GET', `/${ORPHAN_ID}/journey`);
  const d = r.j?.data;
  check('T5 orphan order → 200 linked:false with an explicit reason',
    r.status === 200 && d?.linked === false && typeof d?.link_reason === 'string'
    && d.link_reason.length > 20, JSON.stringify(d?.link_reason));
  check('T5 orphan still reports the shopify entry, not an empty timeline',
    (d?.entries || []).length === 1 && d.entries[0].source === 'shopify',
    JSON.stringify(d?.entries?.map((e) => e.source)));
  const missing = await req('GET', '/9900000000999/journey');
  check('T5 journey for an unknown order → 404', missing.status === 404, String(missing.status));
}

// ── T6: MANUAL ORDER — the money-path census ────────────────────────────────
{
  const before = {
    co_sessions: (await sql`SELECT COUNT(*)::int n FROM co_sessions`)[0].n,
    co_orders: (await sql`SELECT COUNT(*)::int n FROM co_orders`)[0].n,
    co_upsell_charges: (await sql`SELECT COUNT(*)::int n FROM co_upsell_charges`)[0].n,
    co_events: (await sql`SELECT COUNT(*)::int n FROM co_events`)[0].n,
  };

  const r = await req('POST', '/manual', {
    customer_email: 'manual@local.test',
    customer_first_name: 'Manny',
    customer_last_name: 'Ual',
    currency: 'usd',
    shipping_price: 10,
    line_items: [
      { title: 'Widget', quantity: 2, price: 25 },
      { title: 'Gadget', quantity: 1, price: 15 },
      { title: '', quantity: 3, price: 9 },          // dropped: no title
      { title: 'Bad qty', quantity: 0, price: 9 },   // dropped: qty 0
    ],
    note: 'phone order',
  });
  const order = r.j?.data?.order;
  check('T6 manual create → 201', r.status === 201 && !!order, JSON.stringify(r.j));
  check('T6 response states money_moved:false', r.j?.data?.money_moved === false, JSON.stringify(r.j?.data?.money_moved));
  check('T6 source = manual', order?.source === 'manual', order?.source);
  check('T6 order_id is NEGATIVE (cannot collide with a Shopify id)',
    Number(order?.order_id) < 0, String(order?.order_id));
  check('T6 shopify_order_id is NULL — never a store order',
    order?.shopify_order_id == null, String(order?.shopify_order_id));
  check('T6 invalid line items dropped, total computed server-side (25*2+15+10=75)',
    Number(order?.total_price) === 75 && order?.item_count === 3,
    `total=${order?.total_price} items=${order?.item_count}`);
  check('T6 currency upper-cased', order?.currency === 'USD', order?.currency);

  const after = {
    co_sessions: (await sql`SELECT COUNT(*)::int n FROM co_sessions`)[0].n,
    co_orders: (await sql`SELECT COUNT(*)::int n FROM co_orders`)[0].n,
    co_upsell_charges: (await sql`SELECT COUNT(*)::int n FROM co_upsell_charges`)[0].n,
    co_events: (await sql`SELECT COUNT(*)::int n FROM co_events`)[0].n,
  };
  check('T6 RUNTIME CENSUS: ZERO rows written to co_sessions/co_orders/co_upsell_charges/co_events',
    after.co_sessions === before.co_sessions && after.co_orders === before.co_orders
    && after.co_upsell_charges === before.co_upsell_charges && after.co_events === before.co_events,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // The manual row itself must carry no settlement identity.
  const [raw] = await sql`SELECT gateway, client_order_id, order_type, shopify_order_id, raw
                          FROM crm_orders WHERE order_id = ${order.order_id}`;
  check('T6 stored row: gateway=manual, order_type=MANUAL, no client_order_id',
    raw?.gateway === 'manual' && raw?.order_type === 'MANUAL' && raw?.client_order_id === null
    && raw?.shopify_order_id === null, JSON.stringify(raw));
  check('T6 audit event written to crm_order_events',
    (await sql`SELECT COUNT(*)::int n FROM crm_order_events
               WHERE order_id = ${order.order_id} AND kind = 'manual_create'`)[0].n === 1);

  // It flows into the list and the export like any other row.
  const list = await req('GET', '/?limit=100&source=manual');
  check('T6 manual order appears in the list under source=manual',
    list.j?.data?.orders?.some((o) => String(o.order_id) === String(order.order_id)),
    JSON.stringify(list.j?.data?.total));
  const csv = await req('GET', '/export?source=manual');
  check('T6 manual order appears in the CSV export with a source column',
    csv.status === 200 && csv.text.includes(',source') && csv.text.includes('manual'),
    csv.text.slice(0, 120));

  // And its detail + journey pages open despite the negative id.
  const det = await req('GET', `/${order.order_id}`);
  check('T6 manual order detail opens (negative id survives the :id guard)',
    det.status === 200 && String(det.j?.data?.order?.order_id) === String(order.order_id),
    String(det.status));
  const jr = await req('GET', `/${order.order_id}/journey`);
  check('T6 manual order journey → linked:false (it has no session, by design)',
    jr.status === 200 && jr.j?.data?.linked === false, JSON.stringify(jr.j?.data?.linked));
}

// ── T7: needs-review ────────────────────────────────────────────────────────
{
  await sql`UPDATE co_sessions SET needs_review_reason = 'shopify_create_failed' WHERE id = ${SID}`;
  await sql`UPDATE co_orders SET shopify_status = 'needs_review', shopify_error = 'HTTP 422 variant not found'
            WHERE id = ${CO_ORDER_ID}`;

  const r = await req('GET', '/needs-review');
  const d = r.j?.data;
  check('T7 needs-review 200', r.status === 200, String(r.status));

  const sess = (d?.sessions || []).find((s) => s.session_id === SID);
  check('T7 session surfaced WITH its verbatim reason string',
    sess?.reason === 'shopify_create_failed', JSON.stringify(sess?.reason));
  check('T7 session row carries the customer email + gateway for triage',
    sess?.customer_email === 'buyer@local.test' && sess?.gateway === 'whop', JSON.stringify(sess));

  const uc = (d?.upsell_charges || []).find((c) => c.session_id === SID);
  check('T7 failed upsell charge surfaced with status needs_review',
    uc?.status === 'needs_review' && Number(uc?.amount) === 59, JSON.stringify(uc));

  const so = (d?.shopify_creates || []).find((o) => o.session_id === SID);
  check('T7 failed shopify create surfaced with its error string',
    so?.shopify_status === 'needs_review' && String(so?.shopify_error).includes('422'),
    JSON.stringify(so?.shopify_error));

  check('T7 counts + sources_unavailable reported',
    d?.counts?.sessions >= 1 && d?.counts?.upsell_charges >= 1 && d?.counts?.shopify_creates >= 1
    && Array.isArray(d?.sources_unavailable) && d.sources_unavailable.length === 0,
    JSON.stringify(d?.counts));

  // Read-only: the queue must not have mutated anything it listed.
  const [still] = await sql`SELECT needs_review_reason FROM co_sessions WHERE id = ${SID}`;
  check('T7 READ-ONLY — listing did not clear the reason',
    still?.needs_review_reason === 'shopify_create_failed', still?.needs_review_reason);
}

// ── T8: edge cases ──────────────────────────────────────────────────────────
{
  const badSort = await req('GET', '/?sort=total_price;DROP TABLE crm_orders--:asc');
  check('T8 injection-shaped sort key falls back to the default, no error',
    badSort.status === 200 && badSort.j?.data?.sort === 'created_at:desc', JSON.stringify(badSort.j?.data?.sort));
  const [tableStill] = await sql`SELECT to_regclass('crm_orders') IS NOT NULL AS ok`;
  check('T8 crm_orders still exists after the injection-shaped sort', tableStill?.ok === true);

  const goodSort = await req('GET', '/?sort=total_price:asc&limit=100');
  const totals = (goodSort.j?.data?.orders || []).map((o) => Number(o.total_price));
  check('T8 whitelisted sort is actually applied (ascending totals)',
    goodSort.j?.data?.sort === 'total_price:asc'
    && totals.every((t, i) => i === 0 || t >= totals[i - 1]), JSON.stringify(totals));

  const noItems = await req('POST', '/manual', { customer_email: 'x@y.z', line_items: [] });
  check('T8 manual with no valid line items → 400', noItems.status === 400, String(noItems.status));
  const noEmail = await req('POST', '/manual', { line_items: [{ title: 'a', quantity: 1, price: 5 }] });
  check('T8 manual with no customer email → 400', noEmail.status === 400, String(noEmail.status));
  const malformed = await req('POST', '/manual', { customer_email: 'x@y.z', line_items: 'not-an-array' });
  check('T8 manual with a malformed line_items type → 400, no crash',
    malformed.status === 400, String(malformed.status));
  const negTotal = await req('POST', '/manual', {
    customer_email: 'x@y.z', total_discounts: 9999,
    line_items: [{ title: 'a', quantity: 1, price: 5 }],
  });
  check('T8 manual whose discounts exceed the subtotal → 400', negTotal.status === 400, String(negTotal.status));

  const nonNumeric = await req('GET', '/not-a-number');
  check('T8 non-numeric :id → 404, NOT a BIGINT cast 500', nonNumeric.status === 404,
    `${nonNumeric.status} ${nonNumeric.text.slice(0, 80)}`);
  const nonNumericJourney = await req('GET', '/not-a-number/journey');
  check('T8 non-numeric :id journey → 404 too', nonNumericJourney.status === 404, String(nonNumericJourney.status));

  const emptyName = await req('POST', '/views', { name: '   ' });
  check('T8 saved view with a blank name → 400', emptyName.status === 400, String(emptyName.status));
  const longName = await req('POST', '/views', { name: 'z'.repeat(500) });
  check('T8 over-long view name is truncated to 60, not rejected mid-write',
    longName.status === 201 && longName.j?.data?.view?.name?.length === 60,
    String(longName.j?.data?.view?.name?.length));
}

// ── T9: grep-proof — no money-path coupling ─────────────────────────────────
{
  const src = readFileSync(resolve(HERE, '../../src/routes/orders.js'), 'utf8');
  const jsrc = readFileSync(resolve(HERE, '../../src/services/orderJourney.js'), 'utf8');
  const forbiddenImport = /^import[^\n]*from\s+['"][^'"]*(checkoutSettle|checkoutPublic|gatewayWebhooks|moneySweeps|shopifyOrderCreate|shopifyRefund|gatewayConfigs)[^'"]*['"]/m;
  check('T9 orders.js imports NO checkout/gateway/settle module',
    !forbiddenImport.test(src), (src.match(forbiddenImport) || [''])[0]);
  check('T9 orderJourney.js imports NO checkout/gateway/settle module',
    !forbiddenImport.test(jsrc), (jsrc.match(forbiddenImport) || [''])[0]);

  // The journey service must be read-only: no write verb against any table.
  const writeVerb = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
  check('T9 orderJourney.js contains NO write statement of any kind',
    !writeVerb.test(jsrc), (jsrc.match(writeVerb) || [''])[0]);

  // The manual-order handler must never write to a money-path table.
  const manualBlock = src.slice(src.indexOf("router.post('/manual'"), src.indexOf("// GET /api/v1/orders/:id — full detail"));
  check('T9 the /manual handler names no money-path table',
    manualBlock.length > 500 && !/co_sessions|co_orders|co_upsell_charges|co_events/.test(manualBlock),
    (manualBlock.match(/co_sessions|co_orders|co_upsell_charges|co_events/) || [''])[0]);
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await cleanup();
await sql`DELETE FROM user_roles WHERE user_id IN ('u_ord_a','u_ord_b')`;
await sql`DELETE FROM roles WHERE id = 'r_ord_test'`;
await sql`DELETE FROM users WHERE id IN ('u_ord_a','u_ord_b')`;
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
