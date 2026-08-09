// FUNNEL-SETTINGS Domains tab verification — drives the REAL routers
// (/api/v1/domain-hub + /api/v1/funnels, real authenticate/requirePermission)
// against embedded PG. No mocks of our own code; DNS lookups run against
// domains that do not exist, so rows park at pending_dns exactly as a
// just-attached unpointed domain does in production.
//
// Proves by execution: attach → list → verify → records → detach round-trip;
// apex vs subdomain required-records shapes; the primary-domain radio
// contract (PATCH funnels custom_domain: attached-only, null clears, detach
// clears a dangling pointer); typed detach confirmation; cross-funnel attach
// conflict; invalid-domain refusal.
//
// Run:  node server/tests/funnel-settings/domains-tab.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.DOMAIN_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── seed auth (same minimal tables as patch-settings.mjs) ───────────────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email) VALUES ('u_dom_test', 'dom@local.test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_dom_test', 'dom-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_dom_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_dom_test', 'r_dom_test')`;

const funnelsRouter = (await import('../../src/routes/funnels.js')).default;
const domainHubRouter = (await import('../../src/routes/domainHub.js')).default;
// Make sure the domain tables exist before the pre-run cleanup sweeps them.
await (await import('../../src/services/domainHub/schema.js')).ensureDomainTables();

const app = express();
app.use(express.json());
app.use('/api/v1/funnels', funnelsRouter);
app.use('/api/v1/domain-hub', domainHubRouter);
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`;

const token = jwt.sign({ userId: 'u_dom_test' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };
const req = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

const SUB = 'fnl-harness.puure-domains-harness.dev';   // 3 labels → subdomain (1 CNAME)
const APEX = 'puure-domains-harness-apex.dev';         // 2 labels → apex (A + www CNAME)
const cleanup = async () => {
  await sql`DELETE FROM lb_domains WHERE domain IN (${SUB}, ${APEX})`;
  await sql`DELETE FROM domain_events WHERE domain IN (${SUB}, ${APEX})`.catch(() => {});
  await sql`DELETE FROM funnels WHERE slug IN ('dom-harness-a', 'dom-harness-b')`;
};
await cleanup();

// ── funnels ─────────────────────────────────────────────────────────────────
const fA = (await req('POST', '/funnels', { name: 'Dom Harness A', slug: 'dom-harness-a' })).j?.data;
const fB = (await req('POST', '/funnels', { name: 'Dom Harness B', slug: 'dom-harness-b' })).j?.data;
check('setup: two funnels created', Boolean(fA?.id && fB?.id));

// ── attach (subdomain) ──────────────────────────────────────────────────────
{
  const r = await req('POST', '/domain-hub/attach', { domain: SUB, funnel_id: fA.id, auto_dns: true });
  const d = r.j?.data;
  check('attach subdomain → 201 + row', r.status === 201 && d?.domain?.domain === SUB, JSON.stringify(r.j));
  check('attach: row parks at pending_dns (DNS not pointing)', d?.domain?.status === 'pending_dns', d?.domain?.status);
  check('attach: subdomain requires exactly one CNAME', Array.isArray(d?.records) && d.records.length === 1 && d.records[0].type === 'CNAME', JSON.stringify(d?.records));
  check('attach: cloudflare/render config flags present', typeof d?.cloudflare?.configured === 'boolean' && typeof d?.render_configured === 'boolean');
}
// idempotent resume
{
  const r = await req('POST', '/domain-hub/attach', { domain: SUB, funnel_id: fA.id });
  check('re-attach same funnel → 200 resumed, no dup', r.status === 200 && r.j?.data?.resumed === true);
  const n = await sql`SELECT COUNT(*)::int AS n FROM lb_domains WHERE domain = ${SUB}`;
  check('re-attach: still one row', n[0].n === 1);
}
// cross-funnel conflict
{
  const r = await req('POST', '/domain-hub/attach', { domain: SUB, funnel_id: fB.id });
  check('attach to OTHER funnel → 409 conflict', r.status === 409 && r.j?.error === 'domain_attached_to_other_funnel', JSON.stringify(r.j));
}
// invalid domain
{
  const r = await req('POST', '/domain-hub/attach', { domain: 'not a domain!!', funnel_id: fA.id });
  check('attach invalid domain → 400', r.status === 400, JSON.stringify(r.j));
}
// apex records shape
{
  const r = await req('POST', '/domain-hub/attach', { domain: APEX, funnel_id: fA.id });
  const recs = r.j?.data?.records;
  check('attach apex → A @ + www CNAME', Array.isArray(recs) && recs.length === 2 && recs[0].type === 'A' && recs[1].type === 'CNAME' && recs[1].name === 'www', JSON.stringify(recs));
}

// ── list ────────────────────────────────────────────────────────────────────
{
  const r = await req('GET', `/domain-hub/list?funnel_id=${fA.id}`);
  const domains = (r.j?.data || []).map((x) => x.domain).sort();
  check('list?funnel_id returns both rows', r.status === 200 && domains.length === 2 && domains.includes(SUB) && domains.includes(APEX), JSON.stringify(domains));
  const rB = await req('GET', `/domain-hub/list?funnel_id=${fB.id}`);
  check('list for the other funnel is empty', Array.isArray(rB.j?.data) && rB.j.data.length === 0);
}

// ── verify now ──────────────────────────────────────────────────────────────
{
  const r = await req('POST', `/domain-hub/${SUB}/verify`);
  const row = r.j?.data;
  check('verify → 200 row, still pending_dns, attempt counted', r.status === 200 && row?.status === 'pending_dns' && row?.verify_attempts >= 1, JSON.stringify({ s: row?.status, a: row?.verify_attempts }));
}

// ── records view ────────────────────────────────────────────────────────────
{
  const r = await req('GET', `/domain-hub/${SUB}/records`);
  const d = r.j?.data;
  check('records → required + observed shape', r.status === 200 && Array.isArray(d?.required) && d.required.length === 1 && typeof d?.observed === 'object', JSON.stringify(Object.keys(d || {})));
  const missing = await req('GET', `/domain-hub/never-attached.puure-domains-harness.dev/records`);
  check('records for unattached domain → 404', missing.status === 404, JSON.stringify(missing.j));
}

// ── primary radio: PATCH funnels custom_domain ──────────────────────────────
{
  const r = await req('PATCH', `/funnels/${fA.id}`, { custom_domain: SUB });
  check('primary = attached domain → 200 + stored', r.status === 200 && r.j?.data?.custom_domain === SUB, JSON.stringify(r.j?.data?.custom_domain));
}
{
  const r = await req('PATCH', `/funnels/${fA.id}`, { custom_domain: 'unattached.puure-domains-harness.dev' });
  check('primary = UNattached domain → 400', r.status === 400, JSON.stringify(r.j));
}
{
  const r = await req('PATCH', `/funnels/${fB.id}`, { custom_domain: SUB });
  check("primary = another funnel's domain → 400", r.status === 400, JSON.stringify(r.j));
}
{
  const r = await req('PATCH', `/funnels/${fA.id}`, { custom_domain: null });
  check('primary = null clears (Default URL)', r.status === 200 && r.j?.data?.custom_domain === null);
  await req('PATCH', `/funnels/${fA.id}`, { custom_domain: SUB }); // re-set for the detach-repair check
}

// ── detach ──────────────────────────────────────────────────────────────────
{
  const r = await req('DELETE', `/domain-hub/${SUB}`, {});
  check('detach without typed confirm → 400', r.status === 400 && r.j?.error === 'confirm_must_match_domain', JSON.stringify(r.j));
}
{
  const r = await req('DELETE', `/domain-hub/${SUB}`, { confirm: SUB });
  check('detach with typed confirm → 200', r.status === 200 && r.j?.data?.detached === SUB, JSON.stringify(r.j));
  const rows = await sql`SELECT * FROM lb_domains WHERE domain = ${SUB}`;
  check('detach: row deleted', rows.length === 0);
  const f = await req('GET', `/funnels/${fA.id}`);
  check('detach: dangling custom_domain pointer CLEARED', f.j?.data?.funnel?.custom_domain === null, JSON.stringify(f.j?.data?.funnel?.custom_domain));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await req('DELETE', `/domain-hub/${APEX}`, { confirm: APEX });
await cleanup();
await sql`DELETE FROM user_roles WHERE user_id = 'u_dom_test'`;
await sql`DELETE FROM users WHERE id = 'u_dom_test'`;
await sql`DELETE FROM roles WHERE id = 'r_dom_test'`;
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
