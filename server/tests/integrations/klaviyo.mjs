// KLAVIYO integration verification — drives the REAL /api/v1/integrations
// router (real authenticate + requirePermission + ensureIntegrationTables)
// and the REAL klaviyoService/klaviyoEvents against embedded PG + a mock
// Klaviyo server, exactly like the money-path harnesses.
//
// Proves by execution: CRUD masked reads + encrypt-at-rest ('gcm1:' on the
// raw row) + ''=keep/null=clear semantics; test endpoint happy/bad-key;
// profile 409→PATCH conflict flow; event exactly-once (double fire → ONE
// send + ONE claim row); the key never appears in any response body or any
// console line; 401 unauth; fail-closed on mock 500 and timeout (no throw
// into the caller, claim released for retry).
//
// Run:  node server/tests/integrations/klaviyo.mjs   (embedded PG on :5433)
import crypto from 'crypto';
import http from 'http';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const DB = 'postgres://puure@127.0.0.1:5433/puure_klaviyo';
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false, onnotice: () => {} });
await admin`DROP DATABASE IF EXISTS puure_klaviyo`;
await admin`CREATE DATABASE puure_klaviyo`;
await admin.end();

// ── mock Klaviyo ────────────────────────────────────────────────────────────
const GOOD_KEY = 'pk_test_' + crypto.randomBytes(12).toString('hex');
const calls = []; // { method, path, auth, body }
let mode = 'ok'; // 'ok' | 'server_error' | 'timeout'
const knownEmails = new Map(); // email -> profile id (drives the 409 flow)
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch {}
    const auth = req.headers.authorization || '';
    calls.push({ method: req.method, path: req.url, auth, body, revision: req.headers.revision || '' });
    const send = (status, obj) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/vnd.api+json');
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (mode === 'timeout') return; // hang forever — the client's 15s/override timer must fire
    if (mode === 'server_error') return send(500, { errors: [{ status: 500, code: 'internal' }] });
    if (mode === '429_once') {
      mode = 'ok'; // next request succeeds — proves the single retry lands
      res.setHeader('retry-after', '1');
      return send(429, { errors: [{ status: 429, code: 'throttled' }] });
    }
    if (auth !== `Klaviyo-API-Key ${GOOD_KEY}`) {
      return send(401, { errors: [{ status: 401, code: 'not_authenticated', detail: 'Missing or invalid private key.' }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/accounts/')) {
      return send(200, { data: [{ type: 'account', id: 'acc_1', attributes: { test_account: false, contact_information: { organization_name: 'Mock Puure LLC', default_sender_email: 'sender@mock.test', default_sender_name: 'Mock Sender' } } }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/lists/')) {
      return send(200, { data: [{ type: 'list', id: 'L1', attributes: { name: 'Newsletter' } }, { type: 'list', id: 'L2', attributes: { name: 'Buyers' } }] });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/profiles/')) {
      const email = body?.data?.attributes?.email || '';
      if (knownEmails.has(email)) {
        return send(409, { errors: [{ status: 409, code: 'duplicate_profile', meta: { duplicate_profile_id: knownEmails.get(email) } }] });
      }
      const id = 'prof_' + (knownEmails.size + 1);
      knownEmails.set(email, id);
      return send(201, { data: { type: 'profile', id } });
    }
    if (req.method === 'PATCH' && req.url.startsWith('/api/profiles/')) {
      return send(200, { data: { type: 'profile', id: req.url.split('/')[3] } });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/events/')) return send(202);
    if (req.method === 'POST' && req.url.startsWith('/api/profile-subscription-bulk-create-jobs/')) return send(202);
    return send(404, { errors: [{ status: 404, code: 'not_found' }] });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = mock.address().port;

// ── env BEFORE any src import ───────────────────────────────────────────────
Object.assign(process.env, {
  DATABASE_URL: DB,
  NODE_ENV: 'development',
  CHECKOUT_CREDS_KEY: crypto.randomBytes(32).toString('base64'),
  KLAVIYO_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api`,
  KLAVIYO_TIMEOUT_MS: '1500',
});

// Capture EVERY console line so we can prove the key never hits a log.
const logLines = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logLines.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); orig(...a); };
}

const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// seed auth: minimal users/roles + a funnels:access user (patch-settings style)
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_int_test', 'int@local.test', 'Int', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_int_test', 'integrations-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_int_test', 'r_int_test')`;

const integrationsRouter = (await import(`${ROOT}/server/src/routes/integrations.js`)).default;
const { ensureCheckoutTables } = await import(`${ROOT}/server/src/services/checkoutSchema.js`);
const { fireKlaviyoOrderEvent, fireKlaviyoLeadEvent } = await import(`${ROOT}/server/src/services/klaviyoEvents.js`);
await ensureCheckoutTables();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/integrations', integrationsRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/integrations`;

const token = jwt.sign({ userId: 'u_int_test' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const responses = []; // every body text, scanned at the end for the key
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  responses.push(text);
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};

// ── 1. auth gate ────────────────────────────────────────────────────────────
{
  const r = await req('GET', '/klaviyo', undefined, { 'Content-Type': 'application/json' });
  check('unauth GET → 401', r.status === 401, JSON.stringify(r.j));
}

// ── 2. CRUD: masked reads, encrypt-at-rest, ''=keep / null=clear ───────────
{
  const r0 = await req('GET', '/klaviyo');
  check('fresh read: api_key_set=false, enabled=false', r0.status === 200 && r0.j.data.klaviyo.api_key_set === false && r0.j.data.klaviyo.enabled === false, r0.text);

  const r1 = await req('PUT', '/klaviyo', { api_key: GOOD_KEY, enabled: true, list_id_default: 'L1' });
  check('PUT key → masked view api_key_set=true', r1.status === 200 && r1.j.data.klaviyo.api_key_set === true, r1.text);
  check('PUT response never echoes the key', !r1.text.includes(GOOD_KEY));

  const raw = await sql`SELECT config FROM lb_integrations WHERE kind = 'klaviyo'`;
  const storedKey = raw[0]?.config?.api_key || '';
  check("raw row: api_key is a 'gcm1:' ciphertext", storedKey.startsWith('gcm1:'), storedKey.slice(0, 12));
  check('raw row: plaintext key NOT in the DB row', !JSON.stringify(raw[0]).includes(GOOD_KEY));

  const r2 = await req('PUT', '/klaviyo', { api_key: '', enabled: true });
  check("PUT '' keeps the stored key", r2.j.data.klaviyo.api_key_set === true, r2.text);
  const raw2 = await sql`SELECT config FROM lb_integrations WHERE kind = 'klaviyo'`;
  check("'' keep is byte-stable (same ciphertext)", raw2[0].config.api_key === storedKey);

  const r3 = await req('PUT', '/klaviyo', { api_key: null });
  check('PUT null clears the key', r3.j.data.klaviyo.api_key_set === false, r3.text);

  const r4 = await req('PUT', '/klaviyo', { api_key: 12345 });
  check('non-string api_key → 422', r4.status === 422, r4.text);

  // restore for the rest of the run
  await req('PUT', '/klaviyo', { api_key: GOOD_KEY, enabled: true, list_id_default: 'L1' });
}

// ── 3. test endpoint: happy + bad-key ───────────────────────────────────────
{
  const good = await req('POST', '/klaviyo/test', {});
  check('test with good key → ok + account name', good.status === 200 && good.j.data.ok === true && good.j.data.account.name === 'Mock Puure LLC', good.text);
  const view = await req('GET', '/klaviyo');
  check('last_test persisted on the config', view.j.data.klaviyo.last_test?.ok === true && view.j.data.klaviyo.last_test.account_name === 'Mock Puure LLC', view.text);

  await req('PUT', '/klaviyo', { api_key: 'pk_wrong_key_123' });
  const bad = await req('POST', '/klaviyo/test', {});
  check('test with bad key → ok:false invalid_api_key (no 500)', bad.status === 200 && bad.j.data.ok === false && bad.j.data.error === 'invalid_api_key', bad.text);
  const view2 = await req('GET', '/klaviyo');
  check('failed test persisted too', view2.j.data.klaviyo.last_test?.ok === false, view2.text);
  await req('PUT', '/klaviyo', { api_key: GOOD_KEY, enabled: true, list_id_default: 'L1' });
}

// ── 4. lists proxy ──────────────────────────────────────────────────────────
{
  const r = await req('GET', '/klaviyo/lists');
  check('lists proxy → 2 lists, names intact', r.j?.data?.ok === true && r.j.data.lists.length === 2 && r.j.data.lists[0].name === 'Newsletter', r.text);
}

// ── 5. profile upsert 409 → PATCH flow ─────────────────────────────────────
{
  const { upsertProfile } = await import(`${ROOT}/server/src/services/klaviyoService.js`);
  const first = await upsertProfile({ email: 'dup@x.test', first_name: 'A' });
  check('profile create → 201 with id', first.ok === true && first.profileId === knownEmails.get('dup@x.test'), JSON.stringify(first));
  const before = calls.length;
  const second = await upsertProfile({ email: 'dup@x.test', first_name: 'B' });
  const tail = calls.slice(before);
  check('duplicate → 409 then PATCH /profiles/{id}/ with same id', second.ok === true && second.profileId === first.profileId
    && tail.some((c) => c.method === 'POST' && c.path.startsWith('/api/profiles/'))
    && tail.some((c) => c.method === 'PATCH' && c.path === `/api/profiles/${first.profileId}/`), JSON.stringify(tail.map((c) => c.method + ' ' + c.path)));
}

// ── 6. event pipeline: idempotency + claim row ─────────────────────────────
const SID = 'co_' + crypto.randomBytes(8).toString('hex');
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, total, currency, customer, paid_at)
  VALUES (${SID}, 'f_kl', 'p1', 'paid', ${sql.json([{ variant_id: 'v1', quantity: 1, price: 49, title: 'Puure Oil' }])}, 49, 49, 'USD',
          ${sql.json({ email: 'buyer@x.test', first_name: 'Buy', last_name: 'Er', phone: '+15550001111', shipping: { city: 'Rome', country: 'IT' } })}, NOW())`;
await sql`INSERT INTO co_orders (id, session_id, idempotency_key, total, currency)
  VALUES ('ord_1', ${SID}, ${'idem_' + SID}, 49, 'USD')`;
{
  const eventsBefore = calls.filter((c) => c.path.startsWith('/api/events/')).length;
  const r1 = await fireKlaviyoOrderEvent(SID);
  const r2 = await fireKlaviyoOrderEvent(SID);
  const eventsAfter = calls.filter((c) => c.path.startsWith('/api/events/')).length;
  check('first fire sends', r1.ok === true && !r1.deduped, JSON.stringify(r1));
  check('second fire dedups at OUR layer', r2.ok === true && r2.deduped === true, JSON.stringify(r2));
  check('exactly ONE /events/ call for the double fire', eventsAfter - eventsBefore === 1, `delta=${eventsAfter - eventsBefore}`);
  const claims = await sql`SELECT * FROM lb_integration_sends WHERE kind = 'klaviyo' AND ref = ${'ko_' + SID}`;
  check('exactly ONE claim row (kind,ref)', claims.length === 1);
  const evCall = calls.filter((c) => c.path.startsWith('/api/events/')).pop();
  check('event carries unique_id ko_<sid>, value, metric Placed Order',
    evCall.body?.data?.attributes?.unique_id === 'ko_' + SID
    && evCall.body.data.attributes.value === 49
    && evCall.body.data.attributes.metric.data.attributes.name === 'Placed Order'
    && evCall.body.data.attributes.properties.order_id === 'ord_1', JSON.stringify(evCall.body).slice(0, 200));
}

// unpaid session refuses the money metric; lead fires instead
const SID2 = 'co_' + crypto.randomBytes(8).toString('hex');
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, total, currency, customer)
  VALUES (${SID2}, 'f_kl', 'p1', 'processing', ${sql.json([])}, 0, 19, 'USD', ${sql.json({ email: 'lead@x.test' })})`;
{
  const blocked = await fireKlaviyoOrderEvent(SID2);
  check('order event refuses a not-paid session', blocked.ok === false && String(blocked.error).startsWith('not_paid'), JSON.stringify(blocked));
  const lead = await fireKlaviyoLeadEvent(SID2);
  const evCall = calls.filter((c) => c.path.startsWith('/api/events/')).pop();
  check('lead fires Started Checkout with kl_<sid>', lead.ok === true
    && evCall.body?.data?.attributes?.unique_id === 'kl_' + SID2
    && evCall.body.data.attributes.metric.data.attributes.name === 'Started Checkout', JSON.stringify(lead));
  const missing = await fireKlaviyoOrderEvent('co_does_not_exist');
  check('missing session → clean refusal, no throw', missing.ok === false && missing.error === 'session_not_found', JSON.stringify(missing));
}

// ── 7. fail-closed: mock 500 + timeout never throw, claim released ─────────
const SID3 = 'co_' + crypto.randomBytes(8).toString('hex');
await sql`INSERT INTO co_sessions (id, funnel_id, page_id, status, line_items, subtotal, total, currency, customer, paid_at)
  VALUES (${SID3}, 'f_kl', 'p1', 'paid', ${sql.json([])}, 9, 9, 'USD', ${sql.json({ email: 'fail@x.test' })}, NOW())`;
{
  mode = 'server_error';
  const r = await fireKlaviyoOrderEvent(SID3).catch((e) => ({ threw: e.message }));
  check('mock 500 → { ok:false } returned, NOT thrown', r.threw === undefined && r.ok === false && r.error === 'http_500', JSON.stringify(r));
  const claims = await sql`SELECT * FROM lb_integration_sends WHERE ref = ${'ko_' + SID3}`;
  check('failed send released its claim (retry possible)', claims.length === 0);

  mode = 'timeout';
  const t0 = Date.now();
  const rt = await fireKlaviyoOrderEvent(SID3).catch((e) => ({ threw: e.message }));
  check('timeout → { ok:false, error:timeout }, NOT thrown', rt.threw === undefined && rt.ok === false && rt.error === 'timeout', JSON.stringify(rt) + ` in ${Date.now() - t0}ms`);

  mode = 'server_error';
  const tr = await req('POST', '/klaviyo/test', {});
  check('test endpoint on vendor 500 → 200 { ok:false } (fail-closed)', tr.status === 200 && tr.j.data.ok === false, tr.text);
  const lr = await req('GET', '/klaviyo/lists');
  check('lists on vendor 500 → 200 { ok:false, lists:[] }', lr.status === 200 && lr.j.data.ok === false && lr.j.data.lists.length === 0, lr.text);
  mode = 'ok';
  const retry = await fireKlaviyoOrderEvent(SID3);
  check('after recovery the released claim re-sends exactly once', retry.ok === true && !retry.deduped, JSON.stringify(retry));
}

// ── 7b. 429 → honors retry-after with a single retry ───────────────────────
{
  const { getAccount } = await import(`${ROOT}/server/src/services/klaviyoService.js`);
  mode = '429_once';
  const t0 = Date.now();
  const r = await getAccount();
  const elapsed = Date.now() - t0;
  check('429 then 200: single retry succeeds after retry-after', r.ok === true && r.account.name === 'Mock Puure LLC' && elapsed >= 900, `elapsed=${elapsed}ms ${JSON.stringify(r).slice(0, 120)}`);
  mode = 'ok';
}

// ── 8. the key never leaks — every response body, every console line ───────
{
  const inResponses = responses.some((t) => t.includes(GOOD_KEY));
  const inLogs = logLines.some((l) => l.includes(GOOD_KEY));
  check('API key appears in NO response body', !inResponses);
  check('API key appears in NO console line', !inLogs);
  // POSITIVE control: the key DID travel — but only inside Authorization
  // headers to the vendor (proves the assertion isn't vacuous).
  check('positive control: key reached the vendor via header', calls.some((c) => c.auth === `Klaviyo-API-Key ${GOOD_KEY}`));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
server.close();
mock.close();
mock.closeAllConnections?.();
process.exit(fail ? 1 : 0);
