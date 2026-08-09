// Route-mount verification for routes/funnelTrackingExtras.js.
//
// This surface is mounted on the SAME base path as routes/funnels.js
// (/api/v1/funnels), so the thing that can silently break is DISPATCH: either
// my router shadows a funnels route, or funnels.js swallows my paths. This
// harness boots a real express app on an ephemeral port and proves the split
// three ways.
//
// NO DATABASE IS TOUCHED. middleware/auth.js returns 401 for a request with no
// token BEFORE any Redis or Postgres call (auth.js:86), so every assertion here
// runs entirely in-process — which is why it is safe to run without the
// production DATABASE_URL this repo's .env carries.
//
// Run:  node server/tests/tracking/extras-route-mount.mjs
import express from 'express';
import extrasRoutes from '../../src/routes/funnelTrackingExtras.js';
import funnelsRoutes from '../../src/routes/funnels.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// Boot an app with a given mount arrangement, return { base, close }.
const boot = (mount) => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  });
});

const status = async (base, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
};

const TRACKING_PATHS = [
  ['GET', '/api/v1/funnels/fnl_x/tracking/health'],
  ['GET', '/api/v1/funnels/fnl_x/tracking/custom'],
  ['PUT', '/api/v1/funnels/fnl_x/tracking/custom'],
];

// ── A. the extras router ALONE answers all three tracking paths ─────────────
{
  const { base, close } = await boot((app) => app.use('/api/v1/funnels', extrasRoutes));
  for (const [method, path] of TRACKING_PATHS) {
    const s = await status(base, method, path, method === 'PUT' ? { head_html: 'x' } : undefined);
    ok(s === 401, `A ${method} ${path} → 401 (route matched, auth chain fired)`, `got ${s}`);
  }
  // A path this router must NOT claim.
  ok(await status(base, 'GET', '/api/v1/funnels/fnl_x') === 404,
    'A GET /funnels/:id is NOT claimed by the extras router (falls through)');
  ok(await status(base, 'GET', '/api/v1/funnels/fnl_x/tracking/bogus') === 404,
    'A an unknown tracking subpath is not claimed');
  await close();
}

// ── B. funnels.js ALONE registers NO route for the tracking paths ───────────
// Asserted STRUCTURALLY, not over HTTP, because funnels.js applies
// `router.use(authenticate, requirePermission(...))` at its top (funnels.js:23).
// Router-level middleware runs for EVERY request entering that router — even
// one that matches no route — so an unauthenticated probe there answers 401,
// never 404, and HTTP status cannot distinguish "no such route" from "no
// token". The route table can.
//
// This is exactly why the extras router is mounted BEFORE funnelsRoutes and
// attaches its auth PER ROUTE: mounted after, every tracking request would run
// funnels.js's authenticate first and be authenticated TWICE.
{
  const funnelsPaths = funnelsRoutes.stack.filter((l) => l.route).map((l) => l.route.path);
  for (const [, path] of TRACKING_PATHS) {
    const sub = path.replace('/api/v1/funnels', '').replace('fnl_x', ':id');
    ok(!funnelsPaths.includes(sub), `B funnels.js registers no route for ${sub}`, funnelsPaths.join(' '));
  }
  ok(funnelsPaths.length > 0, 'B (sanity) funnels.js does register its own routes', String(funnelsPaths.length));
  // And it carries router-level middleware — the reason for the mount order.
  const bare = funnelsRoutes.stack.filter((l) => !l.route);
  ok(bare.length > 0, 'B funnels.js has router-level middleware (hence extras mounts first)', String(bare.length));
}

// ── C. the REAL arrangement (routes/index.js order): extras, then funnels ───
{
  const { base, close } = await boot((app) => {
    app.use('/api/v1/funnels', extrasRoutes);
    app.use('/api/v1/funnels', funnelsRoutes);
  });
  for (const [method, path] of TRACKING_PATHS) {
    const s = await status(base, method, path, method === 'PUT' ? { head_html: 'x' } : undefined);
    ok(s === 401, `C ${method} ${path} → 401 (extras wins, as mounted)`, `got ${s}`);
  }
  // funnels.js's OWN routes must still be reachable through the extras router.
  ok(await status(base, 'GET', '/api/v1/funnels') === 401,
    'C GET /funnels (list) still reaches funnels.js — extras does not shadow it');
  ok(await status(base, 'GET', '/api/v1/funnels/fnl_x') === 401,
    'C GET /funnels/:id still reaches funnels.js');
  ok(await status(base, 'PATCH', '/api/v1/funnels/fnl_x', { name: 'n' }) === 401,
    'C PATCH /funnels/:id still reaches funnels.js');
  ok(await status(base, 'GET', '/api/v1/funnels/fnl_x/redirects') === 401,
    'C GET /funnels/:id/redirects still reaches funnels.js');
  // An unmatched path passes THROUGH the extras router (proving it claims
  // nothing it should not) and lands on funnels.js's router-level auth, which
  // answers 401 before route matching. Pre-existing funnels.js behaviour — the
  // point here is that the extras router did not absorb or mask the request.
  {
    const s = await status(base, 'GET', '/api/v1/funnels/fnl_x/does-not-exist');
    ok(s === 401, 'C an unmatched path falls through extras to funnels.js\'s own guard', `got ${s}`);
  }
  await close();
}

// ── D. auth is enforced on the WRITE route with a body present ──────────────
// A 400 here would mean validation ran BEFORE authentication.
{
  const { base, close } = await boot((app) => {
    app.use(express.json());
    app.use('/api/v1/funnels', extrasRoutes);
  });
  const s = await status(base, 'PUT', '/api/v1/funnels/fnl_x/tracking/custom', { head_html: 'a'.repeat(40000) });
  ok(s === 401, 'D an oversized unauthenticated PUT is rejected by AUTH (401), not validation (400)', `got ${s}`);
  await close();
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
