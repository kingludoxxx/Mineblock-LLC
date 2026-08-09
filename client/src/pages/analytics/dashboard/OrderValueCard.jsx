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
  EM_DASH, fmtInt, fmtMoney, fmtPctPlain, hasKey, present,
} from './dashFormat.js';

/** A number the server sent, or null. Never a default. */
const val = (src, k) => (src && present(src[k]) ? src[k] : null);

export default function OrderValueCard({ kpis, upsellLines, loading, testid = 'an-card-order-value' }) {
  const up = upsellLines || null;

  // AOV, both bases. `aov_post` is the upsell-inclusive figure the KPI strip
  // shows; `aov_pre` is the same orders without the blend.
  const aovPost = val(up, 'aov_post') ?? val(kpis, 'aov');
  const aovPre = val(up, 'aov_pre') ?? val(kpis, 'aov_pre_upsell');
  const upsellRevenue = val(up, 'upsell_revenue') ?? val(kpis, 'upsell_revenue');
  const upsellRefunds = val(up, 'upsell_refunds');
  const takeRate = val(up, 'take_rate') ?? val(kpis, 'upsell_take_pct');
  const orders = val(kpis, 'orders');
  const abandoned = val(kpis, 'abandoned');
  const abandonedRate = val(kpis, 'abandoned_rate');

  // ABSENT = not reported by this build. Only rendered when the key exists on
  // one of the two payloads we were given.
  const hasItemsSold = hasKey(kpis, 'items_sold');
  const itemsSold = hasItemsSold ? val(kpis, 'items_sold') : null;
  const hasAbandoned = hasKey(kpis, 'abandoned');

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
      fmt: (v) => `−${fmtMoney(v)}`,
    }] : []),
    {
      label: 'Orders',
      hint: 'Base orders. Upsell reversals are netted off Upsell revenue, never off this count.',
      value: orders,
      kind: 'total',
      fmt: fmtInt,
    },
  ];

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
        <p className="text-[10.5px] text-text-muted tabular-nums" data-testid={`${testid}-take-rate`}>
          {takeRateLine}
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
      loading={loading}
      testid={testid}
      footer={footer}
    />
  );
}
