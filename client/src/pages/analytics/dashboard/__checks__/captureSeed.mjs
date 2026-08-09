// captureSeed — regenerate ./seed.generated.json from the REAL services
// (NEW FILE, LANE 3, developer tool; the JSON it writes is what ships).
//
// ── WHY THIS EXISTS (the meta-fix) ──────────────────────────────────────────
//
// The first cut of this lane's fixtures was HAND-WRITTEN from the work order's
// prose. Every honesty rule passed against them and three readers were still
// wrong, because the fixtures encoded the same misunderstanding the readers
// did: `gross_sales` on breakdown rows that actually carry `net_sales`, a
// scalar `total` on a breakdown that actually nests `totals`, string warnings
// in an array that actually holds `{source, reason}`. A hand-written fixture
// cannot catch a shape error — it agrees with whatever the author believed.
//
// So the fixtures are no longer authored. They are CAPTURED from
// `runDashboard`, `runBand` and `getMarketing` themselves, against a real
// Postgres, and committed as JSON. If a lane changes a key, the next capture
// changes with it and the render harness fails loudly instead of agreeing
// quietly.
//
// ── HOW ─────────────────────────────────────────────────────────────────────
//
//   1. Lane 1's own engine harness is run first — it builds and populates
//      `puure_metrics_engine` with the fixture its authors designed to exercise
//      their edges (TTL, uncosted legs, upsell reversals, REPORT_TZ boundaries).
//      Reusing it means these seeds inherit the server lane's edge cases rather
//      than this lane's guesses about them.
//   2. The three services are imported from the sibling worktrees and called
//      directly against that database.
//   3. The captured payloads are written to ./seed.generated.json.
//
// The WITHHELD state is DERIVED from a captured payload by nulling every
// numeric leaf — the SHAPE stays real (that is the part that drifts), only the
// values are forced to the withheld case, which is exactly what is being
// asserted. It is not a second hand-written fixture.
//
// Run:  node client/src/pages/analytics/dashboard/__checks__/captureSeed.mjs
// Env:  METRICS_DIR / ATTRIBUTION_DIR override the sibling worktree paths.
//       PG_ADMIN overrides the postgres superuser URL.
//
// ⚠️ This script is NOT part of the app or of the render check. It reaches into
// sibling worktrees by absolute path on purpose and only runs by hand.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// __checks__ → dashboard → analytics → pages → src → client → <this worktree>
// → .claude/worktrees, which is where the sibling lanes live.
const WORKTREES = resolve(HERE, '../../../../../../..');
const METRICS_DIR = process.env.METRICS_DIR || resolve(WORKTREES, 'agent-metrics-engine');
const ATTRIBUTION_DIR = process.env.ATTRIBUTION_DIR || resolve(WORKTREES, 'agent-attribution');
const PG_ADMIN = process.env.PG_ADMIN || 'postgres://puure@127.0.0.1:5433/postgres';
const DB = 'postgres://puure@127.0.0.1:5433/puure_metrics_engine';

process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const say = (m) => console.log(m);

/* 1 ── populate, by running the server lane's own harness ─────────────────── */

say(`\n== capture seed ==\n  metrics:     ${METRICS_DIR}\n  attribution: ${ATTRIBUTION_DIR}\n`);
say('[1/4] running Lane 1 engine harness to build + populate the fixture DB…');
try {
  execFileSync('node', ['server/tests/metrics/engine.mjs'], {
    cwd: METRICS_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  say('      Lane 1 harness: PASSED (fixture DB is populated)');
} catch (e) {
  // A FAILING SERVER HARNESS IS NOT A REASON TO CAPTURE ANYWAY. The payloads
  // would be shaped by a build its own authors consider broken, and this lane
  // would then pin fixtures to it.
  const tail = String(e.stdout || '').split('\n').slice(-12).join('\n');
  console.error('      Lane 1 harness FAILED — refusing to capture from a red build.\n', tail);
  process.exit(1);
}

/* 2 ── import the real services out of the sibling worktrees ─────────────── */

say('[2/4] importing runDashboard / runBand / getMarketing…');
const metrics = await import(pathToFileURL(resolve(METRICS_DIR, 'server/src/services/funnelMetrics.js')).href);
const attribution = await import(pathToFileURL(resolve(ATTRIBUTION_DIR, 'server/src/services/funnelAttribution.js')).href);
const { runDashboard, runBand, todayInTz } = metrics;
const { getMarketing } = attribution;

const today = todayInTz();
const dayAdd = (day, n) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/* 3 ── capture ───────────────────────────────────────────────────────────── */

say('[3/4] capturing payloads…');

// A. the everyday window — 30 REPORT_TZ days ending today.
const windowA = { start: dayAdd(today, -29), end: today };
const dashboard = await runDashboard(windowA);

// B. a window that reaches PAST the 90-day touch retention. This is the state
//    the TTL note, meta.sessions_unknown and the withheld sessions column all
//    hang off, and it is the one the hand-written fixture got wrong: it claimed
//    `sessions_unknown:false` while also carrying withheld sessions, which is a
//    payload the server cannot produce.
const windowB = { start: dayAdd(today, -200), end: dayAdd(today, -120) };
const dashboardTtl = await runDashboard(windowB);

// C. the heartbeat's own payload — its window is always [yesterday, today].
const band = await runBand({});

// D. Lane 2's bars for window A, at EVERY dimension. The campaign fold in
//    Lane 1's fixture happens to be fully attributed, so capturing only that
//    one would leave the two unattributed states ('none' / 'untagged') — and
//    the disclosure that distinguishes them — untested against a real payload.
//    Whichever dimension actually produces them becomes the seed for that case.
const marketingByDim = {};
for (const dim of ['campaign', 'source', 'referrer', 'landing_page']) {
  marketingByDim[dim] = await getMarketing({ ...windowA, dimension: dim, limit: 12 });
}
const marketing = marketingByDim.campaign;
const unattributedDim = Object.entries(marketingByDim)
  .find(([, p]) => (p.rows || []).some((r) => r.is_unattributed));
const marketingUnattributed = unattributedDim ? unattributedDim[1] : null;

/* 4 ── derive the withheld state from a REAL shape ───────────────────────── */

/**
 * Null every numeric leaf, keep every key. The shape is the server's; only the
 * measurements are forced to "withheld". Booleans and strings are preserved so
 * `sessions_unknown`, `basis_label`, `total_metric` and the window echo still
 * describe the payload truthfully.
 */
const withhold = (v) => {
  if (typeof v === 'number') return null;
  if (Array.isArray(v)) return v.map(withhold);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = withhold(val);
    return out;
  }
  return v;
};
const withheld = withhold(dashboard);
// A withheld window is one the server could not measure, so it says so — with
// the object-shaped warning the real service emits, not a string.
withheld.meta = { ...(withheld.meta || {}), sessions_unknown: true };
withheld.meta.warnings = [{
  source: 'sessions',
  reason: 'sessions withheld for this window (touch retention)',
}];

const out = {
  captured_at: new Date().toISOString(),
  captured_from: {
    metrics_commit: git(METRICS_DIR),
    attribution_commit: git(ATTRIBUTION_DIR),
    report_tz: process.env.REPORT_TZ,
    database: 'puure_metrics_engine (Lane 1 engine harness fixture)',
  },
  windows: { a: windowA, b: windowB },
  dashboard,
  dashboard_ttl: dashboardTtl,
  band,
  marketing,
  marketing_by_dimension: marketingByDim,
  // The dimension whose real fold contains an unattributed bucket, if any.
  marketing_unattributed: marketingUnattributed,
  marketing_unattributed_dimension: unattributedDim ? unattributedDim[0] : null,
  withheld,
};

const target = resolve(HERE, 'seed.generated.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

say(`[4/4] wrote ${target}`);
say(`      dashboard.breakdown_summary.funnels.rows      = ${dashboard.breakdown_summary.funnels.rows.length}`);
say(`      dashboard.breakdown_summary.funnels.rows_total= ${dashboard.breakdown_summary.funnels.rows_total}`);
say(`      dashboard.breakdown_summary.funnels.total_metric = ${dashboard.breakdown_summary.funnels.total_metric}`);
say(`      dashboard.meta.warnings                       = ${JSON.stringify(dashboard.meta.warnings)}`);
say(`      dashboard.meta.sessions_unknown               = ${dashboard.meta.sessions_unknown}`);
say(`      dashboard_ttl.meta.sessions_unknown           = ${dashboardTtl.meta.sessions_unknown}`);
say(`      band.in_window (composite)                    = ${dashboard.band.in_window}`);
say(`      marketing.rows                                = ${marketing.rows?.length}`);
say(`      marketing.totals                              = ${JSON.stringify(marketing.totals)}`);
say(`      marketing unattributed dimension              = ${unattributedDim ? unattributedDim[0] : 'NONE FOUND'}`);
if (marketingUnattributed) {
  const states = marketingUnattributed.rows.filter((r) => r.is_unattributed)
    .map((r) => `${r.label}=${r.attribution}`);
  say(`      …its unattributed rows                        = ${JSON.stringify(states)}`);
}
say('');
process.exit(0);

function git(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}
