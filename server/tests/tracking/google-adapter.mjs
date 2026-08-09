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
const { decryptSecret, encryptSecret } = await import('../../src/services/gatewayConfigs.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { firePurchaseConversion, fireUpsellPurchaseConversion } = await import('../../src/services/trackingService.js');
const { trackingHeadScript } = await import('../../src/services/trackingRuntime.js');
const {
  ga4EventName, ga4ClientId, ga4CollectUrl, redactTokens,
  ga4DebugActive, dryRunReason, deliverToPixel, runDelivery, retryable,
} = await import('../../src/services/trackingDelivery.js');
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
  // review HIGH #2b: customer_id is this row's IDENTITY and must be validated,
  // never free text. It may be ABSENT (staging credentials) but never garbage.
  const junk = await req('PUT', `/${FID}/networks/google_ads`, { customer_id: '../../etc/passwd' });
  check('G2 path-traversal customer_id → 400 invalid_customer_id',
    junk.status === 400 && junk.j?.error?.code === 'invalid_customer_id', JSON.stringify(junk.j));
  const short = await req('PUT', `/${FID}/networks/google_ads`, { customer_id: '712000123' });
  check('G2 9-digit (Meta-pixel-shaped) customer_id → 400',
    short.status === 400 && short.j?.error?.code === 'invalid_customer_id', JSON.stringify(short.j));
  const staged = await req('PUT', `/${FID}/networks/google_ads`, { developer_token: 'DEVTOK_AAA111' });
  check('G2 credentials may be staged with NO customer_id → 200', staged.status === 200, JSON.stringify(staged.j));

  const put = await req('PUT', `/${FID}/networks/google_ads`, {
    customer_id: '123-456-7890', conversion_action_id: '987654321',
    developer_token: 'DEVTOK_AAA111', refresh_token: 'RFTOK_BBB222',
  });
  const n = put.j?.data?.network;
  check('G2 google_ads PUT → 200', put.status === 200, JSON.stringify(put.j));
  check('G2 GET/PUT view says not_active', n?.not_active === true, JSON.stringify(n));
  check('G2 new google_ads row lands DISABLED', n?.enabled === false, JSON.stringify(n?.enabled));
  check('G2 dashed customer_id NORMALIZED to canonical 10 digits',
    n?.customer_id === '1234567890' && n?.pixel_id === '1234567890', JSON.stringify(n));
  check('G2 conversion_action_id round-trips', n?.conversion_action_id === '987654321', JSON.stringify(n));
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
  check('G2 conversion_action_id stored in the CLEAR (not a secret)',
    cfg.conversion_action_id === '987654321', JSON.stringify(cfg));
  check('G2 customer_id stored canonical in the id column', rows[0]?.pixel_id === '1234567890', rows[0]?.pixel_id);
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

// ═══ ADVERSARIAL-REVIEW FIXES ═══════════════════════════════════════════════

// ── R1 (HIGH #1): GA4 debug mode VALIDATES but does not INGEST ──────────────
// Scoring a debug hit as 'sent' would burn the (pixel_id, event_id) claim and
// dedupe that conversion away forever. It must not claim, not report sent, and
// the SAME event must still deliver once the flag is off.
{
  const RID = 'fnl_ga4dbg';
  ALL.push(RID);
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${RID}`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${RID}`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${RID}`;
  const MID2 = 'G-DBGCLAIM1';
  await sql`DELETE FROM lb_tracking_sent WHERE pixel_id = ${MID2}`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_ga4_dbgclaim', ${RID}, 'ga4', ${MID2}, 's2s', TRUE,
                    ${sql.json({ api_secret: encryptSecret(SECRET) })})`;
  const sid = await seedPaid('dbgclaim', RID, 77.25);

  process.env.GA4_MP_DEBUG = '1';
  check('R1 ga4DebugActive() true in development', ga4DebugActive() === true);
  check('R1 dryRunReason names the dry run',
    dryRunReason({ kind: 'ga4' }) === 'debug_mode_no_ingest', dryRunReason({ kind: 'ga4' }));
  check('R1 a meta row is NOT a dry run', dryRunReason({ kind: 'meta_pixel' }) === '');
  mpMode = 204;                       // a VALID payload: debug answers with NO validationMessages
  const before = hits.length;
  const rDbg = await firePurchaseConversion(sid, { source: 'webhook' });
  check('R1 debug fire returns debug_validated (NOT sent)',
    rDbg.results?.[0]?.result === 'debug_validated', JSON.stringify(rDbg.results));
  check('R1 the validation hit WAS made', hits.length === before + 1, String(hits.length - before));
  const claim0 = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE pixel_id = ${MID2} AND event_id = ${'pur_' + sid}`;
  check('R1 NO claim row was burned', claim0[0].n === 0, JSON.stringify(claim0[0]));
  const ev0 = await sql`SELECT status, error FROM lb_tracking_events WHERE funnel_id = ${RID} AND event_id = ${'pur_' + sid}`;
  check('R1 ledger row is skipped/debug_mode_no_ingest (never sent)',
    ev0[0]?.status === 'skipped' && ev0[0]?.error === 'debug_mode_no_ingest', JSON.stringify(ev0[0]));

  // A queued row must be HELD, not settled 'done', while debug is on.
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
            VALUES ('pbq_dbghold', ${RID}, ${RID + ':px_ga4_dbgclaim'}, 'queued',
                    ${sql.json({ event_name: 'Purchase', event_id: 'pur_held_1', custom_data: { value: 5, currency: 'USD', order_id: 'co_held_1' }, idk: ['em'] })},
                    'px_ga4_dbgclaim', 1, NOW() - INTERVAL '1 minute', NOW())`;
  const drainDbg = await runDelivery({ limit: 50 });
  const heldRow = await sql`SELECT status, last_error FROM lb_postback_queue WHERE id = 'pbq_dbghold'`;
  check('R1 a queued row is HELD (still queued), never marked done under debug',
    heldRow[0]?.status === 'queued' && heldRow[0]?.last_error === 'held:debug_mode_no_ingest',
    JSON.stringify(heldRow[0]) + JSON.stringify(drainDbg));

  // Flag OFF → the very same event actually delivers.
  delete process.env.GA4_MP_DEBUG;
  check('R1 ga4DebugActive() false once unset', ga4DebugActive() === false);
  const before2 = hits.length;
  const rLive = await firePurchaseConversion(sid, { source: 'webhook' });
  check('R1 SAME event delivers after the flag is off (not deduped away)',
    rLive.results?.[0]?.result === 'sent', JSON.stringify(rLive.results));
  check('R1 a real MP hit was made', hits.length === before2 + 1, String(hits.length - before2));
  const claim1 = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE pixel_id = ${MID2} AND event_id = ${'pur_' + sid}`;
  check('R1 the claim is taken only by the REAL send', claim1[0].n === 1, JSON.stringify(claim1[0]));

  // production refuses the flag outright
  process.env.GA4_MP_DEBUG = '1';
  process.env.NODE_ENV = 'production';
  check('R1 GA4_MP_DEBUG is REFUSED in production', ga4DebugActive() === false);
  process.env.NODE_ENV = 'development';
  delete process.env.GA4_MP_DEBUG;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${RID}`;
}

// ── R2 (HIGH #2): a colliding pixel_id must not let an UNWIRED kind steal the
// claim and silently suppress the real Meta purchase.
{
  const CID = 'fnl_ga4coll';
  ALL.push(CID);
  const SHARED = '7120001234';   // legal Meta pixel id AND a legal 10-digit Google customer id
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${CID}`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${CID}`;
  await sql`DELETE FROM lb_tracking_sent WHERE pixel_id = ${SHARED}`;
  // google_ads inserted FIRST so serverPixels hands it to the loop FIRST —
  // the adversarial order, where a claim-before-dispatch bug would fire.
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_coll_gads', ${CID}, 'google_ads', ${SHARED}, 's2s', TRUE, ${sql.json({ conversion_action_id: '1' })})`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_coll_meta', ${CID}, 'meta_pixel', ${SHARED}, 's2s', TRUE, ${sql.json({ capi_token: 'META_PLAIN_TOK' })})`;
  const order = await sql`SELECT kind FROM lb_pixels WHERE funnel_id = ${CID} AND enabled = TRUE AND mode IN ('s2s','hybrid')`;
  check('R2 fixture: the UNWIRED kind is served first (adversarial order)',
    order[0]?.kind === 'google_ads', JSON.stringify(order.map((x) => x.kind)));

  // Point the Meta sender at the mock too, so the real send can succeed.
  process.env.TRACKING_RELAY_OVERRIDE_URL = `http://127.0.0.1:${MP_PORT}/meta/events`;
  const sid = await seedPaid('coll', CID, 31);
  const r = await firePurchaseConversion(sid, { source: 'webhook' });
  delete process.env.TRACKING_RELAY_OVERRIDE_URL;
  const byKind = Object.fromEntries((r.results || []).map((x, i) => [order[i]?.kind, x.result]));
  check('R2 the UNWIRED google_ads row dead-letters kind_not_wired',
    byKind.google_ads === 'dead:kind_not_wired', JSON.stringify(r.results));
  check('R2 the REAL Meta purchase still DELIVERS (claim not stolen)',
    byKind.meta_pixel === 'sent', JSON.stringify(r.results));
  const claims = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE pixel_id = ${SHARED} AND event_id = ${'pur_' + sid}`;
  check('R2 exactly ONE claim row exists, and Meta owns it', claims[0].n === 1, JSON.stringify(claims[0]));
}

// ── R3 (HIGH #3): one poisoned queue row must not abort the drain tick ──────
{
  const PID = 'fnl_ga4drain';        // unique (funnel_id, kind) ⇒ one ga4 row per funnel
  const PID2 = 'fnl_ga4drain2';
  ALL.push(PID, PID2);
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ANY(${[PID, PID2]})`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ANY(${[PID, PID2]})`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ANY(${[PID, PID2]})`;
  // POISON: a row whose settle overflows INT on `attempts` — the settle UPDATE
  // throws INSIDE the per-row body, which is exactly the shape that used to
  // kill the tick and strand the row in 'sending' for 30 minutes.
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_drain_bad', ${PID}, 'ga4', 'G-DRAINBAD1', 's2s', TRUE, '{}')`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_drain_good', ${PID2}, 'ga4', 'G-DRAINGOOD', 's2s', TRUE,
                    ${sql.json({ api_secret: encryptSecret(SECRET) })})`;
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
            VALUES ('pbq_poison', ${PID}, ${PID + ':px_drain_bad'}, 'queued',
                    ${sql.json({ event_name: 'Purchase', event_id: 'pur_poison', custom_data: { value: 1, currency: 'USD', order_id: 'co_poison' }, idk: ['em'] })},
                    'px_drain_bad', 2147483647, NOW() - INTERVAL '10 minutes', NOW())`;
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at, created_at)
            VALUES ('pbq_good', ${PID2}, ${PID2 + ':px_drain_good'}, 'queued',
                    ${sql.json({ event_name: 'Purchase', event_id: 'pur_drain_good', custom_data: { value: 9, currency: 'USD', order_id: 'co_drain_good' }, idk: ['em'] })},
                    'px_drain_good', 1, NOW() - INTERVAL '5 minutes', NOW())`;
  mpMode = 204;
  const before = hits.length;
  const out = await runDelivery({ limit: 50 });   // poisoned row is FIRST (older next_at)
  check('R3 the tick SURVIVED a throwing row', out && out.due === 2, JSON.stringify(out));
  check('R3 the poisoned row was counted as errored', out.errored === 1, JSON.stringify(out));
  const poison = await sql`SELECT status, last_error FROM lb_postback_queue WHERE id = 'pbq_poison'`;
  check('R3 the poisoned row SETTLED (never stranded in sending)',
    poison[0]?.status === 'dead' && String(poison[0]?.last_error || '').startsWith('internal:'),
    JSON.stringify(poison[0]));
  const good = await sql`SELECT status FROM lb_postback_queue WHERE id = 'pbq_good'`;
  check('R3 the GOOD row still processed in the same tick', good[0]?.status === 'done', JSON.stringify(good[0]));
  check('R3 the good row really hit MP', hits.length === before + 1, String(hits.length - before));
}

// ── R4 (HIGH #3b): a malformed GA4_MP_OVERRIDE_URL is rejected at module load
{
  const { spawnSync } = await import('child_process');
  const mod = new URL('../../src/services/trackingDelivery.js', import.meta.url).pathname;
  const script = `import { ga4CollectUrl } from ${JSON.stringify(mod)};\nconsole.log(ga4CollectUrl('G-TEST1234','SEK'));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, GA4_MP_OVERRIDE_URL: 'http://not a url:::/x', GA4_MP_DEBUG: '' },
    encoding: 'utf8', timeout: 20000,
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  // NB the child prints dotenv banner noise before our line — match, don't anchor.
  check('R4 a malformed override falls back to the REAL MP endpoint',
    stdout.includes('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST1234')
    && !stdout.includes('not%20a%20url'), stdout.trim().slice(-200) + ' | ' + stderr.slice(-200));
  check('R4 the child logged the refusal loudly',
    /GA4_MP_OVERRIDE_URL is not a valid/.test(stdout + stderr), (stdout + stderr).slice(-200));
}

// ── R5 (MEDIUM #4): relayed custom_data is validated, not trusted ───────────
{
  const VID2 = 'fnl_ga4san';
  ALL.push(VID2);
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${VID2}`;
  await sql`DELETE FROM lb_tracking_sent WHERE pixel_id = 'G-SANITIZE1'`;
  const px = { id: 'px_ga4_san', funnel_id: VID2, kind: 'ga4', pixel_id: 'G-SANITIZE1', mode: 's2s',
    config: { api_secret: encryptSecret(SECRET) } };
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES (${px.id}, ${px.funnel_id}, 'ga4', ${px.pixel_id}, 's2s', TRUE, ${sql.json(px.config)})`;
  mpMode = 204;
  const before = hits.length;
  await deliverToPixel({
    funnelId: VID2, pixel: px, eventName: 'Purchase', eventId: 'pur_san_1',
    userData: { em: 'x' }, idk: ['em'],
    customData: { value: 'not-a-number', currency: 'US', order_id: 'co_san_1', items: [{ evil: '<script>' }] },
    source: 'webhook',
  });
  const p = hits[hits.length - 1]?.payload || {};
  const prm = p.events?.[0]?.params || {};
  check('R5 one hit made', hits.length === before + 1, String(hits.length - before));
  check('R5 NaN value is OMITTED, never sent as null', prm.value === undefined && !('value' in prm), JSON.stringify(prm));
  check('R5 a non-ISO currency is OMITTED', prm.currency === undefined, JSON.stringify(prm));
  check('R5 items[] is NEVER passed through', prm.items === undefined
    && !JSON.stringify(p).includes('evil'), JSON.stringify(prm));
  // an explicit 0 is legitimate and must survive
  const before2 = hits.length;
  await deliverToPixel({
    funnelId: VID2, pixel: px, eventName: 'Purchase', eventId: 'pur_san_zero',
    userData: { em: 'x' }, idk: ['em'],
    customData: { value: 0, currency: 'usd', order_id: 'co_san_zero' }, source: 'webhook',
  });
  const prm2 = hits[hits.length - 1]?.payload?.events?.[0]?.params || {};
  check('R5 an explicit 0 value survives', prm2.value === 0, JSON.stringify(prm2));
  check('R5 lowercase currency is normalized to USD', prm2.currency === 'USD', JSON.stringify(prm2));
  check('R5 second hit made', hits.length === before2 + 1);

  // client_id must NOT come from an attacker-chosen order_id on relayed events
  const forged = ga4ClientId({ event_id: 'cl_forged', custom_data: { order_id: 'co_ga4_ok_victim' } });
  const victim = ga4ClientId({ event_id: 'pur_co_ga4_ok_victim', custom_data: { order_id: 'co_ga4_ok_victim' } });
  check('R5 a cl_ beacon CANNOT graft onto a real order\'s GA4 user',
    forged !== victim && /^\d+\.\d+$/.test(forged), `${forged} vs ${victim}`);
  check('R5 envelope.vid wins when present (ready for the GTM phase)',
    ga4ClientId({ vid: 'v_abc', event_id: 'cl_x', custom_data: { order_id: 'co_1' } })
    === ga4ClientId({ vid: 'v_abc' }), 'vid not preferred');

  // ── R6 (LOW #12): the no_client_id failure path, end to end ──────────────
  const before3 = hits.length;
  const rNo = await deliverToPixel({
    funnelId: VID2, pixel: px, eventName: 'Purchase', eventId: '',
    userData: { em: 'x' }, idk: ['em'], customData: {}, source: 'webhook',
  });
  check('R6 no derivable client_id → dead:no_client_id', rNo === 'dead:no_client_id', String(rNo));
  check('R6 nothing was sent', hits.length === before3, `delta=${hits.length - before3}`);
}

// ── R7 (MEDIUM #5): an upsell shares the parent's GA4 user/session ──────────
{
  const UID = 'fnl_ga4ups';
  ALL.push(UID);
  const MID3 = 'G-UPSELL0001';
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${UID}`;
  await sql`DELETE FROM lb_tracking_sent WHERE pixel_id = ${MID3}`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_ga4_ups', ${UID}, 'ga4', ${MID3}, 's2s', TRUE,
                    ${sql.json({ api_secret: encryptSecret(SECRET) })})`;
  const sid = await seedPaid('ups', UID, 60);
  mpMode = 204;
  hits.length = 0;
  await firePurchaseConversion(sid, { source: 'webhook' });
  const rUp = await fireUpsellPurchaseConversion(sid, 'uc_w4', 19, { source: 'webhook' });
  check('R7 the upsell fired', rUp.ok === true && rUp.fired === 1, JSON.stringify(rUp));
  check('R7 two MP hits', hits.length === 2, String(hits.length));
  const [main, up] = hits.map((h) => h.payload);
  check('R7 upsell shares the parent client_id (same GA4 user)',
    main.client_id === up.client_id, `${main?.client_id} vs ${up?.client_id}`);
  check('R7 upsell shares the parent session_id',
    main.events[0].params.session_id === up.events[0].params.session_id);
  check('R7 but transaction_id still distinguishes the two conversions',
    main.events[0].params.transaction_id === `pur_${sid}`
    && up.events[0].params.transaction_id === `pur_${sid}_u_uc_w4`,
    JSON.stringify([main.events[0].params.transaction_id, up.events[0].params.transaction_id]));
}

// ── R8 (LOWs #7, #9, #10): redaction breadth, unknown kinds, 3xx terminal ───
{
  check('R8 redactTokens masks developer_token',
    !redactTokens('{"developer_token":"DEVTOK_AAA111"}').includes('DEVTOK_AAA111'),
    redactTokens('{"developer_token":"DEVTOK_AAA111"}'));
  check('R8 redactTokens masks refresh_token in a URL',
    !redactTokens('https://x/y?refresh_token=RFTOK_BBB222&z=1').includes('RFTOK_BBB222'),
    redactTokens('https://x/y?refresh_token=RFTOK_BBB222&z=1'));
  check('R8 redaction preserves the following query param',
    redactTokens('https://x/y?refresh_token=RF&z=1').includes('z=1'),
    redactTokens('https://x/y?refresh_token=RF&z=1'));
  check('R8 redactTokens masks capi_token', !redactTokens('capi_token=ABC123').includes('ABC123'));
  check('R8 redaction is idempotent',
    redactTokens(redactTokens('api_secret=XYZ')) === redactTokens('api_secret=XYZ'),
    redactTokens(redactTokens('api_secret=XYZ')));
  check('R8 a 3xx is TERMINAL (redirect:manual is deliberate)', retryable({ status: 302 }) === false);
  check('R8 a 5xx is still retryable', retryable({ status: 500 }) === true);

  const UKF = 'fnl_ga4unk';
  ALL.push(UKF);
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${UKF}`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES ('px_unk_1', ${UKF}, 'klingon_pixel', '999', 's2s', TRUE, '{}')`;
  const s = await req('GET', `/${UKF}/tracking/summary`);
  check('R8 summary reports unknown kinds as a COUNT',
    JSON.stringify(s.j?.data?.unknown_kinds) === '[{"kind":"klingon_pixel","rows":1}]',
    JSON.stringify(s.j?.data?.unknown_kinds));
  const s2 = await req('GET', `/${DID}/tracking/summary`);
  check('R8 a healthy funnel reports an EMPTY unknown_kinds bucket',
    Array.isArray(s2.j?.data?.unknown_kinds) && s2.j.data.unknown_kinds.length === 0,
    JSON.stringify(s2.j?.data?.unknown_kinds));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await sql`DELETE FROM lb_tracking_sent WHERE pixel_id IN ('G-DBGCLAIM1','7120001234','G-SANITIZE1','G-UPSELL0001','G-DRAINGOOD','G-DRAINBAD1')`;
await wipe();
await sql`DELETE FROM user_roles WHERE user_id = 'u_ga4_test'`;
await sql`DELETE FROM roles WHERE id = 'r_ga4_test'`;
await sql`DELETE FROM users WHERE id = 'u_ga4_test'`;

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close(); mp.close();
await sql.end();
process.exit(fail ? 1 : 0);
