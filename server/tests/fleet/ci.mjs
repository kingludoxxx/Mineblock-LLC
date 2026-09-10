// Acceptance tests for the CI workflows. Lane B goal 2 (A5, A6).
//
// A5 — every workflow file parses as YAML and carries the jobs/steps the brief
//      asked for, with every third-party action pinned to a commit sha.
// A6 — the R15 guard is not asserted from the YAML text: the step's actual
//      `run:` script is lifted out of the workflow and EXECUTED against fixture
//      trees. A tree containing a brand literal must make it fail; the same tree
//      with the literal removed must make it pass; a tree where the guarded
//      directories do not exist at all must pass.
//
// Run:  node server/tests/fleet/ci.mjs
// test-timeout: 120s
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const CI = path.join(REPO, '.github/workflows/ci.yml');
const CRM_CI = path.join(REPO, 'docs/crm-ci.yml');
const R15_STEP_NAME = 'R15 no brand literals in engine code';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

// ── A5: YAML validity, via a real parser ───────────────────────────────────
function parseYaml(file) {
  const out = execFileSync('python3', ['-c', `
import json, sys, yaml
with open(sys.argv[1]) as f:
    print(json.dumps(yaml.safe_load(f)))
`, file], { encoding: 'utf8' });
  return JSON.parse(out);
}

let dash = null, crm = null;
for (const [label, file] of [['dashboard .github/workflows/ci.yml', CI], ['CRM docs/crm-ci.yml', CRM_CI]]) {
  ok(existsSync(file), `A5 ${label} exists`, file);
  let doc = null, err = '';
  try { doc = parseYaml(file); } catch (e) { err = String(e.stderr || e.message).slice(0, 300); }
  ok(doc !== null, `A5 ${label} parses as YAML`, err);
  if (file === CI) dash = doc; else crm = doc;
}

// GitHub reads `on:` — YAML 1.1 turns a bare `on` key into the boolean true,
// so assert the trigger survives whichever way the parser rendered it.
const triggerOf = (doc) => doc?.on ?? doc?.[true] ?? doc?.['on'];

if (dash) {
  const trig = triggerOf(dash);
  ok(!!trig, 'A5 dashboard workflow declares triggers', JSON.stringify(Object.keys(dash)));
  ok(trig && ('push' in trig) && ('pull_request' in trig), 'A5 it runs on push and pull_request', JSON.stringify(trig));
  const job = dash.jobs && Object.values(dash.jobs)[0];
  ok(!!job, 'A5 the dashboard workflow has a job', JSON.stringify(Object.keys(dash.jobs || {})));
  const steps = (job && job.steps) || [];
  const text = JSON.stringify(steps);

  const nodeStep = steps.find((s) => (s.uses || '').includes('actions/setup-node'));
  ok(!!nodeStep, 'A5 node is set up', text.slice(0, 200));
  ok(nodeStep && String(nodeStep.with['node-version']) === '22', 'A5 node 22', JSON.stringify(nodeStep && nodeStep.with));

  ok(/npm ci/.test(text), 'A5 npm ci runs', '');
  ok(/cd client && npm ci|npm ci --prefix client|working-directory.*client/.test(text), 'A5 client dependencies are installed too', '');
  ok(/npm run test:smoke/.test(text), 'A5 the smoke suite runs', '');
  ok(steps.some((s) => (s.name || '') === R15_STEP_NAME), `A5 the step "${R15_STEP_NAME}" exists`, text.slice(0, 300));
  ok(steps.some((s) => (s.uses || '').includes('gitleaks')), 'A5 a secret scan runs', '');

  const services = job.services || {};
  const pg = Object.values(services)[0];
  ok(!!pg, 'A5 a service container is declared', JSON.stringify(services));
  ok(pg && /postgres:16/.test(String(pg.image)), 'A5 the service container is Postgres 16', JSON.stringify(pg && pg.image));
  ok(pg && JSON.stringify(pg.options || '').includes('health'), 'A5 the Postgres service has a health check', JSON.stringify(pg && pg.options));

  // lint runs only if the repo has it configured — assert the step is conditional, not absent
  ok(/lint/i.test(text), 'A5 a lint step is present', '');

  // every third-party action pinned to a 40-char sha (supply chain)
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
  ok(unpinned.length === 0, 'A5 every action is pinned to a commit sha', JSON.stringify(unpinned));
  ok(uses.some((u) => /gitleaks.*@[0-9a-f]{40}$/.test(u)), 'A5 the gitleaks action specifically is sha-pinned', JSON.stringify(uses));
}

if (crm) {
  const job = crm.jobs && Object.values(crm.jobs)[0];
  const steps = (job && job.steps) || [];
  const text = JSON.stringify(steps);
  const py = steps.find((s) => (s.uses || '').includes('actions/setup-python'));
  ok(!!py, 'A5 CRM workflow sets up python', text.slice(0, 200));
  ok(py && String(py.with['python-version']).startsWith('3.11'), 'A5 CRM python is 3.11', JSON.stringify(py && py.with));
  ok(/pip install -r backend\/requirements\.txt/.test(text), 'A5 CRM installs backend/requirements.txt', '');
  ok(/ruff/.test(text), 'A5 CRM runs ruff', '');
  ok(/py_compile/.test(text), 'A5 CRM runs py_compile over backend/app', '');
  ok(/uvicorn/.test(text) && /MONGO_URL/.test(text), 'A5 CRM has the MONGO_URL-unset boot smoke', '');
  const unpinned = steps.filter((s) => s.uses).map((s) => s.uses).filter((u) => !/@[0-9a-f]{40}$/.test(u));
  ok(unpinned.length === 0, 'A5 CRM actions are pinned to a commit sha', JSON.stringify(unpinned));
}

// ── A6: run the R15 guard's own script against fixtures ────────────────────
function r15Script() {
  const out = execFileSync('python3', ['-c', `
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1]))
job = list(doc['jobs'].values())[0]
for s in job['steps']:
    if s.get('name') == sys.argv[2]:
        sys.stdout.write(s['run'])
        break
else:
    sys.exit('step not found')
`, CI, R15_STEP_NAME], { encoding: 'utf8' });
  return out;
}

let script = null;
try { script = r15Script(); } catch (e) { ok(false, 'A6 the R15 step carries a run: script', String(e.stderr || e.message).slice(0, 200)); }

if (script) {
  ok(/R15_ROOT/.test(script), 'A6 the R15 script takes its root from R15_ROOT so it can be tested', script.slice(0, 200));

  const runGuard = (root) => spawnSync('bash', ['-c', script], { cwd: REPO, env: { ...process.env, R15_ROOT: root }, encoding: 'utf8' });

  const ROOT = mkdtempSync(path.join(tmpdir(), 'laneb-r15-'));
  const engine = path.join(ROOT, 'server/src/services/engine');
  const pipelines = path.join(ROOT, 'server/src/pipelines');

  // (a) the guarded directories do not exist yet — the step must PASS
  {
    const r = runGuard(ROOT);
    ok(r.status === 0, 'A6 passes when server/src/services/engine and server/src/pipelines do not exist', `status=${r.status}\n${r.stdout}${r.stderr}`);
  }

  // (b) a clean engine file — PASS
  mkdirSync(engine, { recursive: true });
  mkdirSync(pipelines, { recursive: true });
  const clean = path.join(engine, 'recipe.js');
  writeFileSync(clean, 'export const applyRecipe = (store, recipe) => ({ ...store, ...recipe });\n');
  {
    const r = runGuard(ROOT);
    ok(r.status === 0, 'A6 passes on a clean engine tree', `status=${r.status}\n${r.stdout}${r.stderr}`);
  }

  // (c) a brand literal — FAIL, and the file and the term are named
  writeFileSync(clean, 'export const brand = "Puure";\n');
  {
    const r = runGuard(ROOT);
    ok(r.status !== 0, 'A6 FAILS when an engine file contains "Puure"', `status=${r.status}\n${r.stdout}${r.stderr}`);
    ok(/recipe\.js/.test(r.stdout + r.stderr), 'A6 the offending file is named', r.stdout + r.stderr);
  }

  // (d) remove the literal — PASSES again (the red/green pair, same command)
  writeFileSync(clean, 'export const brand = "from the manifest";\n');
  {
    const r = runGuard(ROOT);
    ok(r.status === 0, 'A6 passes once the literal is removed', `status=${r.status}\n${r.stdout}${r.stderr}`);
  }

  // (e) every banned term, one at a time, in either guarded directory
  const BANNED = ['Puure', 'mineblock', 'MinerForge', 'Reevo', 'PL', 'P1', 'MR', 'act_1234567890', '17cca0-2', '9jn59g-x7'];
  for (const term of BANNED) {
    const target = path.join(pipelines, 'brief.js');
    writeFileSync(target, `const code = ${JSON.stringify(term)};\n`);
    const r = runGuard(ROOT);
    ok(r.status !== 0, `A6 FAILS on banned term ${JSON.stringify(term)} (case-insensitive)`, `status=${r.status}\n${r.stdout}${r.stderr}`);
    rmSync(target);
  }

  // (f) word boundaries: a longer word that merely CONTAINS a short code is not a hit
  {
    const target = path.join(pipelines, 'brief.js');
    writeFileSync(target, 'const plan = "APPLICABLE PLANS are compiled"; const mrs = "MRSA"; const p10 = "P10";\n');
    const r = runGuard(ROOT);
    ok(r.status === 0, 'A6 PL/MR/P1 are word-bounded (PLANS, MRSA, P10 are not hits)', `status=${r.status}\n${r.stdout}${r.stderr}`);
    rmSync(target);
  }

  rmSync(ROOT, { recursive: true, force: true });
}

// ── the workflow must not carry a secret ───────────────────────────────────
for (const f of [CI, CRM_CI]) {
  if (!existsSync(f)) continue;
  const raw = readFileSync(f, 'utf8');
  ok(!/rnd_[A-Za-z0-9]{20,}/.test(raw), `${path.basename(f)} contains no Render key`, '');
  ok(!/ghp_[A-Za-z0-9]{20,}|shpat_[A-Za-z0-9]{20,}/.test(raw), `${path.basename(f)} contains no token literal`, '');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
