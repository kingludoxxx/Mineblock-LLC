// HUB -> DASHBOARD END-TO-END (S1-4, Lane E): the REAL hub (store-hub) mints the ticket after a password + TOTP login,
// the REAL dashboard router exchanges it. This is the cross-repo contract test: the two unit files each assert their own
// reading of the ticket format; this one proves the two readings agree, by execution.
//
// Needs the hub checkout: HUB_REPO_DIR=/path/to/store-hub (its node_modules installed) and a hub test database
// HUB_TEST_DATABASE_URL (default postgres://postgres@127.0.0.1:5433/lane_sso_hub). Without HUB_REPO_DIR it SKIPS visibly (exit 0).
//
// Run:  HUB_REPO_DIR=~/store-hub node server/tests/hub-sso/e2e-hub.mjs
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const HUB = process.env.HUB_REPO_DIR;
if (!HUB) { console.log('SKIP  e2e-hub: HUB_REPO_DIR not set (needs the store-hub checkout)'); process.exit(0); }
const HUB_DB = process.env.HUB_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/lane_sso_hub';
const DASH_DB = process.env.HUB_SSO_TEST_DB || 'postgres://postgres@127.0.0.1:5433/lane_sso';
const SECRET = 'e2e-store-secret-' + crypto.randomBytes(12).toString('hex');
const STORE = 'E2E';
const PORT = 48953;

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// ── dashboard side: fresh schema, real router ──────────────────────────────
Object.assign(process.env, {
  DATABASE_URL: DASH_DB, NODE_ENV: 'development', PORT: String(PORT),
  JWT_ACCESS_SECRET: 'e2e-access-' + crypto.randomBytes(8).toString('hex'), JWT_REFRESH_SECRET: 'e2e-refresh-' + crypto.randomBytes(8).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1', HUB_SSO_ENABLED: '1', HUB_SSO_SECRET: SECRET, STORE_CODE: STORE,
});
const { default: pg } = await import('pg');
const dash = new pg.Pool({ connectionString: DASH_DB });
await dash.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of ['001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql', '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql', '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql', '076_team_invitations.sql', '126_hub_sso.sql']) {
  await dash.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
}
const { seedRoles, pool: seedPool } = await import('../../seeds/seed_roles.js');
await seedRoles(); await seedPool.end();
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: authRoutes } = await import('../../src/routes/auth.js');
const { default: hubSsoRoutes } = await import('../../src/routes/hubSso.js');
const app = express();
app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/auth', authRoutes); app.use('/api/v1/hub-sso', hubSsoRoutes);
const server = app.listen(PORT);
const DASH = `http://127.0.0.1:${PORT}`;

// ── hub side: real app on an ephemeral port, its own database ──────────────
const hubMod = async (rel) => import(pathToFileURL(join(HUB, rel)).href);
const { runMigrations } = await hubMod('src/migrate.js');
const { createApp } = await hubMod('src/app.js');
const { seedFromJson } = await hubMod('src/seed.js');
const { encryptMfaSecret } = await hubMod('src/mfa.js');
const { authenticator } = await hubMod('node_modules/otplib/index.js');
const hubKey = crypto.randomBytes(32);
{ const p = new pg.Pool({ connectionString: HUB_DB }); await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await runMigrations({ pool: p, dir: join(HUB, 'migrations'), log: () => {} }); await p.end(); }
const hubApp = await createApp({ databaseUrl: HUB_DB, secretsKey: hubKey.toString('base64'), secretsKeyVersion: 1, platformEnvKeys: [], cookieSecure: false });
const hubServer = await new Promise((r) => { const s = hubApp.listen(0, '127.0.0.1', () => r(s)); });
const HUBURL = `http://127.0.0.1:${hubServer.address().port}`;
process.env.HUB_ORIGIN = HUBURL; // the dashboard only accepts an exchange POSTed from the hub's own origin (review P2-6)
const hubPool = hubApp.locals.pool;
const OPERATOR = 'operator@example.test'; const PASSWORD = 'E2e-Passw0rd!' + crypto.randomBytes(3).toString('hex');
await seedFromJson(hubPool, {
  stores: [{ code: STORE, name: 'E2E store', status: 'active', shopify_domain: 'e2e-1.myshopify.com', gateway_type: 'whop', gateway_company_id: 'biz_e2e', dashboard_origin: DASH.replace('http://', 'https://'), timezone: 'UTC', currency: 'USD', language: 'en' }],
  users: [{ email: OPERATOR, roles: [{ store_code: STORE, role: 'operator' }] }],
}, { passwords: { [OPERATOR]: PASSWORD }, actor: 'e2e' });
const totpSecret = authenticator.generateSecret();
{ const { rows: [u] } = await hubPool.query('SELECT id FROM users WHERE email=$1', [OPERATOR]); await hubPool.query('UPDATE users SET mfa_secret=$2, mfa_enrolled_at=now() WHERE id=$1', [u.id, encryptMfaSecret(hubKey, totpSecret, u.id)]); }

// minimal cookie jar against the hub
const jar = new Map();
async function hub(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (!['GET'].includes(method) && !('x-csrf-token' in headers) && jar.get('hub_csrf')) headers['x-csrf-token'] = jar.get('hub_csrf');
  const res = await fetch(HUBURL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); if (/max-age=0/i.test(sc)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

// 1. hub login: password alone -> 401; password + TOTP -> session
{
  const r0 = await hub('POST', '/hub/auth/login', { email: OPERATOR, password: PASSWORD });
  ok(r0.status === 401 && r0.json?.mfa_required === true, 'E1 hub: password without TOTP -> 401 mfa_required', r0.status + ' ' + r0.text);
  const r1 = await hub('POST', '/hub/auth/login', { email: OPERATOR, password: PASSWORD, totp: authenticator.generate(totpSecret) });
  ok(r1.status === 200 && jar.has('hub_session'), 'E1 hub: password + TOTP -> session', r1.status + ' ' + r1.text);
}
// 2. operator sets the store's HUB_SSO_SECRET? No: an operator is below owner. The OWNER path is the secret write; here the seed
//    plays the owner through a second user so the test also shows the tenancy rule holding on the ticket route's inputs.
{
  const r = await hub('PUT', `/hub/stores/${STORE}/secrets/HUB_SSO_SECRET`, { value: SECRET });
  ok(r.status === 403, 'E2 hub: an operator cannot write the store secret (owner only)', r.status + ' ' + r.text);
  const OWNER = 'owner@example.test'; const OPW = 'Own3r-Passw0rd!';
  await seedFromJson(hubPool, { stores: [], users: [{ email: OWNER, roles: [{ store_code: STORE, role: 'owner' }] }] }, { passwords: { [OWNER]: OPW }, actor: 'e2e' });
  const ownerSecret = authenticator.generateSecret();
  const { rows: [ou] } = await hubPool.query('SELECT id FROM users WHERE email=$1', [OWNER]);
  await hubPool.query('UPDATE users SET mfa_secret=$2, mfa_enrolled_at=now() WHERE id=$1', [ou.id, encryptMfaSecret(hubKey, ownerSecret, ou.id)]);
  const operatorJar = new Map(jar); jar.clear();
  ok((await hub('POST', '/hub/auth/login', { email: OWNER, password: OPW, totp: authenticator.generate(ownerSecret) })).status === 200, 'E2 hub: owner logs in');
  ok((await hub('PUT', `/hub/stores/${STORE}/secrets/HUB_SSO_SECRET`, { value: SECRET })).status === 200, 'E2 hub: owner sets HUB_SSO_SECRET (write-only)');
  ok((await hub('PUT', `/hub/stores/${STORE}/flags/hub_sso_enabled`, { value: true })).status === 200, 'E2 hub: owner turns hub_sso_enabled on');
  const list = await hub('GET', `/hub/stores/${STORE}/secrets`);
  ok(list.status === 200 && !list.text.includes(SECRET) && list.json.some((s) => s.name === 'HUB_SSO_SECRET' && s.is_set), 'E2 hub: the secret lists as set and never reads back');
  jar.clear(); for (const [k, v] of operatorJar) jar.set(k, v);
}
// 3. operator mints a ticket; the dashboard exchanges it
let ticket;
{
  const r = await hub('POST', `/hub/stores/${STORE}/ticket`, {});
  ok(r.status === 200 && typeof r.json?.ticket === 'string', 'E3 hub: operator mints a ticket for the store', r.status + ' ' + r.text);
  ticket = r.json.ticket;
  const { rows: [a] } = await hubPool.query("SELECT actor, action, store_code FROM audit_log WHERE action='sso.ticket' ORDER BY id DESC LIMIT 1");
  ok(a && a.actor === OPERATOR && a.store_code === STORE, 'E3 hub: audit row sso.ticket by the operator on the store', JSON.stringify(a));
  const x = await fetch(DASH + '/api/v1/hub-sso/exchange', { method: 'POST', redirect: 'manual', headers: { origin: process.env.HUB_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, next: '/funnels' }).toString() });
  const cookies = x.headers.getSetCookie();
  ok(x.status === 302 && x.headers.get('location') === '/funnels', 'E4 dashboard: exchanges the HUB-minted ticket -> 302 /funnels', x.status + ' ' + (await x.text()));
  const access = cookies.find((c) => c.startsWith('accessToken='))?.split(';')[0].slice('accessToken='.length);
  ok(!!access, 'E4 dashboard: accessToken cookie issued');
  const me = await fetch(DASH + '/api/v1/auth/me', { headers: { cookie: `accessToken=${access}` } }); const mj = await me.json();
  ok(me.status === 200 && mj.email === OPERATOR && mj.roles?.[0]?.name === 'Manager', 'E4 dashboard: JIT user = the hub operator, role operator -> Manager, session opens /auth/me', me.status + ' ' + JSON.stringify(mj).slice(0, 160));
  // the hub audit hash correlates with the exchanged bytes
  const bytes = Buffer.from(ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const { rows: [h] } = await hubPool.query("SELECT payload_hash FROM audit_log WHERE action='sso.ticket' ORDER BY id DESC LIMIT 1");
  ok(h.payload_hash === crypto.createHash('sha256').update(bytes).digest('hex'), 'E5 hub audit payload_hash == sha256(signed bytes the dashboard received)');
  const nonce = JSON.parse(bytes.toString('utf8')).nonce;
  const { rows: burned } = await dash.query('SELECT nonce FROM hub_sso_used_tickets WHERE nonce=$1', [nonce]);
  ok(burned.length === 1, 'E5 dashboard burned exactly that nonce');
  const again = await fetch(DASH + '/api/v1/hub-sso/exchange', { method: 'POST', redirect: 'manual', headers: { origin: process.env.HUB_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  ok(again.status === 401, 'E6 the same hub ticket replayed -> 401', String(again.status));
}
// 4. a ticket for ANOTHER store, minted by the same hub, is refused by this dashboard (audience)
{
  await seedFromJson(hubPool, { stores: [{ code: 'OTH', name: 'Other', status: 'active', shopify_domain: 'oth-1.myshopify.com', gateway_type: 'whop', gateway_company_id: 'biz_oth' }], users: [{ email: OPERATOR, roles: [{ store_code: STORE, role: 'operator' }, { store_code: 'OTH', role: 'owner' }] }] }, { passwords: { [OPERATOR]: PASSWORD }, actor: 'e2e' });
  const { rows: [u] } = await hubPool.query('SELECT id FROM users WHERE email=$1', [OPERATOR]);
  await hubPool.query('UPDATE users SET mfa_secret=$2, mfa_enrolled_at=now() WHERE id=$1', [u.id, encryptMfaSecret(hubKey, totpSecret, u.id)]);
  jar.clear();
  ok((await hub('POST', '/hub/auth/login', { email: OPERATOR, password: PASSWORD, totp: authenticator.generate(totpSecret) })).status === 200, 'E7 hub: re-login after the role grant');
  await hub('PUT', '/hub/stores/OTH/secrets/HUB_SSO_SECRET', { value: SECRET }); // same secret on purpose: audience must still refuse
  await hub('PUT', '/hub/stores/OTH/flags/hub_sso_enabled', { value: true });
  const r = await hub('POST', '/hub/stores/OTH/ticket', {});
  ok(r.status === 200, 'E7 hub: ticket for the other store minted', r.status + ' ' + r.text);
  const x = await fetch(DASH + '/api/v1/hub-sso/exchange', { method: 'POST', redirect: 'manual', headers: { origin: process.env.HUB_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: r.json.ticket }) });
  ok(x.status === 401, `E7 dashboard STORE_CODE=${STORE} refuses a ticket for OTH even under the same secret -> 401`, String(x.status));
}
// 5. the hub goes away: the dashboard's own login still works
{
  await new Promise((r) => hubServer.close(r)); await hubPool.end();
  const login = await fetch(DASH + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.test', password: 'x' }) });
  ok(login.status === 401, 'E8 hub stopped: the dashboard login route answers on its own (401 for an unknown user, not a 5xx)', String(login.status));
}

server.close(); await dash.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
