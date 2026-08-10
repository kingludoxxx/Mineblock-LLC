// EconomicsCard — unit economics, per order (NEW FILE, LANE 5).
//
// Built ENTIRELY from `kpis` on the composite the page already fetches: the P&L
// reads (cogs / ship_cost / fees / net_after_cogs / margin_pct /
// cost_coverage_pct) and the spend reads (spend / roas / cpa / net_profit) are
// all in that payload. No new request, and — importantly — NO SECOND COST
// ENGINE: every figure here is a division of two numbers the server already
// computed, never a re-derivation of a cost.
//
// ── THE ONLY ARITHMETIC THIS FILE DOES ──────────────────────────────────────
// `per order = <server figure> ÷ <server order count>`, through `safeRate`,
// which returns NULL for a missing or zero denominator. That is the whole of
// it. A per-order figure over an unknown order count is unknown, and this card
// prints an em dash for it rather than the numerator wearing a "/order" suffix.
//
// ── COST COVERAGE IS THE GATE ON THE WHOLE CARD ─────────────────────────────
// The engine withholds `net_after_cogs`, `margin_pct` and `net_profit` at zero
// cost coverage — "a funnel nobody has costed renders a dash, never 100%
// margin". `cost_coverage_pct` is therefore printed AT THE TOP, not buried: it
// is the number that says how much of this card is a measurement and how much
// is an absence. A 40% coverage figure beside a healthy margin means the margin
// describes 40% of the orders, and an operator who cannot see that will read it
// as describing all of them.
//
// ── NOTHING HERE IS A TARGET ────────────────────────────────────────────────
// No colour thresholds, no "healthy / unhealthy" verdicts, no benchmark. The
// business has not given this build a target margin, and inventing one on a
// screen the operator moves budget from is worse than showing the number plain.
// The only colour is the sign of net profit, which is a fact, not a judgement.
import { BreakdownListCard } from './cardKit.jsx';
import {
  EM_DASH, fmtMoney, fmtPctPlain, fmtX, present, safeRate,
} from './dashFormat.js';

const val = (src, k) => (src && present(src[k]) ? Number(src[k]) : null);
const hasKey = (obj, k) =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);

/** `<figure> ÷ <orders>`, or null. Never the figure itself as a fallback. */
const perOrder = (figure, orders) => safeRate(figure, orders);

export default function EconomicsCard({
  kpis, upsellLines, state, reason, testid = 'an-card-economics',
}) {
  const k = kpis || null;
  const up = upsellLines || null;

  // Orders live on `upsell_lines` in this payload (the same place OrderValueCard
  // reads them from) and on the top-level block in others. Both are read.
  const orders = (up && present(up.orders)) ? Number(up.orders) : val(k, 'orders');

  const netSales = val(k, 'net_sales');
  const cogs = val(k, 'cogs');
  const ship = val(k, 'ship_cost');
  const fees = val(k, 'fees');
  const netAfterCogs = val(k, 'net_after_cogs');
  const spend = val(k, 'spend');
  const netProfit = val(k, 'net_profit');
  const margin = val(k, 'margin_pct');
  const coverage = val(k, 'cost_coverage_pct');
  const roas = val(k, 'roas');
  const cpa = val(k, 'cpa');

  /**
   * ABSENT vs NULL, per line. A key the payload never carried means THIS BUILD
   * DOES NOT REPORT IT and the row is not rendered at all — an em dash there
   * would say "we measured this and the answer is unknown", which is a
   * different and stronger claim.
   */
  const line = (key, label, value, extra = {}) =>
    (hasKey(k, key) ? [{ label, value, ...extra }] : []);

  const rows = [
    ...line('net_sales', 'Revenue / order', perOrder(netSales, orders), {
      hint: 'Net sales ÷ base orders. Net sales already contains upsell and rebill money.',
      missingHint: 'Needs both net sales and an order count. An average over no orders is not $0.00.',
    }),
    ...line('cogs', 'COGS / order', perOrder(cogs, orders), {
      kind: 'negative',
      hint: 'Product cost, from the effective-dated cost ledger, over the same orders.',
      missingHint: 'Withheld — no leg in this window has a known product cost.',
    }),
    ...line('ship_cost', 'Shipping / order', perOrder(ship, orders), {
      kind: 'negative',
      hint: 'Fulfilment cost from the cost ledger, over the same orders.',
      missingHint: 'Withheld — no leg in this window has a known shipping cost.',
    }),
    ...line('fees', 'Processing / order', perOrder(fees, orders), {
      kind: 'negative',
      hint: 'Gateway fees, over the same orders.',
      missingHint: 'Withheld — the fee settings could not be applied to this window.',
    }),
    ...line('net_after_cogs', 'Contribution / order', perOrder(netAfterCogs, orders), {
      kind: 'total',
      hint: 'Net sales minus COGS, shipping and fees — BEFORE ad spend.',
      missingHint: 'Withheld at zero cost coverage. A contribution equal to revenue would be a 100%-margin claim.',
    }),
    ...line('spend', 'Ad spend / order', perOrder(spend, orders), {
      kind: 'negative',
      hint: 'Recorded ad spend over the same orders — this is not a CPA on attributed orders.',
      missingHint: 'No spend recorded for this window. A blank here is "we cannot see it", not "we spent nothing".',
    }),
    ...line('net_profit', 'Net profit / order', perOrder(netProfit, orders), {
      kind: 'total',
      hint: 'Contribution minus ad spend, over the same orders.',
      missingHint: 'Withheld — net profit needs full cost coverage AND known spend.',
    }),
  ];

  /**
   * THE COVERAGE BANNER. Rendered whenever the server told us the coverage, and
   * worded by how much of the card it invalidates:
   *   · absent   → no banner (we were not told, so we say nothing)
   *   · 0        → every cost line below is an absence
   *   · < 100    → the margin describes a SUBSET of the orders
   *   · 100      → a quiet confirmation, because "is this complete?" is the
   *                first question an operator asks of a margin.
   */
  /**
   * ⚠️ "100.0%" AND "COMPLETE" ARE NOT THE SAME THING, and rounding merged them.
   *
   * A captured payload carried `cost_coverage_pct: 99.9904`. Formatted to one
   * decimal that is "100.0%", so the notice read: "100.0% of this window's
   * order legs have a known cost … they are not a claim about the uncosted
   * remainder" — a sentence that contradicts itself and invites the reader to
   * dismiss the caveat. The coverage really is incomplete; it is the DISPLAY
   * that rounded the gap away. So a value that is under 100 but rounds to it
   * says so in words instead of printing a number that means "all of them".
   */
  const coverageText = coverage === null ? EM_DASH
    : (coverage < 100 && Number(fmtPctPlain(coverage, 1).replace('%', '')) >= 100
      ? 'just under 100%'
      : fmtPctPlain(coverage, 1));

  const coverageNotice = (() => {
    if (!hasKey(k, 'cost_coverage_pct') || coverage === null) return undefined;
    if (coverage <= 0) {
      return 'No order leg in this window has a known cost, so every cost line below is an absence of '
        + 'measurement rather than a zero. Add cost rates to make this card mean something.';
    }
    if (coverage < 100) {
      return `${coverageText} of this window's order legs have a known cost. The cost, `
        + 'contribution and profit lines describe THAT subset — they are not a claim about the '
        + 'uncosted remainder.';
    }
    return undefined;
  })();

  const footer = (
    <div className="mt-2 pt-2 border-t border-border-default space-y-1" data-testid={`${testid}-notes`}>
      <p className="text-[10.5px] text-text-faint tabular-nums" data-testid={`${testid}-coverage`}>
        {'Cost coverage '}
        {coverageText}
        {' · margin '}
        {present(margin) ? fmtPctPlain(margin, 1) : EM_DASH}
        {' · ROAS '}
        {present(roas) ? fmtX(roas) : EM_DASH}
        {' · CPA '}
        {present(cpa) ? fmtMoney(cpa) : EM_DASH}
      </p>
      <p className="text-[10.5px] text-text-faint leading-relaxed">
        Every line is a server figure divided by the server&apos;s own order count — no cost is
        re-derived here. A line whose numerator or denominator is missing is an em dash, because a
        per-order figure over an unknown number of orders is unknown, not zero. Margin is computed
        over the costed legs only; the coverage figure above says how many that is.
      </p>
      <p className="text-[10.5px] text-text-faint">
        No target is drawn on this card. This build has not been told what a healthy margin is here,
        and a benchmark nobody set is a number invented on the screen budget gets moved from.
      </p>
    </div>
  );

  return (
    <BreakdownListCard
      title="Unit economics"
      sub={present(orders) ? `Per order, over ${orders.toLocaleString('en-US')} base orders` : 'Per order'}
      notice={coverageNotice}
      rows={rows}
      state={state}
      reason={reason}
      testid={testid}
      footer={footer}
    />
  );
}
