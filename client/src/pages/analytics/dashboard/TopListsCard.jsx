// TopListsCard — the ranked breakdowns, one card, one switch
// (NEW FILE, LANE 5).
//
// Reads `breakdown_summary` out of the composite the page already fetches.
// Products, campaigns and countries are all in that payload and only two of the
// five were being drawn; the funnel and source folds have their own dedicated
// cards, so this one covers the rest.
//
// ── WHY ONE CARD WITH A SWITCH, NOT THREE CARDS ─────────────────────────────
// Three near-identical bar lists in a masonry read as three different findings.
// They are one finding — "what sold" — sliced three ways, and the slice is the
// operator's choice. One card also means the truncation footer is stated once,
// correctly, per slice.
//
// ── THE THREE THINGS EVERY SLICE MUST SAY ───────────────────────────────────
//   1. WHICH MONEY. Products fold `gross_sales`; campaigns and countries fold
//      `net_sales`. The difference is the refund total, so the caption names
//      the metric rather than saying "Sales".
//   2. WHICH BASIS. `basis_label` says whether upsell money is inside the fold
//      at all — a captured_base breakdown does not contain it, by construction.
//   3. HOW MUCH IS OFF-SCREEN. `rows_total` predates the server's rank cut and
//      `total` is folded over EVERY bucket, so the footer can say "Top 8 of 40
//      · $123,456" instead of implying the page is the whole thing. That logic
//      lives in HBarCard's TruncationFooter and is reused, not re-implemented.
import { useState } from 'react';
import { HBarCard } from './cardKit.jsx';
import { MONEY_METRIC_LABELS, breakdownOf, present, rowMoney } from '../metricsApi.js';
import { EM_DASH, countryLabel, plural } from './dashFormat.js';

/**
 * The slices. `blank` is what an empty key means IN THIS DIMENSION — and they
 * are different facts, so they get different words: a product with no title is
 * a data problem, a campaign with no UTM is an ad-setup one.
 */
const SLICES = Object.freeze([
  {
    id: 'products',
    label: 'Products',
    title: 'Top products',
    blank: '(untitled product)',
    prefix: 'Cart lines',
    empty: 'No product lines in this date range',
    note: 'A multi-line order appears once per line, so these rows sum to more than the order count. '
      + 'This is the cart\'s composition, not a share of the captured cash.',
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    title: 'Top campaigns',
    blank: 'no campaign on the click',
    prefix: 'Last-touch campaign',
    empty: 'No campaign-attributed sales in this date range',
    note: 'Last touch at or before payment. Money from a visitor whose click carried no campaign '
      + 'lands in the unattributed row — that row is a real bucket, not a rendering gap.',
  },
  {
    id: 'countries',
    label: 'Countries',
    title: 'Top countries',
    blank: '(no shipping country)',
    prefix: 'Shipping country on the order',
    empty: 'No sales with a shipping country in this date range',
    note: 'This is the SHIPPING country on the order — a property of the buyer\'s address, not of '
      + 'where their traffic came from. This build does not geolocate a visit.',
  },
]);

const rowLabel = (r) => r.label ?? r.name ?? r.key ?? r.id ?? null;

/** A blank-looking key is NAMED, never dropped and never printed as a dash. */
const honestLabel = (r, blank) => {
  const l = rowLabel(r);
  const s = l === null || l === undefined ? '' : String(l).trim();
  return s === '' || s === '(none)' || s === 'none' || s === 'null' ? blank : s;
};

export default function TopListsCard({
  data, state, reason, testid = 'an-card-top-lists',
}) {
  const [sliceId, setSliceId] = useState('products');
  const slice = SLICES.find((s) => s.id === sliceId) || SLICES[0];
  const bd = breakdownOf(data, slice.id);

  const metricLabel = bd.metric ? MONEY_METRIC_LABELS[bd.metric] : '';
  const sub = [slice.prefix, metricLabel, bd.basis_label].filter(Boolean).join(' · ') || undefined;

  const action = (
    <div className="flex gap-1 shrink-0" role="group" aria-label="Breakdown" data-testid={`${testid}-slices`}>
      {SLICES.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => setSliceId(s.id)}
          aria-pressed={s.id === sliceId}
          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            s.id === sliceId
              ? 'border-accent/45 text-accent-text bg-accent/10'
              : 'border-border-default text-text-faint hover:text-text-muted'
          }`}
          data-testid={`${testid}-slice-${s.id}`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );

  // A BREAKDOWN THE SERVER DID NOT SEND IS NOT AN EMPTY ONE. HBarCard's empty
  // state is a claim that we asked and the answer was nothing; when the key is
  // absent entirely, the honest sentence is different and is rendered instead.
  if (state === 'ready' && !bd.sent) {
    return (
      <section
        className="mb-3 break-inside-avoid rounded-xl border border-border-default bg-bg-card p-4"
        data-testid={testid}
      >
        <header className="flex items-start justify-between gap-2 mb-1">
          <h3 className="text-[13px] font-semibold tracking-tight text-text-primary truncate">{slice.title}</h3>
          {action}
        </header>
        <div className="flex items-center justify-center min-h-[140px] px-3 text-center" data-testid={`${testid}-absent`}>
          <p className="text-[11px] text-text-faint max-w-[300px] leading-relaxed">
            {`This response did not carry a ${slice.label.toLowerCase()} breakdown. That is an absence in
            the response, not a date range in which nothing sold.`}
          </p>
        </div>
      </section>
    );
  }

  return (
    <HBarCard
      title={slice.title}
      sub={sub}
      action={action}
      state={state}
      reason={reason}
      testid={testid}
      emptyText={slice.empty}
      total={bd.total}
      totalRows={bd.rows_total}
      totalLabel={metricLabel ? metricLabel.toLowerCase() : 'total'}
      rows={bd.rows.map((r) => ({
        label: slice.id === 'countries'
          ? countryLabel(r.country ?? r.key ?? r.label)
          : honestLabel(r, slice.blank),
        value: rowMoney(r).value,
        sub: present(r.orders) ? plural(r.orders, 'order', 'orders') : '',
      }))}
      footer={(
        <p className="text-[10.5px] text-text-faint mt-2 leading-relaxed">
          {slice.note}
          {bd.metric ? '' : ` This slice carries no money column, so every bar reads ${EM_DASH}.`}
        </p>
      )}
    />
  );
}
