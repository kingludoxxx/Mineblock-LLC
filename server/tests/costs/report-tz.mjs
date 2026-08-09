// Report-timezone bucketing (Europe/Madrid) — pure-function proofs.
// The operator's Meta ad account + Shopify store report in Madrid time;
// these pin the day-boundary and DST behavior the P&L now shares.
import { reportDayKey, reportDayStartIso, reportDaysAgo, REPORT_TZ } from '../../src/services/reportTz.js';
import { dayKey } from '../../src/services/funnelCosts.js';

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, extra); } };

ok(REPORT_TZ === 'Europe/Madrid', `REPORT_TZ default is Europe/Madrid (${REPORT_TZ})`);

// Summer (CEST, UTC+2): 23:30Z belongs to the NEXT Madrid day.
ok(reportDayKey('2026-08-09T23:30:00Z') === '2026-08-10', 'summer 23:30Z → next Madrid day', reportDayKey('2026-08-09T23:30:00Z'));
ok(reportDayKey('2026-08-09T21:59:00Z') === '2026-08-09', 'summer 21:59Z → same Madrid day');
ok(reportDayKey('2026-08-09T22:00:00Z') === '2026-08-10', 'summer 22:00Z is the boundary');

// Winter (CET, UTC+1): boundary moves to 23:00Z.
ok(reportDayKey('2026-01-15T23:30:00Z') === '2026-01-16', 'winter 23:30Z → next Madrid day');
ok(reportDayKey('2026-01-15T22:30:00Z') === '2026-01-15', 'winter 22:30Z → same Madrid day');

// funnelCosts.dayKey delegates (and passes day strings through untouched).
ok(dayKey('2026-08-09T23:30:00Z') === '2026-08-10', 'funnelCosts.dayKey uses report tz');
ok(dayKey('2026-06-10') === '2026-06-10', 'day strings pass through');

// Day-start instants (UTC) for Madrid midnights.
ok(reportDayStartIso('2026-08-09') === '2026-08-08T22:00:00.000Z', 'summer day start = 22:00Z prior day', reportDayStartIso('2026-08-09'));
ok(reportDayStartIso('2026-01-15') === '2026-01-14T23:00:00.000Z', 'winter day start = 23:00Z prior day', reportDayStartIso('2026-01-15'));

// DST transitions 2026: spring forward Mar 29, fall back Oct 25.
ok(reportDayStartIso('2026-03-29') === '2026-03-28T23:00:00.000Z', 'spring-forward day starts on CET', reportDayStartIso('2026-03-29'));
ok(reportDayStartIso('2026-03-30') === '2026-03-29T22:00:00.000Z', 'day after spring-forward starts on CEST', reportDayStartIso('2026-03-30'));
ok(reportDayStartIso('2026-10-25') === '2026-10-24T22:00:00.000Z', 'fall-back day starts on CEST', reportDayStartIso('2026-10-25'));
ok(reportDayStartIso('2026-10-26') === '2026-10-25T23:00:00.000Z', 'day after fall-back starts on CET', reportDayStartIso('2026-10-26'));

// The 23h/25h transition days still cover every instant exactly once:
{
  const s1 = Date.parse(reportDayStartIso('2026-03-29'));
  const e1 = Date.parse(reportDayStartIso('2026-03-30'));
  ok(e1 - s1 === 23 * 3600000, 'spring-forward day is 23h', String((e1 - s1) / 3600000));
  const s2 = Date.parse(reportDayStartIso('2026-10-25'));
  const e2 = Date.parse(reportDayStartIso('2026-10-26'));
  ok(e2 - s2 === 25 * 3600000, 'fall-back day is 25h', String((e2 - s2) / 3600000));
}

// Calendar arithmetic is tz-neutral and DST-safe.
ok(reportDaysAgo(1, '2026-03-30') === '2026-03-29', 'daysAgo crosses spring DST cleanly');
ok(reportDaysAgo(-1, '2026-10-24') === '2026-10-25', 'daysAgo crosses fall DST cleanly');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
