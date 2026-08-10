// FUNNEL COHORTS — new-acquisition cohorts and their LTV / repeat-retention
// curves (LANE 5, SELF-CONTAINED, NEW FILE).
//
// A port of the reference `lb_cohort_service.compute_cohorts` onto this build's
// money table (`co_sessions`), keeping its two load-bearing rules and dropping
// the parts that only made sense against Mongo.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE TWO RULES THAT MAKE THE NUMBERS MEAN ANYTHING
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. LTV IS A CUSTOMER PROPERTY, NOT A FUNNEL ONE. Once a buyer is in a
//    cohort, EVERY subsequent paid session of theirs counts toward that
//    cohort's LTV — including sessions on other funnels. Restricting the
//    revenue to the acquisition funnel would answer a different question
//    ("what did this funnel bill?") under the word LTV, and it understates the
//    value of an acquisition funnel that feeds a back end.
//
//    ⚠️ CONSEQUENCE, stated on the payload: with a `funnel_id` filter the
//    ACQUISITION is narrowed and the REVENUE is not, so cohort revenue does not
//    tie out to that funnel's net sales. `basis` says so in words.
//
// 2. THE AGING GUARD. A cohort acquired four days ago has not lived long
//    enough to have a D30. That cell is `null` — never $0.00, which is a
//    lie-by-omission that reads as "these customers came back with nothing",
//    and which drags every average that touches it. Averages are SIZE-WEIGHTED
//    over the buyers old enough to be measured AT EACH HORIZON, so D7 and D90
//    are weighted over different (correct) populations.
//
// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY, AND WHY IT IS THE EMAIL
// ═══════════════════════════════════════════════════════════════════════════
// `LOWER(TRIM(customer->>'email'))`, the SAME identity funnelMetrics' own
// new/returning fold uses (`readCustomers`), so "new customer" means the same
// thing on the KPI strip and on this card. A session with NO email cannot be
// tied to a person and is therefore NOT an acquisition — it is excluded, and
// the count of excluded sessions is published rather than quietly folded in.
//
// ═══════════════════════════════════════════════════════════════════════════
// SHAPE OF THE WORK — SQL FOR THE SCAN, JS FOR THE MATH
// ═══════════════════════════════════════════════════════════════════════════
// Two windowed reads (acquisitions, then those buyers' whole revenue history),
// then a PURE fold. The reference does the whole thing row-by-row in Python
// over three unbounded collection scans; here the grouping and the day keys are
// Postgres's job (REPORT_TZ buckets, bound zone parameter) and only the cohort
// arithmetic is JavaScript — which is what lets
// server/tests/insights/cohorts.mjs drive `foldCohorts` against a known-answer
// table with no database at all.
//
// READ-ONLY, on the ISOLATED analytics pool, exactly like its siblings. The
// reference also hosts saved-report CRUD in this module; that is NOT ported —
// this build already has `explorer/savedReportsStore.js`, and a second
// saved-report store would be a second source of truth.
import { csvCell, REPORT_TIMEZONE, REPORT_TZ, MetricsError, todayInTz, zonedDayStart } from './funnelMetrics.js';
import { analyticsQuery } from './analyticsDb.js';

/**
 * MONEY MOVED — the same predicate the metrics engine and the P&L engine use.
 *
 * Declared LOCALLY and not imported for the same reason funnelMetrics declares
 * it locally: the original owners keep theirs module-private and this lane's
 * fence is create-only. The duplication is PINNED BY EXECUTION —
 * server/tests/insights/cohorts.mjs reads funnelMetrics.js off disk and asserts
 * this literal appears in it byte-for-byte.
 */
export const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

/** Cumulative age horizons, in days. D0 is the acquisition day itself. */
export const HORIZONS = Object.freeze([0, 7, 30, 90]);
export const MAX_HORIZON = 400;
export const MAX_HORIZONS = 8;

export const GROUP_BYS = Object.freeze(['day', 'funnel', 'campaign']);

/**
 * How many acquired buyers one request may fold.
 *
 * NOT a page size — a CAP, and a breach is DISCLOSED (`truncated: true` plus a
 * warning) rather than silently serving a cohort table computed from an
 * arbitrary slice of the buyers. A truncated cohort average is a wrong number
 * with a confident label on it.
 */
export const MAX_BUYERS = 20_000;

/** The widest window this surface will scan (the engine's own ceiling). */
export const MAX_WINDOW_DAYS = 400;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money2 = (v) => Math.round(num(v) * 100) / 100;
const idOf = (v, max = 120) => String(v ?? '').trim().slice(0, max);

const dayAdd = (day, n) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Whole calendar days between two YYYY-MM-DD keys (b − a). */
export const dayDiff = (a, b) =>
  Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
    - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);

function validDay(v, field) {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!DAY_RE.test(s)) {
    throw new MetricsError('invalid_date_format', `${field} must be YYYY-MM-DD`, 422, { [field]: String(v ?? '').slice(0, 20) });
  }
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new MetricsError('invalid_date', `${field} must be a real calendar date`, 422, { [field]: s });
  }
  return s;
}

/** Validate + normalise a cohort request. Refuses BEFORE any SQL runs. */
export function validateCohortQuery(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MetricsError('bad_body', 'query must be an object');
  }
  const today = todayInTz();
  const end = raw.end ? validDay(raw.end, 'end') : today;
  const start = raw.start ? validDay(raw.start, 'start') : dayAdd(end, -89);
  if (start > end) {
    throw new MetricsError('to_before_from', 'the start day is after the end day', 422, { start, end });
  }
  const days = dayDiff(start, end) + 1;
  if (days > MAX_WINDOW_DAYS) {
    throw new MetricsError('window_too_large', `window is ${days} days; at most ${MAX_WINDOW_DAYS}`, 422, { days, max: MAX_WINDOW_DAYS });
  }

  let groupBy = String(raw.group_by ?? 'day');
  if (!GROUP_BYS.includes(groupBy)) {
    throw new MetricsError('unknown_group_by', `group_by must be one of ${GROUP_BYS.join('|')}`, 422, { group_by: groupBy.slice(0, 40) });
  }

  let horizons = HORIZONS;
  if (raw.horizons !== undefined && raw.horizons !== null && raw.horizons !== '') {
    const list = Array.isArray(raw.horizons)
      ? raw.horizons
      : String(raw.horizons).split(',');
    const parsed = [];
    for (const h of list) {
      const n = Math.floor(Number(String(h).trim()));
      if (!Number.isFinite(n) || n < 0 || n > MAX_HORIZON) {
        throw new MetricsError('bad_horizon', `each horizon must be 0..${MAX_HORIZON} days`, 422, { horizon: String(h).slice(0, 20) });
      }
      if (!parsed.includes(n)) parsed.push(n);
    }
    if (!parsed.length) throw new MetricsError('bad_horizon', 'horizons must be a non-empty list', 422);
    if (parsed.length > MAX_HORIZONS) {
      throw new MetricsError('too_many_horizons', `at most ${MAX_HORIZONS} horizons`, 422, { count: parsed.length });
    }
    horizons = Object.freeze(parsed.sort((a, b) => a - b));
  }

  return {
    start,
    end,
    days,
    group_by: groupBy,
    horizons,
    funnel_id: idOf(raw.funnel_id, 64) || null,
    today,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PURE FOLD — the whole of the cohort arithmetic, no database anywhere
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the cohort table.
 *
 * @param buyers   [{email, first_day, funnel_id, funnel_label, campaign}]
 *                 one row per NEW acquisition; `first_day` is a REPORT_TZ day.
 * @param revenue  [{email, day, total}] every paid session of those buyers,
 *                 ANY funnel, ANY date (including before the window — those
 *                 land at a negative day offset and are excluded by the
 *                 `0 <= dp` test, exactly as the reference does).
 * @param today    the REPORT_TZ day the aging clock is read against.
 * @param horizons cumulative day horizons, ascending.
 * @param groupBy  'day' | 'funnel' | 'campaign'.
 *
 * KNOWN-ANSWER EXAMPLE (the first row of the table in
 * server/tests/insights/cohorts.mjs, reproduced so the contract is readable
 * here too):
 *
 *   today = 2026-03-01, horizons = [0, 7, 30]
 *   buyer A first_day 2026-01-01, sessions: 2026-01-01 $100 (day 0),
 *                                 2026-01-05 $50 (day 4), 2026-01-25 $25 (day 24)
 *   buyer B first_day 2026-01-01, sessions: 2026-01-01 $200 (day 0)
 *   both are 59 days old on `today`, so every horizon is aged: [2, 2, 2]
 *   ⇒ cohort '2026-01-01', size 2
 *     ltv       = [ (100+200)/2, (100+50+200)/2, (100+50+25+200)/2 ]
 *               = [ 150.00, 175.00, 187.50 ]
 *     retention = [ 100.0, 50.0, 50.0 ]   (only A repeats, inside D7 and D30)
 *     revenue_to_date = 375.00
 */
export function foldCohorts({
  buyers = [], revenue = [], today, horizons = HORIZONS, groupBy = 'day',
} = {}) {
  const hz = Array.isArray(horizons) && horizons.length ? horizons : HORIZONS;
  const n = hz.length;

  /** email -> {first_day, key, label} */
  const buyerBy = new Map();
  for (const b of buyers) {
    if (!b || !b.email || !DAY_RE.test(String(b.first_day || ''))) continue;
    let key;
    let label;
    if (groupBy === 'funnel') {
      key = String(b.funnel_id ?? '(none)');
      label = b.funnel_label || key;
    } else if (groupBy === 'campaign') {
      key = String(b.campaign ?? '(no campaign)');
      label = key;
    } else {
      key = String(b.first_day);
      label = key;
    }
    buyerBy.set(String(b.email), { first_day: String(b.first_day), key, label });
  }

  /** email -> [{day, total}] */
  const revBy = new Map();
  for (const r of revenue) {
    if (!r || !r.email) continue;
    const em = String(r.email);
    if (!buyerBy.has(em)) continue;
    if (!DAY_RE.test(String(r.day || ''))) continue;
    if (!revBy.has(em)) revBy.set(em, []);
    revBy.get(em).push({ day: String(r.day), total: num(r.total) });
  }

  const byKey = new Map();
  for (const [email, b] of buyerBy) {
    if (!byKey.has(b.key)) byKey.set(b.key, { label: b.label, emails: [] });
    byKey.get(b.key).emails.push(email);
  }

  const avgLtvNum = new Array(n).fill(0);
  const avgLtvDen = new Array(n).fill(0);
  const avgRetNum = new Array(n).fill(0);
  const avgRetDen = new Array(n).fill(0);

  const cohorts = [];
  for (const [key, group] of byKey) {
    const size = group.emails.length;
    const ltv = [];
    const retention = [];
    const aged = [];

    for (let i = 0; i < n; i += 1) {
      const H = hz[i];
      // THE AGING GUARD: only buyers whose acquisition day is at least H days
      // behind `today` can have been observed to their H-day horizon.
      const agedEmails = group.emails.filter(
        (e) => dayDiff(buyerBy.get(e).first_day, today) >= H,
      );
      aged.push(agedEmails.length);
      if (!agedEmails.length) {
        ltv.push(null);
        retention.push(null);
        continue;
      }
      let revSum = 0;
      let repeat = 0;
      for (const e of agedEmails) {
        const fd = buyerBy.get(e).first_day;
        let didRepeat = false;
        for (const r of revBy.get(e) || []) {
          const dp = dayDiff(fd, r.day);
          if (dp >= 0 && dp <= H) revSum += r.total;
          // A REPEAT IS A LATER DAY, strictly: a second order on the
          // acquisition day is the same purchase occasion, not a return.
          if (dp > 0 && dp <= H) didRepeat = true;
        }
        if (didRepeat) repeat += 1;
      }
      const ltvV = money2(revSum / agedEmails.length);
      // D0 retention is 100% BY DEFINITION (everyone bought on day 0); it is
      // not a measurement and is not averaged as if it were one.
      const retV = H === 0 ? 100 : Math.round((repeat / agedEmails.length) * 1000) / 10;
      ltv.push(ltvV);
      retention.push(retV);
      avgLtvNum[i] += ltvV * agedEmails.length;
      avgLtvDen[i] += agedEmails.length;
      avgRetNum[i] += retV * agedEmails.length;
      avgRetDen[i] += agedEmails.length;
    }

    let revToDate = 0;
    for (const e of group.emails) {
      const fd = buyerBy.get(e).first_day;
      for (const r of revBy.get(e) || []) {
        if (dayDiff(fd, r.day) >= 0) revToDate += r.total;
      }
    }

    cohorts.push({
      key: String(key),
      label: group.label,
      size,
      ltv,
      retention,
      aged,
      revenue_to_date: money2(revToDate),
    });
  }

  if (groupBy === 'day') cohorts.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  else {
    cohorts.sort((a, b) => b.revenue_to_date - a.revenue_to_date
      || String(a.key).localeCompare(String(b.key)));
  }

  const average = {
    ltv: hz.map((_h, i) => (avgLtvDen[i] ? money2(avgLtvNum[i] / avgLtvDen[i]) : null)),
    retention: hz.map((_h, i) => (avgRetDen[i] ? Math.round((avgRetNum[i] / avgRetDen[i]) * 10) / 10 : null)),
    aged: hz.map((_h, i) => avgLtvDen[i]),
  };

  return { cohorts, average, horizons: [...hz] };
}

// ═══════════════════════════════════════════════════════════════════════════
// The reads
// ═══════════════════════════════════════════════════════════════════════════

/**
 * NEW ACQUISITIONS in the window.
 *
 * `firsts` is every buyer's first-EVER paid instant (unbounded by design — a
 * "new customer" is a claim about all of history, and bounding it would make
 * every long-standing customer look new). A buyer qualifies when that
 * first-ever instant falls INSIDE the window; the acquiring session is then
 * their earliest paid session in the window that also satisfies the funnel
 * filter.
 *
 * ⚠️ `DISTINCT ON` orders by (email, paid_at) so the acquiring session is
 * deterministic when two sessions share a millisecond — `s.id` is the tiebreak,
 * so two loads of the same window cannot attribute the same buyer to two
 * different funnels.
 */
async function readAcquisitions(query, q) {
  const fromTs = zonedDayStart(q.start).toISOString();
  const toTs = zonedDayStart(dayAdd(q.end, 1)).toISOString();
  const params = [REPORT_TZ, fromTs, toTs];
  let fsql = '';
  if (q.funnel_id) { params.push(q.funnel_id); fsql = ` AND s.funnel_id = $${params.length}`; }
  const rows = await query(
    `WITH firsts AS (
       SELECT LOWER(TRIM(s.customer->>'email')) AS em, MIN(s.paid_at) AS first_paid
       FROM co_sessions s
       WHERE ${MONEY_MOVED_SQL}
         AND NULLIF(TRIM(COALESCE(s.customer->>'email', '')), '') IS NOT NULL
       GROUP BY 1
     )
     SELECT DISTINCT ON (f.em)
            f.em                                                           AS em,
            to_char(s.paid_at AT TIME ZONE $1::text, 'YYYY-MM-DD')         AS first_day,
            COALESCE(NULLIF(s.funnel_id, ''), '(none)')                    AS funnel_id,
            COALESCE(NULLIF(lt.utm->>'utm_campaign', ''), '(no campaign)') AS campaign
     FROM co_sessions s
     JOIN firsts f ON f.em = LOWER(TRIM(s.customer->>'email'))
     LEFT JOIN LATERAL (
       SELECT t.utm FROM lb_touches t
       WHERE t.vid = s.vid AND t.ts <= s.paid_at
       ORDER BY t.ts DESC LIMIT 1
     ) lt ON s.vid IS NOT NULL AND s.vid <> ''
     WHERE s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
       AND f.first_paid >= $2 AND f.first_paid < $3${fsql}
     ORDER BY f.em, s.paid_at ASC, s.id ASC
     LIMIT ${MAX_BUYERS + 1}`,
    params
  );
  return rows.map((r) => ({
    email: String(r.em),
    first_day: String(r.first_day),
    funnel_id: String(r.funnel_id),
    campaign: String(r.campaign),
  }));
}

/**
 * EVERY paid session of the acquired buyers — any funnel, any date.
 *
 * Bounded by the buyer list, not by a window: that is what makes the figure an
 * LTV rather than a window's revenue. Emails go in as a BOUND ARRAY parameter
 * (`= ANY($2)`), never interpolated.
 */
async function readBuyerRevenue(query, emails) {
  if (!emails.length) return [];
  const rows = await query(
    `SELECT LOWER(TRIM(s.customer->>'email'))                    AS em,
            to_char(s.paid_at AT TIME ZONE $1::text, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(s.total), 0)                             AS total
     FROM co_sessions s
     WHERE ${MONEY_MOVED_SQL}
       AND LOWER(TRIM(s.customer->>'email')) = ANY($2)
     GROUP BY 1, 2`,
    [REPORT_TZ, emails]
  );
  return rows.map((r) => ({ email: String(r.em), day: String(r.day), total: num(r.total) }));
}

/** Sessions in the window that CANNOT be tied to a person — disclosed, not folded. */
async function readAnonymousCount(query, q) {
  const fromTs = zonedDayStart(q.start).toISOString();
  const toTs = zonedDayStart(dayAdd(q.end, 1)).toISOString();
  const params = [fromTs, toTs];
  let fsql = '';
  if (q.funnel_id) { params.push(q.funnel_id); fsql = ` AND s.funnel_id = $${params.length}`; }
  const [row] = await query(
    `SELECT COUNT(*)::bigint AS n
     FROM co_sessions s
     WHERE s.paid_at >= $1 AND s.paid_at < $2
       AND ${MONEY_MOVED_SQL}
       AND NULLIF(TRIM(COALESCE(s.customer->>'email', '')), '') IS NULL${fsql}`,
    params
  );
  return num(row && row.n);
}

/** id → name, for the funnel grouping's labels. */
async function readFunnelNames(query) {
  const [reg] = await query(`SELECT to_regclass('public.funnels') AS t`);
  if (!reg || !reg.t) return new Map();
  const rows = await query(`SELECT id, name FROM funnels ORDER BY id LIMIT 500`);
  return new Map(rows.map((r) => [String(r.id), r.name || null]).filter(([, n]) => n));
}

/**
 * GET /funnel-insights/cohorts — the whole cohort table in one composite read.
 */
export async function computeCohorts(raw = {}, { query = analyticsQuery } = {}) {
  const t0 = Date.now();
  const q = validateCohortQuery(raw);
  const warnings = [];

  const [acqAll, names, anonymous] = await Promise.all([
    readAcquisitions(query, q),
    q.group_by === 'funnel' ? readFunnelNames(query) : Promise.resolve(new Map()),
    readAnonymousCount(query, q),
  ]);

  const truncated = acqAll.length > MAX_BUYERS;
  const acq = truncated ? acqAll.slice(0, MAX_BUYERS) : acqAll;
  if (truncated) {
    warnings.push({
      source: 'cohorts',
      reason: `more than ${MAX_BUYERS.toLocaleString('en-US')} new buyers were acquired in this window; the table below `
        + `is folded from the first ${MAX_BUYERS.toLocaleString('en-US')} by email and is NOT a complete cohort `
        + 'average. Narrow the window rather than reading these figures as the whole picture.',
    });
  }
  if (anonymous > 0) {
    warnings.push({
      source: 'identity',
      reason: `${anonymous.toLocaleString('en-US')} paid session(s) in this window carry no email and cannot be tied to a `
        + 'person, so they are in NO cohort. Their money is missing from every figure on this card — it is not zero, '
        + 'it is unattributable.',
    });
  }

  const buyers = acq.map((b) => ({
    ...b,
    funnel_label: names.get(b.funnel_id) || b.funnel_id,
  }));
  const revenue = await readBuyerRevenue(query, buyers.map((b) => b.email));

  const folded = foldCohorts({
    buyers, revenue, today: q.today, horizons: q.horizons, groupBy: q.group_by,
  });

  const unaged = folded.cohorts.reduce(
    (t, c) => t + c.ltv.filter((v) => v === null).length, 0,
  );
  if (unaged > 0) {
    warnings.push({
      source: 'aging',
      reason: `${unaged} cell(s) are blank because their cohort has not lived long enough to reach that horizon yet. `
        + 'A horizon a cohort cannot have reached is withheld, never reported as $0.00.',
    });
  }

  return {
    range: {
      start: q.start, end: q.end, days: q.days, timezone: REPORT_TIMEZONE, today: q.today,
    },
    group_by: q.group_by,
    horizons: folded.horizons,
    cohorts: folded.cohorts,
    average: folded.average,
    totals: {
      buyers: buyers.length,
      cohorts: folded.cohorts.length,
      revenue_to_date: money2(folded.cohorts.reduce((t, c) => t + c.revenue_to_date, 0)),
      anonymous_paid_sessions: anonymous,
      truncated,
    },
    basis: q.funnel_id
      ? 'acquisition narrowed to one funnel; LTV revenue is customer-level across EVERY funnel, so these figures do not tie out to that funnel\'s net sales'
      : 'first-ever paid session inside the window; LTV revenue is customer-level across every funnel',
    identity: "LOWER(TRIM(customer->>'email')) — the same identity the new/returning KPI uses",
    meta: {
      computed_ms: Date.now() - t0,
      rows_scanned: acqAll.length + revenue.length,
      timezone: REPORT_TIMEZONE,
      max_buyers: MAX_BUYERS,
      window: {
        start: q.start, end: q.end, days: q.days, timezone: REPORT_TIMEZONE,
      },
      warnings,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flatten a cohort result to CSV.
 *
 * UN-AGED CELLS ARE BLANK, matching the null convention exactly — a `0` here
 * would be the same fabrication in a file the operator then opens in a
 * spreadsheet and averages.
 *
 * INJECTION: every cell goes through the engine's own `csvCell`, which
 * neutralises the spreadsheet-formula prefixes (= + - @ and leading
 * whitespace). Campaign names and funnel names are operator- and
 * ATTACKER-supplied strings and both land in the label column, so this is a
 * real sink, not a hypothetical one.
 */
export function cohortsCsv(result) {
  const horizons = Array.isArray(result && result.horizons) ? result.horizons : HORIZONS;
  const rows = Array.isArray(result && result.cohorts) ? result.cohorts : [];
  const cell = (v) => (v === null || v === undefined ? '' : csvCell(v));

  const header = ['cohort', 'size'];
  for (const h of horizons) header.push(`ltv_d${h}`);
  for (const h of horizons) header.push(`retention_pct_d${h}`);
  for (const h of horizons) header.push(`aged_buyers_d${h}`);
  header.push('revenue_to_date');

  const lines = [header.map(csvCell).join(',')];
  for (const c of rows) {
    const ltv = Array.isArray(c.ltv) ? c.ltv : [];
    const ret = Array.isArray(c.retention) ? c.retention : [];
    const aged = Array.isArray(c.aged) ? c.aged : [];
    const line = [csvCell(c.label ?? c.key ?? ''), csvCell(c.size ?? 0)];
    for (let i = 0; i < horizons.length; i += 1) line.push(cell(ltv[i]));
    for (let i = 0; i < horizons.length; i += 1) line.push(cell(ret[i]));
    for (let i = 0; i < horizons.length; i += 1) line.push(cell(aged[i]));
    line.push(cell(c.revenue_to_date));
    lines.push(line.join(','));
  }

  const avg = (result && result.average) || {};
  const aLtv = Array.isArray(avg.ltv) ? avg.ltv : [];
  const aRet = Array.isArray(avg.retention) ? avg.retention : [];
  const aAged = Array.isArray(avg.aged) ? avg.aged : [];
  const totalSize = rows.reduce((t, c) => t + num(c.size), 0);
  const avgLine = [csvCell('AVERAGE (size-weighted, aged only)'), csvCell(totalSize)];
  for (let i = 0; i < horizons.length; i += 1) avgLine.push(cell(aLtv[i]));
  for (let i = 0; i < horizons.length; i += 1) avgLine.push(cell(aRet[i]));
  for (let i = 0; i < horizons.length; i += 1) avgLine.push(cell(aAged[i]));
  avgLine.push('');
  lines.push(avgLine.join(','));

  return `${lines.join('\n')}\n`;
}

export default {
  computeCohorts, foldCohorts, cohortsCsv, validateCohortQuery,
  HORIZONS, GROUP_BYS, MAX_BUYERS, MAX_WINDOW_DAYS, MONEY_MOVED_SQL, dayDiff,
};
