// A6 — no read path changed: this lane touched no route, service or client file,
// and no already-applied migration. Checked against git (committed AND working
// tree) from the lane's base, which after the C2 rebase is hub/main.
//
// server/migrations/run.js IS in scope for C2 (review F1/F7: the runner must set
// app.store_code and a lock_timeout). It is not a read path — it is the migration
// runner — so it is allowlisted, and the change is asserted rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, MIGRATIONS_DIR } from './_db.mjs';

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);

const FORBIDDEN = [/^server\/src\//, /^client\//, /^server\/migrations\/0\d\d/, /^server\/migrations\/(1[01]\d|12[0-2])_/];
const ALLOWED = /^(server\/migrations\/(12[3-9]_.*\.sql|1[3-9]\d_.*\.sql|staged\/.*\.sql|order\.lane-c\.json|order\.json|run\.js)|server\/scripts\/backfill-store-codes.*|server\/tests\/(store-code\/.*|migrations\/migrations\.mjs)|docs\/(lanes\/.*|MIGRATIONS\.md))$/;

// ── Range resolution: SELF-DESCRIBING, no env var required ───────────────────
// Merge-time addition (integrator, 2026-09-10): once hub/main CONTAINS the lane,
// merge-base(HEAD, hub/main) === HEAD, the diff is empty and the guard could no longer
// see the lane at all — it failed with 'expected the lane to have changed something'.
// LANE_BASE_COMMIT / LANE_HEAD_COMMIT remain the explicit override (lane mode, the full
// guard). With them unset the test now derives its own range and says which one it took:
//
//   lane mode         HEAD is a lane branch  ->  merge-base(HEAD, hub/main)..HEAD, full guard.
//   integration mode  HEAD already CONTAINS the lane (hub/main itself) -> the HUB RANGE,
//                     merge-base(HEAD, origin/main)..HEAD.
//
// In integration mode the FORBIDDEN/allowlist sweep is NOT applied to the whole hub range:
// measured 2026-09-10, that range legitimately carries other merged lanes' read-path
// changes (server/src/routes/hubSso.js, client/src/config/brand.js, ...), so sweeping it
// reports every other lane as a violation. A per-file attribution back to the store-code
// lane's own commits is not available either: the lane's history contains 121_/122_
// store_code_*.sql, renumbered to 123/124 before the merge, which the FORBIDDEN 12[0-2]
// pattern would flag. So on the integration branch the guard asserts what is still
// answerable and still true: the lane IS visible in the hub range, and nothing in the
// working tree (uncommitted or untracked) touches a read path. The strong sweep stays one
// env var away and still bites — see PROOF-MERGE-2 "Test repairs (post-merge)".
const HEAD_SHA = git('rev-parse', 'HEAD');
const LANE_BASE = tryGit('merge-base', 'HEAD', 'hub/main');
let MODE, BASE, LANE_HEAD;
if (process.env.LANE_BASE_COMMIT || process.env.LANE_HEAD_COMMIT) {
  MODE = 'lane (explicit LANE_BASE_COMMIT/LANE_HEAD_COMMIT)';
  BASE = process.env.LANE_BASE_COMMIT || LANE_BASE;
  LANE_HEAD = process.env.LANE_HEAD_COMMIT || 'HEAD';
} else if (LANE_BASE && LANE_BASE !== HEAD_SHA) {
  MODE = 'lane (derived: merge-base(HEAD, hub/main)..HEAD)';
  BASE = LANE_BASE;
  LANE_HEAD = 'HEAD';
} else {
  MODE = 'integration (derived: hub range, merge-base(HEAD, origin/main)..HEAD)';
  BASE = tryGit('merge-base', 'HEAD', 'origin/main') || LANE_BASE;
  LANE_HEAD = 'HEAD';
}
const INTEGRATION = MODE.startsWith('integration');

test('A6: only migrations/scripts/tests/docs changed since the lane base', () => {
  assert.ok(BASE, 'could not derive a base commit: neither hub/main nor origin/main is reachable');
  const out = git('diff', '--name-only', BASE, LANE_HEAD);
  const untracked = LANE_HEAD === 'HEAD' ? git('ls-files', '--others', '--exclude-standard') : '';
  const files = [...lines(out), ...lines(untracked)];
  console.log(`# A6 range: ${MODE}`);
  console.log(`# A6 range: ${BASE.slice(0, 7)}..${LANE_HEAD === 'HEAD' ? HEAD_SHA.slice(0, 7) + ' (HEAD)' : LANE_HEAD} -> ${files.length} file(s)`);

  if (INTEGRATION) {
    // 1. the lane is visible again in the derived range
    const laneFiles = files.filter((f) => ALLOWED.test(f));
    console.log(`# A6 integration: ${laneFiles.length} of them are store-code lane files`);
    assert.ok(files.length > 0, `the derived hub range ${BASE.slice(0, 7)}..HEAD is empty — nothing to guard`);
    assert.ok(laneFiles.length > 0, `the store-code lane is not visible in the hub range ${BASE.slice(0, 7)}..HEAD`);
    // 2. live guard: the working tree itself must not touch a read path
    const dirty = [...lines(git('diff', '--name-only', 'HEAD')), ...lines(untracked)];
    const badDirty = dirty.filter((f) => FORBIDDEN.some((rx) => rx.test(f)));
    assert.deepEqual(badDirty, [], `read-path / forbidden files touched in the working tree: ${badDirty.join(', ')}`);
    return;
  }

  assert.ok(files.length > 0, `expected the lane to have changed something (range ${BASE.slice(0, 7)}..${LANE_HEAD}, mode: ${MODE})`);
  const bad = files.filter((f) => FORBIDDEN.some((rx) => rx.test(f)));
  assert.deepEqual(bad, [], `read-path / forbidden files touched: ${bad.join(', ')}`);
  const allowed = files.filter((f) => ALLOWED.test(f));
  assert.deepEqual(files.filter((f) => !allowed.includes(f)), [], 'unexpected files outside the lane allowlist');
});

test('A6: the runner change is the store-code + lock-timeout contract and nothing else', () => {
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, 'run.js'), 'utf8');
  assert.match(src, /set_config\('app\.store_code', \$1, true\)/, 'run.js must set app.store_code as a bind parameter');
  assert.match(src, /SET LOCAL lock_timeout/, 'run.js must bound each migration transaction with lock_timeout');
  assert.match(src, /\^\[A-Z0-9\]\{2,4\}\$/, 'run.js must validate STORE_CODE against the store-code shape');
  // No brand or store literal decides anything (R15): MB/PL may appear only in the
  // examples inside the refusal message, never as a value the code falls back to.
  for (const m of src.match(/^.*\b(MB|PL|P1|PUURE)\b.*$/gm) || []) {
    assert.ok(/REFUSING|e\.g\.|would have tagged|\*/.test(m), `store literal in run.js outside a message: ${m.trim()}`);
  }
});
