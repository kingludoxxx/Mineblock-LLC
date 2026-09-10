// Acceptance tests for scripts/fleet.mjs — argument handling, refusal paths and
// credential hygiene. Nothing here touches the network: every test injects a
// mock fetch, and one test asserts that the refusal paths never call fetch at
// all. Lane B goal 3 (A7, A8), plus the B3 review findings P1-1 (protected
// store guard), P2-1 (--commit= form), P2-2 (dry-run may not bypass a refusal),
// P2-5 (readKeyFromSettings) and P2-6 (a sha is 40 lowercase hex).
//
// Run:  node server/tests/fleet/fleet-cli.mjs
// test-timeout: 60s
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const { main, SERVICES_PATH, readKeyFromSettings, protectionFor } = await import(path.join(REPO, 'scripts/fleet.mjs'));

const FAKE_KEY = 'test-not-a-real-render-key-000001';
// A full 40-character lowercase sha: what fleet.mjs now requires (P2-6).
const SHA = 'edc10309c1f4b7a2e6d80b53f7a91c4e2d6b8f01';
const SHA_OLD = 'b17c4a9e02d5f83716ea4c0b9d2f65a8371c0e4d';
const TYPED = '--i-typed-the-store-name=Puure';   // the protected store's typed name

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
  const code = await main(['deploy', 'puure-dashboard', '--commit', SHA, '--dry-run'], h.deps);
  ok(code === 0, 'A8 dry-run exits 0', `code=${code}\n${h.out()}`);
  ok(h.calls.length === 0, 'A8 dry-run sends no request at all', JSON.stringify(h.calls));
  const out = h.out();
  ok(/POST/.test(out) && /\/v1\/services\/srv-[a-z0-9]+\/deploys/.test(out),
    'A8 dry-run prints the method and the endpoint', out);
  const m = out.match(/\{[\s\S]*?\}/);
  ok(!!m, 'A8 dry-run prints a JSON body', out);
  let body = null;
  try { body = JSON.parse(m[0]); } catch { /* reported below */ }
  ok(body && body.commitId === SHA, 'A8 the body carries the commitId verbatim', JSON.stringify(body));
  ok(body && body.clearCache === 'do_not_clear', 'A8 the body carries clearCache=do_not_clear', JSON.stringify(body));
  ok(!out.includes(FAKE_KEY), 'A8 dry-run output does not contain the API key', 'key leaked');
}

// rollback dry-run also sends nothing beyond the read it needs
{
  const deploys = [
    { deploy: { id: 'dep-3', status: 'live', commit: { id: SHA }, finishedAt: '2026-09-10T11:00:00Z' } },
    { deploy: { id: 'dep-2', status: 'live', commit: { id: SHA_OLD }, finishedAt: '2026-09-09T11:00:00Z' } },
  ];
  const h = harness({ routes: { '/deploys': { body: deploys } } });
  const code = await main(['rollback', 'puure-dashboard', '--dry-run'], h.deps);
  ok(code === 0, 'rollback --dry-run exits 0', `code=${code}\n${h.out()}`);
  ok(h.calls.every((c) => (c.init.method || 'GET') === 'GET'), 'rollback --dry-run issues no writes', JSON.stringify(h.calls.map((c) => c.init.method)));
  ok(h.out().includes(SHA_OLD.slice(0, 7)), 'rollback --dry-run names the commit it would redeploy', h.out());
}

// ── unknown service / placeholder service are refusals ──────────────────────
{
  const h = harness();
  const code = await main(['deploy', 'not-a-service', '--commit', SHA], h.deps);
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
  const deploys = [{ deploy: { id: 'dep-1', status: 'live', commit: { id: SHA }, finishedAt: '2026-09-10T11:00:00Z' } }];
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


// ── P1-1: a protected store refuses deploy AND rollback without the typed name ──
// R1/R3. The bracket (snapshots, robot purchase, 30 min observed) stays a human
// process; what is mechanised here is the "typed store name" half of it.
{
  const live = [{ deploy: { id: 'dep-live', status: 'live', commit: { id: SHA_OLD }, finishedAt: '2026-09-10T11:00:00Z' } }];
  const routes = {
    '/deploys': (u, i) => ((i.method === 'POST')
      ? { status: 201, body: { id: 'dep-new', status: 'live', commit: { id: SHA } } }
      : { body: live }),
    '/api/health': { body: { status: 'ok' } },
  };

  for (const svc of ['puure-dashboard', 'puure-crm']) {
    const h = harness({ routes });
    const code = await main(['deploy', svc, '--commit', SHA], h.deps);
    ok(code === 2, `P1-1 deploy ${svc} without the typed store name exits 2`, `code=${code}\n${h.out()}`);
    ok(h.calls.length === 0, `P1-1 that refusal never reaches the network (${svc})`, JSON.stringify(h.calls.map((c) => c.url)));
    ok(/R1\/R3/.test(h.out()), 'P1-1 the refusal cites the rule', h.out());
    ok(/--i-typed-the-store-name=Puure/.test(h.out()), 'P1-1 the refusal says exactly what to type', h.out());
    ok(/bracket/i.test(h.out()), 'P1-1 the refusal says the bracket is a human process', h.out());

    const h2 = harness({ routes });
    const code2 = await main(['rollback', svc], h2.deps);
    ok(code2 === 2, `P1-1 rollback ${svc} without the typed store name exits 2`, `code=${code2}\n${h2.out()}`);
    ok(h2.calls.length === 0, `P1-1 the rollback refusal never reaches the network (${svc})`, JSON.stringify(h2.calls.map((c) => c.url)));
  }

  // the wrong case is not the store name. Case-SENSITIVE, deliberately.
  for (const wrong of ['puure', 'PUURE', 'Puure ', 'puure-dashboard']) {
    const h = harness({ routes });
    const code = await main(['deploy', 'puure-dashboard', '--commit', SHA, `--i-typed-the-store-name=${wrong}`], h.deps);
    ok(code === 2, `P1-1 --i-typed-the-store-name=${JSON.stringify(wrong)} is refused (exact, case-sensitive)`, `code=${code}\n${h.out()}`);
    ok(h.calls.length === 0, `P1-1 the wrong-name refusal sends nothing (${JSON.stringify(wrong)})`, JSON.stringify(h.calls.map((c) => c.url)));
  }

  // a flag copied from another store's command authorises nothing
  {
    const h = harness({ routes });
    const code = await main(['deploy', 'puure-dashboard', '--commit', SHA, '--i-typed-the-store-name=Mineblock'], h.deps);
    ok(code === 2, 'P1-1 another store\'s name does not authorise this store', `code=${code}\n${h.out()}`);
    ok(h.calls.length === 0, 'P1-1 the cross-store refusal sends nothing', JSON.stringify(h.calls.map((c) => c.url)));
  }

  // the exact name is accepted — and the rollback anchor is printed BEFORE the POST
  {
    const h = harness({ routes });
    const code = await main(['deploy', 'puure-dashboard', '--commit', SHA, TYPED], h.deps);
    ok(code === 0, 'P1-1 the exact store name is accepted', `code=${code}\n${h.out()}`);
    const post = h.calls.find((c) => (c.init.method || 'GET') === 'POST');
    ok(!!post, 'P1-1 the authorised deploy does POST', JSON.stringify(h.calls.map((c) => c.url)));
    const out = h.out();
    ok(/ROLLBACK ANCHOR/.test(out), 'P1-1 a rollback anchor is printed', out);
    ok(out.includes('dep-live'), 'P1-1 the anchor names the LIVE deploy id', out);
    ok(out.includes(SHA_OLD.slice(0, 7)), 'P1-1 the anchor names the live commit', out);
    ok(out.indexOf('ROLLBACK ANCHOR') < out.indexOf('POST http'), 'P1-1 the anchor is printed BEFORE the POST', out);
  }

  // --dry-run needs no typed name: it sends nothing, and reading the request is
  // how an operator prepares the bracket in the first place.
  {
    const h = harness({ routes });
    const code = await main(['deploy', 'puure-dashboard', '--commit', SHA, '--dry-run'], h.deps);
    ok(code === 0, 'P1-1 --dry-run on a protected store still works without the typed name', `code=${code}\n${h.out()}`);
    ok(h.calls.length === 0, 'P1-1 and it sends nothing', JSON.stringify(h.calls));
  }

  // an unprotected store is unaffected: --commit and an anchor, no typed name
  {
    const h = harness({ routes });
    const code = await main(['deploy', 'mineblock-dashboard', '--commit', SHA], h.deps);
    ok(code === 0, 'P1-1 an unprotected store needs no typed name', `code=${code}\n${h.out()}`);
    ok(/ROLLBACK ANCHOR/.test(h.out()), 'P1-1 an unprotected store still prints the anchor', h.out());
  }

  // the guard is DATA, not a hardcoded name in the engine (R15)
  {
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(SERVICES_PATH, 'utf8'));
    ok(Array.isArray(cfg.protection) && cfg.protection.length > 0, 'P1-1 the protection rule lives in the services file', JSON.stringify(cfg.protection));
    const prot = cfg.services.filter((x) => protectionFor(cfg, x));
    ok(prot.length === 2 && prot.every((x) => x.name.startsWith('puure')),
      'P1-1 exactly the two protected services are protected', JSON.stringify(prot.map((x) => x.name)));
    const src = readFileSync(path.join(REPO, 'scripts/fleet.mjs'), 'utf8');
    ok(!/['"`]Puure['"`]/.test(src), 'P1-1 R15: the store name is not a literal in fleet.mjs', 'store name found in engine code');
  }
}

// ── P2-1: --commit=<sha> is the same flag, not a missing one ────────────────
{
  const h = harness();
  const code = await main(['deploy', 'mineblock-dashboard', `--commit=${SHA}`, '--dry-run'], h.deps);
  ok(code === 0, 'P2-1 --commit=<sha> is accepted', `code=${code}\n${h.out()}`);
  const m = h.out().match(/\{[\s\S]*?\}/);
  ok(m && JSON.parse(m[0]).commitId === SHA, 'P2-1 the = form carries the same commitId', h.out());

  const h2 = harness();
  const code2 = await main(['deploy', 'mineblock-dashboard', '--commit=nonsense'], h2.deps);
  ok(code2 === 2, 'P2-1 --commit=<not a sha> is refused', `code=${code2}\n${h2.out()}`);
  ok(/40-character lowercase hex/.test(h2.out()) && !/without --commit/.test(h2.out()),
    'P2-1 and the message is about the VALUE, not a missing flag', h2.out());
}

// ── P2-2: --dry-run may not bypass a refusal ────────────────────────────────
{
  const h = harness();
  const code = await main(['deploy', 'sb-dashboard', '--commit', SHA, '--dry-run'], h.deps);
  ok(code === 2, 'P2-2 dry-run on a placeholder service is refused, not printed', `code=${code}\n${h.out()}`);
  ok(/placeholder/.test(h.out()), 'P2-2 the refusal says why', h.out());
  ok(!/services\/null\/deploys/.test(h.out()), 'P2-2 no request against a null service id is ever printed', h.out());
  ok(h.calls.length === 0, 'P2-2 and nothing is sent', JSON.stringify(h.calls));
}

// ── P2-6: a commit is 40 lowercase hex characters, or it is refused ─────────
{
  for (const bad of ['edc1030', 'EDC1030', SHA.toUpperCase(), SHA.slice(0, 39), `${SHA}a`, 'HEAD', 'main']) {
    const h = harness();
    const code = await main(['deploy', 'mineblock-dashboard', '--commit', bad], h.deps);
    ok(code === 2, `P2-6 --commit ${JSON.stringify(bad)} is refused`, `code=${code}\n${h.out()}`);
    ok(h.calls.length === 0, `P2-6 ${JSON.stringify(bad)} never reaches the network`, JSON.stringify(h.calls.map((c) => c.url)));
  }
  const h = harness();
  const code = await main(['deploy', 'mineblock-dashboard', '--commit', SHA, '--dry-run'], h.deps);
  ok(code === 0, 'P2-6 a full 40-character lowercase sha is accepted', `code=${code}\n${h.out()}`);
}

// ── P2-5: readKeyFromSettings, the real function, against a temp HOME ───────
// Every other test injects readKey, so these three refusal branches had never
// been executed. No real key is read here: HOME is redirected to a tmpdir.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const HOME = process.env.HOME;
  const mk = (contents) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'laneb-home-'));
    if (contents !== null) {
      mkdirSync(path.join(dir, '.claude'), { recursive: true });
      writeFileSync(path.join(dir, '.claude', 'settings.json'), contents);
    }
    return dir;
  };
  const attempt = (dir) => {
    process.env.HOME = dir;
    try { return { key: readKeyFromSettings(), err: null }; }
    catch (e) { return { key: null, err: e.message }; }
  };
  try {
    let r = attempt(mk(null));
    ok(r.key === null && /cannot read/.test(r.err || ''), 'P2-5 a missing settings file is a clear refusal', JSON.stringify(r));
    r = attempt(mk('{ not json'));
    ok(r.key === null && /RENDER_API_KEY unavailable/.test(r.err || ''), 'P2-5 malformed JSON is a clear refusal', JSON.stringify(r));
    r = attempt(mk(JSON.stringify({ mcpServers: {} })));
    ok(r.key === null && /not found/.test(r.err || ''), 'P2-5 a settings file without the key is a clear refusal', JSON.stringify(r));
    r = attempt(mk(JSON.stringify({ mcpServers: { render: { env: { RENDER_API_KEY: '  planted-not-a-real-key  ' } } } })));
    ok(r.key === 'planted-not-a-real-key', 'P2-5 a present key is read and trimmed', JSON.stringify(r));
    ok(!(r.err || '').includes('planted-not-a-real-key'), 'P2-5 no branch echoes the key value', JSON.stringify(r));
  } finally {
    if (HOME === undefined) delete process.env.HOME; else process.env.HOME = HOME;
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
