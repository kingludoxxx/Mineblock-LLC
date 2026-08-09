// FUNNEL-SETTINGS PATCH verification — drives the REAL /api/v1/funnels router
// (real authenticate + requirePermission + ensureTables + validateFunnelSettings)
// against embedded PG, exactly like the money-path harnesses.
//
// Proves by execution: the ALTER … IF NOT EXISTS lands the settings column on
// an existing database; PATCH accepts a valid settings object and round-trips
// it; every bound is enforced (32KB structured, 2MB code fields, proto-key
// scan, non-object refusal); an unauthenticated request is refused; and the
// stored row drives renderPageHtml's gated emissions end-to-end.
//
// Run:  node server/tests/funnel-settings/patch-settings.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── seed auth: minimal users/roles tables + a funnels:access user ───────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_fnl_test', 'fnl@local.test', 'Fnl', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_fnl_test', 'funnels-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_fnl_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_fnl_test', 'r_fnl_test')`;

const funnelsRouter = (await import('../../src/routes/funnels.js')).default;
const { validateFunnelSettings } = await import('../../src/routes/funnels.js');
const { renderPageHtml } = await import('../../src/services/funnelRender.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/funnels`;

// JWT_ACCESS_SECRET falls back to the dev default when no .env exists in this
// worktree (config/env.js) — sign with the same fallback.
const token = jwt.sign({ userId: 'u_fnl_test' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

// ── unit: validateFunnelSettings ────────────────────────────────────────────
check('unit: valid object passes', validateFunnelSettings({ brand_colors: { primary: '#111' } }) === null);
check('unit: non-object refused', validateFunnelSettings([1, 2]) !== null && validateFunnelSettings('x') !== null);
check('unit: proto key refused', validateFunnelSettings(JSON.parse('{"a":{"__proto__":{"x":1}}}')) !== null);
check('unit: constructor key refused', validateFunnelSettings(JSON.parse('{"constructor":1}')) !== null);
check('unit: 32KB structured bound', validateFunnelSettings({ big: 'x'.repeat(33 * 1024) }) !== null);
check('unit: code field rides the 2MB cap, not 32KB', validateFunnelSettings({ custom_head_code: 'x'.repeat(100 * 1024) }) === null);
check('unit: code field over 2MB refused', validateFunnelSettings({ custom_head_code: 'x'.repeat(2 * 1024 * 1024 + 1) }) !== null);
check('unit: non-string code field refused', validateFunnelSettings({ custom_head_code: { evil: 1 } }) !== null);

// ── route: auth gate ────────────────────────────────────────────────────────
{
  const r = await req('GET', '/', undefined, { 'Content-Type': 'application/json' });
  check('route: no token → 401', r.status === 401, JSON.stringify(r));
}

// ── route: create → PATCH settings → read back ──────────────────────────────
await sql`DELETE FROM funnels WHERE slug = 'fnl-settings-harness'`;
const created = await req('POST', '/', { name: 'Settings Harness', slug: 'fnl-settings-harness' });
check('route: funnel created', created.status === 201 && created.j?.data?.id, JSON.stringify(created.j));
const FID = created.j?.data?.id;

// The ALTER … IF NOT EXISTS ran inside ensureTables on that request.
const col = await sql`SELECT data_type FROM information_schema.columns WHERE table_name = 'funnels' AND column_name = 'settings'`;
check('db: settings column exists as jsonb after ensureTables', col[0]?.data_type === 'jsonb', JSON.stringify(col));

const SETTINGS = {
  logo_url: 'https://cdn.example.com/logo.png',
  description: 'internal',
  brand_colors: { primary: '#21a05f', secondary: '#161613' },
  fonts: { family: 'poppins' },
  checkout: { address_autocomplete: true, maps_api_key: 'AIzaTestKey123', intl_phone: true },
  custom_head_code: '<script>window.__h=1;</script>',
  custom_body_end_code: '<script>window.__b=1;</script>',
};
{
  const r = await req('PATCH', `/${FID}`, { settings: SETTINGS });
  check('route: PATCH valid settings → 200 + echoed', r.status === 200 && r.j?.data?.settings?.fonts?.family === 'poppins', JSON.stringify(r.j?.data?.settings || r.j));
  const detail = await req('GET', `/${FID}`);
  check('route: GET detail returns stored settings', detail.j?.data?.funnel?.settings?.checkout?.maps_api_key === 'AIzaTestKey123');
}
{
  const r = await req('PATCH', `/${FID}`, '{"settings":{"a":{"__proto__":{"polluted":1}}}}');
  check('route: proto-key settings → 400', r.status === 400, JSON.stringify(r));
}
{
  const r = await req('PATCH', `/${FID}`, { settings: { big: 'x'.repeat(33 * 1024) } });
  check('route: oversize structured settings → 400 (32KB)', r.status === 400 && String(r.j?.error).includes('32KB'), JSON.stringify(r.j));
}
{
  const r = await req('PATCH', `/${FID}`, { settings: 'not-an-object' });
  check('route: non-object settings → 400', r.status === 400, JSON.stringify(r));
}
{
  const r = await req('PATCH', `/${FID}`, { settings: { custom_body_end_code: 'y'.repeat(2 * 1024 * 1024 + 10) } });
  check('route: code field over 2MB → 400', r.status === 400 && String(r.j?.error).includes('2MB'), JSON.stringify(r.j));
}
{
  // A refused PATCH must not have clobbered the stored settings.
  const detail = await req('GET', `/${FID}`);
  check('route: refused PATCHes left stored settings intact', detail.j?.data?.funnel?.settings?.fonts?.family === 'poppins');
}

// ── integration: the STORED row drives the renderer's gated emissions ───────
{
  const rows = await sql`SELECT * FROM funnels WHERE id = ${FID}`;
  const page = { id: 'fpg_h', slug: '/', title: 'H', status: 'published', blocks: [], seo: {} };
  const html = renderPageHtml(page, rows[0], { fpg_h: page });
  check('integration: stored settings emit gmaps + intl + font + colors',
    html.includes('lb-gmaps-autocomplete') && html.includes('lb-intl-phone')
    && html.includes('lb-funnel-font') && html.includes('lb-brand-colors')
    && html.includes('window.__h=1') && html.includes('window.__b=1'));
  const bare = await (async () => {
    await req('PATCH', `/${FID}`, { settings: {} });
    const r2 = await sql`SELECT * FROM funnels WHERE id = ${FID}`;
    return renderPageHtml(page, r2[0], { fpg_h: page });
  })();
  check('integration: settings cleared to {} → all emissions gone',
    !bare.includes('lb-gmaps-autocomplete') && !bare.includes('lb-intl-phone')
    && !bare.includes('lb-funnel-font') && !bare.includes('lb-brand-colors'));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await sql`DELETE FROM funnels WHERE id = ${FID}`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_fnl_test'`;
await sql`DELETE FROM users WHERE id = 'u_fnl_test'`;
await sql`DELETE FROM roles WHERE id = 'r_fnl_test'`;
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
