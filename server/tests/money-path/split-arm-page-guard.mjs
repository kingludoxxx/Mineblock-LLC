// ROUTE-LEVEL verification of the arm-page assignment guard (review B1) —
// drives the REAL /api/v1/split-tests router (real authenticate +
// requirePermission + ensureSplitTables + the transaction and its parent-row
// lock) against embedded PG, exactly like the tracking admin-crud harness.
//
// PATCH /:id/arms/:armId { page_id } re-points a LIVE arm at another page. It
// is as money-meaning as /promote and had ZERO validation. This asserts BY
// EXECUTION that every refusal fires with its named code and its prose, that
// the happy path still lands, and — the case a mirror of listArmEligiblePages
// would miss — that a page already armed by THIS test is refused, because a
// split measuring X against X reports a real-looking difference that is noise
// by construction.
//
// Run:  node server/tests/money-path/split-arm-page-guard.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

// ── seed auth (mirrors admin-crud): a user with funnels:access ─────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_spg_test', 'spg@local.test', 'Spg', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_spg_test', 'split-guard-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_spg_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_spg_test', 'r_spg_test')`;

// Minimal funnel_pages (IF NOT EXISTS — harmless when the full DDL already ran).
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT, slug TEXT, type TEXT, title TEXT,
  status TEXT DEFAULT 'draft', archived BOOLEAN DEFAULT FALSE, is_home BOOLEAN DEFAULT FALSE
)`);

const splitRouter = (await import('../../src/routes/splitTests.js')).default;
const { ensureSplitTables } = await import('../../src/services/splitTestSchema.js');
await ensureSplitTables(q);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

const app = express();
app.use(express.json());
app.use('/api/v1/split-tests', splitRouter);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/v1/split-tests`;

const token = jwt.sign({ userId: 'u_spg_test' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};

const FID = 'fnl_spg';
const OTHER_FID = 'fnl_spg_other';
const TID = 'tst_spg';
const OTHER_TID = 'tst_spg_other';

// ── Fixture ────────────────────────────────────────────────────────────────
// One funnel, one live 2-arm test (a=control/entry on pg_a, b on pg_b), plus
// every shape the guard must refuse.
async function seed() {
  await q(`DELETE FROM lb_split_arms WHERE test_id IN ($1, $2)`, [TID, OTHER_TID]);
  await q(`DELETE FROM lb_split_tests WHERE id IN ($1, $2)`, [TID, OTHER_TID]);
  await q(`DELETE FROM funnel_pages WHERE funnel_id IN ($1, $2)`, [FID, OTHER_FID]);
  await q(
    `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, archived, is_home) VALUES
      ('pg_a',      $1, '/lp-a',  'lead',    'A',        'published', FALSE, FALSE),
      ('pg_b',      $1, '/lp-b',  'lead',    'B',        'published', FALSE, FALSE),
      ('pg_free',   $1, '/free',  'lead',    'Free',     'published', FALSE, FALSE),
      ('pg_draft',  $1, '/draft', 'lead',    'Draft',    'draft',     FALSE, FALSE),
      ('pg_home',   $1, '/',      'lead',    'Home',     'published', FALSE, TRUE),
      ('pg_upsell', $1, '/up',    'upsell',  'Upsell',   'published', FALSE, FALSE),
      ('pg_arch',   $1, '/arch',  'lead',    'Archived', 'published', TRUE,  FALSE),
      ('pg_other',  $1, '/other', 'lead',    'Other',    'published', FALSE, FALSE),
      ('pg_alien',  $2, '/alien', 'lead',    'Alien',    'published', FALSE, FALSE)`,
    [FID, OTHER_FID]
  );
  await q(
    `INSERT INTO lb_split_tests (id, funnel_id, name, scope, handle, enabled, archived) VALUES
      ($1, $3, 'guard test', 'page', 'spg', TRUE, FALSE),
      ($2, $3, 'other test', 'page', 'spg2', TRUE, FALSE)`,
    [TID, OTHER_TID, FID]
  );
  await q(
    `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, is_control, is_entry) VALUES
      ('spg_a', $1, 'a', 50, 'pg_a', TRUE,  TRUE),
      ('spg_b', $1, 'b', 50, 'pg_b', FALSE, FALSE),
      ('spg_o', $2, 'a', 100, 'pg_other', TRUE, TRUE)`,
    [TID, OTHER_TID]
  );
}
await seed();

const armPage = async (armId) => {
  const [row] = await q(`SELECT page_id FROM lb_split_arms WHERE id = $1`, [armId]);
  return row ? row.page_id : null;
};

// ── T1: every refusal — named code, prose, and NO write ────────────────────
const REFUSALS = [
  ['pg_draft', 'arm_page_not_published', 'a draft page'],
  ['pg_home', 'page_is_funnel_default', 'the funnel default page'],
  ['pg_upsell', 'page_post_purchase', 'a post-purchase page'],
  ['pg_arch', 'page_not_found', 'an archived page'],
  ['pg_alien', 'page_not_found', "another funnel's page"],
  ['pg_nope', 'page_not_found', 'a page id that does not exist'],
  ['pg_other', 'page_in_other_test', "a page armed by ANOTHER live test"],
  ['pg_a', 'page_already_an_arm', 'a page already armed by THIS test (X vs X)'],
];
for (const [pageId, code, label] of REFUSALS) {
  const before = await armPage('spg_b');
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: pageId });
  check(`T1 ${label} → 422 ${code}`, r.status === 422 && r.j?.error?.code === code, `${r.status} ${r.text}`);
  check(`T1 ${code} carries prose`, typeof r.j?.error?.message === 'string' && r.j.error.message.length > 20, JSON.stringify(r.j?.error));
  const after = await armPage('spg_b');
  check(`T1 ${code} wrote NOTHING`, before === after && after === 'pg_b', `${before} → ${after}`);
}

// ── T2: the happy path still lands ─────────────────────────────────────────
{
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_free' });
  check('T2 an eligible page is accepted → 200', r.status === 200, `${r.status} ${r.text}`);
  check('T2 the arm actually moved', (await armPage('spg_b')) === 'pg_free', String(await armPage('spg_b')));
  // ...and the page it just vacated becomes assignable again.
  const back = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_b' });
  check('T2 the vacated page is assignable again → 200', back.status === 200, `${back.status} ${back.text}`);
  check('T2 the arm moved back', (await armPage('spg_b')) === 'pg_b', String(await armPage('spg_b')));
}

// ── T3: re-assigning an arm to the page it ALREADY holds is not a duplicate ─
// The claim query excludes the arm being patched (a.id <> $3); without that
// exclusion this idempotent no-op write would refuse itself.
{
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_b' });
  check('T3 re-assigning an arm to its OWN page → 200 (not page_already_an_arm)', r.status === 200, `${r.status} ${r.text}`);
}

// ── T4: clearing an arm's page stays allowed ───────────────────────────────
// A page-less arm is dark and the resolver re-picks around it (split-delivery
// T13), so clearing is a retreat to a safe state, not a new reachable one.
{
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: null });
  check('T4 clearing page_id → 200', r.status === 200, `${r.status} ${r.text}`);
  check('T4 page_id is NULL', (await armPage('spg_b')) === null, String(await armPage('spg_b')));
  await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_b' });
}

// ── T5: an ARCHIVED arm of this test does not block its page ───────────────
// Only LIVE arms claim a page. Archiving arm B must release /lp-b, or a page
// could be permanently un-armable by a retired arm nobody can see.
{
  await q(`UPDATE lb_split_arms SET archived = TRUE, is_control = FALSE WHERE id = 'spg_b'`);
  await q(`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, is_control, is_entry)
           VALUES ('spg_c', $1, 'c', 50, 'pg_free', FALSE, FALSE)`, [TID]);
  const r = await req('PATCH', `/${TID}/arms/spg_c`, { page_id: 'pg_b' });
  check('T5 a page held only by an ARCHIVED arm is assignable → 200', r.status === 200, `${r.status} ${r.text}`);
  await q(`DELETE FROM lb_split_arms WHERE id = 'spg_c'`);
  await q(`UPDATE lb_split_arms SET archived = FALSE WHERE id = 'spg_b'`);
  await q(`UPDATE lb_split_arms SET page_id = 'pg_b' WHERE id = 'spg_b'`);
}

// ── T6: an ARCHIVED test does not block its pages either ───────────────────
{
  await q(`UPDATE lb_split_tests SET archived = TRUE WHERE id = $1`, [OTHER_TID]);
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_other' });
  check('T6 a page armed only by an ARCHIVED test is assignable → 200', r.status === 200, `${r.status} ${r.text}`);
  await q(`UPDATE lb_split_tests SET archived = FALSE WHERE id = $1`, [OTHER_TID]);
  await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_b' });
}

// ── T7: preconditions and hostile input ────────────────────────────────────
{
  const r1 = await req('PATCH', `/${TID}/arms/spg_missing`, { page_id: 'pg_free' });
  check('T7 unknown arm → 404 not_found (not a page refusal)', r1.status === 404 && r1.j?.error?.code === 'not_found', `${r1.status} ${r1.text}`);
  const r2 = await req('PATCH', '/tst_missing/arms/spg_b', { page_id: 'pg_free' });
  check('T7 unknown test → 404 not_found', r2.status === 404 && r2.j?.error?.code === 'not_found', `${r2.status} ${r2.text}`);
  const r3 = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: "pg_a' OR '1'='1" });
  check('T7 a SQL-ish page id → 422 page_not_found, never a 500', r3.status === 422 && r3.j?.error?.code === 'page_not_found', `${r3.status} ${r3.text}`);
  const r4 = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'x'.repeat(5000) });
  check('T7 an over-long page id → 422 page_not_found, never a 500', r4.status === 422 && r4.j?.error?.code === 'page_not_found', `${r4.status} ${r4.text}`);
  check('T7 the arm survived every hostile write', (await armPage('spg_b')) === 'pg_b', String(await armPage('spg_b')));
  const r5 = await req('PATCH', `/${TID}/arms/spg_b`, { page_id: 'pg_free' }, { 'Content-Type': 'application/json' });
  check('T7 no token → 401 (the guard is behind auth)', r5.status === 401, String(r5.status));
}

// ── T8: the OTHER writes on this endpoint are untouched by the guard ────────
{
  const r = await req('PATCH', `/${TID}/arms/spg_b`, { weight: 70 });
  check('T8 a weight-only patch still works', r.status === 200, `${r.status} ${r.text}`);
  const [row] = await q(`SELECT weight FROM lb_split_arms WHERE id = 'spg_b'`);
  check('T8 the weight actually moved', Number(row.weight) === 70, JSON.stringify(row));
  const r2 = await req('PATCH', `/${TID}/arms/spg_a`, { archived: true });
  check('T8 archiving the control is still refused (control_required)', r2.status === 422 && r2.j?.error?.code === 'control_required', `${r2.status} ${r2.text}`);
}

await q(`DELETE FROM lb_split_arms WHERE test_id IN ($1, $2)`, [TID, OTHER_TID]);
await q(`DELETE FROM lb_split_tests WHERE id IN ($1, $2)`, [TID, OTHER_TID]);
await q(`DELETE FROM funnel_pages WHERE funnel_id IN ($1, $2)`, [FID, OTHER_FID]);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
server.close();
await sql.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
