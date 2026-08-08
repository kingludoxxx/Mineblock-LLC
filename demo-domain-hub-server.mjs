// Domain Hub — UI demo backend (screenshot/verification only, NOT shipped).
// Serves stub auth + the REAL /api/v1/domain-hub routes on :4026, with the
// registrar / Render / Cloudflare APIs mocked on local ports and DNS answered
// by the injectable resolver seam. Point vite dev at it:
//   VITE_PROXY_TARGET=http://127.0.0.1:4026
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://puure:puure@127.0.0.1:5433/puure_domains';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.DOMAIN_SWEEP_DISABLED = '1';
process.env.RENDER_API_BASE = 'http://127.0.0.1:4126';
process.env.RENDER_API_KEY = 'rnd_test_mock_key';
process.env.RENDER_SERVICE_ID = 'srv-test0000000000000';
process.env.RENDER_TARGET_HOST = 'puure-dashboard.onrender.com';
process.env.NAMECHEAP_API_BASE = 'http://127.0.0.1:4127/xml.response';
process.env.NAMECHEAP_API_USER = 'ludo';
process.env.NAMECHEAP_API_KEY = 'nc-test-key';
process.env.NAMECHEAP_USERNAME = 'ludo';
process.env.NAMECHEAP_CLIENT_IP = '203.0.113.7';
process.env.CLOUDFLARE_API_BASE = 'http://127.0.0.1:4128/client/v4';
process.env.CLOUDFLARE_API_TOKEN = 'cf-test-token';

const { default: express } = await import('express');
const { pgQuery } = await import('./server/src/db/pg.js');
const { signAccessToken } = await import('./server/src/utils/jwt.js');
const { setResolver } = await import('./server/src/services/domainHub/dnsInspect.js');
const { default: domainHubRoutes } = await import('./server/src/routes/domainHub.js');

// ── DNS mock ────────────────────────────────────────────────────────────────
const dns = {
  ns: {
    'glowbrand-demo.com': ['dns1.registrar-servers.com'],
    'lushlift-demo.com': ['ada.ns.cloudflare.com'],
    'brandsite-demo.com': ['ns1.domaincontrol.com'],
  },
  cname: { 'shop.glowbrand-demo.com': ['puure-dashboard.onrender.com'] },
  a: { 'lushlift-demo.com': ['216.24.57.1'] },
};
const empty = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; return e; };
setResolver({
  async resolveNs(h) { if (dns.ns[h]) return dns.ns[h]; throw empty(); },
  async resolveCname(h) { if (dns.cname[h]) return dns.cname[h]; throw empty(); },
  async resolve4(h) { if (dns.a[h]) return dns.a[h]; throw empty(); },
  async resolve6() { throw empty(); },
});

// ── Mock Render ─────────────────────────────────────────────────────────────
const renderDomains = new Map([
  ['shop.glowbrand-demo.com', { id: 'cdm-glow', name: 'shop.glowbrand-demo.com', verificationStatus: 'verified' }],
  ['lushlift-demo.com', { id: 'cdm-lush', name: 'lushlift-demo.com', verificationStatus: 'unverified' }],
]);
const renderApp = express();
renderApp.use(express.json());
renderApp.get('/v1/services/:sid/custom-domains', (_req, res) =>
  res.json([...renderDomains.values()].map((d) => ({ customDomain: d }))));
renderApp.post('/v1/services/:sid/custom-domains', (req, res) => {
  const name = String(req.body.name).toLowerCase();
  const obj = { id: 'cdm-' + name.replace(/\W/g, '').slice(0, 8), name, verificationStatus: 'unverified' };
  renderDomains.set(name, obj);
  res.status(201).json({ customDomain: obj });
});
renderApp.get('/v1/services/:sid/custom-domains/:id', (req, res) => {
  const hit = [...renderDomains.values()].find((d) => d.id === req.params.id || d.name === req.params.id);
  return hit ? res.json({ customDomain: hit }) : res.status(404).json({ message: 'not found' });
});
renderApp.delete('/v1/services/:sid/custom-domains/:id', (req, res) => {
  const hit = [...renderDomains.values()].find((d) => d.id === req.params.id || d.name === req.params.id);
  if (hit) renderDomains.delete(hit.name);
  res.status(204).end();
});

// ── Mock Namecheap ──────────────────────────────────────────────────────────
const owned = new Set(['glowbrand-demo.com', 'lushlift-demo.com', 'puurehair-demo.com']);
const ncApp = express();
ncApp.use(express.urlencoded({ extended: false }));
ncApp.post('/xml.response', (req, res) => {
  const p = req.body;
  res.type('application/xml');
  if (p.Command === 'namecheap.domains.check') {
    const rows = String(p.DomainList).split(',').map((d) => {
      const dom = d.trim().toLowerCase();
      const available = !owned.has(dom) && !/^(glow|taken)/.test(dom);
      return `<DomainCheckResult Domain="${dom}" Available="${available}" ErrorNo="0" IsPremiumName="false" PremiumRegistrationPrice="0"/>`;
    }).join('');
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>${rows}</CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.users.getPricing') {
    const prods = ['com|10.28', 'net|12.98', 'org|11.48', 'io|32.98', 'co|27.98', 'shop|3.98', 'store|4.98', 'online|2.98', 'xyz|2.18', 'site|2.98']
      .map((s) => { const [t, pr] = s.split('|'); return `<Product Name="${t}"><Price Duration="1" Price="${pr}" YourPrice="${pr}" Currency="USD"/></Product>`; }).join('');
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register">${prods}</ProductCategory></ProductType></UserGetPricingResult></CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.domains.create') {
    const dom = String(p.DomainName).toLowerCase();
    owned.add(dom);
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainCreateResult Domain="${dom}" Registered="true" ChargedAmount="10.87" DomainID="9007" OrderID="1234321"/></CommandResponse></ApiResponse>`);
  }
  if (p.Command === 'namecheap.domains.getList') {
    const rows = [...owned].map((d, i) => `<Domain ID="${i}" Name="${d}" Created="02/14/2026" Expires="02/14/2027" IsExpired="false" IsLocked="false" AutoRenew="true"/>`).join('');
    return res.send(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainGetListResult>${rows}</DomainGetListResult></CommandResponse></ApiResponse>`);
  }
  res.send(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="0">Unknown</Error></Errors></ApiResponse>`);
});

// ── Mock Cloudflare ─────────────────────────────────────────────────────────
const cfApp = express();
cfApp.use(express.json());
cfApp.get('/client/v4/zones', (req, res) =>
  res.json({ success: true, result: String(req.query.name).includes('lushlift') ? [{ id: 'z1', name: req.query.name }] : [] }));
cfApp.get('/client/v4/zones/:z/dns_records', (_req, res) => res.json({ success: true, result: [] }));
cfApp.post('/client/v4/zones/:z/dns_records', (req, res) => res.json({ success: true, result: { id: 'r1', ...req.body } }));

// ── DB fixtures ─────────────────────────────────────────────────────────────
await pgQuery(`DROP TABLE IF EXISTS lb_domains, domain_events, domain_whois_contact CASCADE`);
await pgQuery(`DROP TABLE IF EXISTS user_roles, roles, users, funnels CASCADE`);
await pgQuery(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE, is_active BOOLEAN DEFAULT TRUE)`);
await pgQuery(`CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`);
await pgQuery(`CREATE TABLE user_roles (user_id TEXT, role_id TEXT)`);
await pgQuery(`CREATE TABLE funnels (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE)`);
await pgQuery(`INSERT INTO users (id, email, first_name, last_name) VALUES ('u-test', 'admin@trypuure.co', 'Ludo', 'Operator')`);
await pgQuery(`INSERT INTO roles (id, name, permissions) VALUES ('r-test', 'Operator', '{"*": ["*"]}')`);
await pgQuery(`INSERT INTO user_roles VALUES ('u-test', 'r-test')`);
await pgQuery(`INSERT INTO funnels (id, slug, name, status) VALUES
  ('f1', 'glow-serum', 'Glow Serum funnel', 'published'),
  ('f2', 'breast-lift', 'Breast Lift funnel', 'published'),
  ('f3', 'hair-oil', 'Hair Oil funnel', 'draft')`);

const { ensureDomainTables } = await import('./server/src/services/domainHub/schema.js');
await ensureDomainTables();
await pgQuery(`INSERT INTO lb_domains (id, domain, funnel_id, status, verification_token, dns_provider, render_domain_id, verify_attempts, last_check, error_detail) VALUES
  ('dom-1', 'shop.glowbrand-demo.com', 'f1', 'connected', 'puure-verify-demo1', 'namecheap', 'cdm-glow', 0, NOW(), NULL),
  ('dom-2', 'lushlift-demo.com', 'f2', 'verifying', 'puure-verify-demo2', 'cloudflare', 'cdm-lush', 3, NOW() - interval '40 seconds', NULL),
  ('dom-3', 'try.brandsite-demo.com', 'f3', 'pending_dns', 'puure-verify-demo3', 'godaddy', NULL, 6, NOW() - interval '55 seconds', NULL),
  ('dom-4', 'oldshop-demo.net', 'f1', 'error', 'puure-verify-demo4', NULL, NULL, 240, NOW() - interval '2 hours', 'dns_never_pointed: retries exhausted — check the records, then Verify now')`);
await pgQuery(`INSERT INTO domain_whois_contact (id, contact) VALUES ('default',
  '{"first_name":"Ludo","last_name":"Operator","email":"admin@trypuure.co","phone":"+1.5551234567","address1":"1 Puure Way","city":"Miami","state_province":"FL","postal_code":"33101","country":"US"}')`);

// ── Demo app: stub auth + REAL domain-hub routes ────────────────────────────
const app = express();
app.use(express.json());
const demoUser = {
  id: 'u-test', email: 'admin@trypuure.co', firstName: 'Ludo', lastName: 'Operator',
  roles: [{ id: 'r-test', name: 'Operator', permissions: { '*': ['*'] } }],
  mustChangePassword: false, emailVerified: true,
};
const mint = () => signAccessToken({ userId: 'u-test', email: demoUser.email }, '4h');
app.post('/api/v1/auth/login', (_req, res) => res.json({ accessToken: mint(), user: demoUser }));
app.post('/api/v1/auth/refresh', (_req, res) => res.json({ accessToken: mint(), user: demoUser }));
app.get('/api/v1/auth/me', (_req, res) => res.json({ user: demoUser }));
app.post('/api/v1/auth/logout', (_req, res) => res.json({ ok: true }));
app.get('/api/v1/funnels', async (_req, res) => {
  const funnels = await pgQuery(`SELECT id, slug, name, status FROM funnels WHERE archived = FALSE ORDER BY name`);
  res.json({ data: { funnels } });
});
app.use('/api/v1/domain-hub', domainHubRoutes);

renderApp.listen(4126, '127.0.0.1');
ncApp.listen(4127, '127.0.0.1');
cfApp.listen(4128, '127.0.0.1');
app.listen(4026, '127.0.0.1', () => console.log('[demo] domain-hub demo backend on http://127.0.0.1:4026'));
