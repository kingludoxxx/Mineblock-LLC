// Acceptance tests for scripts/fleet.mjs — argument handling, refusal paths and
// credential hygiene. Nothing here touches the network: every test injects a
// mock fetch, and one test asserts that the refusal paths never call fetch at
// all. Lane B goal 3 (A7, A8).
//
// Run:  node server/tests/fleet/fleet-cli.mjs
// test-timeout: 60s
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { main, SERVICES_PATH } = await import(path.join(REPO, 'scripts/fleet.mjs'));

const FAKE_KEY = 'test-not-a-real-render-key-000001';

// A harness that records every line printed and every request attempted.
function harness({ routes = {}, key = FAKE_KEY } = {}) {
  const lines = [];
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        const r = typeof handler === 'function' ? handler(u, init) : handler;
        return {
          ok: (r.status || 200) < 400,
          status: r.status || 200,
          async json() { return r.body; },
          async text() { return JSON.stringify(r.body); },
        };
      }
    }
    return { ok: false, status: 404, async json() { return { message: 'no mock route' }; }, async text() { return 'no mock route'; } };
  };
  return {
    lines, calls,
    deps: {
      fetch: fetchMock,
      readKey: () => key,
      log: (s) => lines.push(String(s)),
      sleep: async () => {},
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    },
    out: () => lines.join('\n'),
  };
}

// ── A7: deploy REFUSES without --commit (R37) ───────────────────────────────
{
  const h = harness();
  const code = await main(['deploy', 'puure-dashboard'], h.deps);
  ok(code === 2, 'A7 `deploy <name>` without --commit exits 2', `code=${code}\n${h.out()}`);
  ok(/--commit/.test(h.out()), 'A7 the refusal names --commit', h.out());
  ok(/R37/.test(h.out()), 'A7 the refusal cites R37', h.out());
  ok(h.calls.length === 0, 'A7 the refusal never reaches the network', JSON.stringify(h.calls));
}

// a bare `--commit` with no value, and a value that is not a sha, are refusals too
{
  const h = harness();
  const code = await main(['deploy', 'puure-dashboard', '--commit'], h.deps);
  ok(code === 2, '`--commit` with no value exits 2', `code=${code}\n${h.out()}`);
  const h2 = harness();
  const code2 = await main(['deploy', 'puure-dashboard', '--commit', 'HEAD'], h2.deps);
  ok(code2 === 2, '`--commit HEAD` is refused (a sha, not a ref — R37)', `code=${code2}\n${h2.out()}`);
  ok(h2.calls.length === 0, 'the non-sha refusal never reaches the network', JSON.stringify(h2.calls));
}

// ── A8: --dry-run prints the exact POST body and sends nothing ──────────────
{
  const h = harness();
  const code = await main(['deploy', 'puure-dashboard', '--commit', 'edc1030', '--dry-run'], h.deps);
  ok(code === 0, 'A8 dry-run exits 0', `code=${code}\n${h.out()}`);
  ok(h.calls.length === 0, 'A8 dry-run sends no request at all', JSON.stringify(h.calls));
  const out = h.out();
  ok(/POST/.test(out) && /\/v1\/services\/srv-[a-z0-9]+\/deploys/.test(out),
    'A8 dry-run prints the method and the endpoint', out);
  const m = out.match(/\{[\s\S]*?\}/);
  ok(!!m, 'A8 dry-run prints a JSON body', out);
  let body = null;
  try { body = JSON.parse(m[0]); } catch { /* reported below */ }
  ok(body && body.commitId === 'edc1030', 'A8 the body carries the commitId verbatim', JSON.stringify(body));
  ok(body && body.clearCache === 'do_not_clear', 'A8 the body carries clearCache=do_not_clear', JSON.stringify(body));
  ok(!out.includes(FAKE_KEY), 'A8 dry-run output does not contain the API key', 'key leaked');
}

// rollback dry-run also sends nothing beyond the read it needs
{
  const deploys = [
    { deploy: { id: 'dep-3', status: 'live', commit: { id: 'aaaaaaa' }, finishedAt: '2026-09-10T11:00:00Z' } },
    { deploy: { id: 'dep-2', status: 'live', commit: { id: 'bbbbbbb' }, finishedAt: '2026-09-09T11:00:00Z' } },
  ];
  const h = harness({ routes: { '/deploys': { body: deploys } } });
  const code = await main(['rollback', 'puure-dashboard', '--dry-run'], h.deps);
  ok(code === 0, 'rollback --dry-run exits 0', `code=${code}\n${h.out()}`);
  ok(h.calls.every((c) => (c.init.method || 'GET') === 'GET'), 'rollback --dry-run issues no writes', JSON.stringify(h.calls.map((c) => c.init.method)));
  ok(/bbbbbbb/.test(h.out()), 'rollback --dry-run names the commit it would redeploy', h.out());
}

// ── unknown service / placeholder service are refusals ──────────────────────
{
  const h = harness();
  const code = await main(['deploy', 'not-a-service', '--commit', 'edc1030'], h.deps);
  ok(code === 2, 'an unknown service name exits 2', `code=${code}\n${h.out()}`);
  ok(/not-a-service/.test(h.out()), 'the unknown service is named', h.out());
  ok(h.calls.length === 0, 'unknown service never reaches the network', JSON.stringify(h.calls));
}

// ── usage ───────────────────────────────────────────────────────────────────
{
  const h = harness();
  ok(await main([], h.deps) === 2, 'no subcommand exits 2', h.out());
  const h2 = harness();
  ok(await main(['frobnicate'], h2.deps) === 2, 'an unknown subcommand exits 2', h2.out());
  const h3 = harness();
  ok(await main(['env-diff', 'puure-dashboard'], h3.deps) === 2, 'env-diff with one argument exits 2', h3.out());
  const h4 = harness();
  ok(await main(['rollback'], h4.deps) === 2, 'rollback with no service exits 2', h4.out());
}

// ── credential hygiene: the key is never in a URL, never printed ────────────
{
  const deploys = [{ deploy: { id: 'dep-1', status: 'live', commit: { id: 'edc1030' }, finishedAt: '2026-09-10T11:00:00Z' } }];
  const h = harness({ routes: { '/deploys': { body: deploys } } });
  await main(['status'], h.deps);
  ok(h.calls.length > 0, 'status issues requests', String(h.calls.length));
  ok(h.calls.every((c) => !c.url.includes(FAKE_KEY)), 'the key never appears in a URL', JSON.stringify(h.calls.map((c) => c.url)));
  ok(h.calls.every((c) => !c.url.includes('key=') && !c.url.includes('token=') && !c.url.includes('api_key=')),
    'no credential-shaped query parameter is ever built', JSON.stringify(h.calls.map((c) => c.url)));
  ok(h.calls.every((c) => (c.init.headers || {}).Authorization === `Bearer ${FAKE_KEY}`),
    'the key travels in the Authorization header', JSON.stringify(h.calls.map((c) => Object.keys(c.init.headers || {}))));
  ok(!h.out().includes(FAKE_KEY), 'the key is never printed', 'key leaked to stdout');
}

// even when the API errors, the key must not leak into the error text
{
  const h = harness({ routes: { '/deploys': { status: 401, body: { message: 'Unauthorized' } } } });
  const code = await main(['status'], h.deps);
  ok(code === 1, 'a 401 from Render makes status exit 1', `code=${code}\n${h.out()}`);
  ok(!h.out().includes(FAKE_KEY), 'an error path does not print the key', h.out());
  ok(/401/.test(h.out()), 'the HTTP status is reported', h.out());
}

// a missing key is a clear refusal, not a Bearer undefined
{
  const h = harness({ key: null });
  h.deps.readKey = () => { throw new Error('RENDER_API_KEY not found in ~/.claude/settings.json (mcpServers.render.env)'); };
  const code = await main(['status'], h.deps);
  ok(code === 2, 'a missing key exits 2', `code=${code}\n${h.out()}`);
  ok(/RENDER_API_KEY/.test(h.out()), 'the missing-key message names the variable', h.out());
  ok(h.calls.length === 0, 'no request is attempted without a key', JSON.stringify(h.calls));
}

// ── the services file is data, and every live service carries an id ─────────
{
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(SERVICES_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  ok(Array.isArray(cfg.services), 'fleet.services.json holds a services array', raw.slice(0, 200));
  const live = cfg.services.filter((s) => s.live);
  ok(live.length === 4, `four live services are declared (got ${live.length})`, JSON.stringify(cfg.services.map((s) => s.name)));
  ok(live.every((s) => /^srv-[a-z0-9]+$/.test(s.id)), 'every live service carries a Render service id', JSON.stringify(live.map((s) => s.id)));
  ok(cfg.services.some((s) => !s.live && s.id === null), 'placeholders are present with a null id', JSON.stringify(cfg.services.filter((s) => !s.live)));
  ok(!/rnd_/.test(raw), 'the services file holds no credential', 'credential-shaped string found');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
