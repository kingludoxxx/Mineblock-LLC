// Route-level verification for FUNNEL EXPORT / IMPORT and SPLIT PROMOTE-WINNER.
//
// The REAL routers (REAL authenticate + requirePermission + ensureTables +
// ensureSplitTables) mounted on a minimal express host, against a fresh
// embedded-PG database — same shape as page-duplicate.mjs.
//
// Asserts BY EXECUTION:
//   EXPORT   — the envelope carries NO row ids, NO domain bindings, and NO
//              credential: a Google Maps key seeded at settings.checkout.
//              maps_api_key (the one real credential that lives in the settings
//              blob — funnelRender.js:2708) does NOT appear anywhere in the
//              serialized envelope, and neither does an unknown-key canary the
//              allowlist has never heard of. exported_at comes from the DB.
//   ROUNDTRIP— export → import reproduces every page's blocks / custom_css /
//              custom_js / head_html / body_end_html EXACTLY, preserves
//              is_home, and mints fresh ids and a fresh slug.
//   REFUSALS — bad format tag 400, over-cap 413 (page count, per-page blocks,
//              total bytes), invalid blocks 422 — each with NOTHING created
//              (funnel + page counts compared either side).
//   ROLLBACK — a failure raised MID-transaction (a trigger firing on the 2nd of
//              3 page inserts) leaves NO funnel and NO pages. This is the real
//              atomicity proof; the validation refusals above only prove the
//              gate ran before the write.
//   WARNINGS — the custom_js warning surfaces on the import response.
//   PROMOTE  — happy path (entry swapped, test paused, /f/<slug>/<handle> still
//              answers 200 and now serves the winner), every refusal, and the
//              replay rule (same arm idempotent, different arm 409).
//
// Run:  node server/tests/funnels/funnel-transfer.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_fnltransfer';
const PORT = 48917;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_fnltransfer`;
await admin`CREATE DATABASE puure_fnltransfer`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
  FUNNEL_PUBLIC_ENABLED: '1', // the public serve surface is flag-gated
});

const { default: express } = await import('express');
const { default: funnelsRoutes } = await import('../../src/routes/funnels.js');
const { default: transferRoutes } = await import('../../src/routes/funnelTransfer.js');
const { default: splitRoutes } = await import('../../src/routes/splitTests.js');
const { default: publicRoutes } = await import('../../src/routes/funnelPublic.js');
const app = express();
// 30mb so the 20MB TOTAL cap is enforced by OUR validator and not by the body
// parser — a 413 from express would prove nothing about this feature.
app.use(express.json({ limit: '30mb' }));
app.use('/api/v1/funnels', funnelsRoutes);
app.use('/api/v1/funnel-transfer', transferRoutes); // same mount as routes/index.js
app.use('/api/v1/split-tests', splitRoutes);
app.use('/f', publicRoutes);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 300));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
const { ensureTables } = await import('../../src/routes/funnels.js');
await ensureTables();

await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_tr','t@t.co','T','R')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_tr','funnels-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_tr','r_tr')`;
const TOKEN = signAccessToken({ userId: 'u_tr' });

const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const F = (m, p, b) => req(m, `/api/v1/funnels${p}`, b);
const T = (m, p, b) => req(m, `/api/v1/funnel-transfer${p}`, b);
const S = (m, p, b) => req(m, `/api/v1/split-tests${p}`, b);

// JSONB normalises object-key order, so equality must be canonical.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const counts = async () => {
  const [f] = await sql`SELECT COUNT(*)::int AS n FROM funnels`;
  const [p] = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`;
  return { funnels: f.n, pages: p.n };
};

// ═══ SEED: a content-heavy source funnel ═══════════════════════════════════
const MAPS_KEY = 'AIzaSyCANARY_TRANSFER_MUST_NEVER_TRAVEL';
const ROGUE_KEY = 'sk_live_CANARY_UNKNOWN_KEY_MUST_NEVER_TRAVEL';

const src = await F('POST', '/', { name: 'Transfer Source', slug: 'transfer-src' });
ok(src.status === 201, 'seed: source funnel created', JSON.stringify(src.j));
const SRC = src.j?.data?.id;

const settingsPatch = await F('PATCH', `/${SRC}`, {
  settings: {
    logo_url: 'https://cdn.example.com/logo.png',
    description: 'Source funnel description',
    brand_colors: { primary: '#0f0', secondary: '#00f' },
    fonts: { family: 'inter' },
    // The credential + a key the allowlist has never heard of.
    checkout: { address_autocomplete: true, intl_phone: true, maps_api_key: MAPS_KEY },
    stripe_secret_key: ROGUE_KEY,
    custom_head_code: '<script>window.__srcPixel = 1;</script>',
  },
  seo: { site_title: 'Src Title', site_description: 'Src desc' },
});
ok(settingsPatch.status === 200, 'seed: settings written (incl. credential + rogue key)', JSON.stringify(settingsPatch.j?.error));

const BLOCKS_A = [
  { type: 'hero', props: { headline: 'Alpha headline', nested: { deep: [1, 2, { k: 'v' }] } } },
  { type: 'text', props: { body: 'Some copy with "quotes" and \\n escapes' } },
];
const BLOCKS_B = [{ type: 'cta', props: { label: 'Buy now', href: '/checkout' } }];

const pa = await F('POST', `/${SRC}/pages`, { title: 'Alpha Home', slug: '/', type: 'lead' });
const pb = await F('POST', `/${SRC}/pages`, { title: 'Beta LP', slug: '/lp-b', type: 'listicle' });
const pc = await F('POST', `/${SRC}/pages`, { title: 'Gamma', slug: '/gamma', type: 'generic' });
ok(pa.status === 201 && pb.status === 201 && pc.status === 201, 'seed: three pages created');
const PA = pa.j?.data?.id, PB = pb.j?.data?.id, PC = pc.j?.data?.id;

await F('PATCH', `/${SRC}/pages/${PA}`, {
  blocks: BLOCKS_A,
  custom_css: '.alpha { color: #f00; }',
  custom_js: 'window.__alpha = true; /* verbatim */',
  head_html: '<meta name="src" content="alpha">',
  body_end_html: '<!-- alpha end -->',
  custom_html: '<div class="raw">alpha</div>',
  seo: { site_title: 'Alpha SEO', og_image: 'https://x/y.png' },
  status: 'published',
});
await F('PATCH', `/${SRC}/pages/${PB}`, { blocks: BLOCKS_B, custom_css: '.beta{}', status: 'published' });
await F('PATCH', `/${SRC}/pages/${PC}`, { blocks: [] });

// PATCH /:id/flow takes { nodes, edges } at the TOP level (funnels.js:622).
const flowPatch = await F('PATCH', `/${SRC}/flow`, {
  nodes: [{ id: PA, x: 10, y: 20 }, { id: PB, x: 300, y: 20 }, { id: PC, x: 600, y: 20 }],
  edges: [{ source: PA, target: PB, kind: 'main' }, { source: PB, target: PC, kind: 'fallback' }],
});
ok(flowPatch.status === 200, 'seed: flow_layout written', JSON.stringify(flowPatch.j?.error));

// ═══ 1. EXPORT ════════════════════════════════════════════════════════════
const ex = await T('GET', `/${SRC}/export`);
ok(ex.status === 200, 'E1 export answers 200', JSON.stringify(ex.j));
const ENV = ex.j?.data;
const ENV_TEXT = JSON.stringify(ENV);

ok(ENV?.format === 'puure-funnel-v1', 'E2 format tag is puure-funnel-v1', String(ENV?.format));

// exported_at is the DATABASE's instant, not the client's.
const [{ now: dbNow }] = await sql`SELECT NOW() AS now`;
const skew = Math.abs(new Date(ENV?.exported_at).getTime() - dbNow.getTime());
ok(Number.isFinite(skew) && skew < 10_000, 'E3 exported_at parses and matches DB NOW() (<10s)', `skew=${skew}ms`);

ok(!ENV_TEXT.includes(MAPS_KEY), 'E4 settings.checkout.maps_api_key (credential) does NOT appear in the envelope');
ok(!ENV_TEXT.includes(ROGUE_KEY), 'E5 an unknown settings key does NOT appear (allowlist, not blocklist)');
ok(ENV.funnel.settings.checkout?.address_autocomplete === true
  && ENV.funnel.settings.checkout?.intl_phone === true
  && ENV.funnel.settings.checkout?.maps_api_key === undefined,
'E6 checkout toggles travel while the key inside the SAME object is dropped', canon(ENV.funnel.settings.checkout));
ok(ENV.funnel.settings.brand_colors?.primary === '#0f0'
  && ENV.funnel.settings.fonts?.family === 'inter'
  && ENV.funnel.settings.logo_url === 'https://cdn.example.com/logo.png',
'E7 allowlisted settings survive');
ok(Array.isArray(ENV.stripped)
  && ENV.stripped.includes('settings.checkout.maps_api_key')
  && ENV.stripped.includes('settings.stripe_secret_key'),
'E8 stripped[] REPORTS both dropped keys', JSON.stringify(ENV.stripped));

for (const id of [SRC, PA, PB, PC]) {
  ok(!ENV_TEXT.includes(id), `E9 no source id in the envelope (${id.slice(0, 8)}…)`);
}
ok(!/"id"\s*:/.test(ENV_TEXT), 'E10 the envelope contains no "id" key at all');
ok(!/custom_domain|default_page_id|funnel_id/.test(ENV_TEXT),
  'E11 no domain binding / default_page_id / funnel_id keys');
ok(ENV.pages.length === 3 && ENV.pages.filter((p) => p.is_home).length === 1,
  'E12 three pages, exactly one home', JSON.stringify(ENV.pages.map((p) => [p.slug, p.is_home])));
ok(ENV.flow.nodes.length === 3 && ENV.flow.edges.length === 2
  && ENV.flow.nodes.every((n) => Number.isInteger(n.page_index))
  && ENV.flow.edges.every((e) => Number.isInteger(e.source_index) && Number.isInteger(e.target_index)),
'E13 flow is carried as ARRAY INDICES, not ids', canon(ENV.flow));

// ═══ 2. ROUNDTRIP ═════════════════════════════════════════════════════════
const imp = await T('POST', '/import', { envelope: ENV });
ok(imp.status === 201, 'R1 import answers 201', JSON.stringify(imp.j));
const NEW = imp.j?.data?.funnel;
const NEWPAGES = imp.j?.data?.pages || [];

ok(NEW?.id && NEW.id !== SRC, 'R2 imported funnel has a FRESH id', String(NEW?.id));
ok(NEW?.status === 'draft', 'R3 imported funnel is a DRAFT', String(NEW?.status));
ok(NEW?.custom_domain === null, 'R4 imported funnel has NO domain', String(NEW?.custom_domain));
ok(NEW?.slug && NEW.slug !== 'transfer-src', 'R5 imported funnel got a de-collided slug', String(NEW?.slug));
ok(NEWPAGES.length === 3, 'R6 three pages created', String(NEWPAGES.length));
ok(NEWPAGES.every((p) => ![PA, PB, PC].includes(p.id)), 'R7 every imported page has a FRESH id');

const srcRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${SRC} ORDER BY is_home DESC, created_at ASC`;
const newRows = await sql`SELECT * FROM funnel_pages WHERE funnel_id = ${NEW.id} ORDER BY is_home DESC, created_at ASC`;
ok(srcRows.length === newRows.length, 'R8 same page count in the DB');
let identical = true, diff = '';
for (let i = 0; i < srcRows.length; i++) {
  const a = srcRows[i], b = newRows[i];
  if (canon(a.blocks) !== canon(b.blocks)) { identical = false; diff = `blocks@${i}`; break; }
  for (const f of ['custom_css', 'custom_js', 'head_html', 'body_end_html', 'custom_html', 'title', 'slug', 'type', 'status']) {
    if (a[f] !== b[f]) { identical = false; diff = `${f}@${i} ${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`; break; }
  }
  if (!identical) break;
  if (a.is_home !== b.is_home) { identical = false; diff = `is_home@${i}`; break; }
}
ok(identical, 'R9 blocks + css + js + escape hatches + is_home reproduce EXACTLY', diff);

const [newFunnelRow] = await sql`SELECT flow_layout FROM funnels WHERE id = ${NEW.id}`;
const newIds = new Set(newRows.map((r) => r.id));
ok(newFunnelRow.flow_layout.nodes.length === 3
  && newFunnelRow.flow_layout.edges.length === 2
  && newFunnelRow.flow_layout.nodes.every((n) => newIds.has(n.id))
  && newFunnelRow.flow_layout.edges.every((e) => newIds.has(e.source) && newIds.has(e.target)),
'R10 flow rebuilt onto the NEW page ids', JSON.stringify(newFunnelRow.flow_layout));

ok((imp.j?.data?.warnings || []).some((w) => /custom_js present on 1 page/.test(w)),
  'R11 custom_js warning surfaces on the import response', JSON.stringify(imp.j?.data?.warnings));

const impNamed = await T('POST', '/import', { envelope: ENV, name_override: 'Renamed Import' });
ok(impNamed.status === 201 && impNamed.j?.data?.funnel?.name === 'Renamed Import',
  'R12 name_override applies', JSON.stringify(impNamed.j?.data?.funnel?.name));

// Home invariant repair: an envelope with ZERO homes and one with TWO.
const noHome = JSON.parse(ENV_TEXT);
noHome.pages.forEach((p) => { p.is_home = false; });
const rNoHome = await T('POST', '/import', { envelope: noHome });
ok(rNoHome.status === 201 && rNoHome.j?.data?.home_adjusted === true
  && rNoHome.j?.data?.notes?.some((n) => /first page was promoted/.test(n)),
'R13 zero homes → first page promoted, REPORTED', JSON.stringify(rNoHome.j?.data?.notes));
const [homeCount1] = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${rNoHome.j.data.funnel.id} AND is_home`;
ok(homeCount1.n === 1, 'R14 …and exactly one home landed', String(homeCount1.n));

const multiHome = JSON.parse(ENV_TEXT);
multiHome.pages.forEach((p) => { p.is_home = true; });
const rMulti = await T('POST', '/import', { envelope: multiHome });
const [homeCount2] = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${rMulti.j.data.funnel.id} AND is_home`;
ok(rMulti.status === 201 && homeCount2.n === 1
  && rMulti.j?.data?.notes?.some((n) => /3 pages were marked home/.test(n)),
'R15 three homes → first wins, two demoted, REPORTED', JSON.stringify(rMulti.j?.data?.notes));

// ═══ 3. REFUSALS — each with NOTHING created ══════════════════════════════
const refuse = async (label, body, wantStatus, wantCode) => {
  const before = await counts();
  const r = await T('POST', '/import', body);
  const after = await counts();
  ok(r.status === wantStatus && r.j?.error?.code === wantCode,
    `${label} → ${wantStatus} ${wantCode}`, `got ${r.status} ${JSON.stringify(r.j?.error)}`);
  ok(before.funnels === after.funnels && before.pages === after.pages,
    `${label} → NOTHING created (${before.funnels}/${before.pages} unchanged)`,
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  return r;
};

await refuse('X1 bad format tag', { envelope: { ...ENV, format: 'other-tool-v3' } }, 400, 'not_a_funnel_envelope');
await refuse('X2 missing pages', { envelope: { format: 'puure-funnel-v1', funnel: { name: 'x' } } }, 400, 'envelope_missing_pages');
await refuse('X3 empty pages', { envelope: { format: 'puure-funnel-v1', funnel: { name: 'x' }, pages: [] } }, 400, 'envelope_has_no_pages');
await refuse('X4 not an object', { envelope: 'a string' }, 400, 'envelope_must_be_object');

const tooMany = { format: 'puure-funnel-v1', funnel: { name: 'Too many' }, pages: [] };
for (let i = 0; i < 101; i++) tooMany.pages.push({ title: `p${i}`, slug: `/p-${i}`, type: 'generic', blocks: [] });
await refuse('X5 101 pages', { envelope: tooMany }, 413, 'too_many_pages');

const fatPage = {
  format: 'puure-funnel-v1',
  funnel: { name: 'Fat page' },
  pages: [{ title: 'fat', slug: '/', type: 'generic', is_home: true, blocks: [{ type: 'text', props: { body: 'x'.repeat(2 * 1024 * 1024 + 64) } }] }],
};
await refuse('X6 page blocks over 2MB', { envelope: fatPage }, 413, 'page_blocks_too_large');

// Total cap: 12 pages × ~1.8MB = ~21.6MB, each page UNDER the per-page cap, so
// only the TOTAL rule can refuse this one.
const fatTotal = { format: 'puure-funnel-v1', funnel: { name: 'Fat total' }, pages: [] };
for (let i = 0; i < 12; i++) {
  fatTotal.pages.push({ title: `p${i}`, slug: `/p-${i}`, type: 'generic', blocks: [{ type: 'text', props: { body: 'y'.repeat(1_800_000) } }] });
}
await refuse('X7 total over 20MB', { envelope: fatTotal }, 413, 'envelope_too_large');

const badBlocks = JSON.parse(ENV_TEXT);
badBlocks.pages[1].blocks = [{ type: '', props: 'not-an-object' }];
await refuse('X8 invalid blocks (same gate as PATCH)', { envelope: badBlocks }, 422, 'invalid_blocks');

const protoBlocks = JSON.parse(ENV_TEXT);
protoBlocks.pages[0].blocks = [{ type: 'x', props: { __proto__: { polluted: 1 } } }];
// (JSON.parse keeps __proto__ as an own key, which is exactly the payload
//  validateBlocks' FORBIDDEN_KEYS scan exists to refuse.)
protoBlocks.pages[0].blocks = JSON.parse('[{"type":"x","props":{"__proto__":{"polluted":1}}}]');
await refuse('X9 prototype-pollution key in blocks', { envelope: protoBlocks }, 422, 'invalid_blocks');

// ═══ 4. ROLLBACK — a failure raised MID-transaction ═══════════════════════
// The refusals above prove the gate runs BEFORE the write. This proves the
// write itself is atomic: a trigger raises on the SECOND of three page inserts,
// so the funnel row and page one are already in the transaction when it blows.
await sql.unsafe(`
  CREATE OR REPLACE FUNCTION boom_on_marker() RETURNS trigger AS $$
  BEGIN
    IF NEW.title = '__BOOM__' THEN RAISE EXCEPTION 'boom'; END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`);
await sql.unsafe(`CREATE TRIGGER trg_boom BEFORE INSERT ON funnel_pages
  FOR EACH ROW EXECUTE FUNCTION boom_on_marker()`);
{
  const boomEnv = JSON.parse(ENV_TEXT);
  boomEnv.pages[1].title = '__BOOM__';
  const before = await counts();
  const r = await T('POST', '/import', { envelope: boomEnv });
  const after = await counts();
  ok(r.status === 500 && r.j?.error?.code === 'server_error',
    'TX1 a mid-transaction failure answers 500', `${r.status} ${JSON.stringify(r.j)}`);
  ok(before.funnels === after.funnels && before.pages === after.pages,
    'TX2 ROLLBACK: no funnel row and no page row survived', `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
}
await sql.unsafe(`DROP TRIGGER trg_boom ON funnel_pages`);
await sql.unsafe(`DROP FUNCTION boom_on_marker()`);

// A clean import still works after the trigger is gone (the failure above was
// the trigger, not a broken code path).
{
  const r = await T('POST', '/import', { envelope: ENV });
  ok(r.status === 201, 'TX3 imports still succeed once the trigger is removed', JSON.stringify(r.j?.error));
}

// Export refusals.
{
  const r = await T('GET', '/fnl_does_not_exist/export');
  ok(r.status === 404 && r.j?.error?.code === 'funnel_not_found', 'X10 export of an unknown funnel 404s', JSON.stringify(r.j));
  const noAuth = await fetch(`${BASE}/api/v1/funnel-transfer/${SRC}/export`);
  ok(noAuth.status === 401, 'X11 export without a token 401s', String(noAuth.status));
  const noAuthImp = await fetch(`${BASE}/api/v1/funnel-transfer/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: ENV }),
  });
  ok(noAuthImp.status === 401, 'X12 import without a token 401s', String(noAuthImp.status));
}

// ═══ 5. PROMOTE WINNER ════════════════════════════════════════════════════
const pf = await F('POST', '/', { name: 'Promote Funnel', slug: 'promo-fnl' });
const PF = pf.j?.data?.id;
const armA = await F('POST', `/${PF}/pages`, { title: 'ARM A LOSER PAGE', slug: '/arm-a', type: 'lead' });
const armB = await F('POST', `/${PF}/pages`, { title: 'ARM B WINNER PAGE', slug: '/arm-b', type: 'lead' });
const armD = await F('POST', `/${PF}/pages`, { title: 'ARM D DRAFT PAGE', slug: '/arm-d', type: 'lead' });
const AP = armA.j?.data?.id, BP = armB.j?.data?.id, DP = armD.j?.data?.id;
await F('PATCH', `/${PF}/pages/${AP}`, { status: 'published', blocks: [{ type: 'text', props: { body: 'A' } }] });
await F('PATCH', `/${PF}/pages/${BP}`, { status: 'published', blocks: [{ type: 'text', props: { body: 'B' } }] });
await F('PATCH', `/${PF}/pages/${DP}`, { blocks: [{ type: 'text', props: { body: 'D' } }] }); // stays draft
await F('POST', `/${PF}/publish`);
ok(AP && BP && DP, 'P0 promote fixture: three pages');

const test = await S('POST', '/', {
  funnel_id: PF, name: 'Promote test', scope: 'page', handle: 'promo-handle',
  arms: [
    { arm_key: 'a', weight: 1, page_id: AP, is_control: true, is_entry: true },
    { arm_key: 'b', weight: 1, page_id: BP },
    { arm_key: 'd', weight: 1, page_id: DP },
    { arm_key: 'z', weight: 1, page_id: BP },
  ],
});
ok(test.status === 201, 'P1 split test created', JSON.stringify(test.j));
const TID = test.j?.data?.id;
const armRows = await sql`SELECT id, arm_key FROM lb_split_arms WHERE test_id = ${TID}`;
const armId = (k) => armRows.find((a) => a.arm_key === k)?.id;

// Archive arm z (NOT the entry arm — archiving the entry hands the role on).
const arch = await S('PATCH', `/${TID}/arms/${armId('z')}`, { archived: true });
ok(arch.status === 200, 'P2 arm z archived', JSON.stringify(arch.j));

// Baseline serving: the handle answers, and while the test is LIVE it BRANCHES
// — resolvePageSplit mints a first-touch visitor id and picks by sticky hash,
// so which of the two published arms answers is not knowable in advance. What
// IS knowable: it is one of them, and never the draft arm (splitDelivery only
// resolves a page that is `NOT archived AND status = 'published'`).
const serveBefore = await fetch(`${BASE}/f/promo-fnl/promo-handle`);
const bodyBefore = await serveBefore.text();
ok(serveBefore.status === 200
  && (bodyBefore.includes('ARM A LOSER PAGE') || bodyBefore.includes('ARM B WINNER PAGE'))
  && !bodyBefore.includes('ARM D DRAFT PAGE'),
'P3 /f/<slug>/<handle> serves a published arm (branching) before promote', `${serveBefore.status}`);
{
  // A LIVE test really does branch — 24 distinct visitors must not all land on
  // one arm, otherwise P17/P18 below would prove nothing about the promote.
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const r = await fetch(`${BASE}/f/promo-fnl/promo-handle`, { headers: { Cookie: `lbv=pre_visitor_${i}` } });
    const t = await r.text();
    if (t.includes('ARM A LOSER PAGE')) seen.add('a');
    if (t.includes('ARM B WINNER PAGE')) seen.add('b');
  }
  ok(seen.size === 2, 'P3b a LIVE test branches across visitors (both arms observed)', JSON.stringify([...seen]));
}

// Refusals.
{
  const r = await S('POST', `/${TID}/promote`, { arm_id: armId('b') });
  ok(r.status === 400 && r.j?.error?.code === 'confirm_required', 'P4 no confirm → 400 confirm_required', JSON.stringify(r.j));
}
{
  const r = await S('POST', `/${TID}/promote`, { confirm: true });
  ok(r.status === 422 && r.j?.error?.code === 'arm_id_required', 'P5 no arm_id → 422', JSON.stringify(r.j));
}
{
  const r = await S('POST', `/${TID}/promote`, { arm_id: 'lbsa_nope', confirm: true });
  ok(r.status === 404 && r.j?.error?.code === 'not_found', 'P6 unknown arm → 404', JSON.stringify(r.j));
}
{
  const r = await S('POST', '/lbsg_nope/promote', { arm_id: armId('b'), confirm: true });
  ok(r.status === 404 && r.j?.error?.code === 'not_found', 'P7 unknown test → 404', JSON.stringify(r.j));
}
{
  const r = await S('POST', `/${TID}/promote`, { arm_id: armId('d'), confirm: true });
  ok(r.status === 422 && r.j?.error?.code === 'arm_page_not_published',
    'P8 arm whose page is a DRAFT → 422 (it would never serve)', JSON.stringify(r.j));
}
{
  const r = await S('POST', `/${TID}/promote`, { arm_id: armId('z'), confirm: true });
  ok(r.status === 422 && r.j?.error?.code === 'arm_archived', 'P9 archived arm → 422', JSON.stringify(r.j));
}
// Nothing above may have moved the entry arm or paused the test.
{
  const [t] = await sql`SELECT enabled, promoted_arm_id FROM lb_split_tests WHERE id = ${TID}`;
  const entry = await sql`SELECT arm_key FROM lb_split_arms WHERE test_id = ${TID} AND is_entry`;
  ok(t.enabled === true && t.promoted_arm_id === null && entry[0]?.arm_key === 'a',
    'P10 every refusal left the test UNTOUCHED (enabled, entry=a, unpromoted)',
    JSON.stringify({ enabled: t.enabled, promoted: t.promoted_arm_id, entry: entry[0]?.arm_key }));
}

// Happy path.
const promo = await S('POST', `/${TID}/promote`, { arm_id: armId('b'), confirm: true });
ok(promo.status === 200, 'P11 promote arm b → 200', JSON.stringify(promo.j));
ok(promo.j?.data?.enabled === false, 'P12 response says the test is PAUSED', String(promo.j?.data?.enabled));
ok(promo.j?.data?.promoted_arm_id === armId('b') && promo.j?.data?.promoted_arm_key === 'b',
  'P13 response names the promoted arm', JSON.stringify(promo.j?.data?.promoted_arm_id));
{
  const entry = await sql`SELECT arm_key FROM lb_split_arms WHERE test_id = ${TID} AND is_entry AND NOT archived`;
  ok(entry.length === 1 && entry[0].arm_key === 'b', 'P14 exactly one entry arm and it is b', JSON.stringify(entry));
  const [t] = await sql`SELECT enabled, archived, promoted_at FROM lb_split_tests WHERE id = ${TID}`;
  ok(t.enabled === false && t.archived === false && t.promoted_at !== null,
    'P15 test paused (enabled=false), NOT archived, promoted_at stamped', JSON.stringify(t));
}

// THE POINT OF THE WHOLE ENDPOINT: the route still answers, now with the winner.
const serveAfter = await fetch(`${BASE}/f/promo-fnl/promo-handle`);
const bodyAfter = await serveAfter.text();
ok(serveAfter.status === 200, 'P16 the handle STILL answers 200 after the pause', String(serveAfter.status));
ok(bodyAfter.includes('ARM B WINNER PAGE') && !bodyAfter.includes('ARM A LOSER PAGE'),
  'P17 …and now serves ARM B to everyone');
{
  // Paused ⇒ unbranched: many distinct visitors all land on the winner.
  let allB = true;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${BASE}/f/promo-fnl/promo-handle`, { headers: { Cookie: `lbv=visitor_${i}` } });
    const t = await r.text();
    if (!t.includes('ARM B WINNER PAGE')) { allB = false; break; }
  }
  ok(allB, 'P18 a paused test pins EVERY visitor to the promoted arm');
}

// Replay.
{
  const [before] = await sql`SELECT promoted_at FROM lb_split_tests WHERE id = ${TID}`;
  const r = await S('POST', `/${TID}/promote`, { arm_id: armId('b'), confirm: true });
  const [after] = await sql`SELECT promoted_at FROM lb_split_tests WHERE id = ${TID}`;
  ok(r.status === 200 && r.j?.data?.promoted_arm_id === armId('b'),
    'P19 REPLAY of the SAME arm is idempotent → 200', JSON.stringify(r.j?.error));
  ok(before.promoted_at.getTime() === after.promoted_at.getTime(),
    'P20 …and promoted_at does NOT move (COALESCE keeps the first verdict\'s instant)');
}
{
  const r = await S('POST', `/${TID}/promote`, { arm_id: armId('a'), confirm: true });
  ok(r.status === 409 && r.j?.error?.code === 'already_promoted',
    'P21 promoting a DIFFERENT arm afterwards → 409 already_promoted', JSON.stringify(r.j));
  const entry = await sql`SELECT arm_key FROM lb_split_arms WHERE test_id = ${TID} AND is_entry AND NOT archived`;
  ok(entry[0]?.arm_key === 'b', 'P22 …and the 409 changed nothing', JSON.stringify(entry));
}

// ═══ Done ═════════════════════════════════════════════════════════════════
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
