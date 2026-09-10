// A6 — no read path changed: this lane touched no route/service/client file
// and not run.js. Checked against git (committed AND working tree) from the
// lane's base commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './_db.mjs';

const BASE = process.env.LANE_BASE_COMMIT || 'edc1030';
const FORBIDDEN = [/^server\/src\//, /^client\//, /^server\/migrations\/run\.js$/, /^server\/migrations\/0\d\d/];

test('A6: only migrations/scripts/tests/docs changed since the lane base', () => {
  const out = execFileSync('git', ['diff', '--name-only', BASE], { cwd: REPO_ROOT, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const files = [...out.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean);
  assert.ok(files.length > 0, 'expected the lane to have changed something');
  const bad = files.filter((f) => FORBIDDEN.some((rx) => rx.test(f)));
  assert.deepEqual(bad, [], `read-path / forbidden files touched: ${bad.join(', ')}`);
  const allowed = files.filter((f) => /^(server\/migrations\/(1[2-9]\d_.*\.sql|staged\/.*\.sql|order\.lane-c\.json)|server\/scripts\/backfill-store-codes.*|server\/tests\/store-code\/.*|docs\/lanes\/.*)$/.test(f));
  assert.deepEqual(files.filter((f) => !allowed.includes(f)), [], 'unexpected files outside the lane allowlist');
});
