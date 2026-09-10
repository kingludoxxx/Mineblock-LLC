// Acceptance tests for the Render-facing behaviour of scripts/fleet.mjs, driven
// entirely by a mocked fetch: status shaping, deploy polling to a terminal
// state, rollback target selection, and env-diff printing KEY NAMES ONLY.
// Lane B goal 3 (A9 shape, A10 drift). No real Render call happens here.
//
// Run:  node server/tests/fleet/fleet-render.mjs
// test-timeout: 60s
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { main } = await import(path.join(REPO, 'scripts/fleet.mjs'));
const KEY = 'test-not-a-real-render-key-000001';
// Full 40-character lowercase shas: what fleet.mjs accepts (P2-6).
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), F = 'f'.repeat(40);
const SHA = 'edc10309c1f4b7a2e6d80b53f7a91c4e2d6b8f01';
const TYPED = '--i-typed-the-store-name=Puure';

function harness(router) {
  const lines = [];
  const calls = [];
  const deps = {
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const r = await router(String(url), init, calls);
      return {
        ok: (r.status || 200) < 400,
        status: r.status || 200,
        async json() { return r.body; },
        async text() { return JSON.stringify(r.body); },
      };
    },
    readKey: () => KEY,
    log: (s) => lines.push(String(s)),
    sleep: async () => {},
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  };
  return { deps, lines, calls, out: () => lines.join('\n') };
}

const dep = (id, status, commitId, finishedAt) => ({ deploy: { id, status, commit: { id: commitId, message: 'x' }, finishedAt } });

// ── status: one row per service, commit + status + finishedAt ───────────────
{
  const h = harness(async (url) => {
    if (url.includes('/deploys')) {
      const svc = url.match(/services\/(srv-[a-z0-9]+)\//)[1];
      return { body: [dep(`dep-${svc}`, 'live', SHA, '2026-09-10T11:05:00Z')] };
    }
    return { status: 404, body: {} };
  });
  const code = await main(['status'], h.deps);
  const out = h.out();
  ok(code === 0, 'status exits 0', `code=${code}\n${out}`);
  ok(h.calls.length >= 4, `status reads one deploy list per live service (got ${h.calls.length})`, JSON.stringify(h.calls.map((c) => c.url)));
  ok(h.calls.every((c) => c.method === 'GET'), 'status is read-only', JSON.stringify(h.calls.map((c) => c.method)));
  ok(out.includes(SHA.slice(0, 7)), 'status prints the live commit', out);
  ok(/live/.test(out), 'status prints the deploy status', out);
  ok(/2026-09-10/.test(out), 'status prints finishedAt', out);
  ok(!/\bgit\b/i.test(out), 'status reports Render, never git (R11)', out);
  // R11: a service whose latest deploy is still building must not read as live
  const h2 = harness(async () => ({ body: [dep('dep-x', 'build_in_progress', 'aaaaaaa', null)] }));
  await main(['status'], h2.deps);
  ok(/build_in_progress/.test(h2.out()), 'an in-flight deploy is reported as such, not as live', h2.out());
}

// status must survive one service erroring without losing the rest
{
  const h = harness(async (url) => {
    if (url.includes('srv-d9suceks728c738bu320')) return { status: 500, body: { message: 'boom' } };
    return { body: [dep('dep-1', 'live', 'edc1030', '2026-09-10T11:05:00Z')] };
  });
  const code = await main(['status'], h.deps);
  ok(code === 1, 'status exits 1 when a service cannot be read', String(code));
  ok(/500|ERROR/i.test(h.out()), 'the failing service is reported with its status', h.out());
  ok((h.out().match(/edc1030/g) || []).length >= 3, 'the healthy services are still reported', h.out());
}

// ── deploy: POST body, then poll to a terminal state ───────────────────────
{
  let polls = 0;
  const h = harness(async (url, init) => {
    if (init.method === 'POST' && url.includes('/deploys')) {
      return { status: 201, body: { id: 'dep-new', status: 'build_in_progress', commit: { id: SHA } } };
    }
    if (url.includes('/deploys/dep-new')) {
      polls += 1;
      return { body: polls < 3
        ? { id: 'dep-new', status: 'build_in_progress', commit: { id: SHA } }
        : { id: 'dep-new', status: 'live', commit: { id: SHA }, finishedAt: '2026-09-10T12:04:00Z' } };
    }
    if (url.includes('/deploys')) return { body: [dep('dep-anchor', 'live', C, '2026-09-10T10:00:00Z')] };
    if (url.includes('/api/health')) return { body: { status: 'ok' } };
    return { status: 404, body: {} };
  });
  const code = await main(['deploy', 'mineblock-dashboard', '--commit', SHA], h.deps);
  const out = h.out();
  ok(code === 0, 'a deploy that reaches live exits 0', `code=${code}\n${out}`);
  const post = h.calls.find((c) => c.method === 'POST');
  ok(!!post, 'a POST was issued', JSON.stringify(h.calls));
  ok(post && post.body.commitId === SHA, 'the POST carries commitId (R37)', JSON.stringify(post && post.body));
  ok(post && post.body.clearCache === 'do_not_clear', 'the POST carries clearCache=do_not_clear', JSON.stringify(post && post.body));
  ok(polls >= 3, `the deploy is polled until terminal (${polls} polls)`, out);
  ok(/live/.test(out), 'the terminal state is printed', out);
  ok(/health/i.test(out), 'the health check result is printed', out);
}

// a failed build is exit 1, and polling stops at the terminal state
{
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'dep-bad', status: 'build_in_progress' } };
    if (url.includes('/deploys/dep-bad')) return { body: { id: 'dep-bad', status: 'build_failed', commit: { id: SHA } } };
    if (url.includes('/deploys')) return { body: [dep('dep-anchor', 'live', C, '2026-09-10T10:00:00Z')] };
    return { status: 404, body: {} };
  });
  const code = await main(['deploy', 'mineblock-dashboard', '--commit', SHA], h.deps);
  ok(code === 1, 'a build_failed deploy exits 1', `code=${code}\n${h.out()}`);
  ok(/build_failed/.test(h.out()), 'the failure state is named', h.out());
}

// ── rollback: previous live/deactivated deploy whose commit differs ─────────
{
  const list = [
    dep('d5', 'live', C, '2026-09-10T11:00:00Z'),
    dep('d4', 'build_failed', D, '2026-09-10T10:00:00Z'),
    dep('d3', 'live', C, '2026-09-10T09:00:00Z'),   // same commit: not a rollback target
    dep('d2', 'deactivated', B, '2026-09-09T09:00:00Z'), // <- the target
    dep('d1', 'live', A, '2026-09-08T09:00:00Z'),
  ];
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'dep-rb', status: 'build_in_progress' } };
    if (url.includes('/deploys/dep-rb')) return { body: { id: 'dep-rb', status: 'live', commit: { id: B }, finishedAt: '2026-09-10T12:05:00Z' } };
    if (url.includes('/deploys')) return { body: list };
    if (url.includes('/api/health')) return { body: { status: 'ok' } };
    return { status: 404, body: {} };
  });
  const code = await main(['rollback', 'puure-dashboard', TYPED], h.deps);
  ok(code === 0, 'rollback exits 0', `code=${code}\n${h.out()}`);
  const post = h.calls.find((c) => c.method === 'POST');
  ok(post && post.body.commitId === B,
    'rollback picks the newest live/deactivated deploy whose commit differs from the current one',
    JSON.stringify(post && post.body));
  ok(!JSON.stringify(post && post.body).includes(D), 'a failed build is never a rollback target', JSON.stringify(post && post.body));
}

// nothing to roll back to is a refusal, not a no-op deploy
{
  const h = harness(async (url) => {
    if (url.includes('/deploys')) return { body: [dep('d1', 'live', A, '2026-09-10T11:00:00Z')] };
    return { status: 404, body: {} };
  });
  const code = await main(['rollback', 'puure-dashboard', TYPED], h.deps);
  ok(code === 1, 'rollback with no distinct earlier deploy exits 1', `code=${code}\n${h.out()}`);
  ok(h.calls.every((c) => c.method === 'GET'), 'that refusal issues no POST', JSON.stringify(h.calls.map((c) => c.method)));
}

// ── env-diff: KEY NAMES ONLY, both directions, never a value ───────────────
{
  const A = { 'srv-d9r4elcs728c73d01gug': ['DATABASE_URL', 'CHECKOUT_CREDS_KEY', 'PUURE_SHOPIFY_TOKEN', 'NODE_ENV'] };
  const B = { 'srv-d6qavvf5gffc73em69n0': ['DATABASE_URL', 'JWT_SECRET', 'SHOPIFY_ACCESS_TOKEN', 'NODE_ENV'] };
  const SECRET_VALUE = 'shpat_THIS_MUST_NEVER_BE_PRINTED';
  const h = harness(async (url) => {
    const svc = url.match(/services\/(srv-[a-z0-9]+)\//)[1];
    const keys = A[svc] || B[svc] || [];
    return { body: keys.map((k) => ({ envVar: { key: k, value: SECRET_VALUE } })) };
  });
  const code = await main(['env-diff', 'puure-dashboard', 'mineblock-dashboard'], h.deps);
  const out = h.out();
  ok(code === 0, 'env-diff exits 0', `code=${code}\n${out}`);
  ok(!out.includes(SECRET_VALUE), 'env-diff NEVER prints a value', out);
  ok(!out.includes(KEY), 'env-diff never prints the API key', out);
  ok(/CHECKOUT_CREDS_KEY/.test(out) && /PUURE_SHOPIFY_TOKEN/.test(out), 'keys only on the first service are listed', out);
  ok(/JWT_SECRET/.test(out) && /SHOPIFY_ACCESS_TOKEN/.test(out), 'keys only on the second service are listed', out);
  ok(!/^\s*DATABASE_URL\s*$/m.test(out.replace(/.*both.*/i, '')) || /both/i.test(out),
    'shared keys are not listed as drift', out);
  ok(/2\b/.test(out), 'the drift is counted', out);
}


// ── A10: the documented dashboard drift, reproduced by env-diff ────────────
// The real /env-vars read is out of bounds for this lane (the brief allows ONE
// real Render call, and it is `status`). So the fixture IS the inventory:
// ~/tasks/multistore-hub/discovery/env-inventory.md section 3.1, transcribed
// verbatim. If env-diff computes the documented drift from the documented
// inputs, the arithmetic is right; only the freshness of the inputs is open,
// and that caveat is recorded in the proof pack.
{
  const ONLY_MD = ['BRAND_SPY_DEPLOY', 'CLICKUP_MB_AVATARS_LIST_ID', 'CLICKUP_MB_CREATORS_LIST_ID',
    'CLICKUP_MB_MEDIA_BUYING_LIST_ID', 'CLICKUP_MB_PRODUCTS_LIST_ID', 'CLICKUP_MB_STATIC_LIST_ID',
    'CORS_ORIGIN', 'DEPLOY_NONCE', 'DEPLOY_TRIGGER', 'FRAMEIO_MB_EDITING_FOLDER', 'FRAMEIO_MB_PROJECT_ID',
    'FRAMEIO_MB_STATIC_EDITING_FOLDER', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_SECRET', 'PORT',
    'PUURE_DATABASE_URL', 'RENDER_EXTERNAL_URL', 'SELLERBOARD_FEED_URL', 'SHOPIFY_ACCESS_TOKEN',
    'SHOPIFY_WEBHOOK_SECRET', 'STATICS_TEXT_OVERLAY', 'SUPPLIER_SHARE_TOKEN', 'VITE_CRM_ORIGIN'];
  const ONLY_PD = ['CHECKOUT_BASE_CURRENCY', 'CHECKOUT_CREDS_KEY', 'HIGGSFIELD_API_SECRET', 'PUBLIC_APP_URL',
    'PUURE_SHOPIFY_STORE', 'PUURE_SHOPIFY_TOKEN', 'WHOP_WEBHOOK_SECRET'];
  const BOTH = ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'NODE_ENV', 'OPENAI_API_KEY', 'SSO_SHARED_SECRET'];
  const PD_ID = 'srv-d9r4elcs728c73d01gug';

  const h = harness(async (url) => {
    const svc = url.match(/services\/(srv-[a-z0-9]+)\//)[1];
    const keys = svc === PD_ID ? [...ONLY_PD, ...BOTH] : [...ONLY_MD, ...BOTH];
    return { body: keys.map((k) => ({ envVar: { key: k, value: 'never-printed' } })) };
  });
  const code = await main(['env-diff', 'puure-dashboard', 'mineblock-dashboard'], h.deps);
  const out = h.out();
  ok(code === 0, 'A10 env-diff over the inventory exits 0', `code=${code}\n${out}`);
  ok(/asymmetric keys: 31/.test(out), 'A10 reports 31 asymmetric keys (24 only-M-D + 7 only-P-D)', out);
  ok(/only on puure-dashboard \(7\)/.test(out), 'A10 seven keys only on puure-dashboard', out);
  ok(/only on mineblock-dashboard \(24\)/.test(out), 'A10 twenty-four keys only on mineblock-dashboard', out);
  const missing = [...ONLY_MD, ...ONLY_PD].filter((k) => !out.includes(k));
  ok(missing.length === 0, 'A10 every asymmetric key from the inventory is named', JSON.stringify(missing));
  ok(!out.includes('never-printed'), 'A10 no value is printed', out);
  ok(/shared: 5/.test(out), 'A10 shared keys are counted, not listed as drift', out);
}


// ── P1-2: rollback anchors on the LIVE deploy, never on list[0] ─────────────
// The post-incident shape: a build failed, so the NEWEST deploy record is that
// failure and the deploy actually serving traffic sits behind it. Keying on
// list[0] then picks the commit that is already live and reports a no-op as a
// rollback, at the exact moment someone needs a real one.
for (const newestStatus of ['build_failed', 'build_in_progress', 'canceled', 'update_failed']) {
  const list = [
    dep('d9', newestStatus, F, null),                          // newest, NOT live
    dep('d8', 'live', C, '2026-09-10T09:00:00Z'),              // <- what is running
    dep('d7', 'deactivated', B, '2026-09-09T09:00:00Z'),       // <- the rollback target
    dep('d6', 'live', A, '2026-09-08T09:00:00Z'),
  ];
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'rb', status: 'build_in_progress' } };
    if (url.includes('/deploys/rb')) return { body: { id: 'rb', status: 'live', commit: { id: B }, finishedAt: '2026-09-10T12:05:00Z' } };
    if (url.includes('/deploys')) return { body: list };
    if (url.includes('/api/health')) return { body: { status: 'ok' } };
    return { status: 404, body: {} };
  });
  const code = await main(['rollback', 'mineblock-dashboard'], h.deps);
  const post = h.calls.find((c) => c.method === 'POST');
  ok(code === 0, `P1-2 rollback past a ${newestStatus} newest record exits 0`, `code=${code}\n${h.out()}`);
  ok(post && post.body.commitId === B,
    `P1-2 with newest=${newestStatus} the target is the deploy BEFORE the live one, not the live one`,
    JSON.stringify(post && post.body));
  ok(!(post && post.body.commitId === C), `P1-2 with newest=${newestStatus} it never redeploys the commit already running`, JSON.stringify(post && post.body));
  ok(/live/.test(h.out()) && h.out().includes('d8'), `P1-2 the live deploy is named as current (newest=${newestStatus})`, h.out());
  ok(h.out().includes(F.slice(0, 7)), `P1-2 the non-live newer record is disclosed, not hidden (newest=${newestStatus})`, h.out());
}

// no live record at all: refuse, do not guess
{
  const list = [dep('d9', 'build_failed', F, null), dep('d8', 'canceled', C, null)];
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'rb', status: 'live' } };
    if (url.includes('/deploys')) return { body: list };
    return { status: 404, body: {} };
  });
  const code = await main(['rollback', 'mineblock-dashboard'], h.deps);
  ok(code === 1, 'P1-2 no deploy in status live is a refusal', `code=${code}\n${h.out()}`);
  ok(h.calls.every((c) => c.method === 'GET'), 'P1-2 that refusal issues no POST', JSON.stringify(h.calls.map((c) => c.method)));
  ok(/no deploy record in status live/.test(h.out()), 'P1-2 the refusal says what is missing', h.out());
}

// ── P1-3: the Render key reaches the Render API and nothing else ────────────
// `url` is DATA in fleet.services.json. An edited entry, a compromised app or an
// access log on the dashboard's proxy must not be able to collect the platform
// credential. The health check is unauthenticated by construction.
{
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'dep-new', status: 'live', commit: { id: SHA } } };
    if (url.includes('/deploys/dep-new')) return { body: { id: 'dep-new', status: 'live', commit: { id: SHA }, finishedAt: 'x' } };
    if (url.includes('/deploys')) return { body: [dep('dep-anchor', 'live', C, '2026-09-10T10:00:00Z')] };
    if (url.includes('/api/health')) return { body: { status: 'ok' } };
    return { status: 404, body: {} };
  });
  // the harness above does not record headers, so re-wrap the fetch it built
  const seen = [];
  const inner = h.deps.fetch;
  h.deps.fetch = async (url, init = {}) => { seen.push({ url: String(url), auth: (init.headers || {}).Authorization || null, signal: !!init.signal }); return inner(url, init); };

  const code = await main(['deploy', 'mineblock-dashboard', '--commit', SHA], h.deps);
  ok(code === 0, 'P1-3 the deploy completes', `code=${code}\n${h.out()}`);
  const api = seen.filter((r) => r.url.startsWith('https://api.render.com/v1'));
  const offApi = seen.filter((r) => !r.url.startsWith('https://api.render.com/v1'));
  ok(api.length > 0, 'P1-3 requests were made to the Render API', JSON.stringify(seen.map((r) => r.url)));
  ok(offApi.length > 0, 'P1-3 and at least one request went to an app host (the health check)', JSON.stringify(seen.map((r) => r.url)));
  ok(api.every((r) => r.auth === `Bearer ${KEY}`), 'P1-3 every Render API request carries the key', JSON.stringify(api.map((r) => r.url)));
  ok(offApi.every((r) => r.auth === null), 'P1-3 NO request outside the Render API carries an Authorization header',
    JSON.stringify(offApi.map((r) => ({ url: r.url, auth: r.auth }))));
  ok(seen.every((r) => !r.url.includes(KEY)), 'P1-3 the key is never in a URL', JSON.stringify(seen.map((r) => r.url)));

  // P2-3: and every request is bounded by a timeout signal
  ok(seen.filter((r) => r.url.startsWith('https://api.render.com/v1')).every((r) => r.signal),
    'P2-3 every Render API request carries an AbortSignal timeout', JSON.stringify(seen.map((r) => ({ url: r.url, signal: r.signal }))));
  ok(offApi.every((r) => r.signal), 'P2-3 the health check is bounded by a timeout too', JSON.stringify(offApi));
}

// a service whose url has been tampered with still gets no credential
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const cfg = JSON.parse(readFileSync(path.join(REPO, 'scripts/fleet.services.json'), 'utf8'));
  for (const svc of cfg.services) if (svc.url) svc.url = 'https://attacker.example.com';
  const dir = mkdtempSync(path.join(tmpdir(), 'laneb-cfg-'));
  const file = path.join(dir, 'fleet.services.json');
  writeFileSync(file, JSON.stringify(cfg));

  const seen = [];
  const h = harness(async (url, init) => {
    if (init.method === 'POST') return { status: 201, body: { id: 'dep-new', status: 'live', commit: { id: SHA } } };
    if (url.includes('/deploys/dep-new')) return { body: { id: 'dep-new', status: 'live', commit: { id: SHA }, finishedAt: 'x' } };
    if (url.includes('/deploys')) return { body: [dep('dep-anchor', 'live', C, '2026-09-10T10:00:00Z')] };
    return { body: { status: 'ok' } };
  });
  const inner = h.deps.fetch;
  h.deps.fetch = async (url, init = {}) => { seen.push({ url: String(url), auth: (init.headers || {}).Authorization || null }); return inner(url, init); };
  h.deps.servicesPath = file;

  await main(['deploy', 'mineblock-dashboard', '--commit', SHA], h.deps);
  const hostile = seen.filter((r) => r.url.includes('attacker.example.com'));
  ok(hostile.length > 0, 'P1-3 the tampered host was contacted (the health check)', JSON.stringify(seen.map((r) => r.url)));
  ok(hostile.every((r) => r.auth === null), 'P1-3 a tampered `url` receives NO Authorization header',
    JSON.stringify(hostile));
}

// ── P2-4: an env-vars error body is never echoed (it can carry a VALUE) ─────
{
  const h = harness(async (url) => {
    if (url.includes('/env-vars')) return { status: 500, body: { echo: { value: 'shpat_SECRET_VALUE_ECHOED' } } };
    return { status: 404, body: {} };
  });
  const code = await main(['env-diff', 'puure-dashboard', 'mineblock-dashboard'], h.deps);
  ok(code === 1, 'P2-4 an env-vars error exits 1', `code=${code}\n${h.out()}`);
  ok(!h.out().includes('shpat_SECRET_VALUE_ECHOED'), 'P2-4 the env-vars error body is NOT echoed', h.out());
  ok(/500/.test(h.out()), 'P2-4 the status is still reported', h.out());
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
