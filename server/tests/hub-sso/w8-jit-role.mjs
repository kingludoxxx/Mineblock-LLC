// W8b (server half) — WHAT ROLE DOES THE HUB'S JIT USER GET?
//
// Ludo hopped into the brand-new Throwaway store through the hub and the home page answered
// "Request failed with status code 403". The client half of that is the ungated request (fixed in
// client/src/pages/Dashboard.jsx). THIS file is the other half: the role the exchange hands a
// just-in-time user.
//
// Measured on the tree before this lane (the RED run in briefs/out/PROOF-W8.md): migration 126 seeds
// hub_role_map with owner -> 'Admin' and operator -> 'Manager'. Those two roles come from
// seeds/seed_roles.js and their permissions are {users, departments, audit, settings} and
// {departments, audit} — NEITHER carries `dashboard:access`, and the dashboard's pages are gated on
// page-level keys (migration 031). So the operator the hub calls the OWNER of a store arrived in that
// store with a role that opens no page in the sidebar at all.
//
// What is proved here, against the REAL /api/v1/hub-sso router on a fresh Postgres built from the REAL
// migrations off disk:
//   J1  hub `owner`    -> the store's FULL-ACCESS role, and that role really carries dashboard:access
//   J2  hub `admin`    -> the same full-access role (a hub admin is not the dashboard's user-admin role)
//   J3  hub `operator` -> the next one down: the production tools, and NOT the revenue pages
//   J4  hub `viewer`   -> a read-only role: no page key carries a write action
//   J5  FAIL CLOSED: an unknown hub role, and a ticket with no role at all, both land on viewer level
//   J6  IDEMPOTENT for an existing user: a second hop changes no role, and a user whose roles diverge
//       from the map keeps them — but the divergence is AUDITED, never silent
//   J7  the map is DATA (R5): re-pointing one hub_role_map row changes the next JIT user, no deploy
//   J8  the seeded map names only roles that exist, so no hop can 403 on a missing role name
//
// W8c (migration 134) — LUDO'S DECISION (2026-09-11): the hub OWNER must see the KPIs of the store it
// enters. W8b deliberately did NOT widen `Team - Full Access`, because every existing holder of that role
// on the two live dashboards would have silently gained the revenue figures. 134 therefore mints a NEW
// role, `Hub Owner` = `Team - Full Access`'s permission set copied at migration time + `kpi-system:access`,
// and re-points `owner` at it. Proved here:
//   J1  hub `owner` -> Hub Owner, and that role carries dashboard + orders + kpi-system:access
//   J1c NEGATIVE CONTROL: `Team - Full Access` still LACKS kpi-system:access — no existing role widened
//   J2  hub `admin` still -> Team - Full Access (a hub admin is not handed the revenue figures by SSO)
//   J9  the map rows for admin / operator / editor / viewer / * are byte-identical to what 133 leaves
//   K   re-applying 134 is a no-op: no role, no permission, no map row, no user_role changes; a store
//       that re-pointed `owner` itself keeps its choice; a store that edited `Hub Owner` keeps its edit
//   L   FAILURE PATH, run down: on a database with no `Team - Full Access` row at all, 134 still creates
//       `Hub Owner` from migration 031's page keys + kpi-system:access and says so in a NOTICE
//
// Run:  node server/tests/hub-sso/w8-jit-role.mjs
// test-timeout: 180s
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.W8_TEST_DB || 'postgres://postgres@127.0.0.1:5433/lane_w8_sso';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(16).toString('hex');
const PORT = 48957;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT),
  JWT_ACCESS_SECRET: 'w8-access-' + crypto.randomBytes(8).toString('hex'),
  JWT_REFRESH_SECRET: 'w8-refresh-' + crypto.randomBytes(8).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1',
  STORE_CODE: 'TW',
  HUB_ORIGIN: 'https://hub.example.test',
  HUB_SSO_ENABLED: '1',
  HUB_SSO_SECRET: SECRET,
});

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${x}` : ''); } };

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
// The real migrations, off disk, in order. 031 is the one that creates the page-level team roles this
// mapping points at; 126 creates hub_role_map; 133 is this lane's re-point.
const MIGS = [
  '001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql',
  '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql',
  '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql',
  '031_seed_page_permissions.sql', '076_team_invitations.sql', '086_add_orders_permission.sql',
  '126_hub_sso.sql', '132_session_hub_stores.sql', '133_hub_role_map_page_roles.sql',
  '134_hub_owner_kpi_role.sql',
];
for (const f of MIGS) {
  try { await pool.query(await readFile(join(REPO, 'server/migrations', f), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') { console.log(`FAIL  migration ${f} does not exist yet (this is the RED state)`); fail++; }
    else throw e;
  }
}
const { seedRoles, pool: seedPool } = await import('../../seeds/seed_roles.js');
await seedRoles(); await seedPool.end();

const q = async (sql, params) => (await pool.query(sql, params)).rows;

// ── the app ────────────────────────────────────────────────────────────────
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: hubSsoRoutes } = await import('../../src/routes/hubSso.js');
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/hub-sso', hubSsoRoutes);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}) {
  const payload = {
    email: `w8-${crypto.randomBytes(5).toString('hex')}@example.test`,
    store_code: 'TW', exp: Math.floor(Date.now() / 1000) + 30,
    nonce: crypto.randomBytes(16).toString('hex'), role: 'owner',
    ...over,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', SECRET).update(bytes).digest();
  return { ticket: `${b64u(bytes)}.${b64u(sig)}`, payload };
}

async function hop(over = {}) {
  const { ticket, payload } = mint(over);
  const r = await fetch(`${BASE}/api/v1/hub-sso/exchange`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: 'https://hub.example.test' },
    body: JSON.stringify({ ticket, next: '/app/dashboard' }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* a 302 has no body */ }
  return { status: r.status, body, email: payload.email };
}

const rolesOf = async (email) => (await q(
  `SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
    WHERE lower(u.email) = $1 ORDER BY r.name`, [email.toLowerCase()])).map((x) => x.name);
const permsOf = async (roleName) => {
  const rows = await q('SELECT permissions FROM roles WHERE name = $1', [roleName]);
  if (!rows[0]) return null;
  const p = rows[0].permissions;
  return typeof p === 'string' ? JSON.parse(p) : p;
};
const grants = (perms, key, action = 'access') => {
  if (!perms) return false;
  if (Array.isArray(perms['*']) && perms['*'].includes('*')) return true;
  const a = perms[key];
  return Array.isArray(a) && (a.includes(action) || a.includes('*'));
};

// The store's full-access role, as named in the roles table (migration 031).
const FULL = 'Team - Full Access';
const NEXT_DOWN = 'Team - Production';
const READ_ONLY = 'Viewer';
// W8c: the role migration 134 mints so the hub's owner sees the KPIs without widening FULL.
const HUB_OWNER = 'Hub Owner';
const MIG_134 = '134_hub_owner_kpi_role.sql';
let SQL_134 = null;
try { SQL_134 = await readFile(join(REPO, 'server/migrations', MIG_134), 'utf8'); } catch { /* RED state */ }
const permKeys = (p) => Object.keys(p || {}).sort().join(',');

const SEEDED_MAP = await q('SELECT hub_role, dashboard_role FROM hub_role_map ORDER BY hub_role');
console.log('hub_role_map as the migrations seed it:');
for (const r of SEEDED_MAP) console.log(`   ${r.hub_role.padEnd(10)} -> ${r.dashboard_role}`);
console.log('');

try {
  // ── J1 owner ─────────────────────────────────────────────────────────────
  const owner = await hop({ role: 'owner' });
  const ownerRoles = await rolesOf(owner.email);
  ok(owner.status === 302, 'J1: an owner ticket is accepted', `status=${owner.status} body=${JSON.stringify(owner.body)}`);
  ok(ownerRoles.length === 1 && ownerRoles[0] === HUB_OWNER,
    `J1: hub owner -> ${HUB_OWNER}`, `got ${JSON.stringify(ownerRoles)}`);
  const hoPerms = await permsOf(HUB_OWNER);
  const fullPerms = await permsOf(FULL);
  ok(grants(hoPerms, 'dashboard'),
    'J1: that role really opens the home page (dashboard:access)', `perms=${JSON.stringify(hoPerms)}`);
  ok(grants(hoPerms, 'orders'), 'J1: and the revenue pages a store owner needs (orders:access)',
    `perms=${JSON.stringify(hoPerms)}`);
  ok(grants(hoPerms, 'kpi-system'),
    'J1b: W8c — and the KPI block / CEO Office (kpi-system:access), which is why 134 exists',
    `perms=${JSON.stringify(hoPerms)}`);

  // ── J1c NEGATIVE CONTROL — no EXISTING role was widened ──────────────────
  ok(fullPerms !== null && !grants(fullPerms, 'kpi-system'),
    `J1c: NEGATIVE CONTROL — ${FULL} still does NOT carry kpi-system:access`,
    `perms=${JSON.stringify(fullPerms)}`);
  const widened = await q(
    `SELECT name FROM roles WHERE name <> $1 AND name <> 'SuperAdmin'
        AND permissions ? 'kpi-system' ORDER BY name`, [HUB_OWNER]);
  ok(widened.length === 0,
    'J1c: kpi-system:access is carried by NO role but Hub Owner (SuperAdmin holds {"*":["*"]})',
    JSON.stringify(widened));
  ok(permKeys(hoPerms) === permKeys({ ...(fullPerms || {}), 'kpi-system': ['access'] }),
    `J1d: ${HUB_OWNER} is exactly ${FULL}'s key set PLUS kpi-system, nothing else`,
    `hubOwner=${permKeys(hoPerms)}\n      expected=${permKeys({ ...(fullPerms || {}), 'kpi-system': ['access'] })}`);
  const sameActions = Object.entries(fullPerms || {}).every(
    ([k, v]) => JSON.stringify((hoPerms || {})[k]) === JSON.stringify(v));
  ok(fullPerms !== null && sameActions,
    `J1d: and every key it copied carries the SAME actions as ${FULL}`,
    `hubOwner=${JSON.stringify(hoPerms)}`);

  // ── J2 admin ─────────────────────────────────────────────────────────────
  const admin = await hop({ role: 'admin' });
  ok((await rolesOf(admin.email)).join() === FULL, `J2: hub admin -> ${FULL}`, `got ${JSON.stringify(await rolesOf(admin.email))}`);
  // W8c DECISION: `admin` is NOT moved to Hub Owner. Ludo's decision names the OWNER; a hub admin
  // administers the store and is not handed the revenue figures by an SSO hop.
  ok(!grants(await permsOf(FULL), 'kpi-system'),
    'J2: and a hub admin therefore does NOT get kpi-system through the map');

  // ── J3 operator ──────────────────────────────────────────────────────────
  const op = await hop({ role: 'operator' });
  const opRoles = await rolesOf(op.email);
  ok(opRoles.join() === NEXT_DOWN, `J3: hub operator -> ${NEXT_DOWN}`, `got ${JSON.stringify(opRoles)}`);
  const opPerms = await permsOf(NEXT_DOWN);
  ok(grants(opPerms, 'dashboard'), 'J3: an operator can open the home page');
  ok(!grants(opPerms, 'orders') && !grants(opPerms, 'kpi-system'),
    'J3: an operator does NOT get the revenue pages', `perms=${JSON.stringify(opPerms)}`);

  // ── J4 viewer ────────────────────────────────────────────────────────────
  const viewer = await hop({ role: 'viewer' });
  const vRoles = await rolesOf(viewer.email);
  ok(vRoles.join() === READ_ONLY, `J4: hub viewer -> ${READ_ONLY}`, `got ${JSON.stringify(vRoles)}`);
  const vPerms = await permsOf(READ_ONLY);
  const writeActions = Object.entries(vPerms || {})
    .flatMap(([k, acts]) => (Array.isArray(acts) ? acts : []).filter((a) => a !== 'read' && a !== 'access').map((a) => `${k}:${a}`));
  ok(writeActions.length === 0, 'J4: the read-only role carries no write action at all', `found ${JSON.stringify(writeActions)}`);

  // ── J5 fail closed ───────────────────────────────────────────────────────
  const unknown = await hop({ role: 'wharf-master-9000' });
  const uRoles = await rolesOf(unknown.email);
  ok(unknown.status === 302 && uRoles.join() === READ_ONLY,
    'J5: an unknown hub role fails CLOSED to viewer level', `status=${unknown.status} roles=${JSON.stringify(uRoles)}`);
  const noRole = await hop({ role: undefined });
  ok((await rolesOf(noRole.email)).join() === READ_ONLY, 'J5: a ticket with no role at all is viewer level too');
  const weird = await hop({ role: 'Team - Full Access' });
  ok((await rolesOf(weird.email)).join() === READ_ONLY,
    'J5: a hub role that spells a DASHBOARD role name does not select it — the map is the only door',
    `got ${JSON.stringify(await rolesOf(weird.email))}`);

  // ── J6 idempotence for an existing user ──────────────────────────────────
  const again = await hop({ role: 'owner', email: owner.email });
  ok(again.status === 302 && (await rolesOf(owner.email)).join() === HUB_OWNER,
    'J6: a second hop for the same user changes nothing', `roles=${JSON.stringify(await rolesOf(owner.email))}`);
  const createEvents = await q(
    `SELECT count(*)::int AS n FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE lower(u.email) = $1 AND a.action = 'HUB_SSO_JIT_CREATE'`, [owner.email.toLowerCase()]);
  ok(createEvents[0].n === 1, 'J6: the user was created exactly once', `n=${createEvents[0].n}`);

  // a user whose roles were deliberately changed by the store keeps them, and the divergence is recorded
  const demotedId = (await q('SELECT id FROM users WHERE lower(email) = $1', [owner.email.toLowerCase()]))[0].id;
  await q('DELETE FROM user_roles WHERE user_id = $1', [demotedId]);
  await q('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2', [demotedId, READ_ONLY]);
  const third = await hop({ role: 'owner', email: owner.email });
  const afterDemote = await rolesOf(owner.email);
  ok(third.status === 302 && afterDemote.join() === READ_ONLY,
    'J6: the store\'s own decision about an existing user is never overwritten by the hub',
    `roles=${JSON.stringify(afterDemote)}`);
  const divergence = await q(
    `SELECT new_values FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE lower(u.email) = $1 AND a.action = 'HUB_SSO_ROLE_UNCHANGED' ORDER BY a.created_at DESC LIMIT 1`,
    [owner.email.toLowerCase()]);
  const dv = divergence[0] && (typeof divergence[0].new_values === 'string' ? JSON.parse(divergence[0].new_values) : divergence[0].new_values);
  ok(Boolean(dv) && dv.mapped_role === HUB_OWNER && Array.isArray(dv.held_roles) && dv.held_roles.join() === READ_ONLY,
    'J6: and the divergence is AUDITED, not silent', `row=${JSON.stringify(dv)}`);
  // the hop that agreed with the map must NOT write a divergence row (a log that always fires says nothing)
  const quiet = await hop({ role: 'viewer' });
  await hop({ role: 'viewer', email: quiet.email });
  const quietRows = await q(
    `SELECT count(*)::int AS n FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE lower(u.email) = $1 AND a.action = 'HUB_SSO_ROLE_UNCHANGED'`, [quiet.email.toLowerCase()]);
  ok(quietRows[0].n === 0, 'J6: NEGATIVE CONTROL — a user whose roles match the map logs no divergence', `n=${quietRows[0].n}`);

  // ── J7 the map is data ───────────────────────────────────────────────────
  await q('UPDATE hub_role_map SET dashboard_role = $1 WHERE hub_role = $2', [NEXT_DOWN, 'owner']);
  const remapped = await hop({ role: 'owner' });
  ok((await rolesOf(remapped.email)).join() === NEXT_DOWN,
    'J7: re-pointing one hub_role_map row re-roles the next JIT user, with no deploy',
    `got ${JSON.stringify(await rolesOf(remapped.email))}`);
  await q('UPDATE hub_role_map SET dashboard_role = $1 WHERE hub_role = $2', [HUB_OWNER, 'owner']);

  // ── J8 every mapped name exists ──────────────────────────────────────────
  const dangling = await q(
    `SELECT m.hub_role, m.dashboard_role FROM hub_role_map m
      LEFT JOIN roles r ON r.name = m.dashboard_role WHERE r.id IS NULL ORDER BY m.hub_role`);
  ok(dangling.length === 0,
    'J8: every hub_role_map row names a role that exists (a dangling name is a 403 on every hop)',
    JSON.stringify(dangling));

  // ── J9 W8c — 134 moved ONE row, and only that row ────────────────────────
  // sorted pairs, not an object: `SELECT` has no key order and JSON.stringify does (134's own trap)
  const pairs = (o) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(' ');
  const mapNow = pairs(Object.fromEntries(
    (await q('SELECT hub_role, dashboard_role FROM hub_role_map')).map((r) => [r.hub_role, r.dashboard_role])));
  const MAP_AFTER_134 = pairs({
    owner: HUB_OWNER, admin: FULL, operator: NEXT_DOWN, editor: NEXT_DOWN, viewer: READ_ONLY, '*': READ_ONLY,
  });
  ok(mapNow === MAP_AFTER_134,
    'J9: the whole map is exactly 133\'s map with `owner` re-pointed — admin/operator/editor/viewer/* untouched',
    `got      ${mapNow}\n      expected ${MAP_AFTER_134}`);

  // ── K W8c — RE-RUNNING 134 IS A NO-OP, AND IT NEVER OVERRULES THE STORE ──
  const snapshot = async () => JSON.stringify({
    roles: await q('SELECT name, permissions::text AS permissions, description, is_system FROM roles ORDER BY name'),
    map: await q('SELECT hub_role, dashboard_role, updated_at FROM hub_role_map ORDER BY hub_role'),
    userRoles: await q(`SELECT lower(u.email) AS e, r.name FROM users u
      JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id ORDER BY 1, 2`),
  });
  if (!SQL_134) {
    ok(false, `K: ${MIG_134} does not exist yet (this is the RED state)`);
  } else {
    const before = await snapshot();
    await pool.query(SQL_134);
    const after = await snapshot();
    ok(before === after, 'K1: re-applying 134 changes NOTHING — no role, no permission, no map row, no user_role');

    // a store that re-pointed `owner` on its own keeps its choice
    await q('UPDATE hub_role_map SET dashboard_role = $1 WHERE hub_role = $2', [NEXT_DOWN, 'owner']);
    await pool.query(SQL_134);
    const reMapped = (await q('SELECT dashboard_role FROM hub_role_map WHERE hub_role = $1', ['owner']))[0].dashboard_role;
    ok(reMapped === NEXT_DOWN,
      'K2: a store that re-pointed `owner` itself is left alone by a re-run (133\'s guard shape)',
      `got ${reMapped}`);
    await q('UPDATE hub_role_map SET dashboard_role = $1 WHERE hub_role = $2', [HUB_OWNER, 'owner']);

    // a store that edited Hub Owner's permissions keeps its edit
    const keep = JSON.stringify(await permsOf(HUB_OWNER));
    await q(`UPDATE roles SET permissions = '{"dashboard":["access"]}'::jsonb WHERE name = $1`, [HUB_OWNER]);
    await pool.query(SQL_134);
    ok(JSON.stringify(await permsOf(HUB_OWNER)) === '{"dashboard":["access"]}',
      'K3: a store that edited `Hub Owner` keeps its edit — 134 never rewrites an existing role',
      JSON.stringify(await permsOf(HUB_OWNER)));
    await q('UPDATE roles SET permissions = $2::jsonb WHERE name = $1', [HUB_OWNER, keep]);

    // and a JIT hop still lands on Hub Owner after all that
    const afterAll = await hop({ role: 'owner' });
    ok((await rolesOf(afterAll.email)).join() === HUB_OWNER,
      'K4: after three re-runs a hub owner still lands on Hub Owner',
      `got ${JSON.stringify(await rolesOf(afterAll.email))}`);
  }

  // ── L FAILURE PATH, RUN DOWN — no `Team - Full Access` row at all ────────
  // A store whose roles table never got migration 031 (or whose operator deleted that role) must still
  // end up with a usable `Hub Owner`, built from 031's page keys, and must SAY so.
  if (!SQL_134) {
    ok(false, `L: ${MIG_134} does not exist yet (this is the RED state)`);
  } else {
    const lc = await pool.connect();
    const notices = [];
    lc.on('notice', (n) => notices.push(String(n.message || '')));
    try {
      await lc.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      for (const f of MIGS) {
        if (f === '031_seed_page_permissions.sql') continue; // the branch under test
        await lc.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
      }
      const rows = (await lc.query('SELECT permissions FROM roles WHERE name = $1', [HUB_OWNER])).rows;
      const p = rows[0] && (typeof rows[0].permissions === 'string' ? JSON.parse(rows[0].permissions) : rows[0].permissions);
      ok(Boolean(p), 'L1: with no `Team - Full Access` row, 134 still creates `Hub Owner`', JSON.stringify(rows));
      ok(grants(p, 'kpi-system') && grants(p, 'dashboard') && grants(p, 'brief-pipeline') && grants(p, 'statics'),
        'L2: and it carries migration 031\'s page keys plus kpi-system:access', JSON.stringify(p));
      ok(!grants(p, 'orders'),
        'L3: but NOT orders:access — that is 086\'s grant to a role that does not exist here', JSON.stringify(p));
      ok(notices.some((m) => /Team - Full Access/.test(m) && /134/.test(m)),
        'L4: and the migration SAYS so in a NOTICE (a silent fallback is a lie)', JSON.stringify(notices));
      const ownerRow = (await lc.query('SELECT dashboard_role FROM hub_role_map WHERE hub_role = $1', ['owner'])).rows[0];
      ok(ownerRow && ownerRow.dashboard_role === 'Admin',
        'L5: and the map row is NOT re-pointed — 133 could not run either, so 134 does not run ahead of it',
        JSON.stringify(ownerRow));
      lc.removeAllListeners('notice');
      const n2 = [];
      lc.on('notice', (n) => n2.push(String(n.message || '')));
      const b4 = (await lc.query('SELECT name, permissions::text AS p FROM roles ORDER BY name')).rows;
      await lc.query(SQL_134);
      const af = (await lc.query('SELECT name, permissions::text AS p FROM roles ORDER BY name')).rows;
      ok(JSON.stringify(b4) === JSON.stringify(af),
        'L6: and a SECOND run on that same database changes nothing either', JSON.stringify(n2));
    } finally { lc.release(); }
  }
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
