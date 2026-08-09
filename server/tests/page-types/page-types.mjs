// PAGE-TYPES slice verification (feat/page-types).
//
// Boots the real Express app against an isolated DB (puure_pagetypes) with a
// MOCK Whop /payments seam (no real charge) and REAL read-only Shopify
// pricing. Exercises, BY EXECUTION:
//   • funnels.js seed switch: every new page type seeds its template on
//     create through the REAL authed POST /:id/pages route
//   • public serving: each page type renders 200 at /f/<slug>/… with its
//     blocks + runtime; pages without the new blocks stay runtime-free
//   • XSS: hostile props on every NEW block type are inert when served
//   • downsell: the upsell_offer block + EXISTING /upsell/* endpoints —
//     exactly-once accept under double-click (mock gateway call count +
//     charge rows), decline path advance
//   • optin: lead written; honeypot dropped; invalid email 400; rate limit
//   • thank-you: session snapshot endpoint reachable; page render has the
//     confirmation runtime; edge: no ?s= still 200
//
// Run:  set -a; . ~/.config/puure/shopify.env; set +a
//       node server/tests/page-types/page-types.mjs
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const PORT = 4024;
const MOCK_WHOP_PORT = 4112;
const DB = 'postgres://puure@127.0.0.1:5433/puure_pagetypes';

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

// Shopify env (live read-only pricing for /upsell/offer) — load from the
// operator config if the shell didn't already export it.
try {
  const envFile = fs.readFileSync(
    `${process.env.HOME}/.config/puure/shopify.env`, 'utf8'
  );
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(DB, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`PASS  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}  ${d}`); }
};

// ── mock Whop /payments (controllable mode + call counter) ──────────────────
let whopMode = 'succeed';
let whopCalls = [];
const idemMap = new Map();
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

// ── auth prerequisites: roles/users/user_roles DDL + a SuperAdmin ───────────
for (const f of ['001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql']) {
  const ddl = fs.readFileSync(path.join(ROOT, 'server/migrations', f), 'utf8');
  await sql.unsafe(ddl);
}
await sql.unsafe(fs.readFileSync(path.join(ROOT, 'server/migrations', '009_saas_users.sql'), 'utf8'));
// sessions (005 + the 008 rename) — 005 is not idempotent once 008 renamed the
// column, so apply only when the table is absent.
const sessTable = await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions'`;
if (!sessTable.length) {
  await sql.unsafe(fs.readFileSync(path.join(ROOT, 'server/migrations', '005_create_sessions.sql'), 'utf8'));
  await sql.unsafe(fs.readFileSync(path.join(ROOT, 'server/migrations', '008_fix_sessions_column.sql'), 'utf8'));
}
// bcrypt hash of 'PageTypes2026!' minted below with the repo's own bcrypt.
const bcrypt = (await import(`${NM}/bcrypt/bcrypt.js`)).default;
const HASH = bcrypt.hashSync('PageTypes2026!', 12);
await sql`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = 'pagetypes@local.test')`;
await sql`DELETE FROM users WHERE email = 'pagetypes@local.test'`;
await sql`INSERT INTO roles (name, permissions, is_system) VALUES ('SuperAdmin', ${sql.json({ '*': ['*'] })}, TRUE)
          ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_active)
          VALUES ('pagetypes@local.test', ${HASH}, 'Page', 'Types', TRUE)`;
await sql`INSERT INTO user_roles (user_id, role_id)
          SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'pagetypes@local.test' AND r.name = 'SuperAdmin'`;

// ── boot the real app + the optin router (INTEGRATION HOOK under test) ──────
const app = (await import('../../src/app.js')).default;
// INTEGRATION HOOK (documented in routes/optinPublic.js): app.js is owned by
// another lane, so the harness mounts the router exactly as app.js will:
const optinPublicRoutes = (await import('../../src/routes/optinPublic.js')).default;
app.use('/api/v1/optin/public', optinPublicRoutes);
const { ensureTables } = await import('../../src/routes/funnels.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureOptinTables } = await import('../../src/services/optinLeads.js');
await ensureTables();
await ensureCheckoutTables();
await ensureOptinTables();
const server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

const B = `http://127.0.0.1:${PORT}`;
const CO = `${B}/api/v1/checkout/public`;
const OPTIN = `${B}/api/v1/optin/public`;
const get = async (u) => { const r = await fetch(u); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const getText = async (u) => { const r = await fetch(u); return { status: r.status, text: await r.text() }; };
const post = async (u, b, h = {}) => {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, j };
};

// ── login (real route) ──────────────────────────────────────────────────────
const login = await post(`${B}/api/v1/auth/login`, { email: 'pagetypes@local.test', password: 'PageTypes2026!' });
const TOKEN = login.j?.accessToken || login.j?.data?.accessToken;
check('0. login issues a JWT access token', typeof TOKEN === 'string' && TOKEN.split('.').length === 3,
  `status=${login.status} token=${String(TOKEN).slice(0, 25)}`);
const H = { Authorization: `Bearer ${TOKEN}` };

// ── clean + create the funnel & pages through the REAL routes ──────────────
const SLUG = 'ptdemo';
await sql`DELETE FROM co_upsell_charges WHERE session_id LIKE 'sid_pt%'`;
await sql`DELETE FROM co_events WHERE session_id LIKE 'sid_pt%'`;
await sql`DELETE FROM co_sessions WHERE id LIKE 'sid_pt%'`;
await sql`DELETE FROM co_upsells WHERE id LIKE 'up_pt%'`;
await sql`DELETE FROM optin_leads WHERE TRUE`;
const oldF = await sql`SELECT id FROM funnels WHERE slug = ${SLUG}`;
if (oldF.length) {
  await sql`DELETE FROM funnel_pages WHERE funnel_id = ${oldF[0].id}`;
  await sql`DELETE FROM funnels WHERE id = ${oldF[0].id}`;
}

const fRes = await post(`${B}/api/v1/funnels`, { name: 'Page Types Demo', slug: SLUG }, H);
const FN = fRes.j?.data?.id;
check('1. funnel created via API', fRes.status === 201 && !!FN, JSON.stringify(fRes.j)?.slice(0, 200));

// Every page type goes through the REAL create route → the seed switch runs.
const mkPage = async (slug, type, title) => {
  const r = await post(`${B}/api/v1/funnels/${FN}/pages`, { title, slug, type }, H);
  return { status: r.status, page: r.j?.data };
};
const pages = {};
for (const [slug, type] of [
  ['/', 'checkout'], ['/upsell', 'upsell'], ['/downsell', 'downsell'],
  ['/thankyou', 'thankyou'], ['/optin', 'optin'], ['/store', 'storefront'],
  ['/quiz', 'quiz'], ['/story', 'lead'], ['/plain', 'generic'],
]) {
  const { status, page } = await mkPage(slug, type, `${type} page`);
  pages[type] = page;
  check(`2. create ${type} page -> 201`, status === 201 && !!page?.id, `status=${status}`);
}

// Seed switch assertions — blocks landed on the row for every templated type.
const expectSeed = {
  downsell: ['upsell_offer'],
  thankyou: ['order_confirmation'],
  optin: ['optin_form'],
  storefront: ['storefront_grid'],
  quiz: ['quiz_steps'],
  lead: ['heading', 'checklist', 'image'],
};
for (const [type, wantTypes] of Object.entries(expectSeed)) {
  const blocks = pages[type]?.blocks || [];
  const typesOnPage = blocks.map((b) => b?.type);
  check(
    `3. ${type} seeds blocks (${wantTypes.join('+')})`,
    blocks.length > 0 && wantTypes.every((t) => typesOnPage.includes(t)),
    JSON.stringify(typesOnPage)
  );
  check(`3. ${type} seeds custom_css`, String(pages[type]?.custom_css || '').length > 50);
}
check('3. generic page stays an empty canvas', (pages.generic?.blocks || []).length === 0);
check('3. invalid type still rejected', (await mkPage('/bad', 'bogus', 'x')).status === 400);

// ── publish + wire the flow (downsell: main→thankyou, fallback→thankyou) ────
await sql`UPDATE funnels SET status = 'published', flow_layout = ${sql.json({
  nodes: [],
  edges: [
    { source: pages.checkout.id, target: pages.upsell.id, kind: 'main' },
    { source: pages.upsell.id, target: pages.thankyou.id, kind: 'main' },
    { source: pages.upsell.id, target: pages.downsell.id, kind: 'fallback' },
    { source: pages.downsell.id, target: pages.thankyou.id, kind: 'main' },
    { source: pages.downsell.id, target: pages.thankyou.id, kind: 'fallback' },
    { source: pages.optin.id, target: pages.thankyou.id, kind: 'main' },
    { source: pages.quiz.id, target: pages.optin.id, kind: 'main' },
    { source: pages.lead.id, target: pages.quiz.id, kind: 'main' },
  ],
})} WHERE id = ${FN}`;
await sql`UPDATE funnel_pages SET status = 'published' WHERE funnel_id = ${FN}`;

// ── 4. SERVE — each page type renders with its structure + runtime ──────────
const html = {};
for (const [type, pth] of [
  ['downsell', '/downsell'], ['thankyou', '/thankyou'], ['optin', '/optin'],
  ['storefront', '/store'], ['quiz', '/quiz'], ['lead', '/story'], ['plain', '/plain'],
]) {
  const r = await getText(`${B}/f/${SLUG}${pth}`);
  html[type] = r.text;
  check(`4. ${type} serves 200`, r.status === 200, `status=${r.status}`);
}
// downsell = upsell machinery + downsell copy
check('4. downsell has upsell_offer block + runtime', html.downsell.includes('data-fos-upsell') && html.downsell.includes('window.__fos_upsell'));
check('4. downsell copy differs from upsell (no em-dash in visible copy)', html.downsell.includes('Grab this lighter option') && !/[—]/.test(html.downsell.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')));
check('4. downsell flow main+fallback -> thankyou', html.downsell.includes(`/f/${SLUG}/thankyou`));
// thank-you
check('4. thankyou has order_confirmation + runtime', html.thankyou.includes('data-fos-orderconf') && html.thankyou.includes('window.__fos_thankyou'));
check('4. thankyou runtime reads EXISTING /session/:id (no new endpoint)', html.thankyou.includes("'/session/'") || html.thankyou.includes('/session/'));
check('4. thankyou headline + support + continue present', html.thankyou.includes('Thank you! Your order is confirmed.') && html.thankyou.includes('support@trypuure.co') && html.thankyou.includes('Back to the store'));
// optin
check('4. optin has form + honeypot + runtime', html.optin.includes('data-fos-optin') && html.optin.includes("name='website'") && html.optin.includes('window.__fos_optin'));
// storefront
check('4. storefront renders 3 cards', (html.storefront.match(/lb-sf-card/g) || []).length >= 3);
// quiz
check('4. quiz renders steps, first visible only', html.quiz.includes("data-fos-quiz-step='0'") && html.quiz.includes("data-fos-quiz-step='1' hidden"));
check('4. quiz runtime present, answers NEVER in URL', html.quiz.includes('__fos_quiz_answers') && !html.quiz.includes("searchParams.set('q'"));
// lead / advertorial
check('4. advertorial uses generic blocks + flow CTA', html.lead.includes('lb-checklist') && html.lead.includes('#fos-next'));
check('4. advertorial CTA resolves to quiz via flow data', html.lead.includes(`/f/${SLUG}/quiz`));
const stripNonCopy = (t) => t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
for (const t of ['lead', 'thankyou', 'optin', 'storefront', 'quiz']) {
  check(`4. ${t} visible copy carries no em-dash`, !/[—]/.test(stripNonCopy(html[t])));
}
// runtime emission is conditional — a plain page carries NONE of the new runtimes
check('4. plain page carries no page-type runtimes', !html.plain.includes('__fos_thankyou') && !html.plain.includes('__fos_optin') && !html.plain.includes('data-fos-quiz') && !html.plain.includes('__fos_checkout='));

// countdown runtime — only when a countdown block is present
await sql`UPDATE funnel_pages SET blocks = ${sql.json([
  { id: 'cd1', type: 'countdown', props: { label: 'Offer ends in', deadline: new Date(Date.now() + 3600e3).toISOString() } },
])} WHERE id = ${pages.generic.id}`;
{
  const r = await getText(`${B}/f/${SLUG}/plain`);
  check('4. countdown block turns on the countdown runtime', r.status === 200 && r.text.includes('data-deadline') && r.text.includes('Offer expired'));
}

// ── 5. XSS — hostile props on EVERY new block type, served ──────────────────
const HOSTILE = `</script><script>alert(1)</script><img src=x onerror=alert(2)>`;
const QUOTE_BREAK = `' onmouseover='alert(3)`;
await sql`UPDATE funnel_pages SET blocks = ${sql.json([
  { id: 'x1', type: 'order_confirmation', props: { title: HOSTILE, note: HOSTILE } },
  { id: 'x2', type: 'optin_form', props: { headline: HOSTILE, button_text: HOSTILE, success_text: HOSTILE, email_placeholder: QUOTE_BREAK, name_placeholder: QUOTE_BREAK } },
  { id: 'x3', type: 'storefront_grid', props: { items: [{ title: HOSTILE, price: HOSTILE, href: 'javascript:alert(4)', image: 'javascript:alert(5)', cta: HOSTILE }] } },
  { id: 'x4', type: 'quiz_steps', props: { questions: [{ question: HOSTILE, options: [HOSTILE, QUOTE_BREAK] }], finish_text: HOSTILE, done_text: HOSTILE } },
])} WHERE id = ${pages.generic.id}`;
{
  const r = await getText(`${B}/f/${SLUG}/plain`);
  const t = r.text;
  check('5. hostile props page still 200 (fail-open)', r.status === 200, `status=${r.status}`);
  check('5. no raw <script>alert(1) anywhere', !t.includes('<script>alert(1)</script>'));
  check('5. no raw onerror handler', !t.includes('<img src=x onerror=alert(2)>'));
  check('5. escaped forms present (payload visible but inert)', t.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  check('5. javascript: href collapsed to #', !t.includes('javascript:alert(4)') && !t.includes('javascript:alert(5)'));
  check('5. attr quote-breakout escaped', !t.includes("' onmouseover='alert(3)"));
}
// restore the plain page
await sql`UPDATE funnel_pages SET blocks = '[]'::jsonb WHERE id = ${pages.generic.id}`;

// ── 6. DOWNSELL money path — EXISTING endpoints, exactly-once ───────────────
const VARIANT = '58222941077807'; // live variant (same one upsell-page.mjs uses)
const mkSession = (id, withPm) =>
  sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, gateway, currency,
        gateway_customer_id, payment_method_id, total, subtotal)
      VALUES (${id}, ${FN}, ${pages.checkout.id}, 'paid', 'whop', 'USD',
        ${withPm ? 'mem_test' : null}, ${withPm ? 'pm_test' : null}, 89, 89)`;
await mkSession('sid_pt_paid', true);
await mkSession('sid_pt_decl', true);
await sql`INSERT INTO co_upsells (id, funnel_id, page_id, variant_id, price, title, enabled)
  VALUES ('up_pt_down', ${FN}, ${pages.downsell.id}, ${VARIANT}, 29.99, 'Downsell Lite Deal', TRUE)`;

let offer;
{
  const r = await get(`${CO}/upsell/offer?session_id=sid_pt_paid&page_id=${pages.downsell.id}`);
  offer = r.j?.data;
  check('6. downsell offer resolves via page binding (EXISTING endpoint)', r.status === 200 && offer?.offer_id === 'up_pt_down', JSON.stringify(r.j)?.slice(0, 200));
  check('6. downsell price is the server price (29.99)', offer?.price === 29.99, JSON.stringify(offer));
}
{
  whopMode = 'succeed'; whopCalls = []; idemMap.clear();
  // double-click: two rapid accepts for the same session+offer
  const [r1, r2] = await Promise.all([
    post(`${CO}/upsell/accept`, { session_id: 'sid_pt_paid', offer_id: 'up_pt_down' }),
    post(`${CO}/upsell/accept`, { session_id: 'sid_pt_paid', offer_id: 'up_pt_down' }),
  ]);
  const st = [r1.j?.data?.status, r2.j?.data?.status].sort();
  const rows = await sql`SELECT id, status FROM co_upsell_charges WHERE session_id = 'sid_pt_paid' AND offer_id = 'up_pt_down' AND amount > 0`;
  check('6. double-click accept -> both 200', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
  check('6. exactly ONE charge row', rows.length === 1, `rows=${rows.length}`);
  check('6. at most ONE distinct gateway idempotency key', new Set(whopCalls.map((c) => c.idem)).size <= 1, `calls=${whopCalls.length}`);
  // Concurrent second click may legitimately see 'processing' (the pending row
  // exists, the charge is NOT re-sent — the runtime polls); what matters is
  // one row + one gateway key, asserted above.
  check('6. statuses are settled/already_purchased/processing', st.every((s) => ['settled', 'already_purchased', 'processing'].includes(s)), JSON.stringify(st));
  // third click after settle: still no new charge
  const r3 = await post(`${CO}/upsell/accept`, { session_id: 'sid_pt_paid', offer_id: 'up_pt_down' });
  const rows2 = await sql`SELECT id FROM co_upsell_charges WHERE session_id = 'sid_pt_paid' AND offer_id = 'up_pt_down' AND amount > 0`;
  check('6. repeat accept after settle -> already_purchased, still one row', r3.j?.data?.status === 'already_purchased' && rows2.length === 1, JSON.stringify(r3.j));
}
{
  const r = await post(`${CO}/upsell/decline`, { session_id: 'sid_pt_decl', offer_id: 'up_pt_down' });
  check('6. decline on the downsell offer -> 200 (EXISTING endpoint)', r.status === 200, `status=${r.status}`);
}

// ── 7. THANK-YOU session snapshot (EXISTING endpoint the runtime calls) ─────
{
  await sql`UPDATE co_sessions SET line_items = ${sql.json([
    { title: 'Puure Device', product_title: 'Puure Device', quantity: 1, price: 89, image: null },
  ])} WHERE id = 'sid_pt_paid'`;
  const r = await get(`${CO}/session/sid_pt_paid`);
  check('7. GET /session/:id returns the safe snapshot', r.status === 200 && r.j?.data?.totals?.total === 89, JSON.stringify(r.j)?.slice(0, 200));
  const r404 = await get(`${CO}/session/sid_does_not_exist`);
  check('7. unknown session -> 404 (no oracle)', r404.status === 404);
  const rNoS = await getText(`${B}/f/${SLUG}/thankyou`);
  check('7. thankyou page without ?s= still 200 (edge)', rNoS.status === 200);
}

// ── 8. OPTIN — lead written; honeypot dropped; bad email 400; rate limit ────
{
  const ok = await post(`${OPTIN}/submit`, { email: 'buyer@example.com', name: 'Jane', funnel_id: FN, page_id: pages.optin.id });
  const leads = await sql`SELECT email, name, funnel_id, page_id FROM optin_leads WHERE email = 'buyer@example.com'`;
  check('8. valid submit -> 201 + lead row', ok.status === 201 && ok.j?.success === true && leads.length === 1, `status=${ok.status} rows=${leads.length}`);
  check('8. lead carries funnel/page attribution', leads[0]?.funnel_id === FN && leads[0]?.page_id === pages.optin.id);

  const bot = await post(`${OPTIN}/submit`, { email: 'bot@example.com', website: 'http://spam.example' });
  const botRows = await sql`SELECT id FROM optin_leads WHERE email = 'bot@example.com'`;
  check('8. honeypot filled -> success-shaped 201, NO row', bot.status === 201 && bot.j?.success === true && botRows.length === 0, `rows=${botRows.length}`);

  const bad = await post(`${OPTIN}/submit`, { email: 'not-an-email' });
  check('8. invalid email -> 400 invalid_email', bad.status === 400 && bad.j?.error?.code === 'invalid_email');
  const missing = await post(`${OPTIN}/submit`, {});
  check('8. missing body fields -> 400, no crash', missing.status === 400);
  const nonJson = await fetch(`${OPTIN}/submit`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(10) });
  check('8. non-JSON body -> clean 4xx, no crash', nonJson.status === 400 || nonJson.status === 415, `status=${nonJson.status}`);

  // hostile lead content is stored as DATA (parameterized insert) — and long
  // inputs are bounded
  const xssLead = await post(`${OPTIN}/submit`, { email: 'x@example.com', name: `<script>alert(1)</script>${'A'.repeat(500)}` });
  const xr = await sql`SELECT name FROM optin_leads WHERE email = 'x@example.com'`;
  check('8. hostile/long name stored bounded as data', xssLead.status === 201 && xr[0]?.name?.length <= 120, `len=${xr[0]?.name?.length}`);

  // origin allow-list (read at request time): a disallowed Origin is refused,
  // an allowed one passes, and header-less clients are never blocked
  process.env.OPTIN_ALLOWED_ORIGINS = 'trypuure.co';
  const badOrigin = await post(`${OPTIN}/submit`, { email: 'o1@example.com' }, { Origin: 'https://evil.example' });
  check('8. disallowed Origin -> 403', badOrigin.status === 403 && badOrigin.j?.error?.code === 'origin_not_allowed', `status=${badOrigin.status}`);
  const goodOrigin = await post(`${OPTIN}/submit`, { email: 'o2@example.com' }, { Origin: 'https://trypuure.co' });
  check('8. allowed Origin -> 201', goodOrigin.status === 201, `status=${goodOrigin.status}`);
  process.env.OPTIN_ALLOWED_ORIGINS = '';

  // rate limit: bucket is 10/min/IP — we already used 7; the next burst must
  // include a 429 tail
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await post(`${OPTIN}/submit`, { email: `rl${i}@example.com` });
    if (r.status === 429) { got429 = true; break; }
  }
  check('8. spam burst hits the per-IP rate limit (429)', got429);
  const after429 = await sql`SELECT COUNT(*)::int AS n FROM optin_leads`;
  check('8. rate-limited submits stored nothing extra (bounded rows)', after429[0].n <= 12, `rows=${after429[0].n}`);
}

// ── 9. money-code freeze — the new surface added ZERO charging code ─────────
{
  // the optin router must not import any gateway/money module (check the
  // import lines, not comments)
  const src = fs.readFileSync(path.join(ROOT, 'server/src/routes/optinPublic.js'), 'utf8');
  const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
  check('9. optinPublic imports no money modules', !/checkoutPricing|checkoutSettle|gatewayWebhooks|whop|stripe/i.test(imports), imports);
  // the new funnelRender section must not CALL any charge endpoint from its
  // runtimes (comments stripped; the downsell block reuses the existing
  // upsell runtime untouched, which is the point)
  const renderSrc = fs.readFileSync(path.join(ROOT, 'server/src/services/funnelRender.js'), 'utf8');
  const newSection = renderSrc
    .slice(renderSrc.indexOf('PAGE-TYPES slice (feat/page-types)'))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check('9. page-types runtimes call no charge endpoint (only /session/:id read + optin submit)', !newSection.includes('/upsell/accept') && !newSection.includes('create-session') && !newSection.includes('/payments'));
}

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
server.close();
mockWhop.close();
process.exit(fail ? 1 : 0);
