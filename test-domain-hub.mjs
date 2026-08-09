// Domain Hub — verification-by-execution harness.
//
//   node test-domain-hub.mjs
//
// Embedded PG 127.0.0.1:5433 (db puure_domains), app on PORT 4026.
// Registrar, Render, and Cloudflare APIs are MOCKED via their env base-URL
// seams (no real purchases, no real registrations, ever). DNS is controlled
// through the injectable resolver seam in dnsInspect.js.

// ── Env BEFORE any app import (config/env.js reads at import time) ─────────
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://puure:puure@127.0.0.1:5433/puure_domains';
process.env.REDIS_URL = 'redis://127.0.0.1:1'; // unreachable — auth cache degrades
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.PORT = '4026';
process.env.DOMAIN_SWEEP_DISABLED = '1';           // deterministic: we call sweepOnce()
process.env.RENDER_API_BASE = 'http://127.0.0.1:4126';
process.env.RENDER_API_KEY = 'rnd_test_mock_key';
process.env.RENDER_SERVICE_ID = 'srv-test0000000000000';
process.env.RENDER_TARGET_HOST = 'puure-dashboard.onrender.com';
// Namecheap: configured mid-run (the "refuses without creds" test runs first).
process.env.NAMECHEAP_API_BASE = 'http://127.0.0.1:4127/xml.response';
// Cloudflare: configured only for the auto-DNS test.
process.env.CLOUDFLARE_API_BASE = 'http://127.0.0.1:4128/client/v4';

// Static imports are hoisted ABOVE the env block, so every app module is
// loaded dynamically here, after process.env is in place.
const { default: express } = await import('express');
const { pgQuery } = await import('./server/src/db/pg.js');
const { signAccessToken } = await import('./server/src/utils/jwt.js');
const { setResolver, resetResolver } = await import('./server/src/services/domainHub/dnsInspect.js');
const {
  resolveCustomHost, invalidateHostCache, customDomainMiddleware,
  isPlausibleHost, setHostQueryRunner, resetHostQueryRunner, hostCacheStats,
} = await import('./server/src/services/domainHub/hostRouting.js');
const { sweepOnce, startDomainSweep, stopDomainSweep } = await import('./server/src/services/domainHub/verifySweep.js');
const { default: domainHubRoutes } = await import('./server/src/routes/domainHub.js');

// ── tiny test runner ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

// ── Mock DNS resolver seam ──────────────────────────────────────────────────
// dns = { ns: {host: [..]}, cname: {host: [..]}, a: {host: [..]} }
const dns = { ns: {}, cname: {}, a: {}, failAll: false };
const empty = () => { const e = new Error('queryX ENODATA'); e.code = 'ENODATA'; return e; };
const netFail = () => { const e = new Error('queryX ETIMEOUT'); e.code = 'ETIMEOUT'; return e; };
setResolver({
  async resolveNs(h)    { if (dns.failAll) throw netFail(); if (dns.ns[h]) return dns.ns[h]; throw empty(); },
  async resolveCname(h) { if (dns.failAll) throw netFail(); if (dns.cname[h]) return dns.cname[h]; throw empty(); },
  async resolve4(h)     { if (dns.failAll) throw netFail(); if (dns.a[h]) return dns.a[h]; throw empty(); },
  async resolve6()      { if (dns.failAll) throw netFail(); throw empty(); },
});

// ── Mock Render API (:4126) ─────────────────────────────────────────────────
const renderState = {
  domains: new Map(), // name → obj
  createCalls: 0, deleteCalls: 0, listCalls: 0,
  verifiedByDefault: false,
  failCreate: false, failDelete: false,
};
const renderApp = express();
renderApp.use(express.json());
renderApp.use((req, res, next) => {
  if (req.headers.authorization !== 'Bearer rnd_test_mock_key') {
    return res.status(401).json({ message: 'unauthorized' });
  }
  next();
});
renderApp.get('/v1/services/:sid/custom-domains', (req, res) => {
  renderState.listCalls++;
  res.json([...renderState.domains.values()].map((d) => ({ customDomain: d, cursor: 'c' })));
});
renderApp.post('/v1/services/:sid/custom-domains', (req, res) => {
  renderState.createCalls++;
  if (renderState.failCreate) return res.status(500).json({ message: 'render exploded' });
  const name = String(req.body.name || '').toLowerCase();
  if (renderState.domains.has(name)) return res.status(409).json({ message: 'already exists' });
  const obj = {
    id: 'cdm-' + Math.random().toString(16).slice(2, 10),
    name,
    domainType: name.split('.').length === 2 ? 'apex' : 'subdomain',
    verificationStatus: renderState.verifiedByDefault ? 'verified' : 'unverified',
  };
  renderState.domains.set(name, obj);
  res.status(201).json({ customDomain: obj });
});
renderApp.get('/v1/services/:sid/custom-domains/:id', (req, res) => {
  const hit = [...renderState.domains.values()].find((d) => d.id === req.params.id || d.name === req.params.id);
  if (!hit) return res.status(404).json({ message: 'not found' });
  res.json({ customDomain: hit });
});
renderApp.post('/v1/services/:sid/custom-domains/:id/verify', (req, res) => {
  const hit = [...renderState.domains.values()].find((d) => d.id === req.params.id || d.name === req.params.id);
  if (!hit) return res.status(404).json({ message: 'not found' });
  res.json({ customDomain: hit });
});
renderApp.delete('/v1/services/:sid/custom-domains/:id', (req, res) => {
  renderState.deleteCalls++;
  if (renderState.failDelete) return res.status(500).json({ message: 'render exploded' });
  const hit = [...renderState.domains.values()].find((d) => d.id === req.params.id || d.name === req.params.id);
  if (!hit) return res.status(404).json({ message: 'not found' });
  renderState.domains.delete(hit.name);
  res.status(204).end();
});

// ── Mock Namecheap API (:4127) — XML like the real thing ────────────────────
const ncState = { owned: new Set(['already-owned-example.com']), createCalls: 0, checkCalls: 0 };
const ncApp = express();
ncApp.use(express.urlencoded({ extended: false }));
ncApp.post('/xml.response', (req, res) => {
  const p = req.body;
  res.type('application/xml');
  if (p.ApiKey !== 'nc-test-key') {
    return res.send(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors></ApiResponse>`);
  }
  if (p.Command === 'namecheap.domains.check') {
    ncState.checkCalls++;
    const rows = String(p.DomainList).split(',').map((d) => {
      const dom = d.trim().toLowerCase();
      const available = !ncState.owned.has(dom) && !dom.startsWith('taken');
      const premium = dom.startsWith('premium');
      return `<DomainCheckResult Domain="${dom}" Available="${available}" ErrorNo="0" IsPremiumName="${premium}" PremiumRegistrationPrice="${premium ? '104.99' : '0'}"/>`;
    }).join('');
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.check">${rows}</CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.users.getPricing') {
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.users.getPricing"><UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register"><Product Name="com"><Price Duration="1" DurationType="YEAR" Price="10.28" YourPrice="10.28" Currency="USD"/></Product><Product Name="io"><Price Duration="1" DurationType="YEAR" Price="32.98" YourPrice="32.98" Currency="USD"/></Product><Product Name="co"><Price Duration="1" DurationType="YEAR" Price="27.98" YourPrice="27.98" Currency="USD"/></Product></ProductCategory></ProductType></UserGetPricingResult></CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.domains.create') {
    ncState.createCalls++;
    const dom = String(p.DomainName).toLowerCase();
    if (ncState.owned.has(dom)) {
      return res.send(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="2011168">Domain is not available</Error></Errors></ApiResponse>`);
    }
    if (!p.RegistrantEmailAddress) {
      return res.send(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="2010324">Registrant email missing</Error></Errors></ApiResponse>`);
    }
    ncState.owned.add(dom);
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.create"><DomainCreateResult Domain="${dom}" Registered="true" ChargedAmount="10.87" DomainID="9007" OrderID="1234321" TransactionID="55" WhoisguardEnable="true"/></CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.domains.getList') {
    const rows = [...ncState.owned].map((d, i) =>
      `<Domain ID="${100 + i}" Name="${d}" Created="01/01/2026" Expires="01/01/2027" IsExpired="false" IsLocked="false" AutoRenew="true"/>`).join('');
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.getList"><DomainGetListResult>${rows}</DomainGetListResult></CommandResponse></ApiResponse>`);
  }
  res.send(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="0">Unknown command</Error></Errors></ApiResponse>`);
});

// ── Mock Cloudflare API (:4128) ─────────────────────────────────────────────
const cfState = { records: [], createCalls: 0 };
const cfApp = express();
cfApp.use(express.json());
cfApp.use((req, res, next) => {
  if (req.headers.authorization !== 'Bearer cf-test-token') {
    return res.status(403).json({ success: false, errors: [{ message: 'bad token' }] });
  }
  next();
});
cfApp.get('/client/v4/zones', (req, res) => {
  const name = String(req.query.name || '');
  const result = name === 'cfzone-example.com' ? [{ id: 'zone-1', name }] : [];
  res.json({ success: true, result });
});
cfApp.get('/client/v4/zones/:zid/dns_records', (req, res) => {
  const hits = cfState.records.filter((r) => r.type === req.query.type && r.name === req.query.name);
  res.json({ success: true, result: hits });
});
cfApp.post('/client/v4/zones/:zid/dns_records', (req, res) => {
  cfState.createCalls++;
  const rec = { id: 'rec-' + cfState.records.length, ...req.body };
  cfState.records.push(rec);
  res.json({ success: true, result: rec });
});
cfApp.put('/client/v4/zones/:zid/dns_records/:rid', (req, res) => {
  const i = cfState.records.findIndex((r) => r.id === req.params.rid);
  if (i >= 0) cfState.records[i] = { ...cfState.records[i], ...req.body };
  res.json({ success: true, result: cfState.records[i] });
});

// ── DB fixtures (auth + funnels tables the module composes with) ────────────
async function setupDb() {
  await pgQuery(`DROP TABLE IF EXISTS lb_domains, domain_events, domain_whois_contact CASCADE`);
  await pgQuery(`DROP TABLE IF EXISTS user_roles, roles, users, funnels CASCADE`);
  await pgQuery(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
    must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE, is_active BOOLEAN DEFAULT TRUE)`);
  await pgQuery(`CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`);
  await pgQuery(`CREATE TABLE user_roles (user_id TEXT, role_id TEXT)`);
  await pgQuery(`CREATE TABLE funnels (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE)`);
  await pgQuery(`INSERT INTO users (id, email) VALUES ('u-test', 'op@test.local')`);
  await pgQuery(`INSERT INTO roles (id, name, permissions) VALUES ('r-test', 'Operator', '{"funnels": ["access"]}')`);
  await pgQuery(`INSERT INTO user_roles VALUES ('u-test', 'r-test')`);
  await pgQuery(`INSERT INTO funnels (id, slug, name, status) VALUES
    ('f1', 'brand-funnel', 'Brand funnel', 'published'),
    ('f2', 'second-funnel', 'Second funnel', 'published'),
    ('f-arch', 'archived-funnel', 'Archived', 'published')`);
  await pgQuery(`UPDATE funnels SET archived = TRUE WHERE id = 'f-arch'`);
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
const token = signAccessToken({ userId: 'u-test', email: 'op@test.local' });
const BASE = 'http://127.0.0.1:4026/api/v1/domain-hub';
async function api(method, path, body, { auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

// ── main ────────────────────────────────────────────────────────────────────
const servers = [];
function listen(app, port) {
  return new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); servers.push(s); });
}

try {
  await setupDb();
  await listen(renderApp, 4126);
  await listen(ncApp, 4127);
  await listen(cfApp, 4128);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/domain-hub', domainHubRoutes);
  await listen(app, 4026);

  console.log('\n── auth gate ──');
  {
    const r = await api('GET', '/list', undefined, { auth: false });
    check('unauthenticated request → 401', r.status === 401);
  }

  console.log('\n── invalid domains rejected ──');
  for (const [raw, expect] of [
    ['1.2.3.4', 'ip_not_allowed'],
    ['localhost', 'domain_needs_tld'], // single-label check fires first — still rejected
    ['app.localhost', 'own_host_not_allowed'],
    ['evil.onrender.com', 'own_host_not_allowed'],
    ['puure-dashboard.onrender.com', 'own_host_not_allowed'],
    ['trypuure.co', 'own_host_not_allowed'],
    ['funnel.trypuure.co', 'own_host_not_allowed'],
    ['not a domain!!', 'domain_invalid'],
    ['singlelabel', 'domain_needs_tld'],
    ['pаypal.com', 'mixed_script_homoglyph'], // Cyrillic 'а'
    ['gооgle.net', 'mixed_script_homoglyph'], // Cyrillic 'о'
    ['', 'domain_required'],
  ]) {
    const r = await api('POST', '/attach', { domain: raw, funnel_id: 'f1' });
    check(`reject "${raw}" → 400 ${expect}`, r.status === 400 && r.json?.error === expect,
      `got ${r.status} ${r.json?.error}`);
  }
  {
    const r = await api('POST', '/attach', { domain: 'shop.example-brand.com', funnel_id: 'nope' });
    check('unknown funnel → 404 funnel_not_found', r.status === 404 && r.json?.error === 'funnel_not_found');
    const r2 = await api('POST', '/attach', { domain: 'shop.example-brand.com', funnel_id: 'f-arch' });
    check('archived funnel → 404', r2.status === 404);
  }

  console.log('\n── attach flow end-to-end (subdomain) ──');
  const SUB = 'shop.brandsite-example.com';
  dns.ns['brandsite-example.com'] = ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'];
  {
    const r = await api('POST', '/attach', { domain: SUB, funnel_id: 'f1' });
    check('attach → 201', r.status === 201, `got ${r.status}`);
    check('status pending_dns (no DNS yet)', r.json?.data?.domain?.status === 'pending_dns',
      `got ${r.json?.data?.domain?.status}`);
    check('provider detected = namecheap (via NS)', r.json?.data?.provider === 'namecheap',
      `got ${r.json?.data?.provider}`);
    const recs = r.json?.data?.records || [];
    check('records include CNAME → render host',
      recs.some((x) => x.type === 'CNAME' && x.value === 'puure-dashboard.onrender.com'));
    check('verification token minted', String(r.json?.data?.domain?.verification_token || '').startsWith('puure-verify-'));
    check('render not called yet (DNS not pointing)', renderState.createCalls === 0, `calls=${renderState.createCalls}`);
  }
  {
    const r = await api('POST', '/attach', { domain: SUB, funnel_id: 'f1' });
    check('re-attach same funnel → 200 resume, no dup', r.status === 200 && r.json?.data?.resumed === true);
    const rows = await pgQuery(`SELECT count(*)::int AS n FROM lb_domains WHERE domain = $1`, [SUB]);
    check('exactly one row after re-attach', rows[0].n === 1);
    const r2 = await api('POST', '/attach', { domain: SUB, funnel_id: 'f2' });
    check('attach to OTHER funnel → 409', r2.status === 409 && r2.json?.error === 'domain_attached_to_other_funnel');
  }
  {
    // records view shows required vs observed (nothing observed yet)
    const r = await api('GET', `/${SUB}/records`);
    check('records view → 200 with required + observed', r.status === 200
      && Array.isArray(r.json?.data?.required) && r.json?.data?.observed?.cname?.length === 0);
  }
  {
    // sweep while DNS still absent → stays pending_dns, attempt counted
    await sweepOnce();
    const rows = await pgQuery(`SELECT status, verify_attempts FROM lb_domains WHERE domain = $1`, [SUB]);
    check('sweep w/o DNS → still pending_dns', rows[0].status === 'pending_dns');
    check('verify attempt counted', rows[0].verify_attempts >= 1, `attempts=${rows[0].verify_attempts}`);
    check('render still not called', renderState.createCalls === 0);
  }
  {
    // operator creates the CNAME → sweep → Render registered → verifying
    dns.cname[SUB] = ['puure-dashboard.onrender.com'];
    await sweepOnce();
    let rows = await pgQuery(`SELECT status, render_domain_id FROM lb_domains WHERE domain = $1`, [SUB]);
    check('DNS points → status verifying (Render unverified)', rows[0].status === 'verifying', `got ${rows[0].status}`);
    check('render create called EXACTLY once', renderState.createCalls === 1, `calls=${renderState.createCalls}`);
    check('render_domain_id stored', String(rows[0].render_domain_id || '').startsWith('cdm-'));

    // second sweep before Render verifies → still exactly one create
    await sweepOnce();
    check('re-verify does NOT re-create (idempotent)', renderState.createCalls === 1, `calls=${renderState.createCalls}`);

    // Render marks it verified → next sweep connects
    renderState.domains.get(SUB).verificationStatus = 'verified';
    await sweepOnce();
    rows = await pgQuery(`SELECT status FROM lb_domains WHERE domain = $1`, [SUB]);
    check('Render verified → connected', rows[0].status === 'connected', `got ${rows[0].status}`);
    check('still exactly one render create', renderState.createCalls === 1, `calls=${renderState.createCalls}`);
  }
  {
    // verify-now on a connected row: no state damage, no extra create
    const r = await api('POST', `/${SUB}/verify`);
    check('verify-now on connected → 200 connected', r.status === 200 && r.json?.data?.status === 'connected');
    check('no extra render create on verify-now', renderState.createCalls === 1);
  }

  console.log('\n── attach flow (apex, A record) ──');
  const APEX = 'brandsite-example.com';
  {
    renderState.verifiedByDefault = true; // this time Render verifies instantly
    const r = await api('POST', '/attach', { domain: APEX, funnel_id: 'f1' });
    check('apex attach → 201', r.status === 201);
    const recs = r.json?.data?.records || [];
    check('apex records include A 216.24.57.1', recs.some((x) => x.type === 'A' && x.value === '216.24.57.1'));
    dns.a[APEX] = ['216.24.57.1'];
    const rv = await api('POST', `/${APEX}/verify`);
    check('apex A record points → connected in one verify', rv.json?.data?.status === 'connected',
      `got ${rv.json?.data?.status}`);
  }

  console.log('\n── DNS lookup failure = transient, not an error ──');
  {
    const T = 'transient.flaky-example.com';
    await api('POST', '/attach', { domain: T, funnel_id: 'f1' });
    dns.failAll = true;
    const r = await api('POST', `/${T}/verify`);
    check('resolver down → verify survives, stays pending_dns',
      r.status === 200 && r.json?.data?.status === 'pending_dns', `got ${r.status} ${r.json?.data?.status}`);
    dns.failAll = false;
  }

  console.log('\n── Render API failure path ──');
  {
    const F = 'renderfail.brokentest-example.com';
    await api('POST', '/attach', { domain: F, funnel_id: 'f1' });
    dns.cname[F] = ['puure-dashboard.onrender.com'];
    renderState.failCreate = true;
    const before = renderState.createCalls;
    const r = await api('POST', `/${F}/verify`);
    const row = r.json?.data;
    check('render 500 → row parks at verifying with error_detail, no crash',
      r.status === 200 && row?.status === 'verifying' && String(row?.error_detail || '').includes('render_register_failed'),
      `got ${r.status} ${row?.status} ${row?.error_detail}`);
    renderState.failCreate = false;
    const r2 = await api('POST', `/${F}/verify`);
    check('after Render recovers → connected', r2.json?.data?.status === 'connected');
    check('recovery used exactly one MORE create', renderState.createCalls === before + 2, // 1 failed + 1 ok
      `calls=${renderState.createCalls} before=${before}`);
  }

  console.log('\n── bounded retries → error state, verify-now resumes ──');
  {
    const E = 'neverpoints.abandoned-example.com';
    await api('POST', '/attach', { domain: E, funnel_id: 'f1' });
    await pgQuery(`UPDATE lb_domains SET verify_attempts = 239 WHERE domain = $1`, [E]);
    await sweepOnce();
    let rows = await pgQuery(`SELECT status, error_detail FROM lb_domains WHERE domain = $1`, [E]);
    check('attempts exhausted → status error', rows[0].status === 'error', `got ${rows[0].status}`);
    check('error_detail explains', String(rows[0].error_detail || '').includes('dns_never_pointed'));
    await sweepOnce(); // sweep skips error rows
    // verify-now resumes it
    dns.cname[E] = ['puure-dashboard.onrender.com'];
    const r = await api('POST', `/${E}/verify`);
    check('verify-now resets + resumes → connected', r.json?.data?.status === 'connected', `got ${r.json?.data?.status}`);
  }

  console.log('\n── resolveCustomHost (serving hook) ──');
  {
    const hit = await resolveCustomHost(SUB);
    check('connected domain resolves → funnel f1 + slug', hit?.funnelId === 'f1' && hit?.slug === 'brand-funnel',
      JSON.stringify(hit));
    const miss = await resolveCustomHost('unknown-host-example.net');
    check('unknown host → null', miss === null);
    const appHost = await resolveCustomHost('puure-dashboard.onrender.com');
    check('our own app host → null (short-circuit)', appHost === null);
    const pending = await resolveCustomHost('neverpoints.abandoned-example.com'.replace('neverpoints', 'transient'));
    check('non-connected (pending) domain → null', pending === null);

    // caching: flip the row under the cache — stale answer until invalidated
    await pgQuery(`UPDATE lb_domains SET status = 'pending_dns' WHERE domain = $1`, [SUB]);
    const cached = await resolveCustomHost(SUB);
    check('cached ~30s: stale value served after direct DB flip', cached?.funnelId === 'f1');
    invalidateHostCache(SUB);
    const fresh = await resolveCustomHost(SUB);
    check('invalidate → fresh lookup sees pending (null)', fresh === null);
    await pgQuery(`UPDATE lb_domains SET status = 'connected' WHERE domain = $1`, [SUB]);
    invalidateHostCache(SUB);

    // www sibling: www.<apex> resolves the apex row
    const sib = await resolveCustomHost('www.' + APEX);
    check('www sibling of connected apex resolves', sib?.funnelId === 'f1', JSON.stringify(sib));
  }
  {
    // middleware rewrite (unit — the wiring itself happens at merge)
    const mw = customDomainMiddleware();
    const req = { method: 'GET', path: '/', url: '/?utm_source=fb', hostname: SUB, headers: { host: SUB } };
    await new Promise((resolve) => mw(req, {}, resolve));
    check('middleware rewrites / → /f/<slug> with query preserved',
      req.url === '/f/brand-funnel?utm_source=fb', `got ${req.url}`);
    const req2 = { method: 'GET', path: '/checkout', url: '/checkout', hostname: SUB, headers: { host: SUB } };
    await new Promise((resolve) => mw(req2, {}, resolve));
    check('middleware rewrites /checkout → /f/<slug>/checkout', req2.url === '/f/brand-funnel/checkout', `got ${req2.url}`);
    const req3 = { method: 'GET', path: '/api/v1/health', url: '/api/v1/health', hostname: SUB, headers: { host: SUB } };
    await new Promise((resolve) => mw(req3, {}, resolve));
    check('middleware passes /api through untouched', req3.url === '/api/v1/health');
    const req4 = { method: 'GET', path: '/', url: '/', hostname: 'unrelated-example.org', headers: { host: 'unrelated-example.org' } };
    await new Promise((resolve) => mw(req4, {}, resolve));
    check('middleware leaves unknown host untouched', req4.url === '/');
  }

  console.log('\n── HARDENING 1: junk-Host flood costs ZERO queries ──');
  {
    // Syntactic gate, unit level.
    for (const bad of [
      'nodot', '../../etc/passwd', 'a'.repeat(260) + '.com', 'UPPER.com',
      'has space.com', 'xn-- .com', '-lead.com', 'trail-.com',
      '.leadingdot.com', 'trailingdot.com.'.replace(/$/, '.'),
      'label' + 'x'.repeat(64) + '.com', 'ünicode.com', 'a..b.com',
      'semi;colon.com', "quote'.com", '<script>.com',
    ]) {
      check(`isPlausibleHost rejects ${JSON.stringify(bad.slice(0, 24))}`, isPlausibleHost(bad) === false);
    }
    check('isPlausibleHost accepts a real host', isPlausibleHost('shop.brandsite-example.com') === true);
    check('isPlausibleHost accepts an apex', isPlausibleHost('brandsite-example.com') === true);
    check('isPlausibleHost accepts punycode', isPlausibleHost('xn--bcher-kva.com') === true);

    // Warm a real connected domain into the POSITIVE cache first.
    invalidateHostCache();
    const warm = await resolveCustomHost(APEX);
    check('connected domain warm in cache before flood', warm?.funnelId === 'f1', JSON.stringify(warm));

    // Count every query the resolver would execute.
    let queries = 0;
    setHostQueryRunner(async (...args) => { queries++; return pgQuery(...args); });

    // 10k DISTINCT junk hosts — none syntactically plausible.
    const junkShapes = [
      (i) => `junk${i}`,                     // no dot
      (i) => `../../etc/passwd${i}`,         // traversal
      (i) => `bad host ${i}.com`,            // space
      (i) => `${'x'.repeat(70)}${i}.com`,    // over-long label
      (i) => `-${i}.com`,                    // leading hyphen
    ];
    for (let i = 0; i < 10_000; i++) {
      const h = junkShapes[i % junkShapes.length](i);
      const r = await resolveCustomHost(h);
      if (r !== null) { check(`junk host ${h} resolved (should be null)`, false); break; }
    }
    check('10k distinct junk Hosts → ZERO queries executed', queries === 0, `queries=${queries}`);
    const statsAfterJunk = hostCacheStats();
    check('junk left NO cache entries', statsAfterJunk.negative === 0 && statsAfterJunk.positive === 1,
      JSON.stringify(statsAfterJunk));
    const stillCached = await resolveCustomHost(APEX);
    check('connected domain still resolves FROM CACHE after the flood',
      stillCached?.funnelId === 'f1' && queries === 0, `q=${queries} ${JSON.stringify(stillCached)}`);

    // Plausible-but-unattached hosts DO query — and their negatives are capped
    // in their own map, so they still cannot evict the connected entry.
    for (let i = 0; i < 700; i++) {
      await resolveCustomHost(`nobody-${i}.plausible-example.com`);
    }
    // 2 queries per miss: the exact host, then its www sibling (funnel-os
    // apex/www semantics). 700 × 2 = 1400 — this is the path a junk flood
    // WOULD have taken had the syntactic gate not stopped it.
    check('plausible unknown hosts do query (negative path alive)', queries === 1400, `queries=${queries}`);
    const statsAfterNeg = hostCacheStats();
    check('negative cache capped at its own bound', statsAfterNeg.negative <= 500, JSON.stringify(statsAfterNeg));
    check('positive entry SURVIVED negative churn', statsAfterNeg.positive === 1, JSON.stringify(statsAfterNeg));
    const afterChurn = await resolveCustomHost(APEX);
    check('connected domain still cached after 700 negatives', afterChurn?.funnelId === 'f1' && queries === 1400,
      `q=${queries}`);
    resetHostQueryRunner();
  }

  console.log('\n── HARDENING 2: production refuses degraded connect ──');
  {
    const P = 'prodgate.hardening-example.com';
    const savedKey = process.env.RENDER_API_KEY;
    const savedSvc = process.env.RENDER_SERVICE_ID;
    const savedEnv = process.env.NODE_ENV;

    // (a) production + NO Render creds → held at verifying WITH the reason.
    // Attach FIRST with no DNS so the attach-time verify can't connect it,
    // then point DNS and flip the env — the gate is what we're measuring.
    await api('POST', '/attach', { domain: P, funnel_id: 'f1' });
    dns.cname[P] = ['puure-dashboard.onrender.com'];
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_SERVICE_ID;
    process.env.NODE_ENV = 'production';
    const rProd = await api('POST', `/${P}/verify`);
    check('prod + no Render creds → status verifying (NOT connected)',
      rProd.json?.data?.status === 'verifying', `got ${rProd.json?.data?.status}`);
    check('reason surfaced in error_detail',
      String(rProd.json?.data?.error_detail || '').startsWith('render_not_configured'),
      `got ${rProd.json?.data?.error_detail}`);
    check('blocked row does NOT serve any host', (await resolveCustomHost(P)) === null);

    // (b) same env, creds restored → connects as before.
    process.env.RENDER_API_KEY = savedKey;
    process.env.RENDER_SERVICE_ID = savedSvc;
    const rCreds = await api('POST', `/${P}/verify`);
    check('prod + Render creds → connected as today', rCreds.json?.data?.status === 'connected',
      `got ${rCreds.json?.data?.status} ${rCreds.json?.data?.error_detail || ''}`);
    check('error_detail cleared on success', rCreds.json?.data?.error_detail === null);

    // (c) non-production without creds → degraded connect unchanged.
    const D = 'devgate.hardening-example.com';
    process.env.NODE_ENV = 'test';
    await api('POST', '/attach', { domain: D, funnel_id: 'f1' }); // no DNS yet
    dns.cname[D] = ['puure-dashboard.onrender.com'];
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_SERVICE_ID;
    const rDev = await api('POST', `/${D}/verify`);
    check('non-prod + no creds → degraded connect UNCHANGED', rDev.json?.data?.status === 'connected',
      `got ${rDev.json?.data?.status}`);
    const ev = await api('GET', `/events?domain=${D}`);
    check('degraded connect is audited', (ev.json?.data || []).some((e) => e.event === 'connected_degraded_no_render'));

    process.env.RENDER_API_KEY = savedKey;
    process.env.RENDER_SERVICE_ID = savedSvc;
    process.env.NODE_ENV = savedEnv;
  }

  console.log('\n── registrar: search + purchase gates ──');
  {
    // creds NOT configured yet
    const r = await api('GET', '/search?q=brandsite');
    check('search without creds → 502 namecheap_not_configured', r.status === 502 && r.json?.error === 'namecheap_not_configured');
    const p = await api('POST', '/purchase', { domain: 'brandsite-example.com', confirm: true });
    check('purchase without creds → 400 registrar_not_configured', p.status === 400 && p.json?.error === 'registrar_not_configured');
  }
  // configure Namecheap (mock)
  process.env.NAMECHEAP_API_USER = 'ludo';
  process.env.NAMECHEAP_API_KEY = 'nc-test-key';
  process.env.NAMECHEAP_USERNAME = 'ludo';
  process.env.NAMECHEAP_CLIENT_IP = '203.0.113.7';
  {
    const r = await api('GET', '/registrar/status');
    check('registrar status: namecheap configured', r.json?.data?.registrar === 'namecheap' && r.json?.data?.configured === true);
  }
  {
    const r = await api('GET', '/search?q=brandsite');
    check('search → 200 with rows', r.status === 200 && (r.json?.data?.results?.length || 0) > 0,
      `status=${r.status} n=${r.json?.data?.results?.length}`);
    const com = r.json?.data?.results?.find((x) => x.domain === 'brandsite.com');
    check('availability + price surfaced (brandsite.com $10.28)', com?.available === true && com?.price === 10.28,
      JSON.stringify(com));
    const taken = await api('GET', '/search?q=taken');
    check('taken domains reported unavailable', taken.json?.data?.results?.every((x) => x.domain.startsWith('taken') ? !x.available : true));
  }
  const CONTACT = {
    first_name: 'Ludo', last_name: 'Operator', email: 'op@test.local', phone: '+1.5551234567',
    address1: '1 Test St', city: 'Testville', state_province: 'TS', postal_code: '00001', country: 'US',
  };
  {
    const p0 = await api('POST', '/purchase', { domain: 'newshop-example.com' });
    check('purchase without confirm:true → 400 confirm_required', p0.status === 400 && p0.json?.error === 'confirm_required');
    check('no registrar create call happened', ncState.createCalls === 0);

    const p1 = await api('POST', '/purchase', { domain: 'newshop-example.com', confirm: true });
    check('purchase without stored/inline contact → 400', p1.status === 400 && p1.json?.error === 'whois_contact_required');

    const p2 = await api('POST', '/purchase', { domain: 'newshop-example.com', contact: CONTACT, confirm: true });
    check('gated purchase succeeds → 201 with charged amount', p2.status === 201 && p2.json?.data?.charged_amount === '10.87',
      `got ${p2.status} ${JSON.stringify(p2.json)}`);
    check('registrar create called once', ncState.createCalls === 1);

    const p3 = await api('POST', '/purchase', { domain: 'newshop-example.com', contact: CONTACT, confirm: true });
    check('re-purchase → 409 not_available (search-before-buy, no double charge)',
      p3.status === 409 && p3.json?.error === 'domain_not_available', `got ${p3.status} ${p3.json?.error}`);
    check('no second create call', ncState.createCalls === 1, `calls=${ncState.createCalls}`);

    const ev = await api('GET', '/events?domain=newshop-example.com');
    const names = (ev.json?.data || []).map((e) => e.event);
    check('purchase audited in domain_events', names.includes('purchased'), JSON.stringify(names));
  }
  {
    const r = await api('GET', '/owned');
    check('owned list includes purchased domain', r.status === 200
      && r.json?.data?.domains?.some((d) => d.domain === 'newshop-example.com'));
  }

  console.log('\n── WHOIS contact store ──');
  {
    const put = await api('PUT', '/whois', { contact: { ...CONTACT, injected: '<script>x</script>' } });
    check('whois saved; unknown fields stripped', put.status === 200 && put.json?.data?.contact?.injected === undefined);
    const get = await api('GET', '/whois');
    check('whois round-trips', get.json?.data?.contact?.first_name === 'Ludo');
    const p = await api('POST', '/purchase', { domain: 'secondshop-example.com', confirm: true });
    check('purchase falls back to STORED contact → 201', p.status === 201, `got ${p.status} ${p.json?.error || ''}`);
  }

  console.log('\n── Cloudflare auto-DNS (optional leg) ──');
  {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-test-token';
    dns.ns['cfzone-example.com'] = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
    const r = await api('POST', '/attach', { domain: 'go.cfzone-example.com', funnel_id: 'f2' });
    check('attach with CF creds → auto-created the CNAME', r.status === 201
      && r.json?.data?.cloudflare?.auto?.ok === true, JSON.stringify(r.json?.data?.cloudflare));
    check('CF record created (proxied:false)', cfState.records.some((x) => x.type === 'CNAME'
      && x.name === 'go.cfzone-example.com' && x.content === 'puure-dashboard.onrender.com' && x.proxied === false));
    const again = await api('POST', `/go.cfzone-example.com/auto-dns`);
    check('auto-dns re-run idempotent (exists, no dup create)', again.status === 200
      && again.json?.data?.created?.every((x) => x.ok), JSON.stringify(again.json?.data));
    check('exactly one CF create for that record', cfState.createCalls === 1, `calls=${cfState.createCalls}`);
    // zone not in account → honest error
    const other = await api('POST', '/attach', { domain: 'x.otherzone-example.com', funnel_id: 'f2' });
    check('zone not in CF account → attach still ok, manual instructions', other.status === 201
      && other.json?.data?.cloudflare?.auto?.error === 'zone_not_in_cloudflare_account');
    delete process.env.CLOUDFLARE_API_TOKEN;
  }

  console.log('\n── detach ──');
  {
    const noConfirm = await api('DELETE', `/${SUB}`, {});
    check('detach without confirm → 400', noConfirm.status === 400 && noConfirm.json?.error === 'confirm_must_match_domain');

    renderState.failDelete = true;
    const failDel = await api('DELETE', `/${SUB}`, { confirm: SUB });
    check('render delete fails → 502, row KEPT (no orphaned registration)', failDel.status === 502);
    const still = await pgQuery(`SELECT 1 FROM lb_domains WHERE domain = $1`, [SUB]);
    check('row survived failed detach', still.length === 1);
    renderState.failDelete = false;

    const del = await api('DELETE', `/${SUB}`, { confirm: SUB });
    check('detach → 200', del.status === 200, `got ${del.status} ${del.json?.error || ''}`);
    check('render registration removed', !renderState.domains.has(SUB));
    const gone = await pgQuery(`SELECT 1 FROM lb_domains WHERE domain = $1`, [SUB]);
    check('row deleted', gone.length === 0);
    const resolved = await resolveCustomHost(SUB);
    check('host no longer resolves after detach', resolved === null);
    const again = await api('DELETE', `/${SUB}`, { confirm: SUB });
    check('re-detach → 404 (idempotent surface)', again.status === 404);
  }

  console.log('\n── list + funnel filter ──');
  {
    const all = await api('GET', '/list');
    const f2only = await api('GET', '/list?funnel_id=f2');
    check('list returns rows', (all.json?.data?.length || 0) >= 3);
    check('funnel filter works', (f2only.json?.data || []).every((d) => d.funnel_id === 'f2')
      && (f2only.json?.data?.length || 0) >= 1);
  }

  console.log('\n── sweep start/stop ──');
  {
    check('sweep disabled via env returns null', startDomainSweep() === null);
    delete process.env.DOMAIN_SWEEP_DISABLED;
    const t = startDomainSweep();
    check('sweep starts when enabled', t !== null);
    check('second start is a no-op (same timer)', startDomainSweep() === t);
    stopDomainSweep();
  }
} catch (err) {
  failed++;
  console.error('\nHARNESS CRASH:', err);
} finally {
  resetResolver();
  for (const s of servers) s.close();
  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  if (failures.length) console.log('Failures:\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
}
