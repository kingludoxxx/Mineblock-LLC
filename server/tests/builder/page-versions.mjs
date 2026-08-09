// Route-level verification for /api/v1/page-versions — the builder's page
// snapshot / restore stack.
//
// The REAL routers (REAL authenticate + requirePermission + ensureTables +
// ensurePageVersionTables) mounted on a minimal express host against a fresh
// embedded-PG database — same shape as funnels/page-duplicate.mjs.
//
// Asserts BY EXECUTION:
//   • 401 without a token (every verb)
//   • snapshot → list → get → restore round-trip, blocks/css/js/seo/title
//     compared CANONICALLY (JSONB reorders object keys, so byte order is not
//     the invariant — canonical key order is)
//   • the list projection carries block_count + bytes and NEVER the blocks
//   • restore snapshots the CURRENT state FIRST (label 'before restore'), and
//     that snapshot holds the pre-restore content, not the restored content
//   • restore does NOT move slug/status/is_home (content-only by design)
//   • retention: 35 snapshots on one page leave exactly the newest 30
//   • cross-funnel refusal on all four verbs (404, and nothing written)
//   • confirm:true required (and 'true'/1 rejected)
//   • archived page → 404 on snapshot and list
//   • malformed versionId → 400, unknown versionId → 404
//   • a non-string label → 400
//   • a hostile __proto__ block payload cannot be restored (validateBlocks)
//   • an ARCHIVED FUNNEL is refused by all four verbs (400), an unknown
//     funnel by all four (404)
//   • a versionId at and above the int8 ceiling answers 404, never 500
//   • restoring the OLDEST version at the retention cap does not prune the
//     row being restored (the prune takes the next-oldest instead)
//   • the full-version GET applies the archived-page 404 the LIST verb does
//   • bytes is STORED at insert, and a legacy row with a NULL bytes lists as
//     null rather than as a fabricated 0
//
// Run:  node server/tests/builder/page-versions.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_pagever';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_pagever`;
await admin`CREATE DATABASE puure_pagever`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: funnelsRoutes, ensureTables } = await import('../../src/routes/funnels.js');
const { default: pageVersionsRoutes } = await import('../../src/routes/pageVersions.js');
const { VERSION_RETENTION } = await import('../../src/services/pageVersionsSchema.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRoutes);          // same mounts as routes/index.js
app.use('/api/v1/page-versions', pageVersionsRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
await ensureTables();

// ---- Seed: user + funnels role (minimal tables the auth query touches) ----
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_ver','v@t.co','V','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_ver','versions-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_ver','r_ver')`;
const TOKEN = signAccessToken({ userId: 'u_ver' });

const FB_ = `http://127.0.0.1:${PORT}/api/v1/funnels`;
const VB = `http://127.0.0.1:${PORT}/api/v1/page-versions`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// JSONB normalizes object-key order, so equality must be canonical.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const call = async (base) => async (method, path, body, headers = H) => {
  const r = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const freq = await call(FB_);
const vreq = await call(VB);

// ---- Seed: funnel A with a content-heavy page, plus funnel B --------------
const fa = await freq('POST', '/', { name: 'Ver A', slug: 'ver-harness-a' });
const fb = await freq('POST', '/', { name: 'Ver B', slug: 'ver-harness-b' });
ok(fa.status === 201 && fb.status === 201, 'seed: two funnels created', JSON.stringify({ a: fa.status, b: fb.status }));
const FA = fa.j?.data?.id;
const FB = fb.j?.data?.id;

const p1 = await freq('POST', `/${FA}/pages`, { title: 'Versioned', slug: '/', type: 'generic' });
ok(p1.status === 201, 'seed: page created', JSON.stringify(p1.j));
const P1 = p1.j?.data?.id;

// A page in funnel B — the cross-funnel decoy.
const pb = await freq('POST', `/${FB}/pages`, { title: 'Other funnel page', slug: '/', type: 'generic' });
ok(pb.status === 201, 'seed: decoy page in funnel B', JSON.stringify(pb.status));
const PB = pb.j?.data?.id;

const V1_BLOCKS = [
  { id: 'b1', type: 'heading', props: { text: 'Original headline', style: { font_size: 42 } } },
  { id: 'b2', type: 'text', props: { body: 'v1 body', nested: { deep: [1, 2, 3] } } },
];
const V1_SEO = { title: 'v1 seo title', description: 'v1 desc' };
{
  const r = await freq('PATCH', `/${FA}/pages/${P1}`, {
    blocks: V1_BLOCKS, seo: V1_SEO,
    custom_css: '.v1{color:red}', custom_js: 'window.__v=1;',
    title: 'Version One', status: 'published',
  });
  ok(r.status === 200, 'seed: page carries v1 content', JSON.stringify(r.j?.error || r.status));
}

// ---- auth gate: every verb ------------------------------------------------
{
  const noAuth = { 'Content-Type': 'application/json' };
  const a = await vreq('POST', `/${FA}/${P1}/snapshot`, {}, noAuth);
  const b = await vreq('GET', `/${FA}/${P1}`, undefined, noAuth);
  const c = await vreq('GET', `/${FA}/${P1}/1`, undefined, noAuth);
  const d = await vreq('POST', `/${FA}/${P1}/1/restore`, { confirm: true }, noAuth);
  ok(a.status === 401 && b.status === 401 && c.status === 401 && d.status === 401,
    'auth: all four verbs 401 without a token',
    JSON.stringify([a.status, b.status, c.status, d.status]));
}

// ---- snapshot -------------------------------------------------------------
let SNAP1 = null;
{
  const r = await vreq('POST', `/${FA}/${P1}/snapshot`, { label: 'before AI edit' });
  ok(r.status === 201 && r.j?.success, 'snapshot: → 201 {success,data}', JSON.stringify(r));
  SNAP1 = r.j?.data;
  ok(String(SNAP1?.label) === 'before AI edit', 'snapshot: label stored verbatim', SNAP1?.label);
  ok(SNAP1?.created_by === 'u_ver', 'snapshot: created_by is the caller', String(SNAP1?.created_by));
  ok(SNAP1?.page_id === P1 && SNAP1?.funnel_id === FA, 'snapshot: row is keyed to (page, funnel)');
  ok(Number(SNAP1?.id) > 0, 'snapshot: BIGSERIAL id returned', String(SNAP1?.id));
  ok(!('blocks' in (SNAP1 || {})), 'snapshot: response is metadata only, no blocks echoed');
}

// ---- list -----------------------------------------------------------------
{
  const r = await vreq('GET', `/${FA}/${P1}`);
  ok(r.status === 200 && Array.isArray(r.j?.data?.versions), 'list: → 200 {versions:[]}', JSON.stringify(r.status));
  const vs = r.j?.data?.versions || [];
  ok(vs.length === 1, 'list: exactly one version', String(vs.length));
  ok(r.j?.data?.retention === VERSION_RETENTION, 'list: reports the retention cap', String(r.j?.data?.retention));
  const v = vs[0] || {};
  ok(Number(v.block_count) === V1_BLOCKS.length, `list: block_count = ${V1_BLOCKS.length}`, String(v.block_count));
  ok(Number(v.bytes) > 0, 'list: bytes > 0', String(v.bytes));
  ok(!('blocks' in v) && !('custom_css' in v), 'list: NEVER carries blocks / css (the whole point of the projection)', Object.keys(v).join(','));
  ok(typeof v.created_at === 'string' || v.created_at instanceof Date, 'list: created_at present');
}

// ---- get full version: byte(canonical)-compare vs the live page -----------
{
  const r = await vreq('GET', `/${FA}/${P1}/${SNAP1.id}`);
  ok(r.status === 200, 'get: → 200', JSON.stringify(r.status));
  const v = r.j?.data || {};
  ok(canon(v.blocks) === canon(V1_BLOCKS), 'get: blocks canonical-identical to the page at snapshot time',
    `${canon(v.blocks)} !== ${canon(V1_BLOCKS)}`);
  ok(canon(v.seo) === canon(V1_SEO), 'get: seo canonical-identical', canon(v.seo));
  ok(v.custom_css === '.v1{color:red}', 'get: custom_css identical', v.custom_css);
  ok(v.custom_js === 'window.__v=1;', 'get: custom_js identical', v.custom_js);
  ok(v.title === 'Version One', 'get: title identical', v.title);
}

// ---- mutate the page, then restore ---------------------------------------
const V2_BLOCKS = [{ id: 'c1', type: 'text', props: { body: 'CLOBBERED v2' } }];
{
  const r = await freq('PATCH', `/${FA}/pages/${P1}`, {
    blocks: V2_BLOCKS, seo: { title: 'v2 seo' },
    custom_css: '.v2{color:blue}', custom_js: 'window.__v=2;', title: 'Version Two',
  });
  ok(r.status === 200, 'mutate: page moved to v2', JSON.stringify(r.j?.error || r.status));
}

// confirm gate — before the real restore, so a rejected call proves it wrote nothing
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P1}`;
  const noBody = await vreq('POST', `/${FA}/${P1}/${SNAP1.id}/restore`, {});
  const strTrue = await vreq('POST', `/${FA}/${P1}/${SNAP1.id}/restore`, { confirm: 'true' });
  const one = await vreq('POST', `/${FA}/${P1}/${SNAP1.id}/restore`, { confirm: 1 });
  ok(noBody.status === 400 && strTrue.status === 400 && one.status === 400,
    "restore: confirm must be BOOLEAN true ('true' and 1 rejected)",
    JSON.stringify([noBody.status, strTrue.status, one.status]));
  const after = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P1}`;
  ok(before[0].n === after[0].n, 'restore: a refused confirm wrote NO version row',
    `${before[0].n} → ${after[0].n}`);
  const live = await sql`SELECT blocks FROM funnel_pages WHERE id = ${P1}`;
  ok(canon(live[0].blocks) === canon(V2_BLOCKS), 'restore: a refused confirm left the page on v2');
}

let PRE_RESTORE_ID = null;
{
  const r = await vreq('POST', `/${FA}/${P1}/${SNAP1.id}/restore`, { confirm: true });
  ok(r.status === 200 && r.j?.success, 'restore: → 200 {success,data}', JSON.stringify(r));
  const page = r.j?.data?.page || {};
  ok(canon(page.blocks) === canon(V1_BLOCKS), 'restore: returned page carries the v1 blocks', canon(page.blocks));
  ok(page.custom_css === '.v1{color:red}', 'restore: custom_css rolled back', page.custom_css);
  ok(page.custom_js === 'window.__v=1;', 'restore: custom_js rolled back', page.custom_js);
  ok(canon(page.seo) === canon(V1_SEO), 'restore: seo rolled back', canon(page.seo));
  ok(page.title === 'Version One', 'restore: title rolled back', page.title);
  ok(Number(r.j?.data?.restored_version_id) === Number(SNAP1.id), 'restore: reports which version it restored');
  PRE_RESTORE_ID = Number(r.j?.data?.pre_restore_version_id);
  ok(PRE_RESTORE_ID > Number(SNAP1.id), 'restore: reports the pre-restore snapshot id', String(PRE_RESTORE_ID));

  // The DB, not just the response.
  const live = await sql`SELECT blocks, custom_css, title, slug, status, is_home FROM funnel_pages WHERE id = ${P1}`;
  ok(canon(live[0].blocks) === canon(V1_BLOCKS), 'restore: the DB row holds v1 blocks');
  ok(live[0].slug === '/' && live[0].status === 'published' && live[0].is_home === true,
    'restore: slug/status/is_home UNTOUCHED (content-only restore)',
    JSON.stringify({ slug: live[0].slug, status: live[0].status, is_home: live[0].is_home }));
}

// ---- restore snapshotted the CURRENT state FIRST --------------------------
{
  const r = await vreq('GET', `/${FA}/${P1}/${PRE_RESTORE_ID}`);
  ok(r.status === 200, 'pre-restore snapshot: readable', JSON.stringify(r.status));
  const v = r.j?.data || {};
  ok(v.label === 'before restore', "pre-restore snapshot: label is 'before restore'", v.label);
  ok(canon(v.blocks) === canon(V2_BLOCKS),
    'pre-restore snapshot: holds the PRE-restore (v2) content, not the restored content', canon(v.blocks));
  ok(v.custom_css === '.v2{color:blue}', 'pre-restore snapshot: css is the v2 css', v.custom_css);

  const list = await vreq('GET', `/${FA}/${P1}`);
  ok((list.j?.data?.versions || []).length === 2, 'list: two versions after the restore',
    String((list.j?.data?.versions || []).length));
  ok(Number(list.j?.data?.versions?.[0]?.id) === PRE_RESTORE_ID, 'list: newest-first ordering');
}

// ---- retention: newest 30 per page ---------------------------------------
{
  // 2 rows exist; push well past the cap.
  const TARGET = VERSION_RETENTION + 5;
  for (let i = 0; i < TARGET; i++) {
    const r = await vreq('POST', `/${FA}/${P1}/snapshot`, { label: `bulk-${i}` });
    if (r.status !== 201) { ok(false, `retention: bulk snapshot ${i} failed`, JSON.stringify(r)); break; }
  }
  const rows = await sql`SELECT id, label FROM lb_page_versions WHERE page_id = ${P1} ORDER BY id DESC`;
  ok(rows.length === VERSION_RETENTION, `retention: exactly ${VERSION_RETENTION} rows survive`, String(rows.length));
  ok(rows[0].label === `bulk-${TARGET - 1}`, 'retention: the NEWEST snapshot survived', rows[0].label);
  const oldest = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P1} AND id <= ${PRE_RESTORE_ID}`;
  ok(oldest[0].n === 0, 'retention: the oldest rows were pruned inside the write', String(oldest[0].n));
  const list = await vreq('GET', `/${FA}/${P1}`);
  ok((list.j?.data?.versions || []).length === VERSION_RETENTION,
    'retention: the list agrees with the table', String((list.j?.data?.versions || []).length));

  // Retention is PER PAGE — funnel B's page must be untouched by A's burst.
  await vreq('POST', `/${FB}/${PB}/snapshot`, { label: 'other-page' });
  const bRows = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${PB}`;
  ok(bRows[0].n === 1, 'retention: the prune is scoped to one page', String(bRows[0].n));
}

// A live version id on page A, for the cross-funnel probes.
const LIVE_ID = Number((await sql`SELECT id FROM lb_page_versions WHERE page_id = ${P1} ORDER BY id DESC LIMIT 1`)[0].id);

// ---- cross-funnel refusal -------------------------------------------------
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions`;
  const snap = await vreq('POST', `/${FB}/${P1}/snapshot`, { label: 'stolen' });
  const list = await vreq('GET', `/${FB}/${P1}`);
  const get = await vreq('GET', `/${FB}/${P1}/${LIVE_ID}`);
  const rest = await vreq('POST', `/${FB}/${P1}/${LIVE_ID}/restore`, { confirm: true });
  ok(snap.status === 404 && list.status === 404 && get.status === 404 && rest.status === 404,
    'cross-funnel: all four verbs 404 for a page in another funnel',
    JSON.stringify([snap.status, list.status, get.status, rest.status]));
  const after = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions`;
  ok(before[0].n === after[0].n, 'cross-funnel: nothing was written', `${before[0].n} → ${after[0].n}`);
  const live = await sql`SELECT blocks FROM funnel_pages WHERE id = ${P1}`;
  ok(canon(live[0].blocks) === canon(V1_BLOCKS), 'cross-funnel: the target page was not modified');
}

// ---- malformed / missing ids ---------------------------------------------
{
  const bad = await vreq('GET', `/${FA}/${P1}/not-a-number`);
  ok(bad.status === 400, 'ids: a non-numeric versionId is 400, not 500', JSON.stringify(bad));
  const badRestore = await vreq('POST', `/${FA}/${P1}/abc/restore`, { confirm: true });
  ok(badRestore.status === 400, 'ids: a non-numeric versionId on restore is 400', JSON.stringify(badRestore.status));
  const missing = await vreq('GET', `/${FA}/${P1}/999999999`);
  ok(missing.status === 404, 'ids: an unknown versionId is 404', JSON.stringify(missing.status));
  const missingRestore = await vreq('POST', `/${FA}/${P1}/999999999/restore`, { confirm: true });
  ok(missingRestore.status === 404, 'ids: restoring an unknown versionId is 404', JSON.stringify(missingRestore.status));
  const ghostPage = await vreq('POST', `/${FA}/fpg_does_not_exist/snapshot`, {});
  ok(ghostPage.status === 404, 'ids: snapshotting a non-existent page is 404', JSON.stringify(ghostPage.status));
}

// ---- label validation -----------------------------------------------------
{
  const bad = await vreq('POST', `/${FA}/${P1}/snapshot`, { label: { evil: true } });
  ok(bad.status === 400, 'label: a non-string label is 400', JSON.stringify(bad));
  const none = await vreq('POST', `/${FA}/${P1}/snapshot`, {});
  ok(none.status === 201 && none.j?.data?.label === '', "label: absent → '' default", JSON.stringify(none.j?.data?.label));
  const long = await vreq('POST', `/${FA}/${P1}/snapshot`, { label: 'x'.repeat(500) });
  ok(long.status === 201 && long.j?.data?.label.length === 120, 'label: capped at 120 chars', String(long.j?.data?.label?.length));
}

// ---- archived page --------------------------------------------------------
{
  const pa = await freq('POST', `/${FA}/pages`, { title: 'To archive', slug: '/archive-me', type: 'generic' });
  const PA = pa.j?.data?.id;
  const s1 = await vreq('POST', `/${FA}/${PA}/snapshot`, { label: 'pre-archive' });
  ok(s1.status === 201, 'archived: a live page snapshots fine first', JSON.stringify(s1.status));
  await sql`UPDATE funnel_pages SET archived = TRUE WHERE id = ${PA}`;
  const s2 = await vreq('POST', `/${FA}/${PA}/snapshot`, { label: 'post-archive' });
  const l2 = await vreq('GET', `/${FA}/${PA}`);
  const r2 = await vreq('POST', `/${FA}/${PA}/${s1.j.data.id}/restore`, { confirm: true });
  ok(s2.status === 404 && l2.status === 404 && r2.status === 404,
    'archived: snapshot / list / restore all 404 on an archived page',
    JSON.stringify([s2.status, l2.status, r2.status]));
}

// ---- versions whose blocks cannot be restored ------------------------------
// Written straight to the table (the route can never produce these) — restore
// must REFUSE, must not have taken a pre-restore snapshot on the way out, and
// must NEVER degrade to writing an empty page.
const refusalProbe = async (label, blocksParam, name, needle) => {
  const inserted = await sql`
    INSERT INTO lb_page_versions (page_id, funnel_id, blocks, custom_css, custom_js, seo, title, label)
    VALUES (${P1}, ${FA}, ${blocksParam}, '', '', ${sql.json({})}, '', ${label})
    RETURNING id`;
  const badId = Number(inserted[0].id);
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P1}`;
  const liveBefore = await sql`SELECT blocks FROM funnel_pages WHERE id = ${P1}`;
  const r = await vreq('POST', `/${FA}/${P1}/${badId}/restore`, { confirm: true });
  ok(r.status === 422, `${name}: restore is REFUSED with 422, never 500`, JSON.stringify(r));
  ok(needle.test(String(r.j?.error || '')), `${name}: the refusal names the reason`, String(r.j?.error));
  const after = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P1}`;
  ok(before[0].n === after[0].n, `${name}: the refusal wrote NO pre-restore row`,
    `${before[0].n} → ${after[0].n}`);
  const liveAfter = await sql`SELECT blocks FROM funnel_pages WHERE id = ${P1}`;
  ok(canon(liveBefore[0].blocks) === canon(liveAfter[0].blocks) && (liveAfter[0].blocks || []).length > 0,
    `${name}: the live page still holds its blocks (NOT wiped to [])`, canon(liveAfter[0].blocks));
};

// (a) prototype-pollution key. JSON.parse — not an object literal — is what
// makes `__proto__` an OWN key; `{__proto__: …}` in source sets the prototype
// and produces no own key at all, so the probe would prove nothing.
await refusalProbe(
  'hand-written-proto',
  sql.json(JSON.parse('[{"type":"text","props":{"__proto__":{"polluted":1}}}]')),
  'hostile version',
  /forbidden key/
);

// (b) a blocks column that is not an ARRAY at all (JSONB scalar). The wipe
// guard: coercing this to [] would silently empty the operator's live page.
await refusalProbe(
  'hand-written-scalar',
  '[{"type":"text","props":{}}]', // a bare JS string binds as a JSONB *string*
  'non-array version',
  /must be an array/
);

// ---- F3: an ARCHIVED FUNNEL is closed to all four verbs -------------------
// funnels.js refuses page mutations on an archived funnel (404 missing / 400
// archived). Versioning holds the same line rather than half-opening on a
// funnel every other surface treats as trashed.
{
  const fc = await freq('POST', '/', { name: 'Ver C', slug: 'ver-harness-c' });
  const FC = fc.j?.data?.id;
  const pc = await freq('POST', `/${FC}/pages`, { title: 'Archived funnel page', slug: '/', type: 'generic' });
  const PC = pc.j?.data?.id;
  const seed = await vreq('POST', `/${FC}/${PC}/snapshot`, { label: 'pre-archive-funnel' });
  ok(seed.status === 201, 'archived funnel: a live funnel snapshots fine first', JSON.stringify(seed.status));
  const VC = seed.j?.data?.id;

  await sql`UPDATE funnels SET archived = TRUE WHERE id = ${FC}`;
  const before = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${PC}`;

  const snap = await vreq('POST', `/${FC}/${PC}/snapshot`, { label: 'post-archive-funnel' });
  const list = await vreq('GET', `/${FC}/${PC}`);
  const get = await vreq('GET', `/${FC}/${PC}/${VC}`);
  const rest = await vreq('POST', `/${FC}/${PC}/${VC}/restore`, { confirm: true });
  ok(snap.status === 400 && list.status === 400 && get.status === 400 && rest.status === 400,
    'archived funnel: all four verbs answer 400',
    JSON.stringify([snap.status, list.status, get.status, rest.status]));
  ok([snap, list, get, rest].every((r) => /Funnel is archived/.test(String(r.j?.error || ''))),
    'archived funnel: the message matches the funnels router wording',
    JSON.stringify([snap.j?.error, list.j?.error, get.j?.error, rest.j?.error]));
  const after = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${PC}`;
  ok(before[0].n === after[0].n, 'archived funnel: nothing was written', `${before[0].n} -> ${after[0].n}`);

  // …and an UNKNOWN funnel is a 404 on every verb, not a 400.
  const g = 'fnl_does_not_exist';
  const r404 = [
    await vreq('POST', `/${g}/${PC}/snapshot`, {}),
    await vreq('GET', `/${g}/${PC}`),
    await vreq('GET', `/${g}/${PC}/${VC}`),
    await vreq('POST', `/${g}/${PC}/${VC}/restore`, { confirm: true }),
  ];
  ok(r404.every((r) => r.status === 404), 'unknown funnel: all four verbs answer 404',
    JSON.stringify(r404.map((r) => r.status)));
}

// ---- F4: the int8 ceiling is a MISSING row, not a server fault -------------
{
  const MAX = '9223372036854775807';        // int8 max — a legal bind, no such row
  const OVER = '9223372036854775808';       // one past it — the bind itself throws
  const atMax = await vreq('GET', `/${FA}/${P1}/${MAX}`);
  const overMax = await vreq('GET', `/${FA}/${P1}/${OVER}`);
  ok(atMax.status === 404, 'bigint: versionId AT the int8 ceiling → 404', JSON.stringify(atMax));
  ok(overMax.status === 404, 'bigint: versionId ABOVE the int8 ceiling → 404, never 500', JSON.stringify(overMax));
  const restOver = await vreq('POST', `/${FA}/${P1}/${OVER}/restore`, { confirm: true });
  ok(restOver.status === 404, 'bigint: restoring above the ceiling → 404, never 500', JSON.stringify(restOver.status));
  const twenty = await vreq('GET', `/${FA}/${P1}/${'9'.repeat(20)}`);
  ok(twenty.status === 400, 'bigint: a 20-digit id is malformed (400), not a lookup', JSON.stringify(twenty.status));
}

// ---- F5: restoring the OLDEST row at the cap must not prune that row -------
{
  const p5 = await freq('POST', `/${FA}/pages`, { title: 'Retention restore', slug: '/retention-restore', type: 'generic' });
  const P5 = p5.j?.data?.id;
  await freq('PATCH', `/${FA}/pages/${P5}`, { blocks: [{ id: 'r1', type: 'text', props: { body: 'seed' } }] });
  for (let i = 0; i < VERSION_RETENTION; i++) {
    await vreq('POST', `/${FA}/${P5}/snapshot`, { label: `ret-${i}` });
  }
  const rows = await sql`SELECT id, label FROM lb_page_versions WHERE page_id = ${P5} ORDER BY id ASC`;
  ok(rows.length === VERSION_RETENTION, `F5 seed: page sits exactly at the cap (${VERSION_RETENTION})`, String(rows.length));
  const OLDEST = Number(rows[0].id);
  const NEXT_OLDEST = Number(rows[1].id);

  const r = await vreq('POST', `/${FA}/${P5}/${OLDEST}/restore`, { confirm: true });
  ok(r.status === 200, 'F5: restoring the oldest version succeeds', JSON.stringify(r.status));
  ok(Number(r.j?.data?.restored_version_id) === OLDEST, 'F5: it reports the oldest id', String(r.j?.data?.restored_version_id));

  const survived = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE id = ${OLDEST}`;
  ok(survived[0].n === 1,
    'F5: the restored row SURVIVED the prune (restored_version_id points at a live row)', String(survived[0].n));
  const gone = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE id = ${NEXT_OLDEST}`;
  ok(gone[0].n === 0, 'F5: the prune took the NEXT-oldest instead', String(gone[0].n));
  const total = await sql`SELECT COUNT(*)::int AS n FROM lb_page_versions WHERE page_id = ${P5}`;
  ok(total[0].n === VERSION_RETENTION,
    `F5: the page is still exactly at the cap (${VERSION_RETENTION}), not one over`, String(total[0].n));
  // And it is still readable through the API, which is what the drawer does
  // right after a restore.
  const readBack = await vreq('GET', `/${FA}/${P5}/${OLDEST}`);
  ok(readBack.status === 200, 'F5: the restored version is still fetchable', JSON.stringify(readBack.status));
}

// ---- F11: the full-version GET applies the archived-PAGE 404 too ----------
{
  const pz = await freq('POST', `/${FA}/pages`, { title: 'Archive for get', slug: '/archive-get', type: 'generic' });
  const PZ = pz.j?.data?.id;
  const s1 = await vreq('POST', `/${FA}/${PZ}/snapshot`, { label: 'pre' });
  const VZ = s1.j?.data?.id;
  const okBefore = await vreq('GET', `/${FA}/${PZ}/${VZ}`);
  ok(okBefore.status === 200, 'F11: the version reads fine while the page is live', JSON.stringify(okBefore.status));
  await sql`UPDATE funnel_pages SET archived = TRUE WHERE id = ${PZ}`;
  const getAfter = await vreq('GET', `/${FA}/${PZ}/${VZ}`);
  const listAfter = await vreq('GET', `/${FA}/${PZ}`);
  ok(getAfter.status === 404 && listAfter.status === 404,
    'F11: GET full version and LIST agree once the page is archived',
    JSON.stringify([getAfter.status, listAfter.status]));
}

// ---- F12: bytes is STORED at insert, not recomputed per list --------------
{
  const pb2 = await freq('POST', `/${FA}/pages`, { title: 'Bytes', slug: '/bytes-check', type: 'generic' });
  const PB2 = pb2.j?.data?.id;
  const BLK = [{ id: 'x1', type: 'text', props: { body: 'measure me' } }];
  await freq('PATCH', `/${FA}/pages/${PB2}`, { blocks: BLK, custom_css: '.a{}', title: 'Bytes' });
  const snap = await vreq('POST', `/${FA}/${PB2}/snapshot`, { label: 'bytes' });
  ok(snap.status === 201, 'F12 seed: snapshot taken', JSON.stringify(snap.status));

  const stored = await sql`SELECT bytes FROM lb_page_versions WHERE id = ${Number(snap.j.data.id)}`;
  ok(Number(stored[0].bytes) > 0, 'F12: bytes is persisted as a COLUMN at insert time', String(stored[0].bytes));

  const list = await vreq('GET', `/${FA}/${PB2}`);
  const row = (list.j?.data?.versions || [])[0];
  ok(Number(row.bytes) === Number(stored[0].bytes), 'F12: the list reads the stored column verbatim',
    `${row.bytes} vs ${stored[0].bytes}`);

  // The size must still be TRUE, not just present: it is the octet count of
  // the content, so it has to move when the content moves.
  await freq('PATCH', `/${FA}/pages/${PB2}`, { blocks: [...BLK, { id: 'x2', type: 'text', props: { body: 'y'.repeat(500) } }] });
  const snap2 = await vreq('POST', `/${FA}/${PB2}/snapshot`, { label: 'bytes-2' });
  const stored2 = await sql`SELECT bytes FROM lb_page_versions WHERE id = ${Number(snap2.j.data.id)}`;
  ok(Number(stored2[0].bytes) > Number(stored[0].bytes) + 400,
    'F12: bytes tracks the actual content size', `${stored[0].bytes} -> ${stored2[0].bytes}`);

  // A row written before the column existed carries NULL — the list must pass
  // that through as null so the client renders an em dash, NOT a fabricated 0
  // (which would read as "this version is empty").
  await sql`UPDATE lb_page_versions SET bytes = NULL WHERE id = ${Number(snap.j.data.id)}`;
  const list2 = await vreq('GET', `/${FA}/${PB2}`);
  const legacy = (list2.j?.data?.versions || []).find((v) => Number(v.id) === Number(snap.j.data.id));
  ok(legacy && legacy.bytes === null, 'F12: a legacy NULL bytes crosses the wire as null, never as 0',
    JSON.stringify(legacy?.bytes));
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await sql.end();
process.exit(fail ? 1 : 0);
