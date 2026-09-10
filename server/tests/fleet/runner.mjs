// Acceptance tests for the suite runner (server/tests/run-all.mjs).
// Lane B goal 1. Everything runs against a throwaway fixture tree in os.tmpdir()
// so the real suite is never a dependency of its own runner's tests.
//
// Covers: A1 (exit 0 when everything passes), A2 (a seeded failing assertion
// makes the run exit 1 AND names the script), A4 (a hanging script is killed at
// its timeout and reported FAIL, not a hung CI), plus quarantine SKIP, per-script
// timeout headers, --list, and usage refusals.
//
// Run:  node server/tests/fleet/runner.mjs
// test-timeout: 180s
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const RUNNER = path.join(REPO, 'server/tests/run-all.mjs');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

function runner(args, opts = {}) {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [RUNNER, ...args], {
      cwd: REPO,
      env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const guard = setTimeout(() => ch.kill('SIGKILL'), opts.guardMs || 120000);
    ch.on('close', (code) => { clearTimeout(guard); res({ code, out }); });
  });
}

// ── fixture tree ────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(tmpdir(), 'laneb-runner-'));
const w = (rel, body) => {
  const p = path.join(ROOT, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};

w('green/alpha.mjs', 'console.log("RESULT: 3 passed, 0 failed");\nprocess.exit(0);\n');
w('green/beta.mjs', 'console.log("RESULT: 1 passed, 0 failed");\nprocess.exit(0);\n');
w('green/header-timeout.mjs',
  '// a generous header must be honoured, not the 120 s default\n'
  + '// test-timeout: 30s\n'
  + 'await new Promise((r) => setTimeout(r, 300));\n'
  + 'console.log("RESULT: 1 passed, 0 failed");\nprocess.exit(0);\n');

// ── A1: a clean tree exits 0 ────────────────────────────────────────────────
{
  const r = await runner(['--root', ROOT]);
  ok(r.code === 0, 'A1 clean fixture tree exits 0', `code=${r.code}\n${r.out}`);
  ok(/\bgreen\/alpha\.mjs\b/.test(r.out), 'A1 names each script it ran', r.out);
  ok(/3 passed/.test(r.out) || /passed:\s*3/i.test(r.out), 'A1 summary counts the three passing scripts', r.out);
  ok(/header-timeout\.mjs/.test(r.out) && !/TIMEOUT/.test(r.out), 'A1 per-script timeout header honoured (no spurious timeout)', r.out);
}

// ── A2: a seeded failing assertion turns the run red and is named ───────────
{
  w('red/seeded-failure.mjs',
    'console.log("PASS  a real assertion");\n'
    + 'console.log("FAIL  seeded assertion: 1 === 2");\n'
    + 'console.log("RESULT: 1 passed, 1 failed");\nprocess.exit(1);\n');
  const r = await runner(['--root', ROOT]);
  ok(r.code === 1, 'A2 one failing script makes the run exit 1', `code=${r.code}`);
  ok(/red\/seeded-failure\.mjs/.test(r.out), 'A2 the failing script is named in the output', r.out);
  ok(/FAILED/i.test(r.out), 'A2 output carries an explicit failure section', r.out);
  ok(/seeded assertion/.test(r.out), 'A2 the failing script\'s own output is echoed', r.out);
  rmSync(path.join(ROOT, 'red'), { recursive: true, force: true });
}

// ── A4: a hanging script is killed at its timeout and reported FAIL ─────────
{
  w('hang/forever.mjs',
    '// test-timeout: 2s\n'
    + 'setInterval(() => {}, 1000);\n'
    + 'console.log("started and never finishing");\n');
  const t0 = Date.now();
  const r = await runner(['--root', ROOT], { guardMs: 60000 });
  const ms = Date.now() - t0;
  ok(r.code === 1, 'A4 a hanging script makes the run exit 1', `code=${r.code}`);
  ok(/TIMEOUT/.test(r.out), 'A4 the hang is reported as TIMEOUT', r.out);
  ok(/hang\/forever\.mjs/.test(r.out), 'A4 the hanging script is named', r.out);
  ok(ms < 40000, `A4 the runner returns instead of hanging CI (took ${ms} ms)`, r.out);
  rmSync(path.join(ROOT, 'hang'), { recursive: true, force: true });
}

// ── quarantine: listed scripts are SKIPped with a visible reason ────────────
{
  w('quarantined/headless-impossible.mjs', 'process.exit(1);\n');
  writeFileSync(path.join(ROOT, 'QUARANTINE.md'),
    '# Quarantine\n\n'
    + '- `quarantined/headless-impossible.mjs` — needs a display server, cannot run headless\n');
  const r = await runner(['--root', ROOT]);
  ok(r.code === 0, 'quarantined failing script does not turn the run red', `code=${r.code}\n${r.out}`);
  ok(/SKIP/.test(r.out), 'quarantine produces a visible SKIP', r.out);
  ok(/needs a display server/.test(r.out), 'the SKIP carries the quarantine reason', r.out);

  // a quarantine entry pointing at nothing is a maintenance bug: refuse loudly
  writeFileSync(path.join(ROOT, 'QUARANTINE.md'),
    '# Quarantine\n\n- `quarantined/does-not-exist.mjs` — stale entry\n');
  const r2 = await runner(['--root', ROOT]);
  ok(r2.code === 2, 'a stale quarantine entry exits 2', `code=${r2.code}\n${r2.out}`);
  ok(/does-not-exist\.mjs/.test(r2.out), 'the stale quarantine entry is named', r2.out);
  writeFileSync(path.join(ROOT, 'QUARANTINE.md'),
    '# Quarantine\n\n- `quarantined/headless-impossible.mjs` — needs a display server, cannot run headless\n');
}

// ── --list enumerates without executing ─────────────────────────────────────
{
  const r = await runner(['--root', ROOT, '--list']);
  ok(r.code === 0, '--list exits 0', String(r.code));
  ok(/green\/alpha\.mjs/.test(r.out), '--list enumerates discovered scripts', r.out);
  ok(!/RESULT: 3 passed/.test(r.out), '--list does not execute the scripts', r.out);
  ok(/quarantined\/headless-impossible\.mjs/.test(r.out) && /SKIP|quarantin/i.test(r.out),
    '--list marks quarantined scripts', r.out);
}

// ── the runner never runs itself ────────────────────────────────────────────
{
  const r = await runner(['--root', path.join(REPO, 'server/tests'), '--list']);
  ok(r.code === 0, 'listing the real tree exits 0', String(r.code));
  ok(!/(^|\/)run-all\.mjs/m.test(r.out), 'run-all.mjs excludes itself from discovery', r.out);
  ok(/tracking\/health-shape\.mjs/.test(r.out), 'the real tree is discovered', r.out.slice(0, 400));
}

// ── usage refusals ──────────────────────────────────────────────────────────
{
  const r = await runner(['--root', ROOT, '--nonsense']);
  ok(r.code === 2, 'unknown flag exits 2', `code=${r.code}\n${r.out}`);
  const r2 = await runner(['--root', path.join(ROOT, 'no-such-dir')]);
  ok(r2.code === 2, 'a missing root exits 2', `code=${r2.code}\n${r2.out}`);
  const r3 = await runner(['--root', ROOT, '--timeout', 'banana']);
  ok(r3.code === 2, 'an unparseable --timeout exits 2', `code=${r3.code}\n${r3.out}`);
}

// ── a filter narrows the run ────────────────────────────────────────────────
{
  const r = await runner(['--root', ROOT, 'green/alpha']);
  ok(r.code === 0, 'filtered run exits 0', String(r.code));
  ok(/green\/alpha\.mjs/.test(r.out) && !/green\/beta\.mjs/.test(r.out),
    'a positional filter selects a subset', r.out);
  const r2 = await runner(['--root', ROOT, 'matches-nothing-at-all']);
  ok(r2.code === 2, 'a filter matching nothing exits 2 rather than reporting a green empty run', `code=${r2.code}\n${r2.out}`);
}

// ── a script that exits 0 while printing failures is still trusted on exit code,
//    but a NON-ZERO exit with no output must still be reported cleanly ───────
{
  w('quiet/silent-fail.mjs', 'process.exit(3);\n');
  const r = await runner(['--root', ROOT]);
  ok(r.code === 1, 'a silent non-zero exit turns the run red', `code=${r.code}`);
  ok(/silent-fail\.mjs/.test(r.out), 'the silent failure is named', r.out);
  ok(/exit 3|code 3|\(3\)/.test(r.out), 'the exit code is reported', r.out);
  rmSync(path.join(ROOT, 'quiet'), { recursive: true, force: true });
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
