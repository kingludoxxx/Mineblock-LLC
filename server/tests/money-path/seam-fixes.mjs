// Verify the S1/S2/S3/S6 seam fixes by EXECUTION against the real app.
// Own DB + port; mock gateways via env seams. No production contact.
import crypto from 'crypto';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_seamfix';
const PORT = 48890;
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, extra); } };

// ---- bootstrap db
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_seamfix`;
await admin`CREATE DATABASE puure_seamfix`;
await admin.end();

// ---- mock stripe (PI refetch) + mock whop
import http from 'http';
const PI_AMOUNTS = { pi_s1: 8900, pi_s2: 5000, pi_s3: 6000, pi_s1b: 1000, pi_s2_up: 10000 };
const stripeMock = http.createServer((req, res) => {
  const m = req.url.match(/\/v1\/payment_intents\/([^?]+)/);
  res.setHeader('content-type', 'application/json');
  if (m) {
    return res.end(JSON.stringify({
      id: m[1], status: 'succeeded', amount: PI_AMOUNTS[m[1]] ?? 8900, currency: 'usd',
      payment_method: 'pm_1', customer: 'cus_1',
      metadata: {}, charges: { data: [{ payment_method_details: { type: 'card' } }] },
    }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => stripeMock.listen(48891, r));
{
  const probe = await fetch('http://127.0.0.1:48891/v1/payment_intents/pi_probe').then((r) => r.json()).catch((e) => ({ err: String(e) }));
  console.log('MOCK PROBE:', JSON.stringify(probe).slice(0, 120));
}

process.env.DATABASE_URL = DB;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'localdev'; process.env.JWT_REFRESH_SECRET = 'localdev';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:48891/v1';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.FUNNEL_PUBLIC_ENABLED = '1';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.TRACKING_SWEEPS_DISABLED = '1';
process.env.DOMAIN_SWEEP_DISABLED = '1';
process.env.SHOPIFY_ORDER_CREATE_ENABLED = '0';

const { default: app } = await import('/Users/ludo/Puure-integrator/server/src/app.js');
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 4000));

const sql = postgres(DB, { ssl: false });
const { ensureCheckoutTables } = await import('/Users/ludo/Puure-integrator/server/src/services/checkoutSchema.js');
const { ensureSplitTables } = await import('/Users/ludo/Puure-integrator/server/src/services/splitTestSchema.js');
await ensureCheckoutTables(); await ensureSplitTables();

const { recordExposure } = await import('/Users/ludo/Puure-integrator/server/src/services/splitCredits.js');

async function seedSession({ id, total, pi }) {
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, shipping, tax, total, currency, gateway, gateway_session_id)
    VALUES (${id}, 'f_seam', 'p1', 'processing', ${sql.json([{ variant_id: '1', quantity: 1, price: total }])},
            ${total}, 0, 0, ${total}, 'USD', 'stripe', ${pi})`;
}
async function seedTest(testId, funnel = 'f_seam') {
  await sql`INSERT INTO lb_split_tests (id, funnel_id, name, scope, enabled) VALUES (${testId}, ${funnel}, 'T', 'page', TRUE)
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control) VALUES (${testId + '_a'}, ${testId}, 'a', 100, TRUE)
            ON CONFLICT DO NOTHING`;
}
function sig(body, secret = 'whsec_test') {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
async function postWebhook(evt) {
  const body = JSON.stringify(evt);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/gateway-webhooks/stripe`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig(body) }, body,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ================= S1: Stripe base credit must equal session total =========
{
  const S = 'co_s1', PI = 'pi_s1', T = 'sp_s1';
  await seedSession({ id: S, total: 89.00, pi: PI });
  await seedTest(T);
  await recordExposure({ sessionId: S, testId: T, armKey: 'a' });
  const res = await postWebhook({
    id: 'evt_s1', type: 'payment_intent.succeeded',
    data: { object: { id: PI, status: 'succeeded', amount: 8900, currency: 'usd', metadata: { co_session_id: S } } },
  });
  ok(res.status === 200, 'S1 webhook accepted', JSON.stringify(res.json));
  await new Promise((r) => setTimeout(r, 1200));
  const [cr] = await sql`SELECT value, currency FROM lb_split_credits WHERE kind='credit' AND session_id=${S}`;
  ok(cr && Number(cr.value) === 89.00, 'S1 Stripe base credit == session total (89.00), NOT 0', JSON.stringify(cr));
  ok(cr && cr.currency === 'USD', 'S1 credit currency resolved (not undefined)', JSON.stringify(cr));
}

// ================= S1b: non-finite value refused, not coerced to 0 ========
{
  const { creditConversion } = await import('/Users/ludo/Puure-integrator/server/src/services/splitCredits.js');
  const S = 'co_s1b', T = 'sp_s1b';
  await seedSession({ id: S, total: 10, pi: 'pi_s1b' });
  await seedTest(T);
  await recordExposure({ sessionId: S, testId: T, armKey: 'a' });
  const r = await creditConversion({ sessionId: S, testId: T, chargeId: 'c1', value: undefined });
  ok(r === 'refused', 'S1b non-finite credit value REFUSED (was silently $0)', String(r));
  const rows = await sql`SELECT 1 FROM lb_split_credits WHERE kind='credit' AND session_id=${S}`;
  ok(rows.length === 0, 'S1b no zero-value credit row written');
}

// ================= S2: Stripe UPSELL refund must not hit the base =========
{
  const S = 'co_s2', PI = 'pi_s2', T = 'sp_s2';
  await seedSession({ id: S, total: 50.00, pi: PI });
  await seedTest(T);
  await recordExposure({ sessionId: S, testId: T, armKey: 'a' });
  await postWebhook({
    id: 'evt_s2_base', type: 'payment_intent.succeeded',
    data: { object: { id: PI, status: 'succeeded', amount: 5000, currency: 'usd', metadata: { co_session_id: S } } },
  });
  await new Promise((r) => setTimeout(r, 800));
  // an upsell leg on the same session
  await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status, gateway_payment_id)
            VALUES ('uc_s2', ${S}, 'off1', 'v:1', 100.00, 'USD', 'settled', 'pi_s2_up')`;
  const before = await sql`SELECT value FROM lb_split_credits WHERE kind='credit' AND session_id=${S}`;
  // refund the UPSELL charge (metadata carries kind=upsell + charge_row)
  const res = await postWebhook({
    id: 'evt_s2_rf', type: 'charge.refunded',
    data: { object: { id: 'ch_s2_up', payment_intent: 'pi_s2_up', amount_refunded: 10000, currency: 'usd',
      metadata: { co_session_id: S, kind: 'upsell', charge_row: 'uc_s2' },
      refunds: { data: [{ id: 're_s2', amount: 10000, currency: 'usd' }] } } },
  });
  ok(res.json?.upsell === true, 'S2 upsell refund routed to the upsell branch', JSON.stringify(res.json));
  await new Promise((r) => setTimeout(r, 800));
  const [sess] = await sql`SELECT status, refunds FROM co_sessions WHERE id=${S}`;
  ok(sess.status !== 'refunded', 'S2 base session NOT flipped to refunded', sess.status);
  const refs = Array.isArray(sess.refunds) ? sess.refunds : [];
  ok(refs.length === 0, 'S2 base session refunds ledger untouched', JSON.stringify(refs));
  const [up] = await sql`SELECT status FROM co_upsell_charges WHERE id='uc_s2'`;
  ok(up.status === 'refunded', 'S2 upsell charge row marked refunded', up.status);
  const baseCredit = await sql`SELECT value FROM lb_split_credits WHERE kind='credit' AND session_id=${S} AND charge_id=${'base:' + S}`;
  const voids = await sql`SELECT charge_id, value FROM lb_split_credits WHERE kind='void' AND session_id=${S}`;
  ok(baseCredit.length === 1 && Number(baseCredit[0].value) === 50.00, 'S2 base arm credit intact (50.00)', JSON.stringify(baseCredit));
  ok(voids.every((v) => v.charge_id === 'uc_s2'), 'S2 void (if any) targets the UPSELL leg, never base', JSON.stringify(voids));
}

// ================= S3 equivalent for Stripe base refund → voids base ======
{
  const S = 'co_s3', PI = 'pi_s3', T = 'sp_s3';
  await seedSession({ id: S, total: 60.00, pi: PI });
  await seedTest(T);
  await recordExposure({ sessionId: S, testId: T, armKey: 'a' });
  await postWebhook({
    id: 'evt_s3_base', type: 'payment_intent.succeeded',
    data: { object: { id: PI, status: 'succeeded', amount: 6000, currency: 'usd', metadata: { co_session_id: S } } },
  });
  await new Promise((r) => setTimeout(r, 800));
  await postWebhook({
    id: 'evt_s3_rf', type: 'charge.refunded',
    data: { object: { id: 'ch_s3', payment_intent: PI, amount_refunded: 6000, currency: 'usd',
      metadata: { co_session_id: S },
      refunds: { data: [{ id: 're_s3', amount: 6000, currency: 'usd' }] } } },
  });
  await new Promise((r) => setTimeout(r, 900));
  const voids = await sql`SELECT value FROM lb_split_credits WHERE kind='void' AND session_id=${S}`;
  ok(voids.length === 1 && Number(voids[0].value) === -60.00, 'S3 base refund nets the base arm credit (-60.00)', JSON.stringify(voids));
}

// ================= S6: public router body caps apply ======================
{
  const big = JSON.stringify({ funnel_id: 'f', page_id: 'p', line_items: [{ variant_id: 'x', quantity: 1 }], pad: 'x'.repeat(2 * 1024 * 1024) });
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/checkout/public/create-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
  });
  ok(r.status === 413, 'S6 2MB body to checkout/public → 413 (router 1mb cap now applies)', String(r.status));
  const bigOptin = JSON.stringify({ email: 'a@b.co', pad: 'y'.repeat(200 * 1024) });
  const r2 = await fetch(`http://127.0.0.1:${PORT}/api/v1/optin/public/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: bigOptin,
  });
  ok(r2.status === 413, 'S6 200KB body to optin/public → 413 (router 64kb cap now applies)', String(r2.status));
}

// ================= regression: signature verification still works =========
{
  const body = JSON.stringify({ id: 'evt_bad', type: 'payment_intent.succeeded', data: { object: {} } });
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/gateway-webhooks/stripe`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body,
  });
  ok(r.status === 403, 'REG bad signature → 403 (rawBody still captured after mount reorder)', String(r.status));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end(); server.close(); stripeMock.close();
process.exit(fail ? 1 : 0);
