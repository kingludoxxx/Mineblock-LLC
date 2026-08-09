// Verify the two money-path tracking call-sites by EXECUTION:
//   W1  create-session persists co_sessions.vid + click_vault from the
//       visitor's lb_clicks rows (latest value per click param, bots excluded)
//   W2  an invalid/missing _fos_vid mints fine with vid NULL + empty vault
//   W3  the vault read failing (table dropped) is fail-open — mint succeeds
//   W4  settleUpsellCharge fires the upsell Purchase (event_id
//       pur_<sid>_u_<chargeRowId>) exactly once — replayed settle re-sends
//       nothing (lb_tracking_sent claim)
//   W5  null-amount upsell fire is refused (no $0 Purchase pollution)
// Own DB + port; mock relay via TRACKING_RELAY_OVERRIDE_URL. No production contact.
import crypto from 'crypto';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_trkwire';
const PORT = 48930;
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, extra); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_trkwire`;
await admin`CREATE DATABASE puure_trkwire`;
await admin.end();

// ---- mock CAPI relay: records every delivered body
import http from 'http';
const delivered = [];
const relay = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { delivered.push(JSON.parse(body)); } catch { delivered.push({ raw: body }); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ events_received: 1 }));
  });
});
await new Promise((r) => relay.listen(48931, r));

process.env.DATABASE_URL = DB;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'localdev'; process.env.JWT_REFRESH_SECRET = 'localdev';
process.env.FUNNEL_PUBLIC_ENABLED = '1';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.TRACKING_SWEEPS_DISABLED = '1';
process.env.DOMAIN_SWEEP_DISABLED = '1';
process.env.SHOPIFY_ORDER_CREATE_ENABLED = '0';
process.env.TRACKING_RELAY_OVERRIDE_URL = 'http://127.0.0.1:48931/capi';
process.env.PUURE_SHOPIFY_STORE = 'mock.myshopify.com';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock';

// In-process Shopify pricing mock: intercept the GraphQL pricing call so the
// REAL create-session route runs end-to-end (authoritative re-pricing incl.).
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/graphql.json')) {
    const vars = JSON.parse(init?.body || '{}')?.variables || {};
    const nodes = (vars.ids || []).map((gid) => ({
      id: gid, title: 'W Variant', price: '25.0', compareAtPrice: null,
      availableForSale: true, image: null,
      product: { id: 'gid://shopify/Product/1', title: 'W Prod', status: 'ACTIVE', featuredImage: null },
    }));
    return new Response(JSON.stringify({ data: { shop: { currencyCode: 'USD' }, nodes } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const { default: app } = await import('/Users/ludo/Puure-integrator/server/src/app.js');
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 4000));

const sql = postgres(DB, { ssl: false });
const { ensureCheckoutTables } = await import('/Users/ludo/Puure-integrator/server/src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('/Users/ludo/Puure-integrator/server/src/services/trackingSchema.js');
await ensureCheckoutTables(); await ensureTrackingTables();

// ---- fixtures: funnel + page + offer product so create-session mints
await sql`INSERT INTO funnels (id, name, slug, status) VALUES ('fn_w', 'W', 'w', 'published')
          ON CONFLICT (id) DO NOTHING`.catch(() => {});
const VID = 'v_' + crypto.randomBytes(8).toString('hex');
const now = new Date();
const exp = new Date(Date.now() + 86400_000);
// three clicks: latest fbclid wins, gclid rides along, bot row excluded
await sql`INSERT INTO lb_clicks (id, funnel_id, vid, network, click_id, click_key, ts, expires_at)
          VALUES ('ck1', 'fn_w', ${VID}, 'meta', 'FB_OLD', 'fbclid', ${new Date(now - 60000)}, ${exp}),
                 ('ck2', 'fn_w', ${VID}, 'meta', 'FB_NEW', 'fbclid', ${now}, ${exp}),
                 ('ck3', 'fn_w', ${VID}, 'google', 'G_1', 'gclid', ${now}, ${exp}),
                 ('ck4', 'fn_w', ${VID}, 'meta', 'FB_BOT', 'ttclid', ${now}, ${exp})`;
await sql`UPDATE lb_clicks SET bot = TRUE WHERE id = 'ck4'`;

// Mint through the REAL public route (authoritative re-pricing runs against
// the in-process GraphQL mock above).
async function mint(cookieVid) {
  const res = await realFetch(`http://127.0.0.1:${PORT}/api/v1/checkout/public/create-session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookieVid ? { cookie: `_fos_vid=${cookieVid}` } : {}),
    },
    body: JSON.stringify({ funnel_id: 'fn_w', line_items: [{ variant_id: '58222941077807', quantity: 1 }] }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// W1 — vault persisted
{
  const r = await mint(VID);
  const sid = r.body?.data?.session_id || r.body?.session_id;
  ok(r.status === 200 || r.status === 201, `W1 mint ok (status ${r.status})`, JSON.stringify(r.body).slice(0, 200));
  if (sid) {
    const rows = await sql`SELECT vid, click_vault FROM co_sessions WHERE id = ${sid}`;
    ok(rows.length === 1, 'W1 session row exists');
    ok(rows[0]?.vid === VID, 'W1 vid persisted', JSON.stringify(rows[0]));
    const vault = rows[0]?.click_vault || {};
    ok(vault.fbclid === 'FB_NEW', 'W1 vault has LATEST fbclid (FB_NEW beats FB_OLD)', JSON.stringify(vault));
    ok(vault.gclid === 'G_1', 'W1 vault carries gclid');
    ok(!('ttclid' in vault), 'W1 bot click excluded from vault');
  } else {
    ok(false, 'W1 no session id in mint response', JSON.stringify(r.body).slice(0, 300));
  }
}

// W2 — invalid vid: mints, vid NULL, vault empty
{
  const r = await mint('<script>not-a-vid');
  const sid = r.body?.data?.session_id || r.body?.session_id;
  ok(!!sid, 'W2 mint ok with hostile vid cookie');
  if (sid) {
    const rows = await sql`SELECT vid, click_vault FROM co_sessions WHERE id = ${sid}`;
    ok(rows[0]?.vid === null, 'W2 vid NULL for invalid cookie');
    ok(Object.keys(rows[0]?.click_vault || {}).length === 0, 'W2 vault empty');
  }
}

// W3 — vault read failure is fail-open (drop table, mint must still work)
{
  await sql`ALTER TABLE lb_clicks RENAME TO lb_clicks_hidden`;
  const r = await mint(VID);
  const sid = r.body?.data?.session_id || r.body?.session_id;
  ok(!!sid, 'W3 mint survives lb_clicks read failure (fail-open)');
  if (sid) {
    const rows = await sql`SELECT vid, click_vault FROM co_sessions WHERE id = ${sid}`;
    ok(rows[0]?.vid === VID, 'W3 vid still persisted');
    ok(Object.keys(rows[0]?.click_vault || {}).length === 0, 'W3 vault empty on read failure');
  }
  await sql`ALTER TABLE lb_clicks_hidden RENAME TO lb_clicks`;
}

// W4 — upsell settle fires exactly once
{
  const sid = 'co_' + crypto.randomBytes(16).toString('hex');
  await sql`INSERT INTO co_sessions (id, funnel_id, status, total, currency, paid_at, line_items, customer, tracking_net, click_vault)
            VALUES (${sid}, 'fn_w', 'paid', 25.00, 'USD', NOW(), '[]', '{}', '{}', '{}')`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_w', 'fn_w', 'meta_pixel', '123456789', 's2s', TRUE, ${sql.json({ pixel_id: '123456789', capi_token: 'tok_plain' })})`;
  const chg = await sql`INSERT INTO co_upsell_charges (id, session_id, offer_id, charge_id, amount, currency, status)
                        VALUES ('uc_w4', ${sid}, 'of_1', 'chg_w4', 19.00, 'USD', 'pending_settlement') RETURNING id`;
  const chargeRowId = chg[0].id;
  const { settleUpsellCharge } = await import('/Users/ludo/Puure-integrator/server/src/services/checkoutSettle.js');
  const before = delivered.length;
  const r1 = await settleUpsellCharge({ chargeRowId, gatewayPaymentId: 'pay_w4', expectedSessionId: sid });
  ok(r1.ok === true && r1.settled === true, 'W4 settle ok', JSON.stringify(r1));
  await new Promise((r) => setTimeout(r, 1200)); // fire-and-forget drain
  const sent = delivered.slice(before);
  const evtIds = sent.flatMap((b) => (b?.data || []).map((e) => e.event_id)).filter(Boolean);
  ok(evtIds.includes(`pur_${sid}_u_${chargeRowId}`), 'W4 upsell Purchase delivered with deterministic event_id', JSON.stringify(evtIds));
  // replay: second settle is already:true and sends nothing new
  const before2 = delivered.length;
  const r2 = await settleUpsellCharge({ chargeRowId, gatewayPaymentId: 'pay_w4', expectedSessionId: sid });
  ok(r2.ok === true && r2.already === true, 'W4 replay settle is a no-op');
  await new Promise((r) => setTimeout(r, 800));
  ok(delivered.length === before2, 'W4 replay sent NOTHING (claim held)', `delta=${delivered.length - before2}`);
  const claims = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE event_id = ${'pur_' + sid + '_u_' + chargeRowId}`;
  ok(claims[0].n === 1, 'W4 exactly one claim row');
}

// W5 — null value refused
{
  const { fireUpsellPurchaseConversion } = await import('/Users/ludo/Puure-integrator/server/src/services/trackingService.js');
  const r = await fireUpsellPurchaseConversion('co_nonexistent', 999, null);
  ok(r.ok === false && r.reason === 'no_value', 'W5 null value refused pre-lookup', JSON.stringify(r));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close(); relay.close();
await sql.end();
process.exit(fail ? 1 : 0);
