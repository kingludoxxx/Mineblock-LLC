// Funnel analytics — per-page and per-funnel metrics (SELF-CONTAINED, NEW FILE).
//
// Feeds the canvas node overlays and the Analytics view. READ-ONLY: there is
// not a single INSERT/UPDATE/DELETE in this file, and there never may be. Every
// number is DERIVED FROM ROWS AT QUERY TIME (DECISIONS #6, ledgers not
// counters) — nothing here reads a counter, so a crediting bug can be fixed by
// deploying a fix, not by rebuilding history.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFINITIONS. Read these before trusting any number this file returns.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── MONEY_MOVED — the single most important predicate here ─────────────────
//   `paid_at IS NOT NULL AND status IN ('paid','refunded')`
//
//   DECISIONS #5: `processing` is INTENT, not money. Most started checkouts
//   never pay; counting them inflates revenue by roughly an order of
//   magnitude. That is the friend's #1 analytics bug and it is closed here by
//   construction: every revenue query in this file goes through
//   MONEY_MOVED_SQL, and none of them can see a `processing` row.
//
//   BUT `status = 'paid'` ALONE IS ALSO WRONG, and this is the subtler trap.
//   gatewayWebhooks.applyRefund flips a session to `'refunded'` once cumulative
//   refunds cover the total. A `status = 'paid'` filter therefore DROPS fully
//   refunded sessions entirely — so a refund would make GROSS revenue fall,
//   the order would vanish from the order count, and the refund would never
//   appear in the refunded column. That is a counter mutating under you, which
//   is exactly what "ledgers not counters" exists to prevent. Including
//   'refunded' keeps the sale visible and lets the refund net against it.
//   (funnel-os independently reached the same set: _MONEY_STATUSES =
//   ("paid", "deposit_paid", "refunded"). Puure has no deposit status.)
//
//   `paid_at IS NOT NULL` is belt-and-braces: a status set without a timestamp
//   would otherwise land in every window at once.
//
// ── VISITORS (per page) ────────────────────────────────────────────────────
//   COUNT(DISTINCT vid) over `lb_touches` rows carrying that page_id in the
//   window. `lb_touches` is one row per pageview (trackingAttribution
//   collapses same-URL replays inside 45s), `vid` is the browser-scoped
//   visitor cookie. So: UNIQUE BY (page_id, vid).
//
//   WHY lb_touches and not lb_clicks: lb_clicks is the INBOUND AD click ledger
//   (one row per ad click, carrying fbclid/gclid). It measures acquisition, not
//   page traffic — a visitor who arrives organically has a touch and no click.
//   WHY not lb_visitor_firstseen: that is the FIRST-TOUCH acquisition registry.
//   DECISIONS #8 is explicit that first-touch counts and last-click money share
//   labels but not denominators, and dividing one by the other produces a
//   conversion rate that means nothing. This file never crosses that line: the
//   CVR denominator and the CVR numerator both live on the page.
//
//   Funnel-level visitors is its OWN distinct count over the whole funnel, NOT
//   the sum of per-page visitors — one visitor touching three pages is three
//   page-visitor rows but one funnel visitor. The harness asserts this.
//
//   CEILING: lb_touches carries a 90-day TTL (expires_at). Any window whose
//   left edge is older than that silently loses rows. `traffic_ttl_risk` is
//   returned true in that case rather than publishing a rate off a truncated
//   denominator.
//
// ── CTR — HONEST ANSWER: PUURE EMITS NO CLICK-THROUGH EVENT ────────────────
//   There is no CTA/click beacon. trackingRuntime posts exactly two things:
//   `/click` (ad-click id capture — INBOUND, not intra-funnel) and `/collect`
//   with event_name 'PageView'. lb_tracking_events carries pixel dispatch
//   records, not user interactions. A TRUE per-page click-through rate is
//   therefore NOT COMPUTABLE from the data this repo records today.
//
//   Rather than invent one, this file returns a labelled LOWER BOUND on the
//   forward-action rate, from two independently-measurable proxies:
//     step_through_rate = visitors on P who later touched a DIFFERENT page of
//                         the same funnel, within the window ÷ visitors(P)
//     submit_rate       = distinct vids that minted a checkout session on P
//                         ÷ visitors(P)
//   `ctr` = max(step_through_rate, submit_rate), with `ctr_basis` naming which
//   one won and `ctr_is_proxy: true` always set.
//
//   WHY max AND NOT A UNION: the two proxies come from different tables, and
//   the whole point of keeping the tracking read and the money read in
//   SEPARATE queries is that either can fail without taking the page down. A
//   union would weld them into one query and one failure domain. max() of two
//   distinct-vid counts over the same population is a valid LOWER BOUND on
//   their union, so `ctr` under-reports rather than over-reports. That is the
//   safe direction for a number an operator makes spend decisions on.
//
//   To get a true CTR, emit a per-page CTA beacon (funnel-os's `submit` event:
//   one per page load, deduped by a window flag — undeduped it hit 120-150%).
//   Until then this stays a proxy and stays labelled.
//
// ── CVR ────────────────────────────────────────────────────────────────────
//   orders(P) ÷ visitors(P), where orders(P) = MONEY_MOVED sessions whose
//   `page_id` is P. Both sides are scoped to the same page, so no first-touch
//   count is ever divided by a last-click count.
//
//   KNOWN DENOMINATOR SHAPE, stated because it will surprise someone:
//   co_sessions.page_id is the page the checkout was MINTED on. For a
//   two-step funnel (lander → checkout) the lander's CVR is 0 and the
//   checkout page's CVR is high, because the lander never mints a session.
//   That is arithmetically correct and operationally confusing, so the
//   FUNNEL-level CVR (orders ÷ funnel-wide unique visitors) is what the
//   overview cards show, and per-page CVR is labelled page-origin.
//
// ── THE CLAMP (ported from funnel-os _derive) ──────────────────────────────
//   visitors_effective = max(visitors_raw, submits, orders). You cannot buy
//   without visiting, so a rate above 100% is a measurement artefact (a lost
//   beacon, an ad-blocked touch), not a fact. Rates are computed on the
//   clamped denominator; the UNCLAMPED truth is published beside it as
//   `rate_conflict` so the artefact is visible rather than erased.
//
// ── WINDOW SEMANTICS — which timestamp, and why ────────────────────────────
//   traffic  → lb_touches.ts        (when the visit happened)
//   submits  → co_sessions.created_at  (a submit IS the creation event)
//   orders   → co_sessions.paid_at  ← DIVERGES FROM funnel-os ON PURPOSE
//   refunds  → the refund entry's own `at`, NOT the order's date
//
//   funnel-os windows revenue on created_at because its schema has no
//   settlement timestamp. Puure HAS paid_at, and paid_at is the correct field:
//   revenue belongs to the day the money moved. Using created_at would credit
//   a Tuesday settlement of a Monday checkout to Monday, and — worse — would
//   let a session's created_at define a revenue window before it was ever
//   known whether it would pay.
//
//   Refunds dated on their own entry (funnel-os does this too) means a window
//   can show net < gross, and a window containing only a refund can show a
//   NEGATIVE net. That is correct ledger behaviour and is not clamped.
//
//   THE BOUNDARY EFFECT THIS CREATES, stated rather than hidden: a visitor who
//   lands on the last day of the window and pays the next day is in the
//   denominator but not the numerator, so a short window slightly UNDERSTATES
//   CVR. Every funnel report has this property; widening the window shrinks it.
//
//   All bounds are HALF-OPEN [from 00:00:00Z, to+1d 00:00:00Z) in UTC, so the
//   `to` day is fully included exactly once and no row is double-counted at a
//   boundary.
//
// ── AOV ────────────────────────────────────────────────────────────────────
//   aov_post_upsell = net_revenue ÷ orders   (net of refunds, over
//                     refunded-INCLUSIVE orders — dividing net by net would
//                     hide a fully refunded sale entirely)
//   aov_pre_upsell  = aov_post_upsell − upsell_revenue ÷ orders
//   An exact identity, not an estimate, so aov_post − aov_pre is exactly
//   upsell_revenue/orders and post > pre whenever upsell revenue exists.
//   A negative pre-AOV (refunds exceeding base revenue in-window) is REFUSED
//   as null with reason 'blend_inconsistent' rather than rendered.
//
// ── UPSELLS — AND THE REFUND TRAP THAT COMES WITH THEM ─────────────────────
//   legs   = co_upsell_charges rows at status IN ('settled','refunded')
//   buyers = COUNT(DISTINCT session_id) of the same
//   legs >= buyers ALWAYS (one buyer can accept several offers).
//   'declined' rows are decline MARKERS carrying no money (checkoutSettle
//   writes them explicitly) and are counted separately, never as revenue.
//
//   WHY 'refunded' IS COUNTED AS GROSS AND NOT DROPPED — the sharpest edge in
//   this file. There is NO `refunded_total` column on co_upsell_charges, so
//   gatewayWebhooks flips the whole leg's status to 'refunded' for ANY refund,
//   INCLUDING A $5 PARTIAL ONE. Filtering `status = 'settled'` therefore makes
//   a fully-earned $200 leg VANISH the moment $5 comes back. Worse, on the
//   STRIPE upsell path nothing is appended to co_sessions.refunds at all, so
//   the $200 disappears from gross while `refunded` still reads $0 — the money
//   is not moved, it is deleted, and a closed month silently restates.
//   Counting the leg at gross and subtracting the ACTUAL refunded amount is
//   the only arithmetic that survives a partial.
//
//   WHERE THE REAL PARTIAL AMOUNT LIVES: the `void` rows in lb_split_credits,
//   keyed `charge_id = co_upsell_charges.id`. Both gateways write them
//   (gatewayWebhooks Stripe :309, Whop :536) and the value is the true delta,
//   capped at the leg's own room. That is the ONLY place a partial upsell
//   refund amount survives.
//
//   ⚠️ AND ITS LIMIT, STATED HONESTLY: voidSessionRefund only writes a void row
//   for a session that carries a split CREDIT — i.e. a session in a live split
//   test. For a funnel with NO split test, a Stripe partial upsell refund
//   leaves its amount NOWHERE in the database. This file does not guess. Such
//   legs are counted at gross, their count is returned as
//   `upsell_refunds_unmeasured`, and the response flags net revenue as an
//   UPPER BOUND. Inventing "probably fully refunded" would be a fabricated
//   number in a money report; silently ignoring it would be worse.
//
//   THE DOUBLE-SUBTRACTION TRAP (gateways are ASYMMETRIC on main):
//     Stripe upsell refund → flips leg, writes void row, NOTHING in refunds[]
//     Whop   upsell refund → flips leg, writes void row, AND appends to
//                            refunds[] (applyRefund is called unconditionally
//                            at gatewayWebhooks:519, BEFORE the upsell
//                            discrimination at :531)
//   So on Whop the same refund appears twice. Base refunds are therefore
//   summed from refunds[] with any entry whose `id` matches an upsell void
//   row's `refund_key` EXCLUDED. Refunds are counted exactly once per gateway;
//   the harness asserts both paths against the same expected total.
//
// ── CURRENCY ───────────────────────────────────────────────────────────────
//   Assumed single-currency. If more than one appears in a window the sums are
//   still returned but `mixed_currency: true` is set and `currency` is null —
//   loudly, never silently.
import { analyticsQuery } from './analyticsDb.js';
import { buildVerdict, varianceFromSums, MIN_RATE_SAMPLE, STAT_METHOD } from './analyticsStats.js';

// THE predicate. Every revenue read in this file interpolates this constant and
// nothing else, so there is exactly one place to audit.
const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

// lb_touches TTL (trackingSchema: 90 days). A window reaching past it has an
// eroded denominator.
const TOUCH_TTL_DAYS = 90;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 400;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const int = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (v) => Math.round(num(v) * 100) / 100;
const rate = (numer, denom) => (denom > 0 ? Math.round((numer / denom) * 1e6) / 1e6 : null);
const idOf = (v, max = 120) => String(v ?? '').trim().slice(0, max);

/**
 * Validate and normalise a {from,to} date window.
 *
 * INJECTION: the returned bounds are Date objects handed to pgQuery as bound
 * PARAMETERS — they are never string-concatenated into SQL. The strict
 * YYYY-MM-DD regex is a second, independent line of defence (defence in depth,
 * not the primary control): even if a caller mis-wired the parameterisation,
 * a value that reaches here can only ever be ten digits and two hyphens.
 *
 * @returns {{ok:true, from:string, to:string, fromTs:Date, toTs:Date, days:number}
 *          |{ok:false, error:string}}
 */
export function parseWindow({ from, to } = {}) {
  const today = new Date();
  const defTo = today.toISOString().slice(0, 10);
  const defFrom = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const f = from === undefined || from === null || from === '' ? defFrom : String(from);
  const t = to === undefined || to === null || to === '' ? defTo : String(to);

  if (!DATE_RE.test(f) || !DATE_RE.test(t)) return { ok: false, error: 'invalid_date_format' };

  // Parse as UTC midnight. `new Date('2026-01-32')` is Invalid Date, and
  // Date.UTC-based round-tripping rejects '2026-02-31' (which Date would
  // silently roll to March 3) — a rolled date would quietly report the wrong
  // window instead of erroring.
  const fromTs = new Date(`${f}T00:00:00.000Z`);
  const toStart = new Date(`${t}T00:00:00.000Z`);
  if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toStart.getTime())) {
    return { ok: false, error: 'invalid_date' };
  }
  if (fromTs.toISOString().slice(0, 10) !== f || toStart.toISOString().slice(0, 10) !== t) {
    return { ok: false, error: 'invalid_date' };
  }
  if (toStart < fromTs) return { ok: false, error: 'to_before_from' };

  // Half-open right edge: the `to` day is included in full, exactly once.
  const toTs = new Date(toStart.getTime() + 86_400_000);
  const days = Math.round((toTs - fromTs) / 86_400_000);
  // A huge window is a performance foot-gun (a full seq scan over lb_touches),
  // so it is refused rather than served slowly.
  if (days > MAX_WINDOW_DAYS) return { ok: false, error: 'window_too_large' };

  return { ok: true, from: f, to: t, fromTs, toTs, days };
}

/**
 * Run a read and degrade to a named reason instead of throwing.
 *
 * FAIL-OPEN, per the subsystem contract: a missing or slow tracking table must
 * not 500 the Analytics page. The caller gets `null` numbers plus a warning
 * naming the source that degraded — never a zero, because a zero is
 * indistinguishable from "genuinely no traffic" and would be read as a fact.
 */
async function safeRead(label, warnings, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    warnings.push({ source: label, reason: String(err?.message || err).slice(0, 200) });
    return fallback;
  }
}

// ── Traffic (lb_touches only — its own failure domain) ─────────────────────
async function readTraffic(query, funnelId, w) {
  // PERFORMANCE — MEASURED, and the finding is not what it first looked like.
  //
  // At 60,000 touches / 20,000 visitors this query ran for 3m21s before being
  // killed. The obvious diagnosis is the correlated EXISTS below, so it was
  // rewritten as a pre-aggregated (vid, page_id) self-join. THAT DID NOT FIX
  // IT — the rewrite hung on the same fixture. Benchmarking both formulations
  // properly:
  //
  //                          fresh statistics   statistics wiped
  //   correlated EXISTS      118 ms             > 20 s (timed out)
  //   pre-aggregated join    261 ms             > 20 s (timed out)
  //
  // The cause was STALE TABLE STATISTICS, not the query shape: on a
  // freshly bulk-loaded lb_touches the planner estimates ~2,000 rows where
  // there are 60,000 and picks a nested loop. Both shapes degrade identically,
  // so the rewrite bought nothing and cost 2.2x, and this is the simpler and
  // faster of the two. The harness now ANALYZEs after bulk seeding — which is
  // what autovacuum does in production, where lb_touches is written one beacon
  // row at a time and never bulk-loaded.
  //
  // Residual risk, stated: if statistics ever do go stale, this query exceeds
  // the 8s pgQuery timeout and safeRead() degrades traffic to null with a
  // named warning. It fails open to "unmeasured", never to a wrong number.
  const rows = await query(
    `WITH pv AS (
       SELECT page_id, vid
       FROM lb_touches
       WHERE funnel_id = $1 AND ts >= $2 AND ts < $3 AND page_id IS NOT NULL
       GROUP BY page_id, vid
     ),
     views AS (
       SELECT page_id, COUNT(*)::bigint AS pageviews
       FROM lb_touches
       WHERE funnel_id = $1 AND ts >= $2 AND ts < $3 AND page_id IS NOT NULL
       GROUP BY page_id
     ),
     adv AS (
       -- A visitor ADVANCED from page A if they later touched a DIFFERENT page
       -- of the same funnel inside the window.
       SELECT t1.page_id, t1.vid
       FROM lb_touches t1
       WHERE t1.funnel_id = $1 AND t1.ts >= $2 AND t1.ts < $3 AND t1.page_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM lb_touches t2
           WHERE t2.funnel_id = $1 AND t2.vid = t1.vid
             AND t2.ts > t1.ts AND t2.ts < $3
             AND t2.page_id IS DISTINCT FROM t1.page_id
         )
       GROUP BY t1.page_id, t1.vid
     )
     SELECT pv.page_id,
            COUNT(*)::bigint                                   AS visitors,
            COALESCE(MAX(v.pageviews), 0)::bigint              AS pageviews,
            COUNT(*) FILTER (WHERE a.vid IS NOT NULL)::bigint  AS advanced_visitors
     FROM pv
     LEFT JOIN adv a  ON a.page_id = pv.page_id AND a.vid = pv.vid
     LEFT JOIN views v ON v.page_id = pv.page_id
     GROUP BY pv.page_id`,
    [funnelId, w.fromTs, w.toTs]
  );
  // Funnel-wide uniques: its OWN distinct count, never a sum of the per-page
  // figures (one visitor across three pages is ONE funnel visitor).
  const [tot] = await query(
    `SELECT COUNT(DISTINCT vid)::bigint AS visitors,
            COUNT(*)::bigint           AS pageviews,
            MIN(ts)                    AS first_touch_at
     FROM lb_touches
     WHERE funnel_id = $1 AND ts >= $2 AND ts < $3`,
    [funnelId, w.fromTs, w.toTs]
  );
  return {
    perPage: new Map(rows.map((r) => [r.page_id, r])),
    funnelVisitors: int(tot?.visitors),
    funnelPageviews: int(tot?.pageviews),
  };
}

// ── Money (co_* only — its own failure domain) ─────────────────────────────
async function readMoney(query, funnelId, w) {
  // Orders + base revenue, windowed on paid_at.
  const orders = await query(
    `SELECT s.page_id,
            COUNT(*)::bigint                      AS orders,
            COALESCE(SUM(s.total), 0)             AS base_revenue,
            COUNT(DISTINCT s.currency)::bigint    AS currency_count,
            MIN(s.currency)                       AS currency
     FROM co_sessions s
     WHERE s.funnel_id = $1 AND s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
     GROUP BY s.page_id`,
    [funnelId, w.fromTs, w.toTs]
  );
  // Submits = checkout sessions MINTED in the window, windowed on created_at
  // (the submit IS the creation). Deliberately NOT filtered by MONEY_MOVED —
  // a submit that never paid is still a submit; that is the whole point of the
  // column.
  const submits = await query(
    `SELECT s.page_id,
            COUNT(*)::bigint AS submits,
            COUNT(DISTINCT s.vid) FILTER (WHERE s.vid IS NOT NULL AND s.vid <> '')::bigint
              AS submit_visitors
     FROM co_sessions s
     WHERE s.funnel_id = $1 AND s.created_at >= $2 AND s.created_at < $3
     GROUP BY s.page_id`,
    [funnelId, w.fromTs, w.toTs]
  );
  // Upsell legs, scoped to the SAME money-moved session set as `orders` so the
  // AOV identity holds (same denominator, same window, same predicate).
  // A 'refunded' leg is a leg that WAS SOLD and later partly/fully reversed —
  // it belongs in gross, with the reversal subtracted separately. See the
  // header block: filtering to 'settled' deletes the whole leg over a $5
  // partial refund.
  const upsells = await query(
    `SELECT s.page_id,
            COUNT(*) FILTER (WHERE c.status IN ('settled','refunded'))::bigint   AS upsell_legs,
            COUNT(DISTINCT c.session_id) FILTER (WHERE c.status IN ('settled','refunded'))::bigint
              AS upsell_buyers,
            COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('settled','refunded')), 0)
              AS upsell_revenue,
            COUNT(*) FILTER (WHERE c.status = 'refunded')::bigint                AS upsell_refunded_legs,
            COUNT(*) FILTER (WHERE c.status = 'declined')::bigint                AS upsell_declined_legs
     FROM co_upsell_charges c
     JOIN co_sessions s ON s.id = c.session_id
     WHERE s.funnel_id = $1 AND s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL}
     GROUP BY s.page_id`,
    [funnelId, w.fromTs, w.toTs]
  );
  // Does the split ledger exist? A fresh install has no lb_split_credits, and
  // the refund reads below must not take the whole money report down with them.
  // to_regclass returns NULL instead of throwing. The result only ever selects
  // between two FIXED query strings — no value from it reaches SQL.
  const [reg] = await query(`SELECT to_regclass('public.lb_split_credits') IS NOT NULL AS present`);
  const hasLedger = Boolean(reg?.present);

  // The true amount of an upsell reversal, deduped across tests.
  // A session in N split tests gets N void rows for ONE physical refund (one
  // per group_id), so summing them raw multiplies the refund by N. Collapsing
  // on (session, charge, refund_key) first and taking MAX makes it one refund
  // again — MAX rather than MIN because each test's row is capped at its own
  // credit's room, and the largest is the closest to the real amount.
  // Windowed on the void row's own created_at: the funnel report is CALENDAR
  // basis, and a reversal belongs to the day it settled.
  const upsellRefunds = hasLedger
    ? await query(
        `WITH v AS (
           SELECT session_id, charge_id, refund_key,
                  MAX(-value) AS amt,
                  MIN(created_at) AS ts
           FROM lb_split_credits
           WHERE kind = 'void'
           GROUP BY session_id, charge_id, refund_key
         )
         SELECT s.page_id,
                COALESCE(SUM(v.amt), 0) AS upsell_refunded,
                COUNT(*)::bigint        AS upsell_refund_events
         FROM v
         JOIN co_upsell_charges c ON c.id = v.charge_id AND c.session_id = v.session_id
         JOIN co_sessions s        ON s.id = v.session_id
         WHERE s.funnel_id = $1 AND ${MONEY_MOVED_SQL}
           AND v.ts >= $2 AND v.ts < $3
         GROUP BY s.page_id`,
        [funnelId, w.fromTs, w.toTs]
      )
    : [];

  // Base refunds, dated on the REFUND ENTRY, not on the order.
  //
  // ⚠️ MONEY_MOVED_SQL IS LOAD-BEARING HERE, not copy-paste. Without it a
  // session that NEVER PAID still contributes its refund while contributing no
  // gross — and main can reach status='refunded' with paid_at NULL, so this is
  // reachable, not theoretical. It produced net = 100 on a real 500 order.
  //
  // ⚠️ THE NOT EXISTS CLAUSE IS THE WHOP DE-DUPLICATION. Whop calls applyRefund
  // unconditionally BEFORE discriminating upsell from base, so an upsell refund
  // lands in refunds[] AND in a void row. Counting both subtracts it twice.
  // Stripe's upsell path writes only the void row. Matching on the gateway
  // refund id (refunds[].id === void.refund_key — both are the same `ref`)
  // makes the count exactly one on BOTH gateways.
  //
  // The two regex guards are not decoration: `(r->>'at')::timestamptz` throws
  // on a malformed entry and Postgres has no try_cast, so one bad JSONB row
  // would take down the whole report. A row that fails is skipped and counted.
  const dedupeClause = hasLedger
    ? `AND NOT EXISTS (
         SELECT 1 FROM lb_split_credits v
         JOIN co_upsell_charges uc ON uc.id = v.charge_id AND uc.session_id = v.session_id
         WHERE v.kind = 'void' AND v.session_id = s.id AND v.refund_key = r->>'id'
       )`
    : '';
  const refunds = await query(
    `SELECT s.page_id,
            COALESCE(SUM((r->>'amount')::numeric), 0) AS refunded,
            COUNT(*)::bigint                          AS refund_entries
     FROM co_sessions s
     CROSS JOIN LATERAL jsonb_array_elements(s.refunds) r
     WHERE s.funnel_id = $1
       AND ${MONEY_MOVED_SQL}
       AND r->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
       AND r->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$'
       AND (r->>'at')::timestamptz >= $2
       AND (r->>'at')::timestamptz <  $3
       ${dedupeClause}
     GROUP BY s.page_id`,
    [funnelId, w.fromTs, w.toTs]
  );
  const [skipped] = await query(
    `SELECT COUNT(*)::bigint AS n
     FROM co_sessions s
     CROSS JOIN LATERAL jsonb_array_elements(s.refunds) r
     WHERE s.funnel_id = $1
       AND ${MONEY_MOVED_SQL}
       AND NOT (r->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                AND r->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$')`,
    [funnelId]
  );
  // Legs we KNOW were reversed but whose amount is nowhere in the database:
  // status='refunded' with no void row (a non-split funnel on the Stripe path).
  // Net revenue is an UPPER BOUND while this is non-zero.
  const [unmeasured] = await query(
    `SELECT COUNT(*)::bigint AS n
     FROM co_upsell_charges c
     JOIN co_sessions s ON s.id = c.session_id
     WHERE s.funnel_id = $1 AND s.paid_at >= $2 AND s.paid_at < $3
       AND ${MONEY_MOVED_SQL} AND c.status = 'refunded'
       ${hasLedger
         ? `AND NOT EXISTS (SELECT 1 FROM lb_split_credits v
                            WHERE v.kind = 'void' AND v.charge_id = c.id AND v.session_id = c.session_id)`
         : ''}`,
    [funnelId, w.fromTs, w.toTs]
  );
  // Sessions started but never paid, for the funnel card.
  const [processing] = await query(
    `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(s.total), 0) AS amount
     FROM co_sessions s
     WHERE s.funnel_id = $1 AND s.created_at >= $2 AND s.created_at < $3
       AND s.status = 'processing'`,
    [funnelId, w.fromTs, w.toTs]
  );
  const byPage = new Map();
  const put = (rows, key) => {
    for (const r of rows) {
      const k = r.page_id;
      if (!byPage.has(k)) byPage.set(k, {});
      Object.assign(byPage.get(k), { [key]: true }, r);
    }
  };
  put(orders, '_o');
  put(submits, '_s');
  put(upsells, '_u');
  put(refunds, '_r');
  put(upsellRefunds, '_ur');
  return {
    perPage: byPage,
    malformedRefundEntries: int(skipped?.n),
    upsellRefundsUnmeasured: int(unmeasured?.n),
    hasLedger,
    processingSessions: int(processing?.n),
    processingAmount: money(processing?.amount),
  };
}

/**
 * Assemble one page's metric row from its traffic + money parts.
 * Pure — no I/O — so the harness can hand it hand-built fixtures.
 */
export function derivePageMetrics({ page = {}, traffic = null, moneyRow = null }) {
  const trackingOk = traffic !== null;
  const visitorsRaw = trackingOk ? int(traffic.visitors) : null;
  const pageviews = trackingOk ? int(traffic.pageviews) : null;
  const advanced = trackingOk ? int(traffic.advanced_visitors) : null;

  const moneyOk = moneyRow !== null;
  const orders = moneyOk ? int(moneyRow.orders) : null;
  const submits = moneyOk ? int(moneyRow.submits) : null;
  const submitVisitors = moneyOk ? int(moneyRow.submit_visitors) : null;
  const baseRevenue = moneyOk ? money(moneyRow.base_revenue) : null;
  const upsellRevenue = moneyOk ? money(moneyRow.upsell_revenue) : null;
  const upsellLegs = moneyOk ? int(moneyRow.upsell_legs) : null;
  const upsellBuyers = moneyOk ? int(moneyRow.upsell_buyers) : null;
  const upsellDeclinedLegs = moneyOk ? int(moneyRow.upsell_declined_legs) : null;
  const upsellRefundedLegs = moneyOk ? int(moneyRow.upsell_refunded_legs) : null;

  // Refunds come from TWO disjoint sources by construction: base reversals from
  // co_sessions.refunds (with upsell duplicates already excluded in SQL) and
  // upsell reversals from the void ledger. Disjoint ⇒ they add, never
  // double-count. `refunded` is the total the operator sees.
  const baseRefunded = moneyOk ? money(moneyRow.refunded) : null;
  const upsellRefunded = moneyOk ? money(moneyRow.upsell_refunded) : null;
  const refunded = moneyOk ? money(num(baseRefunded) + num(upsellRefunded)) : null;

  const grossRevenue = moneyOk ? money(num(baseRevenue) + num(upsellRevenue)) : null;
  const netRevenue = moneyOk ? money(num(grossRevenue) - num(refunded)) : null;

  // THE CLAMP. You cannot convert without visiting; a rate over 100% is a lost
  // beacon, not a fact. Rates use the clamped denominator, and the unclamped
  // truth is published so the artefact stays visible.
  const flooredBy = Math.max(int(submits), int(orders));
  const visitors = trackingOk ? Math.max(visitorsRaw, flooredBy) : null;
  const clamped = trackingOk && visitors > visitorsRaw;

  const stepThroughRate = trackingOk ? rate(advanced, visitors) : null;
  const submitRate = trackingOk && moneyOk ? rate(submitVisitors, visitors) : null;

  // ctr = the greater of the two proxies (a valid LOWER BOUND on their union).
  // Withheld below MIN_RATE_SAMPLE visitors: a "50% CTR" off 2 visitors reads
  // as precision and is noise.
  let ctr = null;
  let ctrBasis = 'no_data';
  if (trackingOk && visitors >= MIN_RATE_SAMPLE) {
    const s = stepThroughRate ?? 0;
    const m = submitRate ?? 0;
    if (s >= m) {
      ctr = stepThroughRate;
      ctrBasis = 'step_through_proxy';
    } else {
      ctr = submitRate;
      ctrBasis = 'checkout_submit_proxy';
    }
  } else if (trackingOk) {
    ctrBasis = 'sample_below_floor';
  }

  const cvr = trackingOk && moneyOk ? rate(orders, visitors) : null;
  const revPerVisitor = trackingOk && moneyOk ? rate(netRevenue, visitors) : null;

  // AOV — an exact identity, so post − pre is exactly upsell_revenue/orders.
  let aovPost = null;
  let aovPre = null;
  let aovReason = null;
  if (moneyOk) {
    if (orders > 0) {
      aovPost = money(netRevenue / orders);
      const pre = netRevenue / orders - num(upsellRevenue) / orders;
      // Refunds exceeding base revenue in-window make the base AOV negative.
      // Refuse rather than render a negative base basket (funnel-os
      // 'blend_inconsistent').
      if (pre < 0) aovReason = 'blend_inconsistent';
      else aovPre = money(pre);
    } else {
      aovReason = 'no_orders';
    }
  }

  return {
    page_id: page.page_id ?? page.id ?? null,
    slug: page.slug ?? null,
    title: page.title ?? null,
    type: page.type ?? null,

    visitors,
    visitors_raw: visitorsRaw,
    visitors_clamped: clamped,
    visitors_basis: 'distinct lb_touches.vid on this page_id in window',
    pageviews,

    ctr,
    ctr_is_proxy: true,
    ctr_basis: ctrBasis,
    step_through_rate: stepThroughRate,
    submit_rate: submitRate,
    advanced_visitors: advanced,

    submits,
    submit_visitors: submitVisitors,

    cvr,
    cvr_basis: 'money-moved sessions minted on this page ÷ page visitors',
    orders,

    base_revenue: baseRevenue,
    upsell_revenue: upsellRevenue,
    upsell_legs: upsellLegs,
    upsell_buyers: upsellBuyers,
    upsell_declined_legs: upsellDeclinedLegs,
    upsell_refunded_legs: upsellRefundedLegs,
    gross_revenue: grossRevenue,
    refunded,
    base_refunded: baseRefunded,
    upsell_refunded: upsellRefunded,
    net_revenue: netRevenue,

    aov_pre_upsell: aovPre,
    aov_post_upsell: aovPost,
    aov_reason: aovReason,
    aov_basis: 'net_of_refunds_over_refunded_inclusive_orders',

    rev_per_visitor: revPerVisitor,

    // The unclamped truth, so a >100% rate is visible rather than erased.
    rate_conflict:
      clamped && visitorsRaw > 0
        ? {
            visitors_raw: visitorsRaw,
            ctr_true: rate(advanced, visitorsRaw),
            cvr_true: rate(orders, visitorsRaw),
          }
        : clamped
          ? { visitors_raw: visitorsRaw, ctr_true: null, cvr_true: null }
          : null,
  };
}

/**
 * Funnel overview: totals + one row per page.
 *
 * The per-page rows ARE the canvas overlay feed. The canvas lane should read
 * `pages[]` and use { page_id, visitors, ctr, cvr } per node; every other field
 * is additive and safe to ignore.
 */
export async function getFunnelOverview({ funnelId, from, to }, { query = analyticsQuery } = {}) {
  const w = parseWindow({ from, to });
  if (!w.ok) return { error: w.error };
  const fid = idOf(funnelId, 64);
  if (!fid) return { error: 'invalid_funnel_id' };

  const warnings = [];

  // Labels come from the funnels tables. If THIS fails there is nothing to
  // render, so it is the one read that is allowed to matter — but it still
  // degrades to an empty page list rather than throwing.
  const funnelRows = await safeRead('funnels', warnings, () =>
    query(`SELECT id, slug, name, status, created_at FROM funnels WHERE id = $1`, [fid]), []);
  const funnel = funnelRows[0] || null;
  const pages = await safeRead('funnel_pages', warnings, () =>
    query(
      `SELECT id AS page_id, slug, title, type, is_home, archived
       FROM funnel_pages WHERE funnel_id = $1 ORDER BY is_home DESC, slug ASC`,
      [fid]
    ), []);

  const traffic = await safeRead('lb_touches', warnings, () => readTraffic(query, fid, w), null);
  const moneyData = await safeRead('co_sessions', warnings, () => readMoney(query, fid, w), null);

  const trafficPages = traffic?.perPage ?? new Map();
  const moneyPages = moneyData?.perPage ?? new Map();

  // Union of pages that EXIST and pages that have DATA. A page deleted after
  // it took traffic still has rows; dropping it would silently lose its
  // revenue from the totals.
  const known = new Map(pages.map((p) => [p.page_id, p]));
  const allIds = new Set([...known.keys(), ...trafficPages.keys(), ...moneyPages.keys()]);

  const rows = [...allIds]
    .filter((id) => id !== null && id !== undefined)
    .map((id) =>
      derivePageMetrics({
        page: known.get(id) || { page_id: id, slug: null, title: '(deleted page)', type: null },
        traffic: traffic ? trafficPages.get(id) || { visitors: 0, pageviews: 0, advanced_visitors: 0 } : null,
        moneyRow: moneyData ? moneyPages.get(id) || {} : null,
      })
    )
    .sort((a, b) => num(b.net_revenue) - num(a.net_revenue) || num(b.visitors) - num(a.visitors));

  // Totals are computed from the SAME rows, except visitors — which is its own
  // funnel-wide distinct count, NOT a sum (the harness asserts this).
  const sum = (k) => rows.reduce((t, r) => t + num(r[k]), 0);
  const orders = rows.reduce((t, r) => t + int(r.orders), 0);
  const grossRevenue = money(sum('gross_revenue'));
  const refunded = money(sum('refunded'));
  const netRevenue = money(grossRevenue - refunded);
  const upsellRevenue = money(sum('upsell_revenue'));
  const visitors = traffic ? traffic.funnelVisitors : null;

  const currencies = new Set();
  let currencyCount = 0;
  for (const r of moneyPages.values()) {
    if (r.currency) currencies.add(r.currency);
    currencyCount = Math.max(currencyCount, int(r.currency_count));
  }
  const mixedCurrency = currencies.size > 1 || currencyCount > 1;

  // TTL erosion: a window reaching past lb_touches' 90-day retention has an
  // eroded denominator, so every rate off it is overstated.
  const ttlEdge = new Date(Date.now() - TOUCH_TTL_DAYS * 86_400_000);
  const trafficTtlRisk = w.fromTs < ttlEdge;

  let aovPost = null;
  let aovPre = null;
  if (orders > 0) {
    aovPost = money(netRevenue / orders);
    const pre = netRevenue / orders - upsellRevenue / orders;
    if (pre >= 0) aovPre = money(pre);
  }

  return {
    funnel: funnel
      ? { id: funnel.id, slug: funnel.slug, name: funnel.name, status: funnel.status }
      : { id: fid, slug: null, name: null, status: null },
    window: { from: w.from, to: w.to, days: w.days, basis: 'UTC half-open [from, to+1d)' },
    totals: {
      visitors,
      visitors_basis: 'distinct lb_touches.vid across the whole funnel (NOT the sum of page visitors)',
      pageviews: traffic ? traffic.funnelPageviews : null,
      orders: moneyData ? orders : null,
      cvr: traffic && moneyData ? rate(orders, Math.max(visitors, orders)) : null,
      base_revenue: moneyData ? money(sum('base_revenue')) : null,
      upsell_revenue: moneyData ? upsellRevenue : null,
      upsell_legs: moneyData ? rows.reduce((t, r) => t + int(r.upsell_legs), 0) : null,
      upsell_buyers: moneyData ? rows.reduce((t, r) => t + int(r.upsell_buyers), 0) : null,
      upsell_refunded_legs: moneyData ? rows.reduce((t, r) => t + int(r.upsell_refunded_legs), 0) : null,
      gross_revenue: moneyData ? grossRevenue : null,
      refunded: moneyData ? refunded : null,
      base_refunded: moneyData ? money(sum('base_refunded')) : null,
      upsell_refunded: moneyData ? money(sum('upsell_refunded')) : null,
      net_revenue: moneyData ? netRevenue : null,
      aov_pre_upsell: aovPre,
      aov_post_upsell: aovPost,
      rev_per_visitor: traffic && moneyData ? rate(netRevenue, Math.max(visitors, orders)) : null,
      processing_sessions: moneyData ? moneyData.processingSessions : null,
      processing_amount_excluded: moneyData ? moneyData.processingAmount : null,
    },
    pages: rows,
    meta: {
      money_predicate: "paid_at IS NOT NULL AND status IN ('paid','refunded')",
      revenue_window_field: 'co_sessions.paid_at',
      refund_window_field: "co_sessions.refunds[].at (the refund's own date)",
      traffic_window_field: 'lb_touches.ts',
      currency: mixedCurrency ? null : ([...currencies][0] ?? 'USD'),
      mixed_currency: mixedCurrency,
      traffic_ttl_days: TOUCH_TTL_DAYS,
      traffic_ttl_risk: trafficTtlRisk,
      malformed_refund_entries: moneyData ? moneyData.malformedRefundEntries : null,
      // Upsell legs known to be reversed whose AMOUNT is nowhere in the DB
      // (no void row — a non-split funnel on the Stripe path). While this is
      // non-zero, net revenue is an UPPER BOUND, not a measurement.
      upsell_refunds_unmeasured: moneyData ? moneyData.upsellRefundsUnmeasured : null,
      net_revenue_is_upper_bound: Boolean(moneyData && moneyData.upsellRefundsUnmeasured > 0),
      split_ledger_present: moneyData ? moneyData.hasLedger : null,
      refund_sources:
        'base = co_sessions.refunds[] (upsell duplicates excluded); ' +
        'upsell = lb_split_credits void rows. Disjoint by construction.',
      ctr_note:
        'CTR is a labelled PROXY. Puure emits no click-through event; ' +
        'the value is max(step-through, checkout-submit) = a LOWER BOUND.',
    },
    warnings,
    degraded: warnings.length > 0,
  };
}

/** One page, full metric set. Same math as the overview row — one code path. */
export async function getPageMetrics({ funnelId, pageId, from, to }, { query = analyticsQuery } = {}) {
  const pid = idOf(pageId, 64);
  if (!pid) return { error: 'invalid_page_id' };
  const overview = await getFunnelOverview({ funnelId, from, to }, { query });
  if (overview.error) return overview;
  const page = overview.pages.find((p) => p.page_id === pid);
  if (!page) return { error: 'page_not_found' };
  return {
    funnel: overview.funnel,
    window: overview.window,
    page,
    meta: overview.meta,
    warnings: overview.warnings,
    degraded: overview.degraded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPLIT TEST RESULTS
// ═══════════════════════════════════════════════════════════════════════════
//
// PER-ARM "VISITORS" — READ THIS BEFORE QUOTING THE NUMBER.
// The exposure ledger's denominator row is written at CHECKOUT SESSION MINT
// (checkoutPublic.recordSplitExposure), not at page serve. There is no
// page-serve exposure hook wired today. So an arm's "visitors" is really
// "sessions minted while assigned to this arm" — it counts people who reached
// the checkout, not people who saw the page. Every arm is understated by the
// same mechanism, so the COMPARISON between arms stays valid (which is what a
// split test is for), but the ABSOLUTE figure is not page traffic and the
// response says so via `visitors_understated: true`.
//
// funnel-os counts a split arm's visitors as delivered page renders
// (human_impressions). Wiring an exposure call into the page-serve path would
// make Puure match; that call belongs to the funnel-render lane, not this one.

async function readArmSessions(query, testId, w) {
  // Sessions carrying an exposure for this test, windowed on the EXPOSURE
  // ROW's created_at — the moment the visitor entered the test. Windowing on
  // the money date instead would let a session enter one window's denominator
  // and another's numerator.
  return query(
    `SELECT e.arm_key,
            COUNT(*)::bigint AS exposures,
            COUNT(DISTINCT s.vid) FILTER (WHERE s.vid IS NOT NULL AND s.vid <> '')::bigint
              AS distinct_visitors,
            COUNT(*) FILTER (WHERE ${MONEY_MOVED_SQL})::bigint AS orders,
            COALESCE(SUM(s.total) FILTER (WHERE ${MONEY_MOVED_SQL}), 0) AS base_revenue,
            COUNT(DISTINCT s.currency) FILTER (WHERE ${MONEY_MOVED_SQL})::bigint AS currency_count,
            MIN(s.currency) FILTER (WHERE ${MONEY_MOVED_SQL}) AS currency
     FROM lb_split_credits e
     LEFT JOIN co_sessions s ON s.id = e.session_id
     WHERE e.group_id = $1 AND e.kind = 'exposure'
       AND e.created_at >= $2 AND e.created_at < $3
     GROUP BY e.arm_key`,
    [testId, w.fromTs, w.toTs]
  );
}

// Same 'settled' → ('settled','refunded') correction as the funnel path. This
// one MOVES A/B WINNERS: a partial refund on one arm's upsell used to delete
// that arm's entire leg from revenue, and the t-test's sufficient statistics
// moved with it (readArmMoments below shares the fix).
async function readArmUpsells(query, testId, w) {
  return query(
    `SELECT e.arm_key,
            COUNT(*) FILTER (WHERE c.status IN ('settled','refunded'))::bigint AS upsell_legs,
            COUNT(DISTINCT c.session_id) FILTER (WHERE c.status IN ('settled','refunded'))::bigint
              AS upsell_buyers,
            COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('settled','refunded')), 0)
              AS upsell_revenue,
            COUNT(*) FILTER (WHERE c.status = 'refunded')::bigint AS upsell_refunded_legs,
            COUNT(*) FILTER (WHERE c.status = 'declined')::bigint AS upsell_declined_legs
     FROM lb_split_credits e
     JOIN co_sessions s ON s.id = e.session_id
     JOIN co_upsell_charges c ON c.session_id = s.id
     WHERE e.group_id = $1 AND e.kind = 'exposure'
       AND e.created_at >= $2 AND e.created_at < $3
       AND ${MONEY_MOVED_SQL}
     GROUP BY e.arm_key`,
    [testId, w.fromTs, w.toTs]
  );
}

// REFUND BASIS — DELIBERATELY DIFFERENT FROM THE FUNNEL REPORT. Say it out
// loud, because two undocumented refund bases in one system is precisely the
// bug funnel-os shipped (two AOV definitions, 111 vs 112 orders, unfixed).
//
//   funnel report : CALENDAR basis — a refund lands in the window containing
//                   the refund entry's own date. "What did this month cost me?"
//   split report  : COHORT basis — every refund against a session exposed in
//                   the window is netted against that arm, whenever it lands.
//
// The split MUST be cohort-based. A refund is evidence about the arm that
// earned the sale; dropping it because it settled after the window closed
// would flatter whichever arm sells the more refund-prone basket, and that
// bias lands on exactly one arm — the worst failure mode for an A/B test
// (DECISIONS #7 makes the same argument about impressions).
//
// The MONEY_MOVED filter here is not redundant: it keeps this query's session
// set byte-identical to readArmMoments', so `net_revenue` and the Σx the
// t-test consumes can never diverge. The harness asserts they are equal.
// Returns BASE reversals (refunds[], upsell duplicates excluded) and UPSELL
// reversals (void rows) as two disjoint columns. Same de-duplication story as
// the funnel path: on Whop one physical upsell refund is in both places.
// Scoped to this test's group_id, so the cross-test multiplication the funnel
// path has to collapse cannot arise here.
async function readArmRefunds(query, testId, w) {
  return query(
    `WITH ex AS (
       SELECT session_id, arm_key
       FROM lb_split_credits
       WHERE group_id = $1 AND kind = 'exposure'
         AND created_at >= $2 AND created_at < $3
     ),
     up AS (
       SELECT ex.arm_key,
              COALESCE(SUM(-v.value), 0) AS upsell_refunded,
              COUNT(*)::bigint           AS upsell_refund_events
       FROM lb_split_credits v
       JOIN ex ON ex.session_id = v.session_id
       JOIN co_upsell_charges c ON c.id = v.charge_id AND c.session_id = v.session_id
       JOIN co_sessions s ON s.id = v.session_id
       WHERE v.kind = 'void' AND v.group_id = $1 AND ${MONEY_MOVED_SQL}
       GROUP BY ex.arm_key
     ),
     base AS (
       SELECT ex.arm_key,
              COALESCE(SUM((r->>'amount')::numeric), 0) AS base_refunded
       FROM ex
       JOIN co_sessions s ON s.id = ex.session_id
       CROSS JOIN LATERAL jsonb_array_elements(s.refunds) r
       WHERE ${MONEY_MOVED_SQL}
         AND r->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         AND r->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$'
         AND NOT EXISTS (
           SELECT 1 FROM lb_split_credits v2
           JOIN co_upsell_charges uc ON uc.id = v2.charge_id AND uc.session_id = v2.session_id
           WHERE v2.kind = 'void' AND v2.session_id = s.id AND v2.refund_key = r->>'id'
         )
       GROUP BY ex.arm_key
     )
     SELECT k.arm_key,
            COALESCE(base.base_refunded, 0)      AS base_refunded,
            COALESCE(up.upsell_refunded, 0)      AS upsell_refunded,
            COALESCE(base.base_refunded, 0) + COALESCE(up.upsell_refunded, 0) AS refunded
     FROM (SELECT DISTINCT arm_key FROM ex) k
     LEFT JOIN base ON base.arm_key = k.arm_key
     LEFT JOIN up   ON up.arm_key   = k.arm_key`,
    [testId, w.fromTs, w.toTs]
  );
}

/**
 * Per-session net value moments, per arm — the SUFFICIENT STATISTICS Welch's
 * t-test needs (n, Σx, Σx²), computed in ONE pass instead of shipping every row.
 *
 * x = that session's net contribution (base + settled upsells − refunds).
 * Non-buyers contribute x = 0 and are counted by `exposures`, so the zeros are
 * implicit: Σx and Σx² are unchanged by them, and n comes from the exposure
 * count. Dropping non-buyers from n would turn RPV into AOV — a different
 * metric with a different denominator.
 */
async function readArmMoments(query, testId, w) {
  // x MUST be assembled from exactly the same four terms readArmRefunds and
  // readArmUpsells use, or the t-test would be run on a different series than
  // the table displays. The harness asserts Σx === net_revenue per arm, which
  // is what keeps these two queries honest about each other.
  return query(
    `WITH sess AS (
       SELECT e.arm_key, s.id,
              s.total
              + COALESCE((SELECT SUM(c.amount) FROM co_upsell_charges c
                          WHERE c.session_id = s.id
                            AND c.status IN ('settled','refunded')), 0)
              - COALESCE((SELECT SUM((r->>'amount')::numeric)
                          FROM jsonb_array_elements(s.refunds) r
                          WHERE r->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$'
                            AND NOT EXISTS (
                              SELECT 1 FROM lb_split_credits v2
                              JOIN co_upsell_charges uc
                                ON uc.id = v2.charge_id AND uc.session_id = v2.session_id
                              WHERE v2.kind = 'void' AND v2.session_id = s.id
                                AND v2.refund_key = r->>'id'
                            )), 0)
              - COALESCE((SELECT SUM(-v.value) FROM lb_split_credits v
                          JOIN co_upsell_charges c2
                            ON c2.id = v.charge_id AND c2.session_id = v.session_id
                          WHERE v.kind = 'void' AND v.group_id = $1
                            AND v.session_id = s.id), 0) AS x
       FROM lb_split_credits e
       JOIN co_sessions s ON s.id = e.session_id
       WHERE e.group_id = $1 AND e.kind = 'exposure'
         AND e.created_at >= $2 AND e.created_at < $3
         AND ${MONEY_MOVED_SQL}
     )
     SELECT arm_key,
            COALESCE(SUM(x), 0)     AS sum_x,
            COALESCE(SUM(x * x), 0) AS sum_x2
     FROM sess GROUP BY arm_key`,
    [testId, w.fromTs, w.toTs]
  );
}

/**
 * Split-test results: per-arm metric table + verdict + the honest window
 * disclosure.
 *
 * @param {Function} readLedger — splitCredits.readResults, injected so this
 *   module never imports a FORBIDDEN file's internals and the harness can stub
 *   it. Its output is returned VERBATIM under `ledger` for reconciliation; the
 *   table itself is computed from the checkout tables so that every column in
 *   one row comes from ONE source. Two revenue lenses side by side, both
 *   labelled — never silently blended.
 */
export async function getSplitResults(
  { testId, from, to },
  { query = analyticsQuery, readLedger = null } = {}
) {
  const w = parseWindow({ from, to });
  if (!w.ok) return { error: w.error };
  const tid = idOf(testId, 64);
  if (!tid) return { error: 'invalid_test_id' };

  const warnings = [];

  const testRows = await safeRead('lb_split_tests', warnings, () =>
    query(
      `SELECT id, funnel_id, name, scope, enabled, archived, created_at
       FROM lb_split_tests WHERE id = $1`,
      [tid]
    ), []);
  const test = testRows[0];
  if (!test) return { error: 'test_not_found' };

  const armDefs = await safeRead('lb_split_arms', warnings, () =>
    query(
      `SELECT arm_key, weight, is_control, archived, page_id, offer_id
       FROM lb_split_arms WHERE test_id = $1 ORDER BY archived, arm_key`,
      [tid]
    ), []);

  const sessions = await safeRead('split_sessions', warnings, () => readArmSessions(query, tid, w), []);
  const upsells = await safeRead('split_upsells', warnings, () => readArmUpsells(query, tid, w), []);
  const refunds = await safeRead('split_refunds', warnings, () => readArmRefunds(query, tid, w), []);
  const moments = await safeRead('split_moments', warnings, () => readArmMoments(query, tid, w), []);

  // ── The honest window disclosure ─────────────────────────────────────────
  // tracking_started_at = the first touch EVER recorded for this test's funnel.
  // If tracking began AFTER the test was created, every exposure between those
  // two instants was never recorded — the sample starts later than the test
  // does, and the earlier traffic is gone, not zero. The UI must warn, because
  // "arm A has fewer visitors" would otherwise read as a traffic-split bug.
  const trackRows = await safeRead('tracking_start', warnings, () =>
    query(`SELECT MIN(ts) AS first_touch FROM lb_touches WHERE funnel_id = $1`, [
      String(test.funnel_id || ''),
    ]), []);
  const trackingStartedAt = trackRows[0]?.first_touch ?? null;
  const testCreatedAt = test.created_at ?? null;
  const trackingStartedAfterTest =
    Boolean(trackingStartedAt && testCreatedAt) &&
    new Date(trackingStartedAt).getTime() > new Date(testCreatedAt).getTime();

  const idx = (rows) => new Map(rows.map((r) => [r.arm_key, r]));
  const S = idx(sessions);
  const U = idx(upsells);
  const R = idx(refunds);
  const M = idx(moments);

  // Every arm the ledger knows about, even one archived or hard-deleted: the
  // money already moved and dropping it would silently change the totals
  // (mirrors readResults' own rule).
  const keys = new Set([...armDefs.map((a) => a.arm_key), ...S.keys(), ...U.keys(), ...R.keys()]);
  const defByKey = new Map();
  for (const a of armDefs) {
    const prev = defByKey.get(a.arm_key);
    if (!prev || (prev.archived && !a.archived)) defByKey.set(a.arm_key, a);
  }

  const currencies = new Set();
  let currencyCount = 0;

  const arms = [...keys].sort().map((key) => {
    const def = defByKey.get(key) || { arm_key: key, weight: null, is_control: false, archived: true };
    const s = S.get(key) || {};
    const u = U.get(key) || {};
    const r = R.get(key) || {};
    const m = M.get(key) || {};

    if (s.currency) currencies.add(s.currency);
    currencyCount = Math.max(currencyCount, int(s.currency_count));

    const visitors = int(s.exposures);
    const orders = int(s.orders);
    const baseRevenue = money(s.base_revenue);
    const upsellRevenue = money(u.upsell_revenue);
    const grossRevenue = money(baseRevenue + upsellRevenue);
    const baseRefunded = money(r.base_refunded);
    const upsellRefunded = money(r.upsell_refunded);
    const refunded = money(baseRefunded + upsellRefunded);
    const netRevenue = money(grossRevenue - refunded);

    let aovPost = null;
    let aovPre = null;
    let aovReason = null;
    if (orders > 0) {
      aovPost = money(netRevenue / orders);
      const pre = netRevenue / orders - upsellRevenue / orders;
      if (pre < 0) aovReason = 'blend_inconsistent';
      else aovPre = money(pre);
    } else {
      aovReason = 'no_orders';
    }

    return {
      arm_key: key,
      is_control: Boolean(def.is_control),
      archived: Boolean(def.archived),
      weight: def.weight === null || def.weight === undefined ? null : num(def.weight),
      page_id: def.page_id ?? null,
      offer_id: def.offer_id ?? null,

      visitors,
      distinct_visitors: int(s.distinct_visitors),
      submits: visitors, // an exposure IS a checkout mint here — same event.
      submit_rate: visitors > 0 ? 1 : null,

      orders,
      cvr: visitors >= MIN_RATE_SAMPLE ? rate(orders, visitors) : null,
      cvr_withheld: visitors > 0 && visitors < MIN_RATE_SAMPLE,

      aov_pre_upsell: aovPre,
      aov_post_upsell: aovPost,
      aov_reason: aovReason,

      upsell_legs: int(u.upsell_legs),
      upsell_buyers: int(u.upsell_buyers),
      upsell_declined_legs: int(u.upsell_declined_legs),
      upsell_refunded_legs: int(u.upsell_refunded_legs),
      upsell_revenue: upsellRevenue,

      base_revenue: baseRevenue,
      gross_revenue: grossRevenue,
      refunded,
      base_refunded: baseRefunded,
      upsell_refunded: upsellRefunded,
      net_revenue: netRevenue,
      rev_per_visitor: rate(netRevenue, visitors),

      // Sufficient statistics, exposed so the verdict is reproducible from the
      // response alone.
      net_revenue_sum: money(m.sum_x),
      net_revenue_sum_squares: num(m.sum_x2),
      net_revenue_variance: varianceFromSums(visitors, num(m.sum_x), num(m.sum_x2)),
    };
  });

  const verdict = buildVerdict(
    arms.map((a) => ({
      arm_key: a.arm_key,
      is_control: a.is_control,
      visitors: a.visitors,
      orders: a.orders,
      // The moments' Σx is the net-revenue sum over money-moved sessions; it
      // equals net_revenue up to rounding. Use the moment so the mean and the
      // variance are computed from the SAME series (mixing them would make the
      // t statistic incoherent).
      net_revenue: a.net_revenue_sum,
      net_revenue_sum_squares: a.net_revenue_sum_squares,
    }))
  );

  // vs-control percentage on the ranking metric.
  const control = arms.find((a) => a.is_control) || null;
  const controlRpv = control?.rev_per_visitor ?? null;
  for (const a of arms) {
    a.vs_control_rpv_pct =
      controlRpv !== null && controlRpv !== 0 && a.rev_per_visitor !== null && !a.is_control
        ? Math.round(((a.rev_per_visitor - controlRpv) / controlRpv) * 1000) / 10
        : null;
  }

  // The credits ledger, verbatim, for reconciliation. NOT blended into the
  // table — it answers a different question (money the ledger ATTRIBUTED to an
  // arm, all-time) than the table does (money the checkout tables recorded for
  // this arm's sessions, in-window).
  let ledger = null;
  if (typeof readLedger === 'function') {
    ledger = await safeRead('split_ledger', warnings, () => readLedger({ testId: tid }, { query }), null);
  }

  const totals = arms.reduce(
    (t, a) => ({
      visitors: t.visitors + a.visitors,
      orders: t.orders + a.orders,
      gross_revenue: money(t.gross_revenue + a.gross_revenue),
      refunded: money(t.refunded + a.refunded),
      net_revenue: money(t.net_revenue + a.net_revenue),
      upsell_legs: t.upsell_legs + a.upsell_legs,
      upsell_buyers: t.upsell_buyers + a.upsell_buyers,
    }),
    { visitors: 0, orders: 0, gross_revenue: 0, refunded: 0, net_revenue: 0, upsell_legs: 0, upsell_buyers: 0 }
  );

  return {
    test: {
      id: test.id,
      funnel_id: test.funnel_id,
      name: test.name,
      scope: test.scope,
      enabled: test.enabled,
      archived: test.archived,
    },
    window: { from: w.from, to: w.to, days: w.days, basis: 'UTC half-open [from, to+1d)' },
    arms,
    totals,
    verdict,
    ledger,
    disclosure: {
      test_created_at: testCreatedAt,
      tracking_started_at: trackingStartedAt,
      tracking_started_after_test: trackingStartedAfterTest,
      note: trackingStartedAfterTest
        ? 'Tracking began AFTER this test was created. Exposures before the ' +
          'tracking start were never recorded — they are missing, not zero, so ' +
          'the sample starts later than the test does.'
        : null,
      window_only:
        'These figures cover the selected window only. Arms that started at ' +
        'different times are not comparable across a window they do not both span.',
      visitors_understated: true,
      visitors_basis:
        'split exposure ledger — written at CHECKOUT SESSION MINT, not at page ' +
        'serve. This counts visitors who reached checkout, NOT page traffic. ' +
        'No page-serve exposure hook is wired today.',
    },
    meta: {
      money_predicate: "paid_at IS NOT NULL AND status IN ('paid','refunded')",
      exposure_window_field: 'lb_split_credits.created_at (exposure rows)',
      refund_basis:
        'COHORT — every refund against a session exposed in this window is netted ' +
        'against its arm whenever it settled. This DIFFERS from the funnel report, ' +
        "which dates a refund on the refund entry's own date (calendar basis). A " +
        'split must be cohort-based or the bias lands on one arm.',
      revenue_source: 'co_sessions + co_upsell_charges, scoped to the arm exposure session set',
      ledger_source: 'splitCredits.readResults (all-time, arm-attributed credits ledger)',
      stat_method: STAT_METHOD,
      rate_sample_floor: MIN_RATE_SAMPLE,
      currency: currencies.size > 1 || currencyCount > 1 ? null : ([...currencies][0] ?? 'USD'),
      mixed_currency: currencies.size > 1 || currencyCount > 1,
    },
    warnings,
    degraded: warnings.length > 0,
  };
}

export const ANALYTICS_METRIC_DEFINITIONS = Object.freeze({
  money_moved: "co_sessions.paid_at IS NOT NULL AND status IN ('paid','refunded')",
  visitors: 'COUNT(DISTINCT lb_touches.vid) for that page_id in the window',
  funnel_visitors: 'COUNT(DISTINCT lb_touches.vid) funnel-wide — NOT the sum of page visitors',
  ctr: 'PROXY (lower bound): max(step-through rate, checkout-submit rate). Puure emits no click-through event.',
  cvr: 'money-moved sessions minted on the page ÷ clamped page visitors',
  orders: 'COUNT of money-moved sessions, windowed on paid_at',
  revenue: 'SUM(co_sessions.total) over money-moved sessions + SUM settled upsell amounts',
  refunded: "SUM of co_sessions.refunds[].amount, windowed on each entry's own `at`",
  net_revenue: 'gross_revenue − refunded',
  aov_post_upsell: 'net_revenue ÷ orders (refunded-inclusive orders)',
  aov_pre_upsell: 'aov_post_upsell − upsell_revenue ÷ orders (exact identity)',
  rev_per_visitor: 'net_revenue ÷ clamped visitors',
});
