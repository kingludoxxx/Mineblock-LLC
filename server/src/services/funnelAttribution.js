// Ad performance & attribution — LANE 2 (SELF-CONTAINED, NEW FILE).
//
// READ-ONLY. There is not a single INSERT/UPDATE/DELETE in this file and there
// never may be: this subsystem reports on money and on the ad ledger, it never
// writes either. Every number is derived from rows at query time (DECISIONS #6,
// ledgers not counters).
//
// Every read here goes through the ISOLATED analytics pool (analyticsDb) — the
// same reasoning liveView.js and funnelAnalytics.js record: a slow report must
// never be able to hold the money path's connections or trip its breaker. The
// ONE documented exception is `getSpendDaily`, which delegates to the existing
// funnelSpend.funnelSpendByDay (shared pool) rather than forking the
// campaign→funnel binding rule into a second implementation — see that
// function's own note.
//
// ⚠️ THIS FILE'S READ PERFORMANCE DEPENDS ON DDL IT DOES NOT OWN. The last-touch
// LATERAL matches a paid session by its STAMPED session_id, which is only fast
// because of `idx_lb_clicks_session` in trackingSchema.js — the one index this
// lane added there. That ensure runs on the first tracking request (or the first
// harness ensure), NOT on import of this file, so on a database where the
// tracking schema has never been ensured the first /marketing call is a
// sequential scan per paid session (measured 43,283ms at 100K clicks / 5K
// orders, which the analytics pool's 8s statement_timeout turns into a 500;
// 92ms with the index). trackingSchema is the single owner of lb_* DDL and this
// file deliberately does not re-ensure it — but the dependency is real, so it is
// stated here rather than discovered in production.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFINITIONS. Read these before trusting any number this file returns.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── THE REPORTING DAY IS A MADRID DAY (operator decision, overrides UTC) ───
//   REPORT_TZ defaults to 'Europe/Madrid' and is env-overridable. EVERY day
//   key this file emits or accepts, and every window bound it applies, is a
//   Madrid calendar day.
//
//   WHY, and it is not a preference: lb_ad_spend_daily's `meta` rows are
//   written from the Meta Marketing API, and a Meta ad account reports in ITS
//   OWN account timezone — this account's is Europe/Madrid. Those day keys are
//   therefore ALREADY Madrid days. Bucketing revenue on UTC days while joining
//   it to spend bucketed on Madrid days silently shifts one side of every ROAS
//   by one to two hours of orders: a 23:30Z conversion is Madrid *tomorrow*,
//   and under UTC bucketing it would be divided by *today's* spend. The join
//   would be wrong every single day, most visibly on the highest-spend days.
//
//   THE ALIGNMENT ASSUMPTION, STATED SO IT CAN BE FALSIFIED: this file assumes
//   `lb_ad_spend_daily.day` for source='meta' IS the ad account's Madrid day.
//   That is true while the ad account's timezone is Europe/Madrid. If the
//   account timezone is ever changed, or a second account on another timezone
//   is added, this join becomes wrong and the fix is at the SYNC (funnelSpend),
//   not here — spend rows would have to carry their own account timezone.
//   Every spend/revenue join below points back at this paragraph.
//
//   DST IS HANDLED BY POSTGRES, NOT BY ARITHMETIC. Window bounds are built as
//   `(day::date)::timestamp AT TIME ZONE $tz`, so 2026-03-29 is a 23-hour day
//   and 2026-10-25 is a 25-hour day without a single hardcoded offset. Nothing
//   in this file ever adds "+1 hour" or "+2 hours" to anything. Day-string
//   ARITHMETIC (start = end − 29 days) is calendar arithmetic on the string and
//   is timezone-free by construction, which is why it stays correct across a
//   DST boundary that would break an instant-based subtraction.
//
// ── TWO ENDPOINTS, TWO REVENUE BASES — AND THEY ARE NAMED ON THE WIRE ──────
//   /marketing is an ORDER WINDOW: every order whose `paid_at` falls in the
//   window, keyed by whatever click or touch preceded it — however long before
//   the window that click happened.
//   /roas is a CLICK COHORT: every click whose `first_seen` falls in the
//   window, carrying the revenue of the orders those clicks converted — even
//   when the order was paid after the window closed.
//
//   THESE ARE DIFFERENT QUESTIONS AND THEY WILL DISAGREE, by design. "What did
//   last month's revenue come from" is the first; "did the clicks I bought last
//   month pay for themselves" is the second. Undisclosed, that difference reads
//   as a bug — two cards on one page, two numbers, no explanation. So every
//   response carries `revenue_basis` ('order_window' | 'click_cohort') and
//   `revenue_basis_label`, and any surface drawing both must print them.
//
// ── ONE LAST-TOUCH RESOLVER, FOUR KEYS ─────────────────────────────────────
//   `readAttributedSessions` resolves, per PAID session, exactly one click row
//   and one touch row; `resolveKeys` then derives campaign / source / referrer
//   / landing_page from that single pair. There is deliberately no second
//   resolver: four dimensions that disagreed about which touch was "last"
//   would be four different reports wearing one date range.
//
//   THE CHAIN (spec order, with one addition that is strictly stronger):
//     1. the click STAMPED to this session (lb_clicks.session_id = session.id,
//        written by trackingClicks.stampConversion — an exact click-id match
//        from the session's own captured vault), else
//     2. the visitor's latest non-bot lb_clicks row with ts <= paid_at, else
//     3. the visitor's latest lb_touches row with ts <= paid_at (utm only), else
//     4. 'direct / none'.
//   Step 1 is an addition to the written spec (DECISION MADE): it is the same
//   "last touch before payment" question answered by a stronger identity than
//   the vid cookie, and Puure's create-session does not always persist a vid
//   (trackingClicks:188). Without it, a session whose click WAS exactly matched
//   would fall through to 'direct / none' — inventing unattributed revenue.
//
//   `ts <= paid_at` IS LOAD-BEARING AND IS NOT COSMETIC. A click after the
//   purchase cannot have caused it; without the bound, a returning visitor's
//   NEXT ad click would retroactively re-attribute a closed order. The harness
//   proves this by seeding a later, richer click that must lose.
//
//   FUNNEL SCOPE — A SCOPED QUESTION GETS A SCOPED JOURNEY (DECISION MADE).
//   When a funnel filter is supplied, BOTH laterals are scoped to that funnel:
//   a visitor who clicked an ad for funnel A and then bought on funnel B has
//   that order read as unattributed WITHIN B, because inside B's report there
//   is no ad that produced it. Unscoped (no funnel filter) the resolver stays
//   VISITOR-GLOBAL and the cross-funnel journey resolves to its campaign. The
//   old behaviour scoped /roas but not /marketing, so the two cards on one page
//   could contradict each other on exactly this journey; now they agree.
//
//   BOTS NEVER ATTRIBUTE. lb_clicks.bot is written once, on insert
//   (DECISIONS #10), so a click farm cannot re-route a campaign's revenue.
//   Bot rows stay VISIBLE in the /clicks ledger (they are real rows and an
//   operator must be able to see what was excluded) and are counted, named, in
//   `bot_clicks` on every ROAS row — excluded from conversions, never hidden.
//   Their CPC is still counted as COST: the network charged for those clicks.
//   Any row whose ledger cost includes bot cpc says so in `cost_note`.
//
// ── THE MONEY BASIS — captured_base, and it is named on the wire ───────────
//   /marketing sums co_sessions.total for MONEY_MOVED sessions. That is the
//   CAPTURED BASE: the base cart's capture. Upsell legs (co_upsell_charges)
//   are NOT in it and must not be — an upsell leg has no UTM, no referrer and
//   no landing page of its own, so attributing it to a campaign would be a
//   guess printed as a fact. Every response carries `basis: 'captured_base'`
//   and `basis_label`, so the card's "captured base only — upsell money has no
//   UTM" copy is TRUE rather than decorative. A breakdown without a basis is
//   unshippable.
//
//   MONEY_MOVED is `paid_at IS NOT NULL AND status IN ('paid','refunded')` —
//   byte-identical to funnelAnalytics:198. 'processing' is INTENT, not money;
//   'refunded' is included so a refund nets against a sale instead of deleting
//   it (see funnelAnalytics' header for the full argument).
//
// ── UNATTRIBUTED IS A STATE, NOT A KEY ─────────────────────────────────────
//   'direct / none'  — no click and no touch survived for this session at all.
//   '(not set)'      — the visit WAS recorded, this dimension simply was not
//                      tagged (a lander with no utm_campaign).
//   Folding them into one bucket would tell an operator "40% of your revenue
//   is direct" when the truth is "40% of your paid traffic is untagged" — a
//   different problem with a different fix.
//
//   AND THE STATE IS CARRIED OUT-OF-BAND, in `attribution`
//   (resolved | untagged | none), NOT inferred from the key text. A campaign
//   literally named "direct / none" or "(not set)" exists the moment somebody
//   types it into a UTM, and inferring the state from the string merged that
//   real campaign's money into the unattributed bucket — silently, and in the
//   direction that makes paid traffic look organic. Keys that collide with a
//   sentinel keep their money in their own row and get a disambiguating
//   `label` suffix so the two are distinguishable on screen.
//
// ── THE 90-DAY TTL CEILING ─────────────────────────────────────────────────
//   lb_clicks and lb_touches both carry expires_at at 90 days (trackingSchema).
//   A window whose left edge is older than that has an ERODED ATTRIBUTION
//   ledger while co_sessions (no TTL) still has every order. The money totals
//   stay exact; the SPLIT silently drifts toward 'direct / none'. That is
//   flagged as `attribution_ttl_risk` with a named warning rather than served
//   quietly — and it is NOT a reason to withhold the totals, which are
//   measured from a table that never expired.
//
// ── COST, AND THE BRANCHES IT CAN COME FROM ────────────────────────────────
//   Precedence, highest first — `cost_source` is a FIELD on every ROAS row, so
//   no card ever has to infer where a number came from:
//     'meta_api'    lb_ad_spend_daily(source='meta'), keyed by the campaign ids
//                   in the group. True platform spend.
//     'pin_manual'  the group's campaign is PINNED to a funnel (lb_campaign_map)
//                   and that funnel carries operator-typed spend
//                   (lb_ad_spend_daily source='manual', ref_id=funnel_id).
//     'ledger'      Σ lb_clicks.cpc — the `&cost=`/`&cpc=` macro the network
//                   templated into the landing URL (Taboola/Outbrain/MGID/…).
//     'mixed'       more than one of the above, or a KNOWN-PARTIAL total: some
//                   of the group's spend was resolvable and some was refused.
//                   `cost_note` says which part is missing.
//     'unknown'     nothing measured it. cost is NULL.
//
//   NULL IS NOT ZERO, and this is the single most important line in the file.
//   Meta templates no cost macro, so a Meta group's ledger cost is 0. Printing
//   `Cost $0.00` beside `ROAS —` is two adjacent cells contradicting each
//   other, one of them claiming the traffic was free. Unknown cost ⇒ cost null,
//   roas null, cpa null. Never Infinity, never 0.
//
//   A PARTIAL COST IS NEVER ALLOWED TO LOOK CLEAN. If part of a group's spend
//   is knowable and part is refused, the answer is `mixed` plus a note — not a
//   tidy smaller number under a confident source name, which understates cost
//   and overstates ROAS in the same stroke.
//
//   THE GRANULARITY RULE. Platform spend is CAMPAIGN-granular. At
//   sub1..sub10 a campaign spans many groups, so adding its full spend to each
//   would MULTIPLY the money. Those dimensions therefore never fold API spend:
//   they keep ledger cost, and when there is none they report cost null with
//   `cost_unknown_reason: 'api_by_campaign_only'` — "the spend exists, at a
//   granularity this dimension cannot honestly split".
//
//   PINS AND AMBIGUITY. Manual spend is keyed to a FUNNEL, not a campaign. It
//   can only be handed to a campaign group when exactly ONE campaign is pinned
//   to that funnel. Two pinned campaigns and one manual number is an
//   allocation nobody measured — split pro-rata by clicks it would look like a
//   fact, so it is refused and NAMED (`pin_ambiguous`, or `mixed` when part of
//   the group's cost was still resolvable).
//
//   THE TOTALS ROW IS NOT THE SUM OF THE ROWS, ON PURPOSE. A campaign that
//   spent money and got ZERO clicks has no group to appear in — under a
//   rows-summed total, $5,000 of real spend was invisible and the window ROAS
//   was computed as though it had never been spent. The totals row therefore
//   folds the window's platform spend UNRESTRICTED by which campaigns were
//   clicked, and publishes `untracked_campaigns` plus a `cost_note` whenever
//   the two sets differ.
import { analyticsQuery } from './analyticsDb.js';
import { parseWindow } from './funnelAnalytics.js';
import { funnelSpendByDay } from './funnelSpend.js';

// THE predicate — byte-identical to funnelAnalytics:198 on purpose.
const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

// lb_touches / lb_clicks TTL (trackingSchema: 90 days).
const ATTRIBUTION_TTL_DAYS = 90;

/**
 * The reporting timezone. Operator decision: the Meta ad account reports in
 * Europe/Madrid, so lb_ad_spend_daily's day keys already are Madrid days and
 * revenue must be bucketed the same way or every ROAS join is off by the UTC
 * offset. Env-overridable for a future account on another timezone — but see
 * the alignment assumption in the header before changing it.
 */
export const REPORT_TZ = process.env.REPORT_TZ || 'Europe/Madrid';

export const MARKETING_DIMENSIONS = Object.freeze(['campaign', 'source', 'referrer', 'landing_page']);
export const ROAS_DIMENSIONS = Object.freeze([
  'network', 'campaign',
  'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7', 'sub8', 'sub9', 'sub10',
]);
export const COST_SOURCES = Object.freeze(['meta_api', 'pin_manual', 'ledger', 'mixed', 'unknown']);
export const ATTRIBUTION_STATES = Object.freeze(['resolved', 'untagged', 'none']);

// Platform spend is campaign-granular; only these two dimensions can fold it
// into a ROW without multiplying it across sibling groups. (The TOTALS row is
// exempt — folding the window's spend once is exact at any dimension.)
const CAMPAIGN_GRAIN = Object.freeze(['network', 'campaign']);

export const BASIS = 'captured_base';
// Mirrors lb_analytics_service.BREAKDOWN_BASIS_LABELS['captured_base'],
// re-worded only where Puure has no rebills.
export const BASIS_LABEL =
  'captured base only — upsell money has no UTM, gateway or referrer of its own and is not in here';

export const REVENUE_BASIS_LABELS = Object.freeze({
  order_window: 'orders whose payment landed inside the window, keyed by the click or visit that preceded them — however long before the window that was',
  click_cohort: 'clicks first seen inside the window, carrying the revenue of the orders they converted — including orders paid after the window closed',
});

export const DIRECT_KEY = 'direct / none';
export const NOT_SET_KEY = '(not set)';
const SENTINEL_KEYS = Object.freeze([DIRECT_KEY, NOT_SET_KEY]);
// What to call a REAL key that collides with a sentinel, per dimension.
const DIMENSION_NOUN = Object.freeze({
  campaign: 'campaign', source: 'source', referrer: 'referrer', landing_page: 'landing page',
});

// One ceiling for every windowed endpoint in this lane. /roas was already
// capped at 180 days; /marketing and /spend-daily inheriting parseWindow's 400
// meant three surfaces on one page refused at three different widths.
const MAX_REPORT_DAYS = 180;
const MAX_CLICK_ROWS = 500;
const MAX_MARKETING_ROWS = 200;
const DEFAULT_MARKETING_ROWS = 12; // = lb_analytics_service RANK_LIMIT
const MAX_FUNNEL_FANOUT = 500;

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const idOf = (v, max = 120) => String(v ?? '').trim().slice(0, max);

// ── Day keys in the reporting timezone ─────────────────────────────────────
// Intl is the ONLY offset authority here — no table of offsets, no arithmetic,
// so DST is handled by the platform's tz database rather than by this file.
const DAY_FMT = new Map();
function dayFormatter(tz) {
  if (!DAY_FMT.has(tz)) {
    DAY_FMT.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return DAY_FMT.get(tz);
}

/** The calendar day an instant falls on, in `tz`. en-CA formats as YYYY-MM-DD. */
export function dayKeyInTz(instant, tz = REPORT_TZ) {
  return dayFormatter(tz).format(new Date(instant));
}

/**
 * Calendar-day arithmetic on a day STRING. Deliberately not instant
 * arithmetic: "29 days before 2026-03-30" is a calendar question, and doing it
 * on instants makes the answer depend on whether a DST transition sits in
 * between. Stepping the string through UTC midnights is exact for every day.
 */
export function shiftDay(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days from day `a` to day `b` (b − a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Validate {start,end} and return a TZ-AWARE window.
 *
 * The VALIDATION is funnelAnalytics.parseWindow — one owner for "is this a real
 * YYYY-MM-DD, is to >= from" — with the same error codes so both lanes' routes
 * map identically. Its UTC instants (fromTs/toTs) are DELIBERATELY DISCARDED:
 * this lane's bounds are built in Postgres with AT TIME ZONE, because a JS Date
 * computed at UTC midnight is the wrong instant for a Madrid day and would be
 * wrong by a different amount on either side of a DST transition. The width cap
 * is this lane's own (180 days), tighter than parseWindow's 400.
 */
export function resolveWindow({ start, end } = {}, { tz = REPORT_TZ, now = Date.now() } = {}) {
  const today = dayKeyInTz(now, tz);
  const to = end === undefined || end === null || end === '' ? today : String(end);
  const from = start === undefined || start === null || start === ''
    ? shiftDay(to, -29)
    : String(start);
  const w = parseWindow({ from, to });
  if (!w.ok) return w;
  if (w.days > MAX_REPORT_DAYS) return { ok: false, error: 'window_too_large' };
  return { ok: true, from: w.from, to: w.to, days: w.days, tz };
}

/**
 * Push [from, to, tz] onto `params` and return the half-open bound predicate
 * for a timestamptz column, evaluated in the reporting timezone.
 *
 * `(day::date)::timestamp AT TIME ZONE tz` is the instant of local midnight on
 * that day — DST-correct by construction, including the 23h and 25h days.
 * The right edge is (to + 1 day) local midnight, so `to` is included in full,
 * exactly once.
 */
function tzBounds(params, w, col) {
  params.push(w.from); const a = params.length;
  params.push(w.to); const b = params.length;
  params.push(w.tz); const z = params.length;
  const sql = `${col} >= ($${a}::date)::timestamp AT TIME ZONE $${z}::text
      AND ${col} <  (($${b}::date) + 1)::timestamp AT TIME ZONE $${z}::text`;
  // tzIdx is returned rather than assumed: a caller that also buckets BY day
  // needs the same placeholder, and hardcoding "$3" would break the moment a
  // parameter is added ahead of the bounds.
  return { sql, tzIdx: z };
}

/** Positive integer with a ceiling; anything malformed returns null → 400. */
function boundedInt(raw, def, max) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) return null;
  return Math.min(n, max);
}

/** Host + path of a URL, query dropped. */
function urlKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, 'http://x');
    const host = u.host === 'x' ? '' : u.host;
    const path = u.pathname || '/';
    return (host ? `${host}${path}` : path).slice(0, 200);
  } catch {
    return s.slice(0, 200);
  }
}

/** Bare host of a referrer. '' when there was no referring site. */
function hostKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    return new URL(s, 'http://x').host.replace(/^x$/, '').slice(0, 200);
  } catch {
    return s.slice(0, 200);
  }
}

const jsonOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * The ONE resolver's key derivation — pure, so the harness can exercise every
 * branch without a database.
 *
 * Returns keys AND the attribution STATE beside them. The state is the
 * authority on whether a row is unattributed; the key text never is. See the
 * header: a real campaign called "direct / none" must not be able to launder
 * its money into the unattributed bucket by being named after it.
 *
 * @returns {{keys:{campaign:string,source:string,referrer:string,landing_page:string},
 *            attribution:{[dim:string]:'resolved'|'untagged'|'none'},
 *            basis_of:{[dim:string]:string}}}
 */
export function resolveKeys(row = {}) {
  const clickUtm = jsonOf(row.click_utm);
  const clickStruct = jsonOf(row.click_struct);
  const touchUtm = jsonOf(row.touch_utm);
  const seen = Boolean(row.has_click) || Boolean(row.has_touch);

  // '(not set)' only when we DID see the visit. No visit at all is a different
  // fact and gets a different bucket (see the header).
  const blank = () => (seen
    ? { key: NOT_SET_KEY, from: 'untagged', state: 'untagged' }
    : { key: DIRECT_KEY, from: 'none', state: 'none' });

  const pick = (...cands) => {
    for (const [val, from] of cands) {
      const v = idOf(val, 200);
      if (v) return { key: v, from, state: 'resolved' };
    }
    return blank();
  };

  const campaign = pick(
    [clickUtm.utm_campaign, 'click_utm'],
    [clickStruct.campaign_id, 'click_struct'],
    [touchUtm.utm_campaign, 'touch_utm']
  );
  const source = pick(
    [clickUtm.utm_source, 'click_utm'],
    [row.network, 'click_network'],
    [touchUtm.utm_source, 'touch_utm']
  );
  // A blank referrer where a visit WAS recorded is not "untagged" — it is the
  // measurement: nothing referred this visitor. So referrer collapses to
  // 'direct / none' rather than '(not set)'.
  const referrerHost = hostKey(row.referrer);
  const referrer = referrerHost
    ? { key: referrerHost, from: 'touch_referrer', state: 'resolved' }
    : { key: DIRECT_KEY, from: 'none', state: 'none' };
  const landing = pick(
    [urlKey(row.landing_url), 'click_landing_url'],
    [urlKey(row.touch_url), 'touch_url']
  );

  const parts = { campaign, source, referrer, landing_page: landing };
  const keys = {};
  const attribution = {};
  const basis_of = {};
  for (const [dim, p] of Object.entries(parts)) {
    keys[dim] = p.key;
    attribution[dim] = p.state;
    basis_of[dim] = p.from;
  }
  return { keys, attribution, basis_of };
}

/**
 * THE last-touch read. One row per MONEY_MOVED session in the window, each
 * carrying at most one click and at most one touch.
 *
 * Both LATERALs are bounded by `ts <= s.paid_at`, scoped to the funnel when one
 * was asked for (header: funnel scope), and the click LATERAL orders the
 * STAMPED row first, so the resolver's chain is expressed in SQL exactly once.
 * `ORDER BY ..., id DESC` makes a tie on an identical instant deterministic
 * rather than planner-dependent.
 *
 * PERFORMANCE: the `c.session_id = p.id` disjunct rides idx_lb_clicks_session
 * (trackingSchema) and the `c.vid = p.vid` disjunct rides idx_lb_clicks_vid;
 * the planner combines them with a BitmapOr. Without the former this is a seq
 * scan per paid session — see the asterisk at the top of the file.
 */
export async function readAttributedSessions({ funnelId = '', w }, { query = analyticsQuery } = {}) {
  const params = [];
  const { sql: bounds } = tzBounds(params, w, 's.paid_at');
  let sessionFunnelSql = '';
  let clickFunnelSql = '';
  let touchFunnelSql = '';
  if (funnelId) {
    params.push(funnelId);
    const i = params.length;
    sessionFunnelSql = ` AND s.funnel_id = $${i}`;
    // A scoped question gets a scoped journey: an ad click recorded against a
    // DIFFERENT funnel is not this funnel's acquisition, and letting it key a
    // row here is exactly what made /marketing and /roas disagree.
    clickFunnelSql = ` AND c.funnel_id = $${i}`;
    touchFunnelSql = ` AND t.funnel_id = $${i}`;
  }
  return query(
    `WITH paid AS (
       -- NULLIF(vid,'') IS A PLANNER DECISION, NOT A TIDINESS ONE. It moves the
       -- "does this session even have a vid" guard OUT of the LATERAL's OR: a
       -- disjunct carrying a condition on the OUTER relation is not an
       -- indexable qual on lb_clicks, so Postgres could not build a BitmapOr
       -- and fell back to a sequential scan PER PAID SESSION (measured: the
       -- whole read blew the 8s pool timeout at 50K clicks / 2.5K orders).
       -- With a NULL vid, \`c.vid = p.vid\` is simply never true — same
       -- semantics, and both disjuncts are now pure index lookups.
       SELECT s.id, NULLIF(s.vid, '') AS vid, s.paid_at, s.total, s.currency
       FROM co_sessions s
       WHERE ${MONEY_MOVED_SQL} AND ${bounds}${sessionFunnelSql}
     )
     SELECT p.id, p.total, p.currency,
            c.network          AS network,
            c.utm              AS click_utm,
            c.struct           AS click_struct,
            c.landing_url      AS landing_url,
            t.utm              AS touch_utm,
            t.referrer         AS referrer,
            t.url              AS touch_url,
            (c.id IS NOT NULL) AS has_click,
            (t.id IS NOT NULL) AS has_touch
     FROM paid p
     LEFT JOIN LATERAL (
       SELECT c.id, c.network, c.utm, c.struct, c.landing_url
       FROM lb_clicks c
       WHERE c.bot = FALSE
         AND c.ts <= p.paid_at
         -- \`c.session_id <> ''\` is what lets the PARTIAL index be used: a
         -- partial index is only usable when the query's quals IMPLY its
         -- predicate, and \`session_id = $1\` does not imply \`session_id <> ''\`
         -- to the planner (it cannot know the parameter). Session ids are never
         -- empty — '' is the column's "not stamped" default — so this changes
         -- no row, only whether the index is reachable.
         AND (( c.session_id <> '' AND c.session_id = p.id) OR c.vid = p.vid)
         ${clickFunnelSql}
       ORDER BY (c.session_id = p.id) DESC, c.ts DESC, c.id DESC
       LIMIT 1
     ) c ON TRUE
     LEFT JOIN LATERAL (
       SELECT t.id, t.utm, t.referrer, t.url
       FROM lb_touches t
       WHERE t.vid = p.vid AND t.ts <= p.paid_at
         ${touchFunnelSql}
       ORDER BY t.ts DESC, t.id DESC
       LIMIT 1
     ) t ON TRUE`,
    params
  );
}

/** True when the window reaches back past the click/touch TTL. */
function ttlRisk(w, now = Date.now()) {
  return daysBetween(w.from, dayKeyInTz(now, w.tz)) > ATTRIBUTION_TTL_DAYS;
}

/**
 * GET /funnel-attribution/marketing — "Sales attributed to marketing".
 *
 * `totals` folds EVERY bucket, not the returned page: the footer
 * "Top N of M · $total" is only true if the $total survived the truncation.
 */
export async function getMarketing(
  { start, end, funnelId = '', dimension = 'campaign', limit } = {},
  { query = analyticsQuery, now = Date.now(), tz = REPORT_TZ } = {}
) {
  const dim = String(dimension || 'campaign');
  if (!MARKETING_DIMENSIONS.includes(dim)) return { error: 'invalid_dimension' };
  const fid = idOf(funnelId, 64);
  const cap = boundedInt(limit, DEFAULT_MARKETING_ROWS, MAX_MARKETING_ROWS);
  if (cap === null) return { error: 'invalid_limit' };
  const w = resolveWindow({ start, end }, { tz, now });
  if (!w.ok) return { error: w.error };

  const t0 = Date.now();
  const rows = await readAttributedSessions({ funnelId: fid, w }, { query });

  // Buckets are keyed by (state, key), NOT by key alone: a real campaign named
  // "direct / none" is a different bucket from the unattributed one.
  const buckets = new Map();
  const currencies = new Set();
  let orders = 0;
  let sales = 0;
  for (const r of rows) {
    const resolved = resolveKeys(r);
    const key = resolved.keys[dim];
    const state = resolved.attribution[dim];
    const amt = num(r.total);
    orders += 1;
    sales += amt;
    if (r.currency) currencies.add(String(r.currency));
    const id = `${state} ${key}`;
    const b = buckets.get(id) || { key, state, orders: 0, sales: 0 };
    b.orders += 1;
    b.sales += amt;
    buckets.set(id, b);
  }

  const noun = DIMENSION_NOUN[dim] || dim;
  const all = [...buckets.values()]
    .map((b) => ({
      key: b.key,
      // A real key that collides with a sentinel is disambiguated in the LABEL
      // so the two rows are distinguishable on screen; the key itself is left
      // untouched so a filter round-trips.
      label: b.state === 'resolved' && SENTINEL_KEYS.includes(b.key)
        ? `${b.key} (${noun})`
        : b.key,
      orders: b.orders,
      sales: round2(b.sales),
      attribution: b.state,
      is_unattributed: b.state !== 'resolved',
    }))
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders || (a.key < b.key ? -1 : 1));

  // Bars are drawn against the LEADER, which is what makes the longest bar full
  // width. With no positive sales anywhere there is no scale — null, not 0, so
  // nothing renders a full bar off a $0 denominator.
  const top = all.length ? all[0].sales : 0;
  const page = all.slice(0, cap).map((r) => ({
    ...r,
    bar_pct: top > 0 ? Math.round((r.sales / top) * 1000) / 10 : null,
  }));

  const warnings = [];
  const risk = ttlRisk(w, now);
  if (risk) {
    warnings.push({
      source: 'lb_clicks/lb_touches',
      reason: `window reaches past the ${ATTRIBUTION_TTL_DAYS}-day attribution TTL — orders and sales are exact, but the pre-TTL share of the split has drifted into "${DIRECT_KEY}"`,
    });
  }

  return {
    dimension: dim,
    rows: page,
    totals: { orders, sales: round2(sales), rows_total: all.length },
    basis: BASIS,
    basis_label: BASIS_LABEL,
    revenue_basis: 'order_window',
    revenue_basis_label: REVENUE_BASIS_LABELS.order_window,
    funnel_scoped: Boolean(fid),
    attribution_ttl_risk: risk,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    mixed_currency: currencies.size > 1,
    warnings,
    window: { start: w.from, end: w.to, days: w.days, timezone: w.tz },
    meta: { computed_ms: Date.now() - t0, rows_scanned: rows.length },
  };
}

// ── ROAS ───────────────────────────────────────────────────────────────────

/**
 * `dimension` → the lb_clicks expression that keys it. Never interpolated from
 * raw user input: the dimension is checked against ROAS_DIMENSIONS first, so
 * only these literal fragments can ever reach the SQL.
 */
function roasKeyExpr(dim) {
  if (dim === 'network') return `NULLIF(c.network, '')`;
  if (dim === 'campaign') return `NULLIF(c.struct->>'campaign_id', '')`;
  return `NULLIF(c.subs->>'${dim}', '')`; // sub1..sub10, whitelisted above
}

/**
 * Cost for one ROAS group. Returns
 * {cost, cost_source, cost_unknown_reason, cost_note}. Pure — every branch is
 * exercised by the harness without a database.
 */
export function resolveCost(group, {
  campaignGrain,
  metaSpendByCid = new Map(),
  manualByCampaign = new Map(),
} = {}) {
  const ledger = round2(num(group.ledger_cost));
  const metaLedger = round2(num(group.meta_ledger_cost));
  const botLedger = round2(num(group.bot_ledger_cost));
  const botClicks = Number(group.bot_clicks) || 0;
  const campaigns = (group.campaigns || []).filter(Boolean);
  const networks = new Set((group.networks || []).filter(Boolean));

  // The network charged for bot clicks, so their cpc IS cost — but a row whose
  // cost is partly bot traffic should say so rather than let an operator read
  // it as spend on humans.
  const botNote = botLedger > 0
    ? `includes $${botLedger.toFixed(2)} of cpc on ${botClicks} bot click${botClicks === 1 ? '' : 's'} — the network charged for them`
    : null;
  const joinNote = (...parts) => parts.filter(Boolean).join('; ') || null;

  if (campaignGrain) {
    // 1. PLATFORM API. Replaces the meta slice of the ledger (which is always
    //    0 in practice — Meta templates no cost macro) and keeps any non-meta
    //    ledger cost that shares the group.
    //    THE JOIN: metaSpendByCid was summed over lb_ad_spend_daily rows whose
    //    `day` keys are the ad account's MADRID days, and the click/revenue
    //    window that produced this group was bounded on Madrid days too. See
    //    the alignment assumption in the file header.
    const api = round2(campaigns.reduce((s, cid) => s + num(metaSpendByCid.get(cid)), 0));
    if (api > 0) {
      const mixedSources = networks.size > 1 || !networks.has('meta') || ledger - metaLedger > 0;
      return {
        cost: round2(ledger - metaLedger + api),
        cost_source: mixedSources ? 'mixed' : 'meta_api',
        cost_unknown_reason: null,
        cost_note: joinNote(
          mixedSources ? 'platform spend plus non-meta ledger cpc in the same group' : null,
          botNote
        ),
      };
    }
    // 2. OPERATOR PIN → the pinned funnel's manual spend. Only when the pin is
    //    unambiguous: one campaign, one funnel, one number.
    if (campaigns.length) {
      let resolvable = 0;
      let hit = false;
      let ambiguous = 0;
      for (const cid of campaigns) {
        const m = manualByCampaign.get(cid);
        if (!m) continue;
        if (m.ambiguous) { ambiguous += 1; continue; }
        resolvable += num(m.spend);
        hit = true;
      }
      if (hit && !ambiguous) {
        return {
          cost: round2(resolvable + (ledger - metaLedger)),
          cost_source: 'pin_manual',
          cost_unknown_reason: null,
          cost_note: joinNote('operator-typed funnel spend, attributed via a lb_campaign_map pin', botNote),
        };
      }
      if (ambiguous) {
        // KNOWN-PARTIAL. Anything we could resolve is still reported, but never
        // under a clean source name — a tidy understated cost overstates ROAS.
        const partial = round2(resolvable + (ledger - metaLedger));
        if (partial > 0) {
          return {
            cost: partial,
            cost_source: 'mixed',
            cost_unknown_reason: null,
            cost_note: joinNote(
              `partial — ${ambiguous} pinned campaign${ambiguous === 1 ? '' : 's'} ambiguous and excluded (their funnel has more than one pinned campaign, so the manual spend cannot be split)`,
              botNote
            ),
          };
        }
        return {
          cost: null,
          cost_source: 'unknown',
          cost_unknown_reason: 'pin_ambiguous',
          cost_note: joinNote(
            'manual spend is keyed to a funnel with more than one pinned campaign — splitting it here would be a guess',
            botNote
          ),
        };
      }
    }
  }

  // 3. THE CLICK LEDGER — the `&cost=`/`&cpc=` macro.
  if (ledger > 0) {
    return { cost: ledger, cost_source: 'ledger', cost_unknown_reason: null, cost_note: botNote };
  }

  // 4. NOTHING MEASURED IT. Not a measurement of zero.
  const apiExistsElsewhere = !campaignGrain
    && campaigns.some((cid) => num(metaSpendByCid.get(cid)) > 0);
  return {
    cost: null,
    cost_source: 'unknown',
    cost_unknown_reason: apiExistsElsewhere ? 'api_by_campaign_only' : 'no_signal',
    cost_note: joinNote(
      apiExistsElsewhere
        ? 'platform spend exists for these campaigns but is campaign-granular — folding it into this dimension would multiply it'
        : null,
      botNote
    ),
  };
}

/** cost/conversions and revenue/cost, refusing every degenerate denominator. */
function costRates(cost, conversions, revenue) {
  const known = cost !== null && cost !== undefined;
  return {
    cpa: known && conversions > 0 ? round2(cost / conversions) : null,
    // cost === 0 is "known free", and revenue/0 is Infinity — refused.
    roas: known && cost > 0 ? round2(revenue / cost) : null,
  };
}

/**
 * GET /funnel-attribution/roas.
 *
 * WINDOW: the last `days` MADRID days, ending with today (Madrid) inclusive —
 * the same day keys lb_ad_spend_daily is written on, so the spend join lines up
 * day for day (header: alignment assumption).
 *
 * BASIS: click cohort, NOT order window — see the header. Named on the wire as
 * `revenue_basis` so a page drawing this beside /marketing can say why they
 * differ.
 *
 * Revenue is DEDUPED PER (group, session): a visitor who clicked Meta AND
 * TikTok has both rows stamped with the same session_id, and summing the
 * session total per click double-counts a cross-network journey. Deduping in
 * SQL keeps it exact per group; window totals are deduped ACROSS groups by
 * their own DISTINCT, so the totals row is never the sum of the rows.
 */
export async function getRoas(
  { funnelId = '', days = 30, dimension = 'network', limit } = {},
  { query = analyticsQuery, now = Date.now(), tz = REPORT_TZ } = {}
) {
  const dim = String(dimension || 'network');
  if (!ROAS_DIMENSIONS.includes(dim)) return { error: 'invalid_dimension' };
  const d = boundedInt(days, 30, MAX_REPORT_DAYS);
  if (d === null) return { error: 'invalid_days' };
  const cap = boundedInt(limit, MAX_MARKETING_ROWS, MAX_MARKETING_ROWS);
  if (cap === null) return { error: 'invalid_limit' };
  const fid = idOf(funnelId, 64);

  const endDay = dayKeyInTz(now, tz);
  const w = { from: shiftDay(endDay, -(d - 1)), to: endDay, days: d, tz };
  const t0 = Date.now();

  const params = [];
  const { sql: bounds } = tzBounds(params, w, 'c.first_seen');
  let funnelSql = '';
  if (fid) {
    params.push(fid);
    funnelSql = ` AND c.funnel_id = $${params.length}`;
  }

  // MATERIALIZED so lb_clicks is scanned once for both the per-group branch and
  // the window-totals branch.
  const sql = `
    WITH cl AS MATERIALIZED (
      SELECT ${roasKeyExpr(dim)} AS k,
             c.bot AS bot,
             COALESCE(c.cpc, 0) AS cpc,
             COALESCE(c.network, '') AS network,
             COALESCE(c.struct->>'campaign_id', '') AS cid,
             CASE WHEN c.converted AND NOT c.bot THEN NULLIF(c.session_id, '') END AS conv_sid
      FROM lb_clicks c
      WHERE ${bounds}${funnelSql}
    ),
    agg AS (
      SELECT COALESCE(k, $${params.length + 1}::text) AS k,
             COUNT(*)::int AS clicks,
             COUNT(*) FILTER (WHERE bot)::int AS bot_clicks,
             COALESCE(SUM(cpc), 0) AS ledger_cost,
             COALESCE(SUM(cpc) FILTER (WHERE network = 'meta'), 0) AS meta_ledger_cost,
             COALESCE(SUM(cpc) FILTER (WHERE bot), 0) AS bot_ledger_cost,
             COALESCE(ARRAY_AGG(DISTINCT cid) FILTER (WHERE cid <> ''), '{}') AS campaigns,
             COALESCE(ARRAY_AGG(DISTINCT network) FILTER (WHERE network <> ''), '{}') AS networks
      FROM cl GROUP BY 1
    ),
    conv AS (
      SELECT DISTINCT COALESCE(cl.k, $${params.length + 1}::text) AS k, s.id AS sid, s.total AS total
      FROM cl JOIN co_sessions s ON s.id = cl.conv_sid
      WHERE ${MONEY_MOVED_SQL}
    ),
    rev AS (
      SELECT k, COUNT(*)::int AS conversions, COALESCE(SUM(total), 0) AS revenue
      FROM conv GROUP BY k
    ),
    tot_agg AS (
      SELECT COUNT(*)::int AS clicks,
             COUNT(*) FILTER (WHERE bot)::int AS bot_clicks,
             COALESCE(SUM(cpc), 0) AS ledger_cost,
             COALESCE(SUM(cpc) FILTER (WHERE network = 'meta'), 0) AS meta_ledger_cost,
             COALESCE(SUM(cpc) FILTER (WHERE bot), 0) AS bot_ledger_cost,
             COALESCE(ARRAY_AGG(DISTINCT cid) FILTER (WHERE cid <> ''), '{}') AS campaigns,
             COALESCE(ARRAY_AGG(DISTINCT network) FILTER (WHERE network <> ''), '{}') AS networks
      FROM cl
    ),
    tot_rev AS (
      SELECT COUNT(*)::int AS conversions, COALESCE(SUM(total), 0) AS revenue
      FROM (SELECT DISTINCT sid, total FROM conv) x
    )
    SELECT a.k, a.clicks, a.bot_clicks, a.ledger_cost, a.meta_ledger_cost, a.bot_ledger_cost,
           a.campaigns, a.networks,
           COALESCE(r.conversions, 0) AS conversions, COALESCE(r.revenue, 0) AS revenue,
           FALSE AS is_total
    FROM agg a LEFT JOIN rev r ON r.k = a.k
    UNION ALL
    SELECT NULL::text, t.clicks, t.bot_clicks, t.ledger_cost, t.meta_ledger_cost, t.bot_ledger_cost,
           t.campaigns, t.networks, v.conversions, v.revenue, TRUE
    FROM tot_agg t, tot_rev v`;

  const raw = await query(sql, [...params, DIRECT_KEY]);
  const groups = raw.filter((r) => !r.is_total);
  const totalRow = raw.find((r) => r.is_total) || null;

  // Every campaign id anywhere in the window's CLICKS.
  const clickedCids = new Set();
  for (const g of raw) for (const c of g.campaigns || []) if (c) clickedCids.add(String(c));

  const [metaSpendByCid, manualByCampaign] = await Promise.all([
    readWindowMetaSpend(w, { funnelId: fid, clickedCids: [...clickedCids] }, { query }),
    readPinnedManualSpend([...clickedCids], w, { query }),
  ]);

  // THE GHOST-SPEND FOLD. Campaigns that spent money in the window and were
  // never clicked have no group to live in; summing the rows would make that
  // money invisible and inflate the window ROAS. The totals row folds the whole
  // window's platform spend instead, and names the gap.
  const untracked = [...metaSpendByCid.entries()]
    .filter(([cid, spend]) => num(spend) > 0 && !clickedCids.has(cid))
    .map(([cid]) => cid);
  const windowMetaSpend = round2(
    [...metaSpendByCid.values()].reduce((s, v) => s + num(v), 0)
  );

  const campaignGrain = CAMPAIGN_GRAIN.includes(dim);
  const groupOf = (g) => ({
    ledger_cost: g.ledger_cost,
    meta_ledger_cost: g.meta_ledger_cost,
    bot_ledger_cost: g.bot_ledger_cost,
    bot_clicks: g.bot_clicks,
    campaigns: (g.campaigns || []).map(String),
    networks: (g.networks || []).map(String),
  });

  const shape = (g, isTotal) => {
    let c = resolveCost(groupOf(g), { campaignGrain, metaSpendByCid, manualByCampaign });
    if (isTotal && windowMetaSpend > 0) {
      const ledger = round2(num(g.ledger_cost));
      const metaLedger = round2(num(g.meta_ledger_cost));
      const note = untracked.length
        ? `window total — includes $${round2(untracked.reduce((s, cid) => s + num(metaSpendByCid.get(cid)), 0)).toFixed(2)} of platform spend on ${untracked.length} campaign${untracked.length === 1 ? '' : 's'} with no clicks in this window, which appear in no row`
        : 'window total — platform spend folded once over the whole window, not summed from the rows';
      c = {
        cost: round2(ledger - metaLedger + windowMetaSpend),
        cost_source: untracked.length || ledger - metaLedger > 0 ? 'mixed' : 'meta_api',
        cost_unknown_reason: null,
        cost_note: [note, c.cost_note].filter(Boolean).join('; '),
      };
    }
    const revenue = round2(num(g.revenue));
    const conversions = Number(g.conversions) || 0;
    return {
      ...(isTotal ? { untracked_campaigns: untracked.length } : { key: String(g.k), label: String(g.k) }),
      clicks: Number(g.clicks) || 0,
      bot_clicks: Number(g.bot_clicks) || 0,
      conversions,
      revenue,
      cost: c.cost,
      cost_known: c.cost !== null,
      cost_source: c.cost_source,
      cost_unknown_reason: c.cost_unknown_reason,
      cost_note: c.cost_note,
      ...costRates(c.cost, conversions, revenue),
    };
  };

  const rows = groups
    .map((g) => shape(g, false))
    .sort((a, b) => b.revenue - a.revenue || b.clicks - a.clicks || (a.key < b.key ? -1 : 1));

  return {
    dimension: dim,
    rows: rows.slice(0, cap),
    totals: totalRow ? shape(totalRow, true) : {
      untracked_campaigns: untracked.length,
      clicks: 0, bot_clicks: 0, conversions: 0, revenue: 0,
      cost: null, cost_known: false, cost_source: 'unknown',
      cost_unknown_reason: 'no_signal', cost_note: null, cpa: null, roas: null,
    },
    rows_total: rows.length,
    row_cap: rows.length > cap,
    untracked_campaigns: untracked.length,
    basis: BASIS,
    basis_label: BASIS_LABEL,
    revenue_basis: 'click_cohort',
    revenue_basis_label: REVENUE_BASIS_LABELS.click_cohort,
    funnel_scoped: Boolean(fid),
    cost_sources: COST_SOURCES,
    window: { start: w.from, end: w.to, days: d, timezone: w.tz },
    meta: { computed_ms: Date.now() - t0, rows_scanned: groups.length },
  };
}

/**
 * campaign_id → Σ platform spend over the window's MADRID day keys.
 *
 * DELIBERATELY A SUPERSET of the clicked campaigns: the totals row has to be
 * able to see spend on a campaign that got no clicks at all. When a funnel
 * filter is in play, the un-clicked half is limited to campaigns the operator
 * PINNED to that funnel — a zero-click campaign has no click evidence binding
 * it to any funnel, and inventing one would be a guess.
 *
 * lb_ad_spend_daily.day is a TEXT day key written by the Meta sync — the ad
 * account's own (Madrid) day. Comparing it against Madrid day strings is
 * therefore like-for-like, with no re-parse and no timezone maths (header:
 * alignment assumption).
 */
async function readWindowMetaSpend(w, { funnelId = '', clickedCids = [] } = {}, { query = analyticsQuery } = {}) {
  const out = new Map();
  let rows;
  if (funnelId) {
    rows = await query(
      `SELECT ref_id, COALESCE(SUM(spend), 0) AS spend
       FROM lb_ad_spend_daily
       WHERE source = 'meta' AND day >= $1 AND day <= $2
         AND (ref_id = ANY($3)
              OR ref_id IN (SELECT campaign_id FROM lb_campaign_map WHERE funnel_id = $4))
       GROUP BY ref_id`,
      [w.from, w.to, clickedCids, funnelId]
    );
  } else {
    rows = await query(
      `SELECT ref_id, COALESCE(SUM(spend), 0) AS spend
       FROM lb_ad_spend_daily
       WHERE source = 'meta' AND day >= $1 AND day <= $2
       GROUP BY ref_id`,
      [w.from, w.to]
    );
  }
  for (const r of rows) out.set(String(r.ref_id), round2(num(r.spend)));
  return out;
}

/**
 * campaign_id → {spend, ambiguous}. Manual spend is keyed to a FUNNEL; a pin
 * hands it to a campaign only when that funnel has exactly one pinned
 * campaign. More than one and the allocation is unmeasured — flagged
 * `ambiguous` so resolveCost can refuse it (or report a named partial) instead
 * of inventing a split.
 */
async function readPinnedManualSpend(cids, w, { query = analyticsQuery } = {}) {
  const out = new Map();
  if (!cids.length) return out;
  const pins = await query(
    `SELECT campaign_id, funnel_id FROM lb_campaign_map WHERE campaign_id = ANY($1)`,
    [cids]
  );
  if (!pins.length) return out;
  // How many campaigns each of those funnels has pinned IN TOTAL — a pin
  // outside the current window still competes for the same manual dollars.
  const fids = [...new Set(pins.map((p) => String(p.funnel_id)))];
  const [counts, manual] = await Promise.all([
    query(
      `SELECT funnel_id, COUNT(*)::int AS n FROM lb_campaign_map
       WHERE funnel_id = ANY($1) GROUP BY funnel_id`,
      [fids]
    ),
    query(
      `SELECT ref_id, COALESCE(SUM(spend), 0) AS spend
       FROM lb_ad_spend_daily
       WHERE source = 'manual' AND ref_id = ANY($1) AND day >= $2 AND day <= $3
       GROUP BY ref_id`,
      [fids, w.from, w.to]
    ),
  ]);
  const nByFid = new Map(counts.map((c) => [String(c.funnel_id), Number(c.n) || 0]));
  const spendByFid = new Map(manual.map((m) => [String(m.ref_id), round2(num(m.spend))]));
  for (const p of pins) {
    const fid = String(p.funnel_id);
    const spend = spendByFid.get(fid);
    if (spend === undefined) continue;
    out.set(String(p.campaign_id), { spend, ambiguous: (nByFid.get(fid) || 0) > 1, funnel_id: fid });
  }
  return out;
}

/**
 * GET /funnel-attribution/clicks — THE LEDGER.
 * Time · Network · Click ID · Campaign · Country · Device · CPC · Converted,
 * all on lb_clicks. Bot rows are INCLUDED and flagged: the ledger is what an
 * operator checks when a ROAS row's conversions look short, so the rows that
 * were excluded from conversions have to be visible here.
 *
 * `start`/`end` are optional and bound `first_seen` on Madrid days — the same
 * window vocabulary as every other endpoint here, so "show me the clicks behind
 * this ROAS row" is one navigation rather than a scroll through everything.
 */
export async function getClicks(
  { funnelId = '', limit, network = '', start, end } = {},
  { query = analyticsQuery, tz = REPORT_TZ, now = Date.now() } = {}
) {
  const cap = boundedInt(limit, 100, MAX_CLICK_ROWS);
  if (cap === null) return { error: 'invalid_limit' };
  const fid = idOf(funnelId, 64);
  const net = idOf(network, 40);

  const windowed = (start !== undefined && start !== null && start !== '')
    || (end !== undefined && end !== null && end !== '');
  let w = null;
  if (windowed) {
    w = resolveWindow({ start, end }, { tz, now });
    if (!w.ok) return { error: w.error };
  }

  const params = [];
  const where = [];
  if (w) {
    const { sql: bounds } = tzBounds(params, w, 'first_seen');
    where.push(bounds);
  }
  if (fid) { params.push(fid); where.push(`funnel_id = $${params.length}`); }
  if (net) { params.push(net); where.push(`network = $${params.length}`); }
  params.push(tz);
  const tzIdx = params.length;
  params.push(cap);

  const t0 = Date.now();
  const rows = await query(
    `SELECT id, first_seen,
            to_char(first_seen AT TIME ZONE $${tzIdx}::text, 'YYYY-MM-DD') AS day,
            network, click_id, click_key,
            struct->>'campaign_id' AS campaign_id,
            country, device, cpc, converted, converted_at, session_id,
            bot, velocity_flag
     FROM lb_clicks
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY first_seen DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      time: r.first_seen,
      day: r.day, // the Madrid day this click is reported on
      network: r.network || '',
      click_id: r.click_id,
      click_key: r.click_key || '',
      campaign: r.campaign_id || '',
      country: r.country || '',
      // device is captured on the CLICK only (the network's own signal). It is
      // NOT a site-wide device breakdown — lb_touches carries no device until
      // Lane 5 — so nothing here may be re-labelled "traffic by device".
      device: r.device || '',
      cpc: r.cpc === null || r.cpc === undefined ? null : round2(r.cpc),
      converted: Boolean(r.converted),
      converted_at: r.converted_at,
      session_id: r.session_id || '',
      bot: Boolean(r.bot),
      velocity_flag: Boolean(r.velocity_flag),
    })),
    limit: cap,
    truncated: rows.length >= cap,
    timezone: tz,
    window: w ? { start: w.from, end: w.to, days: w.days, timezone: w.tz } : null,
    meta: { computed_ms: Date.now() - t0, rows_scanned: rows.length },
  };
}

/**
 * GET /funnel-attribution/spend-daily — one entry per MADRID day of the
 * window, with the day's captured-base revenue beside it.
 *
 * THE JOIN THIS ENDPOINT EXISTS TO MAKE HONEST: `spend` comes from
 * lb_ad_spend_daily, whose day keys are the ad account's Madrid days;
 * `sales`/`orders` are bucketed with `paid_at AT TIME ZONE REPORT_TZ`. Both
 * sides of the daily ROAS are therefore the same calendar day — a 23:30Z
 * conversion is reported on the NEXT Madrid day and divides that day's spend,
 * which is the day Meta charged for the click that produced it. (Header:
 * alignment assumption — this is only true while the ad account is Madrid-tz.)
 *
 * DECISION MADE — THE ONE POOL DEVIATION IN THIS FILE. The spend half
 * delegates to funnelSpend.funnelSpendByDay, which reads through the SHARED
 * pool. The alternative was re-deriving the campaign→funnel majority-vote
 * binding (funnelSpend:258, ~90 lines incl. the bot-vote exclusion and the
 * click-after-purchase guard) against the analytics pool. Two implementations
 * of "what a funnel's spend is" WILL drift, and the day they do, the P&L page
 * and the Analytics page print different spend under one name — the exact
 * failure the basis labelling in this lane exists to prevent. One owner of the
 * number beats one owner of the connection. The read is bounded (window capped
 * at 180 days; keyed reads on lb_ad_spend_daily's PK and lb_campaign_map's PK).
 * The revenue half uses the analytics pool as normal.
 *
 * `spend` is NULL, never 0, on any day of a funnel whose spend is not KNOWN —
 * a 0 reads as "no ad spend", which is the opposite of "we could not measure".
 */
export async function getSpendDaily(
  { start, end, funnelId = '' } = {},
  { query = analyticsQuery, spendByDay = funnelSpendByDay, now = Date.now(), tz = REPORT_TZ } = {}
) {
  const w = resolveWindow({ start, end }, { tz, now });
  if (!w.ok) return { error: w.error };
  const fid = idOf(funnelId, 64);

  const t0 = Date.now();
  let fids = fid ? [fid] : [];
  let funnelsTruncated = false;
  if (!fids.length) {
    // ORDER BY id so the fan-out is deterministic — an unordered LIMIT can
    // return a different 500 funnels on two identical requests, which would
    // make the same window print two different totals.
    const rows = await query(
      `SELECT id FROM funnels WHERE NOT archived ORDER BY id LIMIT ${MAX_FUNNEL_FANOUT + 1}`
    );
    funnelsTruncated = rows.length > MAX_FUNNEL_FANOUT;
    fids = rows.slice(0, MAX_FUNNEL_FANOUT).map((r) => String(r.id));
  }

  // Calendar-day enumeration — timezone-free by construction (see shiftDay).
  const days = [];
  for (let i = 0; i < w.days; i += 1) days.push(shiftDay(w.from, i));

  if (!fids.length) {
    return {
      series: days.map((day) => ({ day, spend: null, orders: 0, sales: 0, roas: null })),
      total: null,
      total_sales: 0,
      spend_known: false,
      funnels: [],
      funnels_truncated: funnelsTruncated,
      basis: BASIS,
      basis_label: BASIS_LABEL,
      revenue_basis: 'order_window',
      revenue_basis_label: REVENUE_BASIS_LABELS.order_window,
      window: { start: w.from, end: w.to, days: w.days, timezone: w.tz },
      meta: { computed_ms: Date.now() - t0, rows_scanned: 0 },
    };
  }

  // Revenue per Madrid day, captured base, MONEY_MOVED only.
  const revParams = [];
  const { sql: bounds, tzIdx } = tzBounds(revParams, w, 's.paid_at');
  revParams.push(fids);
  const revFunnelSql = ` AND s.funnel_id = ANY($${revParams.length})`;
  const revRows = await query(
    `SELECT to_char(s.paid_at AT TIME ZONE $${tzIdx}::text, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS orders,
            COALESCE(SUM(s.total), 0) AS sales
     FROM co_sessions s
     WHERE ${MONEY_MOVED_SQL} AND ${bounds}${revFunnelSql}
     GROUP BY 1`,
    revParams
  );
  const revByDay = new Map(revRows.map((r) => [String(r.day), r]));

  // bindStart widens the BINDING window without widening the spend window: a
  // funnel that is down today has no sales to vote with, and binding on the
  // spend window alone would leave exactly the campaigns you most need to see
  // unbound (funnelSpend:366).
  const { days: byFid, known } = await spendByDay(fids, w.from, w.to, {
    bindStart: shiftDay(w.from, -30),
  });

  // Known only when EVERY requested funnel's spend is known — a partial answer
  // summed into one series would understate spend while looking complete.
  const allKnown = fids.length > 0 && fids.every((f) => known[f]);

  const series = days.map((day) => {
    const rev = revByDay.get(day);
    const orders = rev ? Number(rev.orders) || 0 : 0;
    const sales = rev ? round2(num(rev.sales)) : 0;
    if (!allKnown) return { day, spend: null, orders, sales, roas: null };
    let s = 0;
    for (const f of fids) s += num((byFid[f] || {})[day]);
    const spend = round2(s);
    return { day, spend, orders, sales, roas: spend > 0 ? round2(sales / spend) : null };
  });

  return {
    series,
    total: allKnown ? round2(series.reduce((s, r) => s + num(r.spend), 0)) : null,
    total_sales: round2(series.reduce((s, r) => s + num(r.sales), 0)),
    spend_known: allKnown,
    funnels: fids.map((f) => ({ funnel_id: f, spend_known: Boolean(known[f]) })),
    funnels_truncated: funnelsTruncated,
    basis: BASIS,
    basis_label: BASIS_LABEL,
    revenue_basis: 'order_window',
    revenue_basis_label: REVENUE_BASIS_LABELS.order_window,
    window: { start: w.from, end: w.to, days: w.days, timezone: w.tz },
    meta: { computed_ms: Date.now() - t0, rows_scanned: revRows.length },
  };
}

export const ATTRIBUTION_DEFINITIONS = Object.freeze({
  timezone: `Every day key and window bound is a ${REPORT_TZ} calendar day, because lb_ad_spend_daily's meta rows are already written on the ad account's ${REPORT_TZ} days. Bucketing revenue on UTC days would divide each day's orders by the wrong day's spend.`,
  revenue_basis_order_window: `/marketing and /spend-daily: ${REVENUE_BASIS_LABELS.order_window}.`,
  revenue_basis_click_cohort: `/roas: ${REVENUE_BASIS_LABELS.click_cohort}. It will not equal the order-window number for the same dates, and that is the definition, not a defect.`,
  last_touch: 'The stamped click for the session, else the visitor\'s latest non-bot ad click at or before paid_at, else the visitor\'s latest pageview\'s UTM, else "direct / none". Bot clicks never attribute.',
  funnel_scope: 'With a funnel filter, the click and touch behind an order must belong to that funnel — a cross-funnel journey reads as unattributed inside the scoped report. Without a funnel filter the resolver is visitor-global.',
  captured_base: BASIS_LABEL,
  attribution_state: 'resolved | untagged | none, carried out-of-band in `attribution`. A row is unattributed because of its STATE, never because its key text looks like a sentinel — a real campaign named "direct / none" keeps its own row and gets a disambiguating label.',
  direct_none: 'No click and no touch survived for this order — nothing measured where it came from.',
  not_set: 'The visit was recorded, but this dimension was not tagged on it.',
  cost_source: 'Where a ROAS row\'s cost came from: meta_api (platform spend) > pin_manual (operator spend via a campaign pin) > ledger (Σ lb_clicks.cpc) > mixed (more than one, or a KNOWN-PARTIAL total — cost_note says what is missing) > unknown (cost null; roas and cpa are withheld, never 0 or Infinity).',
  bot_cost: 'Bot clicks never produce conversions or revenue, but their cpc IS counted as cost — the network charged for them. Any row whose cost includes bot cpc says so in cost_note, with the amount and the click count.',
  totals_row: 'The ROAS totals row is NOT the sum of the rows. It folds the window\'s platform spend once, including campaigns that spent money and got zero clicks (untracked_campaigns) — those have no row to appear in, and omitting them would inflate the window ROAS.',
  ttl: `lb_clicks and lb_touches expire at ${ATTRIBUTION_TTL_DAYS} days. Beyond that, orders and sales stay exact but their attribution drifts into "direct / none" — reported as attribution_ttl_risk.`,
  window_cap: `Every windowed endpoint in this lane refuses a range wider than ${MAX_REPORT_DAYS} days.`,
});

export default {
  getMarketing, getRoas, getClicks, getSpendDaily,
  resolveKeys, resolveCost, readAttributedSessions, resolveWindow,
  dayKeyInTz, shiftDay, daysBetween,
  MARKETING_DIMENSIONS, ROAS_DIMENSIONS, COST_SOURCES, ATTRIBUTION_STATES, REPORT_TZ,
  BASIS, BASIS_LABEL, REVENUE_BASIS_LABELS, DIRECT_KEY, NOT_SET_KEY,
  ATTRIBUTION_DEFINITIONS,
};
