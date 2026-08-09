// Verification harness for the Shopify order-mirror money-path piece.
//
// Standalone (no full server): stands up a LOCAL MOCK Shopify Admin server that
// records POST /admin/api/*/orders.json calls and returns a fake order id, then
// drives the REAL settlement path (settleSessionPaid → createShopifyOrderFor
// Session) against embedded PG. Asserts exactly-once creation under: single
// settle, duplicate delivery, 8× concurrent settle; fail-closed non-fatal
// behaviour on a Shopify 500 and a timeout; and correct payload shape.
//
// Run:  node server/tests/money-path/shopify-order-create.mjs
import http from 'http';
import crypto from 'crypto';

// ── Env MUST be set before importing anything that constructs the pg client ──
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.PUURE_SHOPIFY_STORE = 'mock-puure.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock_token';
process.env.SHOPIFY_API_VERSION = '2024-01';
process.env.SHOPIFY_ORDER_CREATE_ENABLED = '1'; // explicit opt-in (cross-store guard)

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── Mock Shopify Admin API ───────────────────────────────────────────────
// Faithful-enough to catch mispricing: on POST it COMPUTES total_price from the
// payload line prices (× qty) + shipping_lines + tax_lines — pricing a line at
// livePrice ONLY when the payload omits a price (proving that sending an explicit
// price makes live≠funnel irrelevant) — then resolves financial_status by
// comparing the summed sale transactions to total_price (paid / partially_paid /
// pending). Created orders are stored and served on GET orders.json so the
// reclaim-adopt path can find them by note_attributes.
// Modes: 'ok' → 201; '500' → server error (POST+GET); 'timeout' → hang.
const mock = {
  mode: 'ok',
  calls: [],                 // recorded { body } for each orders.json POST
  getCalls: 0,               // count of GET orders.json (reclaim lookups)
  orders: [],                // created order records (served on GET)
  livePrice: {},             // variantId -> live unit price (used only if payload omits price)
  nextId: 5500000001,
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function computeOrder(o) {
  let lineSum = 0;
  for (const li of o.line_items || []) {
    const unit = li.price != null ? num(li.price) : num(mock.livePrice[String(li.variant_id)]);
    lineSum += unit * num(li.quantity);
  }
  const shipSum = (o.shipping_lines || []).reduce((s, l) => s + num(l.price), 0);
  const taxSum = (o.tax_lines || []).reduce((s, l) => s + num(l.price), 0);
  const totalPrice = Math.round((lineSum + shipSum + taxSum) * 100) / 100;
  const paid = (o.transactions || [])
    .filter((t) => ['sale', 'capture'].includes(t.kind) && t.status === 'success')
    .reduce((s, t) => s + num(t.amount), 0);
  const financial_status = paid >= totalPrice - 0.001 ? (paid > totalPrice + 0.001 ? 'paid' : 'paid') : (paid > 0 ? 'partially_paid' : 'pending');
  return { totalPrice, paid, financial_status };
}
const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (!/\/orders\.json/.test(req.url)) { res.writeHead(404).end('{}'); return; }
    if (req.method === 'GET') {
      mock.getCalls++;
      if (mock.mode === 'timeout') return;
      if (mock.mode === '500') { res.writeHead(500).end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orders: mock.orders.map((r) => ({ id: r.id, order_number: r.order_number, note_attributes: r.note_attributes, tags: r.tags })) }));
      return;
    }
    // POST create
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const o = body.order || {};
    mock.calls.push({ body: o });
    if (mock.mode === 'timeout') return; // hang → client-side AbortController fires
    if (mock.mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ errors: 'internal' })); return; }
    const id = mock.nextId++;
    const order_number = 1000 + (id % 1000);
    const { totalPrice, financial_status } = computeOrder(o);
    mock.orders.push({ id, order_number, note_attributes: o.note_attributes || [], tags: o.tags || '', total_price: totalPrice.toFixed(2), financial_status });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ order: { id, order_number, financial_status, total_price: totalPrice.toFixed(2) } }));
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const mockPort = mockServer.address().port;
process.env.SHOPIFY_API_BASE = `http://127.0.0.1:${mockPort}`;
// Speed up the timeout assertion — 15s default is too slow for a test.
// (createShopifyOrderForSession reads CREATE_TIMEOUT_MS as a module const, so
// we instead rely on a short abort via a dead-short server; see TEST 5.)

// ── Import the REAL money path (after env is set) — from THIS worktree ────
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { settleSessionPaid } = await import('../../src/services/checkoutSettle.js');
const { createShopifyOrderForSession } = await import('../../src/services/shopifyOrderCreate.js');

let pass = 0, fail = 0;
const check = (n, cond, d = '') => { if (cond) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

await ensureCheckoutTables();
// Clean slate each run.
await sql`TRUNCATE co_sessions, co_orders, co_events RESTART IDENTITY`;

// Seed a paid-READY session (status 'processing' — settle flips it to paid).
async function seedSession({ id, variant = '58222941077807', qty = 1, total = 89, email = 'buyer@example.com', currency = 'USD', shipping = true, customerOverride } = {}) {
  const customer = customerOverride !== undefined ? customerOverride : {
    email,
    first_name: 'Ada',
    last_name: 'Lovelace',
    phone: '+15551234567',
    ...(shipping ? { shipping: { address1: "12 O'Analytical St", address2: 'Apt <b>4</b>', city: 'London', state: 'LDN', zip: 'EC1', country: 'GB' } } : {}),
  };
  const lineItems = [{ variant_id: variant, quantity: qty, price: total / qty, currency }];
  await sql`INSERT INTO co_sessions ${sql({
    id, funnel_id: 'fn_test', status: 'processing',
    line_items: sql.json(lineItems), subtotal: total, shipping: 0, tax: 0, total,
    currency, customer: sql.json(customer),
  })}`;
  return id;
}

const settleArgs = (id, payId) => ({
  sessionId: id, gateway: 'whop', gatewayId: payId,
  idempotencyKey: `wh_${payId}`, amount: 89, currency: 'USD',
});

// ══ TEST 1 — single settlement → exactly ONE Shopify order-create call ══
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_single', total: 89 });
  const r = await settleSessionPaid(settleArgs(id, 'pay_single'));
  const [ord] = await sql`SELECT shopify_order_id, shopify_status, external_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_single'`;
  check('T1 single settle → ok', r.ok && r.settled === true, JSON.stringify(r));
  check('T1 exactly ONE orders.json call', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('T1 shopify_order_id stored + status created', Boolean(ord?.shopify_order_id) && ord.shopify_status === 'created', JSON.stringify(ord));
  check('T1 external_order_id mirrors shopify id', ord?.external_order_id === ord?.shopify_order_id, JSON.stringify(ord));
}

// ══ TEST 2 — payload shape: paid, line_items, total, currency, email, address ══
{
  const call = mock.calls[0];
  const o = call?.body || {};
  check('T2 financial_status paid', o.financial_status === 'paid', JSON.stringify(o.financial_status));
  check('T2 manual sale transaction paid (amount+currency)', Array.isArray(o.transactions) && o.transactions[0]?.kind === 'sale' && o.transactions[0]?.status === 'success' && o.transactions[0]?.amount === '89.00' && o.transactions[0]?.currency === 'USD', JSON.stringify(o.transactions));
  check('T2 line_items variant_id as numeric STRING + qty + server price', Array.isArray(o.line_items) && o.line_items[0]?.variant_id === '58222941077807' && o.line_items[0]?.quantity === 1 && o.line_items[0]?.price === '89.00', JSON.stringify(o.line_items));
  check('T2 currency USD', o.currency === 'USD', JSON.stringify(o.currency));
  // Reconciliation: the mock's COMPUTED total_price (from line prices+ship+tax)
  // must equal the charged transaction amount and resolve to fully paid.
  const rec1 = mock.orders[mock.orders.length - 1];
  check('T2 total_price == transaction amount (reconciles)', rec1?.total_price === o.transactions[0].amount && rec1?.total_price === '89.00', JSON.stringify(rec1));
  check('T2 financial_status resolves fully PAID (not partially_paid)', rec1?.financial_status === 'paid', JSON.stringify(rec1));
  check('T2 email present', o.email === 'buyer@example.com', JSON.stringify(o.email));
  check('T2 order-confirmation email ON by default, fulfillment email OFF', o.send_receipt === true && o.send_fulfillment_receipt === false, JSON.stringify({ r: o.send_receipt, f: o.send_fulfillment_receipt }));
  check('T2 puure-checkout tag + source', o.tags === 'puure-checkout' && o.source_name === 'puure-checkout', JSON.stringify({ t: o.tags, s: o.source_name }));
  check('T2 gateway payment id in note_attributes', Array.isArray(o.note_attributes) && o.note_attributes.some((a) => a.name === 'gateway_payment_id' && a.value === 'pay_single'), JSON.stringify(o.note_attributes));
  // Injection-in-address: hostile strings pass through as inert JSON values.
  check('T2 address preserved as inert data (no crash/escape)', o.shipping_address?.address1 === "12 O'Analytical St" && o.shipping_address?.address2 === 'Apt <b>4</b>' && o.shipping_address?.province === 'LDN', JSON.stringify(o.shipping_address));
}

// ══ TEST 3 — the SAME settlement delivered TWICE → still exactly ONE order ══
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_dup', total: 89 });
  const r1 = await settleSessionPaid(settleArgs(id, 'pay_dup'));
  const r2 = await settleSessionPaid(settleArgs(id, 'pay_dup')); // redelivery
  const [ord] = await sql`SELECT shopify_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_dup'`;
  const orderRows = await sql`SELECT count(*)::int n FROM co_orders WHERE session_id = 'co_dup'`;
  check('T3 redelivery: exactly ONE orders.json call', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('T3 redelivery: r1 settled, r2 already', r1.settled === true && r2.already === true, JSON.stringify({ r1, r2 }));
  check('T3 redelivery: exactly ONE co_orders row', orderRows[0].n === 1, JSON.stringify(orderRows[0]));
  check('T3 redelivery: shopify id set once', Boolean(ord?.shopify_order_id), JSON.stringify(ord));
}

// ══ TEST 4 — 8× CONCURRENT settlement of the same session → exactly ONE ══
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_race', total: 89 });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => settleSessionPaid(settleArgs(id, 'pay_race')))
  );
  const [ord] = await sql`SELECT shopify_order_id, shopify_status FROM co_orders WHERE idempotency_key = 'wh_pay_race'`;
  const orderRows = await sql`SELECT count(*)::int n FROM co_orders WHERE session_id = 'co_race'`;
  const settledCount = results.filter((r) => r.settled).length;
  check('T4 8×concurrent: exactly ONE orders.json call', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('T4 8×concurrent: exactly ONE settle flip', settledCount === 1, `settled=${settledCount}`);
  check('T4 8×concurrent: exactly ONE co_orders row', orderRows[0].n === 1, JSON.stringify(orderRows[0]));
  check('T4 8×concurrent: shopify id set + created', Boolean(ord?.shopify_order_id) && ord.shopify_status === 'created', JSON.stringify(ord));
}

// ══ TEST 5 — direct 8× concurrency on createShopifyOrderForSession alone ══
// (settleSessionPaid serialises somewhat on the flip; hit the creator directly
// to prove the claim itself is the exactly-once guard under true contention.)
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_race2', total: 89 });
  // Pre-create the co_orders row (as settle would) so all 8 race ONLY the claim.
  await sql`INSERT INTO co_orders ${sql({ id: 'ord_race2', session_id: id, idempotency_key: 'wh_pay_race2', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD' })}`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'wh_pay_race2' }))
  );
  const createdCount = results.filter((r) => r.created).length;
  check('T5 direct 8×: exactly ONE orders.json call', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('T5 direct 8×: exactly ONE created=true', createdCount === 1, `created=${createdCount}`);
}

// ══ TEST 6 — Shopify 500 → card stays charged, needs_review, NO throw/dup ══
{
  mock.mode = '500'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_500', total: 89 });
  let threw = false;
  let r;
  try { r = await settleSessionPaid(settleArgs(id, 'pay_500')); } catch (e) { threw = true; }
  const [sess] = await sql`SELECT status, needs_review_reason FROM co_sessions WHERE id = 'co_500'`;
  const [ord] = await sql`SELECT shopify_order_id, shopify_status, shopify_error FROM co_orders WHERE idempotency_key = 'wh_pay_500'`;
  check('T6 500: settle did NOT throw', threw === false, 'threw');
  check('T6 500: card still charged (session paid + co_orders present)', sess?.status === 'paid' && Boolean(ord), JSON.stringify({ sess, ord }));
  check('T6 500: NO shopify order id (not created)', !ord?.shopify_order_id, JSON.stringify(ord));
  check('T6 500: order flagged needs_review + error recorded', ord?.shopify_status === 'needs_review' && /server:http_500/.test(ord?.shopify_error || ''), JSON.stringify(ord));
  check('T6 500: session flagged needs_review', /shopify_order_create/.test(sess?.needs_review_reason || ''), JSON.stringify(sess?.needs_review_reason));
  // A redelivery must NOT retry a parked (needs_review) order → no duplicate.
  const before = mock.calls.length;
  await settleSessionPaid(settleArgs(id, 'pay_500'));
  check('T6 500: redelivery does NOT retry parked order (no dup call)', mock.calls.length === before, `calls grew to ${mock.calls.length}`);
}

// ══ TEST 7 — transport timeout → ambiguous, needs_review, non-fatal ══
// Point the API base at a server that accepts the socket but never replies, and
// shorten the wait by aborting the socket after a beat via a dead responder.
{
  // Stand up a black-hole server that holds the connection open without reply.
  const blackhole = http.createServer(() => { /* never respond */ });
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
  const bhPort = blackhole.address().port;
  const savedBase = process.env.SHOPIFY_API_BASE;
  process.env.SHOPIFY_API_BASE = `http://127.0.0.1:${bhPort}`;
  const id = await seedSession({ id: 'co_to', total: 89 });
  // Use the creator directly with a short-circuit: we can't shrink the 15s
  // module const, so destroy sockets shortly after connect to force a network
  // error (ECONNRESET) — same AMBIGUOUS transport class as a timeout.
  blackhole.on('connection', (sock) => { setTimeout(() => sock.destroy(), 150); });
  await sql`INSERT INTO co_orders ${sql({ id: 'ord_to', session_id: id, idempotency_key: 'wh_pay_to', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD' })}`;
  let threw = false, r;
  try { r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'wh_pay_to' }); } catch { threw = true; }
  const [ord] = await sql`SELECT shopify_order_id, shopify_status, shopify_error FROM co_orders WHERE idempotency_key = 'wh_pay_to'`;
  check('T7 transport: did NOT throw', threw === false, 'threw');
  check('T7 transport: needsReview, no order id', r?.needsReview === true && !ord?.shopify_order_id, JSON.stringify({ r, ord }));
  check('T7 transport: parked with transport-class error', ord?.shopify_status === 'needs_review' && /transport:/.test(ord?.shopify_error || ''), JSON.stringify(ord));
  process.env.SHOPIFY_API_BASE = savedBase;
  blackhole.close();
}

// ══ TEST 8 — input validation parks needs_review (no crash, no call) ══
{
  mock.mode = 'ok';
  // (a) missing email
  {
    mock.calls.length = 0;
    const id = await seedSession({ id: 'co_noemail', total: 89, customerOverride: { first_name: 'No', last_name: 'Email' } });
    await sql`INSERT INTO co_orders ${sql({ id: 'ord_noemail', session_id: id, idempotency_key: 'k_noemail', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD' })}`;
    const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'k_noemail' });
    const [ord] = await sql`SELECT shopify_status, shopify_error FROM co_orders WHERE idempotency_key = 'k_noemail'`;
    check('T8a missing email → needs_review, no call', r.error === 'missing_email' && ord.shopify_status === 'needs_review' && mock.calls.length === 0, JSON.stringify({ r, ord, calls: mock.calls.length }));
  }
  // (b) empty line_items
  {
    mock.calls.length = 0;
    const id = 'co_noitems';
    await sql`INSERT INTO co_sessions ${sql({ id, funnel_id: 'fn_test', status: 'processing', line_items: sql.json([]), subtotal: 0, shipping: 0, tax: 0, total: 89, currency: 'USD', customer: sql.json({ email: 'x@y.com' }) })}`;
    await sql`INSERT INTO co_orders ${sql({ id: 'ord_noitems', session_id: id, idempotency_key: 'k_noitems', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD' })}`;
    const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'k_noitems' });
    check('T8b empty line_items → needs_review, no call', r.error === 'empty_line_items' && mock.calls.length === 0, JSON.stringify({ r, calls: mock.calls.length }));
  }
  // (c) missing variant_id
  {
    mock.calls.length = 0;
    const id = 'co_novar';
    await sql`INSERT INTO co_sessions ${sql({ id, funnel_id: 'fn_test', status: 'processing', line_items: sql.json([{ variant_id: '', quantity: 1 }]), subtotal: 89, shipping: 0, tax: 0, total: 89, currency: 'USD', customer: sql.json({ email: 'x@y.com' }) })}`;
    await sql`INSERT INTO co_orders ${sql({ id: 'ord_novar', session_id: id, idempotency_key: 'k_novar', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD' })}`;
    const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'k_novar' });
    check('T8c missing variant_id → needs_review, no call', r.error === 'missing_variant_id' && mock.calls.length === 0, JSON.stringify({ r, calls: mock.calls.length }));
  }
  // (d) currency mismatch (session vs order row)
  {
    mock.calls.length = 0;
    const id = 'co_curmis';
    await sql`INSERT INTO co_sessions ${sql({ id, funnel_id: 'fn_test', status: 'processing', line_items: sql.json([{ variant_id: '58222941077807', quantity: 1, price: 89 }]), subtotal: 89, shipping: 0, tax: 0, total: 89, currency: 'USD', customer: sql.json({ email: 'x@y.com' }) })}`;
    await sql`INSERT INTO co_orders ${sql({ id: 'ord_curmis', session_id: id, idempotency_key: 'k_curmis', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'EUR' })}`;
    const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'k_curmis' });
    check('T8d currency mismatch → needs_review, no call', /currency_mismatch/.test(r.error || '') && mock.calls.length === 0, JSON.stringify({ r, calls: mock.calls.length }));
  }
}

// ══ TEST 9 — disabled kill-switch → inert (no call, no row mutation) ══
{
  mock.calls.length = 0;
  process.env.SHOPIFY_ORDER_CREATE_DISABLED = '1';
  const id = await seedSession({ id: 'co_off', total: 89 });
  const r = await settleSessionPaid(settleArgs(id, 'pay_off'));
  const [ord] = await sql`SELECT shopify_status, shopify_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_off'`;
  check('T9 disabled: settle still ok (money path intact)', r.ok && r.settled, JSON.stringify(r));
  check('T9 disabled: NO orders.json call', mock.calls.length === 0, `calls=${mock.calls.length}`);
  check('T9 disabled: co_orders untouched by mirror', !ord?.shopify_status && !ord?.shopify_order_id, JSON.stringify(ord));
  delete process.env.SHOPIFY_ORDER_CREATE_DISABLED;
}

// ══ TEST 10 — multi-line, live price ≠ funnel price, shipping+tax > 0 ══
// Two lines at DIFFERENT server prices + shipping + tax. The mock's live price
// for the variant is deliberately wrong (999) — because the payload carries our
// server price, the computed total_price still reconciles to the charged amount
// and resolves fully PAID. This is the case the old hard-coded mock could not
// catch.
{
  mock.mode = 'ok'; mock.calls.length = 0;
  mock.livePrice = { '58222941077807': 999, '58224832807215': 999 }; // live ≠ funnel
  const id = 'co_multi';
  const lines = [
    { variant_id: '58222941077807', quantity: 1, price: 50, currency: 'USD' },
    { variant_id: '58224832807215', quantity: 2, price: 30, currency: 'USD' }, // 60
  ];
  const total = 125; // 50 + 60 = 110 subtotal + 10 ship + 5 tax
  await sql`INSERT INTO co_sessions ${sql({ id, funnel_id: 'fn_test', status: 'processing', line_items: sql.json(lines), subtotal: 110, shipping: 10, tax: 5, total, currency: 'USD', customer: sql.json({ email: 'multi@example.com', first_name: 'M', last_name: 'L' }) })}`;
  const r = await settleSessionPaid({ sessionId: id, gateway: 'whop', gatewayId: 'pay_multi', idempotencyKey: 'wh_pay_multi', amount: total, currency: 'USD' });
  const call = mock.calls[0]?.body || {};
  const rec = mock.orders[mock.orders.length - 1];
  check('T10 multi-line settle ok', r.ok && r.settled, JSON.stringify(r));
  check('T10 each line carries its own server price', call.line_items?.[0]?.price === '50.00' && call.line_items?.[1]?.price === '30.00', JSON.stringify(call.line_items));
  check('T10 shipping_lines + tax_lines present', call.shipping_lines?.[0]?.price === '10.00' && call.tax_lines?.[0]?.price === '5.00', JSON.stringify({ s: call.shipping_lines, t: call.tax_lines }));
  check('T10 computed total_price == charged amount (125.00), NOT live-priced', rec?.total_price === '125.00' && rec?.total_price === call.transactions[0].amount, JSON.stringify(rec));
  check('T10 resolves fully PAID despite live≠funnel price', rec?.financial_status === 'paid', JSON.stringify(rec));
}

// ══ TEST 11 — total composition mismatch parks needs_review (fail closed) ══
// A snapshot whose lines+ship+tax do NOT sum to the charged total must NOT post
// a mispriced order — it parks for a human.
{
  mock.mode = 'ok'; mock.calls.length = 0; mock.livePrice = {};
  const id = 'co_badcompose';
  // lines sum to 100 but charged total says 125 (e.g. a dropped shipping line).
  await sql`INSERT INTO co_sessions ${sql({ id, funnel_id: 'fn_test', status: 'processing', line_items: sql.json([{ variant_id: '58222941077807', quantity: 1, price: 100 }]), subtotal: 100, shipping: 0, tax: 0, total: 125, currency: 'USD', customer: sql.json({ email: 'bad@example.com' }) })}`;
  await sql`INSERT INTO co_orders ${sql({ id: 'ord_badcompose', session_id: id, idempotency_key: 'k_badcompose', gateway: 'whop', line_items: sql.json([]), total: 125, currency: 'USD' })}`;
  const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'k_badcompose' });
  const [ord] = await sql`SELECT shopify_status, shopify_error FROM co_orders WHERE idempotency_key = 'k_badcompose'`;
  check('T11 composition mismatch → needs_review, no POST', /total_composition_mismatch/.test(r.error || '') && ord.shopify_status === 'needs_review' && mock.calls.length === 0, JSON.stringify({ r, ord, calls: mock.calls.length }));
}

// ══ TEST 12 — reclaim ADOPTS an existing order (SIGKILL-after-201 window) ══
// Create an order, then simulate the id-write being lost (row back to a STALE
// 'creating'). A reclaim must find the existing order at Shopify by our
// idempotency-key note_attribute and adopt it — ZERO new POST, no duplicate.
{
  mock.mode = 'ok'; mock.calls.length = 0; mock.getCalls = 0; mock.livePrice = {};
  const id = await seedSession({ id: 'co_adopt', total: 89 });
  const r0 = await settleSessionPaid(settleArgs(id, 'pay_adopt'));
  const [before] = await sql`SELECT shopify_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_adopt'`;
  const origId = before.shopify_order_id;
  check('T12 setup: first create produced an id', Boolean(origId) && mock.calls.length === 1, JSON.stringify({ origId, calls: mock.calls.length }));
  // Simulate the lost id-write: row reverts to a STALE 'creating' claim.
  await sql`UPDATE co_orders SET shopify_order_id = NULL, shopify_order_number = NULL, external_order_id = NULL, shopify_status = 'creating', shopify_claimed_at = NOW() - INTERVAL '4 minutes' WHERE idempotency_key = 'wh_pay_adopt'`;
  mock.calls.length = 0; mock.getCalls = 0;
  const rAdopt = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'wh_pay_adopt' });
  const [after] = await sql`SELECT shopify_order_id, shopify_status FROM co_orders WHERE idempotency_key = 'wh_pay_adopt'`;
  check('T12 reclaim ADOPTED existing order (no new POST)', rAdopt.adopted === true && mock.calls.length === 0, JSON.stringify({ rAdopt, posts: mock.calls.length }));
  check('T12 reclaim did a GET lookup', mock.getCalls === 1, `getCalls=${mock.getCalls}`);
  check('T12 adopted id matches original, status created', after.shopify_order_id === origId && after.shopify_status === 'created', JSON.stringify({ after, origId }));
}

// ══ TEST 13 — reclaim lookup FAILS → fail closed (needs_review, no POST) ══
// If the dedup GET can't confirm the order is absent, a reclaim must NOT create
// (could duplicate) — it parks for a human.
{
  const id = await seedSession({ id: 'co_adoptfail', total: 89 });
  await sql`INSERT INTO co_orders ${sql({ id: 'ord_adoptfail', session_id: id, idempotency_key: 'wh_pay_adoptfail', gateway: 'whop', line_items: sql.json([]), total: 89, currency: 'USD', shopify_status: 'creating' })}`;
  await sql`UPDATE co_orders SET shopify_claimed_at = NOW() - INTERVAL '4 minutes' WHERE idempotency_key = 'wh_pay_adoptfail'`;
  mock.mode = '500'; mock.calls.length = 0; mock.getCalls = 0; // GET returns 500
  const r = await createShopifyOrderForSession({ sessionId: id, idempotencyKey: 'wh_pay_adoptfail' });
  const [ord] = await sql`SELECT shopify_order_id, shopify_status, shopify_error FROM co_orders WHERE idempotency_key = 'wh_pay_adoptfail'`;
  check('T13 reclaim lookup error → needs_review, NO POST, no id', r.needsReview === true && mock.calls.length === 0 && !ord.shopify_order_id && ord.shopify_status === 'needs_review' && /reclaim_lookup_server/.test(ord.shopify_error || ''), JSON.stringify({ r, ord, posts: mock.calls.length }));
  mock.mode = 'ok';
}

// ══ TEST 14 — enablement gate: opt-in REQUIRED (cross-store guard) ══
{
  mock.calls.length = 0;
  delete process.env.SHOPIFY_ORDER_CREATE_ENABLED; // creds present, kill switch off, but NOT opted in
  const { shopifyOrderCreateEnabled } = await import('../../src/services/shopifyOrderCreate.js');
  check('T14 not opted in → enabled() false', shopifyOrderCreateEnabled() === false);
  const id = await seedSession({ id: 'co_gate', total: 89 });
  const rOff = await settleSessionPaid(settleArgs(id, 'pay_gate'));
  const [ordOff] = await sql`SELECT shopify_status, shopify_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_gate'`;
  check('T14 not opted in → settle ok but NO order created', rOff.ok && rOff.settled && mock.calls.length === 0 && !ordOff?.shopify_status, JSON.stringify({ rOff, calls: mock.calls.length, ordOff }));
  // Now opt in → it creates.
  process.env.SHOPIFY_ORDER_CREATE_ENABLED = '1';
  check('T14 opted in → enabled() true', shopifyOrderCreateEnabled() === true);
  mock.calls.length = 0;
  const id2 = await seedSession({ id: 'co_gate2', total: 89 });
  await settleSessionPaid(settleArgs(id2, 'pay_gate2'));
  const [ordOn] = await sql`SELECT shopify_status, shopify_order_id FROM co_orders WHERE idempotency_key = 'wh_pay_gate2'`;
  check('T14 opted in → order created', mock.calls.length === 1 && ordOn?.shopify_status === 'created' && Boolean(ordOn?.shopify_order_id), JSON.stringify({ calls: mock.calls.length, ordOn }));
}

// ══ TEST 15 — the Shopify order carries BOTH shipping and billing addresses ══
// The first real order (#1121) showed "No shipping/billing address provided"
// because the checkout never sent the buyer's details to the session. This
// asserts that once session.customer.shipping is populated, the emitted order
// payload carries shipping_address AND billing_address (billing mirrors
// shipping when the buyer keeps "same as shipping").
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_addr', total: 42, customerOverride: {
    email: 'buyer@puure.co', first_name: 'Ludo', last_name: 'Apollonio', phone: '+391112223',
    shipping: { address1: 'Via Roma 12', address2: 'Interno 3', city: 'Milano', state: 'MI', zip: '20121', country: 'IT' },
  } });
  const lineItems = [{ variant_id: '58222941077807', quantity: 1, price: 42, currency: 'USD' }];
  await sql`UPDATE co_sessions SET line_items = ${sql.json(lineItems)}, total = 42, subtotal = 42 WHERE id = ${id}`;
  await settleSessionPaid({ sessionId: id, gateway: 'whop', gatewayId: 'pay_addr', idempotencyKey: 'wh_pay_addr', amount: 42, currency: 'USD' });
  const o = mock.calls.length ? mock.calls[mock.calls.length - 1].body : {};
  check('T15 shipping_address present with the buyer address',
    o.shipping_address?.address1 === 'Via Roma 12' && o.shipping_address?.city === 'Milano'
    && o.shipping_address?.zip === '20121' && o.shipping_address?.country === 'IT',
    JSON.stringify(o.shipping_address));
  check('T15 billing_address present (mirrors shipping)',
    o.billing_address?.address1 === 'Via Roma 12' && o.billing_address?.city === 'Milano',
    JSON.stringify(o.billing_address));
  check('T15 first/last name on the address', o.shipping_address?.first_name === 'Ludo' && o.shipping_address?.last_name === 'Apollonio', JSON.stringify(o.shipping_address));
  check('T15 email on the order', o.email === 'buyer@puure.co', JSON.stringify(o.email));
}

// ══ TEST 16 — a DISTINCT billing address reaches Shopify, unmixed with shipping ══
{
  mock.mode = 'ok'; mock.calls.length = 0;
  const id = await seedSession({ id: 'co_bill', total: 30, customerOverride: {
    email: 'b@puure.co', first_name: 'Ada', last_name: 'L',
    shipping: { address1: 'Ship St 1', city: 'Roma', state: 'RM', zip: '00100', country: 'IT' },
    billing:  { first_name: 'Bill', last_name: 'Payer', address1: 'Bill Ave 9', city: 'Napoli', state: 'NA', zip: '80100', country: 'IT' },
  } });
  await sql`UPDATE co_sessions SET line_items = ${sql.json([{ variant_id: '58222941077807', quantity: 1, price: 30, currency: 'USD' }])}, total = 30, subtotal = 30 WHERE id = ${id}`;
  await settleSessionPaid({ sessionId: id, gateway: 'whop', gatewayId: 'pay_bill', idempotencyKey: 'wh_pay_bill', amount: 30, currency: 'USD' });
  const o = mock.calls.length ? mock.calls[mock.calls.length - 1].body : {};
  check('T16 shipping stays the shipping address', o.shipping_address?.address1 === 'Ship St 1' && o.shipping_address?.city === 'Roma', JSON.stringify(o.shipping_address));
  check('T16 billing is the DISTINCT billing address (not shipping)', o.billing_address?.address1 === 'Bill Ave 9' && o.billing_address?.city === 'Napoli', JSON.stringify(o.billing_address));
  check('T16 billing name is the payer', o.billing_address?.first_name === 'Bill' && o.billing_address?.last_name === 'Payer', JSON.stringify(o.billing_address));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
mockServer.close();
await sql.end();
process.exit(fail ? 1 : 0);
