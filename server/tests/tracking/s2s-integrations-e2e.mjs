// END-TO-END verification for the ad-network INTEGRATIONS layer against a REAL
// Postgres and a REAL local HTTP target. Drives the actual routers (real
// authenticate + requirePermission + the real ensure chain + the real SQL) —
// nothing is stubbed except the seeded rows and the partner tracker, which is a
// throwaway http server on loopback.
//
// The pure harness (postback-template.mjs) proves the macro/refusal RULES.
// This one proves the things only real SQL and a real socket can prove: the
// jsonb round-trip, the unique indexes, the delivery-layer wiring, the queue
// drain's re-read of a custom row, the constant-time token path, and the
// anti-probing guarantee measured on actual response bytes.
//
// DATABASE: its OWN scratch database (puure_s2s_networks) on the local scratch
// server. It never touches puure_shoporder or any sibling database.
//
// Run:  node server/tests/tracking/s2s-integrations-e2e.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_s2s_networks';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
process.env.PUBLIC_BASE_URL = 'https://dash.example.test';
// Deterministic ip-hash salt so the ledger's ip_hash is assertable.
process.env.TRACKING_IP_SALT = 's2s-harness-salt';
// The delivery drain must not start a background timer inside the harness.
process.env.TRACKING_SWEEPS_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const http = await import('node:http');

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── seed: auth + one funnel ─────────────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_s2s', 's2s@local.test', 'S2S', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_s2s', 's2s-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_s2s'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_s2s', 'r_s2s')`;
await sql`CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, slug TEXT, custom_domain TEXT, settings JSONB DEFAULT '{}')`;
await sql`INSERT INTO funnels (id, slug) VALUES ('f_s2s', 's2s-funnel') ON CONFLICT (id) DO NOTHING`;

const FID = 'f_s2s';

// CLEAN SLATE. This harness must be RE-RUNNABLE — a suite that only passes
// against a virgin database is a suite nobody runs twice. Dropping the lane's
// tables here (before any application module is imported, so no ensure has
// cached its in-flight promise yet) also makes E0's "fresh database"
// assertion honest on EVERY run rather than only the first.
for (const t of [
  'lb_inbound_events', 'lb_inbound_endpoints', 'lb_custom_networks',
  'lb_postback_queue', 'lb_postback_breakers', 'lb_tracking_events',
  'lb_tracking_sent', 'lb_pixels',
]) {
  await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
}
await sql`DELETE FROM funnels WHERE id = 'f_other'`;

// ── the partner tracker: a real loopback http server ────────────────────────
// It records every request it receives, so "the postback actually left the
// process and arrived with the rendered query string" is an OBSERVATION, not
// an inference from a return value.
const hits = [];
let relayMode = 'ok'; // 'ok' | 'fail500' | 'slow'
const relay = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, body });
    if (relayMode === 'fail500') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('1');
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;

// ── the app under test ──────────────────────────────────────────────────────
const integrationsRouter = (await import('../../src/routes/trackingIntegrations.js')).default;
const publicPbRouter = (await import('../../src/routes/trackingPostbackPublic.js')).default;
const { ensureIntegrationsTables } = await import('../../src/services/trackingIntegrationsSchema.js');
const { customNetworksFor, asPixel, getNetwork } = await import('../../src/services/trackingCustomNetworks.js');
const delivery = await import('../../src/services/trackingDelivery.js');
const inbound = await import('../../src/services/trackingInbound.js');

const app = express();
// /pb is mounted BEFORE any global parser, exactly as the app.js mount line
// specifies — the router installs its own 32kb parsers.
app.use('/pb', publicPbRouter);
app.use(express.json());
app.use('/api/v1/tracking-admin', integrationsRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/tracking-admin`;
const PB = `http://127.0.0.1:${PORT}/pb`;

const token = jwt.sign({ userId: 'u_s2s' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

// ── E0: the ensure chain on a FRESH database ────────────────────────────────
{
  let threw = null;
  try { await ensureIntegrationsTables(); } catch (e) { threw = e.message; }
  check('E0 ensureIntegrationsTables() succeeds on a FRESH database', threw === null, String(threw));
  for (const t of ['lb_custom_networks', 'lb_inbound_endpoints', 'lb_inbound_events']) {
    const r = await sql`SELECT to_regclass(${`public.${t}`}) AS t`;
    check(`E0 ${t} created`, r[0].t !== null, JSON.stringify(r[0]));
  }
  // It chains the OWNING ensure: lb_pixels/lb_postback_queue must exist too,
  // or a custom delivery could not take a claim or queue a retry.
  for (const t of ['lb_pixels', 'lb_postback_queue', 'lb_tracking_sent', 'lb_tracking_events']) {
    const r = await sql`SELECT to_regclass(${`public.${t}`}) AS t`;
    check(`E0 chained ensure created ${t}`, r[0].t !== null, JSON.stringify(r[0]));
  }
  const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'lb_custom_networks'`;
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  check('E0 event_names column is jsonb', byName.event_names === 'jsonb', JSON.stringify(byName));
  const raw = await sql`SELECT data_type FROM information_schema.columns WHERE table_name = 'lb_inbound_events' AND column_name = 'raw'`;
  check('E0 lb_inbound_events.raw is jsonb', raw[0]?.data_type === 'jsonb', JSON.stringify(raw));
  let threw2 = null;
  try { await ensureIntegrationsTables(); } catch (e) { threw2 = e.message; }
  check('E0 ensure is idempotent on a second call', threw2 === null, String(threw2));
}

// ── E1: auth is real ────────────────────────────────────────────────────────
{
  const r = await req('GET', `/${FID}/custom-networks`, undefined, { 'Content-Type': 'application/json' });
  check('E1 unauthenticated custom-networks read is refused', r.status === 401, `${r.status} ${r.text.slice(0, 80)}`);
  const r2 = await req('GET', `/${FID}/directory`, undefined, { Authorization: 'Bearer nonsense' });
  check('E1 a garbage bearer is refused', r2.status === 401, String(r2.status));
}

// ── E2: the directory read ──────────────────────────────────────────────────
{
  const r = await req('GET', `/${FID}/directory`);
  check('E2 directory 200s', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  const d = r.j?.data || {};
  check('E2 twelve network cards', Array.isArray(d.networks) && d.networks.length === 12, String(d.networks?.length));
  check('E2 serving_base uses PUBLIC_BASE_URL + /f/<slug>',
    d.serving_base === 'https://dash.example.test/f/s2s-funnel', String(d.serving_base));
  check('E2 the meta card carries its ad-URL macros',
    (d.networks.find((n) => n.key === 'meta')?.ad_url_params || '').includes('{{campaign.id}}'), '');
  check('E2 five cards advertise a preset',
    d.networks.filter((n) => n.has_preset).length === 5, String(d.networks.filter((n) => n.has_preset).length));
  check('E2 the foundation card is present', d.foundation?.key === 'gtm', JSON.stringify(d.foundation?.key));
  // The client matches a preset card to its custom-network row on THIS key.
  // If it were derived in the UI instead, the slug rule would exist twice.
  check('E2 every preset card advertises the custom-network key it creates',
    d.networks.filter((n) => n.has_preset).every((n) => /^[a-z0-9-]+-s2s$/.test(n.preset_network_key)),
    JSON.stringify(d.networks.filter((n) => n.has_preset).map((n) => n.preset_network_key)));
  check('E2 a non-preset card advertises an empty preset key',
    d.networks.filter((n) => !n.has_preset).every((n) => n.preset_network_key === ''), '');
  check('E2 macro list is advertised', Array.isArray(d.macros) && d.macros.includes('payout'), '');
  const unknown = await req('GET', '/f_nope/directory');
  check('E2 an unknown funnel 404s', unknown.status === 404 && unknown.j?.error?.code === 'funnel_not_found', String(unknown.status));
}

// ── E3: custom-network CRUD, for real ───────────────────────────────────────
let netId = '';
{
  const created = await req('POST', `/${FID}/custom-networks`, {
    label: 'Partner Alpha',
    url_template: `${RELAY}/pb?cid={click_id}&amt={payout}&e={event}&o={order_id}&s1={sub1}`,
    click_id_param: 'paclid',
    method: 'GET',
    event_names: ['Purchase', 'Lead'],
  });
  check('E3 create 201s', created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
  netId = created.j?.data?.network?.id || '';
  check('E3 id is minted with the lbcn_ prefix', netId.startsWith('lbcn_'), netId);
  check('E3 key derived from the label', created.j?.data?.network?.key === 'partner-alpha', String(created.j?.data?.network?.key));
  check('E3 event_names round-trip through jsonb as an ARRAY',
    JSON.stringify(created.j?.data?.network?.event_names) === '["Purchase","Lead"]',
    JSON.stringify(created.j?.data?.network?.event_names));

  // The jsonb trap: a pre-stringified param stores a jsonb STRING scalar and
  // every later jsonb operator throws. Prove the stored TYPE, not just the echo.
  const t = await sql`SELECT jsonb_typeof(event_names) AS t FROM lb_custom_networks WHERE id = ${netId}`;
  check('E3 stored event_names is a jsonb ARRAY (not a double-encoded string)', t[0].t === 'array', JSON.stringify(t[0]));

  // Duplicate label → duplicate key → 409, not a 500.
  const dup = await req('POST', `/${FID}/custom-networks`, {
    label: 'partner  alpha', url_template: 'https://ok.example/pb?c={click_id}',
  });
  check('E3 a duplicate label 409s', dup.status === 409 && dup.j?.error?.code === 'duplicate_label', `${dup.status} ${dup.text.slice(0, 120)}`);

  const list = await req('GET', `/${FID}/custom-networks`);
  check('E3 list returns exactly one network', list.j?.data?.networks?.length === 1, String(list.j?.data?.networks?.length));
  check('E3 list returns the url_template verbatim (the operator must see their own text)',
    list.j?.data?.networks?.[0]?.url_template.startsWith(RELAY), String(list.j?.data?.networks?.[0]?.url_template));

  // A PARTIAL update must not blank what it never sent.
  const patched = await req('PUT', `/${FID}/custom-networks/${netId}`, { enabled: false });
  check('E3 partial update 200s', patched.status === 200, `${patched.status} ${patched.text.slice(0, 120)}`);
  check('E3 partial update flipped enabled', patched.j?.data?.network?.enabled === false, '');
  check('E3 partial update KEPT the template', patched.j?.data?.network?.url_template.startsWith(RELAY), '');
  check('E3 partial update KEPT event_names',
    JSON.stringify(patched.j?.data?.network?.event_names) === '["Purchase","Lead"]', '');
  await req('PUT', `/${FID}/custom-networks/${netId}`, { enabled: true });

  const gone = await req('PUT', '/f_s2s/custom-networks/lbcn_nope', { enabled: true });
  check('E3 updating an unknown id 404s', gone.status === 404, String(gone.status));
}

// ── E4: SSRF REFUSALS at SAVE time ──────────────────────────────────────────
{
  const CASES = [
    ['https://169.254.169.254/pb?c={click_id}', 'unsafe_template_blocked_host', 'cloud metadata'],
    ['https://10.0.0.7/pb?c={click_id}', 'unsafe_template_blocked_host', 'private 10/8'],
    ['https://localhost/pb?c={click_id}', 'unsafe_template_blocked_host', 'localhost by name'],
    ['https://{click_id}.evil.example/pb', 'template_macro_in_host', 'macro in the host'],
    ['https://u:p@ok.example/pb', 'template_userinfo', 'userinfo in the url'],
    ['ftp://ok.example/pb', 'template_bad_scheme', 'non-http scheme'],
    ['javascript:alert(1)', 'template_bad_scheme', 'javascript: scheme'],
    ['nonsense', 'template_not_a_url', 'garbage'],
  ];
  let i = 0;
  for (const [tmpl, code, label] of CASES) {
    i += 1;
    const r = await req('POST', `/${FID}/custom-networks`, { label: `Bad ${i}`, url_template: tmpl });
    check(`E4 SAVE refused (${code}): ${label}`,
      r.status === 400 && r.j?.error?.code === code, `${r.status} ${r.text.slice(0, 140)}`);
  }
  const rows = await sql`SELECT COUNT(*)::int AS n FROM lb_custom_networks WHERE funnel_id = ${FID}`;
  check('E4 not one refused template was persisted', rows[0].n === 1, JSON.stringify(rows[0]));

  // An UPDATE must be gated identically — a safe template edited into an
  // unsafe one is the obvious bypass.
  const upd = await req('PUT', `/${FID}/custom-networks/${netId}`, { url_template: 'https://169.254.169.254/pb' });
  check('E4 UPDATE to a metadata host is refused',
    upd.status === 400 && upd.j?.error?.code === 'unsafe_template_blocked_host', `${upd.status} ${upd.text.slice(0, 140)}`);
  const still = await getNetwork(FID, netId);
  check('E4 the refused update did not touch the stored template', still.url_template.startsWith(RELAY), still.url_template);
}

// ── E5: TEST FIRE ───────────────────────────────────────────────────────────
{
  hits.length = 0;
  relayMode = 'ok';
  const r = await req('POST', `/${FID}/custom-networks/${netId}/test`, {});
  check('E5 test-fire 200s', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  const d = r.j?.data || {};
  check('E5 test-fire reports ok', d.ok === true, JSON.stringify(d));
  check('E5 test-fire returns the RESOLVED url', String(d.rendered_url || '').startsWith(RELAY), String(d.rendered_url));
  check('E5 the resolved url carries the synthetic click id', String(d.rendered_url).includes('TEST_CLICK_ID'), String(d.rendered_url));
  check('E5 the resolved url carries the $1.00 payout', String(d.rendered_url).includes('amt=1.00'), String(d.rendered_url));
  check('E5 test-fire reports the response CODE', d.status === 200, JSON.stringify(d.status));
  check('E5 test-fire returns the raw response body', d.response?.raw === '1', JSON.stringify(d.response));
  check('E5 the partner tracker actually received the request', hits.length === 1, JSON.stringify(hits));
  check('E5 it arrived as a GET with the rendered query', hits[0]?.method === 'GET' && hits[0]?.url.includes('TEST_CLICK_ID'), JSON.stringify(hits[0]));

  // NOTHING is written: no ledger row, no delivery claim. A test that burned
  // the (pixel_id, event_id) claim would suppress a real conversion forever.
  const ev = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_events`;
  const sent = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent`;
  check('E5 test-fire wrote NO tracking-event row', ev[0].n === 0, JSON.stringify(ev[0]));
  check('E5 test-fire took NO delivery claim', sent[0].n === 0, JSON.stringify(sent[0]));

  // A failing target is reported honestly, not swallowed.
  relayMode = 'fail500';
  hits.length = 0;
  const bad = await req('POST', `/${FID}/custom-networks/${netId}/test`, { event: 'Lead' });
  check('E5 a 500 from the partner is reported as ok:false + status 500',
    bad.j?.data?.ok === false && bad.j?.data?.status === 500, JSON.stringify(bad.j?.data));
  check('E5 the failing test still returns the resolved url for debugging',
    String(bad.j?.data?.rendered_url || '').includes('e=lead'), String(bad.j?.data?.rendered_url));
  relayMode = 'ok';

  const badEvent = await req('POST', `/${FID}/custom-networks/${netId}/test`, { event: 'Nope' });
  check('E5 an unknown test event name is refused',
    badEvent.status === 400 && badEvent.j?.error?.code === 'unknown_event_name', String(badEvent.status));
}

// ── E6: PRESETS ─────────────────────────────────────────────────────────────
{
  const r = await req('POST', `/${FID}/custom-networks/preset/taboola`);
  check('E6 preset create 201s', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const n = r.j?.data?.network;
  check('E6 taboola preset lands ENABLED (no credential needed)', n?.enabled === true, JSON.stringify(n?.enabled));
  check('E6 taboola preset carries the tblci click-id param', n?.click_id_param === 'tblci', String(n?.click_id_param));
  check('E6 taboola preset template points at trc.taboola.com',
    String(n?.url_template).startsWith('https://trc.taboola.com/'), String(n?.url_template));
  // The created row's key must EQUAL what the directory advertised, or the
  // card can never find its own connection and stays "not connected" forever.
  const dir2 = await req('GET', `/${FID}/directory`);
  const advertised = dir2.j.data.networks.find((x) => x.key === 'taboola').preset_network_key;
  check('E6 the created row key matches the directory’s preset_network_key',
    n?.key === advertised, `${n?.key} vs ${advertised}`);

  const m = await req('POST', `/${FID}/custom-networks/preset/mgid`);
  check('E6 mgid preset 201s', m.status === 201, String(m.status));
  check('E6 mgid preset (credential placeholder) lands DISABLED', m.j?.data?.network?.enabled === false, JSON.stringify(m.j?.data?.network?.enabled));
  check('E6 mgid preset returns the credential note', String(m.j?.data?.credential_note || '').includes('YOUR_POSTBACK_ID'), String(m.j?.data?.credential_note));

  const dup = await req('POST', `/${FID}/custom-networks/preset/taboola`);
  check('E6 a second taboola preset 409s (one per funnel)', dup.status === 409, String(dup.status));
  const nope = await req('POST', `/${FID}/custom-networks/preset/nosuch`);
  check('E6 an unknown preset key 404s', nope.status === 404 && nope.j?.error?.code === 'unknown_preset', String(nope.status));
}

// ── E7: DELIVERY-LAYER INTEGRATION ──────────────────────────────────────────
// The point of the whole design: a custom network rides deliverToPixel, so it
// gets the idempotency claim, the breaker, the queue and the ledger for free.
{
  // Only the Purchase/Lead-toggled network should be selected for Purchase.
  // (Taboola's preset is Purchase-only; mgid's landed disabled.)
  const forPurchase = await customNetworksFor(FID, 'Purchase');
  const forPageView = await customNetworksFor(FID, 'PageView');
  check('E7 the per-event toggle selects 2 networks for Purchase',
    forPurchase.length === 2, forPurchase.map((p) => p.pixel_id).join());
  check('E7 the per-event toggle selects NONE for PageView', forPageView.length === 0, String(forPageView.length));
  check('E7 a DISABLED network is never selected',
    !forPurchase.some((p) => p.pixel_id === 'mgid-s2s'), forPurchase.map((p) => p.pixel_id).join());
  check('E7 the projection is kind:custom / mode:s2s',
    forPurchase.every((p) => p.kind === 'custom' && p.mode === 's2s'), JSON.stringify(forPurchase[0]));

  const row = await getNetwork(FID, netId);
  const px = asPixel(row);
  hits.length = 0;
  relayMode = 'ok';
  const res1 = await delivery.deliverToPixel({
    funnelId: FID, pixel: px, eventName: 'Purchase', eventId: 'pur_test_1',
    userData: { click_id: 'REALCLICK' }, idk: ['em', 'click_id'],
    customData: { value: 30, currency: 'EUR', order_id: 'co_9', subs: { sub1: 'ad1' } },
    source: 'webhook', eventSourceUrl: 'https://shop.example/ty',
  });
  check('E7 deliverToPixel returns "sent" for a healthy custom network', res1 === 'sent', String(res1));
  check('E7 the postback actually reached the partner', hits.length === 1, JSON.stringify(hits.length));
  check('E7 it carried the REAL click id and the money fields',
    hits[0]?.url.includes('cid=REALCLICK') && hits[0]?.url.includes('amt=30.00') && hits[0]?.url.includes('o=co_9'),
    String(hits[0]?.url));
  check('E7 it carried sub1 from custom_data.subs', hits[0]?.url.includes('s1=ad1'), String(hits[0]?.url));

  const logged = await sql`SELECT platform, pixel_id, status, error FROM lb_tracking_events WHERE event_id = 'pur_test_1'`;
  check('E7 a ledger row was written under platform "custom"',
    logged.length === 1 && logged[0].platform === 'custom' && logged[0].status === 'sent', JSON.stringify(logged));
  check('E7 the ledger row keys on the network KEY, not the row id',
    logged[0]?.pixel_id === 'partner-alpha', String(logged[0]?.pixel_id));
  // THE CRITICAL LEAK CHECK: the rendered url (which can carry a postback
  // secret) must appear NOWHERE in any persisted column.
  const leak = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_events WHERE error LIKE '%127.0.0.1%'`;
  check('E7 no rendered url leaked into lb_tracking_events.error', leak[0].n === 0, JSON.stringify(leak[0]));

  // Idempotency: the SAME event id is a no-op, logged as 'deduped'.
  hits.length = 0;
  const res2 = await delivery.deliverToPixel({
    funnelId: FID, pixel: px, eventName: 'Purchase', eventId: 'pur_test_1',
    userData: { click_id: 'REALCLICK' }, idk: ['em'], customData: { value: 30 }, source: 'webhook',
  });
  check('E7 a replay of the same event_id is a duplicate', res2 === 'duplicate', String(res2));
  check('E7 the duplicate fired NOTHING at the partner', hits.length === 0, String(hits.length));

  // No identity ⇒ skipped BEFORE sending, breaker untouched.
  const res3 = await delivery.deliverToPixel({
    funnelId: FID, pixel: px, eventName: 'Purchase', eventId: 'pur_test_noid',
    userData: {}, idk: [], customData: { value: 1 }, source: 'webhook',
  });
  check('E7 an event with no identity is skipped, not sent', res3 === 'skipped:no_identity', String(res3));
}

// ── E8: FAILURE → QUEUE → DRAIN (with the custom-row re-read) ───────────────
{
  const row = await getNetwork(FID, netId);
  const px = asPixel(row);
  relayMode = 'fail500';
  hits.length = 0;
  const res = await delivery.deliverToPixel({
    funnelId: FID, pixel: px, eventName: 'Purchase', eventId: 'pur_queue_1',
    userData: { click_id: 'QCLICK' }, idk: ['em'],
    customData: { value: 5, currency: 'USD', order_id: 'co_q' }, source: 'webhook',
  });
  check('E8 a 500 from the partner QUEUES the event', String(res).startsWith('queued:'), String(res));
  const q = await sql`SELECT id, pixel_row_id, status, attempts FROM lb_postback_queue WHERE funnel_id = ${FID}`;
  check('E8 one queue row exists, holding the CUSTOM row id',
    q.length === 1 && q[0].pixel_row_id === netId, JSON.stringify(q));

  // The drain must resolve that id back to a custom network. Before this
  // lane, drainOne read lb_pixels ONLY — a custom row id would have settled
  // as 'pixel_gone' and dead-lettered every queued partner conversion.
  await sql`UPDATE lb_postback_queue SET next_at = NOW() - INTERVAL '1 minute' WHERE funnel_id = ${FID}`;
  relayMode = 'ok';
  hits.length = 0;
  const out = await delivery.runDelivery({ limit: 10 });
  check('E8 the drain picked the row up', out.due === 1, JSON.stringify(out));
  check('E8 the drain DELIVERED it (the custom row was re-read)', out.sent === 1, JSON.stringify(out));
  check('E8 the drained postback reached the partner with the queued envelope',
    hits.length === 1 && hits[0].url.includes('cid=QCLICK') && hits[0].url.includes('o=co_q'), JSON.stringify(hits[0]?.url));
  const q2 = await sql`SELECT status FROM lb_postback_queue WHERE funnel_id = ${FID}`;
  check('E8 the queue row settled to done', q2[0]?.status === 'done', JSON.stringify(q2));
  const drainLog = await sql`SELECT status, source, platform FROM lb_tracking_events WHERE event_id = 'pur_queue_1' AND source = 'drain'`;
  check('E8 the drain wrote its own ledger row', drainLog.length === 1 && drainLog[0].status === 'sent', JSON.stringify(drainLog));

  // A DELETED custom network dead-letters honestly rather than vanishing.
  const tmp = await req('POST', `/${FID}/custom-networks`, {
    label: 'Doomed', url_template: `${RELAY}/pb?c={click_id}`, event_names: ['Purchase'],
  });
  const doomedId = tmp.j.data.network.id;
  relayMode = 'fail500';
  await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, doomedId)), eventName: 'Purchase',
    eventId: 'pur_doomed', userData: { click_id: 'D' }, idk: ['em'], customData: { value: 1 }, source: 'webhook',
  });
  await req('DELETE', `/${FID}/custom-networks/${doomedId}`);
  await sql`UPDATE lb_postback_queue SET next_at = NOW() - INTERVAL '1 minute' WHERE pixel_row_id = ${doomedId}`;
  relayMode = 'ok';
  const out2 = await delivery.runDelivery({ limit: 10 });
  const dq = await sql`SELECT status, last_error FROM lb_postback_queue WHERE pixel_row_id = ${doomedId}`;
  check('E8 a deleted network dead-letters as pixel_gone, not a crash',
    dq[0]?.status === 'dead' && String(dq[0]?.last_error).includes('pixel_gone'),
    `${JSON.stringify(dq)} out=${JSON.stringify(out2)}`);
  check('E8 the drain tick did not error', (out2.errored || 0) === 0, JSON.stringify(out2));
}

// ── E8b: per-custom-network HEALTH ──────────────────────────────────────────
// The named-network summary iterates the NAMED registry, so a custom network
// is invisible there. This is the surface a preset card reads its three
// counters from — and its route must not be captured by the /:id route.
{
  const r = await req('GET', `/${FID}/custom-networks/health`);
  check('E8b health 200s (not captured by the /:id route)', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  const rows = r.j?.data?.health || [];
  const alpha = rows.find((h) => h.key === 'partner-alpha');
  check('E8b the delivering network reports 2 sent in 24h', alpha?.sent_24h === 2, JSON.stringify(alpha));
  check('E8b it reports the dedupe too', alpha?.deduped_24h === 1, JSON.stringify(alpha));
  check('E8b queued_now is a LIVE depth, not a ledger count', alpha?.queued_now === 0, JSON.stringify(alpha));
  check('E8b an enabled, event-toggled network reads server_channel_ready', alpha?.server_channel_ready === true, JSON.stringify(alpha));
  const mgid = rows.find((h) => h.key === 'mgid-s2s');
  check('E8b a DISABLED preset is never server_channel_ready', mgid?.server_channel_ready === false, JSON.stringify(mgid));
  check('E8b every configured network appears, even with zero traffic',
    rows.length === (await sql`SELECT COUNT(*)::int AS n FROM lb_custom_networks WHERE funnel_id = ${FID}`)[0].n,
    String(rows.length));
}

// ── E9: INBOUND — mint, ingest, ledger ──────────────────────────────────────
let epToken = ''; let epId = '';
{
  const r = await req('POST', `/${FID}/inbound-endpoints`, { label: 'Affiliate net', purpose: 'affiliate' });
  check('E9 mint 201s', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const ep = r.j?.data?.endpoint;
  epToken = ep?.token || ''; epId = ep?.id || '';
  check('E9 the token is 32 hex chars (128 bits)', /^[0-9a-f]{32}$/.test(epToken), epToken);
  check('E9 the public url is built from PUBLIC_BASE_URL',
    ep?.url === `https://dash.example.test/pb/${epToken}`, String(ep?.url));
  check('E9 the path form is always returned', ep?.path === `/pb/${epToken}`, String(ep?.path));
  const stored = await sql`SELECT token_prefix FROM lb_inbound_endpoints WHERE id = ${epId}`;
  check('E9 token_prefix is the first 8 chars (the indexed lookup key)',
    stored[0].token_prefix === epToken.slice(0, 8), JSON.stringify(stored[0]));

  // A real postback.
  const res = await fetch(`${PB}/${epToken}?event=Purchase&payout=42.50&currency=usd&order_id=ord_1&fbclid=FBC_1&sub1=x`);
  const body = await res.text();
  check('E9 a valid inbound postback answers 200', res.status === 200, String(res.status));
  check('E9 the answer body is the fixed ANSWER', body === '{"ok":true}', body);
  const rows = await sql`SELECT * FROM lb_inbound_events WHERE endpoint_id = ${epId}`;
  check('E9 exactly one ledger row was written', rows.length === 1, JSON.stringify(rows.length));
  const row = rows[0];
  check('E9 the payout parsed', Number(row.payout) === 42.5, String(row.payout));
  check('E9 the currency normalised to USD', row.currency === 'USD', row.currency);
  check('E9 the click id resolved to the fbclid + meta network',
    row.click_id === 'FBC_1' && row.click_key === 'fbclid' && row.network === 'meta', JSON.stringify(row));
  check('E9 the event id is derived from the order id', row.event_id === 'inb_ord_1', row.event_id);
  check('E9 raw is a jsonb OBJECT carrying the received params',
    row.raw && typeof row.raw === 'object' && row.raw.sub1 === 'x', JSON.stringify(row.raw));
  check('E9 the raw ip was NOT stored — only a hash', String(row.ip_hash).length === 32 && !JSON.stringify(row).includes('127.0.0.1'), String(row.ip_hash));
  check('E9 consumed_at is NULL (attribution has not run — this lane does not)', row.consumed_at === null, String(row.consumed_at));

  const eps = await sql`SELECT hits FROM lb_inbound_endpoints WHERE id = ${epId}`;
  check('E9 the endpoint hit counter incremented', Number(eps[0].hits) === 1, JSON.stringify(eps[0]));

  // The AUTHED ledger read is where an operator actually verifies the wiring.
  const ledger = await req('GET', `/${FID}/inbound-events`);
  check('E9 the authed ledger surfaces the row', ledger.j?.data?.events?.length === 1, JSON.stringify(ledger.j?.data?.events?.length));

  // POST with a JSON body works identically.
  await fetch(`${PB}/${epToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'Lead', order_id: 'ord_2', gclid: 'GC_2' }),
  });
  const two = await sql`SELECT event, network, click_key FROM lb_inbound_events WHERE event_id = 'inb_ord_2'`;
  check('E9 a JSON POST ingests', two.length === 1 && two[0].event === 'Lead', JSON.stringify(two));
  check('E9 gclid resolves to the google network', two[0]?.network === 'google' && two[0]?.click_key === 'gclid', JSON.stringify(two[0]));

  // Form-encoded POST (what half the tracker world actually sends).
  await fetch(`${PB}/${epToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'event=Purchase&order_id=ord_3&payout=9.99',
  });
  const three = await sql`SELECT payout FROM lb_inbound_events WHERE event_id = 'inb_ord_3'`;
  check('E9 a form-encoded POST ingests', three.length === 1 && Number(three[0].payout) === 9.99, JSON.stringify(three));
}

// ── E10: INBOUND DEDUPE + the refusals ──────────────────────────────────────
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events`;
  // The same order id twice — an honest partner retry.
  await fetch(`${PB}/${epToken}?event=Purchase&order_id=ord_1&payout=42.50`);
  const after = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events`;
  check('E10 a repeated order_id does NOT double-count', after[0].n === before[0].n, `${before[0].n} → ${after[0].n}`);

  // No order id AND no click id: a crawler / link preview / uptime monitor.
  await fetch(`${PB}/${epToken}?event=Purchase&payout=1000`);
  const after2 = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events`;
  check('E10 a postback with no order id and no click id writes NOTHING', after2[0].n === after[0].n, `${after[0].n} → ${after2[0].n}`);

  // An event name outside the vocabulary.
  await fetch(`${PB}/${epToken}?event=DrainBankAccount&order_id=ord_evil`);
  const evil = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_ord_evil'`;
  check('E10 an unknown event name writes NOTHING', evil[0].n === 0, JSON.stringify(evil[0]));

  // Value bounds: negative, absurd, and NaN must not land as a number.
  await fetch(`${PB}/${epToken}?event=Purchase&order_id=ord_neg&payout=-50`);
  await fetch(`${PB}/${epToken}?event=Purchase&order_id=ord_huge&payout=99999999999`);
  await fetch(`${PB}/${epToken}?event=Purchase&order_id=ord_nan&payout=NaN`);
  const bounds = await sql`SELECT event_id, payout FROM lb_inbound_events WHERE event_id IN ('inb_ord_neg','inb_ord_huge','inb_ord_nan') ORDER BY event_id`;
  check('E10 all three out-of-bounds payouts stored NULL, not a number',
    bounds.length === 3 && bounds.every((b) => b.payout === null), JSON.stringify(bounds));

  // A GET with NO event is a prefetch — readiness only, nothing written.
  const beforeP = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events`;
  const prefetch = await fetch(`${PB}/${epToken}`);
  const prefetchBody = await prefetch.text();
  const afterP = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events`;
  check('E10 a bare GET writes nothing', afterP[0].n === beforeP[0].n, `${beforeP[0].n} → ${afterP[0].n}`);
  check('E10 a bare GET answers the same body', prefetchBody === '{"ok":true}', prefetchBody);

  // MALFORMED BODIES must never reach the caller as an error.
  const badJson = await fetch(`${PB}/${epToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event": "Purchase", ',
  });
  const badJsonBody = await badJson.text();
  check('E10 malformed JSON answers 200 with the SAME body',
    badJson.status === 200 && badJsonBody === '{"ok":true}', `${badJson.status} ${badJsonBody}`);

  const oversize = await fetch(`${PB}/${epToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'Purchase', order_id: 'big', pad: 'x'.repeat(100_000) }),
  });
  const oversizeBody = await oversize.text();
  check('E10 an oversize body answers 200 with the SAME body (32kb cap, fail-open)',
    oversize.status === 200 && oversizeBody === '{"ok":true}', `${oversize.status} ${oversizeBody.slice(0, 80)}`);
  const big = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_big'`;
  check('E10 the oversize body was NOT ingested', big[0].n === 0, JSON.stringify(big[0]));

  // A nested object in the body must not land as '[object Object]'.
  await fetch(`${PB}/${epToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'Purchase', order_id: 'ord_nested', evil: { a: 1 }, arr: [1, 2] }),
  });
  const nested = await sql`SELECT raw FROM lb_inbound_events WHERE event_id = 'inb_ord_nested'`;
  check('E10 nested/array params are dropped, never stringified',
    nested.length === 1 && nested[0].raw.evil === undefined && nested[0].raw.arr === undefined, JSON.stringify(nested[0]?.raw));
}

// ── E11: ANTI-PROBING — the whole point of the public surface ───────────────
{
  const sample = async (url, init) => {
    const r = await fetch(url, init);
    return { status: r.status, body: await r.text(), ctype: r.headers.get('content-type') };
  };
  const validNoop = await sample(`${PB}/${epToken}?event=Purchase`);          // valid token, nothing ingested
  const validReal = await sample(`${PB}/${epToken}?event=Purchase&order_id=probe_1&payout=5`);
  const unknown = await sample(`${PB}/${'f'.repeat(32)}?event=Purchase&order_id=probe_1&payout=5`);
  const malformed = await sample(`${PB}/nothexatall?event=Purchase&order_id=probe_1`);
  const shortTok = await sample(`${PB}/abc?event=Purchase&order_id=probe_1`);

  const all = [validNoop, validReal, unknown, malformed, shortTok];
  check('E11 every token outcome returns 200', all.every((a) => a.status === 200), JSON.stringify(all.map((a) => a.status)));
  check('E11 every token outcome returns a BYTE-IDENTICAL body',
    new Set(all.map((a) => a.body)).size === 1, JSON.stringify([...new Set(all.map((a) => a.body))]));
  check('E11 every token outcome returns the same content-type',
    new Set(all.map((a) => a.ctype)).size === 1, JSON.stringify([...new Set(all.map((a) => a.ctype))]));
  // …and the valid one really did ingest, so the identical answers are hiding
  // a REAL difference rather than both being no-ops.
  const probed = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_probe_1'`;
  check('E11 the valid token DID ingest behind the identical answer', probed[0].n === 1, JSON.stringify(probed[0]));

  // A DISABLED endpoint is indistinguishable from an unknown token.
  await req('PUT', `/${FID}/inbound-endpoints/${epId}`, { enabled: false });
  const disabled = await sample(`${PB}/${epToken}?event=Purchase&order_id=probe_2`);
  check('E11 a DISABLED endpoint answers identically',
    disabled.status === 200 && disabled.body === unknown.body, JSON.stringify(disabled));
  const off = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_probe_2'`;
  check('E11 a disabled endpoint ingests NOTHING', off[0].n === 0, JSON.stringify(off[0]));
  await req('PUT', `/${FID}/inbound-endpoints/${epId}`, { enabled: true });

  // ROTATE revokes: the old token becomes indistinguishable from garbage.
  const rot = await req('POST', `/${FID}/inbound-endpoints/${epId}/rotate`);
  const newToken = rot.j?.data?.endpoint?.token;
  check('E11 rotate mints a different token', /^[0-9a-f]{32}$/.test(newToken) && newToken !== epToken, String(newToken));
  const oldTok = await sample(`${PB}/${epToken}?event=Purchase&order_id=probe_3`);
  check('E11 the OLD token answers identically to an unknown one', oldTok.body === unknown.body, oldTok.body);
  const revoked = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_probe_3'`;
  check('E11 the OLD token ingests NOTHING after rotation', revoked[0].n === 0, JSON.stringify(revoked[0]));
  const newOk = await fetch(`${PB}/${newToken}?event=Purchase&order_id=probe_4`);
  await newOk.text();
  const fresh = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = 'inb_probe_4'`;
  check('E11 the NEW token works', fresh[0].n === 1, JSON.stringify(fresh[0]));
  epToken = newToken;

  // Constant-time compare, unit level: a length mismatch must not throw.
  let threw = null;
  try { inbound.tokensEqual('short', 'a'.repeat(32)); } catch (e) { threw = e.message; }
  check('E11 tokensEqual does not throw on a length mismatch', threw === null, String(threw));
  check('E11 tokensEqual is false for a near-miss',
    inbound.tokensEqual(`${'a'.repeat(31)}b`, 'a'.repeat(32)) === false);
  check('E11 tokensEqual is true for an exact match', inbound.tokensEqual('a'.repeat(32), 'a'.repeat(32)) === true);
  check('E11 tokensEqual is false for two empties (never a wildcard)', inbound.tokensEqual('', '') === false);
}

// ── E12: RATE LIMIT ─────────────────────────────────────────────────────────
// The limiter is per CLIENT IP (not per token), so a 429 reveals nothing about
// whether a token exists. Driven through the real checkRateLimit.
{
  const { _resetRateLimitStore } = await import('../../src/middleware/rateLimiter.js').catch(() => ({}));
  if (typeof _resetRateLimitStore === 'function') _resetRateLimitStore();
  let limited = 0; let okCount = 0;
  // The route's default budget is 120/min per IP; 140 sequential calls must
  // cross it. Bodies are minimal so nothing is ingested (no order/click id).
  for (let i = 0; i < 140; i += 1) {
    const r = await fetch(`${PB}/${epToken}?event=Purchase`);
    await r.text();
    if (r.status === 429) limited += 1; else okCount += 1;
  }
  check('E12 the per-IP limiter engaged', limited > 0, `${okCount} allowed / ${limited} limited of 140`);
  check('E12 it allowed roughly the configured budget first', okCount >= 100 && okCount <= 125, `allowed=${okCount}`);
  // A limited response is a 429 — the ONE non-200, and it is keyed to the IP.
  const r = await fetch(`${PB}/${epToken}?event=Purchase`);
  const t = await r.text();
  check('E12 a limited call answers 429 with a rate_limited code',
    r.status === 429 && t.includes('rate_limited'), `${r.status} ${t}`);
}

// ── E13: endpoint limit + cleanup semantics ─────────────────────────────────
{
  const existing = await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_endpoints WHERE funnel_id = ${FID}`;
  for (let i = existing[0].n; i < 10; i += 1) {
    await req('POST', `/${FID}/inbound-endpoints`, { label: `E${i}` });
  }
  const over = await req('POST', `/${FID}/inbound-endpoints`, { label: 'one too many' });
  check('E13 the endpoint limit is enforced', over.status === 422 && over.j?.error?.code === 'endpoint_limit', `${over.status} ${over.text.slice(0, 120)}`);
  const del = await req('DELETE', `/${FID}/inbound-endpoints/${epId}`);
  check('E13 delete 200s', del.status === 200, String(del.status));
  const delAgain = await req('DELETE', `/${FID}/inbound-endpoints/${epId}`);
  check('E13 deleting twice 404s (no silent success)', delAgain.status === 404, String(delAgain.status));
}

// ── E14: funnel scoping — one funnel can never read another's rows ──────────
{
  await sql`INSERT INTO funnels (id, slug) VALUES ('f_other', 'other') ON CONFLICT (id) DO NOTHING`;
  const other = await req('GET', '/f_other/custom-networks');
  check('E14 a sibling funnel sees NO custom networks', other.j?.data?.networks?.length === 0, JSON.stringify(other.j?.data?.networks?.length));
  const otherEvents = await req('GET', '/f_other/inbound-events');
  check('E14 a sibling funnel sees NO inbound events', otherEvents.j?.data?.events?.length === 0, JSON.stringify(otherEvents.j?.data?.events?.length));
  const crossDelete = await req('DELETE', `/f_other/custom-networks/${netId}`);
  check('E14 a cross-funnel delete 404s (scoping is in the WHERE clause)', crossDelete.status === 404, String(crossDelete.status));
  const stillThere = await getNetwork(FID, netId);
  check('E14 the cross-funnel delete did not remove the row', Boolean(stillThere), '');
}

// ── E15: the GENERAL flags read (funnels.settings.tracking) ────────────────
// send_external_id is the ONE general flag wired into the delivery layer. Its
// read must FAIL OPEN to today's behaviour: only an explicit `false` may drop
// external_id from the CAPI identity, because a read failure that silently
// stopped sending it would quietly degrade match quality on every conversion.
{
  const { trackingFlags } = await import('../../src/services/trackingService.js');
  const set = async (v) => sql`UPDATE funnels SET settings = ${v}::jsonb WHERE id = ${FID}`;

  await set({});
  check('E15 empty settings → no flags', Object.keys(await trackingFlags(FID)).length === 0);

  await set({ tracking: { send_external_id: false, fire_viewcontent_lead: true } });
  const f1 = await trackingFlags(FID);
  check('E15 an explicit false is read as false', f1.send_external_id === false, JSON.stringify(f1));
  check('E15 sibling flags survive the read', f1.fire_viewcontent_lead === true, JSON.stringify(f1));

  // The jsonb both-shape trap: a double-encoded settings blob must still read.
  await sql`UPDATE funnels SET settings = to_jsonb(${'{"tracking":{"send_external_id":false}}'}::text) WHERE id = ${FID}`;
  const f2 = await trackingFlags(FID);
  check('E15 a DOUBLE-ENCODED settings blob still reads the flag', f2.send_external_id === false, JSON.stringify(f2));

  // Malformed / wrong-typed shapes degrade to {} — never throw, never invent.
  await sql`UPDATE funnels SET settings = ${['a', 'b']}::jsonb WHERE id = ${FID}`;
  check('E15 an ARRAY settings blob degrades to {}', Object.keys(await trackingFlags(FID)).length === 0);
  await sql`UPDATE funnels SET settings = ${{ tracking: 'nope' }}::jsonb WHERE id = ${FID}`;
  check('E15 a scalar `tracking` degrades to {}', Object.keys(await trackingFlags(FID)).length === 0);
  check('E15 an unknown funnel degrades to {} (never throws)',
    Object.keys(await trackingFlags('f_does_not_exist')).length === 0);

  // The gate itself, stated as the code states it.
  const gate = (flags) => (flags.send_external_id === false ? '' : 'SESSION_ID');
  check('E15 GATE absent  → external_id IS sent (today’s behaviour)', gate({}) === 'SESSION_ID');
  check('E15 GATE true    → external_id IS sent', gate({ send_external_id: true }) === 'SESSION_ID');
  check('E15 GATE false   → external_id is OMITTED', gate({ send_external_id: false }) === '');
  check('E15 GATE "false" (a string) does NOT disable it', gate({ send_external_id: 'false' }) === 'SESSION_ID');
  await set({});
}

// ── teardown ────────────────────────────────────────────────────────────────
server.close();
relay.close();
await sql.end();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
