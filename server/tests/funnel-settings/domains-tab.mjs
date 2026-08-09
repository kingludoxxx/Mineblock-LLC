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
// conflict; invalid-domain refusal; registrar/status render_target_host;
// reassign ("Reuse here") happy path + refusals + concurrency race (exactly
// one 409) + stale-from_funnel_id guard; the 24h verify backoff schedule
// (math + the sweep-path deferral gate); sweep SQL due-ness (deferred rows
// never consume batch slots); the UNIVERSAL budget on pointing-but-never-
// Render-verified rows (via an injected DNS resolver + a local Render API
// stub that registers but never verifies).
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
  await sql`DELETE FROM lb_domains WHERE domain IN (${SUB}, ${APEX})
            OR domain LIKE 'sweep%.puure-domains-harness.dev'
            OR domain = 'pointing.puure-domains-harness.dev'`;
  await sql`DELETE FROM domain_events WHERE domain IN (${SUB}, ${APEX})
            OR domain LIKE 'sweep%.puure-domains-harness.dev'
            OR domain = 'pointing.puure-domains-harness.dev'`.catch(() => {});
  await sql`DELETE FROM funnels WHERE slug IN ('dom-harness-a', 'dom-harness-b', 'dom-harness-c')`;
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

// ── registrar/status carries the Render target host (Domains-tab banner) ────
{
  const r = await req('GET', '/domain-hub/registrar/status');
  const d = r.j?.data;
  check('registrar/status → render_target_host present',
    r.status === 200 && typeof d?.render_target_host === 'string' && d.render_target_host.length > 0,
    JSON.stringify(d));
  check('registrar/status → config flags still present',
    typeof d?.render_configured === 'boolean' && typeof d?.cloudflare_dns_configured === 'boolean');
}

// ── verify now ──────────────────────────────────────────────────────────────
{
  const r = await req('POST', `/domain-hub/${SUB}/verify`);
  const row = r.j?.data;
  check('verify → 200 row, still pending_dns, attempt counted', r.status === 200 && row?.status === 'pending_dns' && row?.verify_attempts >= 1, JSON.stringify({ s: row?.status, a: row?.verify_attempts }));
}

// ── backoff schedule (24h budget) ───────────────────────────────────────────
{
  const svc = await import('../../src/services/domainHub/attachService.js');
  const total = Array.from({ length: svc.MAX_VERIFY_ATTEMPTS }, (_, i) => svc.verifyDelayMs(i))
    .reduce((a, b) => a + b, 0);
  check('backoff: schedule totals exactly 24h', total === 24 * 60 * 60 * 1000, `total=${total}ms over ${svc.MAX_VERIFY_ATTEMPTS} attempts`);
  check('backoff: fast phase is 60s per attempt for the first hour',
    svc.verifyDelayMs(0) === 60_000 && svc.verifyDelayMs(svc.FAST_VERIFY_ATTEMPTS - 1) === 60_000);
  check('backoff: slow phase is 5min per attempt after the first hour',
    svc.verifyDelayMs(svc.FAST_VERIFY_ATTEMPTS) === 300_000 && svc.verifyDelayMs(svc.MAX_VERIFY_ATTEMPTS - 1) === 300_000);
  // Sweep-path deferral gate BY EXECUTION: the row was verified seconds ago,
  // so a sweep-style call (no resetAttempts) must defer without re-checking.
  const before = await sql`SELECT verify_attempts FROM lb_domains WHERE domain = ${SUB}`;
  const defRes = await svc.verifyDomain(SUB);
  const after = await sql`SELECT verify_attempts FROM lb_domains WHERE domain = ${SUB}`;
  check('backoff: sweep-path verify DEFERS a freshly-checked row',
    defRes.ok === true && defRes.deferred === true, JSON.stringify({ ok: defRes.ok, deferred: defRes.deferred }));
  check('backoff: deferred call did NOT consume an attempt',
    before[0].verify_attempts === after[0].verify_attempts,
    `${before[0].verify_attempts} → ${after[0].verify_attempts}`);
  // Manual verify-now still always runs (resetAttempts path skips the gate).
  const manual = await req('POST', `/domain-hub/${SUB}/verify`);
  check('backoff: manual verify-now still runs (never deferred)',
    manual.status === 200 && manual.j?.data?.verify_attempts >= 1, JSON.stringify(manual.j?.data?.verify_attempts));
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
  await req('PATCH', `/funnels/${fA.id}`, { custom_domain: SUB }); // re-set for the reassign + detach checks
}

// ── reassign ("Reuse here") ─────────────────────────────────────────────────
// refusals first — none of these may move the row or touch the pointer
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { funnel_id: fB.id });
  check('reassign without confirm → 400 confirm_required', r.status === 400 && r.j?.error === 'confirm_required', JSON.stringify(r.j));
}
{
  const r = await req('POST', `/domain-hub/never-attached.puure-domains-harness.dev/reassign`, { funnel_id: fB.id, confirm: true });
  check('reassign unknown domain → 404', r.status === 404 && r.j?.error === 'domain_not_found', JSON.stringify(r.j));
}
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { funnel_id: fA.id, confirm: true });
  check('reassign to the SAME funnel → 400 no-op refusal', r.status === 400 && r.j?.error === 'domain_already_on_this_funnel', JSON.stringify(r.j));
}
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { confirm: true });
  check('reassign without funnel_id → 400', r.status === 400 && r.j?.error === 'funnel_id_required', JSON.stringify(r.j));
}
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { funnel_id: 'fnl_does_not_exist', confirm: true });
  check('reassign to unknown funnel → 404 funnel_not_found', r.status === 404 && r.j?.error === 'funnel_not_found', JSON.stringify(r.j));
}
{
  const still = await sql`SELECT funnel_id FROM lb_domains WHERE domain = ${SUB}`;
  const fa = await req('GET', `/funnels/${fA.id}`);
  check('reassign refusals: row untouched + A still primary',
    still[0]?.funnel_id === fA.id && fa.j?.data?.funnel?.custom_domain === SUB,
    JSON.stringify({ funnel_id: still[0]?.funnel_id, cd: fa.j?.data?.funnel?.custom_domain }));
}
// happy path — B steals SUB from A; A's dangling primary pointer is cleared
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { funnel_id: fB.id, confirm: true });
  check('reassign happy path → 200 + row now on funnel B', r.status === 200 && r.j?.data?.funnel_id === fB.id, JSON.stringify(r.j));
  const fa = await req('GET', `/funnels/${fA.id}`);
  check("reassign: A's custom_domain pointer CLEARED", fa.j?.data?.funnel?.custom_domain === null, JSON.stringify(fa.j?.data?.funnel?.custom_domain));
  const listB = await req('GET', `/domain-hub/list?funnel_id=${fB.id}`);
  check('reassign: list for B now contains the domain',
    (listB.j?.data || []).some((x) => x.domain === SUB), JSON.stringify((listB.j?.data || []).map((x) => x.domain)));
  const n = await sql`SELECT COUNT(*)::int AS n FROM lb_domains WHERE domain = ${SUB}`;
  check('reassign: still exactly one row', n[0].n === 1);
}
// move it back and restore A's primary so the detach block below is unchanged
{
  const r = await req('POST', `/domain-hub/${SUB}/reassign`, { funnel_id: fA.id, confirm: true });
  check('reassign back to A → 200', r.status === 200 && r.j?.data?.funnel_id === fA.id, JSON.stringify(r.j));
  const p = await req('PATCH', `/funnels/${fA.id}`, { custom_domain: SUB });
  check('reassign: A primary re-set for the detach checks', p.status === 200 && p.j?.data?.custom_domain === SUB);
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

// ── reassign concurrency race + stale-from_funnel_id guard ──────────────────
const fC = (await req('POST', '/funnels', { name: 'Dom Harness C', slug: 'dom-harness-c' })).j?.data;
{
  const svc = await import('../../src/services/domainHub/attachService.js');
  // Re-attach SUB (detached above) to A and make it A's primary again.
  await req('POST', '/domain-hub/attach', { domain: SUB, funnel_id: fA.id, auto_dns: false });
  await req('PATCH', `/funnels/${fA.id}`, { custom_domain: SUB });
  // Two concurrent service-level reassigns of the SAME domain to DIFFERENT
  // targets, both anchored on A: the transactional WHERE serializes them —
  // exactly one wins, the other gets 0 rows → 409, never a chained move.
  const [r1, r2] = await Promise.all([
    svc.reassignDomain(SUB, { funnelId: fB.id, fromFunnelId: fA.id, confirm: true }),
    svc.reassignDomain(SUB, { funnelId: fC.id, fromFunnelId: fA.id, confirm: true }),
  ]);
  const oks = [r1, r2].filter((r) => r.ok);
  const conflicts = [r1, r2].filter((r) => !r.ok && r.status === 409 && r.error === 'reassign_conflict');
  check('race: exactly one winner + exactly one 409 reassign_conflict',
    oks.length === 1 && conflicts.length === 1,
    JSON.stringify([r1, r2].map((r) => ({ ok: r.ok, e: r.error }))));
  const winnerTarget = oks[0]?.row?.funnel_id;
  const rowsNow = await sql`SELECT funnel_id FROM lb_domains WHERE domain = ${SUB}`;
  check("race: one row, on the winner's funnel",
    rowsNow.length === 1 && rowsNow[0].funnel_id === winnerTarget, JSON.stringify(rowsNow));
  const fa = await req('GET', `/funnels/${fA.id}`);
  check("race: A's custom_domain pointer cleared", fa.j?.data?.funnel?.custom_domain === null);
  const loserTarget = winnerTarget === fB.id ? fC.id : fB.id;
  const loser = await req('GET', `/funnels/${loserTarget}`);
  check("race: losing target funnel's pointer untouched", loser.j?.data?.funnel?.custom_domain === null);
  // Stale from_funnel_id through the REAL router — claim the row still lives
  // on the loser target: deterministic 409, row untouched.
  const stale = await req('POST', `/domain-hub/${SUB}/reassign`,
    { funnel_id: fA.id, from_funnel_id: loserTarget, confirm: true });
  check('stale from_funnel_id via router → 409 reassign_conflict',
    stale.status === 409 && stale.j?.error === 'reassign_conflict', JSON.stringify(stale.j));
  const still = await sql`SELECT funnel_id FROM lb_domains WHERE domain = ${SUB}`;
  check('stale guard: row untouched', still[0]?.funnel_id === winnerTarget, JSON.stringify(still));
  const good = await req('POST', `/domain-hub/${SUB}/reassign`,
    { funnel_id: fA.id, from_funnel_id: winnerTarget, confirm: true });
  check('correct from_funnel_id via router → 200, row back on A',
    good.status === 200 && good.j?.data?.funnel_id === fA.id, JSON.stringify(good.j));
  const bad = await req('POST', `/domain-hub/${SUB}/reassign`,
    { funnel_id: fB.id, from_funnel_id: 42, confirm: true });
  check('non-string from_funnel_id → 400', bad.status === 400 && bad.j?.error === 'from_funnel_id_invalid', JSON.stringify(bad.j));
}

// ── sweep due-ness: deferred rows must not consume batch slots ──────────────
{
  const { sweepOnce } = await import('../../src/services/domainHub/verifySweep.js');
  const mk = (i) => `sweep${i}.puure-domains-harness.dev`;
  await sql`DELETE FROM lb_domains WHERE domain LIKE 'sweep%.puure-domains-harness.dev'`;
  // 30 slow-phase rows (attempts ≥ 60) checked JUST NOW → none due; more than
  // the sweep's LIMIT 25, so a due-ness-blind query would starve the fast row.
  for (let i = 0; i < 30; i++) {
    await sql`INSERT INTO lb_domains (id, domain, funnel_id, verification_token, status, verify_attempts, last_check)
      VALUES (${'dom_sweep' + i}, ${mk(i)}, ${fA.id}, ${'tok' + i}, 'pending_dns', 100, NOW())`;
  }
  // 1 fast-phase row overdue by 2 minutes → MUST be processed this tick.
  await sql`INSERT INTO lb_domains (id, domain, funnel_id, verification_token, status, verify_attempts, last_check)
    VALUES ('dom_sweepfast', 'sweepfast.puure-domains-harness.dev', ${fA.id}, 'tokfast', 'pending_dns', 1, NOW() - interval '2 minutes')`;
  const stats = await sweepOnce();
  check('sweep: only the DUE fast row fetched/processed (not-due rows never occupy slots)',
    stats.checked === 1 && stats.deferred === 0, JSON.stringify(stats));
  const fastRow = await sql`SELECT verify_attempts, status FROM lb_domains WHERE domain = 'sweepfast.puure-domains-harness.dev'`;
  check('sweep: due fast row consumed an attempt', fastRow[0]?.verify_attempts === 2 && fastRow[0]?.status === 'pending_dns', JSON.stringify(fastRow));
  const slow0 = await sql`SELECT verify_attempts FROM lb_domains WHERE domain = ${mk(0)}`;
  check('sweep: not-due slow rows untouched', slow0[0]?.verify_attempts === 100, JSON.stringify(slow0));
  await sql`DELETE FROM lb_domains WHERE domain LIKE 'sweep%.puure-domains-harness.dev'`;
  await sql`DELETE FROM domain_events WHERE domain LIKE 'sweep%.puure-domains-harness.dev'`;
}

// ── universal 24h budget: pointing but never Render-verified ────────────────
{
  const svc = await import('../../src/services/domainHub/attachService.js');
  const dns = await import('../../src/services/domainHub/dnsInspect.js');
  const PT = 'pointing.puure-domains-harness.dev';
  // Local Render API stub: registration succeeds, verification NEVER lands.
  const stub = express();
  stub.use(express.json());
  const stubDomains = [];
  stub.get('/v1/services/:sid/custom-domains', (_q, s) => s.json(stubDomains.map((d) => ({ customDomain: d }))));
  stub.post('/v1/services/:sid/custom-domains', (q, s) => {
    const d = { id: 'cd_stub_1', name: q.body?.name, verificationStatus: 'unverified' };
    stubDomains.push(d);
    s.status(201).json({ customDomain: d });
  });
  stub.get('/v1/services/:sid/custom-domains/:id', (q, s) => {
    const d = stubDomains.find((x) => x.id === q.params.id);
    if (!d) return s.status(404).json({ message: 'not found' });
    s.json({ customDomain: d });
  });
  stub.delete('/v1/services/:sid/custom-domains/:id', (_q, s) => s.status(204).end());
  const stubSrv = stub.listen(0);
  process.env.RENDER_API_BASE = `http://127.0.0.1:${stubSrv.address().port}`;
  process.env.RENDER_API_KEY = 'test-key-stub';
  process.env.RENDER_SERVICE_ID = 'srv-stub';
  // Resolver seam: PT "points" at the service host.
  dns.setResolver({
    resolveNs: async () => ['ns1.cloudflare.com'],
    resolveCname: async () => [dns.renderTargetHost()],
    resolve4: async () => [],
    resolve6: async () => [],
  });
  try {
    const r = await req('POST', '/domain-hub/attach', { domain: PT, funnel_id: fA.id, auto_dns: false });
    const d0 = r.j?.data?.domain;
    check('budget: pointing row lands at verifying with 1 attempt consumed',
      d0?.status === 'verifying' && d0?.verify_attempts === 1, JSON.stringify({ s: d0?.status, a: d0?.verify_attempts }));
    await sql`UPDATE lb_domains SET last_check = NOW() - interval '2 minutes' WHERE domain = ${PT}`;
    const p2 = await svc.verifyDomain(PT);
    check('budget: next pointing pass ADVANCES the counter (no reset to 0)',
      p2.row?.status === 'verifying' && p2.row?.verify_attempts === 2, JSON.stringify({ s: p2.row?.status, a: p2.row?.verify_attempts }));
    await sql`UPDATE lb_domains SET verify_attempts = ${svc.MAX_VERIFY_ATTEMPTS - 1}, last_check = NOW() - interval '10 minutes' WHERE domain = ${PT}`;
    const p3 = await svc.verifyDomain(PT);
    check('budget: exhausted pointing row parks at error with render_never_verified',
      p3.row?.status === 'error' && String(p3.row?.error_detail || '').startsWith('render_never_verified'),
      JSON.stringify({ s: p3.row?.status, e: p3.row?.error_detail }));
    const rv = await req('POST', `/domain-hub/${PT}/verify`);
    check('budget: verify-now revives the parked row (attempts reset, back to verifying)',
      rv.status === 200 && rv.j?.data?.status === 'verifying' && rv.j?.data?.verify_attempts === 1,
      JSON.stringify({ s: rv.j?.data?.status, a: rv.j?.data?.verify_attempts }));
  } finally {
    dns.resetResolver();
    delete process.env.RENDER_API_BASE;
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_SERVICE_ID;
    stubSrv.close();
    await sql`DELETE FROM lb_domains WHERE domain = ${PT}`;
    await sql`DELETE FROM domain_events WHERE domain = ${PT}`;
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await req('DELETE', `/domain-hub/${APEX}`, { confirm: APEX });
await req('DELETE', `/domain-hub/${SUB}`, { confirm: SUB });
await cleanup();
await sql`DELETE FROM user_roles WHERE user_id = 'u_dom_test'`;
await sql`DELETE FROM users WHERE id = 'u_dom_test'`;
await sql`DELETE FROM roles WHERE id = 'r_dom_test'`;
await sql.end();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
