// DashboardView — the whole analytics dashboard, rendered from props
// (NEW FILE, LANE 3).
//
// PURE ON PURPOSE. This component fetches nothing: it takes the two payloads
// (Lane 1's composite, Lane 2's marketing rows) and renders every surface off
// them. That is what lets ./__checks__/renderHarness.jsx mount the real page
// against seeded data — including the withheld-everything payload — and screenshot
// it, without a server, a login, or a mocked axios.
//
// LAYOUT, in reading order:
//   header · warnings · live band · KPI strip
//   hero row (2/3 sales over time + 1/3 sales breakdown)
//   FUNNEL PERFORMANCE (full width — the table this page exists for)
//   masonry: order value & upsells · sales by funnel · marketing · UTM source ·
//            conversion over time · sales by country · the two NOT-COLLECTED cards
//
// The masonry is CSS columns (columns-1 lg:columns-2 xl:columns-3), not grid:
// grid would stretch every card in a row to the tallest one and leave ragged
// holes between cards of different heights.
import { useMemo } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';
import {
  bucketKeyOf, breakdownOf, hasKey, kpisOf, marketingOf, present, seriesOf,
  sessionsUnknownOf, warningsOf, windowOf,
} from '../metricsApi.js';
import {
  BreakdownListCard, DonutCard, HBarCard, LineCard, NotCollectedCard,
} from './cardKit.jsx';
import DashboardHeader from './DashboardHeader.jsx';
import FunnelPerformanceTable from './FunnelPerformanceTable.jsx';
import KpiRow from './KpiRow.jsx';
import OrderValueCard from './OrderValueCard.jsx';
import {
  EM_DASH, fmtCountShort, fmtInt, fmtMoney, fmtMoneyShort, fmtPctPlain,
  countryLabel, prettyRange, spanDays,
} from './dashFormat.js';

/** A breakdown row's money field, under either of the two spellings. */
const rowSales = (r) => (present(r.gross_sales) ? r.gross_sales : r.sales);
/** A breakdown row's display name, under any of the spellings a lane may use. */
const rowLabel = (r) => r.label ?? r.name ?? r.key ?? r.id ?? null;

/**
 * A bucket with no campaign/source on the click is a REAL bucket and has to be
 * labelled as what it is. Printing "—" for it would make it look like a
 * rendering failure; dropping it would move its money off the card and quietly
 * shrink the total the footer prints.
 */
const honestKeyLabel = (r, blankLabel) => {
  const l = rowLabel(r);
  const s = l === null || l === undefined ? '' : String(l).trim();
  return s === '' || s === '(none)' || s === 'null' ? blankLabel : s;
};

export default function DashboardView({
  data,
  marketing,
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
}) {
  const loading = loadState === 'loading' && !data;
  const tileState = loading ? 'loading' : (loadState === 'failed' && !data ? 'failed' : undefined);

  const win = windowOf(data);
  const warnings = warningsOf(data);
  const { cur: kpis, prev: prevKpis, upsell } = kpisOf(data);
  const sessionsUnknown = sessionsUnknownOf(data);

  const series = useMemo(() => seriesOf(data, 'series'), [data]);
  const prevSeries = useMemo(() => seriesOf(data, 'prev_series'), [data]);
  const labels = useMemo(() => series.map(bucketKeyOf), [series]);
  const prevLabels = useMemo(() => prevSeries.map(bucketKeyOf), [prevSeries]);
  /** A metric column out of the server's own series. Nulls stay null (holes). */
  const col = (rows, key) => rows.map((p) => (p && key in p ? p[key] : null));
  const spark = (metric) => col(series, metric);

  const funnels = breakdownOf(data, 'funnels');
  const sources = breakdownOf(data, 'sources');
  const countries = breakdownOf(data, 'countries');
  const mk = marketingOf(marketing);

  // The scope selector is built from the composite's OWN funnel breakdown, so
  // this page still makes exactly two requests.
  const funnelOptions = useMemo(
    () => funnels.rows
      .map((r) => ({ value: String(r.id ?? r.key ?? ''), label: String(rowLabel(r) ?? r.id ?? '') }))
      .filter((o) => o.value),
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

  const days = spanDays(win.start || start, win.end || end);
  const comparisonLabel = win.prev_start && win.prev_end
    ? `vs ${prettyRange(win.prev_start, win.prev_end)}`
    : 'vs previous period';

  const band = data && data.band && typeof data.band === 'object' ? data.band : null;
  const today = band && band.today && typeof band.today === 'object' ? band.today : null;

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

  /* THE CAPTURED-BASE DISCLAIMER HAS TO BE TRUE. It is printed only when the
     lane actually declared a basis label; a breakdown without one gets no
     claim rather than a guess. */
  const basisSub = (b, prefix) => {
    const parts = [prefix, b.basis_label].filter(Boolean);
    return parts.length ? parts.join(' · ') : undefined;
  };

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

      {warnings.length > 0 && (
        <div
          className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-[11px] text-warning/90 space-y-0.5"
          role="status"
          data-testid="an-dash-warnings"
        >
          {warnings.map((w) => <p key={w}>{w}</p>)}
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
              <BandStat label="Orders today" value={today && present(today.orders) ? fmtInt(today.orders) : EM_DASH} />
              <BandStat label="Revenue today" value={today && present(today.revenue) ? fmtMoney(today.revenue) : EM_DASH} />
              <BandStat label="Spend today" value={today && present(today.spend) ? fmtMoney(today.spend) : EM_DASH} />
              <BandStat label="Net today" value={today && present(today.net) ? fmtMoney(today.net) : EM_DASH} />
              <span className="text-[10px] text-text-faint ml-auto">refreshes every 15s while this tab is open</span>
            </div>
          )}

          {/* ── KPI strip ─────────────────────────────────────────────────── */}
          <KpiRow
            kpis={kpis}
            previous={prevKpis}
            spark={spark}
            state={tileState}
            onDrill={onDrillMetric}
          />

          {/* ── hero row ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
            <div className="lg:col-span-2 min-w-0">
              <LineCard
                flush
                title="Total sales over time"
                headline={headline(kpis && kpis.gross_sales, fmtMoney)}
                sub={days ? `${days} day${days === 1 ? '' : 's'} · previous period overlaid by position, not by date` : undefined}
                points={col(series, 'gross_sales')}
                prevPoints={col(prevSeries, 'gross_sales')}
                labels={labels}
                prevLabels={prevLabels}
                fmt={fmtMoneyShort}
                comparisonLabel={comparisonLabel}
                height={240}
                loading={loading}
                testid="an-card-sales-over-time"
              />
            </div>
            <div className="min-w-0">
              <BreakdownListCard
                flush
                title="Total sales breakdown"
                loading={loading}
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
                    value: kpis ? kpis.upsell_revenue : null,
                  },
                  ...(upsell && present(upsell.upsell_refunds) && Number(upsell.upsell_refunds) > 0 ? [{
                    label: '…reversed on the leg',
                    hint: 'Refunded upsell money. It never enters the session refund ledger, so it is deducted from the upsell line itself — once, not twice and not never.',
                    kind: 'negative',
                    value: upsell.upsell_refunds,
                    fmt: (v) => `−${fmtMoney(v)}`,
                  }] : []),
                  {
                    label: 'Refunds',
                    hint: 'The session refund ledger — base money only, on the day it went back.',
                    kind: 'negative',
                    value: kpis ? kpis.refunds : null,
                    fmt: (v) => `−${fmtMoney(v)}`,
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
            loading={loading}
            sessionsUnknown={sessionsUnknown}
            activeFunnelId={funnelId}
            onPickFunnel={(r) => onScopeChange(
              String(r.id) === String(funnelId || '') ? '' : String(r.id),
            )}
          />

          {/* ── masonry ───────────────────────────────────────────────────── */}
          <div className="columns-1 lg:columns-2 xl:columns-3 gap-3" data-testid="an-card-masonry">
            <OrderValueCard kpis={kpis} upsellLines={upsell} loading={loading} />

            <DonutCard
              title="Sales by funnel"
              sub={basisSub(funnels, undefined)}
              loading={loading}
              testid="an-card-sales-by-funnel"
              rows={funnels.rows.map((r) => ({ label: rowLabel(r) ?? EM_DASH, value: rowSales(r) }))}
              centerFmt={fmtMoneyShort}
            />

            {/* Lane 2's own payload — the ONE attribution request. The blank
                bucket is labelled honestly rather than dropped, and the footer
                prints the folded period total so the tail the rank cut removed
                is admitted in words. */}
            <HBarCard
              title="Sales attributed to marketing"
              sub={basisSub(mk, 'Last-touch campaign, stitched across the visitor’s sessions')}
              loading={loading}
              testid="an-card-marketing"
              total={mk.total}
              totalRows={mk.rows_total}
              rows={mk.rows.map((r) => ({
                label: honestKeyLabel(r, 'No campaign on the click'),
                value: rowSales(r),
                sub: present(r.orders) ? `${fmtInt(r.orders)} orders` : '',
              }))}
              emptyText="No attributed sales in this date range"
            />

            <HBarCard
              title="Sales by UTM source"
              sub={basisSub(sources, undefined)}
              loading={loading}
              testid="an-card-sources"
              total={sources.total}
              totalRows={sources.rows_total}
              rows={sources.rows.map((r) => ({
                label: honestKeyLabel(r, 'direct / none'),
                value: rowSales(r),
                sub: present(r.orders) ? `${fmtInt(r.orders)} orders` : '',
              }))}
            />

            <LineCard
              title="Conversion rate over time"
              headline={headline(kpis && kpis.conv_pct, fmtPctPlain)}
              sub="Orders ÷ sessions per bucket. A bucket with no measured sessions is a hole, not 0%."
              points={col(series, 'conv_pct')}
              prevPoints={col(prevSeries, 'conv_pct')}
              labels={labels}
              prevLabels={prevLabels}
              fmt={(v) => fmtPctPlain(v, 2)}
              comparisonLabel={comparisonLabel}
              height={180}
              loading={loading}
              testid="an-card-conversion-over-time"
            />

            <LineCard
              title="Sessions over time"
              headline={headline(kpis && kpis.sessions, fmtInt)}
              sub="Distinct visitors per bucket — not hits."
              points={col(series, 'sessions')}
              prevPoints={col(prevSeries, 'sessions')}
              labels={labels}
              prevLabels={prevLabels}
              fmt={fmtCountShort}
              comparisonLabel={comparisonLabel}
              height={180}
              loading={loading}
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
                /* No prefix: the server's own basis label already names the
                   record this money came off, and prefixing it printed the
                   same sentence twice. */
                sub={basisSub(countries, undefined)}
                loading={loading}
                testid="an-card-sales-by-country"
                rows={countries.rows.map((r) => ({
                  label: countryLabel(r.country ?? r.key ?? r.label),
                  value: rowSales(r),
                }))}
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
