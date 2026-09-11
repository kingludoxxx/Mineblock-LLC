// HUB SSO EXCHANGE (S1-4, Lane E) — drives the REAL /api/v1/hub-sso router next to the REAL /api/v1/auth router
// (real authenticate, real cookies) against a fresh Postgres on 5433, schema built from the REAL migrations off disk.
//
// Proves BY EXECUTION (acceptance lines from LANE-E-SSO.md):
//   A4  flag unset / not '1' -> 404 and NO table touched (proved before the SSO migration exists: a touch would 500)
//   H1  valid ticket -> 302 to next, the dashboard's OWN cookies (accessToken / refreshToken, same options as login),
//       the cookie opens GET /auth/me and POST /auth/refresh (the SPA's bootstrap path), nonce burned, audit rows
//   A2  replayed ticket -> 401; two PARALLEL exchanges of one ticket -> exactly one 302
//   A3  exp 31 s ago -> 401; exp 29 s ago accepted (30 s skew); exp too far in the future -> 401
//   A1  ticket for PL presented to a dashboard with STORE_CODE=MB -> 401, no user created
//   A5  unknown email -> user created with the LEAST-PRIVILEGED role + audit row; unknown hub role -> same fallback;
//       existing email -> no role change, no new user; inactive user -> 401
//   A6  next='//evil' / 'https://…' / '/\\evil' -> 400; relative next honoured; default '/'
//   A7  hub stopped (nothing listens) -> the dashboard's own POST /auth/login is unaffected; no outbound call in the code
//   A9  no secret, no ticket signature, no nonce in any log line (stdout+stderr captured for the whole run)
//   +   bad signature 401; malformed 400; incomplete 400; secret unset 503; STORE_CODE unset 503; form-encoded body OK;
//       role map owner->Admin; used-ticket TTL cleanup
//
// Run:  node server/tests/hub-sso/hub-sso.mjs        (DSN below; the database is created by this lane)
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.HUB_SSO_TEST_DB || 'postgres://postgres@127.0.0.1:5433/lane_sso';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(12).toString('hex');
const PORT = 48947;

// ── capture every byte the process writes (A9) ─────────────────────────────
const captured = [];
const origOut = process.stdout.write.bind(process.stdout); const origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...r) => { captured.push(String(c)); return origOut(c, ...r); };
process.stderr.write = (c, ...r) => { captured.push(String(c)); return origErr(c, ...r); };

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT),
  JWT_ACCESS_SECRET: 'test-access-' + crypto.randomBytes(8).toString('hex'), JWT_REFRESH_SECRET: 'test-refresh-' + crypto.randomBytes(8).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1', // nothing listens: the code paths must degrade, never depend on it
  STORE_CODE: 'MB',
  HUB_ORIGIN: 'https://hub.example.test', // the hub's own origin: the exchange refuses a POST from anywhere else (review P2-6)
});
delete process.env.HUB_SSO_ENABLED; delete process.env.HUB_SSO_SECRET;

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGS = ['001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql', '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql', '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql', '076_team_invitations.sql'];
for (const f of MIGS) await pool.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
const { seedRoles, pool: seedPool } = await import('../../seeds/seed_roles.js');
await seedRoles(); await seedPool.end();

const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: authRoutes } = await import('../../src/routes/auth.js');
const { default: hubSsoRoutes } = await import('../../src/routes/hubSso.js');
const { safeNext } = await import('../../src/routes/hubSso.js');
const { BAD_NEXT_FORMS, GOOD_NEXT_FORMS, EMPTY_NEXT } = await import('./next-forms.mjs');
const app = express();
// The auth rate limiter keys on req.ip (25 FAILED attempts / 15 min). This file refuses far more than 25 tickets on purpose,
// so each request carries its own X-Forwarded-For (trust proxy, as app.js:41 does on Render); one block below pins the
// same IP to prove the limiter guards the exchange too.
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/hub-sso', hubSsoRoutes); // same mount as routes/index.js
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

// ── the ticket format the hub mints (store-hub src/routes/tickets.js) ──────
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}, secret = SECRET) {
  const payload = { email: 'newbie@example.test', store_code: 'MB', exp: Math.floor(Date.now() / 1000) + 30, nonce: crypto.randomBytes(16).toString('hex'), role: 'viewer', ...over };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(bytes).digest();
  return { ticket: `${b64u(bytes)}.${b64u(sig)}`, payload, sig: b64u(sig) };
}
const minted = [];
let ipCounter = 0;
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter++) & 255}`;
async function exchange(body, { form = false, ip = freshIp() } = {}) {
  const res = await fetch(BASE + '/api/v1/hub-sso/exchange', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': ip, origin: process.env.HUB_ORIGIN },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
}
const cookieVal = (cookies, name) => { const c = cookies.find((s) => s.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };
const q = async (sql, params) => (await pool.query(sql, params)).rows;

// ── A4: flag unset, BEFORE the SSO migration exists ────────────────────────
{
  const t = mint(); minted.push(t);
  const r = await exchange({ ticket: t.ticket });
  ok(r.status === 404, 'A4 HUB_SSO_ENABLED unset -> 404', r.status + ' ' + r.text);
  process.env.HUB_SSO_ENABLED = '0'; process.env.HUB_SSO_SECRET = SECRET;
  const r0 = await exchange({ ticket: t.ticket });
  ok(r0.status === 404, "A4 HUB_SSO_ENABLED='0' -> 404", r0.status);
  process.env.HUB_SSO_ENABLED = 'true';
  ok((await exchange({ ticket: t.ticket })).status === 404, "A4 HUB_SSO_ENABLED='true' (not '1') -> 404");
  const tables = await q("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'hub_%'");
  ok(tables.length === 0, 'A4 no hub_* table exists yet, so a 404 that touched one would have been a 500', JSON.stringify(tables));
  ok((await q('SELECT count(*)::int n FROM users'))[0].n === 0, 'A4 no user created while off');
}

// ── apply THIS lane's migration verbatim off disk, twice (idempotent) ───────
const MIG = join(REPO, 'server/migrations/126_hub_sso.sql');
const migSql = await readFile(MIG, 'utf8');
await pool.query(migSql); await pool.query(migSql);
{
  const map = Object.fromEntries((await q('SELECT hub_role, dashboard_role FROM hub_role_map ORDER BY hub_role')).map((r) => [r.hub_role, r.dashboard_role]));
  ok(map.viewer === 'Viewer' && map.editor === 'Manager' && map.admin === 'Admin', 'M1 hub_role_map seeded viewer/editor/admin -> Viewer/Manager/Admin', JSON.stringify(map));
  ok(map.operator === 'Manager' && map.owner === 'Admin' && map['*'] === 'Viewer', 'M2 hub roles operator/owner mapped; "*" = least-privileged fallback', JSON.stringify(map));
  ok((await q("SELECT count(*)::int n FROM hub_role_map"))[0].n === 6, 'M3 re-running the migration duplicates nothing');
}
process.env.HUB_SSO_ENABLED = '1';

// ── H1 happy path: unknown email, JIT create, own cookies, nonce burned, audit ─
let firstCookies;
{
  const t = mint(); minted.push(t);
  await pool.query("INSERT INTO hub_sso_used_tickets (nonce, exp) VALUES ('stale-nonce', now() - interval '2 days')");
  const r = await exchange({ ticket: t.ticket, next: '/funnels' });
  ok(r.status === 302 && r.location === '/funnels', 'H1 valid ticket -> 302 to the relative next', r.status + ' ' + r.location + ' ' + r.text);
  const access = r.cookies.find((c) => c.startsWith('accessToken=')); const refresh = r.cookies.find((c) => c.startsWith('refreshToken='));
  ok(!!access && /HttpOnly/i.test(access) && /SameSite=Strict/i.test(access) && /Path=\//.test(access) && !/Secure/i.test(access), 'H1 accessToken cookie: HttpOnly, SameSite=Strict, Path=/, secure only in production (authController.js:37-45)', access);
  ok(!!refresh && /HttpOnly/i.test(refresh) && /SameSite=Strict/i.test(refresh) && /Path=\/api\/v1\/auth/.test(refresh), 'H1 refreshToken cookie: HttpOnly, SameSite=Strict, Path=/api/v1/auth (authController.js:47-55)', refresh);
  ok(!r.text.includes('accessToken'), 'H1 no token in the response body (it is a redirect, not the JSON login)');
  firstCookies = r.cookies;
  const [u] = await q('SELECT id, email, is_active, email_verified, password_hash FROM users WHERE email=$1', ['newbie@example.test']);
  ok(!!u && u.is_active === true, 'A5 unknown email -> user created, active', JSON.stringify(u));
  ok(u && u.password_hash && u.password_hash.length > 20, 'A5 JIT user has an unusable (random) password hash, never empty');
  const roles = await q('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [u.id]);
  ok(roles.length === 1 && roles[0].name === 'Viewer', 'A5 JIT role = hub_role_map(viewer) = Viewer', JSON.stringify(roles));
  const audit = await q("SELECT action, resource_type, resource_id::text, new_values FROM audit_logs WHERE user_id=$1 ORDER BY created_at", [u.id]);
  ok(audit.some((a) => a.action === 'HUB_SSO_JIT_CREATE' && a.resource_type === 'user' && a.new_values?.role === 'Viewer' && a.new_values?.store_code === 'MB'), 'A5 audit row HUB_SSO_JIT_CREATE with role + store_code', JSON.stringify(audit));
  ok(audit.some((a) => a.action === 'HUB_SSO_LOGIN'), 'H1 audit row HUB_SSO_LOGIN', JSON.stringify(audit));
  const burned = await q('SELECT nonce FROM hub_sso_used_tickets WHERE nonce=$1', [t.payload.nonce]);
  ok(burned.length === 1, 'H1 nonce burned in hub_sso_used_tickets');
  ok((await q("SELECT count(*)::int n FROM hub_sso_used_tickets WHERE nonce='stale-nonce'"))[0].n === 0, 'H1 TTL cleanup removed the stale used-ticket row');
  ok((await q('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [u.id]))[0].n === 1, 'H1 a sessions row exists for the refresh token (authController.js:243)');
  // the cookies open the real authenticate + the SPA's bootstrap path
  const me = await fetch(BASE + '/api/v1/auth/me', { headers: { cookie: `accessToken=${cookieVal(r.cookies, 'accessToken')}` } });
  const meJson = await me.json();
  ok(me.status === 200 && meJson.email === 'newbie@example.test' && meJson.roles?.[0]?.name === 'Viewer', 'H1 accessToken cookie passes the REAL authenticate (GET /auth/me)', me.status + ' ' + JSON.stringify(meJson).slice(0, 200));
  const rf = await fetch(BASE + '/api/v1/auth/refresh', { method: 'POST', headers: { cookie: `refreshToken=${cookieVal(r.cookies, 'refreshToken')}` } });
  const rfJson = await rf.json();
  ok(rf.status === 200 && typeof rfJson.accessToken === 'string' && rfJson.user?.email === 'newbie@example.test', 'H1 refreshToken cookie passes the REAL /auth/refresh (the SPA bootstrap, AuthContext.jsx:87)', rf.status + ' ' + JSON.stringify(rfJson).slice(0, 120));
  // A2 replay
  const again = await exchange({ ticket: t.ticket });
  ok(again.status === 401 && again.cookies.length === 0, 'A2 replayed ticket -> 401, no cookies', again.status + ' ' + again.text);
  ok((await q('SELECT count(*)::int n FROM users'))[0].n === 1, 'A2 replay created nothing');
}

// ── A2 parallel replay: exactly one winner ─────────────────────────────────
{
  const t = mint({ email: 'racer@example.test' }); minted.push(t);
  const results = await Promise.all([1, 2, 3, 4].map(() => exchange({ ticket: t.ticket })));
  const wins = results.filter((r) => r.status === 302).length;
  ok(wins === 1 && results.filter((r) => r.status === 401).length === 3, 'A2 four parallel exchanges of one ticket -> exactly one 302, three 401', results.map((r) => r.status).join(','));
  ok((await q("SELECT count(*)::int n FROM users WHERE email='racer@example.test'"))[0].n === 1, 'A2 the race created exactly one user');
}

// ── A3 expiry with 30 s skew; ceiling ───────────────────────────────────────
{
  const now = Math.floor(Date.now() / 1000);
  const old = mint({ email: 'late@example.test', exp: now - 31 }); minted.push(old);
  const r = await exchange({ ticket: old.ticket });
  ok(r.status === 401 && /expired/i.test(r.text), 'A3 exp 31 s ago -> 401 expired', r.status + ' ' + r.text);
  ok((await q("SELECT count(*)::int n FROM users WHERE email='late@example.test'"))[0].n === 0, 'A3 expired ticket created nothing');
  const edge = mint({ email: 'edge@example.test', exp: now - 29 }); minted.push(edge);
  ok((await exchange({ ticket: edge.ticket })).status === 302, 'A3 exp 29 s ago is inside the 30 s skew -> accepted');
  const far = mint({ email: 'far@example.test', exp: now + 600 }); minted.push(far);
  const rf = await exchange({ ticket: far.ticket });
  ok(rf.status === 401 && /ttl/i.test(rf.text), 'A3 exp 10 min in the future exceeds the ceiling -> 401 (a minting bug cannot issue a long-lived ticket)', rf.status + ' ' + rf.text);
}

// ── A1 audience ─────────────────────────────────────────────────────────────
{
  const t = mint({ email: 'pl-person@example.test', store_code: 'PL' }); minted.push(t);
  const r = await exchange({ ticket: t.ticket });
  ok(r.status === 401 && /store/i.test(r.text), 'A1 ticket for PL presented to STORE_CODE=MB -> 401', r.status + ' ' + r.text);
  ok((await q("SELECT count(*)::int n FROM users WHERE email='pl-person@example.test'"))[0].n === 0, 'A1 wrong-audience ticket created no user');
  ok((await q('SELECT count(*)::int n FROM hub_sso_used_tickets WHERE nonce=$1', [t.payload.nonce]))[0].n === 0, 'A1 refused before the burn (nothing written for a foreign audience)');
}

// ── A5 role handling ────────────────────────────────────────────────────────
{
  const t = mint({ email: 'weird@example.test', role: 'superowner' }); minted.push(t);
  ok((await exchange({ ticket: t.ticket })).status === 302, 'A5 unknown hub role still logs in');
  const roles = await q("SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.email='weird@example.test'");
  ok(roles.length === 1 && roles[0].name === 'Viewer', 'A5 unknown hub role -> the "*" fallback = least-privileged (Viewer)', JSON.stringify(roles));
  const t2 = mint({ email: 'boss@example.test', role: 'owner' }); minted.push(t2);
  await exchange({ ticket: t2.ticket });
  const r2 = await q("SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.email='boss@example.test'");
  ok(r2.length === 1 && r2[0].name === 'Admin', 'A5 owner -> Admin per hub_role_map', JSON.stringify(r2));
  // existing user with a stronger role: SSO as viewer must NOT change it, and must not add a role
  const { hashPassword } = await import('../../src/utils/hash.js');
  const [existing] = await q("INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified) VALUES ('existing@example.test', $1, 'Ex', 'Isting', true, true) RETURNING id", [await hashPassword('Existing-Passw0rd!')]);
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='Admin'", [existing.id]);
  const t3 = mint({ email: 'Existing@Example.test', role: 'viewer' }); minted.push(t3);
  const r3 = await exchange({ ticket: t3.ticket });
  ok(r3.status === 302, 'A5 existing email (case-insensitive) logs in', r3.status + ' ' + r3.text);
  const r3roles = await q('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [existing.id]);
  ok(r3roles.length === 1 && r3roles[0].name === 'Admin', 'A5 existing user keeps Admin: no role change, no role added', JSON.stringify(r3roles));
  ok((await q("SELECT count(*)::int n FROM users WHERE lower(email)='existing@example.test'"))[0].n === 1, 'A5 no duplicate user for a different-case email');
  ok((await q('SELECT count(*)::int n FROM audit_logs WHERE user_id=$1 AND action=$2', [existing.id, 'HUB_SSO_JIT_CREATE']))[0].n === 0, 'A5 no JIT audit row for an existing user');
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [existing.id]);
  const t4 = mint({ email: 'existing@example.test' }); minted.push(t4);
  const r4 = await exchange({ ticket: t4.ticket });
  ok(r4.status === 401 && r4.cookies.length === 0, 'A5 deactivated user -> 401, no cookies', r4.status + ' ' + r4.text);
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [existing.id]);
}

// ── A6 next validation ──────────────────────────────────────────────────────
{
  // W6c / R10 P0-1: the bad list is the SHARED one (server/tests/hub-sso/next-forms.mjs), the twin of the hub's
  // test/next-forms.mjs. Five forms written out here is how the whitespace class survived W6 on all three guards.
  for (const { label, raw, why } of BAD_NEXT_FORMS) {
    const t = mint({ email: 'redir@example.test' }); minted.push(t);
    const r = await exchange({ ticket: t.ticket, next: raw });
    ok(r.status === 400 && r.cookies.length === 0, `A6 next=${label} -> 400, no cookies (${why})`, r.status + ' ' + r.text);
  }
  // POSITIVE CONTROL, and the unit-level twin: safeNext itself, on the same list, plus the paths it must KEEP.
  for (const { label, raw } of BAD_NEXT_FORMS) ok(safeNext(raw) === null, `A6 safeNext refuses ${label}`, JSON.stringify(safeNext(raw)));
  for (const good of GOOD_NEXT_FORMS) ok(safeNext(good) === good, `A6 safeNext keeps ${good}`, JSON.stringify(safeNext(good)));
  ok(safeNext(EMPTY_NEXT) === '/', "A6 safeNext('') is the SPA root, not a refusal");
  // THE BUG ITSELF, asserted against the URL parser rather than remembered.
  for (const raw of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example']) {
    ok(new URL(raw, 'https://store.example.test').origin === 'https://evil.example', `A6 ${JSON.stringify(raw)} really does resolve off-site`);
  }
  ok((await q("SELECT count(*)::int n FROM users WHERE email='redir@example.test'"))[0].n === 0, 'A6 a refused next creates no user (validated before any write)');
  const t = mint({ email: 'redir@example.test' }); minted.push(t);
  const r = await exchange({ ticket: t.ticket });
  ok(r.status === 302 && r.location === '/', 'A6 missing next -> 302 /', r.status + ' ' + r.location);
  const t2 = mint({ email: 'redir@example.test' }); minted.push(t2);
  const r2 = await exchange({ ticket: t2.ticket, next: '/orders?x=1#frag' });
  ok(r2.status === 302 && r2.location === '/orders?x=1#frag', 'A6 relative next with query/fragment honoured', r2.location);
}

// ── malformed / bad signature / config ─────────────────────────────────────
{
  const t = mint(); minted.push(t);
  const forged = mint({ email: 'forger@example.test' }, 'wrong-secret'); minted.push(forged);
  const rF = await exchange({ ticket: forged.ticket });
  ok(rF.status === 401 && rF.cookies.length === 0, 'bad signature -> 401', rF.status + ' ' + rF.text);
  ok((await q("SELECT count(*)::int n FROM users WHERE email='forger@example.test'"))[0].n === 0, 'bad signature created nothing');
  const [p64, s64] = t.ticket.split('.');
  const tampered = `${b64u(Buffer.from(JSON.stringify({ ...t.payload, email: 'tamper@example.test' })))}.${s64}`;
  { const rT = await exchange({ ticket: tampered }); ok(rT.status === 401, 'tampered payload under a valid signature -> 401', rT.status + ' ' + rT.text); }
  { const rU = await exchange({ ticket: `${b64u('hello')}.${s64}` }); ok(rU.status === 401, 'payload not JSON under a foreign signature -> 401 (signature is checked before anything is parsed)', rU.status + ' ' + rU.text); }
  for (const [label, body] of [['no dot', { ticket: p64 }], ['not base64', { ticket: '!!!.???' }], ['payload not JSON, correctly signed', { ticket: `${b64u('hello')}.${b64u(crypto.createHmac('sha256', SECRET).update('hello').digest())}` }], ['missing ticket', {}], ['ticket not a string', { ticket: 42 }]]) {
    const r = await exchange(body);
    ok(r.status === 400, `malformed (${label}) -> 400`, r.status + ' ' + r.text);
  }
  const incomplete = mint({ nonce: undefined }); minted.push(incomplete);
  { const rI = await exchange({ ticket: incomplete.ticket }); ok(rI.status === 400, 'signed but incomplete payload (no nonce) -> 400', rI.status + ' ' + rI.text); }
  const noExp = mint({ exp: 'soon' }); minted.push(noExp);
  { const rE = await exchange({ ticket: noExp.ticket }); ok(rE.status === 400, 'signed but exp not a number -> 400', rE.status + ' ' + rE.text); }
  delete process.env.HUB_SSO_SECRET;
  const t5 = mint(); minted.push(t5);
  const r5 = await exchange({ ticket: t5.ticket });
  ok(r5.status === 503 && /HUB_SSO_SECRET/.test(r5.text), 'flag on but HUB_SSO_SECRET unset -> 503 naming the key (never an empty-key HMAC)', r5.status + ' ' + r5.text);
  process.env.HUB_SSO_SECRET = SECRET;
  const savedCode = process.env.STORE_CODE; delete process.env.STORE_CODE;
  const r6 = await exchange({ ticket: t5.ticket });
  ok(r6.status === 503 && /STORE_CODE/.test(r6.text), 'STORE_CODE unset -> 503 naming the key (no audience = no exchange)', r6.status + ' ' + r6.text);
  process.env.STORE_CODE = savedCode;
  // form-encoded body: what the hub's auto-submitting form sends
  const t7 = mint({ email: 'form@example.test' }); minted.push(t7);
  const r7 = await exchange({ ticket: t7.ticket, next: '/' }, { form: true });
  ok(r7.status === 302 && r7.cookies.some((c) => c.startsWith('accessToken=')), 'form-encoded POST (browser form from the hub) -> 302 + cookies', r7.status + ' ' + r7.text);
}

// ── A7: the dashboard's own login does not depend on the hub ───────────────
{
  const login = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ email: 'existing@example.test', password: 'Existing-Passw0rd!' }) });
  const lj = await login.json();
  ok(login.status === 200 && typeof lj.accessToken === 'string' && login.headers.getSetCookie().some((c) => c.startsWith('accessToken=')), 'A7 own /auth/login works with nothing listening for the hub', login.status + ' ' + JSON.stringify(lj).slice(0, 100));
  const src = (await readFile(join(REPO, 'server/src/routes/hubSso.js'), 'utf8')) + (await readFile(join(REPO, 'server/src/services/hubSession.js'), 'utf8'));
  ok(!/\b(fetch|axios|https?:\/\/|node:http|from 'http|from 'https|undici)\b/.test(src), 'A7 grep: hubSso.js + hubSession.js make no outbound call and name no URL');
  ok(!/import[^\n]*authController/.test(src), 'hubSso.js / hubSession.js do not import authController.js (brief: do not touch / do not couple)');
}

// ── the auth rate limiter guards the exchange: 26th failure from ONE IP -> 429 ──
{
  const ip = '203.0.113.7';
  let last;
  for (let i = 0; i < 26; i++) last = await exchange({ ticket: 'nope' }, { ip });
  ok(last.status === 429, 'RL 26 failed exchanges from one IP -> 429 (authRateLimiter, 25 failures / 15 min)', last.status + ' ' + last.text);
  const t = mint({ email: 'limited@example.test' }); minted.push(t);
  ok((await exchange({ ticket: t.ticket }, { ip })).status === 429, 'RL a valid ticket from the limited IP is refused too');
  ok((await exchange({ ticket: t.ticket })).status === 302, 'RL the same ticket from another IP still exchanges (limit is per IP, ticket untouched by the 429)');
}

// ── A9: nothing secret in any log line ─────────────────────────────────────
{
  const log = captured.join('');
  ok(!log.includes(SECRET), 'A9 HUB_SSO_SECRET value appears in no log line');
  ok(minted.every((t) => !log.includes(t.sig)), 'A9 no ticket signature appears in any log line');
  ok(minted.every((t) => !log.includes(t.payload.nonce)), 'A9 no nonce appears in any log line');
  ok(minted.every((t) => !log.includes(t.ticket)), 'A9 no whole ticket appears in any log line');
  ok(!log.includes(process.env.JWT_ACCESS_SECRET) && !log.includes(process.env.JWT_REFRESH_SECRET), 'A9 no JWT secret in any log line');
  const access = cookieVal(firstCookies, 'accessToken');
  ok(!log.includes(access), 'A9 no issued access token in any log line');
}

server.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
