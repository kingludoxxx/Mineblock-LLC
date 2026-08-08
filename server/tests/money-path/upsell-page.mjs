// Upsell-page subsystem verification (feat/upsell-page).
//
// Boots the real Express app against an isolated DB (puure_upsell) with a MOCK
// Whop /payments seam (so no real charge) and REAL read-only Shopify pricing.
// Seeds a funnel: checkout -> upsell -> thank-you (+ downsell for the decline
// path), a PAID base session with saved-PM fields, and a co_upsells offer on an
// ACTIVE Shopify variant. Then exercises the buyer-facing money path end to end
// and asserts exactly-once, server-pricing, XSS-safety and the edge cases.
//
// Run:  set -a; . ~/.config/puure/shopify.env; set +a
//       node server/tests/money-path/upsell-page.mjs
import http from 'http';
import crypto from 'crypto';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const PORT = 4021;
const MOCK_WHOP_PORT = 4110;
const DB = 'postgres://puure@127.0.0.1:5433/puure_upsell';

// ── env MUST be set before importing app.js (config/env.js reads at import) ──
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = DB;
process.env.PORT = String(PORT);
process.env.FUNNEL_PUBLIC_ENABLED = '1';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.WHOP_API_BASE = `http://127.0.0.1:${MOCK_WHOP_PORT}`;
process.env.WHOP_API_KEY = 'wk_test_mock';
process.env.WHOP_COMPANY_ID = 'biz_test_mock';
process.env.REDIS_URL = ''; // force the in-memory rate-limit fallback

const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(DB, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`PASS  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}  ${d}`); }
};

// ── mock Whop /payments (controllable mode + call counter) ──────────────────
let whopMode = 'succeed';           // succeed | pending | decline
let whopCalls = [];                 // {idem, body}
const idemMap = new Map();          // Idempotency-Key -> stored response (gateway dedupe)
const mockWhop = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/payments')) {
      const idem = req.headers['idempotency-key'] || '';
      whopCalls.push({ idem, body });
      if (idem && idemMap.has(idem)) {
        const saved = idemMap.get(idem);
        res.writeHead(saved.code, { 'Content-Type': 'application/json' });
        return res.end(saved.payload);
      }
      let code = 200, payload;
      if (whopMode === 'succeed') payload = JSON.stringify({ id: `pay_${crypto.randomBytes(6).toString('hex')}`, status: 'succeeded' });
      else if (whopMode === 'pending') payload = JSON.stringify({ id: `pay_${crypto.randomBytes(6).toString('hex')}`, status: 'processing' });
      else { code = 402; payload = JSON.stringify({ error: { message: 'card_declined', code: 'card_declined' } }); }
      if (idem) idemMap.set(idem, { code, payload });
      res.writeHead(code, { 'Content-Type': 'application/json' });
      return res.end(payload);
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => mockWhop.listen(MOCK_WHOP_PORT, r));

// ── boot the real app ───────────────────────────────────────────────────────
const app = (await import('../../src/app.js')).default;
const { ensureTables } = await import('../../src/routes/funnels.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
await ensureTables();
await ensureCheckoutTables();
const server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

const B = `http://127.0.0.1:${PORT}`;
const CO = `${B}/api/v1/checkout/public`;
const get = async (u) => { const r = await fetch(u); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const getText = async (u) => { const r = await fetch(u); return { status: r.status, text: await r.text() }; };
const post = async (u, b) => {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, j };
};

// ── clean + seed ────────────────────────────────────────────────────────────
const FN = 'fn_up', SLUG = 'updemo';
const P_CK = 'fpg_ck', P_UP = 'fpg_up', P_TY = 'fpg_ty', P_DS = 'fpg_ds';
const VARIANT = '58222941077807'; // Collagen Peptides Gummies — live $89, compare $161
const OFFER_PRICE = 49.99;

async function reseed() {
  await sql`DELETE FROM co_upsell_charges WHERE session_id LIKE 'sid_%'`;
  await sql`DELETE FROM co_events WHERE session_id LIKE 'sid_%'`;
  await sql`DELETE FROM co_sessions WHERE id LIKE 'sid_%'`;
  await sql`DELETE FROM co_upsells WHERE id LIKE 'up_%'`;
  await sql`DELETE FROM funnel_pages WHERE funnel_id = ${FN}`;
  await sql`DELETE FROM funnels WHERE id = ${FN}`;

  await sql`INSERT INTO funnels (id, slug, name, status, flow_layout)
    VALUES (${FN}, ${SLUG}, 'Upsell Demo', 'published',
      ${sql.json({ nodes: [], edges: [
        { source: P_UP, target: P_TY, kind: 'main' },
        { source: P_UP, target: P_DS, kind: 'fallback' },
      ] })})`;

  const fr = await import('../../src/services/funnelRender.js');
  const tpl = fr.upsellPageTemplate();
  const mkPage = (id, slug, type, home, blocks, css) =>
    sql`INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, is_home, blocks, custom_css)
        VALUES (${id}, ${FN}, ${slug}, ${type}, ${type}, 'published', ${home},
                ${sql.json(blocks || [])}, ${css || ''})`;
  await mkPage(P_CK, '/', 'checkout', true, [], '');
  await mkPage(P_UP, '/upsell', 'upsell', false, tpl.blocks, tpl.custom_css);
  await mkPage(P_TY, '/thankyou', 'thankyou', false, [], '');
  await mkPage(P_DS, '/downsell', 'downsell', false, [], '');

  // Offer bound to the upsell page, ACTIVE variant, fixed discounted price.
  await sql`INSERT INTO co_upsells (id, funnel_id, page_id, variant_id, price, title, enabled)
    VALUES ('up_main', ${FN}, ${P_UP}, ${VARIANT}, ${OFFER_PRICE}, 'Collagen Peptides — Members One-Time Deal', TRUE)`;

  const mkSession = (id, withPm) =>
    sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency,
          gateway_customer_id, payment_method_id, total, subtotal)
        VALUES (${id}, ${FN}, ${P_CK}, 'paid', 'whop', 'USD',
          ${withPm ? 'mem_test' : null}, ${withPm ? 'pm_test' : null}, 89, 89)`;
  await mkSession('sid_paid', true);
  await mkSession('sid_nopm', false);
  // an unpaid (processing) session for the not-paid guard
  await sql`INSERT INTO co_sessions (id, funnel_id, status, gateway, currency, total)
    VALUES ('sid_unpaid', ${FN}, 'processing', 'whop', 'USD', 89)`;
}
await reseed();

// ═══ 1. PAGE RENDER ═════════════════════════════════════════════════════════
{
  const r = await getText(`${B}/f/${SLUG}/upsell`);
  const t = r.text;
  check('1. upsell page renders 200', r.status === 200, `status=${r.status}`);
  check('1. has data-fos-upsell block', t.includes('data-fos-upsell'));
  check('1. emits __fos_upsell runtime', t.includes('window.__fos_upsell'));
  check('1. Accept + Decline buttons present', t.includes('data-fos-up-accept') && t.includes('data-fos-up-decline'));
  check('1. no card fields on the upsell page', !/name=['"]card_number['"]/.test(t));
  check('1. flow next_path -> thankyou', t.includes('/f/updemo/thankyou'));
  check('1. flow fallback_path -> downsell', t.includes('/f/updemo/downsell'));
  check('1. runtime wires accept->advanceMain, decline->advanceDecline',
    t.includes('onAccept') && t.includes('advanceMain') && t.includes('advanceDecline'));
}

// ═══ 2. OFFER ENDPOINT — SERVER-PRICED ══════════════════════════════════════
let offerResp;
{
  const r = await get(`${CO}/upsell/offer?session_id=sid_paid&page_id=${P_UP}`);
  offerResp = r.j?.data;
  check('2. offer 200', r.status === 200, `status=${r.status} ${JSON.stringify(r.j)}`);
  check('2. offer_id resolved by page binding', offerResp?.offer_id === 'up_main');
  check('2. server price == offer.price (49.99), NOT client', offerResp?.price === OFFER_PRICE, JSON.stringify(offerResp));
  check('2. original price == live Shopify ($89)', offerResp?.original_price === 89, JSON.stringify(offerResp));
  check('2. discount_pct computed server-side', offerResp?.discount_pct === Math.round((89 - OFFER_PRICE) / 89 * 100), `pct=${offerResp?.discount_pct}`);
  check('2. currency USD', offerResp?.currency === 'USD');
  check('2. image is an https Shopify url', /^https:\/\//.test(offerResp?.image || ''), offerResp?.image);
}

// ═══ 3. XSS — hostile offer name + hostile block props ══════════════════════
{
  // hostile offer TITLE travels as JSON data (client applies via textContent)
  await sql`UPDATE co_upsells SET title = ${'</script><script>alert(1)</script><img src=x onerror=alert(1)>'} WHERE id = 'up_main'`;
  const r = await get(`${CO}/upsell/offer?session_id=sid_paid&page_id=${P_UP}`);
  check('3. hostile title returned as JSON data (valid JSON, not markup)',
    r.status === 200 && typeof r.j?.data?.title === 'string' && r.j.data.title.includes('<script>'),
    JSON.stringify(r.j)?.slice(0, 120));
  await sql`UPDATE co_upsells SET title = ${'Collagen Peptides — Members One-Time Deal'} WHERE id = 'up_main'`;

  // hostile BLOCK props must be escaped by the renderer (esc + jsonForScript)
  const fr = await import('../../src/services/funnelRender.js');
  const hostilePage = {
    id: 'p_hostile', slug: '/x', status: 'published', type: 'upsell',
    blocks: [{
      id: 'b1', type: 'upsell_offer',
      props: {
        offer_id: '"></script><script>alert(1)</script>',
        headline: '<img src=x onerror=alert(1)>',
        accept_text: '</button><script>alert(2)</script>',
      },
    }],
  };
  const html = fr.renderPageHtml(hostilePage, { id: FN, slug: SLUG, status: 'published' }, new Map());
  check('3. hostile headline is HTML-escaped (no raw <img onerror>)',
    !html.includes('<img src=x onerror=alert(1)>') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  check('3. hostile accept_text cannot break out (no raw inline <script>alert(2))',
    !html.includes('<script>alert(2)</script>'));
  check('3. hostile offer_id cannot break the json island (no raw </script><script>alert(1))',
    !html.includes('</script><script>alert(1)</script>'));
}

// ═══ 4. ACCEPT (mock succeed) — exactly-once + server amount ═════════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  const r = await post(`${CO}/upsell/accept`, { session_id: 'sid_paid', offer_id: 'up_main', price: 0.01, amount: 0.01 });
  check('4. accept -> settled', r.j?.data?.status === 'settled', JSON.stringify(r.j));
  const rows = await sql`SELECT status, amount, charge_id FROM co_upsell_charges WHERE session_id = 'sid_paid' AND offer_id = 'up_main'`;
  check('4. exactly ONE charge row', rows.length === 1, `rows=${rows.length}`);
  check('4. row settled', rows[0]?.status === 'settled');
  check('4. charged amount = SERVER price 49.99 (client 0.01 ignored)', Number(rows[0]?.amount) === OFFER_PRICE, `amount=${rows[0]?.amount}`);
  check('4. gateway called exactly once', whopCalls.length === 1, `calls=${whopCalls.length}`);
  const gwBody = JSON.parse(whopCalls[0].body);
  check('4. gateway charged 49.99 (server-priced)', gwBody?.plan?.initial_price === OFFER_PRICE, JSON.stringify(gwBody?.plan));
}

// ═══ 5. DOUBLE-ACCEPT RACE — concurrent, exactly-once ═══════════════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency, gateway_customer_id, payment_method_id, total)
    VALUES ('sid_race', ${FN}, ${P_CK}, 'paid', 'whop', 'USD', 'mem_r', 'pm_r', 89)`;
  const [a, b] = await Promise.all([
    post(`${CO}/upsell/accept`, { session_id: 'sid_race', offer_id: 'up_main' }),
    post(`${CO}/upsell/accept`, { session_id: 'sid_race', offer_id: 'up_main' }),
  ]);
  const rows = await sql`SELECT status FROM co_upsell_charges WHERE session_id = 'sid_race' AND offer_id = 'up_main'`;
  const settled = rows.filter((x) => x.status === 'settled');
  const statuses = [a.j?.data?.status, b.j?.data?.status].sort().join(',');
  check('5. concurrent double-click -> exactly ONE row', rows.length === 1, `rows=${rows.length}`);
  check('5. exactly ONE settled', settled.length === 1);
  check('5. gateway called at most once', whopCalls.length <= 1, `calls=${whopCalls.length}`);
  check('5. responses are {settled, processing|already_purchased}',
    /settled/.test(statuses) && /(processing|already_purchased)/.test(statuses), statuses);
}

// ═══ 6. SAVED-PM ABSENT -> requires_payment_method, no charge ═══════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  const r = await post(`${CO}/upsell/accept`, { session_id: 'sid_nopm', offer_id: 'up_main' });
  check('6. no saved PM -> requires_payment_method', r.j?.data?.status === 'requires_payment_method', JSON.stringify(r.j));
  const rows = await sql`SELECT status FROM co_upsell_charges WHERE session_id = 'sid_nopm'`;
  check('6. NO charge row written (no claim before PM check)', rows.length === 0, `rows=${rows.length}`);
  check('6. gateway NOT called', whopCalls.length === 0, `calls=${whopCalls.length}`);
  check('6. amount still server-priced in the response', r.j?.data?.amount === OFFER_PRICE);
}

// ═══ 7. DECLINE -> advances, no charge ══════════════════════════════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency, gateway_customer_id, payment_method_id, total)
    VALUES ('sid_dec', ${FN}, ${P_CK}, 'paid', 'whop', 'USD', 'mem_d', 'pm_d', 89)`;
  const r = await post(`${CO}/upsell/decline`, { session_id: 'sid_dec', offer_id: 'up_main' });
  check('7. decline -> declined', r.j?.data?.status === 'declined', JSON.stringify(r.j));
  const rows = await sql`SELECT status, charge_id, declined_by_user, amount FROM co_upsell_charges WHERE session_id = 'sid_dec'`;
  check('7. one decline-marker row (charge_id=decline, $0, declined_by_user)',
    rows.length === 1 && rows[0].charge_id === 'decline' && rows[0].declined_by_user === true && Number(rows[0].amount) === 0,
    JSON.stringify(rows));
  check('7. gateway NOT called on decline', whopCalls.length === 0);
}

// ═══ 8. ADVERSARIAL — spoofed / unpaid / disputed session ═══════════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  const spoof = await post(`${CO}/upsell/accept`, { session_id: 'sid_does_not_exist', offer_id: 'up_main' });
  check('8. spoofed session id -> 404 session_not_found', spoof.status === 404 && spoof.j?.error?.code === 'session_not_found', JSON.stringify(spoof.j));
  const unpaid = await post(`${CO}/upsell/accept`, { session_id: 'sid_unpaid', offer_id: 'up_main' });
  check('8. unpaid session -> 409 session_not_paid', unpaid.status === 409 && unpaid.j?.error?.code === 'session_not_paid', JSON.stringify(unpaid.j));
  check('8. no gateway call for spoof/unpaid', whopCalls.length === 0);
  // offer for a session whose funnel differs from a PINNED offer -> not found
  await sql`INSERT INTO co_sessions (id, funnel_id, status, gateway, currency, gateway_customer_id, payment_method_id, total)
    VALUES ('sid_otherfn', 'fn_other', 'paid', 'whop', 'USD', 'm', 'p', 10)`;
  const crossFn = await post(`${CO}/upsell/accept`, { session_id: 'sid_otherfn', offer_id: 'up_main' });
  check('8. pinned offer refuses a foreign-funnel session -> 404 offer_not_found',
    crossFn.status === 404 && crossFn.j?.error?.code === 'offer_not_found', JSON.stringify(crossFn.j));
}

// ═══ 9. DECLINE-AFTER-ACCEPT — settled charge untouched ═════════════════════
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency, gateway_customer_id, payment_method_id, total)
    VALUES ('sid_da', ${FN}, ${P_CK}, 'paid', 'whop', 'USD', 'mem_da', 'pm_da', 89)`;
  const acc = await post(`${CO}/upsell/accept`, { session_id: 'sid_da', offer_id: 'up_main' });
  const dec = await post(`${CO}/upsell/decline`, { session_id: 'sid_da', offer_id: 'up_main' });
  const rows = await sql`SELECT status, charge_id FROM co_upsell_charges WHERE session_id = 'sid_da' ORDER BY charge_id`;
  const settled = rows.find((x) => x.charge_id.startsWith('v:'));
  check('9. accept settled then decline: settled row intact', acc.j?.data?.status === 'settled' && settled?.status === 'settled', JSON.stringify(rows));
  check('9. decline writes a SEPARATE decline slot (no clobber of the paid charge)',
    rows.some((x) => x.charge_id === 'decline') && rows.length === 2, JSON.stringify(rows));
  check('9. gateway called exactly once (accept only)', whopCalls.length === 1, `calls=${whopCalls.length}`);
}

// ═══ 10. PRICING-UNAVAILABLE degrade on offer display ═══════════════════════
{
  // offer with variant_id '' + no live price + fixed price -> still shows amount
  await sql`INSERT INTO co_upsells (id, funnel_id, page_id, variant_id, price, title, enabled)
    VALUES ('up_novar', ${FN}, 'fpg_novar', '', 19.99, 'No-variant fixed offer', TRUE)`;
  const r = await get(`${CO}/upsell/offer?session_id=sid_paid&offer_id=up_novar`);
  check('10. fixed-price offer with no variant still prices (19.99, no image)',
    r.status === 200 && r.j?.data?.price === 19.99 && !r.j?.data?.image, JSON.stringify(r.j));
}

// ═══ 11. PENDING (2xx != settled) — poll is exactly-once ════════════════════
{
  whopMode = 'pending'; whopCalls = []; idemMap.clear();
  await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency, gateway_customer_id, payment_method_id, total)
    VALUES ('sid_pend', ${FN}, ${P_CK}, 'paid', 'whop', 'USD', 'mem_p', 'pm_p', 89)`;
  const r1 = await post(`${CO}/upsell/accept`, { session_id: 'sid_pend', offer_id: 'up_main' });
  check('11. gateway-accepted-not-settled -> processing (never a false settled)', r1.j?.data?.status === 'processing', JSON.stringify(r1.j));
  const [row1] = await sql`SELECT status FROM co_upsell_charges WHERE session_id = 'sid_pend' AND offer_id = 'up_main'`;
  check('11. row held at pending_settlement (webhook is the authority)', row1?.status === 'pending_settlement', row1?.status);
  // the runtime POLLS by re-calling accept — must NOT re-drive the charge
  const r2 = await post(`${CO}/upsell/accept`, { session_id: 'sid_pend', offer_id: 'up_main' });
  check('11. re-accept (poll) returns processing/duplicate', r2.j?.data?.status === 'processing' && r2.j?.data?.duplicate === true, JSON.stringify(r2.j));
  const rows = await sql`SELECT id FROM co_upsell_charges WHERE session_id = 'sid_pend' AND offer_id = 'up_main'`;
  check('11. still exactly ONE row under poll', rows.length === 1, `rows=${rows.length}`);
  check('11. gateway called exactly ONCE across accept+poll', whopCalls.length === 1, `calls=${whopCalls.length}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close(); mockWhop.close(); await sql.end();
process.exit(fail ? 1 : 0);
