// DashboardView — the whole analytics dashboard, rendered from props
// (NEW FILE, LANE 3).
//
// PURE ON PURPOSE. This component fetches nothing: it takes the two payloads
// (Lane 1's composite, Lane 2's marketing rows) and renders every surface off
// them. That is what lets ./__checks__/renderHarness.jsx mount the real page
// against CAPTURED payloads — including the withheld-everything one — and
// screenshot it, without a server, a login, or a mocked axios.
//
// LAYOUT, in reading order:
//   header · error · warnings · live band · KPI strip
//   hero row (2/3 sales over time + 1/3 sales breakdown)
//   FUNNEL PERFORMANCE (full width — the table this page exists for)
//   masonry: order value & upsells · sales by funnel · marketing · UTM source ·
//            conversion over time · sessions over time · sales by country ·
//            the two NOT-COLLECTED cards
//
// The masonry is CSS columns (columns-1 lg:columns-2 xl:columns-3), not grid:
// grid would stretch every card in a row to the tallest one and leave ragged
// holes between cards of different heights.
//
// ── TWO INDEPENDENT LOAD STATES, and they must not be merged ────────────────
// The composite and the attribution call fail separately. A dead attribution
// endpoint must not blank the page, and — the part that matters — the marketing
// card must not print "No attributed sales in this date range" because a
// request never came back. Every card takes its own `state`, and only a
// SUCCEEDED request may reach an empty state.
import { useMemo } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';
import {
  MONEY_METRIC_LABELS, bandOf, breakdownOf, bucketKeyOf, hasKey, kpisOf,
  marketingOf, present, rowMoney, seriesCol, seriesOf, sessionsUnknownOf,
  warningsOf, windowOf,
} from '../metricsApi.js';
import {
  BreakdownListCard, DonutCard, HBarCard, LineCard, NotCollectedCard,
} from './cardKit.jsx';
import DashboardHeader from './DashboardHeader.jsx';
import FunnelPerformanceTable from './FunnelPerformanceTable.jsx';
import KpiRow from './KpiRow.jsx';
import OrderValueCard from './OrderValueCard.jsx';
// LANE 5 — the insight layer. Every one of these is PURE and takes its payload
// as a prop, exactly like the cards above, so the render harness can mount them
// against captured payloads with no server.
import CohortCard from './CohortCard.jsx';
import EconomicsCard from './EconomicsCard.jsx';
import InsightsStrip from './InsightsStrip.jsx';
import Last60Card from './Last60Card.jsx';
import MoversCard from './MoversCard.jsx';
import StepWaterfallCard from './StepWaterfallCard.jsx';
import TopListsCard from './TopListsCard.jsx';
import { insightsOf } from '../insightsApi.js';
import {
  EM_DASH, countryLabel, fmtCountShort, fmtDeduction, fmtInt, fmtMoney,
  fmtMoneyShort, fmtPctPlain, plural, prettyRange,
} from './dashFormat.js';

/** A breakdown row's display name, under any spelling a lane may use. */
const rowLabel = (r) => r.label ?? r.name ?? r.key ?? r.id ?? null;

/**
 * LANE 1 BREAKDOWNS ONLY — never Lane 2's rows.
 *
 * Lane 1's breakdown rows are keyed on the raw dimension value, so a bucket
 * with nothing on the click arrives as '(none)' and has to be named. Printing
 * "—" for it would make a real bucket look like a rendering failure; dropping
 * it would move its money off the card and quietly shrink the total.
 *
 * ⚠️ Lane 2's rows are EXEMPT. Its contract says render `label` and filter on
 * `key`, because it has already disambiguated them server-side — a real
 * campaign literally named "direct / none" comes through as
 * "direct / none (campaign)". Re-deriving a label here would merge that row
 * with the unattributed bucket on screen while the server kept them apart.
 */
const honestKeyLabel = (r, blankLabel) => {
  const l = rowLabel(r);
  const s = l === null || l === undefined ? '' : String(l).trim();
  return s === '' || s === '(none)' || s === 'none' || s === 'null' ? blankLabel : s;
};

export default function DashboardView({
  data,
  marketing,
  marketingError,
  loadState,
  error,
  start,
  end,
  funnelId,
  collapsed,
  onToggleCollapsed,
  onScopeChange,
  onRangeChange,
  onRefresh,
  onOpenExplorer,
  onOpenLive,
  onDrillMetric,
  // ── LANE 5, all optional ──────────────────────────────────────────────────
  // Every prop below defaults to "this build did not fetch it", and the block
  // that consumes it is HIDDEN in that case rather than rendered empty. That is
  // what lets the six pre-existing render-harness states keep mounting this
  // component unchanged: an absent insight payload draws no strip, which is a
  // different thing from a strip that says nothing stood out.
  insights,
  insightsError,
  insightsState,
  cohorts,
  cohortsError,
  cohortsState,
  cohortsCsvUrl,
  cohortGroupBy,
  onCohortGroupByChange,
  onDrillInsight,
}) {
  // The composite's state, threaded into every card that reads it. `failed`
  // only when there is nothing on screen: a failed REFRESH over a good payload
  // keeps the figures and says so in the banner instead.
  const cardState = loadState === 'loading' && !data ? 'loading'
    : loadState === 'failed' && !data ? 'failed'
      : 'ready';
  const loading = cardState === 'loading';

  const win = windowOf(data);
  const warnings = warningsOf(data);
  const { cur: kpis, prev: prevKpis, upsell } = kpisOf(data);
  const sessionsUnknown = sessionsUnknownOf(data);
  const band = bandOf(data);

  const series = useMemo(() => seriesOf(data, 'series'), [data]);
  const prevSeries = useMemo(() => seriesOf(data, 'prev_series'), [data]);
  const labels = useMemo(() => series.map(bucketKeyOf), [series]);
  const prevLabels = useMemo(() => prevSeries.map(bucketKeyOf), [prevSeries]);
  const spark = (metric) => seriesCol(series, metric);

  const funnels = breakdownOf(data, 'funnels');
  const sources = breakdownOf(data, 'sources');
  const countries = breakdownOf(data, 'countries');
  const mk = marketingOf(marketing);

  /**
   * THE INSIGHT LAYER IS OPT-IN PER SURFACE, and absence is not a state.
   *
   * A caller that passes no `insightsState` has not fetched insights at all —
   * the six seeded harness states, for instance — and the strip is NOT rendered.
   * Rendering it in some "ready with nothing" state would put "nothing stood
   * out today" over a page that never asked, which is the same forbidden claim
   * as an empty state over a failed request, just one layer further out.
   */
  const hasInsightLane = Boolean(insightsState);
  const hasCohortLane = Boolean(cohortsState);
  const ins = useMemo(() => insightsOf(insights), [insights]);

  // ATTRIBUTION HAS ITS OWN STATE. It is 'failed' when the call rejected —
  // never 'ready with no rows', which is what would print the empty state.
  const mkState = loading ? 'loading' : marketingError ? 'failed' : 'ready';

  // The scope selector is built from the composite's OWN funnel breakdown, so
  // this page still makes exactly two requests. Non-funnel catch-all buckets
  // are not selectable — there is nothing to scope to.
  const funnelOptions = useMemo(
    () => funnels.rows
      .map((r) => ({ value: String(r.key ?? r.id ?? ''), label: String(rowLabel(r) ?? '') }))
      .filter((o) => o.value && o.value !== '(none)' && o.value !== 'none'),
    [funnels.rows],
  );
  const scopeLabel = funnelId
    ? (funnelOptions.find((o) => o.value === String(funnelId))?.label || 'One funnel')
    : 'All funnels';
  // Count what the breakdown actually covers — the folded bucket count when the
  // server sent one (it predates the rank cut), the rows we were handed
  // otherwise. Null when no breakdown arrived at all: an unknown count.
  const funnelCount = funnels.sent
    ? (funnels.rows_total !== null ? funnels.rows_total : funnels.rows.length)
    : null;

  const days = win.days;
  const comparisonLabel = win.prev_start && win.prev_end
    ? `vs ${prettyRange(win.prev_start, win.prev_end)}`
    : 'vs previous period';

  /**
   * A card headline, or NOTHING while the first fetch is in flight.
   *
   * `undefined` (not an em dash) during loading, because Card omits the line
   * entirely for undefined: a chart showing a shimmer skeleton under a headline
   * that already says "—" is telling the operator two different things at once,
   * and the em dash is the one that means "measured, and the answer is nothing".
   */
  const headline = (v, fn) => {
    if (loading) return undefined;
    return present(v) ? fn(v) : EM_DASH;
  };

  /**
   * WHICH MONEY, AND WHICH FOLD — two different claims, both printed.
   *
   * The metric label says whether refunds are already off (Net sales vs Gross
   * sales); the basis label says whether upsell money is inside the fold at all
   * ("captured base only — upsell money has no UTM"). Lane 1's breakdowns are
   * folded on `net_sales`, so a card captioned only "Sales" would be
   * understating by exactly the refund total with nothing on screen saying so.
   * Each clause is omitted when the server did not declare it — an interpolated
   * `undefined` is a worse caption than no caption.
   */
  const moneySub = (b, prefix) => {
    const metric = b.metric ? MONEY_METRIC_LABELS[b.metric] : '';
    const parts = [prefix, metric, b.basis_label].filter(Boolean);
    return parts.length ? parts.join(' · ') : undefined;
  };

  /**
   * Lane 2's own disclosures, as ONE per-card notice above the bars.
   *
   * THE TWO UNATTRIBUTED FACTS ARE NAMED SEPARATELY. 'none' means nothing was
   * measured for those orders at all; 'untagged' means the visit WAS seen and
   * the dimension simply was not tagged. They look identical on a bar chart and
   * they have opposite fixes — one is a tracking problem, the other is an ad
   * setup problem — so collapsing them into "no campaign" destroys the only
   * information that says which.
   */
  const marketingNotice = [
    mk.mixedCurrency
      ? 'This window mixes currencies. The money column is a raw sum across more than one of them and is not directly comparable — the $ in front of it is the shape of the number, not its unit.'
      : '',
    mk.ttlRisk
      ? 'The click ledger does not reach back far enough to stitch this whole window, so the unattributed bucket is inflated with traffic whose campaign has expired. This is a gap in the record, not a collapse in attribution.'
      : '',
    mk.unattributed.none && mk.unattributed.untagged
      ? 'Two different unattributed buckets are on this card: “nothing measured” (no visit on record for the order) and “visit seen, not tagged” (the click was recorded, the campaign was not). They are not the same problem.'
      : '',
    ...mk.warnings.map((w) => w.text),
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div className="p-6 space-y-4 max-w-[1800px]" data-testid="an-dashboard-page">
      <DashboardHeader
        start={start}
        end={end}
        window={win}
        funnelCount={funnelCount}
        scopeLabel={scopeLabel}
        funnelOptions={funnelOptions}
        funnelId={funnelId}
        onScopeChange={onScopeChange}
        onRangeChange={onRangeChange}
        onRefresh={onRefresh}
        refreshing={loadState === 'loading'}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onOpenExplorer={onOpenExplorer}
        onOpenLive={onOpenLive}
      />

      {/* A failed refetch OVER a good payload keeps the figures on screen and
          says the refresh failed. A cold failure gets the same banner with
          nothing behind it — either way the operator is told, never guessed at. */}
      {error ? (
        <div
          className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 flex items-start gap-2.5 text-xs text-danger"
          role="alert"
          data-testid="an-dash-error"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>
            {String(error)}
            {data ? ' The figures below are from the last successful load.' : ''}
          </span>
        </div>
      ) : null}

      {/* THE ATTRIBUTION FAILURE, SAID OUT LOUD AT PAGE LEVEL. The card below
          also shows it, but a single dead card in a masonry is easy to miss and
          its absence changes what the rest of the page appears to say. */}
      {marketingError && !loading ? (
        <div
          className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 flex items-start gap-2.5 text-xs text-warning/90"
          role="status"
          data-testid="an-dash-marketing-error"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>
            <span className="font-medium">Marketing attribution did not load.</span>{' '}
            {String(marketingError)}{' '}
            Sales figures on this page are unaffected — none of them are attributed.
          </span>
        </div>
      ) : null}

      {warnings.length > 0 && (
        <div
          className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-[11px] text-warning/90 space-y-0.5"
          role="status"
          data-testid="an-dash-warnings"
        >
          {warnings.map((w, i) => (
            <p key={`${w.source}-${i}`}>
              {w.source ? <span className="font-medium">{w.source}: </span> : null}
              {w.text}
            </p>
          ))}
        </div>
      )}

      {collapsed ? null : (
        <>
          {/* ── live band ─────────────────────────────────────────────────── */}
          {band && (
            <div
              className="rounded-xl border border-border-default bg-bg-card px-4 py-2.5 flex items-center gap-5 flex-wrap"
              data-testid="an-dash-band"
            >
              <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                <Radio className={`w-3.5 h-3.5 ${present(band.live) ? 'text-success' : 'text-text-faint'}`} />
                <span className="tabular-nums text-text-primary font-medium">
                  {present(band.live) ? fmtInt(band.live) : EM_DASH}
                </span>
                live now
              </span>
              <BandStat label="Unique today" value={present(band.unique_today) ? fmtInt(band.unique_today) : EM_DASH} />
              <BandStat label="Orders today" value={band.today && present(band.today.orders) ? fmtInt(band.today.orders) : EM_DASH} />
              <BandStat label="Revenue today" value={band.today && present(band.today.revenue) ? fmtMoney(band.today.revenue) : EM_DASH} />
              <BandStat label="Spend today" value={band.today && present(band.today.spend) ? fmtMoney(band.today.spend) : EM_DASH} />
              <BandStat label="Net today" value={band.today && present(band.today.net) ? fmtMoney(band.today.net) : EM_DASH} />
              {/* WHY TODAY'S NUMBERS ARE DASHES WHILE THE PAGE IS FULL OF DATA.
                  `in_window` is the server saying the selected window does not
                  contain today; without printing it, an operator reading a
                  historical range sees a dead band beside a live page and
                  concludes tracking is down. Tri-state: absent says nothing. */}
              {band.inWindow === false && (
                <span className="text-[10.5px] text-warning/90" data-testid="an-dash-band-out-of-window">
                  Today is outside the selected window — these are live counters, not part of the report below.
                </span>
              )}
              {/* The cadence is stated because the page actually keeps it: the
                  heartbeat hits Lane 1's dedicated /band route, not the whole
                  composite. It stops when the tab is hidden — an answer nobody
                  is looking at is worth nothing and costs a query. */}
              <span className="text-[10px] text-text-faint ml-auto">
                today, refreshed every 15s while this tab is open
              </span>
            </div>
          )}

          {/* ── INSIGHTS STRIP ────────────────────────────────────────────
              ABOVE the KPI tiles on purpose. The tiles say WHAT the numbers
              are; the strip says WHICH of them changed enough to matter, and an
              operator who has already read the tiles has spent their attention
              before reaching it. It carries its OWN state — a failed insight
              read must never blank the figures below, and a failed composite
              must never make the strip claim the day was quiet. */}
          {hasInsightLane && (
            <InsightsStrip
              insights={ins}
              state={insightsState}
              error={insightsError}
              onDrill={onDrillInsight}
            />
          )}

          {/* ── KPI strip ─────────────────────────────────────────────────── */}
          <KpiRow
            kpis={kpis}
            previous={prevKpis}
            spark={spark}
            state={cardState === 'ready' ? undefined : cardState}
            onDrill={onDrillMetric}
          />

          {/* ── hero row ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
            <div className="lg:col-span-2 min-w-0">
              <LineCard
                flush
                title="Total sales over time"
                headline={headline(kpis && kpis.gross_sales, fmtMoney)}
                sub={days ? `${days} day${days === 1 ? '' : 's'} · gross sales · previous period overlaid by position, not by date` : 'Gross sales'}
                points={seriesCol(series, 'gross_sales')}
                prevPoints={seriesCol(prevSeries, 'gross_sales')}
                labels={labels}
                prevLabels={prevLabels}
                fmt={fmtMoneyShort}
                comparisonLabel={comparisonLabel}
                height={240}
                state={cardState}
                reason={error ? String(error) : undefined}
                testid="an-card-sales-over-time"
              />
            </div>
            <div className="min-w-0">
              <BreakdownListCard
                flush
                title="Total sales breakdown"
                state={cardState}
                reason={error ? String(error) : undefined}
                testid="an-card-sales-breakdown"
                /* THE TWO REFUND LEDGERS, both on screen. Base money reverses
                   into the session refund ledger and is the "Refunds" row;
                   upsell money reverses onto the charge leg and is netted off
                   "of which upsells" at source, because the base ledger
                   structurally cannot carry it. Showing only the base row makes
                   an upsell reversal look like legs that stopped selling. */
                rows={[
                  { label: 'Gross sales', value: kpis ? kpis.gross_sales : null },
                  {
                    label: 'of which upsells',
                    hint: 'Upsell and rebill legs already inside gross sales, net of the legs’ own reversals.',
                    value: upsell ? upsell.upsell_revenue : null,
                  },
                  ...(upsell && present(upsell.upsell_refunds) && Number(upsell.upsell_refunds) > 0 ? [{
                    label: '…reversed on the leg',
                    hint: 'Refunded upsell money. It never enters the session refund ledger, so it is deducted from the upsell line itself — once, not twice and not never.',
                    kind: 'negative',
                    value: upsell.upsell_refunds,
                    fmt: fmtDeduction,
                  }] : []),
                  {
                    label: 'Refunds',
                    hint: 'The session refund ledger — base money only, on the day it went back.',
                    kind: 'negative',
                    value: kpis ? kpis.refunds : null,
                    fmt: fmtDeduction,
                  },
                  { label: 'Net sales', kind: 'total', value: kpis ? kpis.net_sales : null },
                ]}
              />
            </div>
          </div>

          {/* ── the table this page exists for ────────────────────────────── */}
          <FunnelPerformanceTable
            rows={funnels.rows}
            totals={kpis}
            basisLabel={funnels.basis_label}
            metricLabel={funnels.metric ? `Money column: ${MONEY_METRIC_LABELS[funnels.metric]}` : ''}
            state={cardState}
            reason={error ? String(error) : undefined}
            sessionsUnknown={sessionsUnknown}
            activeFunnelId={funnelId}
            onPickFunnel={(r) => {
              const id = String(r.key ?? r.id ?? '');
              if (!id) return;
              onScopeChange(id === String(funnelId || '') ? '' : id);
            }}
          />

          {/* ── COHORTS — full width, under the funnel table ────────────────
              Not in the masonry: it is a wide table with one column per
              horizon, and a CSS-columns cell would either clip it or force a
              horizontal scrollbar inside a 380px column. Its own state, its own
              window (acquisition, not the picker's range), and it says so. */}
          {hasCohortLane && (
            <CohortCard
              cohorts={cohorts}
              state={cohortsState}
              error={cohortsError}
              groupBy={cohortGroupBy}
              onGroupByChange={onCohortGroupByChange}
              csvUrl={cohortsCsvUrl}
            />
          )}

          {/* ── masonry ───────────────────────────────────────────────────── */}
          <div className="columns-1 lg:columns-2 xl:columns-3 gap-3" data-testid="an-card-masonry">
            {/* LANE 5 cards that read the COMPOSITE — no extra request. The
                waterfall and movers blocks have been on the wire since Lane 1
                and nothing was drawing them; economics is a division of figures
                the KPI block already carries. */}
            <StepWaterfallCard
              data={data}
              state={cardState}
              reason={error ? String(error) : undefined}
            />

            <MoversCard
              data={data}
              window={win}
              state={cardState}
              reason={error ? String(error) : undefined}
              onPickFunnel={(id) => onScopeChange(id === String(funnelId || '') ? '' : id)}
            />

            <EconomicsCard
              kpis={kpis}
              upsellLines={upsell}
              state={cardState}
              reason={error ? String(error) : undefined}
            />

            {/* Its own lane's payload and its own lane's state — a dead insight
                endpoint costs this card and nothing else on the page. */}
            {hasInsightLane && (
              <Last60Card
                insights={insights}
                state={insightsState}
                error={insightsError}
              />
            )}

            <TopListsCard
              data={data}
              state={cardState}
              reason={error ? String(error) : undefined}
            />

            <OrderValueCard
              kpis={kpis}
              upsellLines={upsell}
              state={cardState}
              reason={error ? String(error) : undefined}
            />

            <DonutCard
              title="Sales by funnel"
              sub={moneySub(funnels)}
              state={cardState}
              reason={error ? String(error) : undefined}
              testid="an-card-sales-by-funnel"
              rows={funnels.rows.map((r) => ({ label: rowLabel(r) ?? EM_DASH, value: rowMoney(r).value }))}
              total={funnels.total}
              totalRows={funnels.rows_total}
              totalLabel={funnels.metric ? MONEY_METRIC_LABELS[funnels.metric].toLowerCase() : ''}
              centerFmt={fmtMoneyShort}
            />

            {/* Lane 2's own payload — the ONE attribution request, with ITS OWN
                state so a dead endpoint cannot print "no attributed sales". */}
            <HBarCard
              title="Sales attributed to marketing"
              /* THE REVENUE BASIS IS PRINTED because Lane 2 draws it on a
                 different one from /roas ('order_window' vs 'click_cohort'),
                 and its own header warns the two "will not tie out for the same
                 dates, by definition". A card that omits which basis it is on
                 invites exactly that comparison. */
              sub={[
                moneySub(mk, 'Last-touch campaign, stitched across the visitor’s sessions'),
                mk.revenueBasisLabel,
              ].filter(Boolean).join(' · ') || undefined}
              notice={marketingNotice}
              state={mkState}
              reason={marketingError ? String(marketingError) : undefined}
              testid="an-card-marketing"
              total={mk.total}
              totalRows={mk.rows_total}
              totalLabel={mk.metric ? MONEY_METRIC_LABELS[mk.metric].toLowerCase() : 'total'}
              /* `label` VERBATIM — Lane 2's contract. The unattributed rows
                 already say which of the two facts they are; the sub carries
                 the state so the distinction survives even if a label is
                 truncated. */
              rows={mk.rows.map((r) => ({
                label: String(r.label ?? r.key ?? EM_DASH),
                value: rowMoney(r).value,
                sub: [
                  present(r.orders) ? plural(r.orders, 'order', 'orders') : '',
                  r.attribution === 'none' ? 'nothing measured'
                    : r.attribution === 'untagged' ? 'visit seen, not tagged' : '',
                ].filter(Boolean).join(' · '),
              }))}
              emptyText="No attributed sales in this date range"
            />

            <HBarCard
              title="Sales by UTM source"
              sub={moneySub(sources)}
              state={cardState}
              reason={error ? String(error) : undefined}
              testid="an-card-sources"
              total={sources.total}
              totalRows={sources.rows_total}
              totalLabel={sources.metric ? MONEY_METRIC_LABELS[sources.metric].toLowerCase() : 'total'}
              rows={sources.rows.map((r) => ({
                label: honestKeyLabel(r, 'direct / none'),
                value: rowMoney(r).value,
                sub: present(r.orders) ? plural(r.orders, 'order', 'orders') : '',
              }))}
            />

            <LineCard
              title="Conversion rate over time"
              headline={headline(kpis && kpis.conv_pct, fmtPctPlain)}
              sub="Orders ÷ sessions per bucket. A bucket with no measured sessions is a hole, not 0%."
              points={seriesCol(series, 'conv_pct')}
              prevPoints={seriesCol(prevSeries, 'conv_pct')}
              labels={labels}
              prevLabels={prevLabels}
              fmt={(v) => fmtPctPlain(v, 2)}
              comparisonLabel={comparisonLabel}
              height={180}
              state={cardState}
              reason={error ? String(error) : undefined}
              withheldReason={sessionsUnknown
                ? 'Conversion is orders ÷ sessions, and the session denominator for this window has expired past the 90-day tracking retention. A rate over an unknown denominator is unknown, not 0%.'
                : undefined}
              testid="an-card-conversion-over-time"
            />

            <LineCard
              title="Sessions over time"
              headline={headline(kpis && kpis.sessions, fmtInt)}
              sub="Distinct visitors per bucket — not hits."
              points={seriesCol(series, 'sessions')}
              prevPoints={seriesCol(prevSeries, 'sessions')}
              labels={labels}
              prevLabels={prevLabels}
              fmt={fmtCountShort}
              comparisonLabel={comparisonLabel}
              height={180}
              state={cardState}
              reason={error ? String(error) : undefined}
              withheldReason={sessionsUnknown
                ? 'This window reaches past the 90-day tracking retention, so the visitor spine for it no longer exists. The visitors are not zero — the record of them has expired.'
                : undefined}
              testid="an-card-sessions-over-time"
            />

            {/* SALES by country — the ORDER's shipping country, off the order
                record. NEVER captioned "Pageviews by country": that quantity is
                a different measurement entirely and this build does not take
                it (see the not-collected card below). Hidden when the server
                did not send the breakdown at all. */}
            {countries.sent && (
              <DonutCard
                title="Sales by country"
                sub={moneySub(countries, 'Shipping country on the order')}
                state={cardState}
                reason={error ? String(error) : undefined}
                testid="an-card-sales-by-country"
                rows={countries.rows.map((r) => ({
                  label: countryLabel(r.country ?? r.key ?? r.label),
                  value: rowMoney(r).value,
                }))}
                total={countries.total}
                totalRows={countries.rows_total}
                totalLabel={countries.metric ? MONEY_METRIC_LABELS[countries.metric].toLowerCase() : ''}
                centerFmt={fmtMoneyShort}
              />
            )}

            {/* NOT COLLECTED — never omitted, never fabricated. Dropping these
                would let an operator conclude the split does not matter;
                rendering an empty state would assert "no mobile traffic in this
                range", which is a measurement nobody took. */}
            <NotCollectedCard
              title="Sessions by device"
              testid="an-card-device-not-collected"
              what="This build does not record a device class on a touch. There is no user-agent parse behind these figures, so there is no mobile / tablet / desktop split to show."
            />
            <NotCollectedCard
              title="Pageviews by country"
              testid="an-card-geo-not-collected"
              what="This build does not geolocate a touch. The country card above is the SHIPPING country on the order — a different quantity, taken from a different record, and it says nothing about where traffic came from."
            />
          </div>

          {/* ── provenance footer ─────────────────────────────────────────── */}
          <p className="text-[11px] text-text-faint leading-relaxed max-w-4xl">
            Every figure here is computed on read against the ledgers — there are no rollup tables to
            go stale. Revenue counts paid sessions only; a session at <code>processing</code> is intent,
            not money. Refunds net the top line, never the order count. An em dash is a number we{' '}
            <span className="italic">refuse</span> to invent: it means the source was withheld or the
            denominator was never measured, and it is never a zero wearing a disguise.
            {data && data.meta && present(data.meta.computed_ms)
              ? ` Computed in ${fmtInt(data.meta.computed_ms)}ms${
                hasKey(data.meta, 'rows_scanned') && present(data.meta.rows_scanned)
                  ? ` over ${fmtInt(data.meta.rows_scanned)} rows`
                  : ''
              }.`
              : ''}
          </p>
        </>
      )}
    </div>
  );
}

function BandStat({ label, value }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-xs">
      <span className="text-text-faint">{label}</span>
      <span className="tabular-nums text-text-primary font-medium">{value}</span>
    </span>
  );
}
