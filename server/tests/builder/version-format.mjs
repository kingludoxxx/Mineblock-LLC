// Unit verification for the version-list presentation helpers
// (client/src/pages/funnels/builder/versionFormat.js).
//
// They are pure and dependency-free on purpose, so they can be exercised by
// node directly. The cases that matter are the DEGRADED ones: a version row
// with a broken timestamp or a null size must still render a restorable row,
// never "NaN ago" and never a blank.
//
// Run:  node server/tests/builder/version-format.mjs
import { relativeTime, formatBytes } from '../../../client/src/pages/funnels/builder/versionFormat.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// ---- relativeTime, happy path ---------------------------------------------
eq(relativeTime(ago(0), NOW), 'just now', 'relativeTime: 0s → just now');
eq(relativeTime(ago(44_000), NOW), 'just now', 'relativeTime: 44s → just now');
eq(relativeTime(ago(60_000), NOW), '1 min ago', 'relativeTime: 60s → 1 min ago');
eq(relativeTime(ago(5 * 60_000), NOW), '5 min ago', 'relativeTime: 5 min');
eq(relativeTime(ago(59 * 60_000), NOW), '59 min ago', 'relativeTime: 59 min');
eq(relativeTime(ago(2 * 3600_000), NOW), '2 hrs ago', 'relativeTime: 2 hrs (plural)');
eq(relativeTime(ago(3600_000), NOW), '1 hr ago', 'relativeTime: 1 hr (singular)');
eq(relativeTime(ago(26 * 3600_000), NOW), '1 day ago', 'relativeTime: 1 day (singular)');
eq(relativeTime(ago(3 * 86_400_000), NOW), '3 days ago', 'relativeTime: 3 days');

// ---- relativeTime, degraded -----------------------------------------------
{
  const old = relativeTime(ago(40 * 86_400_000), NOW);
  ok(!/ago/.test(old) && old.length > 0, 'relativeTime: past a week → an absolute date, not "40 days ago"', old);
}
{
  // Clock skew: a snapshot timestamped slightly in the FUTURE must not render
  // a negative duration.
  const future = relativeTime(new Date(NOW + 5_000).toISOString(), NOW);
  eq(future, 'just now', 'relativeTime: a future timestamp (clock skew) → just now');
}
eq(relativeTime('not-a-date', NOW), 'not-a-date', 'relativeTime: unparseable input returns itself, never NaN');
eq(relativeTime(null, NOW), '', 'relativeTime: null → empty string, never "NaN ago"');
eq(relativeTime(undefined, NOW), '', 'relativeTime: undefined → empty string');
ok(!/NaN/.test(relativeTime({}, NOW)), 'relativeTime: an object never yields NaN', relativeTime({}, NOW));

// ---- formatBytes -----------------------------------------------------------
eq(formatBytes(0), '0 B', 'formatBytes: 0');
eq(formatBytes(512), '512 B', 'formatBytes: bytes');
eq(formatBytes(1024), '1.0 KB', 'formatBytes: 1KB boundary');
eq(formatBytes(1536), '1.5 KB', 'formatBytes: KB');
eq(formatBytes(1024 * 1024), '1.00 MB', 'formatBytes: 1MB boundary');
eq(formatBytes(2.5 * 1024 * 1024), '2.50 MB', 'formatBytes: MB');
eq(formatBytes(null), '—', 'formatBytes: null → em dash');
eq(formatBytes(undefined), '—', 'formatBytes: undefined → em dash');
eq(formatBytes('abc'), '—', 'formatBytes: non-numeric → em dash');
eq(formatBytes(-1), '—', 'formatBytes: negative → em dash');
// Postgres BIGINT arrives over JSON as a STRING when it exceeds 2^53; a
// numeric string must still format rather than fall through to the dash.
eq(formatBytes('2048'), '2.0 KB', 'formatBytes: a numeric STRING (postgres bigint over JSON) formats');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
