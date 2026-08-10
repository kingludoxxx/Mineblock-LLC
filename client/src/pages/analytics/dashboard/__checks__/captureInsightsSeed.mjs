// captureInsightsSeed — regenerate ./insights.seed.generated.json from the REAL
// insight + cohort services (NEW FILE, LANE 5, developer tool; the JSON it
// writes is what ships).
//
// ── THE SAME META-FIX AS ./captureSeed.mjs, FOR THE SAME REASON ─────────────
//
// A hand-written fixture agrees with whatever its author believed. That is how
// three readers shipped wrong against Lane 3's first fixtures, and it is why
// this lane's render payloads are CAPTURED from `runInsights` and
// `computeCohorts` themselves rather than authored.
//
// ── WHERE THIS DIFFERS FROM ./captureSeed.mjs ───────────────────────────────
//
// That script reaches into SIBLING WORKTREES by absolute path (`METRICS_DIR`,
// `ATTRIBUTION_DIR`) because Lanes 1, 2 and 3 were built in parallel. Those
// lanes are merged, so this one imports its services from THIS tree, and it
// builds its OWN fixture database rather than borrowing Lane 1's engine
// harness. It has to: the states this lane must render — a cohort with un-aged
// horizons, a detector that could not run, a day on which nothing fired — are
// not states Lane 1's fixture was designed to produce, and capturing whatever
// its data happens to contain would leave the interesting cells untested.
//
// The fixture below is therefore DESIGNED (each block says which state it
// stages) and the PAYLOADS are captured. The shape is the server's; only the
// data that produces it is chosen.
//
// Run:  node client/src/pages/analytics/dashboard/__checks__/captureInsightsSeed.mjs
// Env:  PG_ADMIN overrides the postgres superuser URL.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
// __checks__ → dashboard → analytics → pages → src → client → <this worktree>
const ROOT = resolve(HERE, '../../../../../..');
const PG_ADMIN = process.env.PG_ADMIN || 'postgres://puure@127.0.0.1:5433/postgres';
const DB = 'postgres://puure@127.0.0.1:5433/puure_insights_seed';

process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const say = (m) => console.log(m);
say(`\n== capture insight seed ==\n  tree: ${ROOT}\n  db:   ${DB}\n`);

/* 1 ── a fixture database, built here ─────────────────────────────────────── */

say('[1/4] building the fixture database…');
const admin = postgres(PG_ADMIN, { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_insights_seed`;
await admin`CREATE DATABASE puure_insights_seed`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

const { ensureCheckoutTables } = await import(`${ROOT}/server/src/services/checkoutSchema.js`);
const { ensureTrackingTables } = await import(`${ROOT}/server/src/services/trackingSchema.js`);
const { ensureFunnelCostsTables } = await import(`${ROOT}/server/src/services/funnelCostsSchema.js`);
await ensureCheckoutTables();
await ensureTrackingTables();
await ensureFunnelCostsTables();
await q(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT '',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

const M = await import(`${ROOT}/server/src/services/funnelMetrics.js`);
const I = await import(`${ROOT}/server/src/services/funnelInsights.js`);
const CO = await import(`${ROOT}/server/src/services/funnelCohorts.js`);
const { todayInTz, zonedDayStart } = M;
const { runInsights, dayAdd, BASELINE_DAYS } = I;
const { computeCohorts } = CO;

const TODAY = todayInTz();
const noonOf = (day) => new Date(zonedDayStart(day).getTime() + 12 * 3_600_000).toISOString();

// ── funnels + pages: two funnels, one with a real step flow ────────────────
//
// ⚠️ NO EM DASH IN A FUNNEL NAME. The render check pins an EXACT em-dash count
// per state as its measure of "how many things the page refuses to claim", and
// a funnel called "Alpha — Breast Lift" puts em dashes into every card headline
// that names it. That is punctuation, not a withheld measurement, and it made
// the pin count the wrong thing. Named plainly on purpose.
await q(`INSERT INTO funnels (id, slug, name, status) VALUES
  ('f-alpha','alpha','Alpha Breast Lift','live'),
  ('f-beta','beta','Beta Activator Oil','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type) VALUES
  ('pg-lp','f-alpha','lp','listicle'),
  ('pg-pd','f-alpha','pd','product'),
  ('pg-co','f-alpha','co','checkout'),
  ('pg-ty','f-alpha','ty','thankyou')`);

let sid = 0;
const order = async ({ day, funnel = 'f-alpha', email, total, vid = null, campaign = null }) => {
  sid += 1;
  await q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, currency, customer, gateway, paid_at, created_at, vid)
     VALUES ($1,$2,'pg-co','paid',$3,'USD',jsonb_build_object('email',$4::text),'whop',$5,$5,$6)`,
    [`s${sid}`, funnel, String(total), email, noonOf(day), vid]
  );
  if (vid && campaign) {
    await q(
      `INSERT INTO lb_touches (vid, funnel_id, page_id, url, utm, ts, expires_at)
       VALUES ($1,$2,'pg-lp','https://x/lp',jsonb_build_object('utm_campaign',$3::text),$4,$4::timestamptz + interval '90 days')`,
      [vid, funnel, campaign, noonOf(day)]
    );
  }
};
const touch = async (day, page, vid, funnel = 'f-alpha') => q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, url, utm, ts, expires_at)
   VALUES ($1,$2,$3,'https://x/p','{}'::jsonb,$4,$4::timestamptz + interval '90 days')`,
  [vid, funnel, page, noonOf(day)]
);

// ── STATE A: a day that fires several detectors ────────────────────────────
// Alpha holds ~$100/day across the whole baseline, then collapses to $6 today;
// Beta moves a little, so BOTH movers have a measured previous day. The numbers
// are chosen so the ACCOUNT-WIDE day is the outlier — see
// server/tests/insights/service.mjs for the same arithmetic worked through.
for (let i = BASELINE_DAYS; i >= 1; i -= 1) {
  const d = dayAdd(TODAY, -i);
  await order({ day: d, email: `b${i}@x.com`, total: 62 });
  await order({ day: d, email: `b${i}b@x.com`, total: 38 });
}
await order({ day: TODAY, email: 'today@x.com', total: 6 });
await order({ day: dayAdd(TODAY, -1), funnel: 'f-beta', email: 'mv1@x.com', total: 45 });
await order({ day: TODAY, funnel: 'f-beta', email: 'mv2@x.com', total: 52 });

// ── the step ledger: a healthy funnel that collapses at checkout today ─────
for (let i = BASELINE_DAYS; i >= 1; i -= 1) {
  const d = dayAdd(TODAY, -i);
  for (let v = 0; v < 40; v += 1) await touch(d, 'pg-lp', `bl${i}_${v}`);
  for (let v = 0; v < 20; v += 1) await touch(d, 'pg-pd', `bl${i}_${v}`);
  for (let v = 0; v < 10; v += 1) await touch(d, 'pg-co', `bl${i}_${v}`);
  for (let v = 0; v < 6; v += 1) await touch(d, 'pg-ty', `bl${i}_${v}`);
}
for (let v = 0; v < 120; v += 1) await touch(TODAY, 'pg-lp', `td_${v}`);
for (let v = 0; v < 60; v += 1) await touch(TODAY, 'pg-pd', `td_${v}`);
for (let v = 0; v < 2; v += 1) await touch(TODAY, 'pg-co', `td_${v}`);
for (let v = 0; v < 1; v += 1) await touch(TODAY, 'pg-ty', `td_${v}`);

// ── the dead rail: an enabled Meta pixel with no CAPI token ────────────────
await q(`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, enabled, config)
         VALUES ('px-a','f-alpha','meta_pixel','1234567890',TRUE,'{}'::jsonb)`);

// ── the cohorts: TWO ages, so the AGING GUARD is in the captured payload ───
// An old cohort (100 days back) is aged at every horizon; a cohort acquired
// TODAY is aged at D0 only, so D7/D30/D90 come back NULL. Those null cells are
// the single most important thing this seed carries — they are what the render
// check asserts must draw an em dash and never $0.00.
const OLD = dayAdd(TODAY, -100);
await order({ day: OLD, email: 'old1@x.com', total: 120, vid: 'c1', campaign: 'spring-lift' });
await order({ day: dayAdd(OLD, 4), email: 'old1@x.com', total: 60 });
await order({ day: dayAdd(OLD, 45), email: 'old1@x.com', total: 40 });
await order({ day: OLD, email: 'old2@x.com', total: 90, vid: 'c2', campaign: 'spring-lift' });
await order({ day: OLD, funnel: 'f-beta', email: 'old3@x.com', total: 200, vid: 'c3', campaign: 'oil-retarget' });
await order({ day: dayAdd(OLD, 12), funnel: 'f-alpha', email: 'old3@x.com', total: 35 });
await order({ day: TODAY, email: 'new1@x.com', total: 75, vid: 'c4', campaign: 'spring-lift' });
await order({ day: TODAY, email: 'new2@x.com', total: 85, vid: 'c5', campaign: 'oil-retarget' });
// A paid session with NO email — it can be in no cohort, and the payload has to
// disclose it. Without one in the fixture the "identity" warning never renders.
await q(`INSERT INTO co_sessions (id, funnel_id, status, total, currency, customer, paid_at, created_at)
         VALUES ('anon-1','f-alpha','paid',310,'USD',jsonb_build_object(),$1,$1)`, [noonOf(OLD)]);

/* 2 ── capture ────────────────────────────────────────────────────────────── */

say('[2/4] capturing insight payloads…');

// A. the everyday strip — several detectors fire.
const insights = await runInsights({}, { query: q });

// B. THE SAME DAY, SCOPED TO ONE FUNNEL. Beta has no step ledger and no pixel,
//    so its strip is a strictly smaller set of cards off the same code path —
//    which is what proves the funnel filter reaches every read.
const insightsScoped = await runInsights({ funnel_id: 'f-beta' }, { query: q });

// C. A DAY ON WHICH NOTHING FIRED — DERIVED, and labelled as derived.
//
//    ⚠️ THIS ONE CANNOT BE CAPTURED, and the attempt is instructive: the
//    obvious move is to scope to a quiet funnel, but the detectors are good, so
//    a funnel with two orders still legitimately fires an anomaly and a mover.
//    Manufacturing genuine six-way silence would mean a fixture so empty that
//    the `detectors[]` block would be all-blind — which is the DEGRADED state,
//    not the quiet one, and they must not look the same on screen.
//
//    So the SHAPE is the server's (that is the part that drifts) and only the
//    card list is forced empty with every detector still marked as having run.
//    Exactly the derivation ./captureSeed.mjs uses for its withheld payload.
const insightsNone = {
  ...insights,
  insights: [],
  detectors: insights.detectors.map((d) => ({ ...d, ran: true, fired: false })),
};

// D. A DEGRADED READ, produced by making one read genuinely throw. The
//    `meta.degraded` entry is then the SERVICE'S own, with its real wording —
//    the render check asserts the strip names the blind detector rather than
//    silently dropping it.
const boom = async (text, params) => {
  if (/FROM lb_touches t\s*\n?\s*JOIN funnel_pages/.test(text)) {
    throw new Error('relation "funnel_pages" does not exist');
  }
  return q(text, params);
};
const insightsDegraded = await runInsights({}, { query: boom });

say('[3/4] capturing cohort payloads…');

// E. the cohort table, spanning BOTH the old and the today cohort so the
//    payload carries aged and un-aged cells side by side.
const cohorts = await computeCohorts({ start: OLD, end: TODAY, group_by: 'day' }, { query: q });
const cohortsByFunnel = await computeCohorts({ start: OLD, end: TODAY, group_by: 'funnel' }, { query: q });
const cohortsByCampaign = await computeCohorts({ start: OLD, end: TODAY, group_by: 'campaign' }, { query: q });

// F. A WINDOW WITH NO ACQUISITIONS — the genuine empty state, captured rather
//    than assumed, so the card's "no new customers" copy is proven reachable.
const cohortsEmpty = await computeCohorts({
  start: dayAdd(TODAY, -60), end: dayAdd(TODAY, -50), group_by: 'day',
}, { query: q });

/* 3 ── write ──────────────────────────────────────────────────────────────── */

const out = {
  captured_at: new Date().toISOString(),
  captured_from: {
    commit: git(ROOT),
    report_tz: process.env.REPORT_TZ,
    database: 'puure_insights_seed (this lane\'s own designed fixture)',
    today: TODAY,
  },
  windows: {
    insights: { day: TODAY, baseline_days: BASELINE_DAYS },
    cohorts: { start: OLD, end: TODAY },
    cohorts_empty: { start: dayAdd(TODAY, -60), end: dayAdd(TODAY, -50) },
  },
  insights,
  insights_scoped: insightsScoped,
  insights_none: insightsNone,
  insights_degraded: insightsDegraded,
  cohorts,
  cohorts_by_funnel: cohortsByFunnel,
  cohorts_by_campaign: cohortsByCampaign,
  cohorts_empty: cohortsEmpty,
};

const target = resolve(HERE, 'insights.seed.generated.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

say(`[4/4] wrote ${target}`);
say(`      insights.insights            = ${JSON.stringify(insights.insights.map((c) => `${c.kind}:${c.severity}`))}`);
say(`      insights.detectors           = ${JSON.stringify(insights.detectors.map((d) => `${d.kind}:${d.ran ? 'ran' : 'blind'}${d.fired ? ':fired' : ''}`))}`);
say(`      insights.meta.degraded       = ${JSON.stringify(insights.meta.degraded)}`);
say(`      insights_scoped.insights     = ${insightsScoped.insights.length} card(s)`);
say(`      insights_none.insights       = ${insightsNone.insights.length} card(s), ${insightsNone.detectors.filter((d) => d.ran).length} detector(s) ran`);
say(`      insights_degraded.degraded   = ${JSON.stringify(insightsDegraded.meta.degraded.map((d) => d.source))}`);
say(`      cohorts.cohorts              = ${cohorts.cohorts.length} (${cohorts.cohorts.map((c) => `${c.key}:${c.size}`).join(', ')})`);
say(`      cohorts un-aged cells        = ${cohorts.cohorts.reduce((t, c) => t + c.ltv.filter((v) => v === null).length, 0)}`);
say(`      cohorts.totals               = ${JSON.stringify(cohorts.totals)}`);
say(`      cohorts_empty.cohorts        = ${cohortsEmpty.cohorts.length}`);
say('');

await sql.end({ timeout: 5 });
process.exit(0);

function git(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
  } catch {
    return 'unknown';
  }
}
