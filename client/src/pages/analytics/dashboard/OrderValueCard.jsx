// OrderValueCard — "Order value & upsells" (NEW FILE, LANE 3).
//
// THE OPERATOR'S CORRECTION, made permanent. `aov` is net_sales ÷ orders, and
// net_sales ALREADY CONTAINS upsell and rebill money — so a tile labelled
// "Average order value" has always been showing the POST-upsell figure under a
// label saying otherwise. Worked example: base $10,000.00 + upsell $2,000.00 =
// $12,000.00 gross over 80 base orders reads $150.00, where the true pre-upsell
// figure is $125.00. The value does not move here; the LABEL is corrected and
// the pre-upsell figure sits beside it, derived server-side over the SAME
// orders by subtracting the blend the total already contains.
//
// THE FOUR FOOTNOTES ARE THE CARD. Each one exists because a number above it is
// otherwise ambiguous:
//   1. the AOV methodology — which basis each figure is on;
//   2. "X% take rate · net of $Y reversed on the legs" — upsell money reverses
//      onto the CHARGE LEG, not into the session refund ledger, so it is netted
//      off the upsell line itself: once, not twice and not never;
//   3. "base orders — upsell reversals are netted off Upsell revenue" — the
//      order count is BASE orders, so an upsell reversal must never look like
//      an order that disappeared;
//   4. "N abandoned" — intent that never became money, beside the orders that
//      did, so the denominator of the abandon rate is visible.
//
// ABSENT vs NULL, per line. A key the server never sent means THIS BUILD DOES
// NOT REPORT IT and the line is not rendered at all — an em dash there would
// read as "we measured this and the answer is unknown". A key sent as null IS
// that second thing, and gets the dash plus the reason.
import { BreakdownListCard } from './cardKit.jsx';
import {
  EM_DASH, fmtDeduction, fmtInt, fmtMoney, fmtPctPlain, hasKey, present,
} from './dashFormat.js';

/** A number the server sent, or null. Never a default. */
const val = (src, k) => (src && present(src[k]) ? src[k] : null);

/**
 * WHERE THE ABANDON AND ORDER COUNTS ACTUALLY LIVE.
 *
 * Lane 1 folds `orders` and `abandoned` onto `kpis.upsell_lines` (they come out
 * of the same upsell-metric pass), NOT onto the top-level KPI block. Reading
 * only the top level found nothing and rendered nothing — which, because the
 * line is gated on key presence, silently deleted the whole "N abandoned"
 * footnote instead of dashing it. Both locations are read, upsell_lines first.
 */
const fromEither = (a, b, k) => (hasKey(a, k) ? val(a, k) : hasKey(b, k) ? val(b, k) : null);
const hasEither = (a, b, k) => hasKey(a, k) || hasKey(b, k);

export default function OrderValueCard({
  kpis, upsellLines, state, reason, testid = 'an-card-order-value',
}) {
  const up = upsellLines || null;

  // AOV, both bases. `aov_post` is the upsell-inclusive figure the KPI strip
  // shows; `aov_pre` is the same orders without the blend.
  const aovPost = val(up, 'aov_post') ?? val(kpis, 'aov');
  const aovPre = val(up, 'aov_pre') ?? val(kpis, 'aov_pre_upsell');
  const upsellRevenue = val(up, 'upsell_revenue') ?? val(kpis, 'upsell_revenue');
  const upsellRefunds = val(up, 'upsell_refunds');
  const takeRate = val(up, 'take_rate') ?? val(kpis, 'upsell_take_pct');
  const orders = fromEither(up, kpis, 'orders');
  const abandoned = fromEither(up, kpis, 'abandoned');
  const abandonedRate = fromEither(up, kpis, 'abandoned_rate');

  // ABSENT = not reported by this build. Only rendered when the key exists on
  // one of the two payloads we were given. `items_sold` is not in Lane 1's
  // dashboard fold at all today, so this line correctly renders NOTHING rather
  // than an em dash — "we did not measure this" and "this build does not report
  // it" are different sentences and only one of them is true.
  const hasItemsSold = hasEither(up, kpis, 'items_sold');
  const itemsSold = hasItemsSold ? fromEither(up, kpis, 'items_sold') : null;
  const hasAbandoned = hasEither(up, kpis, 'abandoned');

  const rows = [
    {
      label: 'AOV post-upsell',
      hint: 'Net sales ÷ base orders. Net sales already contains upsell and rebill legs, so this is the blended figure.',
      value: aovPost,
      missingHint: 'Needs orders. With no orders there is no average — not $0.00.',
    },
    {
      label: 'AOV pre-upsell',
      hint: 'The same orders with the upsell and rebill blend subtracted — server-derived, over the identical order set.',
      value: aovPre,
      missingHint: 'The split was refused or not reported. A pre-upsell AOV of $0.00 on a day with real orders is the most confidently wrong number this card could show.',
    },
    {
      label: 'Upsell revenue',
      hint: 'Upsell and rebill legs already inside gross sales, net of the legs’ own reversals.',
      value: upsellRevenue,
    },
    ...(present(upsellRefunds) && Number(upsellRefunds) > 0 ? [{
      label: '…reversed on the leg',
      hint: 'Refunded upsell money. It never enters the session refund ledger, so it is deducted from the upsell line itself — once, not twice and not never.',
      kind: 'negative',
      value: upsellRefunds,
      fmt: fmtDeduction,
    }] : []),
    {
      label: 'Orders',
      hint: 'Base orders. Upsell reversals are netted off Upsell revenue, never off this count.',
      value: orders,
      kind: 'total',
      fmt: fmtInt,
    },
  ];

  /**
   * A TAKE RATE IS A PROPORTION, AND A PROPORTION OVER 100% IS A BROKEN
   * DENOMINATOR — say so instead of printing it straight.
   *
   * Caught by capturing real output: Lane 1 computes `upsell_take_pct` as
   * legs ÷ upsell VIEWS, and against a fixture with settled upsell legs but
   * few recorded view touches it returned 104125. Printing "104125.0% take
   * rate" is not a small formatting wart — it is a number that cannot be true,
   * rendered with the same confidence as the money beside it, and it makes an
   * operator distrust the figures that ARE right.
   *
   * The value is NOT hidden and NOT clamped: hiding it buries a real signal
   * that the view counter is under-recording, and clamping to 100% would
   * invent a plausible figure out of an implausible one — the exact move this
   * whole workspace refuses. It is printed, and it is marked.
   */
  const takeRateImplausible = present(takeRate) && Number(takeRate) > 100;
  const takeRateLine = present(takeRate)
    ? `${fmtPctPlain(takeRate, 1)} take rate${
      present(upsellRefunds) && Number(upsellRefunds) > 0
        ? ` · net of ${fmtMoney(upsellRefunds)} reversed on the legs`
        : ''
    }`
    : null;

  const footer = (
    <div className="mt-2 pt-2 border-t border-border-default space-y-1" data-testid={`${testid}-notes`}>
      <p className="text-[10.5px] text-text-faint leading-relaxed">
        AOV is net sales ÷ base orders. Net sales already contains upsell and rebill money, so the
        post-upsell figure is the blended one; the pre-upsell figure is the same orders with that
        blend subtracted server-side, never a second query over a different order set.
      </p>
      {takeRateLine && (
        <p
          className={`text-[10.5px] tabular-nums ${takeRateImplausible ? 'text-warning' : 'text-text-muted'}`}
          data-testid={`${testid}-take-rate`}
          title={takeRateImplausible
            ? 'A take rate is upsell legs ÷ upsell views. Above 100% the denominator is incomplete — more legs settled than views were recorded — so this figure is not a proportion. It is shown as reported, not corrected.'
            : 'Upsell legs ÷ upsell views.'}
        >
          {takeRateLine}
          {takeRateImplausible && (
            <span data-testid={`${testid}-take-rate-implausible`}>
              {' — over 100%, so the view denominator is incomplete; shown as reported, not corrected.'}
            </span>
          )}
        </p>
      )}
      <p className="text-[10.5px] text-text-faint">
        Orders are base orders — upsell reversals are netted off Upsell revenue.
      </p>
      {hasAbandoned && (
        <p className="text-[10.5px] text-text-faint tabular-nums" data-testid={`${testid}-abandoned`}>
          {present(abandoned) ? `${fmtInt(abandoned)} abandoned` : `${EM_DASH} abandoned`}
          {present(abandonedRate) ? ` · ${fmtPctPlain(abandonedRate, 1)} of attempts` : ''}
          {' — checkouts that stayed at processing past the grace window. Intent, not money.'}
        </p>
      )}
      {hasItemsSold && (
        <p className="text-[10.5px] text-text-faint tabular-nums" data-testid={`${testid}-items-sold`}>
          {present(itemsSold) ? `${fmtInt(itemsSold)} items sold` : `${EM_DASH} items sold`}
        </p>
      )}
    </div>
  );

  return (
    <BreakdownListCard
      title="Order value & upsells"
      rows={rows}
      state={state}
      reason={reason}
      testid={testid}
      footer={footer}
    />
  );
}
