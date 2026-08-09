// GOOGLE tracking adapter verification — drives the REAL trackingAdmin router,
// the REAL trackingDelivery GA4 sender and the REAL firePurchaseConversion
// against embedded PG plus a local mock Measurement Protocol server
// (GA4_MP_OVERRIDE_URL), exactly like the delivery-patches / admin-crud
// harnesses.
//
// Proves by execution:
//   • ga4 CRUD round-trips: measurement_id validated (/^G-[A-Z0-9]{4,16}$/),
//     api_secret is WRITE-ONLY (masked as api_secret_set, 'gcm1:' at rest,
//     decrypts back), native/hybrid modes are REFUSED (MP is server-side only);
//   • google_ads is REGISTERED BUT DORMANT: the PUT stores every field, the GET
//     says not_active, a new row lands DISABLED, and a fire dead-letters as
//     'kind_not_wired' without contacting anything;
//   • a seeded PAID session fires GA4 automatically through serverPixels (the
//     s2s ga4 row is picked up with no caller change) and the mock MP server
//     receives a VALID MP payload: client_id, timestamp_micros, one event named
//     'purchase' (the Purchase→purchase mapping lives in the SENDER), with
//     transaction_id = our event_id, value and currency — and NO user_data/PII;
//   • the api_secret arrives ONLY in the query string of the MOCK request;
//   • the lb_tracking_sent claim is the real dedup guarantee: a double fire
//     produces exactly ONE MP call plus a logged 'deduped' row;
//   • REDACTION: when the endpoint echoes the FULL request URL in a 500 body,
//     neither lb_tracking_events.error nor lb_postback_queue.last_error ever
//     contains the api_secret;
//   • the summary reports ga4 honestly (click_id_params gclid/wbraid/gbraid,
//     server_channel_ready from enabled+measurement_id+api_secret_set);
//   • NO browser surface: an s2s ga4 row is absent from /track/config and the
//     runtime head script contains no gtag/GTM loader.
//
// Run:  node server/tests/tracking/google-adapter.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.TRACKING_SWEEPS_DISABLED = '1';       // no background drain during asserts
delete process.env.TRACKING_RELAY_OVERRIDE_URL;   // ga4 must NOT ride the meta relay override

import http from 'http';
import crypto from 'crypto';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

// ── mock GA4 Measurement Protocol server ────────────────────────────────────
// Records every hit. Real MP answers 204 No Content with an empty body; the
// debug twin answers 200 with validationMessages. `mode` switches:
//   204        → accept (the production behaviour)
//   'echo500'  → 500 whose body ECHOES THE FULL REQUEST URL (the redaction
//                fixture: the URL carries api_secret in its query)
//   'debug'    → 200 + validationMessages (per-event payload rejection)
const hits = [];
let mpMode = 204;
const mp = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(b); } catch { parsed = null; }
    hits.push({ url: req.url, raw: b, payload: parsed, auth: req.headers.authorization || '' });
    if (mpMode === 'echo500') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'boom', request_url: `http://127.0.0.1:${MP_PORT}${req.url}` }));
      return;
    }
    if (mpMode === 'debug') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ validationMessages: [{ fieldPath: 'events', description: 'bad', validationCode: 'VALUE_INVALID' }] }));
      return;
    }
    res.statusCode = 204;
    res.end();
  });
});
await new Promise((r) => mp.listen(0, '127.0.0.1', r));
const MP_PORT = mp.address().port;
process.env.GA4_MP_OVERRIDE_URL = `http://127.0.0.1:${MP_PORT}/mp/collect`;

// ── auth seed (same shape as admin-crud) ────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_ga4_test', 'ga4@local.test', 'Ga', 'Four') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_ga4_test', 'ga4-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_ga4_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_ga4_test', 'r_ga4_test')`;

const trackingAdminRouter = (await import('../../src/routes/trackingAdmin.js')).default;
const trackingPublicRouter = (await import('../../src/routes/trackingPublic.js')).default;
const { TRACKING_NETWORKS } = await import('../../src/routes/trackingAdmin.js');
const { decryptSecret } = await import('../../src/services/gatewayConfigs.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { firePurchaseConversion } = await import('../../src/services/trackingService.js');
const { trackingHeadScript } = await import('../../src/services/trackingRuntime.js');
const { ga4EventName, ga4ClientId, ga4CollectUrl, redactTokens } = await import('../../src/services/trackingDelivery.js');
await ensureTrackingTables();
await ensureCheckoutTables();

const app = express();
app.use(express.json());
app.use('/api/v1/tracking-admin', trackingAdminRouter);
app.use('/api/v1/track', trackingPublicRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/tracking-admin`;

const token = jwt.sign({ userId: 'u_ga4_test' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

const FID = 'fnl_ga4adm';        // CRUD funnel
const DID = 'fnl_ga4del';        // delivery funnel
const GID = 'fnl_gadsdel';       // google_ads dormant-delivery funnel
const MID = 'G-ABCD1234XY';
const SECRET = 'GA4SEKRET9911abcdEFG';
const ALL = [FID, DID, GID];

const wipe = async () => {
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ANY(${ALL})`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ANY(${ALL})`;
  await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ANY(${ALL})`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ANY(${ALL})`;
  await sql`DELETE FROM lb_tracking_sent WHERE pixel_id = ${MID}`;
  await sql`DELETE FROM co_sessions WHERE id LIKE 'co_ga4%'`;
};
await wipe();

// ── G0: pure functions (no I/O) ─────────────────────────────────────────────
{
  check('G0 registry knows ga4 + google_ads + meta_pixel',
    Boolean(TRACKING_NETWORKS.ga4 && TRACKING_NETWORKS.google_ads && TRACKING_NETWORKS.meta_pixel),
    Object.keys(TRACKING_NETWORKS).join(','));
  check('G0 ga4 is s2s-only in the registry',
    JSON.stringify(TRACKING_NETWORKS.ga4.modes) === '["s2s"]', JSON.stringify(TRACKING_NETWORKS.ga4.modes));
  check('G0 Purchase maps to GA4 purchase', ga4EventName('Purchase') === 'purchase', ga4EventName('Purchase'));
  check('G0 PageView maps to page_view', ga4EventName('PageView') === 'page_view', ga4EventName('PageView'));
  check('G0 unknown name degrades to a legal GA4 name',
    /^[a-z][a-z0-9_]*$/.test(ga4EventName('SomeWeird Event!')), ga4EventName('SomeWeird Event!'));
  const cid1 = ga4ClientId({ event_id: 'pur_x', custom_data: { order_id: 'co_1' } });
  const cid2 = ga4ClientId({ event_id: 'pur_x', custom_data: { order_id: 'co_1' } });
  check('G0 client_id is deterministic + GA-shaped', cid1 === cid2 && /^\d+\.\d+$/.test(cid1), cid1);
  check('G0 client_id differs per order',
    cid1 !== ga4ClientId({ custom_data: { order_id: 'co_2' } }), cid1);
  check('G0 empty envelope yields NO client_id (hard error upstream)', ga4ClientId({}) === '', ga4ClientId({}));
  const u = new URL(ga4CollectUrl(MID, SECRET));
  check('G0 ga4CollectUrl carries measurement_id + api_secret in the QUERY',
    u.searchParams.get('measurement_id') === MID && u.searchParams.get('api_secret') === SECRET, u.pathname);
  check('G0 redactTokens masks the api_secret out of that URL',
    !redactTokens(u.toString()).includes(SECRET) && redactTokens(u.toString()).includes('api_secret=[REDACTED]'),
    redactTokens(u.toString()));
  check('G0 redactTokens still masks access_token',
    redactTokens('{"access_token":"EAABsecret123"}').includes('[REDACTED]'));
}

// ── G1: ga4 CRUD ────────────────────────────────────────────────────────────
{
  const bad = await req('PUT', `/${FID}/networks/ga4`, { measurement_id: 'g-lower123', api_secret: SECRET });
  check('G1 invalid measurement_id → 400 invalid_measurement_id',
    bad.status === 400 && bad.j?.error?.code === 'invalid_measurement_id', JSON.stringify(bad.j));
  const bad2 = await req('PUT', `/${FID}/networks/ga4`, { measurement_id: 'UA-12345-1' });
  check('G1 legacy UA id → 400', bad2.status === 400, JSON.stringify(bad2.j));
  const native = await req('PUT', `/${FID}/networks/ga4`, { measurement_id: MID, mode: 'native' });
  check('G1 native mode REFUSED → 400 invalid_mode',
    native.status === 400 && native.j?.error?.code === 'invalid_mode', JSON.stringify(native.j));
  const hybrid = await req('PUT', `/${FID}/networks/ga4`, { measurement_id: MID, mode: 'hybrid' });
  check('G1 hybrid mode REFUSED → 400 invalid_mode',
    hybrid.status === 400 && hybrid.j?.error?.code === 'invalid_mode', JSON.stringify(hybrid.j));
  const noId = await req('PUT', `/${FID}/networks/ga4`, { api_secret: SECRET });
  check('G1 new row without measurement_id → 400 measurement_id_required',
    noId.status === 400 && noId.j?.error?.code === 'measurement_id_required', JSON.stringify(noId.j));

  const ok = await req('PUT', `/${FID}/networks/ga4`, { measurement_id: MID, api_secret: SECRET });
  const n = ok.j?.data?.network;
  check('G1 PUT ga4 → 200', ok.status === 200, JSON.stringify(ok.j));
  check('G1 view echoes measurement_id (and pixel_id alias)',
    n?.measurement_id === MID && n?.pixel_id === MID, JSON.stringify(n));
  check('G1 new ga4 row defaults to mode s2s', n?.mode === 's2s', JSON.stringify(n?.mode));
  check('G1 api_secret masked as api_secret_set', n?.api_secret_set === true && n?.api_secret === undefined, JSON.stringify(n));
  check('G1 raw secret NEVER echoed in the PUT response', !ok.text.includes(SECRET), 'LEAK');
  check('G1 delivery_note states MP gives no per-event validation',
    typeof n?.delivery_note === 'string' && /204/.test(n.delivery_note), String(n?.delivery_note).slice(0, 60));

  const rows = await sql`SELECT pixel_id, mode, enabled, config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'ga4'`;
  const stored = rows[0]?.config?.api_secret || '';
  check('G1 api_secret encrypted at rest (gcm1:)', stored.startsWith('gcm1:'), stored.slice(0, 8));
  check('G1 ciphertext decrypts back to the original', decryptSecret(stored) === SECRET);
  check('G1 measurement_id stored in pixel_id column', rows[0]?.pixel_id === MID, rows[0]?.pixel_id);

  const get = await req('GET', `/${FID}/networks/ga4`);
  check('G1 GET masked (no raw secret anywhere)', get.status === 200 && !get.text.includes(SECRET)
    && get.j?.data?.network?.api_secret_set === true, get.text.slice(0, 160));

  // '' = keep (masked form re-submit) — byte-identical ciphertext
  await req('PUT', `/${FID}/networks/ga4`, { api_secret: '' });
  const after = await sql`SELECT config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'ga4'`;
  check("G1 '' api_secret leaves the ciphertext byte-identical", after[0].config.api_secret === stored);
  // null = clear
  await req('PUT', `/${FID}/networks/ga4`, { api_secret: null });
  const cleared = await sql`SELECT config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'ga4'`;
  check('G1 null api_secret clears it at rest', cleared[0].config.api_secret === undefined, JSON.stringify(cleared[0].config));

  const list = await req('GET', `/${FID}/networks`);
  const kinds = (list.j?.data?.networks || []).map((x) => x.kind);
  check('G1 registry list exposes ga4 + google_ads alongside meta_pixel',
    kinds.includes('ga4') && kinds.includes('google_ads') && kinds.includes('meta_pixel'), kinds.join(','));
}

// ── G2: google_ads — registered but DORMANT ─────────────────────────────────
{
  const put = await req('PUT', `/${FID}/networks/google_ads`, {
    customer_id: '123-456-7890', conversion_action_id: '987654321',
    developer_token: 'DEVTOK_AAA111', refresh_token: 'RFTOK_BBB222',
  });
  const n = put.j?.data?.network;
  check('G2 google_ads PUT accepted with NO id → 200', put.status === 200, JSON.stringify(put.j));
  check('G2 GET/PUT view says not_active', n?.not_active === true, JSON.stringify(n));
  check('G2 new google_ads row lands DISABLED', n?.enabled === false, JSON.stringify(n?.enabled));
  check('G2 plain fields round-trip',
    n?.customer_id === '123-456-7890' && n?.conversion_action_id === '987654321', JSON.stringify(n));
  check('G2 both tokens masked as *_set',
    n?.developer_token_set === true && n?.refresh_token_set === true
    && n?.developer_token === undefined && n?.refresh_token === undefined, JSON.stringify(n));
  check('G2 raw tokens never echoed', !put.text.includes('DEVTOK_AAA111') && !put.text.includes('RFTOK_BBB222'));

  const rows = await sql`SELECT pixel_id, mode, enabled, config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'google_ads'`;
  const cfg = rows[0]?.config || {};
  check('G2 both tokens encrypted at rest',
    String(cfg.developer_token || '').startsWith('gcm1:') && String(cfg.refresh_token || '').startsWith('gcm1:'),
    JSON.stringify(Object.keys(cfg)));
  check('G2 tokens decrypt back',
    decryptSecret(cfg.developer_token) === 'DEVTOK_AAA111' && decryptSecret(cfg.refresh_token) === 'RFTOK_BBB222');
  check('G2 identifiers stored in the CLEAR (not secrets)',
    cfg.customer_id === '123-456-7890' && cfg.conversion_action_id === '987654321', JSON.stringify(cfg));
  check('G2 dormant row is s2s (never a browser mode)', rows[0]?.mode === 's2s', rows[0]?.mode);

  const get = await req('GET', `/${FID}/networks/google_ads`);
  check('G2 GET says not_active', get.j?.data?.network?.not_active === true, JSON.stringify(get.j?.data?.network));
}

// ── seed a PAID session helper ──────────────────────────────────────────────
const seedPaid = async (suffix, funnelId, total = 49.5) => {
  const sid = `co_ga4_${suffix}_${crypto.randomBytes(4).toString('hex')}`;
  await sql`INSERT INTO co_sessions (id, funnel_id, status, total, currency, paid_at, line_items, customer, tracking_net, click_vault, vid)
            VALUES (${sid}, ${funnelId}, 'paid', ${total}, 'USD', NOW(), '[]',
                    ${sql.json({ email: 'buyer@example.test', first_name: 'Bu', last_name: 'Yer', shipping: { city: 'Rome', country: 'IT' } })},
                    ${sql.json({ url: 'https://shop.test/thanks' })}, '{}', 'v_ga4testvid')`;
  return sid;
};

// ── G3: fire path — a paid session reaches GA4 MP automatically ─────────────
{
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_ga4_del', ${DID}, 'ga4', ${MID}, 's2s', TRUE,
                    ${sql.json({ api_secret: (await import('../../src/services/gatewayConfigs.js')).encryptSecret(SECRET) })})`;
  const sid = await seedPaid('ok', DID);
  hits.length = 0;
  mpMode = 204;
  const r = await firePurchaseConversion(sid, { source: 'webhook' });
  check('G3 ga4 s2s row picked up by serverPixels with NO caller change',
    r.ok === true && r.fired === 1, JSON.stringify(r));
  check('G3 delivery result is sent', r.results?.[0]?.result === 'sent', JSON.stringify(r.results));
  check('G3 mock MP received exactly ONE hit', hits.length === 1, String(hits.length));
  const h = hits[0] || {};
  const q = new URLSearchParams((h.url || '').split('?')[1] || '');
  check('G3 hit lands on the MP collect path', (h.url || '').startsWith('/mp/collect?'), h.url);
  check('G3 measurement_id in query', q.get('measurement_id') === MID, q.get('measurement_id'));
  check('G3 api_secret arrives in the QUERY of the mock (MP has no header form)',
    q.get('api_secret') === SECRET, String(q.get('api_secret')).slice(0, 6));
  check('G3 no Authorization header (not a bearer transport)', !h.auth, h.auth);
  const p = h.payload || {};
  check('G3 payload has a GA-shaped client_id', /^\d+\.\d+$/.test(String(p.client_id || '')), String(p.client_id));
  check('G3 payload has timestamp_micros', /^\d{16,}$/.test(String(p.timestamp_micros || '')), String(p.timestamp_micros));
  check('G3 exactly one event, named purchase (mapping lives in the SENDER)',
    Array.isArray(p.events) && p.events.length === 1 && p.events[0].name === 'purchase', JSON.stringify(p.events));
  const prm = (p.events && p.events[0] && p.events[0].params) || {};
  check('G3 transaction_id = our event_id', prm.transaction_id === `pur_${sid}`, String(prm.transaction_id));
  check('G3 value + currency carried', Number(prm.value) === 49.5 && prm.currency === 'USD', JSON.stringify(prm));
  check('G3 realtime params present', Number(prm.engagement_time_msec) >= 1 && Boolean(prm.session_id), JSON.stringify(prm));
  check('G3 NO user_data / PII in the GA4 payload',
    p.user_data === undefined && !h.raw.includes('buyer@example.test'), h.raw.slice(0, 200));
  const ev = await sql`SELECT platform, status, event_name, event_id, error FROM lb_tracking_events WHERE funnel_id = ${DID} ORDER BY ts DESC`;
  check('G3 ledger row: platform ga4, status sent',
    ev[0]?.platform === 'ga4' && ev[0]?.status === 'sent' && ev[0]?.error === null, JSON.stringify(ev[0]));
  check('G3 ledger keeps OUR event name/id (not the GA4 alias)',
    ev[0]?.event_name === 'Purchase' && ev[0]?.event_id === `pur_${sid}`, JSON.stringify(ev[0]));

  // ── G4: the claim, not GA4's transaction_id, is the guarantee ─────────────
  const before = hits.length;
  const r2 = await firePurchaseConversion(sid, { source: 'webhook' });
  check('G4 double fire → duplicate', r2.results?.[0]?.result === 'duplicate', JSON.stringify(r2.results));
  check('G4 second fire sent NOTHING to MP', hits.length === before, `delta=${hits.length - before}`);
  const dd = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_events WHERE funnel_id = ${DID} AND status = 'deduped'`;
  check('G4 a deduped ledger row was written', dd[0].n === 1, JSON.stringify(dd[0]));
  const claims = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE pixel_id = ${MID} AND event_id = ${'pur_' + sid}`;
  check('G4 exactly one claim row', claims[0].n === 1, JSON.stringify(claims[0]));
}

// ── G5: REDACTION — the endpoint echoes the full URL in a 500 body ──────────
{
  const sid = await seedPaid('echo', DID, 12.25);
  mpMode = 'echo500';
  const before = hits.length;
  const r = await firePurchaseConversion(sid, { source: 'webhook' });
  mpMode = 204;
  check('G5 500 from MP is RETRYABLE → queued', String(r.results?.[0]?.result || '').startsWith('queued:'), JSON.stringify(r.results));
  check('G5 the echoing hit was actually made', hits.length === before + 1, String(hits.length - before));
  check('G5 fixture really echoed the secret back', hits[hits.length - 1].url.includes(SECRET), 'fixture broken');

  const ev = await sql`SELECT error FROM lb_tracking_events WHERE funnel_id = ${DID} AND event_id = ${'pur_' + sid}`;
  const qrows = await sql`SELECT last_error FROM lb_postback_queue WHERE funnel_id = ${DID}`;
  const evErr = ev.map((x) => x.error || '').join('|');
  const qErr = qrows.map((x) => x.last_error || '').join('|');
  check('G5 lb_tracking_events.error contains NO api_secret', evErr.length > 0 && !evErr.includes(SECRET), evErr.slice(0, 200));
  check('G5 the error is redacted, not just truncated', evErr.includes('api_secret=[REDACTED]'), evErr.slice(0, 200));
  check('G5 lb_postback_queue.last_error contains NO api_secret', qErr.length > 0 && !qErr.includes(SECRET), qErr.slice(0, 200));

  // Full-table sweep: the secret must exist NOWHERE outside lb_pixels.config.
  const leak = await sql`
    SELECT (SELECT COUNT(*) FROM lb_tracking_events WHERE error LIKE ${'%' + SECRET + '%'})::int AS ev,
           (SELECT COUNT(*) FROM lb_postback_queue WHERE last_error LIKE ${'%' + SECRET + '%'})::int AS q,
           (SELECT COUNT(*) FROM lb_postback_queue WHERE envelope::text LIKE ${'%' + SECRET + '%'})::int AS env`;
  check('G5 no api_secret anywhere in the ledger, the queue or a queued envelope',
    leak[0].ev === 0 && leak[0].q === 0 && leak[0].env === 0, JSON.stringify(leak[0]));
}

// ── G6: failure paths run DOWN their failure path ───────────────────────────
{
  // (a) ga4 row with no api_secret → not_configured, hard, no HTTP call
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_ga4_nosec', ${GID}, 'ga4', 'G-NOSECRET1', 's2s', TRUE, '{}')`;
  const sidA = await seedPaid('nosec', GID);
  const beforeA = hits.length;
  const rA = await firePurchaseConversion(sidA, { source: 'webhook' });
  check('G6a ga4 without api_secret dead-letters not_configured',
    rA.results?.[0]?.result === 'dead:not_configured', JSON.stringify(rA.results));
  check('G6a nothing was sent', hits.length === beforeA, `delta=${hits.length - beforeA}`);

  // (b) corrupt ciphertext → RETRYABLE (healable by fixing the key), never throws
  await sql`UPDATE lb_pixels SET config = ${sql.json({ api_secret: 'gcm1:not-real-base64-ciphertext' })} WHERE id = 'px_ga4_nosec'`;
  const sidB = await seedPaid('corrupt', GID);
  const rB = await firePurchaseConversion(sidB, { source: 'webhook' });
  check('G6b corrupt api_secret ciphertext → queued token_decrypt_failed (healable)',
    rB.results?.[0]?.result === 'queued:token_decrypt_failed', JSON.stringify(rB.results));

  // (c) google_ads is enabled by hand → the fire must NOT fake a delivery
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${GID}`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_gads_on', ${GID}, 'google_ads', '', 's2s', TRUE, ${sql.json({ customer_id: '111' })})`;
  const sidC = await seedPaid('gads', GID);
  const beforeC = hits.length;
  const rC = await firePurchaseConversion(sidC, { source: 'webhook' });
  check('G6c enabled google_ads row dead-letters kind_not_wired (NO faked delivery)',
    rC.results?.[0]?.result === 'dead:kind_not_wired', JSON.stringify(rC.results));
  check('G6c nothing was sent anywhere', hits.length === beforeC, `delta=${hits.length - beforeC}`);
  const evC = await sql`SELECT platform, status, error FROM lb_tracking_events WHERE funnel_id = ${GID} AND event_id = ${'pur_' + sidC}`;
  check('G6c ledger says google_ads / skipped / kind_not_wired',
    evC[0]?.platform === 'google_ads' && evC[0]?.status === 'skipped' && evC[0]?.error === 'kind_not_wired', JSON.stringify(evC[0]));
  // Scoped to THIS event: the funnel already carries G6b's healable queue row.
  const qC = await sql`SELECT COUNT(*)::int AS n FROM lb_postback_queue
                       WHERE funnel_id = ${GID} AND envelope->>'event_id' = ${'pur_' + sidC}`;
  check('G6c a dormant kind never enters the retry queue', qC[0].n === 0, JSON.stringify(qC[0]));

  // (d) MP debug endpoint validation messages = a PER-EVENT rejection: it
  //     dead-letters WITHOUT opening the circuit breaker.
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${GID}`;
  await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ${GID}`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_ga4_dbg', ${GID}, 'ga4', 'G-DEBUG0001', 's2s', TRUE,
                    ${sql.json({ api_secret: (await import('../../src/services/gatewayConfigs.js')).encryptSecret(SECRET) })})`;
  const sidD = await seedPaid('debug', GID);
  mpMode = 'debug';
  const rD = await firePurchaseConversion(sidD, { source: 'webhook' });
  mpMode = 204;
  check('G6d validationMessages → dead (payload rejection, one pass)',
    String(rD.results?.[0]?.result || '').startsWith('dead:'), JSON.stringify(rD.results));
  const br = await sql`SELECT fails FROM lb_postback_breakers WHERE funnel_id = ${GID}`;
  check('G6d a payload rejection did NOT increment the breaker',
    br.length === 0 || Number(br[0].fails) === 0, JSON.stringify(br));
}

// ── G7: summary shape for ga4 ───────────────────────────────────────────────
{
  const s = await req('GET', `/${DID}/tracking/summary`);
  const ga4 = (s.j?.data?.networks || []).find((x) => x.kind === 'ga4');
  check('G7 summary carries a ga4 entry', Boolean(ga4), JSON.stringify(s.j?.data?.networks?.map((x) => x.kind)));
  check('G7 ga4 network label is google', ga4?.network === 'google', ga4?.network);
  check('G7 click_id_params = gclid/wbraid/gbraid',
    ['gclid', 'wbraid', 'gbraid'].every((p) => (ga4?.click_id_params || []).includes(p)), JSON.stringify(ga4?.click_id_params));
  check('G7 sent_24h counted the real GA4 send', ga4?.sent_24h === 1, JSON.stringify(ga4));
  check('G7 deduped_24h counted the dedup', ga4?.deduped_24h === 1, JSON.stringify(ga4));
  check('G7 queued_now sees the retryable 500', ga4?.queued_now === 1, JSON.stringify(ga4));
  check('G7 server_channel_ready true (enabled + measurement_id + api_secret_set)',
    ga4?.server_channel_ready === true, JSON.stringify(ga4));
  check('G7 summary never echoes the api_secret', !s.text.includes(SECRET));

  const gads = (s.j?.data?.networks || []).find((x) => x.kind === 'google_ads');
  check('G7 google_ads summary says not_active and is NEVER ready',
    gads?.not_active === true && gads?.server_channel_ready === false, JSON.stringify(gads));

  await sql`UPDATE lb_pixels SET enabled = FALSE WHERE funnel_id = ${DID} AND kind = 'ga4'`;
  const s2 = await req('GET', `/${DID}/tracking/summary`);
  const off = (s2.j?.data?.networks || []).find((x) => x.kind === 'ga4');
  check('G7 disabled ga4 → server_channel_ready false', off?.server_channel_ready === false, JSON.stringify(off));
  await sql`UPDATE lb_pixels SET enabled = TRUE WHERE funnel_id = ${DID} AND kind = 'ga4'`;
}

// ── G8: NO browser surface in this branch ───────────────────────────────────
{
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/track/config?funnel=${DID}`);
  const j = await r.json();
  const kinds = (j?.data?.pixels || []).map((p) => p.kind);
  check('G8 /track/config excludes the s2s ga4 row', r.status === 200 && !kinds.includes('ga4'), JSON.stringify(kinds));
  check('G8 /track/config excludes the dormant google_ads row', !kinds.includes('google_ads'), JSON.stringify(kinds));
  const head = trackingHeadScript({ funnel_id: DID, page_id: 'pg_1' });
  check('G8 runtime emits NO gtag/GTM/analytics loader',
    !/gtag|googletagmanager|google-analytics|google\.com\/g\/collect/i.test(head), 'loader present');
  check('G8 runtime still emits the meta loader (unchanged)', head.includes('fbevents.js'));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await wipe();
await sql`DELETE FROM user_roles WHERE user_id = 'u_ga4_test'`;
await sql`DELETE FROM roles WHERE id = 'r_ga4_test'`;
await sql`DELETE FROM users WHERE id = 'u_ga4_test'`;

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close(); mp.close();
await sql.end();
process.exit(fail ? 1 : 0);
