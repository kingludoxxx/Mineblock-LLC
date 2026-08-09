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
ok(Array.isArray(ex.j?.meta?.stripped)
  && ex.j.meta.stripped.includes('settings.checkout.maps_api_key')
  && ex.j.meta.stripped.includes('settings.stripe_secret_key'),
'E8 the response REPORTS both dropped keys (in meta — see M8b/M8c)', JSON.stringify(ex.j?.meta?.stripped));

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

ok((imp.j?.data?.warnings || []).some((w) => /custom_js on 1 page/.test(w)),
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

// ═══ 6. REVIEW FIXES — every case below is a reviewer probe, kept forever ══

// ── HIGH #1: allowlisted-but-unwritable settings are REFUSED ───────────────
// The reviewer's exact payload: a 3MB `description` (allowlisted!) plus a 5MB
// custom_head_code. Both pass the allowlist and both fit inside the 20MB
// envelope cap — and before the fix they imported at 201, added ~8MB to every
// GET /funnels, and left the funnel PERMANENTLY UNSAVEABLE from the settings
// modal, because PATCH runs validateFunnelSettings and the stored row now
// failed it.
{
  const fat = JSON.parse(ENV_TEXT);
  fat.funnel.settings = {
    description: 'd'.repeat(3 * 1024 * 1024),
    custom_head_code: '<script>/*'.padEnd(5 * 1024 * 1024, 'x') + '*/</script>',
  };
  const before = await counts();
  const r = await T('POST', '/import', { envelope: fat });
  const after = await counts();
  ok(r.status === 422 && r.j?.error?.code === 'settings_invalid',
    'H1a 3MB description + 5MB head code → 422 settings_invalid', `${r.status} ${JSON.stringify(r.j?.error)}`);
  ok(before.funnels === after.funnels && before.pages === after.pages,
    'H1b …and NOTHING was created', `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
}
// The bound is on the STRUCTURED remainder (32KB) — a legitimate settings blob
// still imports, so the guard is not just "refuse everything large".
{
  const okSettings = JSON.parse(ENV_TEXT);
  okSettings.funnel.settings = { description: 'd'.repeat(1000), brand_colors: { primary: '#abc' } };
  const r = await T('POST', '/import', { envelope: okSettings });
  ok(r.status === 201, 'H1c a normal settings blob still imports', JSON.stringify(r.j?.error));
}

// ── HIGH #2: a hostile flow can no longer poison the canvas ────────────────
// 5000 nodes all pointing at page_index 0 (⇒ 5000 rows sharing ONE id) and 5000
// self-edges. Before the fix this stored at 201 and the canvas then REFUSED its
// own persisted layout on the next save.
{
  const hostile = JSON.parse(ENV_TEXT);
  hostile.flow = { nodes: [], edges: [] };
  for (let i = 0; i < 5000; i++) {
    hostile.flow.nodes.push({ page_index: 0, x: i, y: i });
    hostile.flow.edges.push({ source_index: 0, target_index: 0, kind: 'main' });
  }
  const r = await T('POST', '/import', { envelope: hostile });
  ok(r.status === 201, 'H2a hostile flow does NOT block the import (layout is cosmetic)', JSON.stringify(r.j?.error));
  const fid = r.j?.data?.funnel?.id;
  const [row] = await sql`SELECT flow_layout FROM funnels WHERE id = ${fid}`;
  const fl = row.flow_layout;
  const ids = fl.nodes.map((n) => n.id);
  ok(new Set(ids).size === ids.length, 'H2b stored layout has NO duplicate node ids', `${ids.length} nodes`);
  ok(fl.edges.every((e) => e.source !== e.target), 'H2c stored layout has NO self-edges', `${fl.edges.length} edges`);
  ok(fl.nodes.length <= 1000 && fl.edges.length <= 2000,
    'H2d stored layout is within the canvas caps', JSON.stringify({ n: fl.nodes.length, e: fl.edges.length }));
  ok((r.j?.data?.notes || []).some((n) => /Canvas layout was repaired/.test(n)),
    'H2e the repair is REPORTED', JSON.stringify(r.j?.data?.notes));
  // THE REAL PROOF: hand the stored layout back to the GENUINE
  // PATCH /:id/flow endpoint — the one the canvas calls, running the real
  // validateFlow. A 200 means the canvas can save what the import wrote.
  const back = await F('PATCH', `/${fid}/flow`, { nodes: fl.nodes, edges: fl.edges });
  ok(back.status === 200, 'H2f the REAL validateFlow accepts the stored layout (canvas can save it)', JSON.stringify(back.j));
}
// A well-formed flow still round-trips intact (the repair is not a bulldozer).
{
  const r = await T('POST', '/import', { envelope: ENV });
  const [row] = await sql`SELECT flow_layout FROM funnels WHERE id = ${r.j.data.funnel.id}`;
  const back = await F('PATCH', `/${r.j.data.funnel.id}/flow`, { nodes: row.flow_layout.nodes, edges: row.flow_layout.edges });
  ok(row.flow_layout.nodes.length === 3 && row.flow_layout.edges.length === 2 && back.status === 200,
    'H2g a clean flow survives untouched and is canvas-saveable', JSON.stringify({ n: row.flow_layout.nodes.length, e: row.flow_layout.edges.length, back: back.status }));
}

// ── MED #3: file content must not set request parameters ───────────────────
{
  const planted = JSON.parse(ENV_TEXT);
  planted.name_override = 'PWNED BY THE FILE';
  // Bare-posted: the body IS the envelope, so every key in it is file content.
  const r = await T('POST', '/import', planted);
  ok(r.status === 201 && r.j?.data?.funnel?.name === 'Transfer Source',
    'M3a a name_override planted INSIDE a bare-posted envelope is ignored', JSON.stringify(r.j?.data?.funnel?.name));
  // The wrapper form is still honoured — that one is the operator speaking.
  const r2 = await T('POST', '/import', { envelope: planted, name_override: 'Operator Chose This' });
  ok(r2.status === 201 && r2.j?.data?.funnel?.name === 'Operator Chose This',
    'M3b the WRAPPED name_override is honoured', JSON.stringify(r2.j?.data?.funnel?.name));
}
{
  const r = await T('POST', '/import', { envelope: ENV, name_override: '   ' });
  ok(r.status === 201 && r.j?.data?.funnel?.name === 'Transfer Source',
    'M13 a blank-after-trim name_override falls back to the envelope name', JSON.stringify(r.j?.data?.funnel?.name));
}

// ── MED #4: scripts hidden in html/embed BLOCKS are warned about ───────────
{
  const blocky = JSON.parse(ENV_TEXT);
  blocky.pages[2].blocks = [{ type: 'html', props: { html: '<script>fetch("//evil")</script>' } }];
  blocky.pages[1].blocks = [{ type: 'cta', props: { html: '<script>alert(1)</script>' } }];
  blocky.pages.forEach((p) => { p.custom_js = ''; p.custom_html = ''; p.head_html = ''; p.body_end_html = ''; });
  blocky.funnel.settings = {};
  const r = await T('POST', '/import', { envelope: blocky });
  ok(r.status === 201, 'M4a html-block envelope imports', JSON.stringify(r.j?.error));
  ok((r.j?.data?.warnings || []).some((w) => /2 pages carry raw HTML\/embed blocks/.test(w)),
    'M4b an html BLOCK and a props.html <script> BOTH raise the warning', JSON.stringify(r.j?.data?.warnings));
}

// ── MED #5: a clamped field is REPORTED, and warnings describe what is STORED ─
{
  const clamped = JSON.parse(ENV_TEXT);
  clamped.pages.forEach((p) => { p.custom_js = ''; });
  clamped.pages[0].custom_js = 'j'.repeat(2 * 1024 * 1024 + 128); // over the 2MB field cap
  const r = await T('POST', '/import', { envelope: clamped });
  ok(r.status === 201, 'M5a over-cap custom_js still imports (the field is dropped, not the funnel)', JSON.stringify(r.j?.error));
  ok((r.j?.data?.notes || []).some((n) => /custom_js on page 1 exceeded the 2MB limit and was removed/.test(n)),
    'M5b the removal is REPORTED per field and per page', JSON.stringify(r.j?.data?.notes));
  ok(!(r.j?.data?.warnings || []).some((w) => /custom_js/.test(w)),
    'M5c …and no custom_js warning is raised for code that was DELETED', JSON.stringify(r.j?.data?.warnings));
  const [stored] = await sql`SELECT custom_js FROM funnel_pages WHERE funnel_id = ${r.j.data.funnel.id} AND is_home`;
  ok(stored.custom_js === '', 'M5d the stored field really is empty', JSON.stringify(stored.custom_js?.length));
}

// ── MED #8: the envelope warns, and `stripped` does NOT travel in the file ──
{
  ok(Array.isArray(ENV.warnings) && ENV.warnings.some((w) => /custom_js on 1 page/.test(w)),
    'M8a the EXPORT envelope carries its own warnings', JSON.stringify(ENV.warnings));
  ok(ENV.stripped === undefined, 'M8b `stripped` is NOT in the portable file (it maps where credentials live)');
  ok(Array.isArray(ex.j?.meta?.stripped)
    && ex.j.meta.stripped.includes('settings.checkout.maps_api_key')
    && ex.j.meta.stripped.includes('settings.stripe_secret_key'),
  'M8c …it rides in meta, to the authenticated operator only', JSON.stringify(ex.j?.meta?.stripped));
}

// ── MED #9: redirects travel ───────────────────────────────────────────────
{
  await sql`INSERT INTO funnel_redirects (id, funnel_id, from_path, to_path, match, code, enabled) VALUES
    ('frd_t1', ${SRC}, '/old-lp', '/lp-b', 'exact', 301, TRUE),
    ('frd_t2', ${SRC}, '/legacy', '/gamma', 'prefix', 302, FALSE)`;
  const ex2 = await T('GET', `/${SRC}/export`);
  const env2 = ex2.j?.data;
  ok(env2.redirects?.length === 2, 'M9a export carries the redirects', JSON.stringify(env2.redirects));
  ok(!JSON.stringify(env2.redirects).includes('frd_t1'), 'M9b …with no ids');
  const r = await T('POST', '/import', { envelope: env2 });
  const got = await sql`SELECT from_path, to_path, match, code, enabled FROM funnel_redirects
                        WHERE funnel_id = ${r.j.data.funnel.id} ORDER BY from_path`;
  ok(r.j?.data?.redirects_count === 2 && got.length === 2
    && got[0].from_path === '/legacy' && got[0].match === 'prefix' && got[0].code === 302 && got[0].enabled === false
    && got[1].from_path === '/old-lp' && got[1].match === 'exact' && got[1].code === 301,
  'M9c import recreates them exactly, ids fresh', JSON.stringify(got));

  // A malformed / funnel-killing rule is DROPPED with a note, never a hard fail.
  const bad = JSON.parse(JSON.stringify(env2));
  bad.redirects = [
    { from_path: 'https://evil.example/x', to_path: '/a', match: 'exact', code: 301 },
    { from_path: '//evil.example', to_path: '/a', match: 'exact', code: 301 },
    { from_path: '/loop', to_path: '/loop', match: 'exact', code: 301 },
    { from_path: '/', to_path: '/a', match: 'prefix', code: 301 },
    { from_path: '/good', to_path: '/lp-b', match: 'exact', code: 301 },
  ];
  const r2 = await T('POST', '/import', { envelope: bad });
  ok(r2.status === 201 && r2.j?.data?.redirects_count === 1,
    'M9d open-redirect / self-loop / prefix-on-root rules are dropped, the good one survives', JSON.stringify(r2.j?.data?.redirects_count));
  ok((r2.j?.data?.notes || []).filter((n) => /Redirect \d+ was dropped/.test(n)).length === 4,
    'M9e …and every drop is REPORTED', JSON.stringify(r2.j?.data?.notes));

  const tooMany = JSON.parse(JSON.stringify(env2));
  tooMany.redirects = [];
  for (let i = 0; i < 501; i++) tooMany.redirects.push({ from_path: `/r-${i}`, to_path: '/lp-b', match: 'exact', code: 301 });
  await refuse('M9f 501 redirects', { envelope: tooMany }, 413, 'too_many_redirects');
}

// ── LOW #14: an archived funnel cannot be exported ─────────────────────────
{
  const tmp = await F('POST', '/', { name: 'Archive Me', slug: 'archive-me-exp' });
  await F('POST', `/${tmp.j.data.id}/pages`, { title: 'p', slug: '/', type: 'generic' });
  const okBefore = await T('GET', `/${tmp.j.data.id}/export`);
  await F('POST', `/${tmp.j.data.id}/archive`, { archived: true });
  const r = await T('GET', `/${tmp.j.data.id}/export`);
  ok(okBefore.status === 200 && r.status === 403 && r.j?.error?.code === 'funnel_archived',
    'L14 export of an ARCHIVED funnel → 403 (no resurrection by round trip)', `${okBefore.status} → ${r.status} ${JSON.stringify(r.j?.error)}`);
}

// ── MED #6: a promotion is RETRACTABLE ─────────────────────────────────────
// The 409 used to be permanent: the entry endpoint never cleared
// promoted_arm_id, so a promoted test could never be re-promoted and the row
// kept asserting a winner that had stopped serving.
{
  // TID is promoted onto arm b from section 5. Move the entry to arm a.
  const mv = await S('POST', `/${TID}/arms/${armId('a')}/entry`);
  ok(mv.status === 200, 'M6a entry moved to arm a', JSON.stringify(mv.j));
  const [t] = await sql`SELECT promoted_arm_id, promoted_at FROM lb_split_tests WHERE id = ${TID}`;
  ok(t.promoted_arm_id === null && t.promoted_at === null,
    'M6b moving the entry to a DIFFERENT arm RETRACTS the promotion', JSON.stringify(t));
  const again = await S('POST', `/${TID}/promote`, { arm_id: armId('a'), confirm: true });
  ok(again.status === 200 && again.j?.data?.promoted_arm_id === armId('a'),
    'M6c …so a second promote now SUCCEEDS (the 409 is no longer a dead end)', JSON.stringify(again.j?.error));
}
{
  // Re-enabling restarts the experiment, so the winner claim is retracted too.
  const re = await S('PATCH', `/${TID}`, { enabled: true });
  ok(re.status === 200, 'M6d test re-enabled', JSON.stringify(re.j?.error));
  const [t] = await sql`SELECT enabled, promoted_arm_id, promoted_at FROM lb_split_tests WHERE id = ${TID}`;
  ok(t.enabled === true && t.promoted_arm_id === null && t.promoted_at === null,
    'M6e re-enabling RETRACTS the promotion', JSON.stringify(t));
}
{
  // Archiving the promoted entry arm hands the entry on — the stamp goes too.
  await S('POST', `/${TID}/promote`, { arm_id: armId('b'), confirm: true });
  const arch = await S('PATCH', `/${TID}/arms/${armId('b')}`, { archived: true });
  ok(arch.status === 200, 'M6f promoted entry arm archived', JSON.stringify(arch.j));
  const [t] = await sql`SELECT promoted_arm_id FROM lb_split_tests WHERE id = ${TID}`;
  ok(t.promoted_arm_id === null, 'M6g …archiving the promoted arm RETRACTS the promotion too', JSON.stringify(t));
}

// ── MED #7: concurrent promote + archive never yields a false success ───────
// Before the fix the arm PATCH did NOT take the parent lock, so an archive
// could land between promote's read and promote's write: a 200 promote of an
// arm that no longer serves.
{
  let falseSuccess = null;
  for (let round = 0; round < 6 && !falseSuccess; round++) {
    const f = await F('POST', '/', { name: `Race ${round}`, slug: `race-fnl-${round}` });
    const FID2 = f.j.data.id;
    const pA = await F('POST', `/${FID2}/pages`, { title: 'RA', slug: '/ra', type: 'lead' });
    const pB = await F('POST', `/${FID2}/pages`, { title: 'RB', slug: '/rb', type: 'lead' });
    await F('PATCH', `/${FID2}/pages/${pA.j.data.id}`, { status: 'published' });
    await F('PATCH', `/${FID2}/pages/${pB.j.data.id}`, { status: 'published' });
    const t = await S('POST', '/', {
      funnel_id: FID2, name: `race ${round}`, scope: 'page', handle: `race-h-${round}`,
      arms: [
        { arm_key: 'a', weight: 1, page_id: pA.j.data.id, is_control: true, is_entry: true },
        { arm_key: 'b', weight: 1, page_id: pB.j.data.id },
        { arm_key: 'c', weight: 1, page_id: pB.j.data.id },
      ],
    });
    const rid = t.j.data.id;
    const rows = await sql`SELECT id, arm_key FROM lb_split_arms WHERE test_id = ${rid}`;
    const bId = rows.find((a) => a.arm_key === 'b').id;
    // Fire both at the same instant.
    const [promo, arch] = await Promise.all([
      S('POST', `/${rid}/promote`, { arm_id: bId, confirm: true }),
      S('PATCH', `/${rid}/arms/${bId}`, { archived: true }),
    ]);
    // THE INVARIANT IS ABOUT THE END STATE, NOT THE STATUS CODES.
    // Either order of these two requests is legal on its own — promote-then-
    // archive is a real thing an operator does. What must NEVER survive is a
    // test whose promoted_arm_id names an ARCHIVED arm (a winner that cannot
    // serve), or an entry arm that is archived (a live route pointing at a
    // retired page). Before the parent lock, the interleaving produced exactly
    // the first of those.
    const [armRow] = await sql`SELECT archived, is_entry FROM lb_split_arms WHERE id = ${bId}`;
    const [testRow] = await sql`SELECT promoted_arm_id, enabled FROM lb_split_tests WHERE id = ${rid}`;
    const entryRows = await sql`SELECT archived FROM lb_split_arms WHERE test_id = ${rid} AND is_entry`;
    if (testRow.promoted_arm_id === bId && armRow.archived) {
      falseSuccess = { round, why: 'promoted_arm_id names an ARCHIVED arm', promo: promo.status, arch: arch.status };
    } else if (entryRows.some((e) => e.archived)) {
      falseSuccess = { round, why: 'the ENTRY arm is archived', promo: promo.status, arch: arch.status };
    }
  }
  ok(!falseSuccess,
    'M7 6 concurrent promote+archive rounds never left a promoted-or-entry arm ARCHIVED',
    JSON.stringify(falseSuccess));
}

// ═══ Done ═════════════════════════════════════════════════════════════════
await sql.end();
server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
