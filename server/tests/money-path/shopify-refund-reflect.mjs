// Verification harness for the Shopify refund-reflection money-path piece
// (services/shopifyRefund.js). Stands up a LOCAL MOCK Shopify Admin server that
// serves GET orders/{id}/transactions.json and records POST orders/{id}/
// refunds.json, seeds a mirrored co_orders row, and drives the REAL
// reflectRefundToShopify() against embedded PG. Asserts: correct refund payload
// (parent_id + amount + kind + gateway), full vs partial vs over-cap amount,
// exactly-once under redelivery, skip when there is no Shopify order, and
// fail-CLOSED needs_reconcile on missing parent txn / Shopify 5xx.
//
// Run:  node server/tests/money-path/shopify-refund-reflect.mjs
import http from 'http';

process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.PUURE_SHOPIFY_STORE = 'mock-puure.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock_token';
process.env.SHOPIFY_API_VERSION = '2024-01';
process.env.SHOPIFY_ORDER_CREATE_ENABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── Mock Shopify Admin API ────────────────────────────────────────────────
const mock = {
  txMode: 'ok',      // 'ok' | 'empty' | '500'
  refundMode: 'ok',  // 'ok' | '500'
  transactions: [{ id: 9001, kind: 'sale', status: 'success', amount: '4.97', gateway: 'whop' }],
  refundCalls: [],   // recorded POST bodies
  nextRefundId: 7001,
};
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/\/transactions\.json/.test(req.url) && req.method === 'GET') {
      if (mock.txMode === '500') return j(500, {});
      if (mock.txMode === 'empty') return j(200, { transactions: [] });
      return j(200, { transactions: mock.transactions });
    }
    if (/\/refunds\.json/.test(req.url) && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(raw); } catch { body = {}; }
      mock.refundCalls.push({ url: req.url, body });
      if (mock.refundMode === '500') return j(500, { errors: 'boom' });
      return j(201, { refund: { id: mock.nextRefundId++ } });
    }
    j(404, {});
  });
});
await new Promise((r) => server.listen(0, r));
process.env.SHOPIFY_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { reflectRefundToShopify, _internals } = await import('../../src/services/shopifyRefund.js');
await ensureCheckoutTables();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

// Seed a mirrored co_order for a session. reflectRefundToShopify reads
// co_orders by session_id where shopify_order_id IS NOT NULL.
async function seedOrder(sessionId, shopifyOrderId) {
  await sql`DELETE FROM co_shopify_refunds WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM co_orders WHERE session_id = ${sessionId}`;
  if (shopifyOrderId != null) {
    await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency, shopify_order_id)
              VALUES (${'coo_' + sessionId}, ${sessionId}, ${'idem_' + sessionId}, 'whop', 4.97, 'USD', ${String(shopifyOrderId)})`;
  }
}
const reset = () => { mock.txMode = 'ok'; mock.refundMode = 'ok'; mock.transactions = [{ id: 9001, kind: 'sale', status: 'success', amount: '4.97', gateway: 'whop' }]; mock.refundCalls.length = 0; };

// ── Pure helpers ──────────────────────────────────────────────────────────
{
  const p = { id: 5, amount: '4.97', gateway: 'whop' };
  check('pure: full refund uses parent amount', _internals.refundAmountFor(p, null) === 4.97);
  check('pure: partial refund respected', _internals.refundAmountFor(p, 2.00) === 2.00);
  check('pure: over-cap clamped to parent', _internals.refundAmountFor(p, 9.99) === 4.97);
  const body = _internals.buildRefundBody(p, 4.97, 'rf_1');
  const t = body.refund.transactions[0];
  check('pure: refund body shape', t.parent_id === 5 && t.amount === '4.97' && t.kind === 'refund' && t.gateway === 'whop' && body.refund.notify === false, JSON.stringify(body));
  check('pure: pickParent finds successful sale', _internals.pickParentTransaction([{ kind: 'authorization', status: 'success' }, { kind: 'sale', status: 'success', id: 1 }])?.id === 1);
  check('pure: pickParent ignores failed sale', _internals.pickParentTransaction([{ kind: 'sale', status: 'failure', id: 1 }]) === null);
}

// ── T1: full refund (amount null) posts a books-only refund ────────────────
{
  reset(); await seedOrder('cor_full', 8801);
  const r = await reflectRefundToShopify({ sessionId: 'cor_full', ref: 'rf_full', amount: null });
  const call = mock.refundCalls[0];
  const t = call?.body?.refund?.transactions?.[0];
  check('T1 ok', r.ok === true, JSON.stringify(r));
  check('T1 exactly one refund POST', mock.refundCalls.length === 1);
  check('T1 posts to the mirrored order', /orders\/8801\/refunds/.test(call?.url || ''), call?.url);
  check('T1 parent_id from sale txn', t?.parent_id === 9001, JSON.stringify(t));
  check('T1 full amount = 4.97', t?.amount === '4.97', JSON.stringify(t));
  check('T1 kind refund, manual gateway, no notify', t?.kind === 'refund' && t?.gateway === 'whop' && call?.body?.refund?.notify === false);
  const [row] = await sql`SELECT status, shopify_refund_id FROM co_shopify_refunds WHERE session_id='cor_full' AND ref='rf_full'`;
  check('T1 claim marked reflected', row?.status === 'reflected' && !!row?.shopify_refund_id, JSON.stringify(row));
}

// ── T2: partial refund books the partial amount ────────────────────────────
{
  reset(); await seedOrder('cor_part', 8802);
  const r = await reflectRefundToShopify({ sessionId: 'cor_part', ref: 'rf_part', amount: 2.00 });
  check('T2 ok + partial amount 2.00', r.ok === true && mock.refundCalls[0]?.body?.refund?.transactions?.[0]?.amount === '2.00', JSON.stringify(mock.refundCalls[0]?.body));
}

// ── T3: exactly-once — a redelivered refund ref never posts twice ──────────
{
  reset(); await seedOrder('cor_idem', 8803);
  const a = await reflectRefundToShopify({ sessionId: 'cor_idem', ref: 'rf_dup', amount: null });
  const b = await reflectRefundToShopify({ sessionId: 'cor_idem', ref: 'rf_dup', amount: null });
  check('T3 first reflects, second skips (already)', a.ok === true && b.skipped === 'already', JSON.stringify({ a, b }));
  check('T3 only ONE Shopify refund POST', mock.refundCalls.length === 1, `calls=${mock.refundCalls.length}`);
}

// ── T3b: concurrent redelivery — race both calls, still exactly one POST ────
{
  reset(); await seedOrder('cor_race', 8804);
  const [x, y] = await Promise.all([
    reflectRefundToShopify({ sessionId: 'cor_race', ref: 'rf_race', amount: null }),
    reflectRefundToShopify({ sessionId: 'cor_race', ref: 'rf_race', amount: null }),
  ]);
  check('T3b concurrent: exactly one POST', mock.refundCalls.length === 1, `calls=${mock.refundCalls.length}`);
  check('T3b concurrent: one ok, one skipped', ((x.ok && y.skipped === 'already') || (y.ok && x.skipped === 'already')), JSON.stringify({ x, y }));
}

// ── T4: no mirrored Shopify order → skip, never POST ───────────────────────
{
  reset(); await seedOrder('cor_none', null);
  const r = await reflectRefundToShopify({ sessionId: 'cor_none', ref: 'rf_none', amount: null });
  check('T4 skipped no_shopify_order, no POST', r.skipped === 'no_shopify_order' && mock.refundCalls.length === 0, JSON.stringify(r));
}

// ── T5: no parent transaction → fail CLOSED to needs_reconcile, no refund ──
{
  reset(); mock.txMode = 'empty'; await seedOrder('cor_notx', 8805);
  const r = await reflectRefundToShopify({ sessionId: 'cor_notx', ref: 'rf_notx', amount: null });
  const [row] = await sql`SELECT status, error FROM co_shopify_refunds WHERE session_id='cor_notx' AND ref='rf_notx'`;
  check('T5 no parent txn → not ok, no refund POST', r.ok === false && mock.refundCalls.length === 0, JSON.stringify(r));
  check('T5 claim marked needs_reconcile', row?.status === 'needs_reconcile', JSON.stringify(row));
}

// ── T6: Shopify 5xx on the refund POST → needs_reconcile, not ok ───────────
{
  reset(); mock.refundMode = '500'; await seedOrder('cor_500', 8806);
  const r = await reflectRefundToShopify({ sessionId: 'cor_500', ref: 'rf_500', amount: null });
  const [row] = await sql`SELECT status FROM co_shopify_refunds WHERE session_id='cor_500' AND ref='rf_500'`;
  check('T6 5xx → not ok', r.ok === false, JSON.stringify(r));
  check('T6 claim marked needs_reconcile (human owns bookkeeping)', row?.status === 'needs_reconcile', JSON.stringify(row));
}

// ── T7: disabled (cross-store guard) → skip, never touch Shopify ───────────
{
  reset(); await seedOrder('cor_dis', 8807);
  process.env.SHOPIFY_ORDER_CREATE_DISABLED = '1';
  const r = await reflectRefundToShopify({ sessionId: 'cor_dis', ref: 'rf_dis', amount: null });
  delete process.env.SHOPIFY_ORDER_CREATE_DISABLED;
  check('T7 disabled → skipped, no POST', r.skipped === 'disabled' && mock.refundCalls.length === 0, JSON.stringify(r));
}

// ══ INBOUND direction — a Shopify-admin refund triggers the REAL gateway refund ══
const { handleInboundShopifyRefund } = await import('../../src/services/shopifyRefund.js');
const q2 = (text, params = []) => sql.unsafe(text, params);
async function seedInbound(sessionId, shopifyOrderId, { status = 'paid', refunds = [] } = {}) {
  await sql`DELETE FROM co_shopify_refunds WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM co_orders WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM co_sessions WHERE id = ${sessionId}`;
  await sql`INSERT INTO co_sessions ${sql({ id: sessionId, funnel_id: 'fn_inb', status, gateway: 'whop', gateway_session_id: 'pay_inb_' + sessionId, total: 4.97, subtotal: 4.97, currency: 'USD', line_items: sql.json([]), customer: sql.json({}), refunds: sql.json(refunds) })}`;
  await sql`INSERT INTO co_orders (id, session_id, idempotency_key, gateway, total, currency, shopify_order_id)
            VALUES (${'coo_' + sessionId}, ${sessionId}, ${'idem_' + sessionId}, 'whop', 4.97, 'USD', ${String(shopifyOrderId)})`;
}
const calls = [];
const okRefundFn = async (creds, args) => { calls.push({ creds, args }); return { ok: true, status: 'refunded' }; };
const failRefundFn = async () => ({ ok: false, error: 'gateway_down' });
const cred = async () => 'apik_test';

// I1: full refund created in Shopify → gateway refund issued (full → amount null)
{
  calls.length = 0; await seedInbound('cin_full', 9901);
  const r = await handleInboundShopifyRefund(
    { id: 501, order_id: 9901, note: '', transactions: [{ kind: 'refund', amount: '4.97' }] },
    { query: q2, refundFn: okRefundFn, resolveCred: cred }
  );
  check('I1 inbound full → gateway refund called once', r.ok === true && calls.length === 1, JSON.stringify(r));
  check('I1 full amount passed as null (full refund)', calls[0].args.amount === null && calls[0].args.paymentId === 'pay_inb_cin_full', JSON.stringify(calls[0].args));
  const [row] = await sql`SELECT status FROM co_shopify_refunds WHERE session_id='cin_full' AND ref='shp:501'`;
  check('I1 claim marked inbound_gateway_refunded', row?.status === 'inbound_gateway_refunded', JSON.stringify(row));
}
// I2: PARTIAL refund → partial amount forwarded
{
  calls.length = 0; await seedInbound('cin_part', 9902);
  await handleInboundShopifyRefund(
    { id: 502, order_id: 9902, note: '', transactions: [{ kind: 'refund', amount: '2.00' }] },
    { query: q2, refundFn: okRefundFn, resolveCred: cred }
  );
  check('I2 partial amount forwarded (2.00)', calls[0]?.args.amount === 2, JSON.stringify(calls[0]?.args));
}
// I3: LOOP BREAKER — our own reflected refund is skipped
{
  calls.length = 0; await seedInbound('cin_loop', 9903);
  const r = await handleInboundShopifyRefund(
    { id: 503, order_id: 9903, note: 'Refunded at gateway (rf_x) — money already returned; Shopify books-only. [puure-reflected]', transactions: [{ kind: 'refund', amount: '4.97' }] },
    { query: q2, refundFn: okRefundFn, resolveCred: cred }
  );
  check('I3 own reflection skipped, NO gateway call', r.skipped === 'own_reflection' && calls.length === 0, JSON.stringify(r));
}
// I4: exactly-once — same Shopify refund id redelivered → one gateway call
{
  calls.length = 0; await seedInbound('cin_dup', 9904);
  const payload = { id: 504, order_id: 9904, note: '', transactions: [{ kind: 'refund', amount: '4.97' }] };
  const a = await handleInboundShopifyRefund(payload, { query: q2, refundFn: okRefundFn, resolveCred: cred });
  const b = await handleInboundShopifyRefund(payload, { query: q2, refundFn: okRefundFn, resolveCred: cred });
  check('I4 redelivery: one call, second skipped', a.ok && b.skipped === 'already_handled' && calls.length === 1, JSON.stringify({ a, b, calls: calls.length }));
}
// I5: session already refunded at the gateway → no second refund
{
  calls.length = 0; await seedInbound('cin_done', 9905, { status: 'refunded', refunds: [{ id: 'rf_1', amount: 4.97 }] });
  const r = await handleInboundShopifyRefund(
    { id: 505, order_id: 9905, note: '', transactions: [{ kind: 'refund', amount: '4.97' }] },
    { query: q2, refundFn: okRefundFn, resolveCred: cred }
  );
  check('I5 already-refunded session → skipped, no call', r.skipped === 'gateway_already_refunded' && calls.length === 0, JSON.stringify(r));
}
// I6: non-checkout order (no co_orders row) → clean skip
{
  calls.length = 0;
  const r = await handleInboundShopifyRefund(
    { id: 506, order_id: 777777, note: '', transactions: [{ kind: 'refund', amount: '9.99' }] },
    { query: q2, refundFn: okRefundFn, resolveCred: cred }
  );
  check('I6 non-checkout order skipped', r.skipped === 'not_a_checkout_order' && calls.length === 0, JSON.stringify(r));
}
// I7: gateway failure → claim marked failed + session parked for review
{
  calls.length = 0; await seedInbound('cin_fail', 9907);
  const r = await handleInboundShopifyRefund(
    { id: 507, order_id: 9907, note: '', transactions: [{ kind: 'refund', amount: '4.97' }] },
    { query: q2, refundFn: failRefundFn, resolveCred: cred }
  );
  const [row] = await sql`SELECT status FROM co_shopify_refunds WHERE session_id='cin_fail' AND ref='shp:507'`;
  const [sessR] = await sql`SELECT needs_review_reason FROM co_sessions WHERE id='cin_fail'`;
  check('I7 gateway failure → failed claim + review parked', r.ok === false && String(row?.status).startsWith('inbound_failed') && String(sessR?.needs_review_reason || '').includes('shopify_refund_gateway_failed'), JSON.stringify({ row, sessR }));
}
// I8: OUTBOUND loop breaker — reflection skips when Shopify already refunded
{
  reset(); await seedOrder('cor_ext', 8899);
  mock.transactions = [
    { id: 9001, kind: 'sale', status: 'success', amount: '4.97', gateway: 'whop' },
    { id: 9002, kind: 'refund', status: 'success', amount: '4.97', gateway: 'whop' },
  ];
  const r = await reflectRefundToShopify({ sessionId: 'cor_ext', ref: 'rf_ext', amount: 4.97 });
  const [row] = await sql`SELECT status, error FROM co_shopify_refunds WHERE session_id='cor_ext' AND ref='rf_ext'`;
  check('I8 reflection no-ops when Shopify already refunded (no POST)', r.ok === true && r.external === true && mock.refundCalls.length === 0, JSON.stringify(r));
  check('I8 claim reflected with already-refunded note', row?.status === 'reflected' && row?.error === 'already_refunded_in_shopify', JSON.stringify(row));
}
for (const sid of ['cin_full','cin_part','cin_loop','cin_dup','cin_done','cin_fail','cor_ext']) {
  await sql`DELETE FROM co_shopify_refunds WHERE session_id = ${sid}`;
  await sql`DELETE FROM co_orders WHERE session_id = ${sid}`;
  await sql`DELETE FROM co_sessions WHERE id = ${sid}`;
}

// cleanup
for (const s of ['cor_full', 'cor_part', 'cor_idem', 'cor_race', 'cor_none', 'cor_notx', 'cor_500', 'cor_dis']) {
  await sql`DELETE FROM co_shopify_refunds WHERE session_id = ${s}`;
  await sql`DELETE FROM co_orders WHERE session_id = ${s}`;
}
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
