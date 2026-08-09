// TRACKING ADMIN network-CRUD verification — drives the REAL
// /api/v1/tracking-admin router (real authenticate + requirePermission +
// ensureTrackingTables + encryptSecret) against embedded PG, exactly like the
// funnel-settings harness.
//
// Proves by execution: unauthenticated requests are refused; unknown kind /
// bad mode / missing pixel_id are 400s; a PUT round-trips with MASKED reads
// (the token is NEVER echoed anywhere in any response); the token is
// encrypted AT REST ('gcm1:' prefix, decrypts back to the original);
// empty-string token = leave unchanged (byte-identical ciphertext) vs
// explicit null = clear; graph_version validates; and the summary endpoint
// reports honest 24h counters (incl. deduped), breaker state,
// server_channel_ready and click_id_params.
//
// Run:  node server/tests/tracking/admin-crud.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
// credsKey() falls through JWT_SECRET → JWT_ACCESS_SECRET; pin the same value
// config/env.js defaults to so token signing + encryption agree.
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── seed auth: minimal users/roles tables + a funnels:access user ───────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_trk_test', 'trk@local.test', 'Trk', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_trk_test', 'tracking-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_trk_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_trk_test', 'r_trk_test')`;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

// ── T0 (NIT #7): dupe insurance — must run BEFORE this process's single
// ensureTrackingTables pass. Mirror the lb_pixels DDL (same pattern as
// split-delivery's funnel_pages mirror) so a fresh DB doesn't fail seeding,
// drop the unique index, hand-insert two dupes, then let ensure dedupe
// (keeping the NEWEST) and recreate the index.
await sql`CREATE TABLE IF NOT EXISTS lb_pixels (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, kind TEXT NOT NULL,
  pixel_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'hybrid',
  enabled BOOLEAN NOT NULL DEFAULT TRUE, config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
await sql`DROP INDEX IF EXISTS uq_lb_pixels_funnel_kind`;
await sql`DELETE FROM lb_pixels WHERE funnel_id = 'fnl_trkdupe'`;
await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, updated_at) VALUES
  ('px_dupe_old', 'fnl_trkdupe', 'meta_pixel', '10000001', NOW() - INTERVAL '1 hour'),
  ('px_dupe_new', 'fnl_trkdupe', 'meta_pixel', '10000002', NOW())`;

const trackingAdminRouter = (await import('../../src/routes/trackingAdmin.js')).default;
const { decryptSecret } = await import('../../src/services/gatewayConfigs.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
await ensureTrackingTables();

{
  const rows = await sql`SELECT id FROM lb_pixels WHERE funnel_id = 'fnl_trkdupe'`;
  check('T0 dedupe kept exactly the NEWEST row', rows.length === 1 && rows[0].id === 'px_dupe_new', JSON.stringify(rows));
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'uq_lb_pixels_funnel_kind'`;
  check('T0 unique index recreated', idx.length === 1, JSON.stringify(idx));
  await sql`DELETE FROM lb_pixels WHERE funnel_id = 'fnl_trkdupe'`;
}

const app = express();
app.use(express.json());
app.use('/api/v1/tracking-admin', trackingAdminRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/tracking-admin`;

const token = jwt.sign({ userId: 'u_trk_test' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

const FID = 'fnl_trkadm';
const SECRET = 'EAAB_TOK_SEKRET_9911';
// clean slate for this funnel
await sql`DELETE FROM lb_pixels WHERE funnel_id = ${FID}`;
await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${FID}`;
await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ${FID}`;

// ── T1: auth gate ───────────────────────────────────────────────────────────
{
  const r = await req('GET', `/${FID}/networks`, undefined, { 'Content-Type': 'application/json' });
  check('T1 networks without token → 401', r.status === 401, String(r.status));
  const r2 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '1' }, { 'Content-Type': 'application/json' });
  check('T1 PUT without token → 401', r2.status === 401, String(r2.status));
  const r3 = await req('GET', `/${FID}/tracking/summary`, undefined, { 'Content-Type': 'application/json' });
  check('T1 summary without token → 401', r3.status === 401, String(r3.status));
}

// ── T2: validation refusals ─────────────────────────────────────────────────
{
  const r = await req('PUT', `/${FID}/networks/tiktok_pixel`, { pixel_id: '712000123' });
  check('T2 unknown kind → 400 unknown_kind', r.status === 400 && r.j?.error?.code === 'unknown_kind', JSON.stringify(r.j));
  const r2 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '712000123', mode: 'browser' });
  check('T2 bad mode → 400 invalid_mode', r2.status === 400 && r2.j?.error?.code === 'invalid_mode', JSON.stringify(r2.j));
  const r3 = await req('PUT', `/${FID}/networks/meta_pixel`, { enabled: true });
  check('T2 new row without pixel_id → 400 pixel_id_required', r3.status === 400 && r3.j?.error?.code === 'pixel_id_required', JSON.stringify(r3.j));
  const r4 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '712000123', graph_version: 'nineteen' });
  check('T2 bad graph_version → 400', r4.status === 400 && r4.j?.error?.code === 'invalid_graph_version', JSON.stringify(r4.j));
  const r5 = await req('GET', `/${FID}/networks/ga4`);
  check('T2 GET unknown kind → 400', r5.status === 400 && r5.j?.error?.code === 'unknown_kind', JSON.stringify(r5.j));
  // review MINOR #5 + NIT #6
  const r6 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: 'abc123' });
  check('T2 non-numeric pixel_id → 400 invalid_pixel_id', r6.status === 400 && r6.j?.error?.code === 'invalid_pixel_id', JSON.stringify(r6.j));
  const r7 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '1234' });
  check('T2 too-short pixel_id → 400 invalid_pixel_id', r7.status === 400 && r7.j?.error?.code === 'invalid_pixel_id', JSON.stringify(r7.j));
  const r8 = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '712000123', enabled: 'false' });
  check('T2 string "false" enabled → 400 invalid_enabled', r8.status === 400 && r8.j?.error?.code === 'invalid_enabled', JSON.stringify(r8.j));
}

// ── T3: PUT round-trip, masked reads, token never echoed ────────────────────
{
  const r = await req('PUT', `/${FID}/networks/meta_pixel`, {
    pixel_id: '712000123', capi_token: SECRET, test_event_code: 'TEST42',
    enabled: true, mode: 'hybrid',
  });
  const n = r.j?.data?.network;
  check('T3 upsert 200 with masked view', r.status === 200 && n?.configured === true
    && n?.pixel_id === '712000123' && n?.mode === 'hybrid' && n?.enabled === true
    && n?.capi_token_set === true && n?.test_event_code === 'TEST42', JSON.stringify(n));
  check('T3 token NOT echoed in PUT response', !r.text.includes(SECRET), r.text.slice(0, 200));
  const list = await req('GET', `/${FID}/networks`);
  const item = (list.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T3 list shows configured masked row', list.status === 200 && item?.configured === true && item?.capi_token_set === true, JSON.stringify(item));
  check('T3 token NOT echoed in list', !list.text.includes(SECRET));
  const one = await req('GET', `/${FID}/networks/meta_pixel`);
  check('T3 single-kind read masked', one.status === 200 && one.j?.data?.network?.capi_token_set === true, JSON.stringify(one.j?.data));
  check('T3 token NOT echoed in single read', !one.text.includes(SECRET));
}

// ── T4: encrypted at rest — raw row starts gcm1:, decrypts to the original ──
let cipherBefore = '';
{
  const [row] = await sql`SELECT config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  cipherBefore = row?.config?.capi_token || '';
  check('T4 raw stored token starts gcm1:', cipherBefore.startsWith('gcm1:'), cipherBefore.slice(0, 10));
  check('T4 ciphertext !== plaintext', cipherBefore !== SECRET && !cipherBefore.includes(SECRET));
  check('T4 decrypts back to the original', decryptSecret(cipherBefore) === SECRET);
}

// ── T5: empty-string token = LEAVE UNCHANGED (byte-identical ciphertext) ────
{
  const r = await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '712000123', capi_token: '', mode: 's2s' });
  const [row] = await sql`SELECT config, mode FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  check('T5 "" token keeps ciphertext byte-identical', row?.config?.capi_token === cipherBefore, (row?.config?.capi_token || '').slice(0, 12));
  check('T5 other fields still patched (mode s2s)', r.status === 200 && row?.mode === 's2s' && r.j?.data?.network?.capi_token_set === true, JSON.stringify(r.j?.data?.network));
}

// ── T6: explicit null = CLEAR ───────────────────────────────────────────────
{
  const r = await req('PUT', `/${FID}/networks/meta_pixel`, { capi_token: null });
  const [row] = await sql`SELECT config, pixel_id FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  check('T6 null token clears at rest', r.status === 200 && !('capi_token' in (row?.config || {})), JSON.stringify(row?.config));
  check('T6 read reports capi_token_set false', r.j?.data?.network?.capi_token_set === false, JSON.stringify(r.j?.data?.network));
  check('T6 omitted pixel_id keeps stored value', row?.pixel_id === '712000123', row?.pixel_id);
}

// ── T7: graph_version stored + cleared; plain-field null clears ─────────────
{
  const r = await req('PUT', `/${FID}/networks/meta_pixel`, { graph_version: 'v19.0' });
  check('T7 graph_version v19.0 stored', r.status === 200 && r.j?.data?.network?.graph_version === 'v19.0', JSON.stringify(r.j?.data?.network));
  const r2 = await req('PUT', `/${FID}/networks/meta_pixel`, { graph_version: null, test_event_code: null });
  const [row] = await sql`SELECT config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  check('T7 null clears graph_version + test_event_code at rest',
    r2.status === 200 && !('graph_version' in row.config) && !('test_event_code' in row.config), JSON.stringify(row.config));
}

// ── T7b (review MINOR #4): partial PUTs merge SQL-side — no lost update ─────
// Deterministic proxy for the concurrent-PUT race: each request compiles into
// a partial jsonb patch whose CONTENT never depends on the row it read (the
// read only backs validation/defaults), and the upsert applies
// config = (stored - cleared) || patch atomically in one statement. So an
// interleaved read cannot make one writer clobber the other's field — the
// sequential form below exercises the exact statement the racers would run.
{
  await req('PUT', `/${FID}/networks/meta_pixel`, { capi_token: SECRET, test_event_code: 'TE_A' });
  await req('PUT', `/${FID}/networks/meta_pixel`, { graph_version: 'v21.0' });   // writer A: only graph_version
  await req('PUT', `/${FID}/networks/meta_pixel`, { test_event_code: 'TE_B' }); // writer B: only test_event_code
  const [row] = await sql`SELECT config FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  check('T7b every field survives disjoint partial PUTs',
    String(row.config.capi_token || '').startsWith('gcm1:') && row.config.graph_version === 'v21.0' && row.config.test_event_code === 'TE_B',
    JSON.stringify(Object.keys(row.config)));
  // reset plains for the tests below
  await req('PUT', `/${FID}/networks/meta_pixel`, { graph_version: null, test_event_code: null, capi_token: null });
}

// ── T8: upsert is ONE row per (funnel, kind) ────────────────────────────────
{
  const rows = await sql`SELECT id FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  check('T8 repeated PUTs keep exactly one row', rows.length === 1, String(rows.length));
}

// ── T9: summary — counters, breaker, readiness, click params ────────────────
{
  // restore a full server-ready config
  await req('PUT', `/${FID}/networks/meta_pixel`, { pixel_id: '712000123', capi_token: SECRET, enabled: true, mode: 'hybrid' });
  // seed the 24h ledger: 2 sent, 1 skipped, 1 error, 1 deduped, 1 queued in
  // window + 1 sent OUTSIDE the window (must not count)
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${FID}`;
  const seed = (status, hoursAgo) => sql`
    INSERT INTO lb_tracking_events (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk, ts)
    VALUES (${FID}, 'meta', '712000123', 'Purchase', ${`ev_${status}_${hoursAgo}_${Math.random()}`}, ${status}, 'webhook', '[]', NOW() - make_interval(hours => ${hoursAgo}))`;
  await seed('sent', 1); await seed('sent', 2); await seed('skipped', 1);
  await seed('error', 3); await seed('deduped', 1); await seed('queued', 1);
  await seed('sent', 48); // outside 24h
  // review MAJOR #1: queued_now reads the LIVE queue, not the ledger — the
  // ledger 'queued' row above must NOT count; this pending queue row must.
  const [pxRow] = await sql`SELECT id FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${FID}`;
  await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at)
            VALUES ('pbq_trkadm_live', ${FID}, ${`${FID}:${pxRow.id}`}, 'queued', '{}', ${pxRow.id}, 1, NOW() + INTERVAL '1 minute')`;
  const r = await req('GET', `/${FID}/tracking/summary`);
  const meta = (r.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T9 sent_24h = 2 (48h row excluded)', meta?.sent_24h === 2, JSON.stringify(meta));
  check('T9 failed_24h = 2 (skipped+error)', meta?.failed_24h === 2, JSON.stringify(meta));
  check('T9 deduped_24h = 1', meta?.deduped_24h === 1, JSON.stringify(meta));
  check('T9 queued_now = 1 from LIVE queue (ledger row ignored)', meta?.queued_now === 1, JSON.stringify(meta));
  // the drain settling the row flips the summary: queued_now → 0
  await sql`UPDATE lb_postback_queue SET status = 'done' WHERE id = 'pbq_trkadm_live'`;
  const r2 = await req('GET', `/${FID}/tracking/summary`);
  const meta2 = (r2.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T9 settled queue row → queued_now = 0', meta2?.queued_now === 0, JSON.stringify(meta2));
  check('T9 server_channel_ready true (enabled+pixel+token+hybrid)', meta?.server_channel_ready === true, JSON.stringify(meta));
  check('T9 click_id_params names fbclid', Array.isArray(meta?.click_id_params) && meta.click_id_params.includes('fbclid'), JSON.stringify(meta?.click_id_params));
  check('T9 breaker closed by default', meta?.breaker?.state === 'closed', JSON.stringify(meta?.breaker));
  check('T9 token NOT echoed in summary', !r.text.includes(SECRET));
}

// ── T10: breaker OPEN is reported; native mode is NOT server-ready ──────────
{
  const [row] = await sql`SELECT id FROM lb_pixels WHERE funnel_id = ${FID} AND kind = 'meta_pixel'`;
  await sql`INSERT INTO lb_postback_breakers (scope_id, funnel_id, fails, open_until, updated_at)
            VALUES (${`${FID}:${row.id}`}, ${FID}, 5, NOW() + INTERVAL '10 minutes', NOW())
            ON CONFLICT (scope_id) DO UPDATE SET fails = 5, open_until = NOW() + INTERVAL '10 minutes'`;
  const r = await req('GET', `/${FID}/tracking/summary`);
  const meta = (r.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T10 open breaker reported open with fails', meta?.breaker?.state === 'open' && meta?.breaker?.fails === 5, JSON.stringify(meta?.breaker));
  await req('PUT', `/${FID}/networks/meta_pixel`, { mode: 'native' });
  const r2 = await req('GET', `/${FID}/tracking/summary`);
  const meta2 = (r2.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T10 native mode → server_channel_ready false', meta2?.server_channel_ready === false, JSON.stringify(meta2));
}

// ── T11: empty funnel (edge case) — summary answers, nothing crashes ────────
{
  const r = await req('GET', `/fnl_trk_empty/tracking/summary`);
  const meta = (r.j?.data?.networks || []).find((x) => x.kind === 'meta_pixel');
  check('T11 empty funnel: 200 with zeroed unready meta row', r.status === 200
    && meta?.sent_24h === 0 && meta?.server_channel_ready === false && meta?.breaker?.state === 'closed', JSON.stringify(meta));
  const l = await req('GET', `/fnl_trk_empty/networks`);
  check('T11 empty funnel list: meta_pixel unconfigured', l.status === 200
    && l.j?.data?.networks?.find((x) => x.kind === 'meta_pixel')?.configured === false, JSON.stringify(l.j?.data));
}

// cleanup
await sql`DELETE FROM lb_pixels WHERE funnel_id = ${FID}`;
await sql`DELETE FROM lb_tracking_events WHERE funnel_id = ${FID}`;
await sql`DELETE FROM lb_postback_breakers WHERE funnel_id = ${FID}`;
await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${FID}`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_trk_test'`;
await sql`DELETE FROM roles WHERE id = 'r_trk_test'`;
await sql`DELETE FROM users WHERE id = 'u_trk_test'`;
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
