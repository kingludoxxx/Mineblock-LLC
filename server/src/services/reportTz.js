// REPORTING TIMEZONE — single authority for how instants become report days.
//
// OPERATOR DECISION (2026-08-09): reports bucket in Europe/Madrid, matching
// the Shopify store AND the Meta ad account. Meta's insights API returns
// spend rows already bucketed by the AD ACCOUNT's timezone, so lb_ad_spend_daily
// meta rows are Madrid days — revenue must bucket the same way or every
// day-boundary ROAS disagrees with Ads Manager.
//
// STORAGE stays UTC everywhere; only REPORT bucketing and window bounds use
// this module. DST is handled by Intl (the double-offset refinement below
// covers the two transition days). Env-overridable for tests/other operators.
const REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

const DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

// tz wall-clock offset (ms) at a given UTC instant.
function tzOffsetMs(utcDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return asUtc - utcDate.getTime();
}

/** Report-day key (YYYY-MM-DD in REPORT_TZ) for an instant; today when null. */
export function reportDayKey(value = null) {
  const d = value === null || value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(d.getTime())) return DTF.format(new Date());
  return DTF.format(d); // en-CA gives YYYY-MM-DD
}

/** UTC ISO instant of 00:00:00 REPORT_TZ on the given day string. */
export function reportDayStartIso(day) {
  const guess = new Date(`${day}T00:00:00Z`);
  const off1 = tzOffsetMs(guess);
  let inst = new Date(guess.getTime() - off1);
  const off2 = tzOffsetMs(inst);
  if (off2 !== off1) inst = new Date(guess.getTime() - off2); // DST edge
  return inst.toISOString();
}

/** Pure calendar arithmetic on day strings (tz-neutral). */
export function reportDaysAgo(n, fromDay = null) {
  const base = fromDay ? new Date(`${fromDay}T12:00:00Z`) : new Date(`${reportDayKey()}T12:00:00Z`);
  return new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
}

export { REPORT_TZ };
export default { REPORT_TZ, reportDayKey, reportDayStartIso, reportDaysAgo };
