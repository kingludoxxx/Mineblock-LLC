// Proves the forced-charge exploit (F1) is closed: a leaked session id alone
// can no longer authorize an off-session upsell charge, while the legitimate
// buyer (holding the HttpOnly confirmation cookie) still can.
import crypto from 'crypto';
import http from 'http';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_sessauth';
const PORT = 48900, WHOP_PORT = 48901;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_sessauth`;
await admin`CREATE DATABASE puure_sessauth`;
await admin.end();

let gatewayCalls = 0;
const whop = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.url.includes('/payments')) gatewayCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'pay_' + gatewayCalls, status: 'succeeded', final_amount: 199 }));
  });
});
await new Promise((r) => whop.listen(WHOP_PORT, r));

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  WHOP_API_BASE: `http://127.0.0.1:${WHOP_PORT}`, WHOP_API_KEY: 'k', WHOP_COMPANY_ID: 'biz_test',
  FUNNEL_PUBLIC_ENABLED: '1', MONEY_SWEEP_DISABLED: '1',
  TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: app } = await import('/Users/ludo/Puure-integrator/server/src/app.js');
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 4000));
const sql = postgres(DB, { ssl: false });
const { ensureCheckoutTables } = await import('/Users/ludo/Puure-integrator/server/src/services/checkoutSchema.js');
await ensureCheckoutTables();

// a PAID session with a saved PM, minted the way create-session does
const SID = 'co_' + crypto.randomBytes(16).toString('hex');
const TOKEN = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(TOKEN).digest('hex');
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, shipping, tax, total, currency,
  gateway, gateway_customer_id, payment_method_id, confirm_token_hash, paid_at)
  VALUES (${SID},'f_auth','p1','paid', ${sql.json([{ variant_id: '1', quantity: 1, price: 10 }])},10,0,0,10,'USD',
          'whop','mem_victim','pm_victim_card',${hash}, NOW())`;
await sql`INSERT INTO co_upsells (id, funnel_id, page_id, variant_id, price, title, enabled)
  VALUES ('up_auth','f_auth','p1','v1',199,'Offer',TRUE)`;

const accept = (cookie) => fetch(`http://127.0.0.1:${PORT}/api/v1/checkout/public/upsell/accept`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ session_id: SID, offer_id: 'up_auth' }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

// ---- ATTACK: knows only the (leaked) session id
const before = gatewayCalls;
const a1 = await accept(null);
ok(a1.status === 403 && a1.json?.error?.code === 'confirmation_required',
  'ATTACK with leaked session id alone → 403 confirmation_required', JSON.stringify(a1));
// attacker forging the cookie with the id he knows
const a2 = await accept(`__fos_ck=${SID}`);
ok(a2.status === 403, 'ATTACK forging the cookie from the known id → still 403', JSON.stringify(a2));
const a3 = await accept(`__fos_ck=${'0'.repeat(64)}`);
ok(a3.status === 403, 'ATTACK with a guessed 64-hex token → 403', JSON.stringify(a3));
ok(gatewayCalls === before, `ATTACK caused ZERO gateway charges (calls=${gatewayCalls})`);

// ---- LEGITIMATE buyer: holds the HttpOnly cookie
const good = await accept(`__fos_ck=${TOKEN}`);
ok(good.status === 200, 'BUYER with the confirmation cookie is authorized', JSON.stringify(good).slice(0, 160));
ok(gatewayCalls === before + 1, `BUYER charge reached the gateway exactly once (calls=${gatewayCalls})`);

// ---- decline is protected too
const d = await fetch(`http://127.0.0.1:${PORT}/api/v1/checkout/public/upsell/decline`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: SID, offer_id: 'up_auth' }),
}).then((r) => r.status);
ok(d === 403, 'ATTACK on /upsell/decline → 403 (take-rate poisoning blocked)', String(d));

// ---- create-session issues the cookie HttpOnly and never echoes the token
const mint = await fetch(`http://127.0.0.1:${PORT}/api/v1/checkout/public/create-session`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ funnel_id: 'f_auth', page_id: 'p1', line_items: [{ variant_id: 'x', quantity: 1 }] }),
});
const setCookie = mint.headers.get('set-cookie') || '';
const bodyTxt = await mint.text();
if (mint.status === 200) {
  ok(/__fos_ck=/.test(setCookie) && /HttpOnly/i.test(setCookie),
    'create-session sets the confirmation cookie HttpOnly', setCookie.slice(0, 90));
  ok(!/__fos_ck/.test(bodyTxt), 'confirmation token is NOT echoed in the response body');
} else {
  // No Shopify creds in this harness env: the mint legitimately refuses before
  // reaching the cookie. Assert the SHAPE of the refusal instead of skipping.
  ok(mint.status === 503 || mint.status === 422,
    `create-session refused without pricing (${mint.status}) — cookie path exercised in the checkout e2e`, bodyTxt.slice(0, 120));
  ok(!/__fos_ck/.test(bodyTxt), 'confirmation token is NOT echoed in the response body');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end(); server.close(); whop.close();
process.exit(fail ? 1 : 0);
