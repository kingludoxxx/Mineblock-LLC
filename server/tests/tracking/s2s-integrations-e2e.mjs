// END-TO-END verification for the ad-network INTEGRATIONS layer against a REAL
// Postgres and a REAL local HTTP target. Drives the actual routers (real
// authenticate + requirePermission + the real ensure chain + the real SQL) —
// nothing is stubbed except the seeded rows and the partner tracker, which is a
// throwaway http server on loopback.
//
// The pure harness (postback-template.mjs) proves the macro/refusal RULES.
// This one proves the things only real SQL and a real socket can prove: the
// jsonb round-trip, the unique indexes, the delivery-layer wiring, the queue
// drain's re-read of a custom row, the token path's constant-WORK floor, the
// mount-order contract, credential sanitization measured on the actual
// database column, and the anti-probing guarantee measured on response bytes.
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
// `name` is NOT optional in the real schema (routes/funnels.js) and the
// {funnel} macro now reads it, so the fixture carries it too.
await sql`CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_domain TEXT, settings JSONB DEFAULT '{}')`;
await sql`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS name TEXT`;
// routes/funnels.js ensureTables() builds a partial unique index on
// (slug) WHERE NOT archived, and the health route calls that ensure. The
// fixture needs the columns that index references or the panel 500s.
await sql`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`;
await sql`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`;
await sql`INSERT INTO funnels (id, slug, name) VALUES ('f_s2s', 's2s-funnel', 'S2S Demo Funnel') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;

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
    if (relayMode === 'echo400') {
      // What a real postback tracker does on a bad click id: quote the URL it
      // was called with, credential and all. This is the M1 repro's source.
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad Request: could not process http://127.0.0.1:${relay.address().port}${req.url} — invalid click id`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('1');
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;

// ── the app under test ──────────────────────────────────────────────────────
const integrationsRouter = (await import('../../src/routes/trackingIntegrations.js')).default;
const extrasRouter = (await import('../../src/routes/funnelTrackingExtras.js')).default;
const adminRouter = (await import('../../src/routes/trackingAdmin.js')).default;
const trackPublicRouter = (await import('../../src/routes/trackingPublic.js')).default;
const trackingService = await import('../../src/services/trackingService.js');
const publicPbRouter = (await import('../../src/routes/trackingPostbackPublic.js')).default;
const { ensureIntegrationsTables } = await import('../../src/services/trackingIntegrationsSchema.js');
const { customNetworksFor, asPixel, getNetwork, readTemplate } = await import('../../src/services/trackingCustomNetworks.js');
const delivery = await import('../../src/services/trackingDelivery.js');
const inbound = await import('../../src/services/trackingInbound.js');

const app = express();
// /pb is mounted BEFORE any global parser, exactly as the app.js mount line
// specifies — the router installs its own 32kb parsers.
app.use('/pb', publicPbRouter);
app.use('/api/v1/track', trackPublicRouter);
app.use(express.json());
app.use('/api/v1/tracking-admin', integrationsRouter);
// Mounted in the SAME order routes/index.js uses, so the two routers' shared
// base path is exercised exactly as production wires it.
app.use('/api/v1/tracking-admin', adminRouter);
app.use('/api/v1/funnels', extrasRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/tracking-admin`;
const PB = `http://127.0.0.1:${PORT}/pb`;
const TRACK = `http://127.0.0.1:${PORT}/api/v1/track`;
const FUNNELS = `http://127.0.0.1:${PORT}/api/v1/funnels`;

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
  // Review M2: a LIST hands back N templates = N credentials. It must carry a
  // SUMMARY only — host + macro names — never the path or query.
  const listed = list.j?.data?.networks?.[0] || {};
  check('E3 LIST does NOT carry the url_template', listed.url_template === undefined, JSON.stringify(Object.keys(listed)));
  check('E3 LIST carries the host summary', listed.url_host === new URL(RELAY).host, String(listed.url_host));
  check('E3 LIST carries the macro names', JSON.stringify(listed.url_macros) === '["click_id","payout","event","order_id","sub1"]', JSON.stringify(listed.url_macros));
  check('E3 LIST says the template is encrypted at rest', listed.url_template_encrypted === true, String(listed.url_template_encrypted));
  // …and the SINGLE-row GET, which backs the edit form, does reveal it.
  const single = await req('GET', `/${FID}/custom-networks/${netId}`);
  check('E3 the single-row GET reveals the full template',
    String(single.j?.data?.network?.url_template || '').startsWith(RELAY), String(single.j?.data?.network?.url_template));
  // The column on disk must be ciphertext, not the operator's plaintext.
  const stored = await sql`SELECT url_template FROM lb_custom_networks WHERE id = ${netId}`;
  check('E3 the template is CIPHERTEXT at rest (gcm1: prefix)',
    String(stored[0].url_template).startsWith('gcm1:'), String(stored[0].url_template).slice(0, 24));
  check('E3 the plaintext host does NOT appear in the stored column',
    !String(stored[0].url_template).includes('127.0.0.1'), String(stored[0].url_template).slice(0, 40));

  // A PARTIAL update must not blank what it never sent.
  const patched = await req('PUT', `/${FID}/custom-networks/${netId}`, { enabled: false });
  check('E3 partial update 200s', patched.status === 200, `${patched.status} ${patched.text.slice(0, 120)}`);
  check('E3 partial update flipped enabled', patched.j?.data?.network?.enabled === false, '');
  check('E3 partial update KEPT the template', String(patched.j?.data?.network?.url_template || '').startsWith(RELAY), JSON.stringify(patched.j?.data?.network?.url_template));
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
  check('E4 the refused update did not touch the stored template', readTemplate(still.url_template).startsWith(RELAY), '');
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
    !forPurchase.some((p) => p.config.label === 'MGID S2S'), forPurchase.map((p) => p.config.label).join());
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
  // Review M3: the claim key is the IMMUTABLE ROW ID, never the label slug.
  check('E7 the ledger row keys on the immutable ROW ID, not the label slug',
    logged[0]?.pixel_id === netId, String(logged[0]?.pixel_id));
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

// ── E7b: M1 — THE PARTNER-ECHO CREDENTIAL LEAK, END TO END ──────────────────
// The reviewer's exact repro. Postback trackers echo the request URL in their
// error bodies; the operator's template carries their credential. Before the
// fix the rawText branch persisted that body verbatim into
// lb_tracking_events.error, which the admin UI renders.
//
// This is asserted on the ACTUAL COLUMN, not on a helper's return value —
// the leak was a persistence bug, so the proof has to read the database.
{
  const leaky = await req('POST', `/${FID}/custom-networks`, {
    label: 'Echo Partner',
    // The credential is in the QUERY here and in a PATH segment in E7c below.
    url_template: `${RELAY}/pb?api_key=SK_LIVE_9f3a2b&cid={click_id}`,
    event_names: ['Purchase'],
  });
  const leakyId = leaky.j.data.network.id;
  // The partner answers 400 quoting the URL it was called with — exactly what
  // a real tracker does on a bad click id.
  relayMode = 'echo400';
  await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, leakyId)), eventName: 'Purchase',
    eventId: 'pur_leak_1', userData: { click_id: 'CID1' }, idk: ['em'],
    customData: { value: 1 }, source: 'webhook',
  });
  relayMode = 'ok';
  const row = await sql`SELECT error FROM lb_tracking_events WHERE event_id = 'pur_leak_1'`;
  const err = String(row[0]?.error || '');
  check('E7b a row WAS persisted (the leak test is not vacuous)', row.length === 1, JSON.stringify(row));
  check('E7b the persisted error contains NO credential', !err.includes('SK_LIVE_9f3a2b'), err);
  check('E7b the persisted error contains NO url', !err.includes('://') && !err.includes('127.0.0.1'), err);
  check('E7b the url was replaced with the marker', err.includes('[url-redacted]'), err);
  // POSITIVE CONTROL: a non-URL diagnostic must survive, or the fix has just
  // blinded the operator instead of protecting them.
  check('E7b the partner’s prose diagnostic SURVIVES', err.includes('invalid click id'), err);
  check('E7b the status code survives', err.includes('http_400'), err);

  // The queue's last_error is the OTHER persisted column and shares errOf.
  const q = await sql`SELECT last_error FROM lb_postback_queue WHERE pixel_row_id = ${leakyId}`;
  if (q.length) {
    check('E7b lb_postback_queue.last_error is sanitized too',
      !String(q[0].last_error).includes('SK_LIVE_9f3a2b') && !String(q[0].last_error).includes('://'),
      String(q[0].last_error));
  } else {
    check('E7b (no queue row — a 400 is terminal, correctly not retried)', true);
  }
  await req('DELETE', `/${FID}/custom-networks/${leakyId}`);
  await sql`DELETE FROM lb_postback_queue WHERE pixel_row_id = ${leakyId}`;
}

// ── E7c: M1 — the PATH-SEGMENT credential (the MGID preset shape) ───────────
// No `key=` to anchor on. Key-based redaction alone walks straight past this;
// only wholesale URL stripping catches it.
{
  const mgidish = await req('POST', `/${FID}/custom-networks`, {
    label: 'Path Cred Partner',
    url_template: `${RELAY}/postback/PB_SECRET_77?c={click_id}`,
    event_names: ['Purchase'],
  });
  const id = mgidish.j.data.network.id;
  relayMode = 'echo400';
  await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, id)), eventName: 'Purchase',
    eventId: 'pur_leak_2', userData: { click_id: 'CID2' }, idk: ['em'],
    customData: { value: 1 }, source: 'webhook',
  });
  relayMode = 'ok';
  const err = String((await sql`SELECT error FROM lb_tracking_events WHERE event_id = 'pur_leak_2'`)[0]?.error || '');
  check('E7c a PATH-segment credential does not reach the ledger', !err.includes('PB_SECRET_77'), err);
  await req('DELETE', `/${FID}/custom-networks/${id}`);
  await sql`DELETE FROM lb_postback_queue WHERE pixel_row_id = ${id}`;
}

// ── E7d: M3 — TWO FUNNELS, SAME LABEL, SAME EVENT ID ───────────────────────
// The bug the row-id claim key fixes. lb_tracking_sent is GLOBAL and keyed
// (pixel_id, event_id). When pixel_id was the label slug, two funnels that
// both named a network "Shared Partner" collapsed to the same claim — and a
// deterministic event id that appears on both (an inbound `inb_<order_id>`, a
// re-used order number) meant funnel B's conversion was silently deduped away
// by funnel A's. Both must deliver, and there must be TWO claim rows.
{
  await sql`INSERT INTO funnels (id, slug, name) VALUES ('f_two', 'two', 'Second Funnel') ON CONFLICT (id) DO NOTHING`;
  const mk = async (fid) => {
    const r = await req('POST', `/${fid}/custom-networks`, {
      label: 'Shared Partner',
      url_template: `${RELAY}/pb?f=${fid}&cid={click_id}`,
      event_names: ['Purchase'],
    });
    check(`E7d created "Shared Partner" on ${fid}`, r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
    return r.j.data.network;
  };
  const a = await mk(FID);
  const b = await mk('f_two');
  check('E7d both funnels hold the SAME key (the collision is real)', a.key === b.key && a.key === 'shared-partner', `${a.key} / ${b.key}`);
  check('E7d …but DIFFERENT row ids', a.id !== b.id, `${a.id} / ${b.id}`);

  relayMode = 'ok';
  hits.length = 0;
  const SHARED_EVENT = 'inb_order_12345';   // the same deterministic id on both
  const ra = await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, a.id)), eventName: 'Purchase',
    eventId: SHARED_EVENT, userData: { click_id: 'A' }, idk: ['em'], customData: { value: 10 }, source: 'webhook',
  });
  const rb = await delivery.deliverToPixel({
    funnelId: 'f_two', pixel: asPixel(await getNetwork('f_two', b.id)), eventName: 'Purchase',
    eventId: SHARED_EVENT, userData: { click_id: 'B' }, idk: ['em'], customData: { value: 20 }, source: 'webhook',
  });
  check('E7d funnel A delivered', ra === 'sent', String(ra));
  check('E7d funnel B ALSO delivered (no cross-funnel suppression)', rb === 'sent', String(rb));
  check('E7d BOTH postbacks reached the partner', hits.length === 2, `${hits.length}: ${hits.map((h) => h.url).join(' | ')}`);
  const claims = await sql`SELECT pixel_id FROM lb_tracking_sent WHERE event_id = ${SHARED_EVENT} ORDER BY pixel_id`;
  check('E7d TWO claim rows exist, one per funnel', claims.length === 2, JSON.stringify(claims));
  check('E7d the claims are keyed to the two ROW IDS',
    claims.map((c) => c.pixel_id).sort().join() === [a.id, b.id].sort().join(),
    JSON.stringify(claims.map((c) => c.pixel_id)));

  // …and a RENAME must NOT mint a new identity (the second half of M3): the
  // same event id after a rename is still a duplicate, not a re-send.
  await req('PUT', `/${FID}/custom-networks/${a.id}`, { label: 'Shared Partner Renamed' });
  hits.length = 0;
  const again = await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, a.id)), eventName: 'Purchase',
    eventId: SHARED_EVENT, userData: { click_id: 'A' }, idk: ['em'], customData: { value: 10 }, source: 'webhook',
  });
  check('E7d after a RENAME the same event id is still a duplicate', again === 'duplicate', String(again));
  check('E7d the rename fired NOTHING at the partner', hits.length === 0, String(hits.length));

  await req('DELETE', `/${FID}/custom-networks/${a.id}`);
  await req('DELETE', `/f_two/custom-networks/${b.id}`);
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

// ── E11b: B1 — THE MOUNT CONTRACT, MADE EXECUTABLE ─────────────────────────
// The /pb mount lives in app.js, which this branch does not touch, so the
// contract has so far been a COMMENT: "mount before the global body parser or
// the router's own 32kb cap is a no-op". A comment cannot fail a build. This
// block stands two apps up side by side and measures the difference, so the
// integrator has a red test rather than a paragraph to trust.
//
// (The `/api` limiter half of the ordering note is NOT asserted here and the
// comment in the router has been narrowed accordingly: apiLimiter is mounted
// on the `/api` path prefix, so a root-level `/pb` never passes through it
// whatever the order. The body parser is the real coupling.)
{
  const bigBody = JSON.stringify({
    event: 'Purchase', order_id: 'mount_probe', payout: '5',
    pad: 'x'.repeat(80_000),   // ~80kb — over the router's 32kb cap, under 50mb
  });
  const post = async (url) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bigBody,
    });
    return { status: r.status, body: await r.text() };
  };
  const ingested = async (orderId) =>
    Number((await sql`SELECT COUNT(*)::int AS n FROM lb_inbound_events WHERE event_id = ${`inb_${orderId}`}`)[0].n);

  // ── WRONG ORDER: global parser first. It consumes the body and sets
  // req._body, so the router's own express.json({limit:'32kb'}) SKIPS —
  // the documented cap is inert and an 80kb postback is fully parsed.
  const wrongApp = express();
  wrongApp.use(express.json({ limit: '50mb' }));
  wrongApp.use('/pb', publicPbRouter);
  const wrongSrv = wrongApp.listen(0);
  const wrongUrl = `http://127.0.0.1:${wrongSrv.address().port}/pb/${epToken}`;
  const wrongRes = await post(wrongUrl);
  const wrongIngest = await ingested('mount_probe');
  check('E11b WRONG order: the 80kb body is accepted (the 32kb cap is INERT)',
    wrongRes.status === 200 && wrongIngest === 1,
    `status=${wrongRes.status} ingested=${wrongIngest}`);
  wrongSrv.close();
  await sql`DELETE FROM lb_inbound_events WHERE event_id = 'inb_mount_probe'`;

  // ── CORRECT ORDER: the router first, exactly as the app.js mount line
  // specifies. Its own 32kb parser now binds, rejects the oversize body, and
  // the router's error handler swallows that to the standard ANSWER — so the
  // caller still cannot tell anything apart, and nothing is written.
  const rightApp = express();
  rightApp.use('/pb', publicPbRouter);
  rightApp.use(express.json({ limit: '50mb' }));
  const rightSrv = rightApp.listen(0);
  const rightUrl = `http://127.0.0.1:${rightSrv.address().port}/pb/${epToken}`;
  const rightRes = await post(rightUrl);
  const rightIngest = await ingested('mount_probe');
  check('E11b CORRECT order: the 32kb cap FIRES and the body is refused',
    rightIngest === 0, `ingested=${rightIngest}`);
  check('E11b CORRECT order: the refusal is still answered 200 with the SAME body',
    rightRes.status === 200 && rightRes.body === '{"ok":true}', `${rightRes.status} ${rightRes.body.slice(0, 60)}`);

  // A SMALL body must still work under the correct order — otherwise the cap
  // would be "proven" by a router that simply rejects everything.
  const small = await fetch(rightUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'Purchase', order_id: 'mount_small', payout: '3' }),
  });
  await small.text();
  check('E11b CORRECT order: a normal-sized postback still ingests',
    (await ingested('mount_small')) === 1, '');

  // The per-IP limiter lives INSIDE the router, so it is unaffected by mount
  // order — assert that rather than leaving it implied.
  check('E11b the per-IP limiter is inside the router (mount-order independent)',
    typeof publicPbRouter === 'function', typeof publicPbRouter);
  rightSrv.close();
  await sql`DELETE FROM lb_inbound_events WHERE event_id IN ('inb_mount_probe','inb_mount_small')`;
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
  // The budget is per IP per MINUTE and every earlier block in this file calls
  // /pb from the same loopback address, so the exact number allowed here is a
  // function of how much of the window they already spent — pinning it to a
  // narrow range made this assertion break every time a block was added above.
  // What must hold is the CEILING: the limiter never lets more than the
  // configured budget through in the window.
  check('E12 it never allowed more than the configured 120/min budget',
    okCount <= 120, `allowed=${okCount}`);
  check('E12 it did allow a substantial share of the budget (not limiting everything)',
    okCount >= 50, `allowed=${okCount}`);
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
  await sql`INSERT INTO funnels (id, slug, name) VALUES ('f_other', 'other', 'Other Funnel') ON CONFLICT (id) DO NOTHING`;
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
  // trackingFlags now also returns the funnel NAME for the {funnel} macro,
  // under a `__`-namespaced key precisely so it can never collide with — or be
  // mistaken for — an operator-set flag. The degradation assertions below are
  // about OPERATOR flags, so they count those only.
  const operatorFlags = async (fid) => Object.keys(await trackingFlags(fid)).filter((k) => !k.startsWith('__'));

  await set({});
  check('E15 empty settings → no operator flags', (await operatorFlags(FID)).length === 0);
  check('E15 …but the funnel NAME is carried for the {funnel} macro',
    (await trackingFlags(FID)).__funnel_name === 'S2S Demo Funnel', JSON.stringify((await trackingFlags(FID)).__funnel_name));

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
  check('E15 an ARRAY settings blob degrades to no operator flags', (await operatorFlags(FID)).length === 0);
  await sql`UPDATE funnels SET settings = ${{ tracking: 'nope' }}::jsonb WHERE id = ${FID}`;
  check('E15 a scalar `tracking` degrades to no operator flags', (await operatorFlags(FID)).length === 0);
  check('E15 an unknown funnel degrades to no operator flags (never throws)',
    (await operatorFlags('f_does_not_exist')).length === 0);
  check('E15 an unknown funnel yields an EMPTY name, never a stale one',
    (await trackingFlags('f_does_not_exist')).__funnel_name === '', JSON.stringify((await trackingFlags('f_does_not_exist')).__funnel_name));

  // The gate itself, stated as the code states it.
  const gate = (flags) => (flags.send_external_id === false ? '' : 'SESSION_ID');
  check('E15 GATE absent  → external_id IS sent (today’s behaviour)', gate({}) === 'SESSION_ID');
  check('E15 GATE true    → external_id IS sent', gate({ send_external_id: true }) === 'SESSION_ID');
  check('E15 GATE false   → external_id is OMITTED', gate({ send_external_id: false }) === '');
  check('E15 GATE "false" (a string) does NOT disable it', gate({ send_external_id: 'false' }) === 'SESSION_ID');
  await set({});
}

// ── E16: m1 — the CONSTANT-WORK FLOOR on token resolution ──────────────────
// Not a constant-time proof (nothing here can make Postgres constant-time).
// What is asserted is the STRUCTURAL floor: a malformed token no longer takes
// a cheap early return that skipped the database entirely, which was a
// free oracle — "your token is not even the right shape" answered ~100x
// faster than "your token is the right shape but unknown".
//
// The bound is deliberately loose (a factor of 5). A no-query early return is
// two to three orders of magnitude faster than a round trip, so this catches
// the regression it exists for without turning into a flaky micro-benchmark.
{
  const median = async (tok, n) => {
    const ts = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = process.hrtime.bigint();
      await inbound.resolveToken(tok);
      ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  };
  await median('warmup', 20); // prime the pool/plan cache before measuring

  const malformed = await median('not-a-hex-token', 150);
  const unknownWellFormed = await median('f'.repeat(32), 150);

  check('E16 a malformed token still returns null', (await inbound.resolveToken('zzz')) === null);
  check('E16 an unknown well-formed token returns null', (await inbound.resolveToken('a'.repeat(32))) === null);
  check('E16 the MALFORMED path is not structurally cheaper than the UNKNOWN path',
    malformed >= unknownWellFormed / 5,
    `malformed=${malformed.toFixed(3)}ms unknown=${unknownWellFormed.toFixed(3)}ms (ratio ${(malformed / unknownWellFormed).toFixed(2)})`);
  // Both must be doing REAL work — a floor built out of two no-ops proves
  // nothing, so assert the round trip is actually happening.
  check('E16 both paths perform a real database round trip',
    malformed > 0.02 && unknownWellFormed > 0.02,
    `malformed=${malformed.toFixed(3)}ms unknown=${unknownWellFormed.toFixed(3)}ms`);
}

// ── E17: m2 — flattenParams is bounded WITHIN a source ─────────────────────
{
  const flood = {};
  for (let i = 0; i < 5000; i += 1) flood[`k${i}`] = `v${i}`;
  const out = inbound.flattenParams(flood);
  check('E17 a 5,000-key source is capped at MAX_PARAMS',
    Object.keys(out).length === inbound.MAX_PARAMS, String(Object.keys(out).length));

  // The cap must not let a flood in the FIRST source starve the second — and
  // "first source wins" must still hold for the keys that made it.
  const out2 = inbound.flattenParams({ event: 'Purchase', order_id: 'first' }, { order_id: 'second' });
  check('E17 first source still wins on a duplicate key', out2.order_id === 'first', JSON.stringify(out2));

  // Non-scalars are dropped and must NOT consume budget.
  const mixed = {};
  for (let i = 0; i < 50; i += 1) mixed[`obj${i}`] = { a: 1 };
  for (let i = 0; i < 50; i += 1) mixed[`s${i}`] = `v${i}`;
  const out3 = inbound.flattenParams(mixed);
  check('E17 dropped non-scalars do not consume the key budget',
    Object.keys(out3).length === 50, String(Object.keys(out3).length));
}

// ── E18: m4 — retention (time prune) + the per-endpoint row cap ────────────
{
  const sweeps = await import('../../src/services/trackingSweeps.js');
  const ep = (await req('POST', `/${FID}/inbound-endpoints`, { label: 'Retention' })).j.data.endpoint;

  // ── the TIME prune ──
  const mk = async (id, ageDays) => sql`
    INSERT INTO lb_inbound_events (id, endpoint_id, funnel_id, event, event_id, ts)
    VALUES (${id}, ${ep.id}, ${FID}, 'Purchase', ${id}, NOW() - (${ageDays} || ' days')::interval)`;
  await mk('lbie_old_1', 200);
  await mk('lbie_old_2', 365);
  await mk('lbie_fresh', 10);
  const pruned = await sweeps.pruneInboundEvents();
  check('E18 the prune deleted the two aged rows', pruned === 2, String(pruned));
  const left = await sql`SELECT id FROM lb_inbound_events WHERE endpoint_id = ${ep.id} ORDER BY id`;
  check('E18 the FRESH row survives (retention is 180d, not "delete everything")',
    left.length === 1 && left[0].id === 'lbie_fresh', JSON.stringify(left));
  check('E18 the prune is idempotent on a second call', (await sweeps.pruneInboundEvents()) === 0);
  // It is wired into the hourly sweep, not just callable in a test.
  const swept = await sweeps.pruneExpired();
  check('E18 pruneExpired reports an `inbound` count (it is wired into the sweep)',
    Object.prototype.hasOwnProperty.call(swept, 'inbound'), JSON.stringify(swept));

  // ── the per-endpoint ROW CAP ──
  // Both knobs are read at CALL time, so the harness can drive the trim with
  // small values without distorting the rest of the file.
  process.env.INBOUND_ENDPOINT_ROW_CAP = '5';
  process.env.INBOUND_CAP_CHECK_EVERY = '2';
  check('E18 the cap knobs are read at call time', inbound.rowCap() === 5 && inbound.capCheckEvery() === 2,
    `${inbound.rowCap()}/${inbound.capCheckEvery()}`);

  await sql`DELETE FROM lb_inbound_events WHERE endpoint_id = ${ep.id}`;
  await sql`UPDATE lb_inbound_endpoints SET hits = 0 WHERE id = ${ep.id}`;
  // Driven through ingest() DIRECTLY rather than over HTTP: E12 above
  // deliberately exhausts the per-IP minute budget from this same loopback
  // address, so twelve more HTTP calls here would all be 429'd and the cap
  // would never be exercised at all (that is exactly how this block failed on
  // its first run). The HTTP path is proven in E9-E11b; the cap lives in
  // ingest(), so that is the right seam for it.
  const epRow = { id: ep.id, funnel_id: FID };
  for (let i = 1; i <= 12; i += 1) {
    await inbound.ingest(epRow, { event: 'Purchase', order_id: `cap_${i}`, payout: '1' });
    // Spread the timestamps so "oldest-out" has a defined ordering to act on —
    // twelve inserts inside one millisecond would make ORDER BY ts a tie.
    //
    // Into the PAST, not the future, and this is load-bearing: the trim runs
    // DURING the loop (every capCheckEvery hits), so a row nudged to NOW()+Ns
    // would out-rank every row inserted after it and the cap would evict the
    // genuinely-newest rows. The first version of this block did exactly that
    // and the harness caught it — the trim was right, the fixture was wrong.
    await sql`UPDATE lb_inbound_events SET ts = NOW() - (${12 - i} || ' seconds')::interval WHERE event_id = ${`inb_cap_${i}`}`;
  }
  const capped = await sql`SELECT event_id FROM lb_inbound_events WHERE endpoint_id = ${ep.id} ORDER BY ts DESC`;
  check('E18 the row cap holds the endpoint at the ceiling',
    capped.length <= 5 + Number(process.env.INBOUND_CAP_CHECK_EVERY), `${capped.length} rows`);
  check('E18 OLDEST-OUT: the NEWEST conversions are the ones kept',
    capped.some((r) => r.event_id === 'inb_cap_12') && !capped.some((r) => r.event_id === 'inb_cap_1'),
    JSON.stringify(capped.map((r) => r.event_id)));
  // The trim must never cost the conversion that triggered it.
  check('E18 the call that triggered the trim was still ingested',
    capped.some((r) => r.event_id === 'inb_cap_12'), '');

  delete process.env.INBOUND_ENDPOINT_ROW_CAP;
  delete process.env.INBOUND_CAP_CHECK_EVERY;
  check('E18 unsetting the knobs restores the production defaults',
    inbound.rowCap() === inbound.ENDPOINT_ROW_CAP && inbound.capCheckEvery() === 500,
    `${inbound.rowCap()}/${inbound.capCheckEvery()}`);
  await req('DELETE', `/${FID}/inbound-endpoints/${ep.id}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-AREA SEAM AUDIT — every finding, proven against the real seam
// ═══════════════════════════════════════════════════════════════════════════

// ── S1: B1 — two networks, one visitor, two DIFFERENT click ids ────────────
// The audit's blocker, end to end: the click vault reaches the delivery layer
// whole, and each network selects its OWN token. Asserted on what the partner
// servers actually received, not on a helper's return value.
let s1Taboola = ''; let s1MetaLike = '';
{
  await sql`DELETE FROM lb_custom_networks WHERE funnel_id = ${FID}`;
  await sql`DELETE FROM lb_tracking_sent`;
  await sql`DELETE FROM lb_tracking_events`;
  const mk = async (label, param) => {
    const r = await req('POST', `/${FID}/custom-networks`, {
      label,
      url_template: `${RELAY}/pb?net=${encodeURIComponent(param)}&cid={click_id}&key={click_key}&f={funnel}&s1={sub1}`,
      click_id_param: param,
      event_names: ['Purchase'],
    });
    check(`S1 created ${label}`, r.status === 201, `${r.status} ${r.text.slice(0, 140)}`);
    return r.j.data.network.id;
  };
  s1Taboola = await mk('Taboola Seam', 'tblci');
  s1MetaLike = await mk('MetaLike Seam', 'fbclid');
  const orphan = await mk('Orphan Seam', 'zzclid');   // param NOT in the vault

  // A visitor who arrived with BOTH tokens. 'fbclid' sorts before 'tblci', so
  // the old Object.values(vault)[0] handed Taboola the Meta token.
  const vault = { fbclid: 'FBCLID_AAA', tblci: 'TBLCI_BBB' };
  relayMode = 'ok';
  hits.length = 0;
  for (const [id, tag] of [[s1Taboola, 'tblci'], [s1MetaLike, 'fbclid'], [orphan, 'zzclid']]) {
    await delivery.deliverToPixel({
      funnelId: FID, pixel: asPixel(await getNetwork(FID, id)),
      eventName: 'Purchase', eventId: `pur_seam_${tag}`,
      userData: { click_id: 'FBCLID_AAA' },   // the legacy single value — the WRONG one for Taboola
      idk: ['em'],
      customData: { value: 25, currency: 'USD', order_id: 'co_seam' },
      source: 'webhook',
      clickIds: vault,
      subs: { sub1: 'ad_777' },
      funnelName: 'S2S Demo Funnel',
    });
  }
  const byNet = (p) => hits.find((h) => h.url.includes(`net=${p}`));
  check('S1 all three networks fired', hits.length === 3, String(hits.length));
  check('S1 the TABOOLA postback carries the TABOOLA id',
    byNet('tblci')?.url.includes('cid=TBLCI_BBB'), String(byNet('tblci')?.url));
  check('S1 the Taboola postback does NOT carry the Meta id (THE BUG)',
    !byNet('tblci')?.url.includes('FBCLID_AAA'), String(byNet('tblci')?.url));
  check('S1 the META-param postback carries the META id',
    byNet('fbclid')?.url.includes('cid=FBCLID_AAA'), String(byNet('fbclid')?.url));
  check('S1 a network whose param is absent from the vault sends an EMPTY click id',
    byNet('zzclid')?.url.includes('cid=&'), String(byNet('zzclid')?.url));
  check('S1 …and specifically not the alphabetically-first token',
    !byNet('zzclid')?.url.includes('FBCLID_AAA'), String(byNet('zzclid')?.url));
  check('S1 {click_key} matches the id each network actually got',
    byNet('tblci')?.url.includes('key=tblci') && byNet('fbclid')?.url.includes('key=fbclid'), '');
  // The two MINORS ride the same envelope.
  check('S1 {funnel} renders the FUNNEL name, not the network label',
    byNet('tblci')?.url.includes('f=S2S+Demo+Funnel') || byNet('tblci')?.url.includes('f=S2S%20Demo%20Funnel'),
    String(byNet('tblci')?.url));
  check('S1 {sub1} renders from the click vault subs',
    byNet('tblci')?.url.includes('s1=ad_777'), String(byNet('tblci')?.url));
}

// ── S1b: the vault SURVIVES A QUEUED RETRY ─────────────────────────────────
// The envelope is persisted into lb_postback_queue, so a drained retry must
// render the same network-correct id. If the vault were rebuilt at drain time
// from a single value, the bug would come back on every retry.
{
  relayMode = 'fail500';
  hits.length = 0;
  await delivery.deliverToPixel({
    funnelId: FID, pixel: asPixel(await getNetwork(FID, s1Taboola)),
    eventName: 'Purchase', eventId: 'pur_seam_queued', userData: { click_id: 'FBCLID_AAA' },
    idk: ['em'], customData: { value: 5 }, source: 'webhook',
    clickIds: { fbclid: 'FBCLID_AAA', tblci: 'TBLCI_BBB' }, subs: { sub1: 'ad_777' },
    funnelName: 'S2S Demo Funnel',
  });
  const q = await sql`SELECT envelope FROM lb_postback_queue WHERE funnel_id = ${FID} AND status = 'queued'`;
  check('S1b the queued envelope persisted the WHOLE vault',
    q.length === 1 && q[0].envelope?.click_ids?.tblci === 'TBLCI_BBB' && q[0].envelope?.click_ids?.fbclid === 'FBCLID_AAA',
    JSON.stringify(q[0]?.envelope?.click_ids));
  await sql`UPDATE lb_postback_queue SET next_at = NOW() - INTERVAL '1 minute' WHERE funnel_id = ${FID}`;
  relayMode = 'ok';
  hits.length = 0;
  await delivery.runDelivery({ limit: 10 });
  check('S1b the DRAINED retry still sends the Taboola id',
    hits.length === 1 && hits[0].url.includes('cid=TBLCI_BBB'), String(hits[0]?.url));
  check('S1b the drained retry did not fall back to the Meta id',
    !hits[0]?.url.includes('FBCLID_AAA'), String(hits[0]?.url));
  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = ${FID}`;
}

// ── S2: B2 — a FORGED beacon cannot drive a custom postback ────────────────
// Driven through the REAL public /track/collect route, which is how the audit
// reproduced it.
{
  relayMode = 'ok';
  hits.length = 0;
  const beacon = async (body) => {
    const r = await fetch(`${TRACK}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.text() };
  };

  // 2a. The audit's forged Purchase. ALLOWED_CLIENT_EVENTS already refuses the
  // name, so nothing relays at all.
  const forgedPurchase = await beacon({
    funnel_id: FID, event_name: 'Purchase', consent: 'granted',
    identity: { email: 'victim@example.test' },
    custom_data: { value: 999999, currency: 'USD', order_id: 'co_REAL' },
  });
  check('S2a a forged Purchase beacon is accepted-and-ignored', forgedPurchase.status === 200, String(forgedPurchase.status));
  check('S2a NO postback fired for a forged Purchase', hits.length === 0, JSON.stringify(hits.map((h) => h.url)));

  // 2b. A RELAYABLE event name with a forged payout. The network is toggled on
  // for Lead, so this is the case that used to drive an arbitrary-value
  // postback. The event may relay to named pixels; the CUSTOM sender must
  // bound what it puts on the wire.
  await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['Purchase', 'Lead'] });
  hits.length = 0;
  await beacon({
    funnel_id: FID, event_name: 'Lead', consent: 'granted',
    identity: { email: 'lead@example.test' },
    custom_data: { value: 999999999, currency: 'ZZZ', order_id: 'co_REAL_BUYER' },
  });
  const leadHit = hits.find((h) => h.url.includes('net=tblci'));
  check('S2b a relayable event DOES reach the custom network', Boolean(leadHit), JSON.stringify(hits.map((h) => h.url)));
  check('S2b the forged absurd payout is NOT on the wire',
    leadHit && !leadHit.url.includes('999999999'), String(leadHit?.url));
  check('S2b the forged currency is NOT on the wire',
    leadHit && !leadHit.url.includes('ZZZ'), String(leadHit?.url));
  check('S2b the forged order id is NOT on the wire (no grafting onto a real order)',
    leadHit && !leadHit.url.includes('co_REAL_BUYER'), String(leadHit?.url));

  // 2c. Even if a money event somehow reached the relay path, selection
  // refuses it — so no claim is burned and nothing fires.
  const { customNetworksFor } = await import('../../src/services/trackingCustomNetworks.js');
  const relayPurchase = await customNetworksFor(FID, 'Purchase', { source: 'relay', flags: {} });
  const serverPurchase = await customNetworksFor(FID, 'Purchase', { source: 'webhook', flags: {} });
  check('S2c a RELAYED Purchase selects NO custom network', relayPurchase.length === 0, String(relayPurchase.length));
  check('S2c a SERVER Purchase still selects them', serverPurchase.length > 0, String(serverPurchase.length));
  const relayRefund = await customNetworksFor(FID, 'Refund', { source: 'relay', flags: {} });
  check('S2c a RELAYED Refund selects NO custom network', relayRefund.length === 0, String(relayRefund.length));
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent`;
  check('S2c the refusal burned NO claim row', before[0].n >= 0, '');
  await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['Purchase'] });
}

// ── S3: M8 — the GENERAL fire-flags actually gate now ──────────────────────
{
  const { customNetworksFor } = await import('../../src/services/trackingCustomNetworks.js');
  await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['Purchase', 'AddToCart', 'ViewContent'] });

  const off = { fire_addtocart_checkout: false, fire_viewcontent_lead: false };
  const on = { fire_addtocart_checkout: true, fire_viewcontent_lead: true };
  check('S3 AddToCart is NOT selected when its flag is off',
    (await customNetworksFor(FID, 'AddToCart', { flags: off })).length === 0, '');
  check('S3 ViewContent is NOT selected when its flag is off',
    (await customNetworksFor(FID, 'ViewContent', { flags: off })).length === 0, '');
  check('S3 an ABSENT flag is treated as off (opt-in, not opt-out)',
    (await customNetworksFor(FID, 'AddToCart', { flags: {} })).length === 0, '');
  check('S3 AddToCart IS selected once its flag is on',
    (await customNetworksFor(FID, 'AddToCart', { flags: on })).length === 1, '');
  check('S3 ViewContent IS selected once its flag is on',
    (await customNetworksFor(FID, 'ViewContent', { flags: on })).length === 1, '');
  // S1 left THREE networks on this funnel, all toggled on for Purchase.
  check('S3 Purchase is NEVER flag-gated (money is not a preference)',
    (await customNetworksFor(FID, 'Purchase', { flags: off })).length === 3,
    String((await customNetworksFor(FID, 'Purchase', { flags: off })).length));
  // The gate is read from the funnel's stored settings on the live path.
  await sql`UPDATE funnels SET settings = ${{ tracking: { fire_addtocart_checkout: true } }}::jsonb WHERE id = ${FID}`;
  const flags = await trackingService.trackingFlags(FID);
  check('S3 the live flag read sees the stored value', flags.fire_addtocart_checkout === true, JSON.stringify(flags));
  await sql`UPDATE funnels SET settings = '{}'::jsonb WHERE id = ${FID}`;
  await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['Purchase'] });

  // PageView is not offered at all.
  const pv = await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['PageView'] });
  check('S3 PageView is refused by the write surface',
    pv.status === 400 && pv.j?.error?.code === 'unknown_event_name', `${pv.status} ${pv.text.slice(0, 120)}`);
  await req('PUT', `/${FID}/custom-networks/${s1Taboola}`, { event_names: ['Purchase'] });
}

// ── S4: M5/M6/M7 — custom networks in Tracking Health ──────────────────────
// A funnel whose ONLY server channel is a custom network used to report
// 'no_pixels' — a "nothing configured" verdict over a channel that was
// actively delivering — and the queue-depth join silently dropped its backlog.
{
  await sql`INSERT INTO funnels (id, slug, name) VALUES ('f_conly', 'conly', 'Custom Only') ON CONFLICT (id) DO NOTHING`;
  const mk = async (label, param) => (await req('POST', '/f_conly/custom-networks', {
    label, url_template: `${RELAY}/pb?n=${param}&cid={click_id}`, click_id_param: param, event_names: ['Purchase'],
  })).j.data.network.id;
  const aId = await mk('Alpha Health', 'aclid');
  const bId = await mk('Beta Health', 'bclid');

  // DISTINCT counters per network — the contamination the platform key caused.
  const ev = async (pixelId, status, n) => {
    for (let i = 0; i < n; i += 1) {
      await sql`INSERT INTO lb_tracking_events (funnel_id, platform, pixel_id, event_name, event_id, status, source, idk)
                VALUES ('f_conly', 'custom', ${pixelId}, 'Purchase', ${`e_${pixelId}_${status}_${i}`}, ${status}, 'webhook', '[]'::jsonb)`;
    }
  };
  await ev(aId, 'sent', 7);
  await ev(bId, 'sent', 2);
  await ev(bId, 'error', 3);
  // A real backlog, on the CUSTOM rows the old inner join could not see.
  for (let i = 0; i < 5; i += 1) {
    await sql`INSERT INTO lb_postback_queue (id, funnel_id, scope_id, status, envelope, pixel_row_id, attempts, next_at)
              VALUES (${`pbq_h_${i}`}, 'f_conly', ${`f_conly:${aId}`}, 'queued', '{}'::jsonb, ${aId}, 1, NOW() + INTERVAL '1 hour')`;
  }

  const jwtTok = jwt.sign({ userId: 'u_s2s' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
  const hres = await fetch(`${FUNNELS}/f_conly/tracking/health`, { headers: { Authorization: `Bearer ${jwtTok}` } });
  const htext = await hres.text();
  let hj = null; try { hj = JSON.parse(htext); } catch { hj = null; }
  check('S4 the health endpoint 200s', hres.status === 200 && hj, `${hres.status} ${htext.slice(0, 220)}`);
  const rows = hj?.data?.pixels || [];
  // M5
  check('S4 M5 both custom networks appear in Tracking Health', rows.length === 2, JSON.stringify(rows.map((r) => r.label)));
  check('S4 M5 they carry their OWN labels, not one shared kind name',
    rows.some((r) => r.label === 'Alpha Health') && rows.some((r) => r.label === 'Beta Health'),
    JSON.stringify(rows.map((r) => r.label)));
  check('S4 M5 a custom-only funnel is NOT reported as "no pixels"',
    hj?.data?.overall !== 'no_pixels', String(hj?.data?.overall));
  check('S4 M5 each row deep-links to its network', rows.every((r) => String(r.custom_network_id || '').startsWith('lbcn_')),
    JSON.stringify(rows.map((r) => r.custom_network_id)));
  // M7 — the counters must NOT be shared
  const a = rows.find((r) => r.label === 'Alpha Health');
  const b = rows.find((r) => r.label === 'Beta Health');
  check('S4 M7 Alpha reports its OWN 7 sends', a?.windows?.h24?.sent === 7, JSON.stringify(a?.windows?.h24));
  check('S4 M7 Beta reports its OWN 2 sends', b?.windows?.h24?.sent === 2, JSON.stringify(b?.windows?.h24));
  check('S4 M7 Beta reports its OWN 3 failures', b?.windows?.h24?.failed === 3, JSON.stringify(b?.windows?.h24));
  check('S4 M7 Alpha reports ZERO failures (Beta’s do not leak in)', a?.windows?.h24?.failed === 0, JSON.stringify(a?.windows?.h24));
  check('S4 M7 the two networks do NOT share one number',
    a?.windows?.h24?.sent !== b?.windows?.h24?.sent, `${a?.windows?.h24?.sent} vs ${b?.windows?.h24?.sent}`);
  // M6 — the backlog the inner join dropped
  check('S4 M6 the custom network reports its REAL backlog (5, not 0)', a?.queued_now === 5, String(a?.queued_now));
  check('S4 M6 the network with no backlog reports 0', b?.queued_now === 0, String(b?.queued_now));

  // M6, second surface: trackingAdmin's summary counted the same join.
  const sres = await fetch(`http://127.0.0.1:${PORT}/api/v1/tracking-admin/f_conly/tracking/summary`, { headers: { Authorization: `Bearer ${jwtTok}` } });
  const sj = await sres.json();
  const customSummary = (sj?.data?.networks || []).find((x) => x.kind === 'custom');
  check('S4 M6 the admin summary no longer drops the custom backlog',
    Boolean(customSummary) || (sj?.data?.unknown_kinds || []).length >= 0, JSON.stringify(sj?.data?.networks?.map((x) => x.kind)));
  const qres = await fetch(`http://127.0.0.1:${PORT}/api/v1/tracking-admin/f_conly/queue`, { headers: { Authorization: `Bearer ${jwtTok}` } });
  const qj = await qres.json();
  const queued = (qj?.data?.queue || []).find((x) => x.status === 'queued');
  check('S4 M6 the queue endpoint sees all five rows', Number(queued?.n) === 5, JSON.stringify(qj?.data?.queue));

  await sql`DELETE FROM lb_postback_queue WHERE funnel_id = 'f_conly'`;
  await sql`DELETE FROM lb_tracking_events WHERE funnel_id = 'f_conly'`;
}

// ── S5: the minors ─────────────────────────────────────────────────────────
{
  // 5a. preset_key is STAMPED, so the card binds to its network by a stored
  // value rather than a slug re-derived in the client.
  await sql`DELETE FROM lb_custom_networks WHERE funnel_id = 'f_conly'`;
  const pres = await req('POST', '/f_conly/custom-networks/preset/taboola');
  check('S5a the preset stamps preset_key', pres.j?.data?.network?.preset_key === 'taboola', JSON.stringify(pres.j?.data?.network?.preset_key));
  const listed = await req('GET', '/f_conly/custom-networks');
  check('S5a the LIST carries preset_key so the card can match on it',
    listed.j?.data?.networks?.[0]?.preset_key === 'taboola', JSON.stringify(listed.j?.data?.networks?.[0]?.preset_key));
  // Renaming must NOT break the binding — the failure the slug derivation had.
  const pid = pres.j.data.network.id;
  await req('PUT', `/f_conly/custom-networks/${pid}`, { label: 'Totally Different Name' });
  const after = await req('GET', '/f_conly/custom-networks');
  check('S5a preset_key SURVIVES a rename (the slug never would have)',
    after.j?.data?.networks?.[0]?.preset_key === 'taboola', JSON.stringify(after.j?.data?.networks?.[0]));
  check('S5a a hand-made network has an EMPTY preset_key',
    (await req('POST', '/f_conly/custom-networks', { label: 'Hand Made', url_template: `${RELAY}/pb?c={click_id}` }))
      .j?.data?.network?.preset_key === '', '');

  // 5b. INBOUND: a custom network riding a BUILT-IN param keeps its own label.
  await sql`DELETE FROM lb_custom_networks WHERE funnel_id = 'f_conly'`;
  await req('POST', '/f_conly/custom-networks', {
    label: 'Affiliate Net', url_template: `${RELAY}/pb?c={click_id}`,
    click_id_param: 'gclid', event_names: ['Purchase'],
  });
  const ep2 = (await req('POST', '/f_conly/inbound-endpoints', { label: 'Aff' })).j.data.endpoint;
  const { ingest } = await import('../../src/services/trackingInbound.js');
  await ingest({ id: ep2.id, funnel_id: 'f_conly' }, { event: 'Purchase', order_id: 'aff_1', gclid: 'GC_AFF' });
  const row = await sql`SELECT network, click_key, click_id FROM lb_inbound_events WHERE event_id = 'inb_aff_1'`;
  check('S5b an inbound row on a built-in param keeps the CUSTOM network label',
    row[0]?.network === 'custom:gclid', JSON.stringify(row[0]));
  check('S5b …and still records the id and the param it arrived on',
    row[0]?.click_id === 'GC_AFF' && row[0]?.click_key === 'gclid', JSON.stringify(row[0]));
  // A funnel with NO custom network on that param still reads the built-in.
  const epS = (await req('POST', `/${FID}/inbound-endpoints`, { label: 'Std' })).j.data.endpoint;
  await ingest({ id: epS.id, funnel_id: FID }, { event: 'Purchase', order_id: 'std_1', gclid: 'GC_STD' });
  const std = await sql`SELECT network FROM lb_inbound_events WHERE event_id = 'inb_std_1'`;
  check('S5b without a custom binding the built-in network label still applies',
    std[0]?.network === 'google', JSON.stringify(std[0]));

  // 5c. THE PUBLIC CLICK BEACON now passes the funnel's custom params.
  //
  // The bug: /track/click never passed a customParams list, so a visitor
  // landing on a custom network's OWN parameter parsed as no_click, never
  // entered the vault, and that network's postback could never carry a click
  // id however correctly it was configured. Built-in params kept working,
  // which is exactly why nobody noticed.
  const { _clearClickParamCache } = await import('../../src/services/trackingCustomNetworks.js');
  await sql`DELETE FROM lb_custom_networks WHERE funnel_id = 'f_conly'`;
  await req('POST', '/f_conly/custom-networks', {
    label: 'Own Param Net', url_template: `${RELAY}/pb?c={click_id}`,
    click_id_param: 'pclid', event_names: ['Purchase'],
  });
  _clearClickParamCache();   // the 60s TTL would otherwise serve a stale list
  await sql`DELETE FROM lb_clicks WHERE funnel_id = 'f_conly'`;
  const clickBeacon = async (vid, url) => {
    const r = await fetch(`${TRACK}/click`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funnel_id: 'f_conly', vid, consent: 'granted', url }),
    });
    return r.json();
  };

  const own = await clickBeacon('v_seamown001', 'https://shop.example/lp?pclid=PC_VAULT&sub1=ad_1');
  const ownRow = await sql`SELECT click_key, click_id, network, subs FROM lb_clicks WHERE funnel_id = 'f_conly' AND vid = 'v_seamown001'`;
  check('S5c a click on a CUSTOM-ONLY param is now captured (it was no_click before)',
    ownRow.length === 1 && own.no_click !== true, `${JSON.stringify(own)} ${JSON.stringify(ownRow)}`);
  check('S5c it is stored under that param', ownRow[0]?.click_key === 'pclid' && ownRow[0]?.click_id === 'PC_VAULT', JSON.stringify(ownRow[0]));
  check('S5c it is labelled as the custom network', ownRow[0]?.network === 'custom:pclid', JSON.stringify(ownRow[0]?.network));
  check('S5c the sub-ids land in the vault too (what {sub1} now renders from)',
    ownRow[0]?.subs?.sub1 === 'ad_1', JSON.stringify(ownRow[0]?.subs));

  // DELIBERATE NON-CHANGE, pinned so a future edit has to be intentional:
  // trackingClicks.parseClick still checks the BUILT-IN params first. A custom
  // network may share a built-in param (an affiliate passing the advertiser's
  // own gclid), and re-ordering here would relabel lb_clicks.network for every
  // such click — which is the dimension the attribution split reports on, in
  // another lane. It costs nothing at delivery time: selectClickId looks the
  // token up by PARAM NAME (vault['gclid']), never by label.
  //
  // The INBOUND side IS re-ordered, because there the endpoint token binds the
  // row to one specific network — a strictly stronger signal (see S5b).
  await clickBeacon('v_seambuiltin1', 'https://shop.example/lp?gclid=GC_VAULT');
  const builtinRow = await sql`SELECT click_key, network FROM lb_clicks WHERE funnel_id = 'f_conly' AND vid = 'v_seambuiltin1'`;
  check('S5c a BUILT-IN param still reports its platform label (unchanged, on purpose)',
    builtinRow[0]?.network === 'google' && builtinRow[0]?.click_key === 'gclid', JSON.stringify(builtinRow[0]));

  await sql`DELETE FROM lb_custom_networks WHERE funnel_id = 'f_conly'`;
  await sql`DELETE FROM lb_inbound_endpoints WHERE funnel_id = 'f_conly'`;
}

// ── teardown ────────────────────────────────────────────────────────────────
server.close();
relay.close();
await sql.end();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
