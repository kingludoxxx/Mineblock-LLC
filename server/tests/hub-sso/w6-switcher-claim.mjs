// W6 — the store switcher inside THIS dashboard's sidebar. Server half, proved by execution against the REAL
// /api/v1/hub-sso router, the REAL /api/v1/store-config router and the REAL authenticate middleware, on a fresh
// Postgres (5433) whose schema is built from the REAL migrations off disk.
//
// What is proved here:
//   C1  COMPATIBILITY, first and before any change: a ticket carrying the hub's new `stores` field is accepted by
//       the exchange exactly as it is today. (Run this file on the unmodified tree and C1 passes: unknown ticket
//       fields are ignored. That is what makes the hub's change safe to deploy first.)
//   S1  a valid ticket's `stores` list is persisted on the SESSION row (migration 132), never on the client
//   S2  a malformed list is IGNORED — the ticket is still accepted, the session simply carries no list
//   S3  the cap (50) and the field shape ({code,name,role,can_hop}) are enforced on the way in
//   W6b W6 deviation 6 closed: validation is PER ENTRY. One unusable entry is skipped and the rest of the list
//       is kept, where W6 dropped the whole dropdown. Plus the wider code grammar (^[A-Z0-9]{1,8}$: the HUB is
//       the authority on codes) and the backward-compatible defaults for a W6-shaped ticket.
//   S4  GET /api/v1/store-config carries hub{origin, sso_enabled} + switcher{current, stores} for that session,
//       read at REQUEST time (R7): flipping the env between two requests changes the answer
//   S5  a plain (non-hub) session sees switcher.stores = [] — a local login never invents a list (R21)
//   S6  nothing in either answer is a secret, and the list is exactly what the SIGNED ticket said
//
// Run:  node server/tests/hub-sso/w6-switcher-claim.mjs
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DB = process.env.W6_TEST_DB || 'postgres://postgres@127.0.0.1:5433/lane_w6_sso';
const SECRET = 'hub-sso-secret-' + crypto.randomBytes(16).toString('hex');
const PORT = 48953;

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', PORT: String(PORT),
  JWT_ACCESS_SECRET: 'w6-access-' + crypto.randomBytes(8).toString('hex'),
  JWT_REFRESH_SECRET: 'w6-refresh-' + crypto.randomBytes(8).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1',
  STORE_CODE: 'MB',
  HUB_ORIGIN: 'https://hub.example.test',
  HUB_SSO_ENABLED: '1',
  HUB_SSO_SECRET: SECRET,
  // store-config needs its required key; none of these is a store the dashboard hardcodes (R5/R15).
  PRODUCT_CODES_JSON: '{"ZZ":{"default":true,"clickup":{"videoListId":"901"},"frameio":{"projectId":"proj-zz"}}}',
  FRAMEIO_TOKEN: 'LEAK-w6-frameio-token-a1b2',
});

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x ? `\n      ${x}` : ''); } };

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGS = ['001_create_roles.sql', '002_create_users.sql', '003_create_user_roles.sql', '005_create_sessions.sql', '006_create_audit_logs.sql', '008_fix_sessions_column.sql', '009_saas_users.sql', '010_create_workspaces.sql', '011_create_workspace_members.sql', '014_update_sessions.sql', '015_update_audit_logs.sql', '076_team_invitations.sql', '126_hub_sso.sql'];
for (const f of MIGS) await pool.query(await readFile(join(REPO, 'server/migrations', f), 'utf8'));
const { seedRoles, pool: seedPool } = await import('../../seeds/seed_roles.js');
await seedRoles(); await seedPool.end();

const q = async (sql, params) => (await pool.query(sql, params)).rows;

// ── the app: the same mounts routes/index.js uses ───────────────────────────
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: hubSsoRoutes } = await import('../../src/routes/hubSso.js');
const { default: authRoutes } = await import('../../src/routes/auth.js');
const { default: storeConfigRoutes } = await import('../../src/routes/storeConfig.js');
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
app.use('/api/v1/hub-sso', hubSsoRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', storeConfigRoutes);
const server = app.listen(PORT);
await new Promise((r) => setTimeout(r, 200));
const BASE = `http://127.0.0.1:${PORT}`;

// ── the ticket the hub mints (store-hub src/routes/tickets.js, W6 shape) ────
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(over = {}) {
  const payload = {
    email: `w6-${crypto.randomBytes(4).toString('hex')}@example.test`,
    store_code: 'MB', exp: Math.floor(Date.now() / 1000) + 30,
    nonce: crypto.randomBytes(16).toString('hex'), role: 'owner',
    stores: [
      { code: 'MB', name: 'Mineblock', role: 'owner', can_hop: true },
      { code: 'SB', name: 'Sandbox', role: 'owner', can_hop: true },
      { code: 'TW', name: 'Third Wave', role: 'admin', can_hop: true },
      { code: 'PL', name: 'Puure', role: 'owner', can_hop: false },
    ],
    ...over,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { ticket: `${b64u(bytes)}.${b64u(crypto.createHmac('sha256', SECRET).update(bytes).digest())}`, payload };
}
let ipCounter = 0;
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter++) & 255}`;
async function exchange(body) {
  const res = await fetch(BASE + '/api/v1/hub-sso/exchange', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), origin: process.env.HUB_ORIGIN },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
}
const cookieVal = (cookies, name) => { const c = cookies.find((s) => s.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };
const storeConfig = async (accessToken) => {
  const res = await fetch(BASE + '/api/v1/store-config', { headers: accessToken ? { cookie: `accessToken=${accessToken}` } : {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};
/** The session row this exchange opened (there is exactly one per successful exchange). */
const lastSession = async () => (await q('SELECT * FROM sessions ORDER BY created_at DESC, id DESC LIMIT 1'))[0];

// ── C1: the hub's new field is ALREADY harmless — run before any dashboard change ──
{
  const t = mint();
  const r = await exchange({ ticket: t.ticket, next: '/app/dashboard' });
  ok(r.status === 302 && r.location === '/app/dashboard', 'C1 a ticket carrying the new `stores` field is accepted exactly as before (302 to next)', `${r.status} ${r.location} ${r.text}`);
  ok(cookieVal(r.cookies, 'accessToken') !== null, 'C1 it opens the dashboard\'s own session', JSON.stringify(r.cookies));
}

// ── the migration this lane adds, applied off disk, TWICE (idempotent) ─────
const MIG = join(REPO, 'server/migrations/132_session_hub_stores.sql');
const migSql = await readFile(MIG, 'utf8');
await pool.query(migSql); await pool.query(migSql);
{
  const cols = await q("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='sessions' AND column_name='hub_stores'");
  ok(cols.length === 1 && cols[0].data_type === 'jsonb' && cols[0].is_nullable === 'YES', 'M1 migration 132 adds sessions.hub_stores jsonb null, and re-running it changes nothing', JSON.stringify(cols));
}

// ── S1: the list is persisted on the session row ───────────────────────────
let hubAccess = null;
{
  const t = mint();
  const r = await exchange({ ticket: t.ticket, next: '/app/dashboard' });
  hubAccess = cookieVal(r.cookies, 'accessToken');
  const s = await lastSession();
  ok(r.status === 302, 'S1 valid ticket -> 302', `${r.status} ${r.text}`);
  ok(JSON.stringify(s.hub_stores) === JSON.stringify(t.payload.stores), 'S1 the signed list is persisted on the SESSION row', JSON.stringify(s.hub_stores));
}

// ── S2/S3/W6b: malformed lists are ignored, never refused; the cap, the shape and PER-ENTRY skipping ──
const GOOD = { code: 'SB', name: 'Sandbox', role: 'owner', can_hop: true };
{
  // (a) the CLAIM itself is unusable: there is no list to salvage, so the session carries none.
  for (const [label, stores] of [['not an array', 'a-string'], ['an object', { MB: 'Mineblock' }], ['null', null]]) {
    const t = mint({ stores });
    const r = await exchange({ ticket: t.ticket, next: '/' });
    const sess = await lastSession();
    ok(r.status === 302, `S2 ${label}: the ticket is still accepted`, `${r.status} ${r.text}`);
    ok(Array.isArray(sess.hub_stores) && sess.hub_stores.length === 0, `S2 ${label}: the field is ignored, the session carries no list`, JSON.stringify(sess.hub_stores));
  }

  // (b) W6b, the fix for W6's deviation 6: ONE unusable ENTRY is skipped, the rest of the list survives.
  //     Under W6 every one of these cost the operator the WHOLE dropdown.
  const perEntry = [
    ['an entry that is not an object', 'MB'],
    ['a code that is not a store code', { code: 'mb', name: 'Mineblock', role: 'owner', can_hop: true }],
    ['a code with punctuation', { code: 'M-B', name: 'Mineblock', role: 'owner', can_hop: true }],
    ['a code over 8 characters', { code: 'ABCDEFGHI', name: 'Too long', role: 'owner', can_hop: true }],
    ['a name that is not a string', { code: 'MB', name: 42, role: 'owner', can_hop: true }],
    ['a name over 80 characters', { code: 'MB', name: 'x'.repeat(81), role: 'owner', can_hop: true }],
    ['an entry carrying an extra field', { code: 'MB', name: 'Mineblock', role: 'owner', can_hop: true, dashboard_origin: 'https://evil.example' }],
    ['a role that is not a string', { code: 'MB', name: 'Mineblock', role: 5, can_hop: true }],
    ['a role over 24 characters', { code: 'MB', name: 'Mineblock', role: 'r'.repeat(25), can_hop: true }],
    ['can_hop that is not a boolean', { code: 'MB', name: 'Mineblock', role: 'owner', can_hop: 'yes' }],
  ];
  for (const [label, bad] of perEntry) {
    const t = mint({ stores: [bad, GOOD] });
    const r = await exchange({ ticket: t.ticket, next: '/' });
    const sess = await lastSession();
    ok(r.status === 302, `W6b ${label}: the ticket is still accepted`, `${r.status} ${r.text}`);
    ok(JSON.stringify(sess.hub_stores) === JSON.stringify([GOOD]), `W6b ${label}: that ENTRY is skipped and the rest of the list is kept`, JSON.stringify(sess.hub_stores));
  }

  // (c) backward compatibility with a W6 ticket: no role, no can_hop -> role '' and can_hop true.
  {
    const t = mint({ stores: [{ code: 'MB', name: 'Mineblock' }, { code: 'SB', name: 'Sandbox' }] });
    const r = await exchange({ ticket: t.ticket, next: '/' });
    const sess = await lastSession();
    ok(r.status === 302, 'W6b a W6-shaped ticket ({code,name} only) is still accepted', `${r.status}`);
    ok(JSON.stringify(sess.hub_stores) === JSON.stringify([{ code: 'MB', name: 'Mineblock', role: '', can_hop: true }, { code: 'SB', name: 'Sandbox', role: '', can_hop: true }]),
      'W6b a W6-shaped entry defaults to role "" and can_hop true', JSON.stringify(sess.hub_stores));
  }

  // (d) the HUB is the authority on codes: the dashboard's LIST grammar is the hub's ^[A-Z0-9]{1,8}$,
  //     not this dashboard's own 2-4 character STORE_CODE. A 1- and an 8-character code both survive.
  {
    const t = mint({ stores: [{ code: 'X', name: 'One char', role: 'viewer', can_hop: true }, { code: 'ABCDEFGH', name: 'Eight chars', role: 'owner', can_hop: false }] });
    const r = await exchange({ ticket: t.ticket, next: '/' });
    const sess = await lastSession();
    ok(r.status === 302 && sess.hub_stores.length === 2, 'W6b the dashboard accepts the HUB\'s code grammar for the list (1..8 characters)', JSON.stringify(sess.hub_stores));
  }

  const many = Array.from({ length: 60 }, (_, i) => ({ code: `S${String(i).padStart(2, '0')}`.slice(0, 4), name: `Store ${i}`, role: 'owner', can_hop: true }));
  const t = mint({ stores: many });
  const r = await exchange({ ticket: t.ticket, next: '/' });
  const sess = await lastSession();
  ok(r.status === 302 && sess.hub_stores.length === 50, 'S3 a list longer than 50 is capped at 50, not refused', `${r.status} ${sess.hub_stores?.length}`);
  const t2 = mint({ stores: undefined, nonce: crypto.randomBytes(16).toString('hex') });
  const r2 = await exchange({ ticket: t2.ticket, next: '/' });
  ok(r2.status === 302 && Array.isArray((await lastSession()).hub_stores), 'S3 a ticket with no list at all is accepted (an older hub) and the session carries an empty list', `${r2.status}`);
}

// ── S4: the store-config answer, read at REQUEST time ──────────────────────
{
  const r = await storeConfig(hubAccess);
  ok(r.status === 200, 'S4 GET /store-config with a hub session -> 200', `${r.status} ${r.text.slice(0, 200)}`);
  ok(r.json?.data?.hub?.origin === 'https://hub.example.test' && r.json.data.hub.sso_enabled === true, 'S4 it carries hub{origin, sso_enabled}', JSON.stringify(r.json?.data?.hub));
  ok(r.json?.data?.switcher?.current === 'MB', 'S4 switcher.current is this store\'s code', JSON.stringify(r.json?.data?.switcher?.current));
  ok(JSON.stringify(r.json?.data?.switcher?.stores) === JSON.stringify([
    { code: 'MB', name: 'Mineblock', role: 'owner', can_hop: true },
    { code: 'SB', name: 'Sandbox', role: 'owner', can_hop: true },
    { code: 'TW', name: 'Third Wave', role: 'admin', can_hop: true },
    { code: 'PL', name: 'Puure', role: 'owner', can_hop: false },
  ]), 'S4 switcher.stores is exactly what the SIGNED ticket carried, role and can_hop included', JSON.stringify(r.json?.data?.switcher?.stores));
  ok(r.json?.data?.switcher?.stores?.length === 4 && r.json.data.switcher.stores.every((x) => Object.keys(x).sort().join(',') === 'can_hop,code,name,role'), 'W6b every store-config entry is exactly {code,name,role,can_hop}', JSON.stringify(r.json?.data?.switcher?.stores));
  ok(r.json?.data?.switcher?.stores?.filter((x) => x.can_hop === false).length === 1, 'W6b a store the operator cannot hop into is SERVED, so the sidebar can grey it', JSON.stringify(r.json?.data?.switcher?.stores));

  const savedOrigin = process.env.HUB_ORIGIN; const savedFlag = process.env.HUB_SSO_ENABLED;
  delete process.env.HUB_ORIGIN; process.env.HUB_SSO_ENABLED = '0';
  const off = await storeConfig(hubAccess);
  ok(off.json?.data?.hub?.origin === null && off.json.data.hub.sso_enabled === false, 'S4 R7: unsetting HUB_ORIGIN changes the NEXT request, with no restart', JSON.stringify(off.json?.data?.hub));
  process.env.HUB_ORIGIN = savedOrigin; process.env.HUB_SSO_ENABLED = savedFlag;
  const back = await storeConfig(hubAccess);
  ok(back.json?.data?.hub?.origin === savedOrigin, 'S4 R7: setting it back is live on the request after that', JSON.stringify(back.json?.data?.hub));
}

// ── S5: a LOCAL login sees no list at all (R21: the store works with the hub gone) ──
{
  const { signAccessToken } = await import('../../src/utils/jwt.js');
  const u = (await q('SELECT id, email FROM users ORDER BY created_at LIMIT 1'))[0];
  const local = signAccessToken({ userId: u.id, email: u.email, roles: [] });     // no hub_sso, no sid
  const r = await storeConfig(local);
  ok(r.status === 200, 'S5 a local (non-hub) session still reads store-config', `${r.status} ${r.text.slice(0, 120)}`);
  ok(Array.isArray(r.json?.data?.switcher?.stores) && r.json.data.switcher.stores.length === 0, 'S5 it carries an EMPTY list: a local login never invents stores', JSON.stringify(r.json?.data?.switcher));
  ok(r.json?.data?.switcher?.current === 'MB', 'S5 it still knows which store it is');
}

// ── S6: no secret anywhere in the answer, and no client input reaches the list ──
{
  const r = await storeConfig(hubAccess);
  ok(!r.text.includes(process.env.FRAMEIO_TOKEN) && !r.text.includes(SECRET) && !r.text.includes(DB), 'S6 the answer carries no secret value');
  const keys = [];
  (function walk(o) { for (const [k, v] of Object.entries(o || {})) { keys.push(k); if (v && typeof v === 'object') walk(v); } })(r.json);
  ok(!keys.some((k) => /token|secret|password|api_key|apikey/i.test(k)), 'S6 no secret-named key', keys.join(','));
  // NEGATIVE CONTROL: the client cannot put a store in its own list.
  const forged = await fetch(BASE + '/api/v1/store-config?stores=%5B%7B%22code%22%3A%22XX%22%7D%5D', { headers: { cookie: `accessToken=${hubAccess}`, 'x-hub-stores': '[{"code":"XX","name":"Injected"}]' } });
  const forgedBody = await forged.text();
  ok(!forgedBody.includes('Injected') && !forgedBody.includes('"XX"'), 'S6 a client-supplied list is never echoed: the list comes from the session row only', forgedBody.slice(0, 200));
}

// ── R1: the list survives token rotation (the 15-minute cliff) ─────────────
{
  const t = mint();
  const r = await exchange({ ticket: t.ticket, next: '/' });
  const access = cookieVal(r.cookies, 'accessToken');
  const refresh = cookieVal(r.cookies, 'refreshToken');
  const oldSession = await lastSession();
  const rot = await fetch(BASE + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `refreshToken=${refresh}`, 'x-forwarded-for': freshIp() } });
  const rotCookies = rot.headers.getSetCookie();
  const newAccess = cookieVal(rotCookies, 'accessToken');
  const newSession = await lastSession();
  ok(rot.status === 200 && newAccess && newAccess !== access, 'R1 the SPA can rotate its token after a hop', `${rot.status}`);
  ok(newSession.id !== oldSession.id, 'R1 rotation really made a NEW session row (the old one is deleted)', `${oldSession.id} -> ${newSession.id}`);
  ok(JSON.stringify(newSession.hub_stores) === JSON.stringify(t.payload.stores), 'R1 the switcher list is carried onto the new row', JSON.stringify(newSession.hub_stores));
  const after = await storeConfig(newAccess);
  ok(after.json?.data?.switcher?.stores?.length === 4, 'R1 store-config still answers with the list after rotation', JSON.stringify(after.json?.data?.switcher));
}

// ── R2: revocation is unchanged — deleting the session row still ends it on the next request ──
{
  const t = mint();
  const r = await exchange({ ticket: t.ticket, next: '/' });
  const access = cookieVal(r.cookies, 'accessToken');
  ok((await storeConfig(access)).status === 200, 'R2 the fresh hub session reads store-config');
  const s = await lastSession();
  await q('DELETE FROM sessions WHERE id = $1', [s.id]);
  const gone = await storeConfig(access);
  ok(gone.status === 401, 'R2 with the session row deleted the very next request is 401 (no grace window)', `${gone.status} ${gone.text.slice(0, 120)}`);
}

server.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
