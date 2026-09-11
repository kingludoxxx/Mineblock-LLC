// VIDEO LAUNCHER ROUTE — W9 / R20.
//
// What this proves, by execution, on the REAL router with the REAL authenticate
// and the REAL requirePermission against a real database:
//
//   A  it refuses with no session, and refuses an authenticated operator who
//      does not hold brief-pipeline:access
//   B  the only reachable upstream endpoints are the two the page actually
//      calls; anything else is 400, including a traversal attempt
//   C  with the env unset — every store but the one this token belongs to —
//      /status answers configured:false and /open/app answers 503. Nothing
//      throws, nothing is called
//   D  with the env set, the token is attached SERVER-SIDE: the upstream sees
//      it, and it is in no response body
//   E  the token and the host appear in NO log line (with a positive control —
//      a canary that MUST be captured, or the absence proves nothing)
//   F  the SSRF guard bites on the env value, every request, and the refusal
//      does not echo the url
//
// THE REAL LAUNCHER IS NEVER CALLED. Upstream here is a stub http server on
// 127.0.0.1 that stands in for it: it records what it was sent so the test can
// assert the token arrived, and where.
//
// Run:  node server/tests/video-launcher/route.mjs
// test-timeout: 120s
import http from 'node:http';
import postgres from 'postgres';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// Both DSNs are PLAIN LITERALS on purpose. run-all.mjs's preflight scans these files
// for DSN strings so it can make sure the databases exist; it does not evaluate
// javascript, so a template literal here made it create a database literally named
// `${DBNAME}` on the cluster (observed 2026-09-11, then dropped). Interpolation lives
// on the identifier below, never in the connection string.
const PGADMIN = 'postgres://postgres@127.0.0.1:5433/postgres';
const DB = 'postgres://postgres@127.0.0.1:5433/w9_video_launcher';
const DBNAME = 'w9_video_launcher';

// The token used throughout. Deliberately token-SHAPED (the `mb-` + hex shape
// the leaked one had) so the "never in a body / never in a log" assertions are
// testing the same string class that leaked, not a word that could not leak.
const TOKEN = 'mb-0000testtoken0000deadbeefcafe00';

const admin = postgres(PGADMIN, { ssl: false });
await admin`DROP DATABASE IF EXISTS ${admin(DBNAME)}`;
await admin`CREATE DATABASE ${admin(DBNAME)}`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB,
  NODE_ENV: 'development',
  JWT_ACCESS_SECRET: 'localdev',
  JWT_REFRESH_SECRET: 'localdev',
});
delete process.env.VIDEO_LAUNCHER_URL;
delete process.env.VIDEO_LAUNCHER_TOKEN;

// ── log capture ────────────────────────────────────────────────────────────
// Everything the process writes through console goes into `logged`. The repo's
// logger (utils/logger.js) writes through console, so this catches it too.
const logged = [];
const realConsole = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  realConsole[level] = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}
const stopCapture = () => { for (const l of Object.keys(realConsole)) console[l] = realConsole[l]; };
function startCapture() {
  for (const level of Object.keys(realConsole)) {
    console[level] = (...args) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
}
// `ok` must print for real, not into the capture buffer.
const OK = (c, m, x = '') => { stopCapture(); ok(c, m, x); startCapture(); };

// ── the stub launcher ──────────────────────────────────────────────────────
const seen = [];
const stub = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } });
  if (req.url.startsWith('/health')) {
    if (stub.failHealth) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>stub launcher</body></html>');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB_ORIGIN = `http://127.0.0.1:${stub.address().port}`;

// ── app under test ─────────────────────────────────────────────────────────
const { default: express } = await import('express');
const { default: videoLauncherRoutes } = await import('../../src/routes/videoLauncher.js');
const { signAccessToken } = await import('../../src/utils/jwt.js');

const app = express();
app.use(express.json());
app.use('/api/v1/video-launcher', videoLauncherRoutes); // same mount as routes/index.js
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── seed: one operator WITH brief-pipeline:access, one WITHOUT ─────────────
const sql = postgres(DB, { ssl: false });
await sql`CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE)`;
await sql`CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO roles (id, name, permissions) VALUES
  ('r_prod','Team - Production', ${sql.json({ 'brief-pipeline': ['access'] })}),
  ('r_view','Viewer',            ${sql.json({ departments: ['read'] })})`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_prod','p@t.co','P','R'), ('u_view','v@t.co','V','W')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_prod','r_prod'), ('u_view','r_view')`;

const H_PROD = { Authorization: `Bearer ${signAccessToken({ userId: 'u_prod' })}` };
const H_VIEW = { Authorization: `Bearer ${signAccessToken({ userId: 'u_view' })}` };

const get = async (path, headers = {}, redirect = 'manual') => {
  const r = await fetch(`${BASE}/api/v1/video-launcher${path}`, { headers, redirect });
  const body = await r.text();
  let j = null; try { j = JSON.parse(body); } catch { /* not every answer is json */ }
  return { status: r.status, body, j, location: r.headers.get('location'), cache: r.headers.get('cache-control') };
};

startCapture();

// ══ E-control: the log capture must actually capture ═══════════════════════
console.warn('CANARY-W9-LOG-CAPTURE');
OK(logged.some((l) => l.includes('CANARY-W9-LOG-CAPTURE')),
  'E0 POSITIVE CONTROL: the log capture records what the process logs (a zero below would otherwise be vacuous)');

// ══ A. auth matrix ═════════════════════════════════════════════════════════
{
  const a1 = await get('/status');
  OK(a1.status === 401, 'A1 GET /status with no session → 401', `got ${a1.status}`);
  const a2 = await get('/open/app');
  OK(a2.status === 401, 'A2 GET /open/app with no session → 401', `got ${a2.status}`);
  const a3 = await get('/open/health');
  OK(a3.status === 401, 'A3 GET /open/health with no session → 401', `got ${a3.status}`);

  const a4 = await get('/status', H_VIEW);
  OK(a4.status === 403, 'A4 GET /status as an operator WITHOUT brief-pipeline:access → 403', `got ${a4.status}`);
  const a5 = await get('/open/app', H_VIEW);
  OK(a5.status === 403, 'A5 GET /open/app as an operator WITHOUT brief-pipeline:access → 403', `got ${a5.status}`);
  OK(a5.location === null, 'A5b the refused request was handed NO Location header', String(a5.location));

  // POSITIVE CONTROL for the matrix: the permitted operator is NOT refused,
  // so 401/403 above is the guard biting, not the route being broken.
  const a6 = await get('/status', H_PROD);
  OK(a6.status === 200, 'A6 POSITIVE CONTROL: the permitted operator is not refused', `got ${a6.status}`);
}

// ══ C. env unset — every store that has no launcher ════════════════════════
{
  const c1 = await get('/status', H_PROD);
  OK(c1.status === 200 && c1.j?.configured === false && c1.j?.healthy === null,
    'C1 env unset → /status 200 { configured:false, healthy:null } (no throw, nothing called)', c1.body);
  OK(c1.j?.missing?.VIDEO_LAUNCHER_URL === true && c1.j?.missing?.VIDEO_LAUNCHER_TOKEN === true,
    'C1b it names BOTH missing keys', JSON.stringify(c1.j?.missing));

  const c2 = await get('/open/app', H_PROD);
  OK(c2.status === 503 && c2.j?.error === 'video_launcher_not_configured',
    'C2 env unset → /open/app 503 video_launcher_not_configured', `${c2.status} ${c2.body}`);
  OK(c2.location === null, 'C2b and no redirect anywhere', String(c2.location));
  OK(seen.length === 0, 'C3 the upstream was NEVER contacted while unconfigured', JSON.stringify(seen));

  // Half-configured is NOT configured — a url with no token would call the
  // launcher as a guest and render an "enter access key" gate inside the frame.
  process.env.VIDEO_LAUNCHER_URL = STUB_ORIGIN;
  const c4 = await get('/status', H_PROD);
  OK(c4.j?.configured === false && c4.j?.missing?.VIDEO_LAUNCHER_TOKEN === true
     && c4.j?.missing?.VIDEO_LAUNCHER_URL === false,
    'C4 url set but token unset → still configured:false, and it says which key is missing', c4.body);
  OK(seen.length === 0, 'C5 still nothing called', JSON.stringify(seen));
}

// ══ B. the allowlist ═══════════════════════════════════════════════════════
process.env.VIDEO_LAUNCHER_TOKEN = TOKEN;
{
  // The last four are the ones that used to get THROUGH. When TARGETS was an object
  // literal, `TARGETS[name]` answered every inherited Object.prototype key as a truthy
  // value, so `constructor` passed the `if (!target)` guard and reached the fetch branch
  // with an undefined path — a call to `<launcher>undefined` carrying the admin token.
  // TARGETS is a Map now; these assert it stays one.
  for (const bad of ['bogus', 'admin', 'api', '..%2F..%2Fadmin', '%2e%2e%2f', 'APP', 'app%00',
                     'constructor', '__proto__', 'toString', 'valueOf']) {
    const r = await get(`/open/${bad}`, H_PROD);
    OK(r.status === 400 && r.j?.error === 'target_not_allowed',
      `B GET /open/${bad} → 400 target_not_allowed`, `${r.status} ${r.body}`);
    OK(r.location === null, `B  …and no Location was issued for /open/${bad}`, String(r.location));
  }
  const listed = (await get('/open/bogus', H_PROD)).j?.allowed;
  OK(Array.isArray(listed) && listed.length === 2 && listed.includes('app') && listed.includes('health'),
    'B2 the allowlist is exactly the two endpoints the page calls', JSON.stringify(listed));
  OK(seen.length === 0, 'B3 no refused target reached the upstream', JSON.stringify(seen));
}

// ══ D. configured — the token is attached server-side ══════════════════════
{
  const d1 = await get('/status', H_PROD);
  OK(d1.status === 200 && d1.j?.configured === true && d1.j?.healthy === true,
    'D1 configured + upstream up → { configured:true, healthy:true }', d1.body);

  const healthHit = seen.find((s) => s.url.startsWith('/health'));
  OK(!!healthHit, 'D2 the SERVER made the health call (the browser never did)', JSON.stringify(seen.map((s) => s.url)));
  OK(healthHit?.headers['x-access-token'] === TOKEN,
    'D3 the token reached the upstream in the X-Access-Token HEADER', JSON.stringify(Object.keys(healthHit?.headers || {})));
  OK(healthHit?.url === '/health',
    'D4 …and NOT in the health URL (no credential in a query string)', String(healthHit?.url));

  OK(!d1.body.includes(TOKEN) && !d1.body.includes(STUB_ORIGIN) && !d1.body.includes('127.0.0.1'),
    'D5 /status body carries neither the token nor the host', d1.body);

  const d6 = await get('/open/app', H_PROD);
  OK(d6.status === 302, 'D6 /open/app → 302', `got ${d6.status}`);
  OK(typeof d6.location === 'string' && d6.location.startsWith(`${STUB_ORIGIN}/?access=`),
    'D7 the Location points at the store\'s launcher with the token attached server-side', String(d6.location));
  OK(d6.location.includes(encodeURIComponent(TOKEN)) || d6.location.includes(TOKEN),
    'D8 …carrying the token the ENV holds, not one the client supplied', 'location did not carry it');
  OK(!d6.body.includes(TOKEN), 'D9 the RESPONSE BODY of /open/app contains no token', d6.body.slice(0, 200));
  OK(/no-store/.test(d6.cache || '') && /private/.test(d6.cache || ''),
    'D10 the redirect is Cache-Control: no-store, private (its Location carries a credential)', String(d6.cache));

  const d11 = await get('/open/health', H_PROD);
  OK(d11.status === 200 && d11.body.includes('"ok":true'),
    'D11 /open/health proxies the upstream answer through this server', `${d11.status} ${d11.body}`);
  OK(!d11.body.includes(TOKEN), 'D12 …and the proxied body carries no token', d11.body);
}

// ══ D-failure: the upstream is down / broken ═══════════════════════════════
{
  stub.failHealth = true;
  const f1 = await get('/status', H_PROD);
  OK(f1.j?.configured === true && f1.j?.healthy === false,
    'F1 upstream answers 500 → healthy:false (not a 500 from us)', f1.body);
  OK(!f1.body.includes(TOKEN) && !f1.body.includes(STUB_ORIGIN),
    'F1b …and the unhealthy answer still leaks neither token nor host', f1.body);
  stub.failHealth = false;

  // Now the upstream is GONE, not merely unhappy.
  const port = stub.address().port;
  await new Promise((r) => stub.close(r));
  const f2 = await get('/status', H_PROD);
  OK(f2.status === 200 && f2.j?.healthy === false && f2.j?.reason === 'network',
    'F2 upstream unreachable → healthy:false, reason classified as network', f2.body);
  OK(!f2.body.includes(TOKEN) && !f2.body.includes(String(port)),
    'F2b …and the network failure echoes neither the token nor the port', f2.body);
  // /open/app still redirects: whether the tool is up is the browser's problem,
  // and refusing here would break the page every time the launcher cold-starts.
  const f3 = await get('/open/app', H_PROD);
  OK(f3.status === 302, 'F3 /open/app still redirects while the tool is waking up', `got ${f3.status}`);
}

// ══ G. the SSRF guard bites on the ENV value, every request ════════════════
{
  const cases = [
    ['https://169.254.169.254', 'cloud metadata (link-local)'],
    ['https://127.0.0.1', 'loopback over https'],
    ['https://10.1.2.3', 'private 10/8'],
    ['https://metadata.google.internal', 'GCP metadata hostname'],
  ];
  process.env.NODE_ENV = 'production';
  for (const [url, label] of cases) {
    process.env.VIDEO_LAUNCHER_URL = url;
    const r = await get('/open/app', H_PROD);
    OK(r.status === 502 && r.j?.error === 'upstream_refused',
      `G /open/app with VIDEO_LAUNCHER_URL = ${label} → 502 upstream_refused`, `${r.status} ${r.body}`);
    OK(r.location === null && !r.body.includes(TOKEN),
      `G  …no Location, no token in the body (${label})`, `${r.location} ${r.body}`);
  }
  // …and plaintext http is refused in production even on a public host.
  process.env.VIDEO_LAUNCHER_URL = 'http://example.com';
  const g2 = await get('/open/app', H_PROD);
  OK(g2.status === 502 && g2.j?.reason === 'scheme',
    'G2 plaintext http is refused in production (reason: scheme)', `${g2.status} ${g2.body}`);
  process.env.NODE_ENV = 'development';
}

// ══ H. a malformed / hostile env value never becomes a URL ═════════════════
{
  for (const v of ['not a url', 'javascript:alert(1)', '   ', 'ftp://example.com']) {
    process.env.VIDEO_LAUNCHER_URL = v;
    const r = await get('/status', H_PROD);
    OK(r.status === 200 && r.j?.configured === false,
      `H VIDEO_LAUNCHER_URL = ${JSON.stringify(v)} → configured:false, page disabled`, r.body);
    const r2 = await get('/open/app', H_PROD);
    OK(r2.status === 503 && r2.location === null,
      `H  …and /open/app refuses with 503, no redirect (${JSON.stringify(v)})`, `${r2.status} ${r2.location}`);
  }
  // A url with a path/query/fragment is normalised to a bare origin, so a
  // pasted value cannot retarget the call.
  process.env.VIDEO_LAUNCHER_URL = 'https://launcher.example.test/some/path?token=x#frag';
  const { videoLauncherUrl } = await import('../../src/config/storeConfig.js');
  OK(videoLauncherUrl() === 'https://launcher.example.test',
    'H2 a url with a path/query/fragment is normalised to a bare origin', String(videoLauncherUrl()));
}

// ══ E. the token and the host are in NO log line ═══════════════════════════
{
  stopCapture();
  const leaked = logged.filter((l) => l.includes(TOKEN));
  const hostLeaked = logged.filter((l) => l.includes(STUB_ORIGIN));
  ok(logged.length > 0, 'E1 (sanity) the run produced log lines at all', String(logged.length));
  ok(leaked.length === 0, `E2 the TOKEN appears in 0 of ${logged.length} captured log lines`, leaked.join(' | ').slice(0, 400));
  ok(hostLeaked.length === 0, `E3 the launcher HOST appears in 0 of ${logged.length} captured log lines`, hostLeaked.join(' | ').slice(0, 400));
  console.log(`# captured ${logged.length} log lines; ${logged.filter((l) => /videoLauncher|storeConfig/.test(l)).length} of them from this feature`);
  for (const l of logged.filter((l) => /videoLauncher|VIDEO_LAUNCHER/.test(l)).slice(0, 6)) console.log(`#   ${l}`);
}

await sql.end();
await new Promise((r) => server.close(r));
try { await new Promise((r) => stub.close(r)); } catch { /* already closed in F */ }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
