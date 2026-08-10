// ORDER EDIT verification — drives the REAL /api/v1/order-edit router (real
// authenticate + requirePermission + ensureTables) against embedded PG on 5433,
// same shape as server/tests/orders/orders-extras.mjs.
//
// Shopify is MOCKED at the fetch boundary (the Admin GraphQL pricing call and
// the Order Editing writes), so the authoritative-re-pricing behaviour is
// proved rather than assumed, and both of its failure classes are driven.
//
// Proves BY EXECUTION:
//   E1  every endpoint refuses an unauthenticated request (401)
//   E2  preview re-prices an added line SERVER-SIDE and ignores the client price
//   E3  the two pricing failure classes stay distinct: 422 invalid_variant vs
//       RETRYABLE 503 pricing_unavailable
//   E4  commit writes an immutable v1 row, mirrors the snapshot, and leaves
//       co_sessions.total (the captured amount) UNTOUCHED
//   E5  a second edit appends v2 and leaves the v1 row byte-identical
//   E6  a replayed edit_id returns the ORIGINAL result and writes nothing new
//   E7  a stale base_version is refused 409 (the unique index arbitrates)
//   E8  needs-settlement rows: 'charge' on an increase, 'refund' on a decrease,
//       NONE below the epsilon; amount is always a positive magnitude
//   E9  resolving a settlement is an atomic claim — the second resolve 409s
//   E10 address edit normalizes into OUR stored shape; a blank address1 is
//       refused, not silently applied
//   E11 NULL vs 0 — an existing line with a null price fails 'unpriced_line'
//       instead of contributing 0 to a subtotal
//   E12 refused states: refunded session, fulfilled order
//   E13 Shopify push: skipped when disarmed, 'pushed' against a mocked store,
//       'needs_review' on a mocked failure — and the edit still stands
//   E14 malformed input is refused with a NAMED error, never a 500
//   E15 by-order resolves the order→session chain, and reports linked:false
//       with a reason for an order that never came through checkout
//   E16 grep-proof: this lane never writes co_sessions.total and imports no
//       settle/webhook module
//
// Run:  node server/tests/orders/order-edit.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_orderedit';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.PUURE_SHOPIFY_STORE = 'test-shop.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_test_token';
delete process.env.SHOPIFY_ORDER_EDIT_ENABLED;
delete process.env.CHECKOUT_BASE_CURRENCY;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// Evict any stale backend from a harness that died mid-run — otherwise the
// DDL below fails 55006 object_in_use and the failure reads exactly like one
// caused by the code under test.
{
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`;
  if (n > 0) {
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    console.log(`bootstrap: terminated ${n} stale backend(s)`);
  }
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── MOCK SHOPIFY ────────────────────────────────────────────────────────────
// One catalog, one switchable transport mode, one op log. Everything that is
// not the mocked store host falls through to the real fetch (the harness's own
// HTTP calls to 127.0.0.1 go through this same function).
const realFetch = globalThis.fetch;
const CATALOG = {
  '111': { price: '19.00', title: 'Small', product: 'Widget', status: 'ACTIVE', available: true },
  '222': { price: '45.50', title: 'Large', product: 'Widget', status: 'ACTIVE', available: true },
  '333': { price: '7.25', title: 'Add-on', product: 'Sticker', status: 'ACTIVE', available: true },
  '444': { price: '99.00', title: 'Draft', product: 'Hidden', status: 'DRAFT', available: true },
};
const shopify = {
  mode: 'ok',          // 'ok' | 'transport' | 'http500'
  currency: 'USD',
  ops: [],
  editMode: 'ok',      // 'ok' | 'begin_error' | 'commit_error' | 'transport'
};
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes('test-shop.myshopify.com')) return realFetch(url, init);
  const body = init?.body ? JSON.parse(init.body) : {};

  // ── REST: order address PUT ──
  if (/\/orders\/\d+\.json$/.test(u) && init?.method === 'PUT') {
    shopify.ops.push({ op: 'address_put', body });
    if (shopify.editMode === 'transport') throw Object.assign(new Error('boom'), { name: 'FetchError' });
    if (shopify.editMode === 'address_error') return jsonResp({ errors: { address1: ['is invalid'] } }, 422);
    return jsonResp({ order: { id: 1, shipping_address: body.order.shipping_address } });
  }

  if (!u.endsWith('/graphql.json')) return jsonResp({}, 404);
  const q = String(body.query || '');

  // ── GraphQL: the pricing query (checkoutPricing) ──
  if (q.includes('query variantPrices')) {
    shopify.ops.push({ op: 'price', ids: body.variables.ids });
    if (shopify.mode === 'transport') throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    if (shopify.mode === 'http500') return jsonResp({}, 500);
    const nodes = body.variables.ids.map((gid) => {
      const num = gid.split('/').pop();
      const v = CATALOG[num];
      if (!v) return null; // unknown variant — Shopify returns a null node
      return {
        id: gid, title: v.title, price: v.price, compareAtPrice: null,
        availableForSale: v.available, image: null,
        product: { id: `gid://shopify/Product/${num}`, title: v.product, status: v.status, featuredImage: null },
      };
    });
    return jsonResp({ data: { shop: { currencyCode: shopify.currency }, nodes } });
  }

  // ── GraphQL: the Order Editing mutations ──
  if (shopify.editMode === 'transport') throw Object.assign(new Error('boom'), { name: 'FetchError' });
  if (q.includes('mutation editBegin')) {
    shopify.ops.push({ op: 'begin' });
    if (shopify.editMode === 'begin_error') {
      return jsonResp({ data: { orderEditBegin: { calculatedOrder: null, userErrors: [{ field: ['id'], message: 'Order not editable' }] } } });
    }
    return jsonResp({ data: { orderEditBegin: { calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1' }, userErrors: [] } } });
  }
  if (q.includes('mutation editAdd')) {
    shopify.ops.push({ op: 'add', variantId: body.variables.variantId, quantity: body.variables.quantity });
    return jsonResp({ data: { orderEditAddVariant: { calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1' }, userErrors: [] } } });
  }
  if (q.includes('query calcLines')) {
    shopify.ops.push({ op: 'list' });
    return jsonResp({ data: { node: { id: 'gid://shopify/CalculatedOrder/1', lineItems: { edges: [
      { node: { id: 'gid://shopify/CalculatedLineItem/1', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/111' } } },
      { node: { id: 'gid://shopify/CalculatedLineItem/2', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/222' } } },
    ] } } } });
  }
  if (q.includes('mutation editQty')) {
    shopify.ops.push({ op: 'set_qty', lineItemId: body.variables.lineItemId, quantity: body.variables.quantity });
    return jsonResp({ data: { orderEditSetQuantity: { calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1' }, userErrors: [] } } });
  }
  if (q.includes('mutation editCommit')) {
    shopify.ops.push({ op: 'commit' });
    if (shopify.editMode === 'commit_error') {
      return jsonResp({ data: { orderEditCommit: { order: null, userErrors: [{ field: [], message: 'Order was modified' }] } } });
    }
    return jsonResp({ data: { orderEditCommit: { order: { id: 'gid://shopify/Order/9911' }, userErrors: [] } } });
  }
  return jsonResp({ data: {} });
};

// ── seed auth ───────────────────────────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name)
  VALUES ('u_oe_a', 'oea@local.test', 'Edit', 'Alpha') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions)
  VALUES ('r_oe_test', 'oe-tester', '{"orders": ["access"]}')
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_oe_a'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_oe_a','r_oe_test')`;

const orderEditRouter = (await import('../../src/routes/orderEdit.js')).default;
const ordersRouter = (await import('../../src/routes/orders.js')).default;
const svc = await import('../../src/services/orderEditService.js');
const pushSvc = await import('../../src/services/shopifyOrderEdit.js');
const { clearPriceCache } = await import('../../src/services/checkoutPricing.js');

const app = express();
app.use(express.json());
app.use('/api/v1/order-edit', orderEditRouter);
app.use('/api/v1/orders', ordersRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/order-edit`;

const HA = {
  Authorization: `Bearer ${jwt.sign({ userId: 'u_oe_a' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' })}`,
  'Content-Type': 'application/json',
};
const NOAUTH = { 'Content-Type': 'application/json' };

const req = async (method, path, body, headers = HA) => {
  const r = await realFetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

// ── fixtures ────────────────────────────────────────────────────────────────
const SID = 'co_oe_main';
const SID_UNPRICED = 'co_oe_unpriced';
const SID_REFUNDED = 'co_oe_refunded';
const SID_FULFILLED = 'co_oe_fulfilled';
const SID_PUSH = 'co_oe_push';
const SHOPIFY_ID = 9911000000001;
const FULFILLED_SHOPIFY_ID = 9911000000002;
const ORPHAN_ID = 9911000000003;
const PUSH_SHOPIFY_ID = 9911000000004;
const ALL_SIDS = [SID, SID_UNPRICED, SID_REFUNDED, SID_FULFILLED, SID_PUSH];

const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
await ensureCheckoutTables();
await svc.ensureOrderEditTables();

const cleanup = async () => {
  await sql`DELETE FROM co_order_edit_settlements WHERE session_id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM co_order_edit_pushes WHERE session_id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM co_order_edits WHERE session_id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM co_events WHERE session_id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM co_orders WHERE session_id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM co_sessions WHERE id = ANY(${ALL_SIDS})`;
  await sql`DELETE FROM crm_orders WHERE order_id IN (${SHOPIFY_ID}, ${FULFILLED_SHOPIFY_ID}, ${ORPHAN_ID}, ${PUSH_SHOPIFY_ID})`;
};

// One authed call so routes/orders.js's ensureTables creates crm_orders.
await realFetch(`http://127.0.0.1:${PORT}/api/v1/orders?limit=1`, { headers: HA });
await cleanup();

const LINES = [
  { variant_id: '111', quantity: 2, price: 19.00, currency: 'USD', title: 'Small', product_title: 'Widget', line_total: 38.00 },
  { variant_id: '222', quantity: 1, price: 45.50, currency: 'USD', title: 'Large', product_title: 'Widget', line_total: 45.50 },
];
// subtotal 83.50 + shipping 5 + tax 4 - discount 2.50 = 90.00 captured
const seedSession = async (id, over = {}) => {
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, subtotal, shipping, tax,
      discount_amount, total, currency, customer, gateway, payment_method_id, paid_at)
    VALUES (${id}, 'f_oe', ${over.status || 'paid'}, ${sql.json(over.line_items || LINES)},
      ${over.subtotal ?? 83.50}, 5.00, 4.00, 2.50, ${over.total ?? 90.00}, 'USD',
      ${sql.json(over.customer || { email: 'buyer@local.test', first_name: 'Bee',
        shipping: { address1: '1 Old St', address2: '', city: 'Madrid', state: 'M', zip: '28001', country: 'ES' } })},
      'whop', 'pm_saved_1', NOW())`;
};

await seedSession(SID);
await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency, shopify_order_id, shopify_status)
  VALUES ('coo_oe_main', ${SID}, 'idem_oe_main', 'whop', 90.00, 'USD', ${String(SHOPIFY_ID)}, 'created')`;
await sql`INSERT INTO crm_orders (order_id, order_number, financial_status, fulfillment_status,
    total_price, currency, customer_email, shopify_order_id, source)
  VALUES (${SHOPIFY_ID}, '#2001', 'paid', 'unfulfilled', 90.00, 'USD', 'buyer@local.test', ${SHOPIFY_ID}, 'shopify'),
         (${ORPHAN_ID}, '#2003', 'paid', 'unfulfilled', 10.00, 'USD', 'x@local.test', ${ORPHAN_ID}, 'shopify')`;

// ════════════════════════════════════════════════════════════════════════════
// E1 — auth
// ════════════════════════════════════════════════════════════════════════════
{
  const paths = [
    ['GET', `/${SID}`], ['POST', `/${SID}/preview`], ['POST', `/${SID}/commit`],
    ['GET', '/settlements'], ['POST', '/settlements/x/resolve'], ['GET', `/by-order/${SHOPIFY_ID}`],
  ];
  let all401 = true; const seen = [];
  for (const [m, p] of paths) {
    const r = await req(m, p, m === 'GET' ? undefined : {}, NOAUTH);
    seen.push(`${m} ${p}=${r.status}`);
    if (r.status !== 401) all401 = false;
  }
  check('E1 every order-edit endpoint 401s without a token', all401, seen.join(' '));
}

// ════════════════════════════════════════════════════════════════════════════
// E2 — preview re-prices server-side
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  shopify.ops = [];
  // The client SHOUTS a price of 0.01 for variant 333. The server must charge
  // the catalog price 7.25 regardless.
  const r = await req('POST', `/${SID}/preview`, {
    add_lines: [{ variant_id: '333', quantity: 2, price: 0.01, title: 'Sticker' }],
  });
  const d = r.j?.data;
  const added = (d?.changes || []).find((c) => c.variant_id === '333');
  check('E2 preview 200', r.status === 200, JSON.stringify(r.j).slice(0, 200));
  check('E2 the CLIENT price is ignored — the line is priced at the catalog 7.25',
    added?.price === 7.25, JSON.stringify(added));
  check('E2 subtotal moves by 2 x 7.25 = 14.50',
    d?.subtotal_before === 83.5 && d?.subtotal_after === 98 && d?.subtotal_delta === 14.5,
    `${d?.subtotal_before}/${d?.subtotal_after}/${d?.subtotal_delta}`);
  check('E2 captured_total is reported UNCHANGED at 90 while owed_after rises to 104.50',
    d?.captured_total === 90 && d?.owed_before === 90 && d?.owed_after === 104.5
    && d?.total_delta === 14.5 && d?.cumulative_delta === 14.5,
    `${d?.captured_total}/${d?.owed_before}/${d?.owed_after}/${d?.total_delta}`);
  check('E2 the seam is a CHARGE of the positive magnitude',
    d?.settlement?.direction === 'charge' && d?.settlement?.amount === 14.5, JSON.stringify(d?.settlement));
  check('E2 preview WROTE NOTHING — no version row exists yet',
    (await sql`SELECT COUNT(*)::int n FROM co_order_edits WHERE session_id = ${SID}`)[0].n === 0);
  check('E2 exactly one pricing call, for the ADDED variant only',
    shopify.ops.filter((o) => o.op === 'price').length === 1
    && shopify.ops[0].ids.length === 1 && shopify.ops[0].ids[0].endsWith('/333'),
    JSON.stringify(shopify.ops));
}

// ════════════════════════════════════════════════════════════════════════════
// E3 — the two pricing failure classes stay distinct
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const unknown = await req('POST', `/${SID}/preview`, { add_lines: [{ variant_id: '999', quantity: 1 }] });
  check('E3 an unknown variant is 422 invalid_variant',
    unknown.status === 422 && unknown.j?.error === 'invalid_variant', `${unknown.status} ${JSON.stringify(unknown.j)}`);

  clearPriceCache();
  const draft = await req('POST', `/${SID}/preview`, { add_lines: [{ variant_id: '444', quantity: 1 }] });
  check('E3 a DRAFT product is 422 invalid_variant (omitted, never priced)',
    draft.status === 422 && draft.j?.error === 'invalid_variant', `${draft.status} ${JSON.stringify(draft.j)}`);

  clearPriceCache();
  shopify.mode = 'transport';
  const down = await req('POST', `/${SID}/preview`, { add_lines: [{ variant_id: '333', quantity: 1 }] });
  check('E3 a Shopify TRANSPORT failure is a RETRYABLE 503, never a 422',
    down.status === 503 && down.j?.error === 'pricing_unavailable' && down.j?.retryable === true,
    `${down.status} ${JSON.stringify(down.j)}`);

  clearPriceCache();
  shopify.mode = 'http500';
  const five = await req('POST', `/${SID}/commit`, { edit_id: 'never', add_lines: [{ variant_id: '333', quantity: 1 }] });
  check('E3 commit maps the same transport failure to 503 and writes NO version row',
    five.status === 503 && five.j?.error === 'pricing_unavailable'
    && (await sql`SELECT COUNT(*)::int n FROM co_order_edits WHERE session_id = ${SID}`)[0].n === 0,
    `${five.status} ${JSON.stringify(five.j)}`);
  shopify.mode = 'ok';
  clearPriceCache();
}

// ════════════════════════════════════════════════════════════════════════════
// E4 — commit v1: immutable row, mirrored snapshot, UNTOUCHED total
// ════════════════════════════════════════════════════════════════════════════
let v1RowJson = null;
{
  clearPriceCache();
  const before = (await sql`SELECT total, subtotal, line_items FROM co_sessions WHERE id = ${SID}`)[0];
  const r = await req('POST', `/${SID}/commit`, {
    edit_id: 'edit-one', base_version: 0,
    add_lines: [{ variant_id: '333', quantity: 2, price: 0.01 }],
  });
  const d = r.j?.data;
  check('E4 commit 200 at version 1', r.status === 200 && d?.version === 1, `${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
  check('E4 the response says money_moved:false', r.j?.money_moved === false);

  const rows = await sql`SELECT * FROM co_order_edits WHERE session_id = ${SID} ORDER BY version`;
  v1RowJson = JSON.stringify(rows[0]);
  check('E4 exactly ONE version row', rows.length === 1 && rows[0].version === 1, `${rows.length}`);
  check('E4 the row carries BOTH snapshots whole (self-contained audit)',
    Array.isArray(rows[0].before_snapshot?.line_items) && rows[0].before_snapshot.line_items.length === 2
    && Array.isArray(rows[0].after_snapshot?.line_items) && rows[0].after_snapshot.line_items.length === 3,
    JSON.stringify(rows[0].before_snapshot).slice(0, 120));
  check('E4 the row carries the DELTA as well as the snapshots',
    Array.isArray(rows[0].delta?.changes) && rows[0].delta.changes.length === 1
    && rows[0].delta.changes[0].kind === 'added', JSON.stringify(rows[0].delta));

  const after = (await sql`SELECT total, subtotal, line_items FROM co_sessions WHERE id = ${SID}`)[0];
  check('E4 co_sessions.total (the CAPTURED amount) is byte-identical after the edit',
    String(after.total) === String(before.total) && Number(after.total) === 90,
    `${before.total} -> ${after.total}`);
  check('E4 co_sessions.line_items and subtotal ARE mirrored',
    after.line_items.length === 3 && Number(after.subtotal) === 98,
    `${after.line_items.length} / ${after.subtotal}`);
  check('E4 an audit event was written',
    (await sql`SELECT COUNT(*)::int n FROM co_events WHERE session_id = ${SID} AND kind = 'order_edited'`)[0].n === 1);
}

// ════════════════════════════════════════════════════════════════════════════
// E5 — append-only: v2 appends, v1 untouched
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const r = await req('POST', `/${SID}/commit`, {
    edit_id: 'edit-two', base_version: 1, line_edits: [{ variant_id: '111', quantity: 1 }],
  });
  check('E5 second edit lands at version 2', r.status === 200 && r.j?.data?.version === 2,
    `${r.status} ${JSON.stringify(r.j).slice(0, 200)}`);
  const rows = await sql`SELECT * FROM co_order_edits WHERE session_id = ${SID} ORDER BY version`;
  check('E5 there are now TWO rows, versions 1 and 2',
    rows.length === 2 && rows[0].version === 1 && rows[1].version === 2, `${rows.length}`);
  check('E5 the v1 row is BYTE-IDENTICAL — nothing was updated in place',
    JSON.stringify(rows[0]) === v1RowJson,
    `${v1RowJson}\n  vs\n  ${JSON.stringify(rows[0])}`);
  check('E5 v2 records base_version 1 (the chain is explicit, not inferred)',
    rows[1].base_version === 1);
  check('E5 v2 before_snapshot equals v1 after_snapshot line items (the chain is continuous)',
    JSON.stringify(rows[1].before_snapshot.line_items) === JSON.stringify(rows[0].after_snapshot.line_items));
}

// ════════════════════════════════════════════════════════════════════════════
// E6 — replay
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const beforeCount = (await sql`SELECT COUNT(*)::int n FROM co_order_edits WHERE session_id = ${SID}`)[0].n;
  const beforeSettle = (await sql`SELECT COUNT(*)::int n FROM co_order_edit_settlements WHERE session_id = ${SID}`)[0].n;
  const r = await req('POST', `/${SID}/commit`, {
    edit_id: 'edit-one', base_version: 2, add_lines: [{ variant_id: '333', quantity: 2 }],
  });
  check('E6 a replayed edit_id returns replayed:true at the ORIGINAL version 1',
    r.status === 200 && r.j?.data?.replayed === true && r.j?.data?.version === 1,
    `${r.status} ${JSON.stringify(r.j).slice(0, 250)}`);
  const afterCount = (await sql`SELECT COUNT(*)::int n FROM co_order_edits WHERE session_id = ${SID}`)[0].n;
  const afterSettle = (await sql`SELECT COUNT(*)::int n FROM co_order_edit_settlements WHERE session_id = ${SID}`)[0].n;
  check('E6 the replay wrote NO new version row and NO second settlement',
    afterCount === beforeCount && afterSettle === beforeSettle,
    `edits ${beforeCount}->${afterCount} settlements ${beforeSettle}->${afterSettle}`);
}

// ════════════════════════════════════════════════════════════════════════════
// E7 — stale base_version
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const r = await req('POST', `/${SID}/commit`, {
    edit_id: 'edit-stale', base_version: 0, line_edits: [{ variant_id: '222', quantity: 3 }],
  });
  check('E7 a stale base_version is refused 409 stale_version, naming the current one',
    r.status === 409 && r.j?.error === 'stale_version' && r.j?.current_version === 2,
    `${r.status} ${JSON.stringify(r.j)}`);
  check('E7 the refused edit wrote nothing',
    (await sql`SELECT COUNT(*)::int n FROM co_order_edits WHERE session_id = ${SID}`)[0].n === 2);
}

// ════════════════════════════════════════════════════════════════════════════
// E8 — the money seam
// ════════════════════════════════════════════════════════════════════════════
{
  const rows = await sql`SELECT * FROM co_order_edit_settlements WHERE session_id = ${SID} ORDER BY version`;
  check('E8 v1 (an INCREASE of 14.50) produced a CHARGE settlement of +14.50',
    rows[0]?.direction === 'charge' && Number(rows[0].amount) === 14.5 && rows[0].status === 'needs_settlement',
    JSON.stringify(rows[0]));
  // v2 dropped variant 111 from qty 2 to 1: owed 104.50 → 85.50. THIS EDIT'S
  // impact is -19.00 — NOT -4.50. Measuring against the captured 90 would
  // re-book v1's still-open +14.50 a second time.
  check('E8 v2 (a DECREASE) is booked at ITS OWN impact 19.00, not the cumulative 4.50',
    rows[1]?.direction === 'refund' && Number(rows[1].amount) === 19,
    JSON.stringify(rows[1]));

  // Below the epsilon: an edit whose money impact is arithmetic noise.
  check('E8 settlementDirection() is null strictly inside the epsilon band',
    svc.settlementDirection(0) === null && svc.settlementDirection(0.004) === null
    && svc.settlementDirection(-0.004) === null && svc.settlementDirection(0.01) === 'charge'
    && svc.settlementDirection(-0.01) === 'refund');

  const q = await req('GET', '/settlements?status=needs_settlement');
  check('E8 the settlement queue lists both, with per-direction exposure (never a net)',
    q.status === 200 && q.j?.data?.total === 2
    && q.j.data.totals.charge_total === 14.5 && q.j.data.totals.refund_total === 19,
    JSON.stringify(q.j?.data?.totals));

  const state = await req('GET', `/${SID}`);
  check('E8 the order surface reports the open seam count and signed net exposure',
    state.j?.data?.open_settlement_count === 2 && state.j.data.open_settlement_net === -4.5,
    `${state.j?.data?.open_settlement_count} / ${state.j?.data?.open_settlement_net}`);
  // THE AUDIT IDENTITY: with every settlement still open, the per-edit deltas
  // must sum EXACTLY to the divergence between money taken and goods owed.
  check('E8 sum(open settlements) === owed_now − captured_total (the seam balances)',
    state.j.data.open_settlement_net === state.j.data.session.cumulative_delta
    && state.j.data.session.owed_now === 85.5 && state.j.data.session.captured_total === 90,
    `${state.j.data.open_settlement_net} vs ${state.j.data.session.cumulative_delta}`);
}

// ════════════════════════════════════════════════════════════════════════════
// E9 — resolving is an atomic claim
// ════════════════════════════════════════════════════════════════════════════
{
  const [row] = await sql`SELECT edit_row_id FROM co_order_edit_settlements
    WHERE session_id = ${SID} AND direction = 'charge'`;
  const a = await req('POST', `/settlements/${row.edit_row_id}/resolve`, {
    action: 'settled', gateway_payment_id: 'pay_123', settled_amount: 14.5, note: 'charged by hand',
  });
  check('E9 the first resolve wins and reports money_moved:false',
    a.status === 200 && a.j?.data?.status === 'settled' && a.j?.money_moved === false,
    `${a.status} ${JSON.stringify(a.j)}`);
  const b = await req('POST', `/settlements/${row.edit_row_id}/resolve`, { action: 'waived' });
  check('E9 the SECOND resolve is refused 409 not_open, naming the current status',
    b.status === 409 && b.j?.error === 'not_open' && b.j?.current_status === 'settled',
    `${b.status} ${JSON.stringify(b.j)}`);
  const bad = await req('POST', `/settlements/${row.edit_row_id}/resolve`, { action: 'refund_it_all' });
  check('E9 an unknown action is 400 bad_action, never a silent no-op',
    bad.status === 400 && bad.j?.error === 'bad_action', `${bad.status} ${JSON.stringify(bad.j)}`);
  const missing = await req('POST', `/settlements/oe_nope/resolve`, { action: 'settled' });
  check('E9 resolving a settlement that does not exist is 404', missing.status === 404);
}

// ════════════════════════════════════════════════════════════════════════════
// E10 — address editing
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const blank = await req('POST', `/${SID}/preview`, { shipping_address: { address1: '   ', city: 'Madrid' } });
  check('E10 a blank address1 is refused invalid_address, never applied as a partial',
    blank.status === 422 && blank.j?.error === 'invalid_address', `${blank.status} ${JSON.stringify(blank.j)}`);

  const same = await req('POST', `/${SID}/preview`, {
    shipping_address: { address1: '1 Old St', address2: '', city: 'Madrid', state: 'M', zip: '28001', country: 'ES' },
  });
  check('E10 re-submitting the SAME address is not dirty (no fake audit row)',
    same.status === 200 && same.j?.data?.address_changed === false && same.j?.data?.dirty === false,
    JSON.stringify(same.j?.data?.address_changed));

  const r = await req('POST', `/${SID}/commit`, {
    edit_id: 'edit-addr', base_version: 2,
    shipping_address: { address1: '9 New Ave', city: 'Lisbon', state: 'L', zip: '1000', country: 'PT', ignored: 'x' },
  });
  check('E10 an address-only edit commits at v3 with NO settlement (goods unchanged)',
    r.status === 200 && r.j?.data?.version === 3 && r.j?.data?.settlement === null
    && r.j?.data?.address_changed === true, `${r.status} ${JSON.stringify(r.j?.data).slice(0, 250)}`);

  const [s] = await sql`SELECT customer FROM co_sessions WHERE id = ${SID}`;
  check('E10 the address landed in OUR stored shape under customer.shipping',
    s.customer.shipping.address1 === '9 New Ave' && s.customer.shipping.city === 'Lisbon'
    && s.customer.shipping.country === 'PT' && s.customer.shipping.ignored === undefined,
    JSON.stringify(s.customer.shipping));
  check('E10 the rest of the customer object survived the address write',
    s.customer.email === 'buyer@local.test' && s.customer.first_name === 'Bee', JSON.stringify(s.customer));

  // Reference-shaped keys must map onto ours rather than be dropped.
  const norm = svc.normalizeShippingAddress({ address1: 'x', province_code: 'CA', country_code: 'US', postal_code: '90210' });
  check('E10 reference-shaped keys (province_code/country_code/postal_code) map onto our fields',
    norm.ok && norm.address.state === 'CA' && norm.address.country === 'US' && norm.address.zip === '90210',
    JSON.stringify(norm));
}

// ════════════════════════════════════════════════════════════════════════════
// E11 — NULL vs 0
// ════════════════════════════════════════════════════════════════════════════
{
  await seedSession(SID_UNPRICED, {
    line_items: [
      { variant_id: '111', quantity: 2, price: 19.00 },
      { variant_id: '222', quantity: 1, price: null },
    ],
  });
  clearPriceCache();
  const r = await req('POST', `/${SID_UNPRICED}/preview`, { line_edits: [{ variant_id: '111', quantity: 1 }] });
  check('E11 an existing line with a NULL price fails unpriced_line — it is not worth 0',
    r.status === 422 && r.j?.error === 'unpriced_line' && (r.j?.unpriced || []).includes('222'),
    `${r.status} ${JSON.stringify(r.j)}`);

  const pure = svc.subtotalOf([{ variant_id: 'a', quantity: 1, price: 0 }]);
  check('E11 a genuine ZERO price is valid and sums to 0 (0 and null are different facts)',
    pure.ok === true && pure.subtotal === 0, JSON.stringify(pure));
  const nullish = svc.subtotalOf([{ variant_id: 'a', quantity: 1, price: null }]);
  check('E11 a NULL price is reported, not summed', nullish.ok === false && nullish.unpriced[0] === 'a');
}

// ════════════════════════════════════════════════════════════════════════════
// E12 — refused states
// ════════════════════════════════════════════════════════════════════════════
{
  await seedSession(SID_REFUNDED, { status: 'refunded' });
  clearPriceCache();
  const r = await req('POST', `/${SID_REFUNDED}/commit`, {
    edit_id: 'edit-refunded', line_edits: [{ variant_id: '111', quantity: 1 }],
  });
  check('E12 a REFUNDED session is 409 not_editable (its money is being unwound)',
    r.status === 409 && r.j?.error === 'not_editable' && r.j?.detail === 'status:refunded',
    `${r.status} ${JSON.stringify(r.j)}`);

  await seedSession(SID_FULFILLED);
  await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency, shopify_order_id)
    VALUES ('coo_oe_ful', ${SID_FULFILLED}, 'idem_oe_ful', 'whop', 90.00, 'USD', ${String(FULFILLED_SHOPIFY_ID)})`;
  await sql`INSERT INTO crm_orders (order_id, order_number, financial_status, fulfillment_status,
      total_price, currency, shopify_order_id, source)
    VALUES (${FULFILLED_SHOPIFY_ID}, '#2002', 'paid', 'fulfilled', 90.00, 'USD', ${FULFILLED_SHOPIFY_ID}, 'shopify')`;
  clearPriceCache();
  const f = await req('POST', `/${SID_FULFILLED}/commit`, {
    edit_id: 'edit-ful', line_edits: [{ variant_id: '111', quantity: 1 }],
  });
  check('E12 a FULFILLED order is 409 already_fulfilled (the goods left the building)',
    f.status === 409 && f.j?.error === 'already_fulfilled', `${f.status} ${JSON.stringify(f.j)}`);
  const st = await req('GET', `/${SID_FULFILLED}`);
  check('E12 the read surface says editable:false with the reason named',
    st.j?.data?.editable === false && st.j?.data?.not_editable_reason === 'already_fulfilled',
    JSON.stringify(st.j?.data?.not_editable_reason));

  const unknown = await req('GET', '/co_does_not_exist');
  check('E12 an unknown session is 404, not a 500', unknown.status === 404);
}

// ════════════════════════════════════════════════════════════════════════════
// E13 — the Shopify push
// ════════════════════════════════════════════════════════════════════════════
{
  await seedSession(SID_PUSH);
  await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency, shopify_order_id)
    VALUES ('coo_oe_push', ${SID_PUSH}, 'idem_oe_push', 'whop', 90.00, 'USD', ${String(PUSH_SHOPIFY_ID)})`;
  await sql`INSERT INTO crm_orders (order_id, order_number, financial_status, fulfillment_status,
      total_price, currency, shopify_order_id, source)
    VALUES (${PUSH_SHOPIFY_ID}, '#2004', 'paid', 'unfulfilled', 90.00, 'USD', ${PUSH_SHOPIFY_ID}, 'shopify')`;

  // (a) DISARMED — the default. No store call at all.
  clearPriceCache(); shopify.ops = [];
  const off = await req('POST', `/${SID_PUSH}/commit`, {
    edit_id: 'push-off', base_version: 0, add_lines: [{ variant_id: '333', quantity: 1 }],
  });
  check('E13a with the push lane disarmed the edit still commits, push_status skipped',
    off.status === 200 && off.j?.data?.push_status === 'skipped'
    && off.j?.data?.push_reason === 'push_disabled', JSON.stringify(off.j?.data?.push_status));
  check('E13a no Shopify EDIT call was made (only the pricing read)',
    shopify.ops.every((o) => o.op === 'price'), JSON.stringify(shopify.ops));

  // (b) ARMED, store healthy.
  process.env.SHOPIFY_ORDER_EDIT_ENABLED = '1';
  clearPriceCache(); shopify.ops = []; shopify.editMode = 'ok';
  const on = await req('POST', `/${SID_PUSH}/commit`, {
    edit_id: 'push-on', base_version: 1,
    line_edits: [{ variant_id: '222', quantity: 4 }],
    shipping_address: { address1: '5 Push Rd', city: 'Porto', country: 'PT' },
  });
  check('E13b armed + healthy store → push_status pushed',
    on.status === 200 && on.j?.data?.push_status === 'pushed', JSON.stringify(on.j?.data).slice(0, 250));
  const ops = shopify.ops.map((o) => o.op);
  check('E13b the ADDRESS (idempotent REST) goes FIRST, then begin→setQty→commit',
    ops[0] === 'address_put' && ops.includes('begin') && ops.includes('list')
    && ops.includes('set_qty') && ops.indexOf('commit') === ops.length - 1, JSON.stringify(ops));
  const [pushRow] = await sql`SELECT * FROM co_order_edit_pushes WHERE session_id = ${SID_PUSH} ORDER BY updated_at DESC LIMIT 1`;
  check('E13b the push outcome is recorded with its op trail',
    pushRow.status === 'pushed' && Array.isArray(pushRow.detail?.ops) && pushRow.detail.ops.length >= 4,
    JSON.stringify(pushRow.detail).slice(0, 200));

  // (c) ARMED, store fails at commit — the edit MUST still stand.
  clearPriceCache(); shopify.ops = []; shopify.editMode = 'commit_error';
  const bad = await req('POST', `/${SID_PUSH}/commit`, {
    edit_id: 'push-fail', base_version: 2, line_edits: [{ variant_id: '111', quantity: 1 }],
  });
  check('E13c a store failure does NOT fail the edit — it lands as needs_review',
    bad.status === 200 && bad.j?.data?.version === 3 && bad.j?.data?.push_status === 'needs_review'
    && /commit_failed/.test(bad.j?.data?.push_reason || ''), JSON.stringify(bad.j?.data).slice(0, 250));
  check('E13c the local snapshot is still mirrored despite the store failure',
    (await sql`SELECT line_items FROM co_sessions WHERE id = ${SID_PUSH}`)[0].line_items
      .find((li) => li.variant_id === '111').quantity === 1);

  // (d) a transport blow-up must not throw out of the push module.
  clearPriceCache(); shopify.editMode = 'transport';
  const t = await pushSvc.pushOrderEdit({
    editRowId: 'oe_x', shopifyOrderId: String(PUSH_SHOPIFY_ID),
    changes: [{ kind: 'added', variant_id: '333', quantity: 1 }],
  });
  check('E13d a transport failure returns needs_review instead of throwing',
    t.status === 'needs_review' && /begin_failed|transport/.test(t.reason), JSON.stringify(t));

  // (e) an ADDRESS failure must stop BEFORE the non-idempotent line commit.
  clearPriceCache(); shopify.ops = []; shopify.editMode = 'address_error';
  const ae = await pushSvc.pushOrderEdit({
    editRowId: 'oe_y', shopifyOrderId: String(PUSH_SHOPIFY_ID),
    changes: [{ kind: 'added', variant_id: '333', quantity: 1 }],
    shippingAddress: { address1: '1 Bad St' },
  });
  check('E13e an address failure aborts BEFORE the additive commit is ever begun',
    ae.status === 'needs_review' && /address_failed/.test(ae.reason)
    && !shopify.ops.some((o) => o.op === 'begin' || o.op === 'commit'),
    `${JSON.stringify(ae)} ops=${JSON.stringify(shopify.ops.map((o) => o.op))}`);

  shopify.editMode = 'ok';
  delete process.env.SHOPIFY_ORDER_EDIT_ENABLED;
}

// ════════════════════════════════════════════════════════════════════════════
// E14 — malformed input
// ════════════════════════════════════════════════════════════════════════════
{
  clearPriceCache();
  const cases = [
    ['no edit_id', { add_lines: [{ variant_id: '333', quantity: 1 }] }, 400, 'edit_id_required'],
    ['edit_id with a slash', { edit_id: 'a/b', add_lines: [{ variant_id: '333', quantity: 1 }] }, 400, 'bad_edit_id'],
    ['an empty edit', { edit_id: 'empty-1' }, 422, 'no_changes'],
    ['a no-op quantity', { edit_id: 'noop-1', line_edits: [{ variant_id: '222', quantity: 1 }] }, 422, 'no_changes'],
    ['a negative base_version', { edit_id: 'neg-1', base_version: -3, line_edits: [{ variant_id: '222', quantity: 5 }] }, 400, 'bad_base_version'],
  ];
  let ok = true; const seen = [];
  for (const [label, body, wantStatus, wantErr] of cases) {
    const r = await req('POST', `/${SID}/commit`, body);
    seen.push(`${label}=${r.status}/${r.j?.error}`);
    if (r.status !== wantStatus || r.j?.error !== wantErr) ok = false;
  }
  check('E14 every malformed body gets a NAMED refusal, never a 500', ok, seen.join(' | '));

  // Garbage that could plausibly throw rather than be refused.
  const weird = await req('POST', `/${SID}/preview`, {
    add_lines: 'not-an-array', line_edits: [{ variant_id: null }, { quantity: 'x' }],
    shipping_address: [],
  });
  check('E14 non-array / null-variant / array-address input is refused, not thrown',
    weird.status === 422 && weird.j?.error === 'invalid_address', `${weird.status} ${JSON.stringify(weird.j)}`);

  const bigList = Array.from({ length: 80 }, (_, i) => ({ variant_id: String(1000 + i), quantity: 1 }));
  clearPriceCache();
  const big = await req('POST', `/${SID}/preview`, { add_lines: bigList });
  check('E14 an oversized add list is refused (invalid_variant on the first unknown), not a 500',
    big.status === 422 && ['invalid_variant', 'too_many_lines'].includes(big.j?.error),
    `${big.status} ${JSON.stringify(big.j)}`);

  const badSid = await req('GET', '/this-is-a-very-long-session-id-that-exceeds-the-eighty-character-bound-by-quite-a-lot-indeed');
  check('E14 an over-long session id is 404, never a driver error', badSid.status === 404);
}

// ════════════════════════════════════════════════════════════════════════════
// E15 — by-order resolution
// ════════════════════════════════════════════════════════════════════════════
{
  const linked = await req('GET', `/by-order/${SHOPIFY_ID}`);
  check('E15 by-order resolves the order→co_orders→session chain',
    linked.status === 200 && linked.j?.data?.linked === true
    && linked.j.data.session?.id === SID && linked.j.data.version === 3,
    `${linked.status} ${JSON.stringify(linked.j?.data?.linked)}`);
  check('E15 the history is returned newest-first and is complete',
    linked.j.data.history.length === 3 && linked.j.data.history[0].version === 3
    && linked.j.data.history_capped === false, JSON.stringify(linked.j.data.history.map((h) => h.version)));

  const orphan = await req('GET', `/by-order/${ORPHAN_ID}`);
  check('E15 an order with no checkout session reports linked:false WITH a reason',
    orphan.status === 200 && orphan.j?.data?.linked === false
    && orphan.j.data.reason === 'no_checkout_session_for_this_store_order',
    JSON.stringify(orphan.j?.data));

  const nope = await req('GET', '/by-order/8888888888888');
  check('E15 an unknown order id is 404', nope.status === 404);
  const nonNumeric = await req('GET', '/by-order/abc');
  check('E15 a non-numeric order id is 404, never a BIGINT cast 500', nonNumeric.status === 404);
}

// ════════════════════════════════════════════════════════════════════════════
// E16 — grep-proof
// ════════════════════════════════════════════════════════════════════════════
{
  const svcSrc = readFileSync(resolve(HERE, '../../src/services/orderEditService.js'), 'utf8');
  const routeSrc = readFileSync(resolve(HERE, '../../src/routes/orderEdit.js'), 'utf8');
  const pushSrc = readFileSync(resolve(HERE, '../../src/services/shopifyOrderEdit.js'), 'utf8');

  const forbiddenImport = /^import[^\n]*from\s+['"][^'"]*(checkoutSettle|checkoutPublic|gatewayWebhooks|moneySweeps|gateways\/)[^'"]*['"]/m;
  check('E16 orderEditService imports NO settle/webhook/gateway module',
    !forbiddenImport.test(svcSrc), (svcSrc.match(forbiddenImport) || [''])[0]);
  check('E16 the route file imports NO settle/webhook/gateway module',
    !forbiddenImport.test(routeSrc), (routeSrc.match(forbiddenImport) || [''])[0]);

  // The single most important invariant in this lane, asserted as source text:
  // no statement anywhere sets co_sessions.total.
  const setsTotal = /UPDATE\s+co_sessions[\s\S]{0,400}?\bSET\b[\s\S]{0,400}?(^|[\s,(])total\s*=/im;
  check('E16 NOTHING in this lane writes co_sessions.total',
    !setsTotal.test(svcSrc) && !setsTotal.test(routeSrc),
    (svcSrc.match(setsTotal) || routeSrc.match(setsTotal) || [''])[0]);

  const flipsCharge = /UPDATE\s+co_upsell_charges/i;
  check('E16 this lane never flips a co_upsell_charges status',
    !flipsCharge.test(svcSrc) && !flipsCharge.test(routeSrc));

  check('E16 the Shopify push module is opt-in by construction (returns false without the flag)',
    /SHOPIFY_ORDER_EDIT_ENABLED\s*!==\s*'1'/.test(pushSrc) && pushSvc.shopifyOrderEditEnabled() === false);

  // co_order_edits must be written exactly once per row and never updated.
  const updatesEdits = /UPDATE\s+co_order_edits/i;
  check('E16 co_order_edits is append-only in source as well as in behaviour',
    !updatesEdits.test(svcSrc) && !updatesEdits.test(routeSrc));

  check('E16 the money-seam contract is documented in the route header for the integrator',
    /MONEY SEAM/.test(routeSrc) && /orderedit_<edit_row_id>/.test(routeSrc)
    && /kind: 'order_edit'/.test(routeSrc));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await cleanup();
await sql`DELETE FROM user_roles WHERE user_id = 'u_oe_a'`;
await sql`DELETE FROM roles WHERE id = 'r_oe_test'`;
await sql`DELETE FROM users WHERE id = 'u_oe_a'`;
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
