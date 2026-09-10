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

const BASE = process.env.LANE_BASE_COMMIT
  || execFileSync('git', ['merge-base', 'HEAD', 'hub/main'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
// Merge-time addition (integrator, 2026-09-10): once hub/main CONTAINS the lane,
// merge-base(HEAD, hub/main) === HEAD, the diff is empty and the guard can no longer
// see the lane at all. LANE_HEAD_COMMIT lets it be evaluated over the lane's own range
// (BASE..<lane merge commit>) after the merge. Nothing it forbids has changed.
const LANE_HEAD = process.env.LANE_HEAD_COMMIT || 'HEAD';
const FORBIDDEN = [/^server\/src\//, /^client\//, /^server\/migrations\/0\d\d/, /^server\/migrations\/(1[01]\d|12[0-2])_/];

test('A6: only migrations/scripts/tests/docs changed since the lane base', () => {
  const out = execFileSync('git', ['diff', '--name-only', BASE, LANE_HEAD], { cwd: REPO_ROOT, encoding: 'utf8' });
  const untracked = LANE_HEAD === 'HEAD'
    ? execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' })
    : '';
  const files = [...out.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean);
  assert.ok(files.length > 0, 'expected the lane to have changed something');
  const bad = files.filter((f) => FORBIDDEN.some((rx) => rx.test(f)));
  assert.deepEqual(bad, [], `read-path / forbidden files touched: ${bad.join(', ')}`);
  const allowed = files.filter((f) => /^(server\/migrations\/(12[3-9]_.*\.sql|1[3-9]\d_.*\.sql|staged\/.*\.sql|order\.lane-c\.json|order\.json|run\.js)|server\/scripts\/backfill-store-codes.*|server\/tests\/(store-code\/.*|migrations\/migrations\.mjs)|docs\/(lanes\/.*|MIGRATIONS\.md))$/.test(f));
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
