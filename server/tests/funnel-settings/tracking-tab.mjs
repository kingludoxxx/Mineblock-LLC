// TRACKING-TAB verification — proves by execution the seams the new client
// Tracking directory (client/src/components/funnels/settings/TrackingSection.jsx)
// depends on:
//
//   1. ALWAYS (against this branch's server code): the GENERAL panel's
//      persistence — PATCH /api/v1/funnels/:id {settings:{tracking:{…}}} is
//      accepted by validateFunnelSettings (no key whitelist), round-trips,
//      and a read-merge-write from another section preserves it.
//   2. The /tracking-admin surface — masked network reads, PUT validation
//      codes, summary + events shapes. The events read spine has been on main
//      since the attribution merge; the NETWORKS surface landed with
//      feat/tracking-server (merged @ b5b5206 — this branch is rebased onto
//      it, so the whole block runs). The 404-probe skip remains as a guard
//      for running this harness on an older branch.
//
// Run:  node server/tests/funnel-settings/tracking-tab.mjs
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
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_trk_test', 'trk@local.test', 'Trk', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_trk_test', 'tracking-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_trk_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_trk_test', 'r_trk_test')`;

const funnelsRouter = (await import('../../src/routes/funnels.js')).default;
const { validateFunnelSettings } = await import('../../src/routes/funnels.js');

// The tracking lane's admin router — absent on a pre-merge branch.
// TRACKING_ADMIN_PATH lets the activated block be executed against the
// feat/tracking-server worktree BEFORE the merge (verification only).
const TA_PATH = process.env.TRACKING_ADMIN_PATH || new URL('../../src/routes/trackingAdmin.js', import.meta.url).pathname;
let trackingAdminRouter = null;
try {
  trackingAdminRouter = (await import(TA_PATH)).default;
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err; // a broken module must FAIL, not skip
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/funnels', funnelsRouter);
if (trackingAdminRouter) app.use('/api/v1/tracking-admin', trackingAdminRouter); // same mount as routes/index.js
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1`;

const token = jwt.sign({ userId: 'u_trk_test' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* non-JSON body — j stays null and the check fails visibly */ }
  return { status: r.status, j };
};

// ── 1. GENERAL panel persistence (settings.tracking via funnels PATCH) ──────
// This is the exact payload GeneralPanel writes.
const TRACKING_SETTINGS = {
  fire_purchase: 'checkout_server',
  send_external_id: true,
  fire_addtocart_checkout: false,
  fire_viewcontent_lead: true,
  unique_txn_per_upsell: true,
};

check('unit: validateFunnelSettings accepts a tracking key (no whitelist gap)',
  validateFunnelSettings({ tracking: TRACKING_SETTINGS }) === null,
  String(validateFunnelSettings({ tracking: TRACKING_SETTINGS })));

await sql`DELETE FROM funnels WHERE slug = 'trk-tab-harness'`;
const created = await req('POST', '/funnels', { name: 'Tracking Tab Harness', slug: 'trk-tab-harness' });
check('route: funnel created', created.status === 201 && created.j?.data?.id, JSON.stringify(created.j));
const FID = created.j?.data?.id;

{
  const r = await req('PATCH', `/funnels/${FID}`, { settings: { tracking: TRACKING_SETTINGS } });
  check('route: PATCH settings.tracking → 200 + echoed',
    r.status === 200 && r.j?.data?.settings?.tracking?.send_external_id === true, JSON.stringify(r.j?.data?.settings || r.j));
}
{
  // Read-merge-write from ANOTHER section (GeneralSection's shape) must
  // preserve settings.tracking — the client always re-GETs and spreads fresh.settings.
  const fresh = await req('GET', `/funnels/${FID}`);
  const merged = { ...(fresh.j?.data?.funnel?.settings || {}), logo_url: 'https://cdn.example.com/x.png' };
  const r = await req('PATCH', `/funnels/${FID}`, { settings: merged });
  check('route: sibling-section merge preserves tracking',
    r.status === 200 && r.j?.data?.settings?.tracking?.unique_txn_per_upsell === true
    && r.j?.data?.settings?.logo_url === 'https://cdn.example.com/x.png', JSON.stringify(r.j?.data?.settings || r.j));
}
{
  // The optimistic single-key write GeneralPanel performs (flip one checkbox).
  const fresh = await req('GET', `/funnels/${FID}`);
  const st = fresh.j?.data?.funnel?.settings || {};
  st.tracking = { ...(st.tracking || {}), fire_addtocart_checkout: true };
  const r = await req('PATCH', `/funnels/${FID}`, { settings: st });
  check('route: single-checkbox flip persists without dropping siblings',
    r.status === 200 && r.j?.data?.settings?.tracking?.fire_addtocart_checkout === true
    && r.j?.data?.settings?.tracking?.send_external_id === true, JSON.stringify(r.j?.data?.settings?.tracking || r.j));
}

// ── 2. /tracking-admin seams ────────────────────────────────────────────────
if (!trackingAdminRouter) {
  // The read spine has been on main since the attribution merge — a missing
  // module now is a regression, not a skip.
  check('ta: trackingAdmin router present on this branch', false, TA_PATH);
} else {
  // Events feed — EXISTS ON MAIN — the detail page's Recent deliveries seam.
  {
    const r = await req('GET', `/tracking-admin/${FID}/events?limit=5`);
    check('ta: events feed → 200 { events: [] } for a fresh funnel',
      r.status === 200 && Array.isArray(r.j?.data?.events), JSON.stringify(r.j));
  }
  {
    const r = await req('GET', `/tracking-admin/${FID}/events?limit=5`, undefined, { 'Content-Type': 'application/json' });
    check('ta: no token → 401', r.status === 401, JSON.stringify(r));
  }

  // NETWORKS surface — ships on feat/tracking-server; 404 pre-merge.
  const probe = await req('GET', `/tracking-admin/${FID}/networks`);
  if (probe.status === 404) {
    skip++;
    console.log('\nSKIP  tracking-admin NETWORKS seams — GET /networks 404s on this branch');
    console.log('      (feat/tracking-server not merged yet). This sub-block runs automatically once it');
    console.log('      lands; it was executed pre-merge via TRACKING_ADMIN_PATH pointed at that worktree.\n');
  } else {
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${FID}`.catch(() => {});
  {
    const r = await req('GET', `/tracking-admin/${FID}/networks`);
    const nets = r.j?.data?.networks;
    const metaN = Array.isArray(nets) ? nets.find((n) => n.kind === 'meta_pixel') : null;
    check('ta: GET networks → registry list incl. unconfigured meta_pixel',
      r.status === 200 && metaN && metaN.configured === false, JSON.stringify(r.j));
    check('ta: masked read — capi_token never present, capi_token_set boolean',
      metaN && !('capi_token' in metaN) && typeof metaN.capi_token_set === 'boolean', JSON.stringify(metaN));
  }
  {
    const r = await req('PUT', `/tracking-admin/${FID}/networks/meta_pixel`, { pixel_id: '123', mode: 'sideways' });
    check('ta: PUT invalid mode → 400 invalid_mode', r.status === 400 && r.j?.error?.code === 'invalid_mode', JSON.stringify(r.j));
  }
  {
    const r = await req('PUT', `/tracking-admin/${FID}/networks/klingon_pixel`, { pixel_id: '123' });
    check('ta: PUT unknown kind → 400 unknown_kind', r.status === 400 && r.j?.error?.code === 'unknown_kind', JSON.stringify(r.j));
  }
  {
    const r = await req('PUT', `/tracking-admin/${FID}/networks/meta_pixel`, { pixel_id: 'not-numeric' });
    check('ta: PUT malformed pixel id → 400 invalid_pixel_id',
      r.status === 400 && r.j?.error?.code === 'invalid_pixel_id', JSON.stringify(r.j));
  }
  {
    const r = await req('PUT', `/tracking-admin/${FID}/networks/meta_pixel`, { pixel_id: '12345678901', enabled: 'false' });
    check('ta: PUT string-boolean enabled → 400 invalid_enabled',
      r.status === 400 && r.j?.error?.code === 'invalid_enabled', JSON.stringify(r.j));
  }
  {
    // The mode-segment PUT on an UNCONFIGURED network (client sends {mode} alone).
    const r = await req('PUT', `/tracking-admin/${FID}/networks/meta_pixel`, { mode: 'hybrid' });
    check('ta: PUT mode without a stored pixel → 400 pixel_id_required',
      r.status === 400 && r.j?.error?.code === 'pixel_id_required', JSON.stringify(r.j));
  }
  {
    // No-token save (the client's '' = keep semantics on a fresh row).
    const r = await req('PUT', `/tracking-admin/${FID}/networks/meta_pixel`,
      { pixel_id: '1234567890123456', mode: 'hybrid', enabled: true, capi_token: '', test_event_code: 'TEST99' });
    const n = r.j?.data?.network;
    check('ta: PUT valid credentials → 200 masked view',
      r.status === 200 && n?.pixel_id === '1234567890123456' && n?.mode === 'hybrid'
      && n?.capi_token_set === false && n?.test_event_code === 'TEST99', JSON.stringify(r.j));
  }
  {
    const r = await req('GET', `/tracking-admin/${FID}/tracking/summary`);
    const m = (r.j?.data?.networks || []).find((n) => n.kind === 'meta_pixel');
    check('ta: summary → fbclid click-id param + counters + breaker shape',
      r.status === 200 && Array.isArray(m?.click_id_params) && m.click_id_params.includes('fbclid')
      && typeof m.sent_24h === 'number' && typeof m.failed_24h === 'number'
      && typeof m.deduped_24h === 'number' && m?.breaker?.state, JSON.stringify(m || r.j));
    check('ta: server_channel_ready FALSE without a stored token (no fake ready)',
      m?.server_channel_ready === false, JSON.stringify(m));
  }
  await sql`DELETE FROM lb_pixels WHERE funnel_id = ${FID}`.catch(() => {});
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await sql`DELETE FROM funnels WHERE id = ${FID}`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_trk_test'`;
await sql`DELETE FROM users WHERE id = 'u_trk_test'`;
await sql`DELETE FROM roles WHERE id = 'r_trk_test'`;
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} block skipped (activates post-merge)` : ''}`);
process.exit(fail ? 1 : 0);
