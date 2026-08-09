// FUNNEL METRICS — the one query engine (LANE 1, SELF-CONTAINED, NEW FILE).
//
// One vocabulary, one legality matrix, one fold. Every analytics surface
// (dashboard, explorer, CSV, presets) goes through `runQuery` / `runDashboard`
// below; no surface re-implements a formula, and no surface may invent a
// metric that is not in `METRICS`.
//
// READ-ONLY. There is not a single INSERT/UPDATE/DELETE here and there never
// may be — this subsystem reports on money, it never touches it. Every read
// goes through the ISOLATED analytics pool (analyticsDb.analyticsQuery): a slow
// report degrades this subsystem and nothing else. See analyticsDb.js for why
// that isolation is not optional.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PREDICATE
// ═══════════════════════════════════════════════════════════════════════════
// MONEY_MOVED = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`.
//
// It is declared here as a LOCAL constant and not imported, because the
// existing owners (funnelAnalytics.js:198 and funnelCosts.js:61) both keep it
// module-private and this lane's fence is CREATE-ONLY — adding an export to
// either file is out of scope. The duplication is therefore deliberate and it
// is PINNED BY EXECUTION: server/tests/metrics/engine.mjs reads both source
// files off disk and asserts this literal appears in them byte-for-byte. If
// anyone edits the predicate in one place, that assertion fails.
//
// ═══════════════════════════════════════════════════════════════════════════
// TIMEZONE — REPORT_TZ = Europe/Madrid (OPERATOR DECISION, supersedes UTC v1)
// ═══════════════════════════════════════════════════════════════════════════
// Every day/hour/week/month bucket and every window edge is a MADRID calendar
// boundary, and `meta.timezone` says so on every response.
//
// WHY, and it is not cosmetic: Meta buckets spend by the AD ACCOUNT's
// timezone, so the `meta` rows already in lb_ad_spend_daily ARE Madrid days.
// Windowing revenue on UTC days while dividing it by Madrid-day spend gives a
// ROAS that silently disagrees with Ads Manager by whatever crossed midnight —
// and ROAS is the number the operator moves budget on. The Shopify store is on
// the same timezone, so this also makes the two revenue reports reconcile.
//
// HOW: the CONVERSION IS POSTGRES'S JOB, not JavaScript's. Every bucket is
// `to_char(<ts> AT TIME ZONE $1, …)` with the zone as a BOUND PARAMETER, so
// Postgres's own tz database handles DST — including the 23-hour and 25-hour
// days, which hand-rolled offset arithmetic gets wrong twice a year. The only
// JS-side zone math is turning the client's inclusive local day-strings into
// the UTC instants that bound the WHERE clause (`zonedDayStart`), and that is
// done with Intl and re-checked across the offset change.
//
// SCOPE, stated so nobody assumes more than was changed: the lb_touches TTL /
// session-identity logic is untouched, and so is the effective-dated COST RATE
// day inside funnelCosts (a rate that changes mid-day can therefore price on
// the UTC day while its revenue books on the Madrid day — a ≤2h boundary
// effect on rate-CHANGE days only, and moving it belongs to that engine's own
// before/after). The pre-existing surfaces — the funnelAnalytics page and the
// COGS P&L day keys — REMAIN UTC. These endpoints are the new canonical
// behaviour; the alignment pass on the older surfaces is the integrator's to
// schedule, and until it lands the two families will differ at the boundary.
//
// ═══════════════════════════════════════════════════════════════════════════
// NO ROLLUP TABLES — GROUP BY ON READ
// ═══════════════════════════════════════════════════════════════════════════
// Same decision funnelCosts.js:1281 records: numbers are derived from rows at
// query time, so a crediting bug is fixed by deploying a fix rather than by
// rebuilding history. Every response carries `meta.computed_ms` and
// `meta.rows_scanned` so the cost of that decision is measured, not assumed.
//
// ═══════════════════════════════════════════════════════════════════════════
// HONESTY RULES (these are the whole point of the file)
// ═══════════════════════════════════════════════════════════════════════════
//  • NULL IS NOT ZERO. Every rate whose DENOMINATOR is missing is `null`, and
//    the client renders an em dash. A "0.00% conversion" on a funnel earning
//    $50,000 is an argument to kill it; "—" is the truth.
//  • SESSIONS CAN BE UNKNOWN, which is not the same as zero. `lb_touches`
//    carries a 90-day TTL, so a window reaching past it sums a year of orders
//    over ~90 days of visitors. Buckets that cross the TTL carry
//    `sessions_unknown`; when a fold contains ANY, `sessions` itself is
//    withheld and every rate over it dashes (same rule funnelAnalytics's
//    traffic_ttl_risk publishes, enforced here rather than merely flagged).
//  • PROFIT IS WITHHELD AT ZERO COST COVERAGE. `net_after_cogs`, `margin_pct`
//    and `net_profit` are null when no leg in the fold has a known cost — a
//    funnel nobody has costed renders a dash, never "100% margin".
//  • SPEND IS TRI-STATE. `spend` is null unless the Meta feed has synced for a
//    bound campaign or the operator typed a manual figure. A zero there reads
//    as "no ad spend", which is the opposite of the truth.
//  • EVERY BREAKDOWN NAMES ITS BASIS. A breakdown without a basis is
//    unshippable: the same report name meant two different amounts depending
//    on which group-by was picked, which is the bug BREAKDOWN_BASES exists to
//    close. On a `captured_base` dimension the upsell folds DO NOT RUN AT ALL,
//    so the "upsell money has no UTM and is not in here" copy is true by
//    construction and not by promise. DIM_METRICS refuses `upsell_revenue`
//    there, so the number cannot be asked for either.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS DELIBERATELY NOT HERE
// ═══════════════════════════════════════════════════════════════════════════
//  • `device` is a REGISTERED dimension that answers {unavailable:true} and
//    422s any query naming it. Puure's tracking runtime captures no
//    user-agent class on lb_touches (Lane 5, operator-gated). It is listed
//    rather than omitted so the UI can render an explicit "not collected"
//    placeholder — silently dropping it is how a missing measurement becomes
//    an assumed zero.
//  • `country` is the ORDER SHIPPING country (co_sessions.customer->shipping),
//    so it serves MONEY only and is labelled "Sales by country". It is NEVER
//    "Pageviews by country": Puure captures no geo header anywhere (see
//    liveViewQueries.js), so a per-country pageview number would be invented.
//    DIM_METRICS refuses `pageviews` on it.
import { analyticsQuery } from './analyticsDb.js';
import { parseWindow } from './funnelAnalytics.js';
import { resolveCosts, buildRateIndex, round2 } from './funnelCosts.js';
import { funnelSpendByDay } from './funnelSpend.js';

// ── THE predicate (see the header block for why it is duplicated) ──────────
export const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

// lb_touches TTL (trackingSchema: 90 days). A bucket older than this has an
// eroded session denominator and withholds sessions + every rate over them.
export const TOUCH_TTL_DAYS = 90;

// A 'processing' session older than this is an ABANDONED checkout, not one in
// flight. Reference ABANDON_GRACE.
export const ABANDON_GRACE_SECONDS = 3600;

export const MAX_METRICS = 8;
export const MAX_BREAKDOWN_LIMIT = 200;
export const DEFAULT_BREAKDOWN_LIMIT = 50;

/**
 * The widest window this engine will serve, in days.
 *
 * It is NOT enforced here — `parseWindow` (funnelAnalytics.js) owns the
 * refusal, and this constant exists so /definitions can PUBLISH the number the
 * client greys its date picker against. It therefore has to equal the enforcer's
 * cap, which is a duplication, which is why the harness reads funnelAnalytics
 * off disk and pins the two together. A published limit that is looser than the
 * enforced one is worse than no published limit: it invites the client to
 * offer a range that always 422s.
 */
export const MAX_WINDOW_DAYS = 400;

/**
 * The reporting timezone. Env-overridable so a future account on another zone
 * is a config change, not a code change.
 *
 * VALIDATED AT LOAD, and it must be: this string is handed to Postgres and to
 * Intl. A typo would otherwise surface as a 500 on the first report of the
 * day rather than at boot, and an unvalidated value reaching `AT TIME ZONE`
 * is a string arriving at SQL. It is still passed as a BOUND PARAMETER
 * everywhere — the check below is defence in depth, not the control.
 */
function resolveReportTz() {
  const want = String(process.env.REPORT_TZ || 'Europe/Madrid').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: want });
    return want;
  } catch {
    throw new Error(`REPORT_TZ '${want.slice(0, 60)}' is not a valid IANA timezone`);
  }
}
export const REPORT_TZ = resolveReportTz();
/** Kept as the wire name the client reads. */
export const REPORT_TIMEZONE = REPORT_TZ;

// ═══════════════════════════════════════════════════════════════════════════
// THE FROZEN VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════

/** Every metric v1 can serve. Nothing outside this tuple is addressable. */
export const METRICS = Object.freeze([
  'orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell',
  'sessions', 'pageviews', 'conv_pct', 'rev_per_session',
  'upsell_revenue', 'upsell_take_pct',
  'new_customers', 'returning_customers',
  'abandoned', 'abandoned_rate',
  'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
  'spend', 'roas', 'cpa', 'net_profit',
]);

const METRIC_SET = new Set(METRICS);

/** Operator-facing labels + formatting class. `rate` metrics are tri-state. */
export const METRIC_META = Object.freeze({
  orders: { label: 'Orders', format: 'int' },
  gross_sales: { label: 'Gross sales', format: 'money' },
  net_sales: { label: 'Net sales', format: 'money' },
  refunds: { label: 'Refunds', format: 'money' },
  aov: { label: 'AOV', format: 'money', rate: true },
  aov_pre_upsell: { label: 'AOV (pre-upsell)', format: 'money', rate: true },
  sessions: { label: 'Sessions', format: 'int' },
  pageviews: { label: 'Pageviews', format: 'int' },
  conv_pct: { label: 'Conversion rate', format: 'pct', rate: true },
  rev_per_session: { label: '$/session', format: 'money', rate: true },
  upsell_revenue: { label: 'Upsell revenue', format: 'money' },
  upsell_take_pct: { label: 'Upsell take rate', format: 'pct', rate: true },
  new_customers: { label: 'New customers', format: 'int' },
  returning_customers: { label: 'Returning customers', format: 'int' },
  abandoned: { label: 'Abandoned checkouts', format: 'int' },
  abandoned_rate: { label: 'Abandoned rate', format: 'pct', rate: true },
  cogs: { label: 'COGS', format: 'money' },
  ship_cost: { label: 'Shipping cost', format: 'money' },
  fees: { label: 'Processing fees', format: 'money' },
  net_after_cogs: { label: 'Net after costs', format: 'money', rate: true },
  margin_pct: { label: 'Margin', format: 'pct', rate: true },
  cost_coverage_pct: { label: 'Cost coverage', format: 'pct', rate: true },
  spend: { label: 'Ad spend', format: 'money', rate: true },
  roas: { label: 'ROAS', format: 'ratio', rate: true },
  cpa: { label: 'CPA', format: 'money', rate: true },
  net_profit: { label: 'Net profit', format: 'money', rate: true },
});

/** Every dimension v1 registers. `device` is registered but UNAVAILABLE. */
export const DIMENSIONS = Object.freeze([
  'funnel', 'page', 'product', 'gateway', 'source', 'campaign', 'referrer',
  'landing_page', 'country', 'device',
]);

const DIMENSION_SET = new Set(DIMENSIONS);

/**
 * Registered-but-unservable dimensions. They are NOT removed from DIMENSIONS:
 * the UI must be able to draw an explicit "not collected" card. A query naming
 * one is refused 422 before any SQL runs.
 */
export const UNAVAILABLE_DIMENSIONS = Object.freeze({
  device: Object.freeze({
    unavailable: true,
    reason: 'device_not_collected',
    detail:
      'lb_touches records no user-agent class, so mobile/tablet/desktop cannot '
      + 'be split without inventing it. Gated behind Lane 5 (operator decision).',
  }),
});

// ── BREAKDOWN_BASES — ported from lb_analytics_service.py:303-330 ──────────
//
// A basis is not decoration. `gross` and `captured_base` are DIFFERENT AMOUNTS
// for the same window, and a card that draws one while naming the other is the
// exact bug the reference's own docstring calls out: "one report name meant two
// different amounts depending on which group-by was picked".
//
// On this build the basis is enforced by the QUERY PLAN, not by a label: the
// upsell revenue / upsell reversal folds are SKIPPED ENTIRELY on a
// captured_base dimension (see `basisOf` uses in gatherAtoms), and DIM_METRICS
// refuses `upsell_revenue` / `aov_pre_upsell` there so the number cannot even
// be requested.
export const BREAKDOWN_BASES = Object.freeze({
  funnel: 'gross',
  page: 'gross',
  country: 'gross',
  gateway: 'captured_base',
  source: 'captured_base',
  campaign: 'captured_base',
  referrer: 'captured_base',
  landing_page: 'captured_base',
  product: 'line_items',
  device: 'unavailable',
});

/**
 * The POPULATION each basis draws from — deliberately phrased as a noun
 * phrase, not as a report title.
 *
 * These used to lead with "gross sales — …", which made a net_sales breakdown
 * render a footer that said "Gross sales" under a column of net figures. A
 * basis describes WHICH MONEY IS IN THE FOLD; the METRIC describes WHAT WAS
 * MEASURED OVER IT. Conflating the two is how a label ends up contradicting
 * the column it sits under. `basisLabelFor` composes the two.
 */
export const BREAKDOWN_BASIS_LABELS = Object.freeze({
  gross: 'the captured base plus upsells',
  captured_base:
    'the captured base only — upsell money has no gateway, UTM or referrer of '
    + 'its own and is not in here',
  line_items: 'line-item value (price × quantity) — the cart\'s composition, not what was captured',
  unavailable: 'not collected',
});

/** Human labels for each dimension, including the two the reference re-bases. */
export const DIMENSION_META = Object.freeze({
  funnel: { label: 'Funnel', report_label: 'Sales by funnel' },
  page: { label: 'Page', report_label: 'Sales by page' },
  product: { label: 'Product', report_label: 'Sales by product' },
  gateway: { label: 'Gateway', report_label: 'Sales by gateway' },
  source: { label: 'Source', report_label: 'Sales by UTM source' },
  campaign: { label: 'Campaign', report_label: 'Sales by campaign' },
  referrer: { label: 'Referrer', report_label: 'Sales by referrer' },
  landing_page: { label: 'Landing page', report_label: 'Sales by landing page' },
  // NEVER "Pageviews by country" — this key is the ORDER's shipping country.
  country: { label: 'Country', report_label: 'Sales by country' },
  device: { label: 'Device', report_label: 'Sessions by device' },
});

// ── The legality matrix (contract: illegal combo ⇒ 422 BEFORE any query) ────
const BASE_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov', 'aov_pre_upsell', 'upsell_revenue'];
// On a captured_base dimension the upsell legs are not attributable, so the two
// upsell-derived metrics are not offered at all.
const CAPTURED_BASE_MONEY = ['orders', 'gross_sales', 'net_sales', 'refunds', 'aov'];
const TRAFFIC = ['sessions', 'pageviews', 'conv_pct', 'rev_per_session'];
const CUSTOMER = ['new_customers', 'returning_customers'];
const ABANDON = ['abandoned', 'abandoned_rate'];
const COST = ['cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'];
const SPEND = ['spend', 'roas', 'cpa', 'net_profit'];

/**
 * Which metrics are DEFINED per dimension.
 *
 *  • The `null` key is the timeseries (no dimension) — everything is legal.
 *  • COST rides SESSION ATTRIBUTES only (funnel / page / country). A cost fold
 *    includes upsell legs, so pairing it with a captured_base money figure
 *    would divide one population by another — exactly the class of lie
 *    BREAKDOWN_BASES exists to remove.
 *  • SPEND rides `funnel` only. lb_ad_spend_daily binds to funnels through
 *    lb_campaign_map; there is no honest per-gateway or per-country split of an
 *    ad budget, and pro-rating one would be a fabricated number on the tile
 *    the operator makes spend decisions on.
 *  • `product` deliberately serves NO cost metric and NO net_sales — same
 *    reasoning the reference records: the fold keys on the line, refunds carry
 *    no line reference, and there is no pro-rata fee split. Re-keying it is its
 *    own change with its own before/after.
 *  • `country` serves NO pageviews — see the header block.
 */
export const DIM_METRICS = Object.freeze({
  __timeseries__: Object.freeze(new Set(METRICS)),
  funnel: Object.freeze(new Set([...BASE_MONEY, ...TRAFFIC, ...CUSTOMER, ...ABANDON, ...COST, ...SPEND, 'upsell_take_pct'])),
  page: Object.freeze(new Set([...BASE_MONEY, ...TRAFFIC, ...CUSTOMER, ...ABANDON, ...COST])),
  country: Object.freeze(new Set([...BASE_MONEY, ...CUSTOMER, ...COST])),
  gateway: Object.freeze(new Set([...CAPTURED_BASE_MONEY, ...CUSTOMER])),
  source: Object.freeze(new Set([...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER])),
  campaign: Object.freeze(new Set([...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER])),
  referrer: Object.freeze(new Set([...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER])),
  landing_page: Object.freeze(new Set([...CAPTURED_BASE_MONEY, ...TRAFFIC, ...CUSTOMER])),
  product: Object.freeze(new Set(['orders', 'gross_sales', 'aov'])),
  device: Object.freeze(new Set()),
});

/** Metrics that are MONEY (or derived from it) — the ones a basis describes. */
const MONEY_SHAPED = Object.freeze(new Set([...BASE_MONEY, ...COST, ...SPEND]));

/**
 * The basis label for a SPECIFIC fold: what was measured, then what it was
 * measured over.
 *
 * `basis` is a property of the DIMENSION (which money is attributable to it);
 * the leading phrase is a property of the METRIC LIST. A net_sales breakdown
 * must never render "Gross sales …" — that is a label contradicting its own
 * column, and it is the single most expensive kind of reporting bug because it
 * is invisible to everyone who already knows what the number should be.
 *
 * When the fold names no money metric at all (a sessions-by-source breakdown,
 * say) the basis still matters — it says what the MONEY on that dimension
 * would be — so it is stated as exactly that rather than dropped.
 */
export function basisLabelFor(basis, metrics = []) {
  const population = BREAKDOWN_BASIS_LABELS[basis] || BREAKDOWN_BASIS_LABELS.unavailable;
  const primary = metrics.find((m) => MONEY_SHAPED.has(m));
  if (!primary) {
    const head = METRIC_META[metrics[0]]?.label ?? 'This figure';
    return `${head} — a traffic figure, not money; the money on this breakdown is ${population}`;
  }
  return `${METRIC_META[primary].label} — ${population}`;
}

/** The metric a breakdown's scalar `total` reports (and its footer names). */
export function primaryMetricOf(metrics = []) {
  if (metrics.includes('net_sales')) return 'net_sales';
  return metrics.find((m) => MONEY_SHAPED.has(m)) ?? metrics[0] ?? null;
}

export const GRANULARITIES = Object.freeze(['day', 'hour', 'week', 'month']);

/**
 * Metrics that DO NOT EXIST below a day, and are refused at
 * `granularity=hour` REGARDLESS OF DIMENSION.
 *
 * This is not a capacity limit, it is a measurement one — each of these is
 * day-partitioned at its SOURCE and there is no hourly version to serve:
 *
 *   • spend / roas / cpa / net_profit — lb_ad_spend_daily's grain IS a day
 *     key. Meta does not report spend by hour, so an hourly ROAS would divide
 *     a real hourly revenue by a made-up hourly budget, which is the most
 *     expensive fabricated number on the page.
 *   • the six COST metrics — an effective-dated cost rate is keyed to a DAY;
 *     splitting it across hours implies a precision the rate ledger does not
 *     have, and margin_pct would move purely on rounding.
 *   • new/returning — the class is decided against the buyer's first-ever paid
 *     DAY (the reference's pinned, additive per-day semantics).
 *   • abandoned / abandoned_rate — the 3600s grace is a whole hour wide, so an
 *     hourly bucket would be mostly grace and the rate would read as a clock,
 *     not a funnel.
 *
 * The client mirrors this list; THIS is the authority, and it is served on
 * /definitions so there is no second copy to drift.
 */
export const HOUR_ONLY_EXCLUSIONS = Object.freeze([
  'spend', 'roas', 'cpa', 'net_profit',
  'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct',
  'new_customers', 'returning_customers',
  'abandoned', 'abandoned_rate',
]);
const HOUR_EXCLUDED = new Set(HOUR_ONLY_EXCLUSIONS);

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

/** A caller-fault refusal. `status` is what the router must send. */
export class MetricsError extends Error {
  constructor(code, message, status = 422, detail = null) {
    super(message || code);
    this.name = 'MetricsError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Small helpers (kept local — pure, so the harness can drive them directly)
// ═══════════════════════════════════════════════════════════════════════════
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const int = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (v) => Math.round(num(v) * 100) / 100;
const pct = (numer, denom) => (denom > 0 ? Math.round((numer / denom) * 1e6) / 1e4 : null);
const idOf = (v, max = 120) => String(v ?? '').trim().slice(0, max);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Calendar-day arithmetic on a YYYY-MM-DD STRING. Anchoring at UTC noon keeps
// this correct across every DST rule: a ±1h shift can never move noon onto a
// different calendar date, whereas midnight-anchored stepping can.
const dayAdd = (day, n) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

const _tzParts = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** The zone's UTC offset (ms) at a given instant — DST-aware. */
function tzOffsetMs(instant) {
  const p = Object.fromEntries(_tzParts.formatToParts(instant).map((x) => [x.type, x.value]));
  // 'en-US' with hour12:false renders midnight as '24' — normalise it.
  const hour = Number(p.hour) % 24;
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant of LOCAL MIDNIGHT on `day` in REPORT_TZ.
 *
 * Two passes, and the second one is load-bearing: the offset that applies at
 * the ANSWER can differ from the offset at the guess, which is exactly what
 * happens on the two DST-transition days a year. One pass gets those days
 * wrong by an hour; re-reading the offset at the candidate instant and
 * re-solving fixes it.
 */
export function zonedDayStart(day) {
  const guess = new Date(`${day}T00:00:00Z`);
  const first = new Date(guess.getTime() - tzOffsetMs(guess));
  const second = new Date(guess.getTime() - tzOffsetMs(first));
  return second;
}

/** The REPORT_TZ calendar day (YYYY-MM-DD) an instant falls on. */
export function dayInTz(instant = new Date()) {
  const p = Object.fromEntries(_tzParts.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today, in the reporting timezone. */
export const todayInTz = () => dayInTz(new Date());

/** How many hours the local day actually has (23 / 24 / 25 across DST). */
export function hoursInLocalDay(day) {
  return Math.round((zonedDayStart(dayAdd(day, 1)).getTime() - zonedDayStart(day).getTime()) / HOUR_MS);
}

/**
 * Turn a validated {from,to} pair of LOCAL day-strings into the half-open UTC
 * instant bounds [local midnight of `from`, local midnight of `to`+1).
 *
 * The `to` day is included in full, exactly once, and no row is double-counted
 * at a boundary — the same contract funnelAnalytics.parseWindow publishes, but
 * cut on REPORT_TZ calendar days rather than UTC ones.
 */
export function localWindow(w) {
  return {
    ...w,
    fromTs: zonedDayStart(w.from),
    toTs: zonedDayStart(dayAdd(w.to, 1)),
    timezone: REPORT_TZ,
  };
}

/** ISO-week start (Monday) as a YYYY-MM-DD key. */
export function weekKey(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getTime() - dow * DAY_MS).toISOString().slice(0, 10);
}
export const monthKey = (day) => day.slice(0, 7);

/**
 * The bucket key a raw day/hour belongs to at a given granularity.
 * Hour rows arrive as 'YYYY-MM-DDTHH'; everything else as 'YYYY-MM-DD'.
 */
export function bucketOf(raw, granularity) {
  if (granularity === 'hour') return raw;
  const day = raw.slice(0, 10);
  if (granularity === 'week') return weekKey(day);
  if (granularity === 'month') return monthKey(day);
  return day;
}

/**
 * The complete, gap-free bucket list for a window — so a zero day is still
 * drawn rather than silently closing the gap in the chart.
 *
 * ⚠️ HOURLY BUCKETS ARE GENERATED FROM REAL INSTANTS, not from `0..23`. A
 * spring-forward day has 23 hours and an autumn day has 25, so a hard-coded
 * 24 would invent an hour that never existed (drawn as a confident zero) and
 * lose one that happened twice. Walking the actual elapsed hours and asking
 * the zone what each one is called gets both right; the repeated autumn hour
 * folds into ONE bucket, which is the honest total for that wall-clock hour.
 */
export function bucketsFor(w, granularity) {
  const out = [];
  const seen = new Set();
  if (granularity === 'hour') {
    const start = zonedDayStart(w.from).getTime();
    const end = zonedDayStart(dayAdd(w.to, 1)).getTime();
    for (let t = start; t < end; t += HOUR_MS) {
      const p = Object.fromEntries(_tzParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      const k = `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}`;
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }
  for (let d = w.from; d <= w.to; d = dayAdd(d, 1)) {
    const k = bucketOf(d, granularity);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** Every local calendar day a window covers. */
function daysOfWindow(w) {
  const out = [];
  for (let d = w.from; d <= w.to; d = dayAdd(d, 1)) out.push(d);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation + legality (NOTHING touches the database until this passes)
// ═══════════════════════════════════════════════════════════════════════════

const WINDOW_ERRORS = new Set([
  'invalid_date_format', 'invalid_date', 'to_before_from', 'window_too_large',
]);

/**
 * Validate a MetricsQueryBody. Throws MetricsError(422) on any refusal.
 *
 * Ported shape (schemas/lb_metrics.py:113-135): {metrics[1..8], dimension?,
 * filters{}, window{start_day,end_day}, compare, granularity, limit}.
 */
export function validateQuery(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MetricsError('bad_body', 'body must be a JSON object');
  }

  const metricsIn = raw.metrics;
  if (!Array.isArray(metricsIn) || metricsIn.length === 0) {
    throw new MetricsError('metrics_required', 'metrics must be a non-empty array');
  }
  // Dedupe while preserving order — a repeated metric is not an error, but it
  // must not consume two of the eight slots.
  const metrics = [];
  for (const m of metricsIn) {
    const name = String(m ?? '');
    if (!METRIC_SET.has(name)) {
      throw new MetricsError('unknown_metric', `unknown metric '${name.slice(0, 40)}'`, 422, { metric: name.slice(0, 40) });
    }
    if (!metrics.includes(name)) metrics.push(name);
  }
  if (metrics.length > MAX_METRICS) {
    throw new MetricsError('too_many_metrics', `at most ${MAX_METRICS} metrics`, 422, { count: metrics.length });
  }

  let dimension = null;
  if (raw.dimension !== undefined && raw.dimension !== null && raw.dimension !== '') {
    dimension = String(raw.dimension);
    if (!DIMENSION_SET.has(dimension)) {
      throw new MetricsError('unknown_dimension', `unknown dimension '${dimension.slice(0, 40)}'`, 422, { dimension: dimension.slice(0, 40) });
    }
    if (UNAVAILABLE_DIMENSIONS[dimension]) {
      throw new MetricsError(
        'dimension_unavailable',
        `dimension '${dimension}' is registered but not collected`,
        422,
        UNAVAILABLE_DIMENSIONS[dimension]
      );
    }
  }

  // ── THE LEGALITY GATE. Refused before a single row is read. ──────────────
  const legal = DIM_METRICS[dimension ?? '__timeseries__'];
  const illegal = metrics.filter((m) => !legal.has(m));
  if (illegal.length) {
    throw new MetricsError(
      'illegal_metric_for_dimension',
      `metric(s) ${illegal.join(', ')} are not defined for dimension '${dimension}'`,
      422,
      { dimension, illegal, legal: [...legal] }
    );
  }

  // Shape / ordering / 400-day cap are funnelAnalytics.parseWindow's contract,
  // reused verbatim so the two subsystems refuse exactly the same windows. Its
  // UTC instant bounds are then REPLACED by REPORT_TZ ones — the day-strings
  // the client sends are LOCAL calendar days.
  const win = raw.window || {};
  const parsed = parseWindow({ from: win.start_day, to: win.end_day });
  if (!parsed.ok) {
    const code = WINDOW_ERRORS.has(parsed.error) ? parsed.error : 'invalid_window';
    throw new MetricsError(code, `window rejected: ${parsed.error}`, 422, { window: win });
  }
  const w = localWindow(parsed);

  const granularity = String(raw.granularity ?? 'day');
  if (!GRANULARITIES.includes(granularity)) {
    throw new MetricsError('unknown_granularity', `granularity must be one of ${GRANULARITIES.join('|')}`, 422, { granularity });
  }
  // Hourly buckets only make sense inside one day: an hour key across a
  // multi-day window either collapses 30 Mondays into one point or explodes
  // into 720 — both are wrong, so it is refused rather than guessed.
  if (granularity === 'hour' && w.from !== w.to) {
    throw new MetricsError(
      'hour_requires_single_day',
      'granularity=hour is only valid when start_day == end_day',
      422,
      { start_day: w.from, end_day: w.to }
    );
  }
  // Day-only metrics are refused hourly REGARDLESS OF DIMENSION — the source
  // grain is a day and there is no hourly figure to serve (see
  // HOUR_ONLY_EXCLUSIONS). Checked here, before any query, exactly like the
  // dimension legality gate.
  if (granularity === 'hour') {
    const dayOnly = metrics.filter((m) => HOUR_EXCLUDED.has(m));
    if (dayOnly.length) {
      throw new MetricsError(
        'metric_not_available_hourly',
        `metric(s) ${dayOnly.join(', ')} are measured per day and cannot be served hourly`,
        422,
        { granularity, metrics: dayOnly, hour_only_exclusions: HOUR_ONLY_EXCLUSIONS }
      );
    }
  }

  const f = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters) ? raw.filters : {};
  const filters = {
    funnel_id: idOf(f.funnel_id, 64) || null,
    country: idOf(f.country, 60) || null,
    gateway: idOf(f.gateway, 40) || null,
    source: idOf(f.source, 120) || null,
  };

  let limit = raw.limit === undefined || raw.limit === null ? DEFAULT_BREAKDOWN_LIMIT : Math.floor(Number(raw.limit));
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_BREAKDOWN_LIMIT) {
    throw new MetricsError('bad_limit', `limit must be 1..${MAX_BREAKDOWN_LIMIT}`, 422, { limit: raw.limit });
  }
  limit = Math.floor(limit);

  return {
    metrics,
    dimension,
    filters,
    window: w,
    compare: Boolean(raw.compare),
    granularity,
    limit,
  };
}

/**
 * The equal-length window immediately preceding `w`, in LOCAL calendar days.
 *
 * Equal-length in DAYS, not in milliseconds: across a DST boundary the two
 * windows differ by an hour of real time, and matching the millisecond span
 * instead would slide the comparison off the calendar and pair a Monday with
 * a Sunday.
 */
export function previousWindow(w) {
  const end = dayAdd(w.from, -1);
  const start = dayAdd(end, -(w.days - 1));
  const prev = parseWindow({ from: start, to: end });
  if (!prev.ok) throw new MetricsError('invalid_window', `previous window rejected: ${prev.error}`);
  return localWindow(prev);
}

// ═══════════════════════════════════════════════════════════════════════════
// Dimension key SQL
// ═══════════════════════════════════════════════════════════════════════════
//
// Every key expression below reads a column or a JSONB path — no caller value
// is ever concatenated into SQL. Filters go in as bound parameters.

/** Whether a dimension needs the last-touch / first-touch lateral join. */
const TOUCH_DIMS = new Set(['source', 'campaign', 'referrer', 'landing_page']);

/**
 * The dimension key + label expressions over `co_sessions s`.
 * `lt` = last touch at/before payment, `ft` = first touch at/before payment.
 */
function moneyKeyExpr(dimension) {
  switch (dimension) {
    case 'funnel': return `COALESCE(NULLIF(s.funnel_id, ''), '(none)')`;
    case 'page': return `COALESCE(NULLIF(s.page_id, ''), '(no page)')`;
    case 'gateway': return `COALESCE(NULLIF(s.gateway, ''), '(unknown)')`;
    case 'country': return `COALESCE(NULLIF(TRIM(s.customer->'shipping'->>'country'), ''), '(unknown)')`;
    case 'source': return `COALESCE(NULLIF(lt.utm->>'utm_source', ''), '(direct)')`;
    case 'campaign': return `COALESCE(NULLIF(lt.utm->>'utm_campaign', ''), '(no campaign)')`;
    case 'referrer': return `COALESCE(NULLIF(regexp_replace(COALESCE(lt.referrer, ''), '^https?://([^/?#]+).*$', '\\1'), ''), '(direct)')`;
    case 'landing_page': return `COALESCE(NULLIF(regexp_replace(COALESCE(ft.url, ''), '^https?://[^/]*([^?#]*).*$', '\\1'), ''), '(unknown)')`;
    default: return `''`;
  }
}

/** The lateral joins a money query needs for the requested dimension. */
function moneyJoins(dimension) {
  if (!TOUCH_DIMS.has(dimension)) return '';
  const bits = [];
  if (dimension !== 'landing_page') {
    // LAST touch at or before payment — the click that closed the sale.
    bits.push(`
      LEFT JOIN LATERAL (
        SELECT t.utm, t.referrer
        FROM lb_touches t
        WHERE t.vid = s.vid AND t.ts <= s.paid_at
        ORDER BY t.ts DESC
        LIMIT 1
      ) lt ON s.vid IS NOT NULL AND s.vid <> ''`);
  } else {
    // FIRST touch — the page they ARRIVED on, which is what "landing page"
    // means. Using the last touch here would report the checkout page as the
    // landing page on every single order.
    bits.push(`
      LEFT JOIN LATERAL (
        SELECT t.url
        FROM lb_touches t
        WHERE t.vid = s.vid AND t.ts <= s.paid_at
        ORDER BY t.ts ASC
        LIMIT 1
      ) ft ON s.vid IS NOT NULL AND s.vid <> ''`);
  }
  return bits.join('\n');
}

/** The traffic-side key over `lb_touches t` (only for traffic-serving dims). */
function trafficKeyExpr(dimension) {
  switch (dimension) {
    case 'funnel': return `COALESCE(NULLIF(t.funnel_id, ''), '(none)')`;
    case 'page': return `COALESCE(NULLIF(t.page_id, ''), '(no page)')`;
    case 'source': return `COALESCE(NULLIF(t.utm->>'utm_source', ''), '(direct)')`;
    case 'campaign': return `COALESCE(NULLIF(t.utm->>'utm_campaign', ''), '(no campaign)')`;
    case 'referrer': return `COALESCE(NULLIF(regexp_replace(COALESCE(t.referrer, ''), '^https?://([^/?#]+).*$', '\\1'), ''), '(direct)')`;
    case 'landing_page': return `COALESCE(NULLIF(regexp_replace(COALESCE(t.url, ''), '^https?://[^/]*([^?#]*).*$', '\\1'), ''), '(unknown)')`;
    default: return `''`;
  }
}

/**
 * Bucket expression for a timestamp column, in REPORT_TZ.
 *
 * `$1` IS ALWAYS THE ZONE. Every windowed read in this file binds its params
 * as [REPORT_TZ, fromTs, toTs, …filters], so the zone is a BOUND PARAMETER and
 * never a concatenated string — and Postgres, not JavaScript, does the DST
 * arithmetic. `timestamptz AT TIME ZONE 'X'` yields the local wall clock,
 * which is exactly what a report day key is.
 */
function bucketExpr(col, granularity) {
  // ⚠️ `$1::text` — the cast is load-bearing. `AT TIME ZONE` is overloaded on
  // (text) and (interval), so an untyped parameter there is AMBIGUOUS and
  // Postgres refuses the whole statement with "could not determine data type".
  return granularity === 'hour'
    ? `to_char(${col} AT TIME ZONE $1::text, 'YYYY-MM-DD"T"HH24')`
    : `to_char(${col} AT TIME ZONE $1::text, 'YYYY-MM-DD')`;
}

/**
 * The standard leading bind list: the zone, then the half-open UTC bounds.
 *
 * ⚠️ ONLY for statements that actually reference `$1`. Postgres rejects a
 * prepared statement carrying a parameter it never uses ("could not determine
 * data type of parameter $1"), so a query with no bucket expression must bind
 * the bounds alone — see `windowBounds`.
 */
const windowParams = (w) => [REPORT_TZ, w.fromTs, w.toTs];

/** Bounds only, for statements that do no bucketing (no `$1` to type). */
const windowBounds = (w) => [w.fromTs, w.toTs];

/**
 * Filter predicates over `co_sessions s`, as bound parameters.
 * `source` needs the last-touch lateral, so it is only honoured where that
 * join exists — otherwise it is reported as an unappliable filter (a WARNING,
 * never a silent no-op: a filter the operator typed that did nothing is a
 * wrong number with a confident label on it).
 */
function moneyFilters(filters, params, { hasLastTouch }) {
  const bits = [];
  const unapplied = [];
  if (filters.funnel_id) { params.push(filters.funnel_id); bits.push(`AND s.funnel_id = $${params.length}`); }
  if (filters.gateway) { params.push(filters.gateway); bits.push(`AND s.gateway = $${params.length}`); }
  if (filters.country) {
    params.push(filters.country);
    bits.push(`AND UPPER(TRIM(COALESCE(s.customer->'shipping'->>'country', ''))) = UPPER($${params.length})`);
  }
  if (filters.source) {
    if (hasLastTouch) {
      params.push(filters.source);
      bits.push(`AND COALESCE(NULLIF(lt.utm->>'utm_source', ''), '(direct)') = $${params.length}`);
    } else {
      unapplied.push('source');
    }
  }
  return { sql: bits.join('\n       '), unapplied };
}

// ═══════════════════════════════════════════════════════════════════════════
// The atom reads. Each is its OWN failure domain, and each is only run when a
// requested metric can actually observe it (a fold nobody reads is dead work).
// ═══════════════════════════════════════════════════════════════════════════

const emptyAtoms = () => ({
  orders: 0, base_revenue: 0, upsell_revenue: 0, upsell_legs: 0,
  base_refunds: 0, upsell_refunds: 0,
  sessions: 0, pageviews: 0, upsell_views: 0, sessions_unknown: false,
  new_customers: 0, returning_customers: 0, abandoned: 0,
  cogs: 0, ship_cost: 0, fees: 0, known_legs: 0, missing_legs: 0,
  spend: 0, spend_known: false,
});

function slotFor(map, bucket, key) {
  const k = `${bucket} ${key}`;
  let v = map.get(k);
  if (!v) { v = { bucket, key, ...emptyAtoms() }; map.set(k, v); }
  return v;
}

/** Which atom families a metric list actually needs. */
export function neededFolds(metrics) {
  const s = new Set(metrics);
  const any = (...names) => names.some((n) => s.has(n));
  return {
    money: true, // orders/base revenue is the spine — always read
    upsell: any('gross_sales', 'net_sales', 'aov', 'aov_pre_upsell', 'upsell_revenue', 'refunds', 'rev_per_session', 'roas', 'margin_pct', 'net_after_cogs', 'net_profit', 'upsell_take_pct'),
    refunds: any('net_sales', 'refunds', 'aov', 'aov_pre_upsell', 'rev_per_session', 'roas', 'margin_pct', 'net_after_cogs', 'net_profit'),
    traffic: any('sessions', 'pageviews', 'conv_pct', 'rev_per_session'),
    upsellViews: s.has('upsell_take_pct'),
    customers: any('new_customers', 'returning_customers'),
    abandoned: any('abandoned', 'abandoned_rate'),
    costs: any('cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct', 'net_profit'),
    spend: any('spend', 'roas', 'cpa', 'net_profit'),
  };
}

/**
 * Orders + captured base revenue, windowed on paid_at.
 * ALSO the only place `rows_scanned` for the money spine is counted.
 */
async function readOrders(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const joins = moneyJoins(dimension);
  const { sql: fsql, unapplied } = moneyFilters(filters, params, { hasLastTouch: TOUCH_DIMS.has(dimension) && dimension !== 'landing_page' });
  const key = moneyKeyExpr(dimension);
  const rows = await query(
    `SELECT ${bucketExpr('s.paid_at', granularity)} AS bkt,
            ${key}                                  AS k,
            COUNT(*)::bigint                        AS orders,
            COALESCE(SUM(s.total), 0)               AS base_revenue,
            COUNT(DISTINCT s.currency)::bigint      AS currency_count,
            MIN(s.currency)                         AS currency
     FROM co_sessions s
     ${joins}
     WHERE s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  stats.unapplied_filters = unapplied;
  return rows;
}

/**
 * Product breakdown — line_items basis.
 *
 * `orders` here is DISTINCT money sessions containing the product (a two-line
 * order is one order on each line's row, and the TOTALS count distinct
 * sessions overall), and `gross_sales` is price × quantity — the cart's
 * composition, NOT a share of the captured cash. That is why `net_sales` is
 * not legal on this dimension: a refund entry carries no line reference, so
 * netting a line is not something the data can answer.
 */
async function readProductOrders(query, q, stats) {
  const { window: w, granularity, filters } = q;
  const params = windowParams(w);
  const { sql: fsql, unapplied } = moneyFilters(filters, params, { hasLastTouch: false });
  const rows = await query(
    `SELECT ${bucketExpr('s.paid_at', granularity)} AS bkt,
            COALESCE(NULLIF(TRIM(COALESCE(li->>'product_title', li->>'title', '')), ''), '(untitled)') AS k,
            COUNT(DISTINCT s.id)::bigint AS orders,
            COALESCE(SUM(COALESCE((li->>'price')::numeric, 0)
                         * GREATEST(COALESCE((li->>'quantity')::int, 1), 0)), 0) AS base_revenue
     FROM co_sessions s
     CROSS JOIN LATERAL jsonb_array_elements(s.line_items) li
     WHERE s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
       AND jsonb_typeof(s.line_items) = 'array'
       AND jsonb_typeof(li) = 'object'
       AND COALESCE(li->>'price', '0') ~ '^-?[0-9]+(\\.[0-9]+)?$'
       AND COALESCE(li->>'quantity', '1') ~ '^-?[0-9]+$'
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  stats.unapplied_filters = unapplied;
  return rows;
}

/** Distinct money sessions in the window — the product breakdown's TOTALS. */
async function readDistinctOrders(query, q) {
  const { window: w, filters } = q;
  const params = windowBounds(w);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: false });
  const [row] = await query(
    `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(s.total), 0) AS base_revenue
     FROM co_sessions s
     WHERE s.paid_at >= $1 AND s.paid_at < $2 AND ${MONEY_MOVED_SQL} ${fsql}`,
    params
  );
  return { orders: int(row?.n), base_revenue: money(row?.base_revenue) };
}

/**
 * Upsell legs. Skipped entirely on a captured_base dimension — that is what
 * makes the basis label true rather than merely printed.
 *
 * A 'refunded' leg is a leg that WAS SOLD and later reversed: it belongs in
 * gross with the reversal subtracted separately. Filtering to 'settled' would
 * delete a fully-earned $200 leg the moment $5 came back (funnelAnalytics.js
 * :151-166 documents the same edge at length).
 */
async function readUpsells(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: false });
  const key = moneyKeyExpr(dimension);
  const rows = await query(
    `SELECT ${bucketExpr('c.created_at', granularity)} AS bkt,
            ${key}                                     AS k,
            COUNT(*)::bigint                           AS upsell_legs,
            COALESCE(SUM(c.amount), 0)                 AS upsell_revenue
     FROM co_upsell_charges c
     JOIN co_sessions s ON s.id = c.session_id
     WHERE c.created_at >= $2 AND c.created_at < $3
       AND c.status IN ('settled', 'refunded')
       AND c.amount > 0
       AND ${MONEY_MOVED_SQL}
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * Base refunds, dated on the REFUND ENTRY (not the order).
 *
 * ⚠️ MONEY_MOVED is load-bearing, not copy-paste: main can reach
 * status='refunded' with paid_at NULL, and without the predicate such a
 * session contributes its refund while contributing no gross.
 * ⚠️ The regex + jsonb_typeof guards are load-bearing too: `(r->>'at')::timestamptz`
 * throws on a malformed entry and Postgres has no try_cast, and
 * jsonb_array_elements THROWS outright on a non-array value — one bad row
 * would otherwise take down every funnel's money in the same read.
 * ⚠️ The NOT EXISTS is the WHOP de-duplication: Whop appends an upsell refund
 * to refunds[] AND writes a void row, so counting both subtracts it twice.
 */
async function readRefunds(query, q, hasLedger, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const joins = moneyJoins(dimension);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: TOUCH_DIMS.has(dimension) && dimension !== 'landing_page' });
  const key = moneyKeyExpr(dimension);
  const dedupe = hasLedger
    ? `AND NOT EXISTS (
         SELECT 1 FROM lb_split_credits v
         JOIN co_upsell_charges uc ON uc.id = v.charge_id AND uc.session_id = v.session_id
         WHERE v.kind = 'void' AND v.session_id = s.id AND v.refund_key = r->>'id'
       )`
    : '';
  const rows = await query(
    `SELECT ${bucketExpr(`(r->>'at')::timestamptz`, granularity)} AS bkt,
            ${key}                                               AS k,
            COALESCE(SUM((r->>'amount')::numeric), 0)            AS base_refunds
     FROM co_sessions s
     ${joins}
     CROSS JOIN LATERAL jsonb_array_elements(s.refunds) r
     WHERE ${MONEY_MOVED_SQL}
       AND jsonb_typeof(s.refunds) = 'array'
       AND r->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
       AND r->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$'
       AND (r->>'at')::timestamptz >= $2
       AND (r->>'at')::timestamptz <  $3
       ${dedupe}
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * Upsell reversals, from the void ledger — the ONLY place a PARTIAL upsell
 * refund amount survives in this database.
 *
 * A session in N split tests gets N void rows for ONE physical refund, so the
 * inner collapse on (session, charge, refund_key) + MAX makes it one refund
 * again. Skipped on a captured_base dimension, exactly like the legs.
 */
async function readUpsellRefunds(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: false });
  const key = moneyKeyExpr(dimension);
  const rows = await query(
    `WITH v AS (
       SELECT session_id, charge_id, refund_key, MAX(-value) AS amt, MIN(created_at) AS ts
       FROM lb_split_credits
       WHERE kind = 'void'
       GROUP BY session_id, charge_id, refund_key
     )
     SELECT ${bucketExpr('v.ts', granularity)} AS bkt,
            ${key}                             AS k,
            COALESCE(SUM(v.amt), 0)            AS upsell_refunds
     FROM v
     JOIN co_upsell_charges c ON c.id = v.charge_id AND c.session_id = v.session_id
     JOIN co_sessions s        ON s.id = v.session_id
     WHERE v.ts >= $2 AND v.ts < $3
       AND ${MONEY_MOVED_SQL}
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * Sessions (distinct vid) + pageviews from lb_touches.
 *
 * ⚠️ `sessions` IS DISTINCT VISITORS **PER BUCKET, SUMMED** — the reference's
 * pinned definition ("distinct vid/day … additive per report-timezone day"),
 * and it is NOT the same number as distinct visitors over the whole window. A
 * visitor who comes back on Tuesday is TWO sessions, which is what the word
 * means everywhere else the operator reads it.
 *
 * The consequence, stated rather than smoothed over: the figure is a function
 * of the BUCKET SIZE. At `granularity=hour` a visitor active across three
 * hours contributes three, so an hourly window total is larger than the same
 * day's daily total. That is why `meta.sessions_basis` names the bucket on
 * every response instead of letting two screens print "sessions" and mean
 * different things. The alternative — a separate window-wide DISTINCT for the
 * totals — would make `totals.sessions` disagree with the sum of the series
 * that is drawn directly beneath it, which is a worse lie than a named one.
 */
async function readTraffic(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const bits = [];
  if (filters.funnel_id) { params.push(filters.funnel_id); bits.push(`AND t.funnel_id = $${params.length}`); }
  if (filters.source) {
    params.push(filters.source);
    bits.push(`AND COALESCE(NULLIF(t.utm->>'utm_source', ''), '(direct)') = $${params.length}`);
  }
  const key = trafficKeyExpr(dimension);
  const rows = await query(
    `SELECT ${bucketExpr('t.ts', granularity)} AS bkt,
            ${key}                             AS k,
            COUNT(DISTINCT t.vid)::bigint      AS sessions,
            COUNT(*)::bigint                   AS pageviews
     FROM lb_touches t
     WHERE t.ts >= $2 AND t.ts < $3
       ${bits.join('\n       ')}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * Upsell-page views — the take-rate denominator.
 *
 * DOCUMENTED APPROXIMATION, same as the reference: Puure emits no
 * "offer shown" event, so views on pages typed upsell/downsell stand in for
 * offers presented. `upsell_take_pct` is labelled a proxy everywhere it is
 * published for exactly this reason.
 */
async function readUpsellViews(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const bits = [];
  if (filters.funnel_id) { params.push(filters.funnel_id); bits.push(`AND t.funnel_id = $${params.length}`); }
  const key = dimension === 'funnel' ? `COALESCE(NULLIF(t.funnel_id, ''), '(none)')` : `''`;
  const rows = await query(
    `SELECT ${bucketExpr('t.ts', granularity)} AS bkt,
            ${key}                             AS k,
            COUNT(*)::bigint                   AS upsell_views
     FROM lb_touches t
     JOIN funnel_pages p ON p.id = t.page_id
     WHERE t.ts >= $2 AND t.ts < $3
       AND p.type IN ('upsell', 'downsell')
       ${bits.join('\n       ')}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * NEW vs RETURNING, by the buyer's FIRST-EVER paid session.
 *
 * An email whose first-ever money-moved session falls INSIDE the window is a
 * NEW customer; otherwise RETURNING. Anonymous (no email) counts as NEW — the
 * reference's rule, and the only one that keeps the identity below true.
 *
 * The lookup is CASE-INSENSITIVE: emails store raw case, so a prior
 * 'Rep@X.com' must match a window buyer 'rep@x.com' or the same human is
 * counted new twice.
 *
 * ⚠️ THE IDENTITY: new + returning == orders, exactly. It holds because this
 * query's window/predicate/filters are byte-identical to readOrders' — the
 * harness asserts the identity by execution, on filtered AND unfiltered reads.
 */
async function readCustomers(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const joins = moneyJoins(dimension);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: TOUCH_DIMS.has(dimension) && dimension !== 'landing_page' });
  const key = moneyKeyExpr(dimension);
  const rows = await query(
    `WITH firsts AS (
       SELECT LOWER(TRIM(s.customer->>'email')) AS em, MIN(s.paid_at) AS first_paid
       FROM co_sessions s
       WHERE ${MONEY_MOVED_SQL}
         AND NULLIF(TRIM(COALESCE(s.customer->>'email', '')), '') IS NOT NULL
       GROUP BY 1
     )
     SELECT ${bucketExpr('s.paid_at', granularity)} AS bkt,
            ${key}                                  AS k,
            COUNT(*) FILTER (
              WHERE NULLIF(TRIM(COALESCE(s.customer->>'email', '')), '') IS NULL
                 OR f.first_paid >= $2
            )::bigint AS new_customers,
            COUNT(*) FILTER (
              WHERE NULLIF(TRIM(COALESCE(s.customer->>'email', '')), '') IS NOT NULL
                AND f.first_paid < $2
            )::bigint AS returning_customers
     FROM co_sessions s
     ${joins}
     LEFT JOIN firsts f ON f.em = LOWER(TRIM(s.customer->>'email'))
     WHERE s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
       ${fsql}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * ABANDONED checkouts: status='processing' minted inside the window and older
 * than ABANDON_GRACE. The grace exists because a checkout opened 30 seconds
 * ago is IN FLIGHT, not abandoned — counting it would make the abandoned rate
 * a function of how recently the operator hit refresh.
 */
async function readAbandoned(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = [...windowParams(w), ABANDON_GRACE_SECONDS];
  const bits = [];
  if (filters.funnel_id) { params.push(filters.funnel_id); bits.push(`AND s.funnel_id = $${params.length}`); }
  if (filters.gateway) { params.push(filters.gateway); bits.push(`AND s.gateway = $${params.length}`); }
  const key = dimension === 'page'
    ? `COALESCE(NULLIF(s.page_id, ''), '(no page)')`
    : dimension === 'funnel' ? `COALESCE(NULLIF(s.funnel_id, ''), '(none)')` : `''`;
  const rows = await query(
    `SELECT ${bucketExpr('s.created_at', granularity)} AS bkt,
            ${key}                                     AS k,
            COUNT(*)::bigint                           AS abandoned
     FROM co_sessions s
     WHERE s.created_at >= $2 AND s.created_at < $3
       AND s.status = 'processing'
       AND s.created_at < NOW() - ($4::text || ' seconds')::interval
       ${bits.join('\n       ')}
     GROUP BY 1, 2`,
    params
  );
  stats.rows_scanned += rows.length;
  return rows;
}

/**
 * COST atoms. The math is funnelCosts.resolveCosts — the ONE cost engine,
 * imported and reused, never reimplemented. What this function owns is only
 * the WINDOWING and the fold key.
 *
 * WINDOWING mirrors funnelCosts.loadMoneyWindow exactly: a base order costs on
 * its paid_at day, an upsell leg on ITS OWN settle day. Cost books with its own
 * revenue or net_after_cogs stops reconciling with net_sales.
 *
 * The rate/catalog/fee reads are re-issued HERE on the analytics pool rather
 * than calling funnelCosts' loaders — those go through the shared pgQuery
 * handle, and a reporting read must never be able to hold a money-path
 * connection (analyticsDb.js). resolveCosts itself is PURE, so reusing it
 * costs nothing.
 */
async function readCosts(query, q, stats) {
  const { window: w, dimension, granularity, filters } = q;
  const params = windowParams(w);
  const { sql: fsql } = moneyFilters(filters, params, { hasLastTouch: false });
  const key = moneyKeyExpr(dimension);

  const [rates, catalogRows, feeRows, sessions, charges] = await Promise.all([
    query(`SELECT id, scope, variant_id, cost_item_id,
                  to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                  unit_cogs, ship, currency, source, created_at
           FROM lb_cost_rates ORDER BY effective_from, created_at, id`),
    query(`SELECT variant_id, pays_shipping, kind_auto, kind_override, cost_item_id FROM lb_variant_costs`),
    query(`SELECT default_pct, default_fixed, gateways FROM lb_fee_settings WHERE id = 1`),
    query(
      `SELECT s.id, s.funnel_id, s.page_id, s.gateway, s.line_items, s.total, s.refunds, s.paid_at,
              ${key} AS k,
              ${bucketExpr('s.paid_at', granularity)} AS bkt
       FROM co_sessions s
       WHERE s.paid_at >= $2 AND s.paid_at < $3 AND ${MONEY_MOVED_SQL} ${fsql}`,
      params
    ),
    query(
      `SELECT c.id, c.session_id, c.amount, c.status, c.line_items, c.created_at,
              s.gateway,
              ${key} AS k,
              ${bucketExpr('c.created_at', granularity)} AS bkt
       FROM co_upsell_charges c
       JOIN co_sessions s ON s.id = c.session_id
       WHERE c.created_at >= $2 AND c.created_at < $3
         AND c.status IN ('settled', 'refunded')
         AND ${MONEY_MOVED_SQL} ${fsql}`,
      params
    ),
  ]);
  stats.rows_scanned += sessions.length + charges.length;

  const rateIndex = buildRateIndex(rates);
  const catalog = {};
  for (const r of catalogRows) catalog[String(r.variant_id)] = r;
  // ⚠️ THE NESTED SHAPE IS THE CONTRACT. `resolveFeeRate` reads
  // {default:{pct,fixed}, gateways:{…}} — handing it the flat column names
  // would silently fall through to the 6%/0 defaults and every gateway
  // override would vanish from the fee total without an error anywhere.
  const fee = feeRows[0] || {};
  const feeSettings = {
    default: {
      pct: fee.default_pct === undefined || fee.default_pct === null ? 6 : Number(fee.default_pct),
      fixed: fee.default_fixed === undefined || fee.default_fixed === null ? 0 : Number(fee.default_fixed),
    },
    gateways: (typeof fee.gateways === 'string' ? JSON.parse(fee.gateways || '{}') : fee.gateways) || {},
  };
  const ctx = { catalog, rateIndex, feeSettings };

  const out = [];
  for (const s of sessions) {
    const r = resolveCosts(s, s.paid_at, { ...ctx, charges: [] });
    out.push({
      bkt: s.bkt, k: s.k, cogs: r.cogs, ship_cost: r.ship_cost, fees: r.fees,
      known_legs: r.known_legs, missing_legs: r.missing_legs,
    });
  }
  for (const c of charges) {
    // A stand-alone resolve on the charge's OWN settle day, with a synthetic
    // zero-collected shell carrying the parent's gateway so the fee resolves
    // on the right rail (funnelCosts.resolveChargeAlone, same shape).
    const r = resolveCosts(
      { gateway: c.gateway, total: 0, line_items: [], refunds: [] },
      c.created_at,
      { ...ctx, charges: [c] }
    );
    out.push({
      bkt: c.bkt, k: c.k, cogs: r.cogs, ship_cost: r.ship_cost, fees: r.fees,
      known_legs: r.known_legs, missing_legs: r.missing_legs,
    });
  }
  return out;
}

/** Does the split-credit ledger exist? A fresh install has none. */
async function ledgerPresent(query) {
  const [reg] = await query(`SELECT to_regclass('public.lb_split_credits') IS NOT NULL AS present`);
  return Boolean(reg?.present);
}

// ═══════════════════════════════════════════════════════════════════════════
// The fold + the derived metrics
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the requested metrics from a folded atom bag.
 *
 * ⚠️ EVERY RATIO IS RECOMPUTED FROM THE FOLDED SUMS, never averaged from the
 * component buckets. That single rule is what makes week/month granularity and
 * the window TOTALS correct: the mean of seven daily conversion rates is not
 * the week's conversion rate unless every day had identical traffic.
 */
export function computeMetrics(a, metrics) {
  const grossSales = money(a.base_revenue + a.upsell_revenue);
  const refunds = money(a.base_refunds + a.upsell_refunds);
  const netSales = money(grossSales - refunds);
  const orders = int(a.orders);

  // Sessions: withheld (null) — NOT zero — when any folded bucket crossed the
  // lb_touches TTL. Every rate over it dashes with it.
  const sessionsKnown = !a.sessions_unknown;
  const sessions = sessionsKnown ? int(a.sessions) : null;
  const rateable = sessionsKnown && int(a.sessions) > 0;

  const totalLegs = int(a.known_legs) + int(a.missing_legs);
  const netAfterCogs = int(a.known_legs) === 0
    ? null
    : money(netSales - a.cogs - a.ship_cost - a.fees);
  const spend = a.spend_known ? money(a.spend) : null;

  const all = {
    orders,
    gross_sales: grossSales,
    net_sales: netSales,
    refunds,
    aov: orders > 0 ? money(netSales / orders) : null,
    // Exact identity: aov − aov_pre_upsell === upsell_revenue / orders.
    // A negative pre-AOV (refunds exceeding base revenue in-window) is REFUSED
    // rather than rendered as a negative basket.
    aov_pre_upsell: orders > 0 && (netSales - a.upsell_revenue) >= 0
      ? money((netSales - a.upsell_revenue) / orders)
      : null,
    sessions,
    pageviews: int(a.pageviews),
    conv_pct: rateable ? pct(orders, int(a.sessions)) : null,
    rev_per_session: rateable ? money(netSales / int(a.sessions)) : null,
    upsell_revenue: money(a.upsell_revenue),
    upsell_take_pct: int(a.upsell_views) > 0 ? pct(int(a.upsell_legs), int(a.upsell_views)) : null,
    new_customers: int(a.new_customers),
    returning_customers: int(a.returning_customers),
    abandoned: int(a.abandoned),
    abandoned_rate: (int(a.abandoned) + orders) > 0 ? pct(int(a.abandoned), int(a.abandoned) + orders) : null,
    cogs: money(a.cogs),
    ship_cost: money(a.ship_cost),
    fees: money(a.fees),
    net_after_cogs: netAfterCogs,
    margin_pct: netAfterCogs === null || netSales <= 0 ? null : pct(netAfterCogs, netSales),
    // Null when there are NO legs at all — "0% coverage" and "nothing to
    // cover" are different facts and must not print the same character.
    cost_coverage_pct: totalLegs > 0 ? pct(int(a.known_legs), totalLegs) : null,
    spend,
    roas: spend !== null && spend > 0 ? Math.round((netSales / spend) * 100) / 100 : null,
    cpa: spend !== null && orders > 0 ? money(spend / orders) : null,
    net_profit: spend !== null && netAfterCogs !== null ? money(netAfterCogs - spend) : null,
  };

  const out = {};
  for (const m of metrics) out[m] = all[m];
  return out;
}

/** Add every atom of `src` into `dst` (sums; `unknown` flags OR together). */
function foldInto(dst, src) {
  for (const k of ['orders', 'base_revenue', 'upsell_revenue', 'upsell_legs',
    'base_refunds', 'upsell_refunds', 'sessions', 'pageviews', 'upsell_views',
    'new_customers', 'returning_customers', 'abandoned',
    'cogs', 'ship_cost', 'fees', 'known_legs', 'missing_legs', 'spend']) {
    dst[k] += num(src[k]);
  }
  dst.sessions_unknown = dst.sessions_unknown || src.sessions_unknown;
  dst.spend_known = dst.spend_known || src.spend_known;
  return dst;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE QUERY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gather every needed atom for one window into a Map keyed (bucket, dim key).
 * `folds` says which families to run, so a metric list that observes none of a
 * fold never pays for it.
 */
async function gatherAtoms(query, q, folds, stats) {
  const map = new Map();
  const { dimension, granularity, window: w } = q;
  const basis = dimension ? BREAKDOWN_BASES[dimension] : 'gross';
  const isProduct = dimension === 'product';
  // On a captured_base dimension the upsell folds DO NOT RUN. The basis label
  // is therefore a description of the query that ran, not a promise about it.
  const upsellsAttributable = basis === 'gross';

  const hasLedger = folds.refunds && !isProduct ? await ledgerPresent(query) : false;

  const jobs = [];
  const push = (p, handler) => jobs.push(p.then(handler));

  if (isProduct) {
    push(readProductOrders(query, q, stats), (rows) => {
      for (const r of rows) {
        const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
        s.orders += int(r.orders);
        s.base_revenue += num(r.base_revenue);
      }
    });
  } else {
    push(readOrders(query, q, stats), (rows) => {
      for (const r of rows) {
        const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
        s.orders += int(r.orders);
        s.base_revenue += num(r.base_revenue);
      }
    });
    if (folds.upsell && upsellsAttributable) {
      push(readUpsells(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.upsell_legs += int(r.upsell_legs);
          s.upsell_revenue += num(r.upsell_revenue);
        }
      });
    }
    if (folds.refunds) {
      push(readRefunds(query, q, hasLedger, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.base_refunds += num(r.base_refunds);
        }
      });
      if (hasLedger && upsellsAttributable) {
        push(readUpsellRefunds(query, q, stats), (rows) => {
          for (const r of rows) {
            const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
            s.upsell_refunds += num(r.upsell_refunds);
          }
        });
      }
    }
    if (folds.traffic) {
      push(readTraffic(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.sessions += int(r.sessions);
          s.pageviews += int(r.pageviews);
        }
      });
    }
    if (folds.upsellViews) {
      push(readUpsellViews(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.upsell_views += int(r.upsell_views);
        }
      });
    }
    if (folds.customers) {
      push(readCustomers(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.new_customers += int(r.new_customers);
          s.returning_customers += int(r.returning_customers);
        }
      });
    }
    if (folds.abandoned) {
      push(readAbandoned(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.abandoned += int(r.abandoned);
        }
      });
    }
    if (folds.costs) {
      push(readCosts(query, q, stats), (rows) => {
        for (const r of rows) {
          const s = slotFor(map, bucketOf(r.bkt, granularity), r.k);
          s.cogs += num(r.cogs);
          s.ship_cost += num(r.ship_cost);
          s.fees += num(r.fees);
          s.known_legs += int(r.known_legs);
          s.missing_legs += int(r.missing_legs);
        }
      });
    }
  }

  await Promise.all(jobs);

  // ── SPEND. Funnel-bound by construction (lb_campaign_map), so it lands on
  //    the funnel dimension and on the timeseries; DIM_METRICS refuses it
  //    everywhere else, which is why no other branch exists here.
  if (folds.spend && (!dimension || dimension === 'funnel')) {
    const fids = dimension === 'funnel'
      ? [...new Set([...map.values()].map((v) => v.key).filter((k) => k && k !== '(none)'))]
      : (q.filters.funnel_id ? [q.filters.funnel_id] : await allFunnelIds(query));
    if (fids.length) {
      const spend = await funnelSpendByDay(fids, w.from, w.to);
      for (const fid of fids) {
        const known = Boolean(spend.known[fid]);
        for (const [day, amount] of Object.entries(spend.days[fid] || {})) {
          if (day < w.from || day > w.to) continue;
          // Always a day-or-coarser bucket: `spend` is refused at hourly
          // granularity by validateQuery, because lb_ad_spend_daily's grain IS
          // a day and there is no hourly figure to place.
          const s = slotFor(map, bucketOf(day, granularity), dimension === 'funnel' ? fid : '');
          s.spend += num(amount);
          s.spend_known = s.spend_known || known;
        }
        if (known) {
          // A funnel whose feed HAS synced but spent nothing in-window must
          // still read "spend $0.00 (known)", not "—". Seed the flag on a
          // bucket even when no spend row landed.
          const s = slotFor(map, bucketsFor(w, granularity)[0], dimension === 'funnel' ? fid : '');
          s.spend_known = true;
        }
      }
    }
  }

  // ── TTL erosion, per bucket. A bucket whose day is older than the
  //    lb_touches retention has an eroded session denominator, so it withholds
  //    sessions and every rate over them instead of publishing an inflated
  //    conversion rate off a truncated count.
  const ttlEdge = ttlEdgeDay();
  for (const slot of map.values()) {
    const day = slot.bucket.length === 7 ? `${slot.bucket}-01` : slot.bucket.slice(0, 10);
    if (day < ttlEdge) slot.sessions_unknown = true;
  }
  return map;
}

/**
 * The oldest REPORT_TZ day whose session count is still complete.
 * Compared as a local day-string against local bucket keys — mixing a UTC edge
 * with local buckets would move the cliff by a day twice a year.
 */
function ttlEdgeDay() {
  return dayInTz(new Date(Date.now() - TOUCH_TTL_DAYS * DAY_MS));
}

async function allFunnelIds(query) {
  const rows = await query(`SELECT id FROM funnels WHERE NOT archived LIMIT 500`);
  return rows.map((r) => String(r.id)).filter(Boolean);
}

/** Does the window's LEFT edge reach past the lb_touches retention? */
export function ttlRisk(w) {
  return w.from < ttlEdgeDay();
}

/**
 * Append a warning, GUARANTEEING `{source, reason}` with `reason` a non-empty
 * string.
 *
 * Clients render `reason` directly. A warning that arrives as `undefined`
 * renders as an empty banner — which is worse than no banner, because the
 * operator sees an alarm with nothing in it and learns to ignore alarms.
 * `source` and `reason` are written LAST so a caller's `extra` can never
 * shadow them.
 */
function pushWarning(list, source, reason, extra = {}) {
  const text = (typeof reason === 'string' ? reason : String(reason ?? '')).trim();
  list.push({ ...extra, source: String(source || 'unknown'), reason: text || 'unspecified' });
  return list;
}

/** The first REPORT_TZ day a bucket key covers ('2026-08' → '2026-08-01'). */
function firstDayOfBucket(key) {
  return key.length === 7 ? `${key}-01` : key.slice(0, 10);
}

/** The REPORT_TZ hour key for right now — the future test at hour grain. */
function currentHourKey() {
  const p = Object.fromEntries(_tzParts.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}`;
}

/**
 * Has this bucket STARTED yet, in REPORT_TZ?
 *
 * A window may legitimately end after today — "this month" selected on the 9th
 * runs to the 31st. Those buckets have not happened, and drawing them as 0
 * produces a CLIFF TO ZERO in the chart that reads as a collapse in sales.
 * Both keys compare lexicographically because both are zero-padded ISO, and
 * both are evaluated in REPORT_TZ: an operator whose report zone is ahead of
 * the server (Auckland against a UTC box) would otherwise have their current
 * day classified as tomorrow and blanked.
 */
export function isFutureBucket(key, granularity) {
  if (granularity === 'hour') return key > currentHourKey();
  return firstDayOfBucket(key) > todayInTz();
}

/**
 * Attach `funnels.name` to a funnel breakdown.
 *
 * The KEY stays the funnel id — it is the join key the client scopes the page
 * with, and swapping it for a human name would make two funnels sharing a name
 * collapse into one row. `label` upgrades to the name when one resolves so
 * every existing label consumer (including the CSV) gets the readable string,
 * and `name` is published separately for callers that want to tell the two
 * apart. '(none)' is PRESERVED exactly: it is not a funnel id, so it is not
 * looked up, and it keeps its label with `name: null`.
 */
async function attachFunnelNames(query, rows) {
  const ids = [...new Set(rows.map((r) => r.key).filter((k) => k && k !== '(none)'))];
  const byId = new Map();
  if (ids.length) {
    const found = await query(`SELECT id, name FROM funnels WHERE id = ANY($1)`, [ids]);
    for (const f of found) byId.set(String(f.id), f.name || null);
  }
  for (const r of rows) {
    const name = byId.get(String(r.key)) ?? null;
    r.name = name;
    if (name) r.label = name;
  }
  return rows;
}

/**
 * Run one validated query. Returns {series[]|rows[], totals, previous?, meta}.
 *
 * `previous` is the EQUAL-LENGTH IMMEDIATELY-PRECEDING window and its series
 * is ALIGNED BY INDEX with the current one — never by date key, which would
 * mis-pair every comparison the moment a month has a different number of days.
 */
export async function runQuery(body, { query = analyticsQuery } = {}) {
  const t0 = Date.now();
  const q = validateQuery(body);
  const folds = neededFolds(q.metrics);
  const stats = { rows_scanned: 0, unapplied_filters: [] };
  const warnings = [];

  const basis = q.dimension ? BREAKDOWN_BASES[q.dimension] : 'gross';
  // Describes the METRIC ACTUALLY FOLDED, not just the dimension — see
  // basisLabelFor. A net_sales breakdown never says "Gross sales".
  const basisLabel = basisLabelFor(basis, q.metrics);

  const map = await gatherAtoms(query, q, folds, stats);
  // Surfaced on the wire: the TTL clamp is invisible in the numbers (a
  // withheld session and an unmeasured one both render "—"), so the client
  // needs the boolean to explain WHICH it is looking at.
  const sessionsUnknown = ttlRisk(q.window) || [...map.values()].some((s) => s.sessions_unknown);

  let previous = null;
  if (q.compare) {
    const prevW = previousWindow(q.window);
    const prevQ = { ...q, window: prevW };
    const prevStats = { rows_scanned: 0, unapplied_filters: [] };
    const prevMap = await gatherAtoms(query, prevQ, folds, prevStats);
    stats.rows_scanned += prevStats.rows_scanned;
    previous = { map: prevMap, window: prevW, q: prevQ };
  }

  const out = {
    meta: {
      computed_ms: 0,
      rows_scanned: stats.rows_scanned,
      basis,
      basis_label: basisLabel,
      basis_metric: primaryMetricOf(q.metrics),
      timezone: REPORT_TIMEZONE,
      granularity: q.granularity,
      // Names the bucket the session count is distinct WITHIN, because the
      // figure is a function of that bucket (see readTraffic).
      sessions_basis: `distinct lb_touches.vid per ${q.granularity === 'hour' ? 'hour' : 'day'}, summed (additive)`,
      sessions_unknown: sessionsUnknown,
      metrics: q.metrics,
      dimension: q.dimension,
      // BOTH spellings on purpose. `start_day`/`end_day` is the REQUEST
      // vocabulary (it echoes the body back verbatim); `start`/`end`/`timezone`
      // is the WINDOW-ECHO contract every client renders in its header. Two
      // consumers, one object, no guessing which one a given surface speaks.
      window: {
        start: q.window.from,
        end: q.window.to,
        start_day: q.window.from,
        end_day: q.window.to,
        days: q.window.days,
        timezone: REPORT_TIMEZONE,
      },
      warnings,
    },
  };

  if (q.dimension) {
    out.rows = breakdownRows(map, q, stats);
    // TOP-N-OF-M. The truncation is invisible in the payload itself, which is
    // how a footer ends up claiming a page is the whole thing — so the
    // PRE-TRUNCATION count ships beside it, and `totals` always folds ALL
    // buckets, not just the ones that made the page.
    out.meta.limit = q.limit;
    out.meta.rows_total = stats.rows_total ?? out.rows.length;
    out.meta.rows_truncated = out.meta.rows_total > out.rows.length;
    out.totals = totalsOf(map, q, { product: q.dimension === 'product' });
    // The scalar the "Top N of M · $total" footer prints, plus the name of the
    // metric it IS — so the footer cannot claim one number and show another.
    out.meta.total_metric = primaryMetricOf(q.metrics);
    out.meta.total = out.meta.total_metric ? out.totals[out.meta.total_metric] ?? null : null;
    if (q.dimension === 'funnel') await attachFunnelNames(query, out.rows);
    if (q.dimension === 'product') {
      // The product fold counts a session once PER LINE, so its rows sum to
      // more orders than exist. The TOTALS therefore come from a distinct
      // count, and the discrepancy is named rather than hidden.
      const distinct = await readDistinctOrders(query, q);
      out.totals.orders = q.metrics.includes('orders') ? distinct.orders : out.totals.orders;
      pushWarning(out.meta.warnings, 'product_dimension',
        'rows count a session once per line; totals.orders is the DISTINCT session count');
    }
    if (previous) {
      const prevRows = breakdownRows(previous.map, previous.q, { rows_scanned: 0 });
      if (q.dimension === 'funnel') await attachFunnelNames(query, prevRows);
      out.previous = {
        rows: prevRows,
        totals: totalsOf(previous.map, previous.q, { product: q.dimension === 'product' }),
        window: { start_day: previous.window.from, end_day: previous.window.to },
      };
    }
  } else {
    out.series = seriesPoints(map, q);
    out.totals = totalsOf(map, q, {});
    if (previous) {
      const prevSeries = seriesPoints(previous.map, previous.q);
      out.previous = {
        // ALIGNED BY INDEX. `series[i]` and `previous.series[i]` are the same
        // ordinal position in their own windows — a Feb/Mar comparison must
        // pair day 1 with day 1, not 2026-02-29 with nothing.
        series: prevSeries,
        totals: totalsOf(previous.map, previous.q, {}),
        window: { start_day: previous.window.from, end_day: previous.window.to },
        aligned_by: 'index',
      };
    }
  }

  if (stats.unapplied_filters.length) {
    pushWarning(out.meta.warnings, 'filters',
      `filter(s) ${stats.unapplied_filters.join(', ')} could not be applied on dimension '${q.dimension ?? 'none'}'`);
  }
  if (ttlRisk(q.window) && folds.traffic) {
    pushWarning(out.meta.warnings, 'lb_touches',
      `window reaches past the ${TOUCH_TTL_DAYS}-day touch retention — sessions and every rate over them are withheld for the affected buckets`);
  }
  // A window running past today is legitimate ("this month" on the 9th). Its
  // unstarted buckets are drawn as nulls rather than zeros; say so, so the gap
  // in the line reads as "not yet" instead of "we lost the data".
  if (!q.dimension && (out.series || []).some((p) => p.future)) {
    pushWarning(out.meta.warnings, 'window',
      `window extends past today (${todayInTz()} in ${REPORT_TZ}); buckets that have not begun report null, never 0`);
  }
  // A DST-transition day is genuinely 23 or 25 hours long. The buckets are
  // right either way (they come from the zone, not from a hard-coded 24), but
  // a reader comparing it to the day before will see a real step and deserves
  // to be told why rather than left to file a bug.
  const dstDays = daysOfWindow(q.window).filter((d) => hoursInLocalDay(d) !== 24);
  if (dstDays.length) {
    pushWarning(out.meta.warnings, 'timezone',
      `window contains a daylight-saving transition in ${REPORT_TZ}: `
        + dstDays.map((d) => `${d} is ${hoursInLocalDay(d)}h`).join(', '),
      { days: dstDays });
  }
  out.meta.computed_ms = Date.now() - t0;
  return out;
}

/** The gap-free timeseries: every bucket in the window, drawn or zero. */
function seriesPoints(map, q) {
  const byBucket = new Map();
  for (const slot of map.values()) {
    let b = byBucket.get(slot.bucket);
    if (!b) { b = { ...emptyAtoms() }; byBucket.set(slot.bucket, b); }
    foldInto(b, slot);
  }
  return bucketsFor(q.window, q.granularity).map((key) => {
    const a = byBucket.get(key) || { ...emptyAtoms() };
    // A bucket with no traffic row and a TTL-crossed date is still UNKNOWN,
    // not zero — the row is missing because it EXPIRED, not because nobody came.
    const day = firstDayOfBucket(key);
    if (day < ttlEdgeDay()) a.sessions_unknown = true;

    // ── A BUCKET THAT HAS NOT BEGUN IS NULL, NOT ZERO ────────────────────
    // "This month" picked on the 9th runs to the 31st. Those days have not
    // happened; drawing them as 0 puts a cliff to zero on the chart that reads
    // as a collapse in sales, and it drags every trend line the operator is
    // about to make a spend decision on.
    //
    // Gated on the bucket being EMPTY on purpose: if a future bucket somehow
    // carries rows, that is a clock or a data anomaly, and blanking it would
    // hide exactly the thing worth seeing.
    if (!byBucket.has(key) && isFutureBucket(key, q.granularity)) {
      const nulls = {};
      for (const m of q.metrics) nulls[m] = null;
      return { key, future: true, ...nulls };
    }
    return { key, future: false, ...computeMetrics(a, q.metrics) };
  });
}

/** Ranked breakdown rows, folded over the whole window. */
function breakdownRows(map, q, stats) {
  const byKey = new Map();
  // ⚠️ THE WINDOW-LEVEL TTL CHECK, and it is not redundant with the per-bucket
  // one. A window entirely past the touch retention produces NO rows at all,
  // so a fold over the (empty) map would report a confident `sessions: 0` —
  // "nobody visited" — for a period whose visitors merely expired. The flag
  // has to come from the WINDOW, not from the rows the window returned.
  const ttlUnknown = ttlRisk(q.window);
  for (const slot of map.values()) {
    let b = byKey.get(slot.key);
    if (!b) { b = { ...emptyAtoms() }; byKey.set(slot.key, b); }
    foldInto(b, slot);
  }
  if (ttlUnknown) for (const b of byKey.values()) b.sessions_unknown = true;
  const sortBy = q.metrics[0];
  const rows = [...byKey.entries()].map(([key, a]) => ({
    key,
    label: key,
    ...computeMetrics(a, q.metrics),
  }));
  rows.sort((x, y) => {
    const a = x[sortBy]; const b = y[sortBy];
    // Nulls sort LAST in both directions: a withheld measurement is not a
    // small one, and burying a funnel because its costs are unknown is exactly
    // how the operator stops seeing the funnels that need attention.
    if (a === null && b === null) return String(x.key).localeCompare(String(y.key));
    if (a === null) return 1;
    if (b === null) return -1;
    return num(b) - num(a) || String(x.key).localeCompare(String(y.key));
  });
  if (stats) stats.rows_total = rows.length;
  return rows.slice(0, q.limit);
}

/** Window totals — folded from atoms, ratios recomputed (never averaged). */
function totalsOf(map, q, { product = false } = {}) {
  const t = { ...emptyAtoms() };
  if (product) {
    // Product rows double-count a multi-line session, so summing them would
    // inflate `orders`. Every OTHER atom is line-scoped and folds honestly.
    for (const slot of map.values()) foldInto(t, { ...slot, orders: 0 });
  } else {
    for (const slot of map.values()) foldInto(t, slot);
  }
  // Same reasoning as breakdownRows: an empty map over a past-TTL window must
  // not report a measured zero.
  if (ttlRisk(q.window)) t.sessions_unknown = true;
  return computeMetrics(t, q.metrics);
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV (C2 as a download) — injection-guarded
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Neutralise a spreadsheet formula.
 *
 * A cell starting with = + - @ (or a leading tab/CR, which Excel strips before
 * looking at the first character) is executed as a formula on open. Funnel
 * names, UTM campaigns and referrer hosts are all ATTACKER-SUPPLIED strings
 * that land in this file, so this is a real injection sink and not a
 * hypothetical one. The guard prefixes a single quote, which Excel and Sheets
 * both treat as "literal text".
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render a runQuery result as CSV. */
export function toCsv(result, q) {
  const metrics = q.metrics;
  const lines = [];
  if (q.dimension) {
    lines.push(['key', 'label', ...metrics].map(csvCell).join(','));
    for (const row of result.rows || []) {
      lines.push([row.key, row.label, ...metrics.map((m) => row[m])].map(csvCell).join(','));
    }
    lines.push(['totals', '', ...metrics.map((m) => result.totals[m])].map(csvCell).join(','));
  } else {
    lines.push(['key', ...metrics].map(csvCell).join(','));
    for (const p of result.series || []) {
      lines.push([p.key, ...metrics.map((m) => p[m])].map(csvCell).join(','));
    }
    lines.push(['totals', ...metrics.map((m) => result.totals[m])].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRESETS — the curated report library
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The reference ships 18 presets. FOUR do not survive the port, and the reason
 * is recorded per preset rather than left as a silent omission:
 *
 *   • conversion_funnel_steps — needs a `step` dimension. Puure has page TYPES
 *     but no pinned 7-step vocabulary on lb_touches; inventing one would put a
 *     funnel-shape chart on screen that no data supports.
 *   • discounts_usage — needs a `discounts` metric. co_sessions carries no
 *     discount column of its own (it is folded into `total`), so the number
 *     would have to be reverse-engineered from a line/total delta that also
 *     contains shipping and tax.
 *   • ltv_cohorts — cohorts/LTV are SKIPPED BY DESIGN for this build.
 *   • contribution_margin_by_funnel — the reference's own version is re-derived
 *     below against OUR cost engine rather than ported, because its metric list
 *     is legal only under the reference's DIM_METRICS.
 *
 * TWO are added: the contribution-margin report above and the one it always
 * gets asked for next — net profit after ad spend.
 *
 * ⚠️ EVERY query below is a VALID body AND LEGAL against the real DIM_METRICS,
 * so the frontend can POST it verbatim and never 422. The harness POSTs all of
 * them; a preset that 422s fails the build.
 */
export const UNSERVABLE_PRESETS = Object.freeze([
  { id: 'conversion_funnel_steps', reason: 'no `step` dimension in Puure — page types are not a pinned funnel vocabulary' },
  { id: 'discounts_usage', reason: 'no `discounts` metric — co_sessions folds discounts into `total`' },
  { id: 'ltv_cohorts', reason: 'cohorts / LTV are out of scope for this build (skipped by design)' },
  { id: 'contribution_margin_by_funnel@reference', reason: 're-derived below against our cost engine; the reference metric list is legal only under its own DIM_METRICS' },
]);

export function reportPresets(startDay, endDay) {
  const window = { start_day: startDay, end_day: endDay };
  const q = (metrics, { dimension = null, granularity = 'day', compare = true, limit = DEFAULT_BREAKDOWN_LIMIT } = {}) => {
    const body = { metrics, filters: {}, window: { ...window }, compare, granularity, limit };
    if (dimension) body.dimension = dimension;
    return body;
  };
  return [
    { id: 'total_sales_over_time', label: 'Total sales over time', category: 'Sales', query: q(['gross_sales', 'net_sales', 'refunds']) },
    // Product money is LINE-PRICED — gross only, never net_sales (a refund
    // entry carries no line reference).
    { id: 'sales_by_product', label: 'Sales by product', category: 'Sales', query: q(['orders', 'gross_sales'], { dimension: 'product' }) },
    { id: 'sales_by_funnel', label: 'Sales by funnel', category: 'Sales', query: q(['orders', 'net_sales', 'aov'], { dimension: 'funnel' }) },
    // ORDER SHIPPING country. Labelled "Sales by country" and never
    // "Pageviews by country" — Puure captures no geo on the traffic spine.
    { id: 'sales_by_country', label: 'Sales by country', category: 'Sales', query: q(['orders', 'net_sales'], { dimension: 'country' }) },
    { id: 'sales_by_gateway', label: 'Sales by gateway', category: 'Sales', query: q(['orders', 'net_sales'], { dimension: 'gateway' }) },
    { id: 'orders_over_time', label: 'Orders over time', category: 'Orders', query: q(['orders']) },
    { id: 'aov_over_time', label: 'Average order value over time', category: 'Sales', query: q(['aov', 'aov_pre_upsell']) },
    { id: 'aov_by_country', label: 'AOV by country', category: 'Sales', query: q(['aov', 'orders'], { dimension: 'country' }) },
    { id: 'new_vs_returning', label: 'New vs returning customers', category: 'Customers', query: q(['new_customers', 'returning_customers']) },
    { id: 'returning_rate', label: 'Returning customer rate', category: 'Customers', query: q(['returning_customers', 'new_customers', 'orders']) },
    { id: 'sessions_over_time', label: 'Sessions over time', category: 'Traffic', query: q(['sessions', 'pageviews']) },
    // The reference keys this on its `page` dimension. Ours keys it on the
    // FIRST touch's path, because "landing page" means the page they arrived
    // on — the reference's version reports the checkout page as the landing
    // page on every order that was minted there.
    { id: 'sessions_by_landing_page', label: 'Landing page performance', category: 'Traffic', query: q(['sessions', 'orders', 'gross_sales'], { dimension: 'landing_page' }) },
    { id: 'upsell_performance', label: 'Upsell performance', category: 'Upsells', query: q(['upsell_revenue', 'upsell_take_pct']) },
    { id: 'refunds_over_time', label: 'Refunds over time', category: 'Refunds', query: q(['refunds', 'net_sales']) },
    // ── THE TWO ADDITIONS ────────────────────────────────────────────────
    // Revenue next to what is actually LEFT of it. `cost_coverage_pct` rides
    // along deliberately: a margin read without knowing how much of the cost
    // side is entered is the flattering number in its last costume.
    {
      id: 'contribution_margin_by_funnel',
      label: 'Contribution margin by funnel',
      category: 'Profitability',
      query: q(['net_sales', 'cogs', 'ship_cost', 'fees', 'net_after_cogs', 'margin_pct', 'cost_coverage_pct'], { dimension: 'funnel' }),
    },
    // ...and the question it always gets asked next. `spend` is TRI-STATE, so
    // an unbound funnel dashes here rather than claiming a profit it has not
    // paid for its traffic out of.
    {
      id: 'net_profit_by_funnel',
      label: 'Net profit by funnel (after spend)',
      category: 'Profitability',
      query: q(['net_sales', 'net_after_cogs', 'spend', 'net_profit', 'roas', 'cpa'], { dimension: 'funnel' }),
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD — ONE composite read
// ═══════════════════════════════════════════════════════════════════════════

const DASHBOARD_SERIES_METRICS = ['gross_sales', 'net_sales', 'orders', 'sessions', 'conv_pct'];
const DASHBOARD_KPIS = ['orders', 'gross_sales', 'net_sales', 'refunds', 'sessions', 'conv_pct',
  'aov', 'new_customers', 'returning_customers'];
const DASHBOARD_KPIS_COST = ['net_after_cogs', 'margin_pct', 'cost_coverage_pct', 'spend', 'roas', 'cpa', 'net_profit'];
const MOVERS_LIMIT = 3;

/**
 * The live band: who is on the site right now, and how many today.
 *
 * "Today" is the REPORT_TZ day, not the UTC one. `date_trunc('day', NOW() AT
 * TIME ZONE $1) AT TIME ZONE $1` is the round trip that matters: the inner
 * conversion gets the local wall clock, the truncation finds local midnight,
 * and the outer one turns that back into the instant the timestamptz column
 * can actually be compared against. Dropping the outer conversion compares a
 * timestamptz to a timestamp and silently re-reads it as UTC.
 */
async function dashboardBand(query, funnelId) {
  const params = [REPORT_TZ];
  let fsql = '';
  if (funnelId) { params.push(funnelId); fsql = ` AND funnel_id = $${params.length}`; }
  const [live] = await query(
    `SELECT COUNT(DISTINCT vid) FILTER (WHERE ts >= NOW() - interval '5 minutes')::bigint AS live,
            COUNT(DISTINCT vid) FILTER (
              WHERE ts >= (date_trunc('day', NOW() AT TIME ZONE $1::text) AT TIME ZONE $1::text)
            )::bigint AS unique_today
     FROM lb_touches
     WHERE ts >= NOW() - interval '26 hours'${fsql}`,
    params
  );
  return { live: int(live?.live), unique_today: int(live?.unique_today) };
}

/**
 * The step waterfall — distinct visitors per funnel step, in flow order.
 *
 * Steps come from funnel_pages.type. A page type outside the vocabulary is
 * NOT dropped: it folds into 'other' and is drawn, because a silently missing
 * step reads as a step nobody visited.
 */
const STEP_ORDER = Object.freeze(['listicle', 'product', 'checkout', 'upsell', 'downsell', 'thankyou', 'other']);
const STEP_LABELS = Object.freeze({
  listicle: 'Landing', product: 'Product', checkout: 'Checkout',
  upsell: 'Upsell', downsell: 'Downsell', thankyou: 'Thank you', other: 'Other',
});
const TYPE_TO_STEP = Object.freeze({
  lead: 'listicle', listicle: 'listicle', optin: 'listicle', quiz: 'listicle', generic: 'listicle',
  product: 'product', checkout: 'checkout', upsell: 'upsell', downsell: 'downsell', thankyou: 'thankyou',
});

async function dashboardWaterfall(query, w, funnelId) {
  // No bucket expression here, so no zone parameter — see `windowBounds`.
  const params = windowBounds(w);
  let fsql = '';
  if (funnelId) { params.push(funnelId); fsql = ` AND t.funnel_id = $${params.length}`; }
  const rows = await query(
    `SELECT COALESCE(NULLIF(p.type, ''), 'generic') AS ptype,
            COUNT(DISTINCT t.vid)::bigint AS visitors
     FROM lb_touches t
     JOIN funnel_pages p ON p.id = t.page_id
     WHERE t.ts >= $1 AND t.ts < $2${fsql}
     GROUP BY 1`,
    params
  );
  const byStep = new Map();
  for (const r of rows) {
    const step = TYPE_TO_STEP[String(r.ptype)] || 'other';
    byStep.set(step, int(byStep.get(step)) + int(r.visitors));
  }
  const top = Math.max(...[...byStep.values()], 0);
  return {
    steps: STEP_ORDER.filter((s) => byStep.has(s)).map((s) => ({
      step: s,
      label: STEP_LABELS[s],
      visitors: byStep.get(s),
      // Share of the WIDEST step, so the bar chart has an honest 100% anchor.
      // Null when there is nothing to compare against, never a fake 0%.
      pct_of_top: top > 0 ? pct(byStep.get(s), top) : null,
    })),
    basis: 'distinct lb_touches.vid per funnel_pages.type',
  };
}

/** Biggest net-sales movers vs the previous window. */
function moversFrom(curRows, prevRows) {
  const prev = new Map(prevRows.map((r) => [r.key, r]));
  const out = [];
  for (const r of curRows) {
    const p = prev.get(r.key);
    // NO DELTA WITHOUT A BASELINE. A funnel with no previous window has an
    // UNKNOWN change, not a 0% one, and it must not be ranked against funnels
    // whose change is measured.
    if (!p || p.net_sales === null || p.net_sales === 0) continue;
    const delta = money(num(r.net_sales) - num(p.net_sales));
    out.push({
      key: r.key,
      label: r.label,
      net_sales: r.net_sales,
      previous_net_sales: p.net_sales,
      delta,
      delta_pct: pct(delta, Math.abs(num(p.net_sales))),
    });
  }
  out.sort((a, b) => Math.abs(num(b.delta)) - Math.abs(num(a.delta)));
  return out.slice(0, MOVERS_LIMIT);
}

/**
 * GET /funnel-metrics/band — the live band, ON ITS OWN.
 *
 * WHY IT IS A SEPARATE ROUTE: the band is the one block that re-polls (every
 * 15s while the tab is visible). Serving it off `/dashboard` would re-run the
 * entire composite — every breakdown, both cost folds, the waterfall — four
 * times a minute, per open tab, to refresh two counters. That is not a
 * micro-optimisation; on the 50K fixture the composite is ~700ms against
 * ~10ms for this.
 *
 * `runDashboard` calls THIS function for its own band, so the polled value and
 * the first paint come from one derivation and cannot drift apart.
 *
 * Its own window is always [yesterday, today] in REPORT_TZ, independent of
 * whatever range the page is showing — "live" and "today" mean today.
 */
export async function runBand({ funnel_id: funnelId } = {}, { query = analyticsQuery } = {}) {
  const t0 = Date.now();
  const fid = idOf(funnelId, 64) || null;
  const today = todayInTz();
  const yesterday = dayAdd(today, -1);
  const w = localWindow(parseWindow({ from: yesterday, to: today }));

  const metrics = ['orders', 'net_sales', 'spend', 'net_profit'];
  const q = {
    metrics,
    dimension: null,
    filters: { funnel_id: fid, country: null, gateway: null, source: null },
    window: w,
    compare: false,
    granularity: 'day',
    limit: DEFAULT_BREAKDOWN_LIMIT,
  };
  const stats = { rows_scanned: 0, unapplied_filters: [] };
  const [live, map] = await Promise.all([
    dashboardBand(query, fid),
    gatherAtoms(query, q, neededFolds(metrics), stats),
  ]);

  const byKey = new Map(seriesPoints(map, q).map((p) => [p.key, p]));
  // `?? null` throughout: an absent bucket is "nothing measured", and the band
  // is the most-glanced-at block on the page — a 0 here is the single easiest
  // place to convince an operator the day is dead when it merely has no rows
  // yet.
  const block = (d) => {
    const p = byKey.get(d) || {};
    return {
      day: d,
      orders: p.orders ?? null,
      revenue: p.net_sales ?? null,
      spend: p.spend ?? null,
      net: p.net_profit ?? null,
    };
  };

  return {
    ...live,
    today: block(today),
    yesterday: block(yesterday),
    timezone: REPORT_TIMEZONE,
    meta: {
      computed_ms: Date.now() - t0,
      rows_scanned: stats.rows_scanned,
      timezone: REPORT_TIMEZONE,
      warnings: [],
    },
  };
}

/**
 * GET /funnel-metrics/dashboard — the whole page in ONE composite read.
 *
 * Everything below runs inside a single Promise.all: the page must not make
 * eleven round trips, and a partially-loaded dashboard where the tiles and the
 * chart disagree is worse than a slow one.
 */
export async function runDashboard({ start, end, funnel_id: funnelId } = {}, { query = analyticsQuery } = {}) {
  const t0 = Date.now();
  // Defaults are REPORT_TZ days: "the last 30 days" must mean the operator's
  // last 30 days, or the default view disagrees with every explicit one.
  const endDay = end || todayInTz();
  const startDay = start || dayAdd(endDay, -29);
  const parsed = parseWindow({ from: startDay, to: endDay });
  if (!parsed.ok) throw new MetricsError(WINDOW_ERRORS.has(parsed.error) ? parsed.error : 'invalid_window', `window rejected: ${parsed.error}`);
  const w0 = localWindow(parsed);
  const fid = idOf(funnelId, 64) || null;
  const prevW = previousWindow(w0);

  const filters = { funnel_id: fid, country: null, gateway: null, source: null };
  const base = { filters, window: w0, compare: false, granularity: 'day', limit: 12 };

  const kpiMetrics = [...DASHBOARD_KPIS];
  const upsellMetrics = ['aov', 'aov_pre_upsell', 'upsell_revenue', 'upsell_take_pct', 'orders', 'abandoned'];

  const runOne = async (metrics, over = {}) => {
    const q = { ...base, ...over, metrics, dimension: over.dimension ?? null };
    const stats = { rows_scanned: 0, unapplied_filters: [] };
    const map = await gatherAtoms(query, q, neededFolds(metrics), stats);
    return { q, map, stats };
  };

  const [
    band, kpiCur, kpiPrev, costCur, costPrev, upsellCur, seriesCur, seriesPrev,
    brFunnels, brProducts, brSources, brCampaigns, brCountries,
    moversPrevRows, waterfall,
  ] = await Promise.all([
    // The SAME function GET /band serves, so the first paint and the 15s
    // repoll can never print different numbers under the same two labels.
    runBand({ funnel_id: fid }, { query }),
    runOne(kpiMetrics),
    runOne(kpiMetrics, { window: prevW }),
    runOne(DASHBOARD_KPIS_COST),
    runOne(DASHBOARD_KPIS_COST, { window: prevW }),
    runOne(upsellMetrics),
    runOne(DASHBOARD_SERIES_METRICS),
    runOne(DASHBOARD_SERIES_METRICS, { window: prevW }),
    runOne(['net_sales', 'orders', 'aov'], { dimension: 'funnel' }),
    runOne(['gross_sales', 'orders'], { dimension: 'product' }),
    runOne(['net_sales', 'orders'], { dimension: 'source' }),
    runOne(['net_sales', 'orders'], { dimension: 'campaign' }),
    runOne(['net_sales', 'orders'], { dimension: 'country' }),
    runOne(['net_sales'], { dimension: 'funnel', window: prevW }),
    dashboardWaterfall(query, w0, fid),
  ]);

  const rowsScanned = [kpiCur, kpiPrev, costCur, costPrev, upsellCur, seriesCur, seriesPrev,
    brFunnels, brProducts, brSources, brCampaigns, brCountries, moversPrevRows]
    .reduce((t, r) => t + r.stats.rows_scanned, 0);

  const kpis = {
    ...totalsOf(kpiCur.map, kpiCur.q, {}),
    ...totalsOf(costCur.map, costCur.q, {}),
    previous: {
      ...totalsOf(kpiPrev.map, kpiPrev.q, {}),
      ...totalsOf(costPrev.map, costPrev.q, {}),
    },
    // The operator's correction, on the tile it is wrong on: the figure
    // labelled "AOV" has always been the POST-upsell one, because net_sales
    // already contains upsell money. Both are published, from the SAME
    // derivation the rest of the page uses, so two screens cannot print
    // different numbers under the same label.
    upsell_lines: (() => {
      const u = totalsOf(upsellCur.map, upsellCur.q, {});
      return {
        aov_post: u.aov,
        aov_pre: u.aov_pre_upsell,
        upsell_revenue: u.upsell_revenue,
        take_rate: u.upsell_take_pct,
        // Reversals are netted off the UPSELL line, never off `refunds` — the
        // base refund ledger and the void ledger are disjoint by construction.
        upsell_refunds: money([...upsellCur.map.values()].reduce((t, s) => t + num(s.upsell_refunds), 0)),
        orders: u.orders,
        abandoned: u.abandoned,
      };
    })(),
  };

  const brFunnelRows = await attachFunnelNames(query, breakdownRows(brFunnels.map, brFunnels.q, null));
  const totalsFor = (r) => totalsOf(r.map, r.q, { product: r.q.dimension === 'product' });
  const summary = (r, presetRows = null) => {
    const st = {};
    const rows = presetRows ?? breakdownRows(r.map, r.q, st);
    if (presetRows) breakdownRows(r.map, r.q, st); // recount for rows_total only
    const totals = totalsFor(r);
    const basis = BREAKDOWN_BASES[r.q.dimension];
    const totalMetric = primaryMetricOf(r.q.metrics);
    const rowsTotal = st.rows_total ?? rows.length;
    return {
      rows,
      totals,
      basis,
      // Describes the METRIC ACTUALLY FOLDED, not just the dimension.
      basis_label: basisLabelFor(basis, r.q.metrics),
      basis_metric: totalMetric,
      // "Top N of M · $total" — BOTH the M and the $ come from the
      // PRE-TRUNCATION fold, so the footer describes the DATA and not the page
      // that happened to fit. `total_metric` names which figure it is, so the
      // footer cannot say "sales" over a column of orders.
      limit: r.q.limit,
      total: totalMetric ? totals[totalMetric] ?? null : null,
      total_metric: totalMetric,
      rows_total: rowsTotal,
      rows_truncated: rowsTotal > rows.length,
    };
  };

  const bandTotals = totalsOf(kpiCur.map, kpiCur.q, {});
  const seriesRows = seriesPoints(seriesCur.map, seriesCur.q);
  const today = todayInTz();

  const out = {
    // Verbatim from runBand — the same object GET /band serves, so the 15s
    // repoll replaces this block wholesale and nothing can drift.
    band: {
      ...band,
      // `in_window` says whether the CHART covers today; the band's own
      // figures are always today's, whatever range the page is showing.
      in_window: today >= w0.from && today <= w0.to,
    },
    kpis,
    series: seriesRows,
    prev_series: seriesPoints(seriesPrev.map, seriesPrev.q),
    breakdown_summary: {
      // Pass the NAME-RESOLVED rows in — re-deriving them here would silently
      // drop the funnels.name join that movers already got.
      funnels: summary(brFunnels, brFunnelRows),
      products: summary(brProducts),
      sources: summary(brSources),
      campaigns: summary(brCampaigns),
      countries: summary(brCountries),
    },
    waterfall,
    movers: moversFrom(brFunnelRows, breakdownRows(moversPrevRows.map, moversPrevRows.q, null)),
    window: {
      start: w0.from,
      end: w0.to,
      prev_start: prevW.from,
      prev_end: prevW.to,
      days: w0.days,
      timezone: REPORT_TIMEZONE,
    },
    meta: {
      computed_ms: 0,
      rows_scanned: rowsScanned,
      basis: 'gross',
      basis_label: basisLabelFor('gross', DASHBOARD_SERIES_METRICS),
      basis_metric: primaryMetricOf(DASHBOARD_SERIES_METRICS),
      timezone: REPORT_TIMEZONE,
      sessions_unknown: ttlRisk(w0) || bandTotals.sessions === null,
      series_aligned_by: 'index',
      // The same window echo every other response carries, so a client reading
      // `meta.window` never has to special-case this endpoint. NOTE: the
      // compare series here is `prev_series` (a flat sibling of `series`);
      // `previous.series` is the /query shape. Two endpoints, two documented
      // keys, and the harness pins both.
      window: {
        start: w0.from, end: w0.to, days: w0.days, timezone: REPORT_TIMEZONE,
      },
      warnings: [],
    },
  };
  if (ttlRisk(w0)) {
    pushWarning(out.meta.warnings, 'lb_touches',
      `window reaches past the ${TOUCH_TTL_DAYS}-day touch retention — sessions and every rate over them are withheld for the affected buckets`);
  }
  if (bandTotals.sessions === null) {
    pushWarning(out.meta.warnings, 'sessions', 'sessions withheld for this window (touch retention)');
  }
  if (seriesRows.some((p) => p.future)) {
    pushWarning(out.meta.warnings, 'window',
      `window extends past today (${today} in ${REPORT_TZ}); buckets that have not begun report null, never 0`);
  }
  out.meta.computed_ms = Date.now() - t0;
  return out;
}

export default {
  METRICS, METRIC_META, DIMENSIONS, DIMENSION_META, DIM_METRICS,
  BREAKDOWN_BASES, BREAKDOWN_BASIS_LABELS, UNAVAILABLE_DIMENSIONS,
  GRANULARITIES, MetricsError, validateQuery, previousWindow, computeMetrics,
  runQuery, runDashboard, runBand, reportPresets, toCsv, csvCell, neededFolds,
  bucketOf, bucketsFor, weekKey, monthKey, ttlRisk, isFutureBucket,
  basisLabelFor, primaryMetricOf,
  REPORT_TZ, REPORT_TIMEZONE, zonedDayStart, dayInTz, todayInTz,
  hoursInLocalDay, localWindow, UNSERVABLE_PRESETS,
  HOUR_ONLY_EXCLUSIONS, MAX_WINDOW_DAYS, MAX_METRICS, MAX_BREAKDOWN_LIMIT,
};
