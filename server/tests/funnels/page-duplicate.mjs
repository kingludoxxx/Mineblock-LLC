// Route-level verification for POST /api/v1/funnels/:id/pages/:pageId/duplicate
// — the ATOMIC page copy that replaced the client's 2-call composite (create
// page, then PATCH blocks with the failure swallowed → silent empty copies).
//
// The REAL router file (REAL authenticate + requirePermission + ensureTables)
// mounted on a minimal express host, against a fresh embedded-PG database —
// same shape as page-thumbnails-route.mjs.
//
// Asserts BY EXECUTION: 401 without a token; a duplicate carries blocks + seo
// + every escape-hatch field in the SAME response row (and the same DB row);
// derived title/slug defaults; explicit title/slug overrides; a pinned-slug
// collision answers 409 and leaves NO partial row; a pageId belonging to a
// DIFFERENT funnel answers 404 and copies nothing (cross-funnel refusal); a
// missing page 404s; an archived page 404s; a malformed slug 400s; the copy
// is always a draft and never home.
//
// Run:  node server/tests/funnels/page-duplicate.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_pagedup';
const PORT = 48911;
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_pagedup`;
await admin`CREATE DATABASE puure_pagedup`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
});

const { default: express } = await import('express');
const { default: funnelsRoutes } = await import('../../src/routes/funnels.js');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 300));

const sql = postgres(DB, { ssl: false });
const { signAccessToken } = await import('../../src/utils/jwt.js');
const { ensureTables } = await import('../../src/routes/funnels.js');
await ensureTables();

// ---- Seed: user + funnels role (minimal tables the auth query touches) ----
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_dup','d@t.co','D','T')`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_dup','funnels-tester', ${sql.json({ funnels: ['access'] })})`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_dup','r_dup')`;
const TOKEN = signAccessToken({ userId: 'u_dup' });

const B = `http://127.0.0.1:${PORT}/api/v1/funnels`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
// JSONB normalizes object-key order, so equality must be canonical (sorted
// keys), not byte order.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

// ---- Seed: funnel A with a content-heavy source page, plus funnel B --------
const fa = await req('POST', '/', { name: 'Dup A', slug: 'dup-harness-a' });
const fb = await req('POST', '/', { name: 'Dup B', slug: 'dup-harness-b' });
ok(fa.status === 201 && fb.status === 201, 'seed: two funnels created', JSON.stringify({ a: fa.status, b: fb.status }));
const FA = fa.j?.data?.id;
const FB = fb.j?.data?.id;

const p1 = await req('POST', `/${FA}/pages`, { title: 'Source Lead', slug: '/', type: 'generic' });
ok(p1.status === 201, 'seed: source page created (home)', JSON.stringify(p1.j));
const P1 = p1.j?.data?.id;

const BLOCKS = [
  { type: 'hero', props: { headline: 'Buy the thing', sub: 'now' } },
  { type: 'text', props: { body: 'paragraph', nested: { deep: [1, 2, 3] } } },
];
const SEO = { title: 'Pinned title', description: 'desc' };
{
  const r = await req('PATCH', `/${FA}/pages/${P1}`, {
    blocks: BLOCKS, seo: SEO,
    custom_css: '.x{color:red}', custom_js: 'window.__z=1;',
    custom_html: '<div id="pre"></div>', head_html: '<meta name="h">', body_end_html: '<span id="tail"></span>',
    status: 'published',
  });
  ok(r.status === 200, 'seed: source page carries blocks/seo/escape-hatch fields', JSON.stringify(r.j));
}

// ---- auth gate -------------------------------------------------------------
{
  const r = await req('POST', `/${FA}/pages/${P1}/duplicate`, undefined, { 'Content-Type': 'application/json' });
  ok(r.status === 401, 'route: no token → 401', JSON.stringify(r));
}

// ---- the atomic copy -------------------------------------------------------
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${FA}`;
  const r = await req('POST', `/${FA}/pages/${P1}/duplicate`);
  ok(r.status === 201 && r.j?.success, 'route: duplicate → 201 {success,data}', JSON.stringify(r));
  const np = r.j?.data || {};
  ok(np.id && np.id !== P1, 'copy: new id, not the source id', np.id);
  ok(np.funnel_id === FA, 'copy: stays on the source funnel', np.funnel_id);
  ok(np.title === 'Source Lead copy', "copy: derived title is '<title> copy'", np.title);
  ok(/^\/generic-[0-9a-f]{4}$/.test(np.slug), "copy: derived slug is '/<type>-<hex4>'", np.slug);
  ok(np.status === 'draft', 'copy: always lands as a DRAFT (source was published)', np.status);
  ok(np.is_home === false, 'copy: never home (source WAS home)', String(np.is_home));
  ok(canon(np.blocks) === canon(BLOCKS), 'copy: blocks travel IN THE SAME response row', JSON.stringify(np.blocks));
  ok(canon(np.seo) === canon(SEO), 'copy: seo travels too', JSON.stringify(np.seo));
  ok(np.custom_css === '.x{color:red}' && np.custom_js === 'window.__z=1;'
    && np.custom_html === '<div id="pre"></div>' && np.head_html === '<meta name="h">'
    && np.body_end_html === '<span id="tail"></span>',
    'copy: every escape-hatch field travels');
  const row = await sql`SELECT blocks, custom_css FROM funnel_pages WHERE id = ${np.id}`;
  ok(canon(row[0]?.blocks) === canon(BLOCKS), 'db: the stored row has the blocks (not an empty copy)');
  const after = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${FA}`;
  ok(after[0].n === before[0].n + 1, 'db: exactly ONE new row', `${before[0].n} -> ${after[0].n}`);
}

// ---- explicit overrides ----------------------------------------------------
{
  const r = await req('POST', `/${FA}/pages/${P1}/duplicate`, { title: 'Named Copy', slug: '/named-copy' });
  ok(r.status === 201 && r.j?.data?.title === 'Named Copy' && r.j?.data?.slug === '/named-copy',
    'route: explicit title/slug overrides are honoured', JSON.stringify(r.j?.data && { t: r.j.data.title, s: r.j.data.slug }));
}

// ---- pinned-slug collision: 409, and NO partial row ------------------------
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${FA}`;
  const r = await req('POST', `/${FA}/pages/${P1}/duplicate`, { slug: '/named-copy' });
  ok(r.status === 409, 'route: pinned slug collision → 409 (never silently rewritten)', JSON.stringify(r));
  const after = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = ${FA}`;
  ok(after[0].n === before[0].n, 'db: the refused duplicate left NO partial row', `${before[0].n} -> ${after[0].n}`);
}

// ---- malformed input -------------------------------------------------------
{
  const r = await req('POST', `/${FA}/pages/${P1}/duplicate`, { slug: 'no-leading-slash' });
  ok(r.status === 400, 'route: malformed slug → 400', JSON.stringify(r));
  const r2 = await req('POST', `/${FA}/pages/${P1}/duplicate`, { title: '   ' });
  ok(r2.status === 400, 'route: blank title override → 400', JSON.stringify(r2));
}

// ---- cross-funnel refusal --------------------------------------------------
{
  const before = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`;
  const r = await req('POST', `/${FB}/pages/${P1}/duplicate`);
  ok(r.status === 404, "route: another funnel's pageId → 404 (cross-funnel refusal)", JSON.stringify(r));
  const after = await sql`SELECT COUNT(*)::int AS n FROM funnel_pages`;
  ok(after[0].n === before[0].n, 'db: the cross-funnel attempt copied NOTHING', `${before[0].n} -> ${after[0].n}`);
}

// ---- missing + archived sources -------------------------------------------
{
  const r = await req('POST', `/${FA}/pages/fpg_does_not_exist/duplicate`);
  ok(r.status === 404, 'route: missing page → 404', JSON.stringify(r));
}
{
  const pArch = await req('POST', `/${FA}/pages`, { title: 'Doomed', slug: '/doomed', type: 'generic' });
  const PA = pArch.j?.data?.id;
  const a = await req('POST', `/${FA}/pages/${PA}/archive`, { archived: true });
  ok(a.status === 200, 'seed: page archived', JSON.stringify(a));
  const r = await req('POST', `/${FA}/pages/${PA}/duplicate`);
  ok(r.status === 404, 'route: archived source → 404 (a retired page is not a template)', JSON.stringify(r));
}
{
  const r = await req('POST', `/fnl_missing/pages/${P1}/duplicate`);
  ok(r.status === 404, 'route: missing funnel → 404', JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await sql.end();
process.exit(fail ? 1 : 0);
