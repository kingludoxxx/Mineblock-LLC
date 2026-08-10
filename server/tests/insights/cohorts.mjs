// COHORT MATH verification — drives the REAL `foldCohorts` / `cohortsCsv` /
// `validateCohortQuery` from services/funnelCohorts.js against a KNOWN-ANSWER
// TABLE (LANE 5, verification only). No database.
//
// ── WHY A KNOWN-ANSWER TABLE AND NOT A CAPTURE ──────────────────────────────
//
// A captured cohort payload proves the SHAPE of the answer. It cannot prove the
// ARITHMETIC, because to check the arithmetic you have to already know what the
// answer should be — and the only way to know that is to work it out by hand
// from a table small enough to hold in your head.
//
// So every expected number below is DERIVED IN THE COMMENT ABOVE IT, from the
// fixture rows, by hand. If the fold changes, the comment is the thing that
// says whether the new number is a fix or a regression. (The SQL that feeds the
// fold is verified separately, by execution, in ./service.mjs.)
//
// ── THE FIXTURE ─────────────────────────────────────────────────────────────
//
//   today = 2026-03-01
//
//   cohort 2026-01-01 (59 days old on `today` — aged at every horizon)
//     A  first_day 2026-01-01   $100 @ d0 · $50 @ d4 · $25 @ d24
//     B  first_day 2026-01-01   $200 @ d0
//   cohort 2026-02-01 (28 days old — aged at D0 and D7, NOT at D30)
//     C  first_day 2026-02-01   $60  @ d0 · $40 @ d2
//
// Run:  node server/tests/insights/cohorts.mjs
import { readFileSync } from 'node:fs';

process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const C = await import('../../src/services/funnelCohorts.js');
const {
  foldCohorts, cohortsCsv, validateCohortQuery, dayDiff,
  HORIZONS, GROUP_BYS, MAX_BUYERS, MAX_WINDOW_DAYS, MONEY_MOVED_SQL,
} = C;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
);
const throws = (fn, code, m) => {
  try { fn(); ok(false, m, 'did not throw'); } catch (e) { ok(e && e.code === code, m, `code=${e && e.code}`); }
};

const TODAY = '2026-03-01';

const BUYERS = [
  { email: 'a@x.com', first_day: '2026-01-01', funnel_id: 'f1', funnel_label: 'Alpha funnel', campaign: 'spring' },
  { email: 'b@x.com', first_day: '2026-01-01', funnel_id: 'f1', funnel_label: 'Alpha funnel', campaign: 'spring' },
  { email: 'c@x.com', first_day: '2026-02-01', funnel_id: 'f2', funnel_label: 'Beta funnel', campaign: 'summer' },
];
const REVENUE = [
  { email: 'a@x.com', day: '2026-01-01', total: 100 },
  { email: 'a@x.com', day: '2026-01-05', total: 50 },
  { email: 'a@x.com', day: '2026-01-25', total: 25 },
  { email: 'b@x.com', day: '2026-01-01', total: 200 },
  { email: 'c@x.com', day: '2026-02-01', total: 60 },
  { email: 'c@x.com', day: '2026-02-03', total: 40 },
];

console.log('\n== cohort math (known-answer table) ==\n');

/* ═══ 0. PINS ═══ */

{
  const src = readFileSync(new URL('../../src/services/funnelMetrics.js', import.meta.url), 'utf8');
  ok(src.includes(MONEY_MOVED_SQL),
    'PIN funnelMetrics.js carries the identical MONEY_MOVED predicate this lane duplicates');
  ok(!MONEY_MOVED_SQL.includes("'processing'"),
    'PIN the predicate can never see a processing row (intent is not money)');
  // ⚠️ CASE-SENSITIVE, and that is not a shortcut. Every SQL keyword in this
  // codebase is upper-case, while `drop`, `create` and `update` are ordinary
  // English words that appear all over the leak detector's prose and its local
  // variables — a case-insensitive scan flags `const drop = …` as a DROP
  // statement and the pin becomes noise that gets deleted. Comments (line AND
  // block) are stripped first so a paragraph ABOUT writes is not a write.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|COPY)\s/;
  for (const file of ['services/funnelCohorts.js', 'services/funnelInsights.js', 'routes/funnelInsights.js']) {
    const src = stripComments(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'));
    ok(!WRITE_SQL.test(src), `PIN ${file} contains no write statement of any kind`);
  }
  const routeSrc = readFileSync(new URL('../../src/routes/funnelInsights.js', import.meta.url), 'utf8');
  ok(!/router\.(post|put|patch|delete)\s*\(/.test(routeSrc),
    'PIN the insight router exposes no write verb');
  // The negative control for the pin above: a file that DOES write must trip it,
  // or the scan is proving nothing about the three files that must not.
  const writer = stripComments(readFileSync(new URL('../../src/services/trackingSchema.js', import.meta.url), 'utf8'));
  ok(WRITE_SQL.test(writer),
    'PIN (negative control) the same scan DOES flag a file that really writes');
}

/* ═══ 1. dayDiff — everything below is built on it ═══ */

eq(dayDiff('2026-01-01', '2026-01-01'), 0, '1 the same day is zero days apart');
eq(dayDiff('2026-01-01', '2026-01-05'), 4, '1 four days');
eq(dayDiff('2026-01-01', '2026-01-25'), 24, '1 twenty-four days');
eq(dayDiff('2026-01-01', '2026-03-01'), 59, '1 Jan 1 → Mar 1 2026 is 59 days (31 + 28, not a leap year)');
eq(dayDiff('2026-02-01', '2026-03-01'), 28, '1 Feb 1 → Mar 1 is 28 days');
eq(dayDiff('2026-01-05', '2026-01-01'), -4, '1 …and it is signed, so pre-acquisition revenue is negative');
// The Madrid DST days are 23h and 25h long. dayDiff must still count CALENDAR
// days, or every cohort spanning late March would be off by one.
eq(dayDiff('2026-03-28', '2026-03-30'), 2, '1 two calendar days across the Madrid spring DST change');
eq(dayDiff('2026-10-24', '2026-10-26'), 2, '1 …and across the autumn one');

/* ═══ 2. THE KNOWN-ANSWER TABLE — group_by day, horizons [0,7,30] ═══ */

{
  const r = foldCohorts({ buyers: BUYERS, revenue: REVENUE, today: TODAY, horizons: [0, 7, 30], groupBy: 'day' });

  eq(r.cohorts.length, 2, '2 two acquisition days ⇒ two cohorts');
  // group_by=day sorts DESCENDING, newest cohort first.
  eq(r.cohorts.map((c) => c.key), ['2026-02-01', '2026-01-01'],
    '2 day cohorts are newest-first');

  const jan = r.cohorts.find((c) => c.key === '2026-01-01');
  const feb = r.cohorts.find((c) => c.key === '2026-02-01');

  eq(jan.size, 2, '2 [Jan] size 2');
  // Jan buyers are 59 days old on 2026-03-01 → aged at 0, 7 and 30.
  eq(jan.aged, [2, 2, 2], '2 [Jan] aged [2,2,2] — 59 days old clears every horizon');
  // D0  = (100 + 200) / 2                = 150.00
  // D7  = (100 + 50 + 200) / 2           = 175.00   ($25 is at d24, outside D7)
  // D30 = (100 + 50 + 25 + 200) / 2      = 187.50
  eq(jan.ltv, [150, 175, 187.5], '2 [Jan] ltv [150.00, 175.00, 187.50] — worked out in the header');
  // D0  = 100% by definition
  // D7  = A repeated at d4, B never  ⇒ 1/2 = 50.0
  // D30 = A repeated at d4 and d24   ⇒ 1/2 = 50.0
  eq(jan.retention, [100, 50, 50], '2 [Jan] retention [100.0, 50.0, 50.0]');
  // 100 + 50 + 25 + 200
  eq(jan.revenue_to_date, 375, '2 [Jan] revenue_to_date 375.00');

  eq(feb.size, 1, '2 [Feb] size 1');
  // C is 28 days old: aged at D0 and D7, NOT at D30.
  eq(feb.aged, [1, 1, 0], '2 [Feb] aged [1,1,0] — 28 days old cannot have a D30');
  // D0 = 60 / 1 = 60.00 ; D7 = (60 + 40) / 1 = 100.00 ; D30 = UN-AGED
  eq(feb.ltv, [60, 100, null], '2 [Feb] ltv [60.00, 100.00, null]');
  eq(feb.retention, [100, 100, null], '2 [Feb] retention [100.0, 100.0, null] — C repeated at d2');
  ok(feb.ltv[2] === null, '2 [Feb] THE AGING GUARD: the un-reached horizon is null');
  ok(feb.ltv[2] !== 0, '2 …and emphatically NOT $0.00, which would read as "came back with nothing"');
  eq(feb.revenue_to_date, 100, '2 [Feb] revenue_to_date 100.00');

  // ── the size-weighted average, over the AGED population at each horizon ──
  // D0  ltv: (150×2 + 60×1) / 3   = 360/3 = 120.00
  // D7  ltv: (175×2 + 100×1) / 3  = 450/3 = 150.00
  // D30 ltv: only Jan is aged     = 187.50
  eq(r.average.ltv, [120, 150, 187.5], '2 AVG ltv [120.00, 150.00, 187.50] — weighted by AGED buyers');
  // D0  ret: (100×2 + 100×1)/3 = 100.0
  // D7  ret: (50×2 + 100×1)/3  = 200/3 = 66.666… → 66.7
  // D30 ret: only Jan aged     = 50.0
  eq(r.average.retention, [100, 66.7, 50], '2 AVG retention [100.0, 66.7, 50.0]');
  eq(r.average.aged, [3, 3, 2],
    '2 AVG the D30 average is weighted over 2 buyers, not 3 — the un-aged cohort is EXCLUDED, not zeroed');
}

/* ═══ 3. THE RULES THE AVERAGE WOULD BE WRONG WITHOUT ═══ */

{
  // A second order on the ACQUISITION DAY is the same purchase occasion.
  const r = foldCohorts({
    buyers: [{ email: 'd@x.com', first_day: '2026-01-01' }],
    revenue: [
      { email: 'd@x.com', day: '2026-01-01', total: 50 },
      { email: 'd@x.com', day: '2026-01-01', total: 30 },
    ],
    today: TODAY, horizons: [0, 7], groupBy: 'day',
  });
  eq(r.cohorts[0].ltv, [80, 80], '3 two orders on day 0 both COUNT toward LTV (80.00)');
  eq(r.cohorts[0].retention, [100, 0],
    '3 …but neither is a REPEAT — a repeat is a LATER day, so D7 retention is 0%, not 100%');

  // Revenue BEFORE the acquisition day belongs to no horizon.
  const pre = foldCohorts({
    buyers: [{ email: 'e@x.com', first_day: '2026-02-01' }],
    revenue: [
      { email: 'e@x.com', day: '2026-01-01', total: 999 },
      { email: 'e@x.com', day: '2026-02-01', total: 10 },
    ],
    today: TODAY, horizons: [0], groupBy: 'day',
  });
  eq(pre.cohorts[0].ltv, [10], '3 revenue at a NEGATIVE day offset is excluded from LTV');
  eq(pre.cohorts[0].revenue_to_date, 10, '3 …and from revenue_to_date');

  // A cohort acquired TODAY is aged at D0 only.
  const fresh = foldCohorts({
    buyers: [{ email: 'f@x.com', first_day: TODAY }],
    revenue: [{ email: 'f@x.com', day: TODAY, total: 42 }],
    today: TODAY, horizons: [0, 7, 30, 90], groupBy: 'day',
  });
  eq(fresh.cohorts[0].aged, [1, 0, 0, 0], '3 a cohort acquired TODAY is aged at D0 and nowhere else');
  eq(fresh.cohorts[0].ltv, [42, null, null, null], '3 …so only D0 has a figure');
  eq(fresh.average.ltv, [42, null, null, null],
    '3 …and the AVERAGE at an entirely un-aged horizon is null, never 0');

  // A buyer with NO revenue rows at all (possible when the money read is
  // narrower than the acquisition read) is $0 LTV, not a crash and not a skip.
  const noRev = foldCohorts({
    buyers: [{ email: 'g@x.com', first_day: '2026-01-01' }],
    revenue: [], today: TODAY, horizons: [0], groupBy: 'day',
  });
  eq(noRev.cohorts[0].ltv, [0], '3 an acquired buyer with no revenue rows folds to a MEASURED 0.00');
  eq(noRev.cohorts[0].size, 1, '3 …and still counts toward the cohort size');
}

/* ═══ 4. GROUPING ═══ */

{
  const byFunnel = foldCohorts({ buyers: BUYERS, revenue: REVENUE, today: TODAY, horizons: [0, 7], groupBy: 'funnel' });
  eq(byFunnel.cohorts.map((c) => c.key), ['f1', 'f2'], '4 funnel cohorts are keyed on the funnel id');
  eq(byFunnel.cohorts.map((c) => c.label), ['Alpha funnel', 'Beta funnel'],
    '4 …and LABELLED with the funnel name (the key stays the id — two funnels may share a name)');
  eq(byFunnel.cohorts.map((c) => c.revenue_to_date), [375, 100],
    '4 …sorted by revenue_to_date DESCENDING, not by key');
  // f1's two buyers are both 59 days old; f2's one is 28.
  eq(byFunnel.cohorts[0].aged, [2, 2], '4 f1 aged [2,2]');

  const byCampaign = foldCohorts({ buyers: BUYERS, revenue: REVENUE, today: TODAY, horizons: [0], groupBy: 'campaign' });
  eq(byCampaign.cohorts.map((c) => c.key), ['spring', 'summer'], '4 campaign cohorts key on the campaign');
  eq(byCampaign.cohorts[0].size, 2, '4 …and fold the two spring buyers into one cohort');

  // A buyer with no funnel / no campaign still lands somewhere NAMED.
  const anon = foldCohorts({
    buyers: [{ email: 'h@x.com', first_day: '2026-01-01' }],
    revenue: [], today: TODAY, horizons: [0], groupBy: 'funnel',
  });
  eq(anon.cohorts[0].key, '(none)', '4 a buyer with no funnel lands in an explicitly-named bucket');
}

/* ═══ 5. DEGENERATE INPUT — must fold, never throw ═══ */

{
  eq(foldCohorts({}).cohorts, [], '5 no arguments at all yields no cohorts');
  eq(foldCohorts({ buyers: [], revenue: [], today: TODAY }).average.ltv, [null, null, null, null],
    '5 an empty fold averages to nulls, never zeros');
  eq(foldCohorts({
    buyers: [null, undefined, {}, { email: 'x', first_day: 'nope' }],
    revenue: [null, { email: 'x' }, { email: 'x', day: 'nope', total: 5 }],
    today: TODAY, horizons: [0], groupBy: 'day',
  }).cohorts, [], '5 junk rows are dropped, not folded into a fake cohort');
  const badTotal = foldCohorts({
    buyers: [{ email: 'i@x.com', first_day: '2026-01-01' }],
    revenue: [{ email: 'i@x.com', day: '2026-01-01', total: 'not a number' }],
    today: TODAY, horizons: [0], groupBy: 'day',
  });
  eq(badTotal.cohorts[0].ltv, [0], '5 an unparseable total folds to 0, not NaN');
  // A revenue row for someone who is NOT in the cohort must not leak in.
  const stranger = foldCohorts({
    buyers: [{ email: 'j@x.com', first_day: '2026-01-01' }],
    revenue: [
      { email: 'j@x.com', day: '2026-01-01', total: 10 },
      { email: 'stranger@x.com', day: '2026-01-01', total: 9999 },
    ],
    today: TODAY, horizons: [0], groupBy: 'day',
  });
  eq(stranger.cohorts[0].ltv, [10], "5 a non-cohort buyer's revenue never reaches the fold");
}

/* ═══ 6. CSV ═══ */

{
  const result = {
    ...foldCohorts({ buyers: BUYERS, revenue: REVENUE, today: TODAY, horizons: [0, 7, 30], groupBy: 'day' }),
  };
  const csv = cohortsCsv(result);
  const lines = csv.trim().split('\n');
  eq(lines[0],
    'cohort,size,ltv_d0,ltv_d7,ltv_d30,retention_pct_d0,retention_pct_d7,retention_pct_d30,'
    + 'aged_buyers_d0,aged_buyers_d7,aged_buyers_d30,revenue_to_date',
    '6 the header names every horizon column and its unit');
  eq(lines.length, 4, '6 two cohort rows plus the header plus the average row');
  // QUOTED, because the label itself contains a comma. That is the RFC rule
  // doing its job, and asserting the bare prefix would have "passed" only until
  // someone removed the quoting and broke the column alignment of the file.
  eq(lines[3], '"AVERAGE (size-weighted, aged only)",3,120,150,187.5,100,66.7,50,3,3,2,',
    '6 the last row is the weighted average, RFC-quoted, and SAYS what it is weighted over');
  ok(lines[3].includes(',3,3,2,'),
    '6 …carrying the AGED denominators, so a reader can see D30 was averaged over 2 buyers and D7 over 3');

  const febLine = lines.find((l) => l.startsWith('2026-02-01'));
  eq(febLine, '2026-02-01,1,60,100,,100,100,,1,1,0,100',
    '6 THE UN-AGED CELL IS BLANK, never 0 — the same claim the null makes on the wire');
  const janLine = lines.find((l) => l.startsWith('2026-01-01'));
  eq(janLine, '2026-01-01,2,150,175,187.5,100,50,50,2,2,2,375', '6 …and a fully-aged row prints every figure');

  // FORMULA INJECTION — campaign and funnel names are attacker-supplied.
  const hostile = cohortsCsv({
    horizons: [0],
    cohorts: [
      { key: 'x', label: '=cmd|"/c calc"!A1', size: 1, ltv: [1], retention: [100], aged: [1], revenue_to_date: 1 },
      { key: 'y', label: '+SUM(A1)', size: 1, ltv: [1], retention: [100], aged: [1], revenue_to_date: 1 },
      { key: 'z', label: '@import', size: 1, ltv: [1], retention: [100], aged: [1], revenue_to_date: 1 },
      { key: 'w', label: 'Summer, "big" sale\nrow2', size: 1, ltv: [1], retention: [100], aged: [1], revenue_to_date: 1 },
    ],
    average: { ltv: [1], retention: [100], aged: [4] },
  });
  for (const prefix of ["'=cmd", "'+SUM", "'@import"]) {
    ok(hostile.includes(prefix), `6 INJECTION a cell starting "${prefix[1]}" is neutralised with a leading quote`);
  }
  ok(hostile.includes('"Summer, ""big"" sale\nrow2"'),
    '6 INJECTION a label with a comma, a quote and a newline is properly RFC-quoted');
  const hostileLines = hostile.split('\n');
  ok(!hostileLines.some((l) => /^=|^\+|^@/.test(l)),
    '6 INJECTION no CSV line can begin with a formula character');
}

/* ═══ 7. VALIDATION — refused BEFORE any SQL runs ═══ */

{
  const q = validateCohortQuery({});
  eq(q.group_by, 'day', '7 group_by defaults to the acquisition day');
  eq(q.horizons, HORIZONS, '7 horizons default to D0/D7/D30/D90');
  eq(q.days, 90, '7 the window defaults to 90 days');
  eq(q.funnel_id, null, '7 …and no funnel scope');

  eq(validateCohortQuery({ start: '2026-01-01', end: '2026-01-31' }).days, 31, '7 an explicit window is measured inclusively');
  eq(validateCohortQuery({ horizons: '0,30' }).horizons, [0, 30], '7 horizons parse from a CSV string');
  eq(validateCohortQuery({ horizons: [30, 0, 30] }).horizons, [0, 30], '7 …deduped and sorted ascending');
  eq(validateCohortQuery({ funnel_id: '  f1  ' }).funnel_id, 'f1', '7 a funnel id is trimmed');
  eq(validateCohortQuery({ group_by: 'campaign' }).group_by, 'campaign', '7 a real group_by is kept');

  throws(() => validateCohortQuery({ start: 'nope' }), 'invalid_date_format', '7 REFUSE a malformed start');
  throws(() => validateCohortQuery({ end: '2026-02-30' }), 'invalid_date', '7 REFUSE an impossible calendar date');
  throws(() => validateCohortQuery({ start: '2026-02-01', end: '2026-01-01' }), 'to_before_from', '7 REFUSE a reversed window');
  throws(() => validateCohortQuery({ start: '2020-01-01', end: '2026-01-01' }), 'window_too_large', `7 REFUSE a window over ${MAX_WINDOW_DAYS} days`);
  throws(() => validateCohortQuery({ group_by: 'zodiac' }), 'unknown_group_by', '7 REFUSE an unknown group_by (never silently falls back)');
  throws(() => validateCohortQuery({ horizons: '-1' }), 'bad_horizon', '7 REFUSE a negative horizon');
  throws(() => validateCohortQuery({ horizons: '9999' }), 'bad_horizon', '7 REFUSE a horizon past the ceiling');
  throws(() => validateCohortQuery({ horizons: 'nope' }), 'bad_horizon', '7 REFUSE an unparseable horizon');
  throws(() => validateCohortQuery({ horizons: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), 'too_many_horizons', '7 REFUSE more horizons than the table can carry');
  throws(() => validateCohortQuery([]), 'bad_body', '7 REFUSE a non-object query');

  ok(GROUP_BYS.length === 3 && MAX_BUYERS === 20000,
    `7 the published caps are what the service enforces (group_bys=${GROUP_BYS.length}, max_buyers=${MAX_BUYERS})`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
