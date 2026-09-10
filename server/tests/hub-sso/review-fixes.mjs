// HUB SSO — REVIEW FIXES (Lane E2, from briefs/out/REVIEW-LANE-E.md).
// Same harness shape as hub-sso.mjs: the REAL /api/v1/hub-sso router next to the REAL /api/v1/auth router
// (real authenticate, real cookies) against a fresh Postgres on 5433, schema built from the REAL migrations off disk.
//
// Proves BY EXECUTION, one block per review finding:
//   F3 (P1-3) the flag check runs BEFORE any rate limiting, dark POSTs never touch the store's own login budget,
//             and a successful 302 is never counted as a failed attempt; failures are still limited, in their own bucket.
//   F4 (P2-6) Origin / Referer check on the SSO POST: a foreign origin is refused before anything is written.
//   F5 (P2-2) HUB_SSO_SECRET shorter than 32 bytes refuses to serve the route (fail closed, no HMAC computed).
//   F6 (P2-1/P2-5) a LOCKED account is refused; case-insensitive email match; an ambiguous match is refused;
//             a successful hop sets last_login and clears the failed-login counters, as authController.login does.
//   F7 (P1-4, DECISION MADE: no grace) a revoked session is rejected on the VERY NEXT request: no 60 s window,
//             no session cache for hub-SSO sessions.
//
// Run:  HUB_SSO_TEST_DB=postgres://postgres@127.0.0.1:5433/e2_test node server/tests/hub-sso/review-fixes.mjs
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.HUB_SSO_TEST_DB || 'postgres://postgres@127.0.0.1:5433/e2_test';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(16).toString('hex'); // > 32 bytes
const HUB_ORIGIN = 'https://hub.example.test';
const PORT = 48951;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT),
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
const hubSessionMod = await import('../../src/services/hubSession.js');
const { peekHubSsoClaims } = hubSessionMod;
const app = express();
app.set('trust proxy', true); // as app.js does on Render: req.ip is the X-Forwarded-For client
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/hub-sso', hubSsoRoutes);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}, secret = SECRET) {
  const payload = { email: 'newbie@example.test', store_code: 'MB', exp: Math.floor(Date.now() / 1000) + 30, nonce: crypto.randomBytes(16).toString('hex'), role: 'viewer', ...over };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(bytes).digest();
  return { ticket: `${b64u(bytes)}.${b64u(sig)}`, payload };
}
let ipCounter = 0;
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter++) & 255}`;
async function exchange(body, { form = false, ip = freshIp(), origin = HUB_ORIGIN, referer = undefined } = {}) {
  const headers = { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': ip };
  if (origin !== null) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  const res = await fetch(BASE + '/api/v1/hub-sso/exchange', {
    method: 'POST', redirect: 'manual', headers,
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
}
const cookieVal = (cookies, name) => { const c = cookies.find((s) => s.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const login = (email, password, ip) => fetch(BASE + '/api/v1/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password }),
});
const me = (accessToken) => fetch(BASE + '/api/v1/auth/me', { headers: { cookie: `accessToken=${accessToken}` } });

const LOCAL_PW = 'Local-Passw0rd!';
async function seedUser(email, extra = {}) {
  const hash = await hashPassword(LOCAL_PW);
  const [u] = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified)
     VALUES ($1, $2, 'L', 'U', true, true) RETURNING *`, [email, hash]);
  for (const [k, v] of Object.entries(extra)) await pool.query(`UPDATE users SET ${k} = $1 WHERE id = $2`, [v, u.id]);
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
// F3 (P1-3) the rate limiter must not be reachable while the feature is dark,
//           and a successful 302 must not be counted as a failed attempt.
// ─────────────────────────────────────────────────────────────────────────────
await seedUser('local@example.test');
{
  const ip = '198.51.100.11';
  let last;
  for (let i = 0; i < 26; i++) last = await exchange({ ticket: mint().ticket }, { ip });
  ok(last.status === 404, 'F3 dark route answers 404 for all 26 posts (flag unset)', last.status + ' ' + last.text);
  const l = await login('local@example.test', LOCAL_PW, ip);
  ok(l.status === 200, "F3 26 posts to the DARK sso route do NOT consume the store's own login budget (own login from the same IP still 200)", l.status + ' ' + (await l.text()).slice(0, 120));
}

process.env.HUB_SSO_SECRET = SECRET;
process.env.HUB_ORIGIN = HUB_ORIGIN;
process.env.HUB_SSO_ENABLED = '1';

{
  const ip = '198.51.100.22';
  const statuses = [];
  for (let i = 0; i < 26; i++) statuses.push((await exchange({ ticket: mint({ email: 'burst@example.test' }).ticket }, { ip })).status);
  ok(statuses.every((s) => s === 302), 'F3 26 VALID hops from one IP all succeed (a 302 is not a failed attempt)', statuses.join(','));
  const l = await login('local@example.test', LOCAL_PW, ip);
  ok(l.status === 200, 'F3 26 valid hops do not lock the local login on that IP', l.status);
}
{
  const ip = '198.51.100.33';
  let last;
  for (let i = 0; i < 26; i++) last = await exchange({ ticket: 'nope' }, { ip });
  ok(last.status === 429, 'F3 26 FAILED exchanges from one IP are still limited -> 429', last.status + ' ' + last.text);
  const l = await login('local@example.test', LOCAL_PW, ip);
  ok(l.status === 200, 'F3 the sso limiter has its OWN bucket: a limited SSO IP can still use the local login', l.status);
}

// ─────────────────────────────────────────────────────────────────────────────
// F4 (P2-6) Origin / Referer check
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = mint({ email: 'origin@example.test' });
  const bad = await exchange({ ticket: t.ticket }, { origin: 'https://evil.example' });
  ok(bad.status === 403 && bad.cookies.length === 0, 'F4 foreign Origin -> 403, no cookies', bad.status + ' ' + bad.text);
  ok((await q('SELECT count(*)::int n FROM hub_sso_used_tickets WHERE nonce=$1', [t.payload.nonce]))[0].n === 0, 'F4 refused request burned nothing');
  ok((await q('SELECT count(*)::int n FROM users WHERE email=$1', ['origin@example.test']))[0].n === 0, 'F4 refused request created no user');

  const none = await exchange({ ticket: mint({ email: 'origin2@example.test' }).ticket }, { origin: null });
  ok(none.status === 403, 'F4 no Origin and no Referer -> 403 (fail closed)', none.status + ' ' + none.text);

  const ref = await exchange({ ticket: mint({ email: 'origin3@example.test' }).ticket }, { origin: null, referer: HUB_ORIGIN + '/stores/MB' });
  ok(ref.status === 302, 'F4 Referer from the hub origin is accepted when the browser sends no Origin', ref.status + ' ' + ref.text);

  const badRef = await exchange({ ticket: mint({ email: 'origin4@example.test' }).ticket }, { origin: null, referer: 'https://evil.example/x' });
  ok(badRef.status === 403, 'F4 foreign Referer -> 403', badRef.status + ' ' + badRef.text);

  delete process.env.HUB_ORIGIN;
  const unset = await exchange({ ticket: mint({ email: 'origin5@example.test' }).ticket });
  ok(unset.status === 503 && /HUB_ORIGIN/.test(unset.text), 'F4 HUB_ORIGIN unset while the flag is on -> 503 naming the key (never an unchecked origin)', unset.status + ' ' + unset.text);
  process.env.HUB_ORIGIN = HUB_ORIGIN;
}

// ─────────────────────────────────────────────────────────────────────────────
// F5 (P2-2) HUB_SSO_SECRET must be at least 32 bytes
// ─────────────────────────────────────────────────────────────────────────────
{
  const short = 'a'.repeat(31);
  process.env.HUB_SSO_SECRET = short;
  const t = mint({ email: 'shortkey@example.test' }, short);
  const r = await exchange({ ticket: t.ticket });
  ok(r.status === 503 && /HUB_SSO_SECRET/.test(r.text), 'F5 31-byte HUB_SSO_SECRET -> 503 naming the key, ticket NOT accepted', r.status + ' ' + r.text);
  ok(!/aaaa/.test(r.text), 'F5 the 503 body does not echo the secret', r.text);
  ok((await q('SELECT count(*)::int n FROM users WHERE email=$1', ['shortkey@example.test']))[0].n === 0, 'F5 nothing created under a weak key');

  const exact = 'b'.repeat(32);
  process.env.HUB_SSO_SECRET = exact;
  const t2 = mint({ email: 'exactkey@example.test' }, exact);
  const r2 = await exchange({ ticket: t2.ticket });
  ok(r2.status === 302, 'F5 exactly 32 bytes is accepted (the floor, not more)', r2.status + ' ' + r2.text);
  process.env.HUB_SSO_SECRET = SECRET;
}

// ─────────────────────────────────────────────────────────────────────────────
// F6 (P2-1 / P2-5) locked accounts, case-insensitive email, ambiguity, last_login
// ─────────────────────────────────────────────────────────────────────────────
{
  const locked = await seedUser('locked@example.test');
  await pool.query("UPDATE users SET failed_login_attempts = 5, locked_until = NOW() + INTERVAL '10 minutes' WHERE id = $1", [locked.id]);
  const own = await login('locked@example.test', LOCAL_PW, freshIp());
  ok(own.status === 423, 'F6 control: the store\'s own login refuses a locked account with 423 (authController.js:176-179)', own.status);
  const r = await exchange({ ticket: mint({ email: 'locked@example.test' }).ticket });
  ok(r.status === 423 && r.cookies.length === 0, 'F6 a LOCKED account is refused by the SSO hop too -> 423, no cookies', r.status + ' ' + r.text);
  ok((await q('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [locked.id]))[0].n === 0, 'F6 no session row for the locked account');

  const mixed = await seedUser('MiXeD@Example.test');
  const rm = await exchange({ ticket: mint({ email: 'mixed@example.test' }).ticket });
  ok(rm.status === 302, 'F6 email match is case-insensitive: a lower-case ticket opens the MiXeD@ account', rm.status + ' ' + rm.text);
  ok((await q("SELECT count(*)::int n FROM users WHERE lower(email)='mixed@example.test'"))[0].n === 1, 'F6 no second user row was created for the other casing');
  const [after] = await q('SELECT last_login, failed_login_attempts, locked_until FROM users WHERE id=$1', [mixed.id]);
  ok(after.last_login !== null, 'F6 a successful hop sets last_login (authController.js:203-206)', JSON.stringify(after));
  ok(after.failed_login_attempts === 0 && after.locked_until === null, 'F6 a successful hop clears the failed-login counters', JSON.stringify(after));

  await seedUser('dup@example.test'); await seedUser('DUP@example.test');
  const rd = await exchange({ ticket: mint({ email: 'dup@example.test' }).ticket });
  ok(rd.status === 409 && rd.cookies.length === 0, 'F6 two rows differing only in case -> 409, never an arbitrary pick', rd.status + ' ' + rd.text);
  ok((await q("SELECT count(*)::int n FROM sessions s JOIN users u ON u.id=s.user_id WHERE lower(u.email)='dup@example.test'"))[0].n === 0, 'F6 the ambiguous hop opened no session');
}

// ─────────────────────────────────────────────────────────────────────────────
// F7 (P1-4) revocation takes effect on the VERY NEXT request (DECISION: no grace)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = await exchange({ ticket: mint({ email: 'revoke@example.test' }).ticket });
  ok(r.status === 302, 'F7 setup: hop succeeded', r.status + ' ' + r.text);
  const access = cookieVal(r.cookies, 'accessToken');
  const m1 = await me(access);
  ok(m1.status === 200, 'F7 the session works before revocation', m1.status);
  const [u] = await q('SELECT id FROM users WHERE email=$1', ['revoke@example.test']);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]); // what logout / "log out other devices" / an admin revoke does
  const m2 = await me(access);
  ok(m2.status === 401, 'F7 a REVOKED session is refused on the very next request (no 60 s grace, no cache)', m2.status + ' ' + (await m2.text()).slice(0, 120));

  const r2 = await exchange({ ticket: mint({ email: 'deact@example.test' }).ticket });
  const access2 = cookieVal(r2.cookies, 'accessToken');
  ok((await me(access2)).status === 200, 'F7 setup: second session works');
  await pool.query("UPDATE users SET is_active=false WHERE email='deact@example.test'");
  const m3 = await me(access2);
  ok(m3.status === 401, 'F7 a DEACTIVATED user (what a hub removal writes) is refused on the very next request', m3.status);

  // structural: hub-SSO tokens are marked and routed past the 5-minute session cache
  const { peekHubSsoClaims } = hubSessionMod;
  const l = await login('local@example.test', LOCAL_PW, freshIp());
  const localToken = (await l.json()).accessToken;
  ok(peekHubSsoClaims(access)?.hub_sso === true && typeof peekHubSsoClaims(access).sid === 'string', 'F7 an SSO access token carries hub_sso + sid', JSON.stringify(peekHubSsoClaims(access)));
  ok(peekHubSsoClaims(localToken) === null, 'F7 an ordinary login token is not marked (its cached path is unchanged)');
  const authSrc = await readFile(join(REPO, 'server/src/middleware/auth.js'), 'utf8');
  const cacheRead = authSrc.indexOf('await getCachedSession(');
  const guard = authSrc.indexOf('peekHubSsoClaims(');
  ok(guard > 0 && guard < cacheRead, 'F7 auth.js decides the hub-SSO path BEFORE it reads the session cache', `guard=${guard} cacheRead=${cacheRead}`);
  ok(/if \(!hubSso\)[^\n]*\n[^\n]*getCachedSession/.test(authSrc) || /hubSso \? null : await getCachedSession/.test(authSrc), 'F7 the session-cache READ is skipped for hub-SSO tokens');
  ok(/if \(!hubSso\) await cacheSession\(/.test(authSrc), 'F7 the session-cache WRITE is skipped for hub-SSO tokens');
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths for the new code itself
// ─────────────────────────────────────────────────────────────────────────────
{
  process.env.HUB_ORIGIN = 'not a url';
  const r = await exchange({ ticket: mint({ email: 'badcfg@example.test' }).ticket });
  ok(r.status === 503 && /HUB_ORIGIN/.test(r.text), 'EDGE a HUB_ORIGIN that is not a URL is treated as unset -> 503, never as "allow anything"', r.status + ' ' + r.text);
  process.env.HUB_ORIGIN = `https://other.example, ${HUB_ORIGIN}`;
  const r2 = await exchange({ ticket: mint({ email: 'multi@example.test' }).ticket });
  ok(r2.status === 302, 'EDGE HUB_ORIGIN accepts a comma-separated list (a hub with more than one hostname)', r2.status + ' ' + r2.text);
  const r3 = await exchange({ ticket: mint({ email: 'garbage@example.test' }).ticket }, { origin: 'http://[not-an-origin' });
  ok(r3.status === 403, 'EDGE an unparseable Origin header is refused, not thrown on', r3.status + ' ' + r3.text);
  process.env.HUB_ORIGIN = HUB_ORIGIN;

  const { signAccessToken } = await import('../../src/utils/jwt.js');
  const [any] = await q("SELECT id, email FROM users WHERE email='local@example.test'");
  const forgedNoSid = signAccessToken({ userId: any.id, email: any.email, roles: [], hub_sso: true });
  ok((await me(forgedNoSid)).status === 401, 'EDGE a token marked hub_sso with NO sid is refused (fail closed), even though it verifies');
  const forgedSid = signAccessToken({ userId: any.id, email: any.email, roles: [], hub_sso: true, sid: '00000000-0000-0000-0000-000000000000' });
  ok((await me(forgedSid)).status === 401, 'EDGE a token whose sid names no session row is refused');
  const plain = signAccessToken({ userId: any.id, email: any.email, roles: [] });
  ok((await me(plain)).status === 200, 'EDGE control: an unmarked token for the same user still authenticates (no regression for local logins)');
  ok(peekHubSsoClaims('') === null && peekHubSsoClaims('a.b.c') === null && peekHubSsoClaims(undefined) === null, 'EDGE peekHubSsoClaims never throws on a malformed token');
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await pool.end();
process.exit(fail === 0 ? 0 : 1);
