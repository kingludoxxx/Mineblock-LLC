// HUB SSO — the claims must SURVIVE a token refresh (Lane H1).
//
// Lane E2 closed review finding P1-4 by marking a hub-originated access token with `hub_sso` + `sid`, which routes
// `authenticate` past the 5-minute session cache and re-reads Postgres on EVERY request, so a revoked session dies
// on the very next one. It left one hole open, in its own words (services/hubSession.js, "KNOWN LIMIT"):
//
//     after the SPA rotates the token through POST /auth/refresh, the new access token is minted by
//     authController, which this lane may not touch, so it carries no mark and returns to the cached path.
//
// That is a real revocation hole: ~15 minutes after a hub hop, the SPA refreshes, the mark is gone, and removing
// the operator no longer takes effect on the next request. This file proves the hole, then proves it closed.
//
//   R1  a refresh of a hub session mints a token that is STILL marked (hub_sso + a sid)
//   R2  the sid names the NEW session row (the old one is rotated away and deleted — a carried-over sid would
//       log the operator out instantly)
//   R3  REVOCATION AFTER REFRESH: delete the sessions row, the very next request is 401     <- the finding
//   R4  the mark survives repeated refreshes, not just the first
//   R5  the browser drops the accessToken cookie at its 15-minute maxAge, so a REALISTIC refresh arrives with the
//       refresh cookie ALONE. The mark must survive that too — this is the normal case, not an edge case.
//   R6  NEGATIVE CONTROL: a local (non-hub) login's refresh yields an UNMARKED token and still works, and its
//       cached path is untouched.
//
// Run:  HUB_SSO_TEST_DB=postgres://postgres@127.0.0.1:5433/h1_sso node server/tests/hub-sso/refresh-claims.mjs
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.HUB_SSO_TEST_DB || 'postgres://postgres@127.0.0.1:5433/h1_sso';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(16).toString('hex'); // > 32 bytes
const HUB_ORIGIN = 'https://hub.example.test';
const PORT = 48973;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT), MIGRATE_SSL: '0',
  JWT_ACCESS_SECRET: 'test-access-' + crypto.randomBytes(8).toString('hex'),
  JWT_REFRESH_SECRET: 'test-refresh-' + crypto.randomBytes(8).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1', // nothing listens: every path must degrade, never depend on it
  STORE_CODE: 'MB',
});
delete process.env.HUB_SSO_ENABLED; delete process.env.HUB_SSO_SECRET; delete process.env.HUB_ORIGIN;

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGS = ['001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql', '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql', '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql', '076_team_invitations.sql', '126_hub_sso.sql'];
for (const f of MIGS) await pool.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
const { seedRoles, pool: seedPool } = await import('../../seeds/seed_roles.js');
await seedRoles(); await seedPool.end();

const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { hashPassword } = await import('../../src/utils/hash.js');
const { default: authRoutes } = await import('../../src/routes/auth.js');
const { default: hubSsoRoutes } = await import('../../src/routes/hubSso.js');
const { peekHubSsoClaims } = await import('../../src/services/hubSession.js');
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/hub-sso', hubSsoRoutes);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}) {
  const payload = { email: 'hub@example.test', store_code: 'MB', exp: Math.floor(Date.now() / 1000) + 30, nonce: crypto.randomBytes(16).toString('hex'), role: 'viewer', ...over };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', SECRET).update(bytes).digest();
  return `${b64u(bytes)}.${b64u(sig)}`;
}
let ipCounter = 0;
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter++) & 255}`;
const cookieVal = (cookies, name) => { const c = cookies.find((s) => s.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };
const q = async (sql, params) => (await pool.query(sql, params)).rows;

async function hop(email) {
  const res = await fetch(BASE + '/api/v1/hub-sso/exchange', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: HUB_ORIGIN, 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ ticket: mint({ email }) }),
  });
  const cookies = res.headers.getSetCookie();
  return { status: res.status, access: cookieVal(cookies, 'accessToken'), refresh: cookieVal(cookies, 'refreshToken') };
}
/** POST /auth/refresh. `access` omitted models the browser having dropped the 15-minute accessToken cookie. */
async function doRefresh({ refresh, access }) {
  const cookie = [access ? `accessToken=${access}` : null, `refreshToken=${refresh}`].filter(Boolean).join('; ');
  const res = await fetch(BASE + '/api/v1/auth/refresh', { method: 'POST', headers: { cookie, 'x-forwarded-for': freshIp() } });
  const cookies = res.headers.getSetCookie();
  return { status: res.status, body: await res.text(), access: cookieVal(cookies, 'accessToken'), refresh: cookieVal(cookies, 'refreshToken') };
}
const me = (access) => fetch(BASE + '/api/v1/auth/me', { headers: { cookie: `accessToken=${access}` } });

const LOCAL_PW = 'Local-Passw0rd!';
async function seedUser(email) {
  const hash = await hashPassword(LOCAL_PW);
  const [u] = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified)
     VALUES ($1, $2, 'L', 'U', true, true) RETURNING *`, [email, hash]);
  return u;
}
const login = async (email) => {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ email, password: LOCAL_PW }),
  });
  const cookies = res.headers.getSetCookie();
  return { status: res.status, access: cookieVal(cookies, 'accessToken'), refresh: cookieVal(cookies, 'refreshToken') };
};

process.env.HUB_SSO_SECRET = SECRET;
process.env.HUB_ORIGIN = HUB_ORIGIN;
process.env.HUB_SSO_ENABLED = '1';

// ─────────────────────────────────────────────────────────────────────────────
// R1 / R2  the refreshed token is still a hub-SSO token
// ─────────────────────────────────────────────────────────────────────────────
{
  const h = await hop('r1@example.test');
  ok(h.status === 302, 'SETUP the hub hop succeeded', String(h.status));
  ok(peekHubSsoClaims(h.access)?.hub_sso === true, 'SETUP CONTROL the token the HOP mints is marked (Lane E2 works)');

  const r = await doRefresh(h);
  ok(r.status === 200, 'R1 the refresh itself succeeds', r.status + ' ' + r.body.slice(0, 120));
  const claims = peekHubSsoClaims(r.access);
  ok(claims?.hub_sso === true, 'R1 the REFRESHED access token still carries hub_sso', JSON.stringify(claims));
  ok(typeof claims?.sid === 'string' && /^[0-9a-fA-F-]{36}$/.test(claims.sid), 'R1 the refreshed token carries a sid', JSON.stringify(claims));

  const [u] = await q('SELECT id FROM users WHERE email=$1', ['r1@example.test']);
  const rows = await q('SELECT id FROM sessions WHERE user_id=$1', [u.id]);
  ok(rows.length === 1, 'R2 refresh ROTATED the session: exactly one row remains', JSON.stringify(rows));
  ok(claims?.sid === rows[0]?.id, 'R2 the sid names the NEW session row, not the rotated-away one',
    `sid=${claims?.sid} row=${rows[0]?.id}`);
  ok((await me(r.access)).status === 200, 'R2 the refreshed token authenticates (a stale sid would 401 immediately)');
}

// ─────────────────────────────────────────────────────────────────────────────
// R3  the finding: revocation after a refresh
// ─────────────────────────────────────────────────────────────────────────────
{
  const h = await hop('r3@example.test');
  const r = await doRefresh(h);
  ok((await me(r.access)).status === 200, 'R3 SETUP the refreshed session works before revocation');

  const [u] = await q('SELECT id FROM users WHERE email=$1', ['r3@example.test']);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]); // logout / "log out other devices" / admin revoke / hub removal
  const m = await me(r.access);
  ok(m.status === 401, 'R3 a session REVOKED AFTER A REFRESH is refused on the very next request',
    m.status + ' ' + (await m.text()).slice(0, 120));
}

// ─────────────────────────────────────────────────────────────────────────────
// R4  the mark survives repeated rotation, not only the first refresh
// ─────────────────────────────────────────────────────────────────────────────
{
  let cur = await hop('r4@example.test');
  const marks = [];
  for (let i = 0; i < 3; i++) {
    cur = await doRefresh(cur);
    marks.push(peekHubSsoClaims(cur.access)?.hub_sso === true);
  }
  ok(marks.every(Boolean), 'R4 three chained refreshes all stay marked', JSON.stringify(marks));

  const [u] = await q('SELECT id FROM users WHERE email=$1', ['r4@example.test']);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  ok((await me(cur.access)).status === 401, 'R4 revocation still bites after THREE refreshes');
}

// ─────────────────────────────────────────────────────────────────────────────
// R5  the realistic refresh: the accessToken cookie is already gone (15-minute maxAge)
// ─────────────────────────────────────────────────────────────────────────────
{
  const h = await hop('r5@example.test');
  const r = await doRefresh({ refresh: h.refresh }); // NO accessToken cookie — the browser dropped it
  ok(r.status === 200, 'R5 a refresh with the refresh cookie ALONE succeeds', r.status + ' ' + r.body.slice(0, 120));
  ok(peekHubSsoClaims(r.access)?.hub_sso === true,
    'R5 the mark survives even though there was no access token to read it from (the normal 15-minute case)',
    JSON.stringify(peekHubSsoClaims(r.access)));

  const [u] = await q('SELECT id FROM users WHERE email=$1', ['r5@example.test']);
  ok((await me(r.access)).status === 200, 'R5 SETUP that token works');
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  ok((await me(r.access)).status === 401, 'R5 and revocation bites on the very next request');
}

// ─────────────────────────────────────────────────────────────────────────────
// R6  NEGATIVE CONTROL — a local login must be completely unchanged
// ─────────────────────────────────────────────────────────────────────────────
{
  await seedUser('local@example.test');
  const l = await login('local@example.test');
  ok(l.status === 200, 'R6 CONTROL the local login works', String(l.status));
  ok(peekHubSsoClaims(l.access) === null, 'R6 CONTROL a local login token is NOT marked');

  const r = await doRefresh(l);
  ok(r.status === 200, 'R6 a local refresh still succeeds', r.status + ' ' + r.body.slice(0, 120));
  ok(peekHubSsoClaims(r.access) === null, 'R6 a local refresh yields an UNMARKED token (no hub_sso, no sid)',
    JSON.stringify(peekHubSsoClaims(r.access)));
  ok((await me(r.access)).status === 200, 'R6 the refreshed local token authenticates');

  const [u] = await q('SELECT id FROM users WHERE email=$1', ['local@example.test']);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  ok((await me(r.access)).status === 200,
    'R6 a local session is NOT revoked per-request — the local path is unchanged, this fix does not tighten it');

  const l2 = await login('local@example.test');
  const r2 = await doRefresh({ refresh: l2.refresh });
  ok(r2.status === 200 && peekHubSsoClaims(r2.access) === null,
    'R6 a local refresh with the refresh cookie alone is also unchanged and unmarked', r2.status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths for the new code itself
// ─────────────────────────────────────────────────────────────────────────────
{
  const h = await hop('edge@example.test');
  const [u] = await q('SELECT id FROM users WHERE email=$1', ['edge@example.test']);

  // the refresh row is gone before the SPA rotates: refresh must refuse, not mint a marked token on nothing
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  const r = await doRefresh(h);
  ok(r.status === 401, 'EDGE refreshing a session that was already revoked is refused', r.status + ' ' + r.body.slice(0, 120));
  ok(r.access === null || r.access === '', 'EDGE the refused refresh minted no access token', String(r.access).slice(0, 40));
  const left = await q('SELECT id FROM sessions WHERE user_id=$1', [u.id]);
  ok(left.length === 0, 'EDGE and it created no session row', JSON.stringify(left));

  // a garbage refresh cookie
  const bad = await doRefresh({ refresh: 'not-a-jwt' });
  ok(bad.status === 401, 'EDGE a malformed refresh token is refused, not thrown on', bad.status + ' ' + bad.body.slice(0, 80));

  // a FORGED hub_sso mark on the access cookie must not be enough to fake a live session
  const { signAccessToken } = await import('../../src/utils/jwt.js');
  const forged = signAccessToken({ userId: u.id, email: 'edge@example.test', roles: [], hub_sso: true, sid: crypto.randomUUID() });
  ok((await me(forged)).status === 401, 'EDGE a forged hub_sso token whose sid names no session row is refused');
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await pool.end();
process.exit(fail === 0 ? 0 : 1);
