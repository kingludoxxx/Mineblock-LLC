// W8f — THE ONE-TIME REPAIR OF A HUB USER STRANDED ON MIGRATION 126's MAP.
//
// THE DEFECT, measured live 2026-09-11 14:41Z on the MB and SB databases: the hub operator's user
// (info@trypuure.co) was created inside each store by the SSO exchange on 2026-09-10, while
// hub_role_map still held migration 126's seed `owner -> 'Admin'`. 'Admin' administers the users
// table and carries NONE of the page keys migration 031 seeds, so hopping in from the hub lands on
// an empty sidebar and a locked KPI card. Migrations 133/134 fixed the MAP (`owner -> 'Hub Owner'`,
// which is Team - Full Access + kpi-system:access) but deliberately never re-role an EXISTING user,
// so every store that had a hop before 2026-09-11 still carries such a user.
//
// WHAT IS PROVED HERE, against the REAL /api/v1/hub-sso router on a fresh Postgres built from the
// REAL migration files off disk:
//
//   R1  a user created by the JIT path UNDER THE 126 MAP holds exactly ["Admin"] and opens no page
//   R2  migration 135 backfills created_via = 'hub_sso' for that historical row
//   R3  the next owner hop moves them to the role the CURRENT map gives them, once
//   R4  ... and writes ONE HUB_SSO_ROLE_UPGRADED row carrying the OLD and the NEW roles
//   R5  every assertion above is RE-READ on a fresh connection AFTER the commit
//   R6  a second hop writes no second upgrade row, and no divergence row either
//
// W8g (REVIEW-W8F P0-1 / P1-2 / P2-1 / P2-3) — WHAT MAKES "ONCE" TRUE IS THE LATCH:
//   R7  FOUR ROUNDS, the store putting the user back on exactly ["Admin"] between hops THROUGH THE
//       PRODUCT'S OWN ENDPOINT (teamController.changeTeamMemberRole, called as the real function):
//       rounds 2-4 leave the store's choice alone, and there is still exactly ONE upgrade row.
//       RED, before the latch: ["Hub Owner"] after every round and FOUR upgrade rows.
//   R8  the latch is on the row — created_via = 'hub_sso_repaired', which (a) does not match
//   U1  a ticket whose hub role the map does not name does NOT spend the repair (the '*' fallback
//       used to move the user to Viewer, after which (b) refused them forever)
//   X1  hub_role_map is not a lever on a REPAIRED user: re-pointed owner -> SuperAdmin, untouched,
//       with the control that the same map DOES still decide what a NEW user gets
//   D1  the predicate agrees with the door: a deactivated (401) or locked (423) user is not a
//       candidate, so the census cannot name a user the exchange would turn away
//
//   N1  Admin PLUS another role            -> untouched, still HUB_SSO_ROLE_UNCHANGED   (b)
//   N2  a row written since creation (what a password reset leaves) -> untouched        (c)
//   N3  a local login after the last hop   -> untouched                                 (c)
//   N4  the store's own SuperAdmin         -> untouched                                 (b)+(c)
//   N4b a SuperAdmin-SHAPED row (must_change_password = true) holding exactly Admin     (c) alone
//   N5  a user created LOCALLY whose only role is Admin -> untouched                    (a)
//   N6  an invited user (invited_at / invited_by set)   -> untouched                    (c)
//
//   T1  THE POSTGRES TRAP: a failed statement inside a transaction aborts the WHOLE transaction and
//       a later COMMIT silently behaves as a ROLLBACK. The optional audit insert is therefore wrapped
//       in SAVEPOINT / ROLLBACK TO SAVEPOINT: with the audit row refused by a CHECK constraint the
//       re-map still commits, and the proof is a re-read on a fresh connection after the commit.
//   T0  the same transaction shape WITHOUT a savepoint, run directly, to show what T1 is defending
//       against (the UPDATE is silently lost).
//
//   C1  nothing new is exposed to the client: created_via appears in no client file, in no response
//       shape, and in neither token the exchange mints.
//
// Run:  W8F_TEST_DB=postgres://postgres@127.0.0.1:5433/w8f_remap node server/tests/hub-sso/w8f-jit-remap.mjs
// test-timeout: 180s
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.W8F_TEST_DB || 'postgres://postgres@127.0.0.1:5433/w8f_remap';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(16).toString('hex');
const PORT = 48961;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT),
  JWT_ACCESS_SECRET: 'w8f-access-' + crypto.randomBytes(8).toString('hex'),
  JWT_REFRESH_SECRET: 'w8f-refresh-' + crypto.randomBytes(8).toString('hex'),
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

// The real migrations, off disk, in order. 031 seeds the page roles the map points at; 076 adds the
// invite columns; 126 creates hub_role_map; 133/134 re-point it; 135 is this lane's provenance column.
const MIGS = [
  '001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql',
  '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql',
  '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql',
  '031_seed_page_permissions.sql', '076_team_invitations.sql', '086_add_orders_permission.sql',
  '126_hub_sso.sql', '132_session_hub_stores.sql', '133_hub_role_map_page_roles.sql',
  '134_hub_owner_kpi_role.sql', '135_users_created_via.sql',
];
const MIG_135 = '135_users_created_via.sql';
let SQL_135 = null;
for (const f of MIGS) {
  try {
    const sql = await readFile(join(REPO, 'server/migrations', f), 'utf8');
    if (f === MIG_135) SQL_135 = sql;
    await pool.query(sql);
  } catch (e) {
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
const hubSsoModule = await import('../../src/routes/hubSso.js');
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/hub-sso', hubSsoModule.default);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}) {
  const payload = {
    email: `w8f-${crypto.randomBytes(5).toString('hex')}@example.test`,
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
  return { status: r.status, body, email: payload.email, setCookie: r.headers.getSetCookie?.() || [] };
}

const LEGACY = 'Admin';               // migration 126's seeded target for hub `owner`
const HUB_OWNER = 'Hub Owner';        // migration 134's
const READ_ONLY = 'Viewer';

/** Roles held, read on a FRESH connection out of the pool (never the router's). */
const rolesOf = async (email) => (await q(
  `SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
    WHERE lower(u.email) = $1 ORDER BY r.name`, [email.toLowerCase()])).map((x) => x.name);
const userRow = async (email) => (await q('SELECT * FROM users WHERE lower(email) = $1', [email.toLowerCase()]))[0];
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
const auditRows = async (email, action) => (await q(
  `SELECT a.old_values, a.new_values, a.created_at FROM audit_logs a JOIN users u ON u.id = a.resource_id
    WHERE lower(u.email) = $1 AND a.action = $2 ORDER BY a.created_at`, [email.toLowerCase(), action]))
  .map((r) => ({
    old: typeof r.old_values === 'string' ? JSON.parse(r.old_values) : r.old_values,
    neu: typeof r.new_values === 'string' ? JSON.parse(r.new_values) : r.new_values,
  }));

const setMap = async (hubRole, dashboardRole) =>
  q('UPDATE hub_role_map SET dashboard_role = $2 WHERE hub_role = $1', [hubRole, dashboardRole]);

/**
 * Make an EXISTING user look exactly like one the hub created on 2026-09-10, before migration 135:
 * provenance not recorded yet, and the row untouched since the instant it was created.
 */
const makeHistorical = async (email) => q(
  `UPDATE users SET created_via = NULL, updated_at = created_at WHERE lower(email) = $1`, [email.toLowerCase()]);

/** Re-apply migration 135 exactly as the runner would (idempotent: ALTER IF NOT EXISTS + a guarded UPDATE). */
const runBackfill = async () => { if (SQL_135) await pool.query(SQL_135); };

try {
  // ══ R1 — the user the 126 map created ════════════════════════════════════
  await setMap('owner', LEGACY);                       // put the map back to migration 126's seed
  const stranded = await hop({ role: 'owner' });
  ok(stranded.status === 302, 'R1: the 126-map hop is accepted', `status=${stranded.status} body=${JSON.stringify(stranded.body)}`);
  const strandedRoles = await rolesOf(stranded.email);
  ok(strandedRoles.join() === LEGACY, `R1: and it strands the hub owner on exactly ["${LEGACY}"]`, `got ${JSON.stringify(strandedRoles)}`);
  const legacyPerms = await permsOf(LEGACY);
  ok(!grants(legacyPerms, 'dashboard') && !grants(legacyPerms, 'kpi-system'),
    'R1: THE HARM — that role opens no page and no KPI card', `perms=${JSON.stringify(legacyPerms)}`);
  await setMap('owner', HUB_OWNER);                    // the map as 133/134 leave it today

  // ══ R2 — migration 135 finds the historical row ══════════════════════════
  await makeHistorical(stranded.email);
  ok((await userRow(stranded.email)).created_via === null, 'R2: the historical row carries no provenance yet');
  await runBackfill();
  ok((await userRow(stranded.email)).created_via === 'hub_sso',
    'R2: migration 135 backfills created_via = hub_sso off the HUB_SSO_JIT_CREATE audit row',
    `got ${JSON.stringify((await userRow(stranded.email)).created_via)}`);

  // ══ R3/R4/R5 — the repair, re-read after the commit ══════════════════════
  const repaired = await hop({ role: 'owner', email: stranded.email });
  ok(repaired.status === 302, 'R3: the repairing hop is accepted', `status=${repaired.status} body=${JSON.stringify(repaired.body)}`);
  const afterRoles = await rolesOf(stranded.email);    // fresh connection, after the response = after COMMIT
  ok(afterRoles.join() === HUB_OWNER,
    `R3: the stranded user now holds exactly ["${HUB_OWNER}"] — the role the CURRENT map gives an owner`,
    `got ${JSON.stringify(afterRoles)}`);
  const hoPerms = await permsOf(HUB_OWNER);
  ok(grants(hoPerms, 'dashboard') && grants(hoPerms, 'kpi-system'),
    'R3: and that role really opens the sidebar and the KPI card', `perms=${JSON.stringify(hoPerms)}`);
  const up = await auditRows(stranded.email, 'HUB_SSO_ROLE_UPGRADED');
  ok(up.length === 1, 'R4: exactly ONE HUB_SSO_ROLE_UPGRADED row', `n=${up.length}`);
  ok(up[0] && up[0].old && Array.isArray(up[0].old.roles) && up[0].old.roles.join() === LEGACY,
    'R4: it carries the OLD roles', `old=${JSON.stringify(up[0] && up[0].old)}`);
  ok(up[0] && up[0].neu && Array.isArray(up[0].neu.roles) && up[0].neu.roles.join() === HUB_OWNER,
    'R4: and the NEW roles', `new=${JSON.stringify(up[0] && up[0].neu)}`);
  const reread = await new pg.Client({ connectionString: DB });
  await reread.connect();
  const rr = await reread.query(
    `SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE lower(u.email) = $1`, [stranded.email.toLowerCase()]);
  const rrAudit = await reread.query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'HUB_SSO_ROLE_UPGRADED'`);
  await reread.end();
  ok(rr.rows.length === 1 && rr.rows[0].name === HUB_OWNER && rrAudit.rows[0].n === 1,
    'R5: RE-READ ON A BRAND-NEW CONNECTION AFTER THE COMMIT — the role change and the audit row are both really there',
    `roles=${JSON.stringify(rr.rows)} upgrades=${rrAudit.rows[0].n}`);

  // ══ R6 — once, and only once ═════════════════════════════════════════════
  await hop({ role: 'owner', email: stranded.email });
  ok((await auditRows(stranded.email, 'HUB_SSO_ROLE_UPGRADED')).length === 1,
    'R6: a second hop after the upgrade writes NO second upgrade row');
  ok((await auditRows(stranded.email, 'HUB_SSO_ROLE_UNCHANGED')).length === 0,
    'R6: and no divergence row either — the user now agrees with the map');
  ok((await rolesOf(stranded.email)).join() === HUB_OWNER, 'R6: and the roles are unchanged by it');

  // ── a factory for the negative controls: a hub-created user on exactly ["Admin"] ──
  const strandedUser = async () => {
    await setMap('owner', LEGACY);
    const u = await hop({ role: 'owner' });
    await setMap('owner', HUB_OWNER);
    await makeHistorical(u.email);
    await runBackfill();
    return u.email;
  };
  /** Hop as owner and report what the user ended up holding + whether an upgrade row was written. */
  const probe = async (email) => {
    const r = await hop({ role: 'owner', email });
    return {
      status: r.status,
      roles: (await rolesOf(email)).join(),
      upgrades: (await auditRows(email, 'HUB_SSO_ROLE_UPGRADED')).length,
      unchanged: (await auditRows(email, 'HUB_SSO_ROLE_UNCHANGED')).length,
    };
  };

  // ══ N1 — Admin PLUS another role: not "exactly the legacy default" ═══════
  const n1 = await strandedUser();
  await q(`INSERT INTO user_roles (user_id, role_id)
           SELECT u.id, r.id FROM users u, roles r WHERE lower(u.email) = $1 AND r.name = $2`, [n1, READ_ONLY]);
  const n1r = await probe(n1);
  ok(n1r.roles === `${LEGACY},${READ_ONLY}` && n1r.upgrades === 0,
    'N1: a user holding Admin PLUS another role is untouched (b)', JSON.stringify(n1r));
  ok(n1r.unchanged === 1, 'N1: and still gets the HUB_SSO_ROLE_UNCHANGED divergence row', JSON.stringify(n1r));

  // ══ N2 — the row has been written since creation (a password reset) ══════
  const n2 = await strandedUser();
  await q('UPDATE users SET updated_at = created_at + INTERVAL \'1 second\' WHERE lower(email) = $1', [n2]);
  const n2r = await probe(n2);
  ok(n2r.roles === LEGACY && n2r.upgrades === 0 && n2r.unchanged === 1,
    'N2: a hub row written since creation (what reset-password leaves) is untouched (c)', JSON.stringify(n2r));

  // ══ N3 — a local login later than the newest hub hop ═════════════════════
  const n3 = await strandedUser();
  await q('UPDATE users SET last_login = NOW() + INTERVAL \'1 hour\' WHERE lower(email) = $1', [n3]);
  const n3r = await probe(n3);
  ok(n3r.roles === LEGACY && n3r.upgrades === 0 && n3r.unchanged === 1,
    'N3: a login this store served itself (last_login past the newest HUB_SSO_LOGIN) is untouched (c)', JSON.stringify(n3r));

  // ══ N4 — the store's OWN SuperAdmin ══════════════════════════════════════
  // Created exactly the way server/src/server.js and seeds/seed_superadmin.js create one.
  const saEmail = 'superadmin@example.test';
  await q(`INSERT INTO users (email, password_hash, first_name, last_name, must_change_password)
           VALUES ($1, 'not-a-real-hash', 'Super', 'Admin', true)`, [saEmail]);
  await q(`INSERT INTO user_roles (user_id, role_id)
           SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'SuperAdmin'`, [saEmail]);
  const saBefore = (await rolesOf(saEmail)).join();
  const n4r = await probe(saEmail);
  ok(saBefore === 'SuperAdmin' && n4r.roles === 'SuperAdmin' && n4r.upgrades === 0,
    'N4: the store\'s own SuperAdmin is untouched by a hop that claims to be the owner', JSON.stringify(n4r));

  // ══ N4b — a SuperAdmin-SHAPED row: (c) alone must refuse it ══════════════
  // Everything the repair wants EXCEPT must_change_password, which both SuperAdmin creators set true.
  const n4b = await strandedUser();
  await q('UPDATE users SET must_change_password = true, updated_at = created_at WHERE lower(email) = $1', [n4b]);
  const n4br = await probe(n4b);
  ok(n4br.roles === LEGACY && n4br.upgrades === 0,
    'N4b: must_change_password = true alone refuses the repair — the SuperAdmin guard is independent of (b)',
    JSON.stringify(n4br));

  // ══ N5 — created LOCALLY, only role Admin ════════════════════════════════
  // Exactly userController.createUser's INSERT: no invite, no provenance, a password an admin typed.
  const n5 = 'local-admin@example.test';
  await q(`INSERT INTO users (email, first_name, last_name, password_hash) VALUES ($1, 'Local', 'Admin', 'a-real-hash')`, [n5]);
  await q(`INSERT INTO user_roles (user_id, role_id)
           SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = $2`, [n5, LEGACY]);
  await runBackfill();
  ok((await userRow(n5)).created_via === null, 'N5: a locally created user gets NO provenance from the backfill');
  const n5r = await probe(n5);
  ok(n5r.roles === LEGACY && n5r.upgrades === 0 && n5r.unchanged === 1,
    'N5: and a locally created user whose only role is Admin is untouched (a)', JSON.stringify(n5r));

  // ══ N6 — an invited user ═════════════════════════════════════════════════
  const n6 = await strandedUser();
  await q(`UPDATE users SET invited_at = NOW(), invited_by = (SELECT id FROM users WHERE email = $2),
             updated_at = created_at WHERE lower(email) = $1`, [n6, saEmail]);
  const n6r = await probe(n6);
  ok(n6r.roles === LEGACY && n6r.upgrades === 0,
    'N6: a user the store invited is untouched, whatever else is true of the row (c)', JSON.stringify(n6r));

  // ══ R7/R8 — W8g: THE REPAIR IS ONCE BECAUSE IT LATCHES ═══════════════════
  // The store's own decision is made through the product's own endpoint, not by SQL this test writes:
  // changeTeamMemberRole is the thing that writes user_roles and never touches users.updated_at, and
  // that is exactly why nothing used to latch the repair off.
  let storeSetsRole;                                           // hoisted: X2 below needs it too
  {
    const team = await import('../../src/controllers/teamController.js');
    const actorId = (await userRow(saEmail)).id;               // the store's own SuperAdmin, from N4
    storeSetsRole = async (email, roleName) => {
      const target = await userRow(email);
      const role = (await q('SELECT id FROM roles WHERE name = $1', [roleName]))[0];
      let code = 200, body = null;
      const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
      await team.changeTeamMemberRole(
        { params: { userId: target.id }, body: { roleId: role.id }, user: { id: actorId }, ip: '127.0.0.1', headers: {} },
        res);
      return { code, body };
    };

    const l = await strandedUser();
    await hop({ role: 'owner', email: l });
    ok((await rolesOf(l)).join() === HUB_OWNER && (await auditRows(l, 'HUB_SSO_ROLE_UPGRADED')).length === 1,
      'R7: round 1 is the repair itself', `roles=${JSON.stringify(await rolesOf(l))}`);
    ok((await userRow(l)).created_via === 'hub_sso_repaired',
      'R8: the repair LATCHED on the row it repaired — created_via = hub_sso_repaired',
      `created_via=${JSON.stringify((await userRow(l)).created_via)}`);

    const rounds = [];
    for (let n = 2; n <= 4; n++) {
      const resp = await storeSetsRole(l, LEGACY);
      const row = await userRow(l);
      // The RED condition itself, asserted rather than assumed: the store's endpoint leaves the row
      // looking exactly like a repair candidate. Only the latch separates it from one.
      ok(resp.code === 200 && (await rolesOf(l)).join() === LEGACY && row.updated_at <= row.created_at,
        `R7: round ${n} — the store sets ["${LEGACY}"] and the row still reads updated_at <= created_at`,
        `code=${resp.code} roles=${JSON.stringify(await rolesOf(l))} c4=${row.updated_at <= row.created_at}`);
      await hop({ role: 'owner', email: l });
      rounds.push({ n, after: (await rolesOf(l)).join(), up: (await auditRows(l, 'HUB_SSO_ROLE_UPGRADED')).length });
    }
    for (const r of rounds) {
      ok(r.after === LEGACY, `R7: round ${r.n} — THE STORE'S OWN ROLE DECISION SURVIVES THE HOP`,
        `roles=["${r.after}"] upgradeRows=${r.up}`);
    }
    ok((await auditRows(l, 'HUB_SSO_ROLE_UPGRADED')).length === 1,
      'R7: and after FOUR rounds there is still exactly ONE HUB_SSO_ROLE_UPGRADED row',
      `n=${(await auditRows(l, 'HUB_SSO_ROLE_UPGRADED')).length}`);
  }

  // ══ U1 — an unknown hub role must not spend the one repair ═══════════════
  {
    const u = await strandedUser();
    const unknown = await hop({ role: 'no-such-hub-role', email: u });
    ok(unknown.status === 302, 'U1: a ticket whose hub role the map does not name is still served', `status=${unknown.status}`);
    ok((await rolesOf(u)).join() === LEGACY && (await auditRows(u, 'HUB_SSO_ROLE_UPGRADED')).length === 0,
      'U1: and it leaves the user exactly as they were — the repair is NOT spent on the "*" fallback',
      `roles=${JSON.stringify(await rolesOf(u))}`);
    ok((await userRow(u)).created_via === 'hub_sso', 'U1: the row is not latched either',
      `created_via=${JSON.stringify((await userRow(u)).created_via)}`);
    await hop({ role: 'owner', email: u });
    ok((await rolesOf(u)).join() === HUB_OWNER,
      'U1: so a later GENUINE owner hop still repairs them', `roles=${JSON.stringify(await rolesOf(u))}`);
  }

  // ══ X1 — hub_role_map is not a lever on a REPAIRED user (review P1-2) ════
  {
    const x = await strandedUser();
    await hop({ role: 'owner', email: x });                    // the one repair
    await setMap('owner', 'SuperAdmin');                       // the lever the review measured
    await hop({ role: 'owner', email: x });
    ok((await rolesOf(x)).join() === HUB_OWNER,
      'X1: a REPAIRED user is untouched when the map is re-pointed owner -> SuperAdmin',
      `roles=${JSON.stringify(await rolesOf(x))}`);
    ok((await auditRows(x, 'HUB_SSO_ROLE_UPGRADED')).length === 1, 'X1: and still exactly one upgrade row');
    const fresh = await hop({ role: 'owner' });
    ok((await rolesOf(fresh.email)).join() === 'SuperAdmin',
      'X1: CONTROL — the same re-pointed map DOES decide what a NEW user gets, so X1 is not a dead map',
      `roles=${JSON.stringify(await rolesOf(fresh.email))}`);
    await setMap('owner', HUB_OWNER);

    // ── X2, THE SHARP ONE: P0-1 and P1-2 are the SAME defect seen twice ──────────────────────────
    // X1 above passes even on the pre-W8g route, and for an accidental reason: a repaired user holds
    // the MAPPED role, so (b) refuses them. That protection evaporates the moment the store puts
    // them back on 'Admin' — which is precisely P0-1. So: repair, let the store demote through its
    // own endpoint, THEN re-point the map at SuperAdmin and hop. Before W8g this ended on
    // ["SuperAdmin"]: one row edited in a data table, one hop, and an existing account is the store's
    // most privileged role. The latch is what makes it impossible.
    const x2 = await strandedUser();
    await hop({ role: 'owner', email: x2 });                   // the one repair
    await storeSetsRole(x2, LEGACY);                           // the store's own decision
    await setMap('owner', 'SuperAdmin');                       // the lever
    await hop({ role: 'owner', email: x2 });
    ok((await rolesOf(x2)).join() === LEGACY,
      'X2: a repaired user the store then DEMOTED is still untouched by a map re-pointed at SuperAdmin',
      `roles=${JSON.stringify(await rolesOf(x2))}`);
    ok((await auditRows(x2, 'HUB_SSO_ROLE_UPGRADED')).length === 1,
      'X2: and still exactly one upgrade row, ever',
      `n=${(await auditRows(x2, 'HUB_SSO_ROLE_UPGRADED')).length}`);
    await setMap('owner', HUB_OWNER);
  }

  // ══ D1 — the predicate agrees with the door (review P2-1) ════════════════
  // The exchange refuses a deactivated user 401 and a locked one 423 before the repair is reached.
  // The census reads REMAP_CANDIDATE_SQL, so the predicate has to know that too.
  {
    const { REMAP_CANDIDATE_SQL } = hubSsoModule;
    const candidate = async (email) => (await q(`${REMAP_CANDIDATE_SQL} AND lower(u.email) = $2`,
      [LEGACY, email.toLowerCase()])).length;

    const d1 = await strandedUser();
    ok(await candidate(d1) === 1, 'D1: POSITIVE CONTROL — a healthy stranded user IS a candidate');
    await q('UPDATE users SET is_active = false WHERE lower(email) = $1', [d1]);
    ok(await candidate(d1) === 0, 'D1: a DEACTIVATED user is not a candidate (the door answers 401)');
    const dHop = await hop({ role: 'owner', email: d1 });
    ok(dHop.status === 401 && (await rolesOf(d1)).join() === LEGACY,
      'D1: and the exchange really does refuse them 401 without re-roling', `status=${dHop.status}`);

    const d2 = await strandedUser();
    await q("UPDATE users SET locked_until = NOW() + INTERVAL '1 hour' WHERE lower(email) = $1", [d2]);
    ok(await candidate(d2) === 0, 'D1: a LOCKED user is not a candidate (the door answers 423)');
    const d2Hop = await hop({ role: 'owner', email: d2 });
    ok(d2Hop.status === 423 && (await rolesOf(d2)).join() === LEGACY,
      'D1: and the exchange really does refuse them 423 without re-roling', `status=${d2Hop.status}`);
    await q('UPDATE users SET locked_until = NULL WHERE lower(email) = $1', [d2]);
    ok(await candidate(d2) === 1, 'D1: once the lock EXPIRES the same user is a candidate again — the guard is the lock, not a brand');
  }

  // ══ T0 — THE TRAP ITSELF, shown failing on this very database ════════════
  // A failed statement inside a transaction aborts the WHOLE transaction and the later COMMIT is a
  // ROLLBACK. Demonstrated on a throwaway row so the reader does not have to take it on trust.
  const trapClient = new pg.Client({ connectionString: DB });
  await trapClient.connect();
  await trapClient.query(`CREATE TABLE IF NOT EXISTS w8f_trap (id int PRIMARY KEY, v text)`);
  await trapClient.query(`INSERT INTO w8f_trap (id, v) VALUES (1, 'before') ON CONFLICT (id) DO UPDATE SET v = 'before'`);
  let commitSaidRollback = false;
  await trapClient.query('BEGIN');
  await trapClient.query(`UPDATE w8f_trap SET v = 'after' WHERE id = 1`);
  try { await trapClient.query(`INSERT INTO w8f_trap (id, v) VALUES (1, 'dup')`); } catch { /* the failing statement */ }
  const commitRes = await trapClient.query('COMMIT');
  commitSaidRollback = String(commitRes.command || '').toUpperCase() === 'ROLLBACK';
  await trapClient.end();
  const trapValue = (await q(`SELECT v FROM w8f_trap WHERE id = 1`))[0].v;
  ok(trapValue === 'before' && commitSaidRollback,
    'T0: RED-BY-CONSTRUCTION — without a savepoint the good UPDATE is silently lost and COMMIT reports ROLLBACK',
    `value=${trapValue} commit=${commitRes.command}`);
  await q('DROP TABLE w8f_trap');

  // ══ T1 — the repair survives an audit insert that cannot be written ══════
  const t1 = await strandedUser();
  // NOT VALID: enforced on every NEW row, but not checked against the upgrade rows R4 already wrote.
  await q(`ALTER TABLE audit_logs ADD CONSTRAINT w8f_no_upgrade_rows CHECK (action <> 'HUB_SSO_ROLE_UPGRADED') NOT VALID`);
  const t1hop = await hop({ role: 'owner', email: t1 });
  await q('ALTER TABLE audit_logs DROP CONSTRAINT w8f_no_upgrade_rows');
  const t1re = new pg.Client({ connectionString: DB });
  await t1re.connect();
  const t1roles = (await t1re.query(
    `SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE lower(u.email) = $1`, [t1.toLowerCase()])).rows.map((r) => r.name);
  const t1login = (await t1re.query(
    `SELECT count(*)::int AS n FROM audit_logs a JOIN users u ON u.id = a.resource_id
      WHERE lower(u.email) = $1 AND a.action = 'HUB_SSO_LOGIN'`, [t1.toLowerCase()])).rows[0].n;
  await t1re.end();
  ok(t1hop.status === 302, 'T1: the hop still succeeds when the audit row cannot be written', `status=${t1hop.status}`);
  ok(t1roles.join() === HUB_OWNER,
    'T1: and the RE-MAP SURVIVED THE COMMIT — the savepoint kept the failed insert from aborting the transaction',
    `roles=${JSON.stringify(t1roles)}`);
  ok(t1login >= 1, 'T1: and the rest of the transaction committed too (the HUB_SSO_LOGIN row is there)', `n=${t1login}`);
  ok((await auditRows(t1, 'HUB_SSO_ROLE_UPGRADED')).length === 0,
    'T1: the upgrade row itself is genuinely absent — the constraint really bit');
  ok((await userRow(t1)).created_via === 'hub_sso_repaired',
    'T1: and the LATCH survived the commit too — a lost audit row must not hand the user a second repair',
    `created_via=${JSON.stringify((await userRow(t1)).created_via)}`);

  // ══ T2 — W8g: a repair that CANNOT complete must not be spent ════════════
  // The target role is missing from `roles`, so the repair declines (W8f's guard against leaving a
  // user with no role at all). The latch is written AFTER that check, deliberately: a user whose
  // repair never happened still has it.
  {
    const t2 = await strandedUser();
    await q(`UPDATE roles SET name = $2 WHERE name = $1`, [HUB_OWNER, 'Hub Owner (renamed away)']);
    const t2hop = await hop({ role: 'owner', email: t2 });
    ok(t2hop.status === 302 && (await rolesOf(t2)).join() === LEGACY,
      'T2: a missing target role still serves the hop and leaves the user with their role',
      `status=${t2hop.status} roles=${JSON.stringify(await rolesOf(t2))}`);
    ok((await userRow(t2)).created_via === 'hub_sso',
      'T2: and it does NOT latch — a repair that could not happen is not a repair that was spent',
      `created_via=${JSON.stringify((await userRow(t2)).created_via)}`);
    await q(`UPDATE roles SET name = $2 WHERE name = $1`, ['Hub Owner (renamed away)', HUB_OWNER]);
    await hop({ role: 'owner', email: t2 });
    ok((await rolesOf(t2)).join() === HUB_OWNER,
      'T2: so once the role exists again, the repair still happens', `roles=${JSON.stringify(await rolesOf(t2))}`);
  }

  // ══ M1 — FAILURE PATH, RUN DOWN: a database that has NOT had migration 135 ══
  // A rollback, or a preDeployCommand that did not run, must not turn the SSO door into a 500: the
  // operator still gets in, with the behaviour this route had before W8f. Same rule (and the same
  // reason) as services/hubSession.js takes for migration 132's hub_stores column.
  {
    const mc = new pg.Client({ connectionString: DB });
    await mc.connect();
    await mc.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const f of MIGS) {
      if (f === MIG_135) continue;                       // the branch under test
      await mc.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
    }
    await mc.end();
    const { seedRoles: sr, pool: sp } = await import(`../../seeds/seed_roles.js?pre135=${Date.now()}`);
    await sr(); await sp.end();
    const cols = await q(`SELECT column_name FROM information_schema.columns
                           WHERE table_name = 'users' AND column_name = 'created_via'`);
    ok(cols.length === 0, 'M1: the fixture really has no created_via column', JSON.stringify(cols));
    await setMap('owner', LEGACY);
    const m1 = await hop({ role: 'owner' });
    ok(m1.status === 302 && (await rolesOf(m1.email)).join() === LEGACY,
      'M1: a JIT creation still succeeds with no created_via column (no 500 on the SSO door)',
      `status=${m1.status} roles=${JSON.stringify(await rolesOf(m1.email))}`);
    await setMap('owner', HUB_OWNER);
    const m1b = await hop({ role: 'owner', email: m1.email });
    ok(m1b.status === 302 && (await rolesOf(m1.email)).join() === LEGACY,
      'M1: and the repair is NOT attempted — with no provenance it cannot be safe (fail closed)',
      `status=${m1b.status} roles=${JSON.stringify(await rolesOf(m1.email))}`);
    ok((await auditRows(m1.email, 'HUB_SSO_ROLE_UPGRADED')).length === 0
       && (await auditRows(m1.email, 'HUB_SSO_ROLE_UNCHANGED')).length === 1,
      'M1: the hop takes the old HUB_SSO_ROLE_UNCHANGED path instead');
  }

  // ══ C1 — nothing new is exposed to the client ════════════════════════════
  // A filesystem grep, not `git grep`: the reviewer runs this out of a `git archive`, where a tracked
  // file is present but no index is (REVIEW-W8 P2-7), and a guard that cannot run is not a guard.
  const grepFor = (needle, dirs) => {
    try {
      return execFileSync('grep', ['-rl', '--exclude-dir=node_modules', '--exclude-dir=dist', needle, ...dirs],
        { cwd: REPO, encoding: 'utf8' }).trim();
    } catch (e) { return e.status === 1 ? '' : `grep failed: ${e.message}`; }
  };
  const clientHits = grepFor('created_via', ['client/src', 'client/dev', 'client/index.html']);
  ok(clientHits === '', 'C1: created_via appears in no client file', clientHits);
  const posControl = grepFor('created_via', ['server/src', 'server/migrations']);
  ok(posControl.includes('server/src/routes/hubSso.js') && posControl.includes('server/migrations/135_users_created_via.sql'),
    'C1: POSITIVE CONTROL — the same grep does find it on the server side', posControl);
  const c1hop = await hop({ role: 'owner' });
  const cookieBlob = c1hop.setCookie.join('\n');
  const jwtPayloads = cookieBlob.split('\n').map((c) => {
    const m = /^(?:accessToken|refreshToken)=([^;]+)/.exec(c);
    if (!m) return null;
    try { return Buffer.from(decodeURIComponent(m[1]).split('.')[1].replace(/-/g, '+').replace(/\//g, '_'), 'base64').toString('utf8'); }
    catch { return ''; }
  }).filter((x) => x !== null);
  ok(jwtPayloads.length === 2 && jwtPayloads.every((p) => !p.includes('created_via')),
    'C1: and neither token the exchange mints carries it', `n=${jwtPayloads.length}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
