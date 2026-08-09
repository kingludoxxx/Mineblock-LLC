// dashFormat — the analytics dashboard's formatter layer (NEW FILE, LANE 3).
//
// Built ON TOP of ../format.js, which is READ-ONLY to this lane and already
// owns the one rule that matters: `null` and `0` are different facts and must
// never render the same. EM_DASH, fmtMoney, fmtInt, fmtRate, fmtPct and fmtDate
// are re-exported from there unchanged so this workspace has exactly one
// definition of each, and everything added here obeys the same rule:
//
//     null / undefined / NaN / ±Infinity  ->  EM_DASH
//     a measured 0                        ->  "0", "$0.00", "0.00%"
//
// Nothing in this file may return a number for an input it did not receive.
// The node harness in ./__checks__/formatterContract.mjs asserts exactly that,
// formatter by formatter, and is the gate this lane ships behind.
import {
  EM_DASH, fmtDate, fmtInt, fmtMoney, fmtPct, fmtRate,
} from '../format.js';

export { EM_DASH, fmtDate, fmtInt, fmtMoney, fmtPct, fmtRate };

/** The single nil test — mirrors ../format.js's private one. A non-finite
 *  number is not a measurement, so it is nil too. */
export const isNil = (v) =>
  v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));

/** Was this value actually sent, and is it a claim rather than a refusal? */
export const present = (v) => v !== null && v !== undefined;

/** ABSENT vs NULL — see metricsApi.hasKey; duplicated here so pure-format
 *  consumers do not have to import the API module. */
export const hasKey = (obj, k) =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);

const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A CHART POINT, or `null` for NEVER MEASURED.
 *
 * `Number(null)` is `0` and `Number.isFinite(0)` is true, so coercing a series
 * point drops a day the server deliberately published as null onto the floor of
 * the canvas — a fake cliff that looks exactly like a real traffic collapse.
 * Every series on this page goes through here and every chart runs
 * connectNulls={false}, so an unmeasured day is a HOLE.
 */
export const numOrGap = (v) => finite(v);

/** Print-side twin of numOrGap: a measured 0 prints, a withheld value dashes. */
export const orDash = (fmt) => (v) => (finite(v) === null ? EM_DASH : fmt(finite(v)));

/** Compact money for axis ticks and donut centres. Withheld -> em dash. */
export const fmtMoneyShort = (v) => {
  const n = finite(v);
  if (n === null) return EM_DASH;
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${sign}$${Math.round(a / 1000)}K`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

/** Compact counts. Withheld -> em dash. */
export const fmtCountShort = (v) => {
  const n = finite(v);
  if (n === null) return EM_DASH;
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${sign}${Math.round(a / 1000)}K`;
  return `${sign}${a.toLocaleString('en-US')}`;
};

/**
 * A percentage ALREADY IN PERCENT UNITS (conv_pct 2.41 -> "2.41%").
 *
 * Deliberately NOT ../format.js#fmtPct, which prefixes a "+" on positives
 * because it formats a LIFT. A conversion rate of "+2.41%" reads as a change
 * that did not happen.
 */
export const fmtPctPlain = (v, dp = 2) => {
  const n = finite(v);
  return n === null ? EM_DASH : `${n.toFixed(dp)}%`;
};

/** ROAS / any multiple. `0` is a real answer (spent, earned nothing). */
export const fmtX = (v, dp = 2) => {
  const n = finite(v);
  return n === null ? EM_DASH : `${n.toFixed(dp)}x`;
};

/**
 * A DEDUCTION line: "−$3,365.00", but "$0.00" for a measured zero.
 *
 * Blindly prefixing the minus rendered "−$0.00" on a window with no refunds —
 * a negative zero, which reads as a rounding artefact and makes an operator
 * wonder what was subtracted. Zero refunded is zero, with no sign on it. A
 * withheld value still dashes.
 */
export const fmtDeduction = (v) => {
  const n = finite(v);
  if (n === null) return EM_DASH;
  return n === 0 ? fmtMoney(0) : `−${fmtMoney(Math.abs(n))}`;
};

/** "1 order" / "2 orders" — a count and its noun, agreeing. */
export const plural = (n, one, many) => {
  const v = finite(n);
  if (v === null) return `${EM_DASH} ${many}`;
  return `${fmtInt(v)} ${Math.abs(v) === 1 ? one : many}`;
};

/** Money with no cents — table totals and axis labels. */
export const fmtMoney0 = (v) => {
  const n = finite(v);
  if (n === null) return EM_DASH;
  const s = `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return n < 0 ? `−${s}` : s;
};

/**
 * A RATE OVER A DENOMINATOR WE MAY NOT HAVE.
 *
 * Returns null — never 0 — whenever the denominator is missing, zero, or
 * withheld. Every rate on this page is built from this so the tri-state cannot
 * be re-implemented (differently) per card.
 */
export const safeRate = (numerator, denominator) => {
  const a = finite(numerator);
  const b = finite(denominator);
  if (a === null || b === null || b === 0) return null;
  return a / b;
};

/**
 * A DELTA NEEDS A BASELINE. No previous value, or a previous value of zero,
 * means there is no percentage to state — and a fabricated "0%" or "+100%"
 * against an empty period is the delta chip's version of absent-means-zero.
 * Returns `null`, and the caller renders NOTHING.
 */
export const deltaPct = (cur, prev) => {
  const a = finite(cur);
  const b = finite(prev);
  if (a === null || b === null || b === 0) return null;
  const pct = ((a - b) / Math.abs(b)) * 100;
  return Number.isFinite(pct) ? pct : null;
};

/* ── bucket keys ─────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):00/;

/** "2026-07-14" -> "Jul 14". Anything unparseable comes back untouched. */
export const shortDay = (iso) => {
  const s = String(iso || '');
  const m = s.match(DAY_RE);
  if (!m) return s;
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`;
};

/**
 * Hour buckets are the SERVER'S REPORT_TZ wall-clock keys and are parsed by
 * STRING PARTS only. `new Date(key)` would reinterpret the hour in the
 * BROWSER'S zone and silently shift every bucket for any operator outside the
 * reporting zone — the key already IS the display truth, and the header names
 * the zone beside it (tzLabel below).
 */
export const hourAxisLabel = (key) => {
  const m = String(key || '').match(HOUR_RE);
  if (!m) return '';
  const h = Number(m[4]);
  return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
};

/** "2026-08-07 06:00" -> "Aug 7, 2026, 6:00 AM". "" for non-hour keys. */
export const hourTooltipLabel = (key) => {
  const m = String(key || '').match(HOUR_RE);
  if (!m) return '';
  const h = Number(m[4]);
  const t = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`;
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]}, ${t}`;
};

/** Axis tick for either bucket shape — hour keys win, day keys unchanged. */
export const bucketAxisLabel = (key) => hourAxisLabel(key) || shortDay(key);

/** Tooltip label for either bucket shape. */
export const bucketTooltipLabel = (key) => hourTooltipLabel(key) || shortDay(key);

/** ISO country code -> "🇺🇸 United States". Never throws. */
export const countryLabel = (cc) => {
  const code = String(cc || '').toUpperCase();
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    /* keep the raw code */
  }
  const flag = /^[A-Z]{2}$/.test(code)
    ? code.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
    : '';
  return `${flag} ${name}`.trim();
};

/* ── reporting zone ──────────────────────────────────────────────────────── */

/**
 * THE ZONE IS THE SERVER'S CLAIM, NOT OURS.
 *
 * Every figure on this page is computed in REPORT_TZ and every day key is a
 * REPORT_TZ day; `window.timezone` is what the server says that zone is, and
 * this renders exactly it. `Europe/Madrid` gets the operator's own words —
 * "Madrid time" — because that is the phrase on the reference screenshots; any
 * other zone prints the raw IANA string rather than a friendly name we invented
 * for it. An absent zone prints NOTHING: claiming a timezone the payload did
 * not name is how a whole page of numbers quietly changes meaning.
 *
 * Hardcoding "Madrid time" here would survive exactly until REPORT_TZ moved,
 * and would then label Madrid figures over a different zone's days.
 */
export const TZ_LABELS = {
  'Europe/Madrid': 'Madrid time',
  UTC: 'UTC',
};

export const tzLabel = (zone) => {
  const z = typeof zone === 'string' ? zone.trim() : '';
  if (!z) return '';
  return TZ_LABELS[z] || z;
};

/* ── window helpers ──────────────────────────────────────────────────────── */

/**
 * THE INITIAL WINDOW GUESS, in the REPORTING ZONE — and it is only a guess.
 *
 * Three different "today"s are in play and they are not the same day:
 *   · the UTC day     — what ../format.js#todayIso returns
 *                       (`toISOString().slice(0,10)`)
 *   · the browser day — wherever the operator's laptop happens to be
 *   · the REPORT day  — Europe/Madrid, which is what every figure is cut on
 *
 * Madrid is UTC+1/+2, so between Madrid midnight and 01:00/02:00 the UTC day is
 * still YESTERDAY. Seeding "Today" from it opens the page on the wrong day,
 * every night, silently — and seeding from the browser day does the same thing
 * for anyone travelling.
 *
 * `Intl.DateTimeFormat('en-CA', {timeZone})` yields `YYYY-MM-DD` directly, so
 * the seed is the reporting zone's calendar day with no arithmetic.
 *
 * ⚠️ THIS CONSTANT IS NOT THE ZONE LABEL. `tzLabel` above stays SERVER-NAMED —
 * it renders `window.timezone`, whatever the server says that is. This one only
 * has to be right enough to open the page before any payload exists; the moment
 * the first response lands, the page ADOPTS the server's own window echo (see
 * ./index.jsx). If the two ever disagree, the server wins, visibly, on the
 * provenance line.
 */
export const REPORT_TZ_GUESS = 'Europe/Madrid';

const zoneDayFmt = (() => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: REPORT_TZ_GUESS, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    return null; // an engine without the zone data — fall back below
  }
})();

const localDayIso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** The reporting zone's calendar day for an instant, browser day as fallback. */
export const reportDayIso = (d = new Date()) => {
  if (!zoneDayFmt) return localDayIso(d);
  const s = zoneDayFmt.format(d);
  return DAY_RE.test(s) ? s : localDayIso(d);
};

export function todayIso() {
  return reportDayIso(new Date());
}

/**
 * `n` days before today IN THE REPORTING ZONE. The subtraction is done on the
 * INSTANT and re-formatted in the zone, so a DST change inside the window
 * cannot shift the day key by one (adding 24h × n to a wall clock can).
 */
export function daysAgoIso(n) {
  return reportDayIso(new Date(Date.now() - n * 86_400_000));
}

/** "Aug 1 – Aug 9, 2026", or just the day when the window is one day long. */
export const prettyRange = (start, end) => {
  if (!start && !end) return EM_DASH;
  if (!end || start === end) return prettyDay(start || end);
  return `${shortDay(start)} – ${prettyDay(end)}`;
};

/** "Aug 9, 2026". Unparseable input comes back untouched. */
export const prettyDay = (iso) => {
  const m = String(iso || '').match(DAY_RE);
  if (!m) return String(iso || EM_DASH);
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]}`;
};

/** Inclusive day span of a window, or null when either edge is missing. */
export const spanDays = (start, end) => {
  const a = String(start || '').match(DAY_RE);
  const b = String(end || '').match(DAY_RE);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.floor(ms / 86_400_000) + 1;
};
