// INSIGHT SERVICE verification — drives the REAL `runInsights` and
// `computeCohorts` against embedded Postgres (LANE 5, verification only).
//
// ./detectors.mjs and ./cohorts.mjs prove the RULES and the ARITHMETIC with no
// database. This file proves the half neither of them can touch: THE SQL. Every
// statement in this lane — the DISTINCT ON acquisition read, the `= ANY($1)`
// email array, the REPORT_TZ step bucket, the to_regclass guards — either runs
// against a real Postgres here or has never run at all.
//
// It also proves the two things a pure test structurally cannot:
//   · the reads and the detectors agree on the SAME series (a rule that fires
//     on a fixture is worth nothing if the reader hands it a different shape);
//   · a MISSING TABLE degrades to a NAMED warning instead of a 500.
//
// Run:  node server/tests/insights/service.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_insights';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
);
const near = (a, b, eps = 0.011) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= eps;

// ── bootstrap ───────────────────────────────────────────────────────────────
const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_insights`;
await admin`CREATE DATABASE puure_insights`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
await ensureCheckoutTables();
await ensureTrackingTables();
await ensureFunnelCostsTables();
await q(`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  custom_domain TEXT, default_page_id TEXT, seo JSONB DEFAULT '{}',
  flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}', misc JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT NOT NULL, slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_home BOOLEAN NOT NULL DEFAULT FALSE, blocks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

const M = await import('../../src/services/funnelMetrics.js');
const I = await import('../../src/services/funnelInsights.js');
const CO = await import('../../src/services/funnelCohorts.js');
const { todayInTz, zonedDayStart } = M;
const { runInsights, dayAdd } = I;
const { computeCohorts, cohortsCsv } = CO;

const TODAY = todayInTz();
// THE JUDGED DAY IS YESTERDAY — the last COMPLETE day, which is what
// runInsights defaults to. The fixture stages its notable event on YESTERDAY so
// the default read judges a settled day; TODAY is left as a deliberately
// partial (below-baseline) bucket for the suppression test in section G.
const YESTERDAY = dayAdd(TODAY, -1);
/** A UTC instant at 12:00 local on a REPORT_TZ day — safely inside the day. */
const noonOf = (day) => new Date(zonedDayStart(day).getTime() + 12 * 3_600_000).toISOString();

console.log(`\n== insight service, against real Postgres ==\n   today (REPORT_TZ) = ${TODAY} · judged day (default) = ${YESTERDAY}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// A. THE EMPTY DATABASE — before a single row exists
// ═══════════════════════════════════════════════════════════════════════════

{
  const r = await runInsights({}, { query: q });
  eq(r.day, YESTERDAY, 'A1 an empty database still answers, and DEFAULTS TO YESTERDAY (the last complete day)');
  eq(r.partial, false, 'A1 …a complete day is not partial');
  eq(r.insights, [], 'A1 …with NO cards — and an empty list, never a fabricated one');
  eq(r.meta.degraded, [], 'A1 …and nothing degraded (the tables exist, they are just empty)');
  ok(r.detectors.length === 6 && r.detectors.every((d) => d.fired === false),
    'A1 …while still reporting all six detectors as having run and not fired');
  ok(r.meta.warnings.some((w) => w.source === 'baseline'),
    'A1 THE SILENCE IS EXPLAINED: a baseline too short to judge is named, not left to read as "all clear"');
  ok(r.last_60.series.length === I.LAST_N_DAYS,
    `A1 the 60-day series is gap-free even with no data (${r.last_60.series.length} buckets)`);

  const c = await computeCohorts({}, { query: q });
  eq(c.cohorts, [], 'A2 an empty database has no cohorts');
  eq(c.average.ltv, [null, null, null, null], 'A2 …and averages to nulls, never to $0.00');
  eq(c.totals.buyers, 0, 'A2 …with a measured zero buyer count');
  ok(cohortsCsv(c).startsWith('cohort,size,'), 'A2 …and the CSV is still a well-formed file');
}

// ═══════════════════════════════════════════════════════════════════════════
// B. THE FIXTURE
// ═══════════════════════════════════════════════════════════════════════════
//
//   funnels    f1 "Alpha funnel" · f2 "Beta funnel"
//   pages      f1: product + checkout (for the step waterfall)
//   money      f1 takes $100 on each of the 28 days BEFORE yesterday, then
//              COLLAPSES to $5 on YESTERDAY (the judged/default day). f2 takes
//              $40 the day before yesterday and $50 yesterday.
//
//              ⚠️ THE EVENT IS ON YESTERDAY, NOT TODAY — that is the whole point
//              of the reviewer's fix. runInsights defaults to the last COMPLETE
//              day, so staging the collapse on today would make the default read
//              judge a partial bucket and (correctly, now) suppress the very
//              card this section is trying to observe. On the SETTLED day:
//                baseline = 27 days at $100 + one at $140 (f1 + f2's day-before)
//                mean = 101.43, σ = 7.42, so mean − 2σ = 86.59
//                yesterday = $5 + $50 = $55  ⇒ below the band, a BAD anomaly
//              and f1's −$95 beats f2's +$10 for the top mover, both with a
//              measured previous day.
//
//              TODAY is left as a PARTIAL bucket ($5, well below baseline) with
//              its own token-less-pixel-independent low steps, so section G can
//              prove the partial-day guard suppresses the downward card that the
//              SAME detector fires on the settled day.
//   cohorts    three buyers, hand-checkable (see the table in C below)
//   steps      product → checkout at 50% across the baseline, then 100 → 2 on
//              yesterday (2%, under half of 50% — a leak) and the same on today.
//   rails      f1 has an enabled Meta pixel with NO capi token — a dead rail.

await q(`INSERT INTO funnels (id, slug, name, status) VALUES
  ('f1','alpha','Alpha funnel','live'), ('f2','beta','Beta funnel','live')`);
await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type) VALUES
  ('p1','f1','prod','product'), ('p2','f1','co','checkout')`);

let sid = 0;
const addOrder = async ({ day, funnel = 'f1', email, total, vid = null, campaign = null }) => {
  sid += 1;
  const id = `s${sid}`;
  // ⚠️ `jsonb_build_object`, NOT `$n::jsonb` over a JSON.stringify'd blob.
  // postgres.js infers a JS string bound to a jsonb cast as a JSON *string*,
  // so the column ends up holding `"{\"email\":\"a@x.com\"}"` — jsonb_typeof
  // 'string' — and every `customer->>'email'` in this repo silently answers
  // NULL. The first cut of this harness did exactly that and produced zero
  // cohorts against a database that visibly had the rows; building the object
  // in SQL makes the type unambiguous.
  await q(
    `INSERT INTO co_sessions (id, funnel_id, page_id, status, total, currency, customer, paid_at, created_at, vid)
     VALUES ($1,$2,'p1','paid',$3,'USD',jsonb_build_object('email',$4::text),$5,$5,$6)`,
    [id, funnel, String(total), email, noonOf(day), vid]
  );
  if (vid && campaign) {
    await q(
      `INSERT INTO lb_touches (vid, funnel_id, page_id, url, utm, ts, expires_at)
       VALUES ($1,$2,'p1','https://x/p',jsonb_build_object('utm_campaign',$3::text),$4,$4::timestamptz + interval '90 days')`,
      [vid, funnel, campaign, noonOf(day)]
    );
  }
  return id;
};

// ── the anomaly baseline: f1 at $100/day for the 28 days BEFORE yesterday ──
for (let i = 1; i <= I.BASELINE_DAYS; i += 1) {
  // Two orders a day so AOV has something to be, and a distinct email each day
  // so these buyers do not pollute the cohort table below.
  await addOrder({ day: dayAdd(YESTERDAY, -i), email: `base${i}@x.com`, total: 60 });
  await addOrder({ day: dayAdd(YESTERDAY, -i), email: `base${i}b@x.com`, total: 40 });
}
// The COLLAPSE, on yesterday (the settled, judged day).
await addOrder({ day: YESTERDAY, email: 'yest@x.com', total: 5 });
// TODAY: a PARTIAL bucket, also below baseline. Section G judges this day.
await addOrder({ day: TODAY, email: 'today@x.com', total: 5 });

// ── f2: a small measured move, so BOTH movers have a real baseline ─────────
// day-before-yesterday $40 (a baseline day for yesterday's judgement), then
// yesterday $50 — so f2's mover has a measured previous day and reads +$10.
await addOrder({ day: dayAdd(YESTERDAY, -1), funnel: 'f2', email: 'm1@x.com', total: 40 });
await addOrder({ day: YESTERDAY, funnel: 'f2', email: 'm2@x.com', total: 50 });

// ── the step ledger ────────────────────────────────────────────────────────
const addTouch = async (day, page, vid) => q(
  `INSERT INTO lb_touches (vid, funnel_id, page_id, url, utm, ts, expires_at)
   VALUES ($1,'f1',$2,'https://x/p','{}'::jsonb,$3,$3::timestamptz + interval '90 days')`,
  [vid, page, noonOf(day)]
);
for (let i = 1; i <= I.BASELINE_DAYS; i += 1) {
  const day = dayAdd(YESTERDAY, -i);
  for (let v = 0; v < 10; v += 1) await addTouch(day, 'p1', `v${i}_${v}`);
  for (let v = 0; v < 5; v += 1) await addTouch(day, 'p2', `v${i}_${v}`); // 50% through
}
// yesterday: 100 → 2 = 2% (the settled leak)
for (let v = 0; v < 100; v += 1) await addTouch(YESTERDAY, 'p1', `vy_${v}`);
for (let v = 0; v < 2; v += 1) await addTouch(YESTERDAY, 'p2', `vy_${v}`);
// today: the same collapse, but on a partial day — section G proves it is suppressed
for (let v = 0; v < 100; v += 1) await addTouch(TODAY, 'p1', `vt_${v}`);
for (let v = 0; v < 2; v += 1) await addTouch(TODAY, 'p2', `vt_${v}`);

// ── the dead rail ──────────────────────────────────────────────────────────
await q(`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, enabled, config)
         VALUES ('px1','f1','meta_pixel','111',TRUE,'{}'::jsonb)`);

// ═══════════════════════════════════════════════════════════════════════════
// C. COHORTS, END TO END, WITH A HAND-CHECKED ANSWER
// ═══════════════════════════════════════════════════════════════════════════
//
//   All three buyers below are NEW (no paid session before the window) and are
//   acquired 40 days ago, so every horizon up to D30 is aged.
//
//     coh1@x.com   f1, campaign 'spring'   $100 @ d0 · $50 @ d5
//     coh2@x.com   f1, campaign 'spring'   $200 @ d0
//     coh3@x.com   f2, campaign 'summer'   $80  @ d0   (+ $20 on f1 @ d3 —
//                                          CROSS-FUNNEL, and it must count)
//
//   cohort day = TODAY-40, size 3, aged [3,3,3] at [0,7,30]
//     D0  = (100 + 200 + 80) / 3           = 126.67
//     D7  = (100+50 + 200 + 80+20) / 3     = 450/3 = 150.00
//     D30 = same as D7 (nothing later)     = 150.00
//     retention: coh1 repeats @d5, coh3 repeats @d3 ⇒ 2/3 = 66.7 at D7 and D30
//     revenue_to_date = 100+50+200+80+20   = 450.00

const ACQ = dayAdd(TODAY, -40);
await addOrder({ day: ACQ, email: 'coh1@x.com', total: 100, vid: 'c1', campaign: 'spring' });
await addOrder({ day: dayAdd(ACQ, 5), email: 'coh1@x.com', total: 50 });
await addOrder({ day: ACQ, email: 'coh2@x.com', total: 200, vid: 'c2', campaign: 'spring' });
await addOrder({ day: ACQ, funnel: 'f2', email: 'coh3@x.com', total: 80, vid: 'c3', campaign: 'summer' });
await addOrder({ day: dayAdd(ACQ, 3), funnel: 'f1', email: 'coh3@x.com', total: 20 });

{
  const c = await computeCohorts({
    start: ACQ, end: ACQ, horizons: [0, 7, 30], group_by: 'day',
  }, { query: q });

  eq(c.cohorts.length, 1, 'C1 one acquisition day in the window ⇒ one cohort');
  const co = c.cohorts[0];
  eq(co.key, ACQ, 'C1 …keyed on the acquisition day');
  eq(co.size, 3, 'C1 …with all three new buyers');
  eq(co.aged, [3, 3, 3], 'C1 …aged at every horizon (acquired 40 days ago)');
  ok(near(co.ltv[0], 126.67), `C1 D0 LTV 126.67 (${co.ltv[0]}) — hand-checked in the header`);
  ok(near(co.ltv[1], 150), `C1 D7 LTV 150.00 (${co.ltv[1]})`);
  ok(near(co.ltv[2], 150), `C1 D30 LTV 150.00 (${co.ltv[2]})`);
  eq(co.retention, [100, 66.7, 66.7], 'C1 retention [100.0, 66.7, 66.7] — two of three repeated');
  ok(near(co.revenue_to_date, 450), `C1 revenue_to_date 450.00 (${co.revenue_to_date})`);

  ok(c.basis.includes('customer-level'),
    'C2 the payload SAYS the revenue is customer-level, not funnel-scoped');
  ok(c.identity.includes('email'), 'C2 …and names the identity it grouped on');

  // THE CROSS-FUNNEL RULE, proven rather than asserted: coh3 was acquired on
  // f2 and spent $20 on f1. Scope the ACQUISITION to f2 and that $20 must
  // still be in the LTV — otherwise this is a funnel report wearing the word
  // "LTV", which is the thing the reference's comment warns about.
  const scoped = await computeCohorts({
    start: ACQ, end: ACQ, horizons: [0, 7], group_by: 'day', funnel_id: 'f2',
  }, { query: q });
  eq(scoped.cohorts[0].size, 1, 'C3 scoping acquisition to f2 finds only the buyer f2 acquired');
  ok(near(scoped.cohorts[0].ltv[0], 80), `C3 …their D0 is the f2 order (${scoped.cohorts[0].ltv[0]})`);
  ok(near(scoped.cohorts[0].ltv[1], 100),
    `C3 …and their D7 INCLUDES the $20 they later spent on a DIFFERENT funnel (${scoped.cohorts[0].ltv[1]})`);
  ok(scoped.basis.includes('do not tie out'),
    'C3 …and the payload warns, in words, that this will not tie out to f2\'s net sales');

  // Grouping by funnel and by campaign runs the same fold over different keys.
  const byFunnel = await computeCohorts({ start: ACQ, end: ACQ, group_by: 'funnel' }, { query: q });
  eq(byFunnel.cohorts.map((x) => x.key).sort(), ['f1', 'f2'], 'C4 group_by=funnel keys on the funnel id');
  ok(byFunnel.cohorts.every((x) => x.label && x.label !== x.key),
    'C4 …and resolves the funnel NAME for the label');
  const byCampaign = await computeCohorts({ start: ACQ, end: ACQ, group_by: 'campaign' }, { query: q });
  eq(byCampaign.cohorts.map((x) => x.key).sort(), ['spring', 'summer'],
    'C4 group_by=campaign reads the last-touch UTM off the acquiring session');

  // A RETURNING buyer is not an acquisition: coh1 bought at ACQ, so a window
  // that starts later must not treat their next order as a new customer.
  const later = await computeCohorts({
    start: dayAdd(ACQ, 1), end: dayAdd(ACQ, 10), group_by: 'day',
  }, { query: q });
  const emails = later.cohorts.flatMap((x) => x.key);
  ok(!later.cohorts.some((x) => x.size > 0 && x.key === dayAdd(ACQ, 5)),
    `C5 a buyer whose first-ever purchase predates the window is NOT a new acquisition (${JSON.stringify(emails)})`);

  // The aging guard, against the clock rather than against a fixture.
  const fresh = await computeCohorts({ start: TODAY, end: TODAY, horizons: [0, 30] }, { query: q });
  if (fresh.cohorts.length) {
    eq(fresh.cohorts[0].ltv[1], null, 'C6 a cohort acquired TODAY has a null D30, never $0.00');
    ok(fresh.meta.warnings.some((w) => w.source === 'aging'), 'C6 …and the blank cells are explained');
  } else {
    ok(true, 'C6 no acquisitions today in this fixture — aging guard covered by ./cohorts.mjs');
  }

  // Sessions with no email cannot be in a cohort, and that is DISCLOSED.
  await q(`INSERT INTO co_sessions (id, funnel_id, status, total, currency, customer, paid_at, created_at)
           VALUES ('anon1','f1','paid',999,'USD',jsonb_build_object(),$1,$1)`, [noonOf(ACQ)]);
  const withAnon = await computeCohorts({ start: ACQ, end: ACQ }, { query: q });
  eq(withAnon.totals.anonymous_paid_sessions, 1, 'C7 an email-less paid session is COUNTED');
  ok(withAnon.meta.warnings.some((w) => w.source === 'identity'),
    'C7 …and named in a warning — its money is unattributable, not zero');
  ok(!withAnon.cohorts.some((x) => Number(x.revenue_to_date) > 500),
    'C7 …and it is NOT folded into anyone\'s LTV');
  await q(`DELETE FROM co_sessions WHERE id = 'anon1'`);

  // The CSV comes out of the same numbers.
  const csv = cohortsCsv(c);
  ok(csv.includes('126.67'), 'C8 the CSV carries the same D0 LTV the JSON does');
  ok(csv.trim().split('\n').length === 3, 'C8 …header + one cohort + the average row');
}

// ═══════════════════════════════════════════════════════════════════════════
// D. THE DETECTORS, DRIVEN BY THE REAL READS
// ═══════════════════════════════════════════════════════════════════════════

{
  const r = await runInsights({}, { query: q });
  const kinds = r.insights.map((c) => c.kind);
  console.log(`      fired: ${JSON.stringify(kinds)}`);
  console.log(`      computed_ms=${r.meta.computed_ms} rows_scanned=${r.meta.rows_scanned}`);

  eq(r.meta.degraded, [], 'D0 no read and no detector degraded on a healthy database');
  ok(r.insights.length > 0 && r.insights.length <= I.MAX_CARDS,
    `D0 the strip is non-empty and capped (${r.insights.length})`);

  // RANKING is a property of the real output, not just of the unit test.
  const rank = { bad: 0, warn: 1, good: 2, info: 3 };
  const ranks = r.insights.map((c) => rank[c.severity]);
  ok(ranks.every((v, i) => i === 0 || ranks[i - 1] <= v),
    `D0 …and ranked worst-first (${r.insights.map((c) => c.severity).join(' → ')})`);

  const anomaly = r.insights.find((c) => c.kind === 'anomaly');
  ok(anomaly, 'D1 the $100/day → $5 collapse fires the ANOMALY detector off the real series');
  eq(anomaly.severity, 'bad', 'D1 …as bad');
  eq(anomaly.evidence.metric, 'net_sales', 'D1 …on net_sales');
  ok(anomaly.evidence.baseline_days_measured >= I.THRESHOLDS.anomaly_min_baseline.value,
    `D1 …over ${anomaly.evidence.baseline_days_measured} MEASURED baseline days`);

  const mover = r.insights.find((c) => c.kind === 'top_mover');
  ok(mover, 'D2 the TOP MOVER detector fires off the two real day-breakdowns');
  eq(mover.evidence.funnel_id, 'f1',
    'D2 …and picks f1 (−$95) over f2 (+$10) on ABSOLUTE delta — both have a measured yesterday');
  eq(mover.evidence.label, 'Alpha funnel', 'D2 …naming the funnel, not printing its id');
  eq(mover.evidence.delta, -95, 'D2 …with the real delta, sign intact');

  const leak = r.insights.find((c) => c.kind === 'funnel_leak');
  ok(leak, 'D3 the 50% → 2% step collapse fires the FUNNEL LEAK detector off lb_touches');
  eq([leak.evidence.from_step, leak.evidence.to_step], ['product', 'checkout'],
    'D3 …naming the consecutive step pair');
  ok(near(leak.evidence.day_pct, 2) && near(leak.evidence.baseline_pct, 50),
    `D3 …with both real rates (${leak.evidence.day_pct}% vs ${leak.evidence.baseline_pct}%)`);
  eq(leak.evidence.day_upstream_visitors, 100, 'D3 …and the real upstream visitor count');

  const rail = r.insights.find((c) => c.kind === 'dead_rail');
  ok(rail, 'D4 the token-less Meta pixel fires the DEAD RAIL detector');
  eq(rail.evidence.signal, 'capi_token_missing', 'D4 …on the CAPI signal');
  ok(!JSON.stringify(r).includes('capi_token"'), 'D4 …and no token value is anywhere in the payload');

  // The whole payload's contract.
  for (const k of ['day', 'timezone', 'insights', 'detectors', 'last_60', 'baseline_window', 'thresholds', 'window', 'meta']) {
    ok(Object.prototype.hasOwnProperty.call(r, k), `D5 the payload ships '${k}'`);
  }
  eq(r.last_60.series.length, I.LAST_N_DAYS, `D5 the last-60 series is exactly ${I.LAST_N_DAYS} gap-free buckets`);
  eq(r.last_60.series[r.last_60.series.length - 1].key, YESTERDAY,
    'D5 …ending on the JUDGED day (yesterday, the last complete one) — not the partial today');
  ok(r.last_60.metrics.every((m) => Object.prototype.hasOwnProperty.call(r.last_60.series[0], m)),
    'D5 …and every metric it names is actually on the points');
  eq(r.detectors.length, 6, 'D5 all six detectors report whether they ran');
  ok(r.detectors.filter((d) => d.fired).length === r.insights.length,
    'D5 …and the fired flags agree with the card list');
  eq(r.partial, false, 'D5 the default (settled-day) read is NOT partial');
  eq(r.meta.partial_suppressed, 0, 'D5 …and suppresses nothing');
  ok(r.detectors.every((d) => d.suppressed === false), 'D5 …no detector is marked suppressed');

  // Deep links must be POSTable by the explorer, i.e. legal for the engine.
  for (const c of r.insights) {
    if (c.deep_link.page !== 'explorer') continue;
    const p = c.deep_link.params;
    const probe = await M.runQuery({
      metrics: p.metrics.split(','),
      window: { start_day: p.start_day, end_day: p.end_day },
      granularity: 'day',
      filters: p.funnel_id ? { funnel_id: p.funnel_id } : {},
    }, { query: q });
    ok(Array.isArray(probe.series),
      `D6 [${c.kind}] its deep link is a query the ENGINE ACTUALLY ACCEPTS (${p.metrics} over ${p.start_day}→${p.end_day})`);
  }

  // Scoping: a funnel filter must reach every read.
  const scoped = await runInsights({ funnel_id: 'f2' }, { query: q });
  ok(!scoped.insights.some((c) => c.kind === 'funnel_leak'),
    'D7 scoped to f2 (which has no pages) the leak detector finds nothing — the filter reached the step read');
  ok(!scoped.insights.some((c) => c.kind === 'dead_rail'),
    'D7 …and f2 has no pixel, so the rail detector is quiet too');
}

// ═══════════════════════════════════════════════════════════════════════════
// G. THE PARTIAL CURRENT DAY — the reviewer's bug, end to end
// ═══════════════════════════════════════════════════════════════════════════
//
// Requesting TODAY judges a bucket that is still filling. The SAME detectors
// that fired a red "net sales dropped" card on the settled day (section D) run
// again here — but every DOWNWARD card must be withheld, or a normal
// in-progress morning renders a confident alarm that is a clock artifact, not
// the business. This is the reviewer's exact scenario, proven end to end.

{
  const rP = await runInsights({ day: TODAY }, { query: q });
  console.log(`      partial-day fired: ${JSON.stringify(rP.insights.map((c) => `${c.kind}:${c.severity}:${c.direction}`))}`);

  eq(rP.day, TODAY, 'G1 requesting today judges today…');
  eq(rP.partial, true, 'G1 …and the payload flags it partial');

  // THE HEADLINE GUARANTEE: not one downward card, at any severity.
  ok(!rP.insights.some((c) => c.direction === 'down'),
    `G2 NO downward card survives a partial day (${rP.insights.map((c) => `${c.kind}:${c.direction}`).join(', ')})`);
  ok(!rP.insights.some((c) => c.severity === 'bad' && c.kind === 'anomaly'),
    'G2 …specifically the red "net sales dropped" card the reviewer proved is GONE');

  // LOAD-BEARING PROOF that the guard did work, not that today was normal: the
  // anomaly detector RAN, did not fire, and is marked SUPPRESSED — i.e. it
  // found a downward outlier and the guard withheld it. Without the guard this
  // would be the same bad card section D observed on the settled day.
  const anomalyRow = rP.detectors.find((d) => d.kind === 'anomaly');
  ok(anomalyRow && anomalyRow.ran === true && anomalyRow.fired === false && anomalyRow.suppressed === true,
    `G3 the anomaly detector RAN, was withheld, and SAYS SO (ran/fired/suppressed = ${JSON.stringify([anomalyRow?.ran, anomalyRow?.fired, anomalyRow?.suppressed])})`);
  ok(rP.meta.partial_suppressed >= 1,
    `G3 …and meta.partial_suppressed counts the withheld card(s) (${rP.meta.partial_suppressed})`);

  // The suppression is NAMED, not silent — an operator sees WHY the strip is quiet.
  ok(rP.meta.warnings.some((w) => w.source === 'today_partial'),
    'G4 a today_partial warning explains the withholding');

  // NEUTRAL and UPWARD findings SURVIVE — the guard is a scalpel, not a mute
  // button. The token-less pixel (a config problem, direction neutral) still
  // fires on the partial day.
  ok(rP.insights.some((c) => c.kind === 'dead_rail'),
    'G5 the dead-rail card (neutral, a config problem) SURVIVES a partial day');

  // THE MIRROR TEST: the SAME numbers, judged as a COMPLETE day, DO produce the
  // bad card. Section D already proved the settled day fires it; assert the
  // linkage explicitly so a future change that stops the settled day firing
  // cannot make G2 pass vacuously.
  const rSettled = await runInsights({ day: YESTERDAY }, { query: q });
  ok(rSettled.insights.some((c) => c.kind === 'anomaly' && c.severity === 'bad' && c.direction === 'down'),
    'G6 MIRROR the identical detector DOES fire a bad downward anomaly on the SETTLED day — '
    + 'so G2 is suppression at work, not an absence of signal');
  eq(rSettled.partial, false, 'G6 …and that settled read is not partial');
}

// ═══════════════════════════════════════════════════════════════════════════
// E. REFUSALS AND DEGRADATION
// ═══════════════════════════════════════════════════════════════════════════

{
  const refuses = async (body, code, m) => {
    try { await runInsights(body, { query: q }); ok(false, m, 'did not throw'); } catch (e) { ok(e && e.code === code, m, `code=${e && e.code}`); }
  };
  await refuses({ day: 'nope' }, 'invalid_day', 'E1 a malformed day is a 422, not an empty strip');
  await refuses({ day: '2026-02-30' }, 'invalid_day', 'E1 …and so is an impossible calendar date');
  await refuses({ day: dayAdd(TODAY, 1) }, 'day_in_future',
    'E1 a FUTURE day is refused — judging an unstarted day against a full baseline fires every '
    + 'downward detector at once');

  // A day with a short baseline is legal, and SAYS its baseline is short.
  const early = await runInsights({ day: dayAdd(TODAY, -59) }, { query: q });
  ok(early.meta.warnings.some((w) => w.source === 'baseline' || w.source === 'series'),
    'E2 a day whose baseline is mostly outside the fixture explains its own silence');

  // ── THE DEGRADATION PATH, run down its failure case (not merely claimed) ──
  await q(`ALTER TABLE lb_pixels RENAME TO lb_pixels_hidden`);
  await q(`ALTER TABLE lb_tracking_events RENAME TO lb_tracking_events_hidden`);
  const noRails = await runInsights({}, { query: q });
  ok(!noRails.insights.some((c) => c.kind === 'dead_rail'),
    'E3 with the tracking tables absent the rail detector produces no card');
  ok(noRails.meta.warnings.some((w) => w.source === 'tracking'),
    'E3 …and the ABSENCE IS NAMED — a quiet rail card and a missing rail table are different facts');
  eq(noRails.meta.degraded, [], 'E3 …and a to_regclass miss is a known absence, not a degradation');
  ok(noRails.insights.some((c) => c.kind === 'anomaly'),
    'E3 …while every other detector still runs (one dead read is not a dead strip)');
  await q(`ALTER TABLE lb_pixels_hidden RENAME TO lb_pixels`);
  await q(`ALTER TABLE lb_tracking_events_hidden RENAME TO lb_tracking_events`);

  // A read that genuinely EXPLODES must be caught and named, not 500 the page.
  let calls = 0;
  const flaky = async (text, params) => {
    calls += 1;
    if (/FROM lb_touches t\s*\n?\s*JOIN funnel_pages/.test(text)) throw new Error('boom: step read exploded');
    return q(text, params);
  };
  const degraded = await runInsights({}, { query: flaky });
  ok(calls > 0, 'E4 (control) the injected handle really was used');
  ok(degraded.meta.degraded.some((d) => d.source === 'steps'),
    `E4 a read that THROWS is caught and NAMED in meta.degraded (${JSON.stringify(degraded.meta.degraded)})`);
  ok(!degraded.insights.some((c) => c.kind === 'funnel_leak'),
    'E4 …the leak card is absent rather than fabricated');
  ok(degraded.insights.some((c) => c.kind === 'anomaly'),
    'E4 …and the rest of the strip is unaffected');
}

// ═══════════════════════════════════════════════════════════════════════════
// F. COST — this runs on a two-connection pool beside the money path
// ═══════════════════════════════════════════════════════════════════════════

{
  const times = [];
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now();
    await runInsights({}, { query: q });
    times.push(Date.now() - t);
  }
  console.log(`      runInsights: ${times.join('ms ')}ms`);
  ok(true, `F1 insight composite timing recorded: ${times.join('/')}ms`);

  const ct = [];
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now();
    await computeCohorts({ start: dayAdd(TODAY, -89), end: TODAY }, { query: q });
    ct.push(Date.now() - t);
  }
  console.log(`      computeCohorts (90d): ${ct.join('ms ')}ms`);
  ok(true, `F2 cohort timing recorded: ${ct.join('/')}ms`);
}

await sql.end({ timeout: 5 });
console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
