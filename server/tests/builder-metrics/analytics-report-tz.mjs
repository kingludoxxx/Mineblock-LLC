// Funnel-analytics report-timezone bounds — pure-function + stubbed-query proofs.
//
// Style follows server/tests/costs/report-tz.mjs. What these pin: funnelAnalytics
// computes its window bounds and day keys in REPORT_TZ (Europe/Madrid) via
// services/reportTz.js, exactly like funnelCosts/funnelSpend, so a 23:30Z order
// lands on the same Madrid day on every dashboard surface.
//
// STORAGE stays UTC — every bound below is a UTC instant. Only WHICH instant
// changed.
process.env.REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const { parseWindow, getFunnelLive } = await import('../../src/services/funnelAnalytics.js');
const { reportDayKey, reportDayStartIso, reportDaysAgo, REPORT_TZ } = await import(
  '../../src/services/reportTz.js'
);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('PASS ', m); }
  else { fail++; console.log('FAIL ', m, extra); }
};

const iso = (d) => d.toISOString();
const naiveUtc = (day) => `${day}T00:00:00.000Z`;

ok(REPORT_TZ === 'Europe/Madrid', `REPORT_TZ is Europe/Madrid (${REPORT_TZ})`);

// ── A. BOUNDS ARE REPORT-TZ MIDNIGHTS, NOT UTC MIDNIGHTS ────────────────────
{
  const w = parseWindow({ from: '2026-08-09', to: '2026-08-09' });
  ok(w.ok === true, 'A1 summer single-day window parses');
  ok(iso(w.fromTs) === '2026-08-08T22:00:00.000Z',
    'A2 summer left edge = Madrid midnight (22:00Z prior day)', iso(w.fromTs));
  ok(iso(w.toTs) === '2026-08-09T22:00:00.000Z',
    'A3 summer right edge = next Madrid midnight, half-open', iso(w.toTs));
  ok(w.days === 1, 'A4 single day counts as 1', String(w.days));

  // The whole point: the bound is NOT the naive string-concat UTC midnight.
  ok(iso(w.fromTs) !== naiveUtc('2026-08-09'),
    'A5 left edge is NOT `from`+"T00:00:00Z" (string concat is gone)');
  ok(iso(w.fromTs) === reportDayStartIso('2026-08-09'),
    'A6 left edge comes from reportDayStartIso verbatim');
  ok(iso(w.toTs) === reportDayStartIso(reportDaysAgo(-1, '2026-08-09')),
    'A7 right edge is reportDayStartIso(to + 1 calendar day)');
}
{
  const w = parseWindow({ from: '2026-01-15', to: '2026-01-15' });
  ok(iso(w.fromTs) === '2026-01-14T23:00:00.000Z',
    'A8 winter left edge = Madrid midnight (23:00Z prior day)', iso(w.fromTs));
  ok(iso(w.toTs) === '2026-01-15T23:00:00.000Z',
    'A9 winter right edge tracks CET, not a frozen offset', iso(w.toTs));
  ok(iso(w.fromTs) !== naiveUtc('2026-01-15'), 'A10 winter edge is not naive UTC either');
}

// ── B. THE 23:30Z ORDER — THE BUG THIS CHANGE EXISTS TO FIX ─────────────────
// Summer (CEST, UTC+2): 23:30Z on Aug 9 is 01:30 Madrid on Aug 10.
{
  const order = Date.parse('2026-08-09T23:30:00Z');
  const inside = (w) => order >= w.fromTs.getTime() && order < w.toTs.getTime();

  const aug9 = parseWindow({ from: '2026-08-09', to: '2026-08-09' });
  const aug10 = parseWindow({ from: '2026-08-10', to: '2026-08-10' });
  ok(!inside(aug9), 'B1 23:30Z order is NOT in the Madrid Aug-9 window');
  ok(inside(aug10), 'B2 23:30Z order IS in the Madrid Aug-10 window (next day)');
  ok(reportDayKey('2026-08-09T23:30:00Z') === '2026-08-10',
    'B3 …and the day key agrees with the window (one authority)');

  // Under the old UTC bounds it would have landed on Aug 9 — assert the
  // regression is actually reachable, so this test cannot pass vacuously.
  const oldAug9Start = Date.parse(naiveUtc('2026-08-09'));
  const oldAug9End = oldAug9Start + 86_400_000;
  ok(order >= oldAug9Start && order < oldAug9End,
    'B4 CONTROL: the same order DID fall on Aug 9 under UTC bounds (bug was real)');
}
// Summer boundary is exactly 22:00Z.
{
  const aug10 = parseWindow({ from: '2026-08-10', to: '2026-08-10' });
  ok(Date.parse('2026-08-09T22:00:00Z') === aug10.fromTs.getTime(),
    'B5 22:00Z is the exact summer day boundary (inclusive left)');
  ok(Date.parse('2026-08-09T21:59:59Z') < aug10.fromTs.getTime(),
    'B6 21:59:59Z is still the previous Madrid day');
}
// Winter boundary moves to 23:00Z — a fixed offset would fail one of B5/B7.
{
  const jan16 = parseWindow({ from: '2026-01-16', to: '2026-01-16' });
  ok(Date.parse('2026-01-15T23:00:00Z') === jan16.fromTs.getTime(),
    'B7 23:00Z is the exact winter day boundary', iso(jan16.fromTs));
  ok(Date.parse('2026-01-15T23:30:00Z') >= jan16.fromTs.getTime(),
    'B8 winter 23:30Z order lands on the NEXT Madrid day');
}

// ── C. DST: THE 23-HOUR AND 25-HOUR DAYS ───────────────────────────────────
// Europe/Madrid 2026: spring forward Mar 29, fall back Oct 25.
{
  const spring = parseWindow({ from: '2026-03-29', to: '2026-03-29' });
  const span = spring.toTs - spring.fromTs;
  ok(span === 23 * 3_600_000, 'C1 spring-forward day window is 23h', String(span / 3_600_000));
  ok(spring.days === 1, 'C2 …and still counts as exactly 1 day', String(spring.days));

  const fall = parseWindow({ from: '2026-10-25', to: '2026-10-25' });
  const span2 = fall.toTs - fall.fromTs;
  ok(span2 === 25 * 3_600_000, 'C3 fall-back day window is 25h', String(span2 / 3_600_000));
  ok(fall.days === 1, 'C4 …and still counts as exactly 1 day', String(fall.days));
}
// A window spanning a transition must not drift a day (the +86_400_000 bug).
{
  const w = parseWindow({ from: '2026-03-28', to: '2026-03-30' });
  ok(w.days === 3, 'C5 3-day window across spring-forward counts 3 days', String(w.days));
  ok(w.toTs - w.fromTs === 71 * 3_600_000,
    'C6 …spanning 71h, not 72h', String((w.toTs - w.fromTs) / 3_600_000));

  const w2 = parseWindow({ from: '2026-10-24', to: '2026-10-26' });
  ok(w2.days === 3, 'C7 3-day window across fall-back counts 3 days', String(w2.days));
  ok(w2.toTs - w2.fromTs === 73 * 3_600_000,
    'C8 …spanning 73h, not 72h', String((w2.toTs - w2.fromTs) / 3_600_000));
}

// ── D. CONSECUTIVE WINDOWS TILE EXACTLY (no gap, no double-count) ──────────
// Half-open bounds mean day N's right edge must EQUAL day N+1's left edge,
// including across both DST transitions.
{
  let tiled = 0, broken = [];
  for (const start of ['2026-03-27', '2026-10-23']) {
    let day = start;
    for (let i = 0; i < 5; i++) {
      const next = reportDaysAgo(-1, day);
      const a = parseWindow({ from: day, to: day });
      const b = parseWindow({ from: next, to: next });
      if (a.toTs.getTime() === b.fromTs.getTime()) tiled++;
      else broken.push(`${day}->${next}`);
      day = next;
    }
  }
  ok(broken.length === 0 && tiled === 10,
    `D1 10 consecutive day-windows tile exactly across both DST edges (${tiled}/10)`,
    broken.join(','));
}

// ── E. DEFAULTS ARE REPORT-TZ DAYS ────────────────────────────────────────
{
  const w = parseWindow({});
  ok(w.ok === true, 'E1 empty window parses to defaults');
  ok(w.to === reportDayKey(), 'E2 default `to` is the Madrid today', `${w.to} vs ${reportDayKey()}`);
  ok(w.from === reportDaysAgo(29, reportDayKey()),
    'E3 default `from` is 29 Madrid days back', w.from);
  ok(w.days === 30, 'E4 default window is 30 days', String(w.days));
  ok(/^\d{4}-\d{2}-\d{2}$/.test(w.from) && /^\d{4}-\d{2}-\d{2}$/.test(w.to),
    'E5 default keys keep YYYY-MM-DD format (response contract)');
}

// ── F. VALIDATION IS UNCHANGED (regressions the retz could have caused) ────
{
  ok(parseWindow({ from: 'nope', to: '2026-08-09' }).error === 'invalid_date_format',
    'F1 malformed input still refused');
  ok(parseWindow({ from: '2026-02-31', to: '2026-03-01' }).error === 'invalid_date',
    'F2 impossible calendar date still refused (no silent roll to Mar 3)');
  ok(parseWindow({ from: '2026-01-32', to: '2026-02-01' }).error === 'invalid_date',
    'F3 out-of-range day still refused');
  ok(parseWindow({ from: '2026-08-10', to: '2026-08-09' }).error === 'to_before_from',
    'F4 reversed window still refused');
  ok(parseWindow({ from: '2024-01-01', to: '2026-08-09' }).error === 'window_too_large',
    'F5 oversized window still refused (>400d)');
  ok(parseWindow({ from: '2026-02-29', to: '2026-03-01' }).error === 'invalid_date',
    'F6 non-leap Feb 29 refused (2026 is not a leap year)');
  // A valid leap day must still be ACCEPTED — the guard must not over-refuse.
  ok(parseWindow({ from: '2024-02-29', to: '2024-02-29' }).ok === true,
    'F7 real leap day 2024-02-29 accepted');
}

// ── G. RESPONSE SHAPE: format preserved, timezone disclosed ────────────────
{
  const w = parseWindow({ from: '2026-08-09', to: '2026-08-10' });
  ok(w.from === '2026-08-09' && w.to === '2026-08-10',
    'G1 day keys are echoed verbatim in YYYY-MM-DD (format unchanged)');
  ok(typeof w.days === 'number' && Number.isInteger(w.days),
    'G2 `days` is still an integer');
  ok(w.fromTs instanceof Date && w.toTs instanceof Date,
    'G3 bounds are still Date objects (bound params, never concatenated into SQL)');
}

// ── H. LIVE CHIP counts since REPORT-TZ midnight, not UTC midnight ─────────
{
  let bound = null;
  const q = async (_sql, params) => { bound = params; return [{ live: 3, unique_today: 7 }]; };
  const r = await getFunnelLive({ funnelId: 'f1' }, { query: q });

  ok(r.live === 3 && r.unique_today === 7, 'H1 live chip returns both counts');
  ok(r.timezone === REPORT_TZ, 'H2 response discloses the report timezone', String(r.timezone));
  ok(/report-tz midnight/.test(r.basis.unique_today),
    'H3 basis names report-tz midnight, not UTC midnight', r.basis.unique_today);
  ok(Array.isArray(bound) && bound.length === 2,
    'H4 day start is a BOUND PARAMETER, not inlined SQL', JSON.stringify(bound));
  ok(bound?.[1] instanceof Date, 'H5 …and it is a Date', String(bound?.[1]));
  ok(bound?.[1]?.toISOString?.() === reportDayStartIso(reportDayKey()),
    'H6 bound instant is exactly report-tz midnight today', String(bound?.[1]?.toISOString?.()));
  // It must differ from UTC midnight — Madrid is never UTC+0.
  const utcMidnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  ok(bound?.[1]?.getTime?.() !== utcMidnight.getTime() || REPORT_TZ === 'UTC',
    'H7 report-tz midnight differs from UTC midnight (Madrid is never UTC+0)');
  ok(r.degraded === false && r.warnings.length === 0, 'H8 healthy read is not degraded');
}

// ── I. EDGE CASES: the live chip must not crash on a dead source ───────────
{
  const dead = async () => { throw new Error('relation "lb_touches" does not exist'); };
  const r = await getFunnelLive({ funnelId: 'f1' }, { query: dead });
  ok(r.live === null && r.unique_today === null,
    'I1 dead source degrades to null, never 0 (0 means "no traffic")');
  ok(r.degraded === true && r.warnings.length > 0, 'I2 degradation is named, not silent');
  ok(r.timezone === REPORT_TZ, 'I3 timezone still disclosed on the degraded path');

  const bad = await getFunnelLive({ funnelId: '' }, { query: async () => [] });
  ok(bad.error === 'invalid_funnel_id', 'I4 empty funnel id refused');

  const empty = await getFunnelLive({ funnelId: 'f1' }, { query: async () => [] });
  ok(empty.live === null && empty.unique_today === null,
    'I5 empty result set degrades cleanly instead of throwing');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
