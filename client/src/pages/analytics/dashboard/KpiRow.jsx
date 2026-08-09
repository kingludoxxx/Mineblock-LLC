// KpiRow — the dashboard's eight headline tiles (NEW FILE, LANE 3).
//
//   Gross sales · Orders · Sessions · Returning rate
//   Net profit  · ROAS   · Spend    · Net after costs
//
// Each tile is one truth-layer metric: the big number, a delta chip against the
// previous period, and a sparkline for shape. THE HEADLINE AND THE DELTA ARE
// BOTH SERVER MATH — the sparkline is the only thing this file draws, and it
// claims nothing beyond the shape of the server's own series.
//
// THE FOUR RULES, all of them the same rule:
//   · value null/undefined  -> em dash, never 0.
//   · no baseline           -> NO delta chip. A "+100%" against an empty
//                              previous period is a number we invented.
//   · loading               -> skeleton, not an em dash. A fetching dashboard
//                              must never be pixel-identical to a dead one.
//   · failed                -> says so, in the tile.
//
// The one derived figure here is RETURNING RATE, and it is derived only from
// two counts the server sent: returning ÷ (new + returning). If either count is
// missing, or the denominator is zero, the rate is null — a rate over an
// unknown denominator is unknown, not 0%.
import { Sparkline } from './cardKit.jsx';
import {
  EM_DASH, deltaPct, fmtInt, fmtMoney, fmtPctPlain, fmtX, present, safeRate,
} from './dashFormat.js';

/* ── delta chip ──────────────────────────────────────────────────────────── */

function DeltaChip({ cur, prev, invert = false }) {
  const pct = deltaPct(cur, prev);
  if (pct === null) return null;
  const rounded = Math.round(pct);
  const good = invert ? rounded <= 0 : rounded >= 0;
  return (
    <span
      className={`tabular-nums text-[10px] font-medium ${good ? 'text-success' : 'text-danger'}`}
      title="vs previous period"
      data-testid="an-kpi-delta"
    >
      {`${rounded >= 0 ? '↗' : '↘'} ${Math.abs(rounded)}%`}
    </span>
  );
}

/* ── tile ────────────────────────────────────────────────────────────────── */

export function KpiTile({
  label, value, previous, fmt = fmtMoney, series, invert = false,
  accent, sub, why, onClick, testId, state,
}) {
  const loading = state === 'loading';
  const failed = state === 'failed';
  const missing = !present(value);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`relative overflow-hidden rounded-xl border border-border-default bg-bg-card p-4 pb-5 text-left w-full min-w-0 transition-colors ${
        onClick ? 'hover:border-accent/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40' : ''
      }`}
      data-testid={testId}
    >
      <div className="relative z-10 min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-text-muted font-semibold truncate">{label}</p>
        {loading ? (
          <div
            className="mt-1 h-8 w-24 rounded bg-bg-elevated animate-pulse"
            aria-label={`${label} loading`}
            data-testid="an-kpi-skeleton"
          />
        ) : (
          <p
            className={`text-2xl tabular-nums font-medium tracking-tight mt-1 ${
              missing ? 'text-text-faint' : (accent || 'text-text-primary')
            }`}
            title={missing ? (why || undefined) : undefined}
          >
            {present(value) ? fmt(value) : EM_DASH}
          </p>
        )}
        <div className="flex items-baseline justify-between gap-2 mt-0.5 min-h-[16px]">
          <span className={`text-[10px] truncate ${failed ? 'text-warning' : 'text-text-faint'}`}>
            {loading ? 'loading…' : failed ? 'couldn’t load' : (sub || '')}
          </span>
          {!loading && !failed && <DeltaChip cur={value} prev={previous} invert={invert} />}
        </div>
      </div>
      <Sparkline series={series} gradId={testId || label} />
    </Tag>
  );
}

/* ── the row ─────────────────────────────────────────────────────────────── */

/**
 * `kpis` / `previous` are the server's window figures; `spark` is a
 * `(metric) => number[]` reader over the server's own series. Nothing here
 * defaults a missing metric — an absent key and a withheld one both arrive as
 * `undefined`/`null` and both render an em dash with a reason.
 */
export default function KpiRow({ kpis, previous, spark, state, onDrill }) {
  const kv = (k) => (kpis && present(kpis[k]) ? kpis[k] : null);
  const pv = (k) => (previous && present(previous[k]) ? previous[k] : null);

  // RETURNING RATE — the only client-derived tile, and only from two counts the
  // server sent. `safeRate` returns null on a missing or zero denominator, so
  // "no customers yet" renders as an em dash rather than as 0.0% returning.
  const returningRate = (src) => {
    if (!src) return null;
    if (present(src.returning_rate)) return Number(src.returning_rate);
    const r = safeRate(src.returning_customers, Number(src.new_customers) + Number(src.returning_customers));
    return r === null ? null : r * 100;
  };

  const drill = (metric) => (onDrill ? () => onDrill(metric) : undefined);

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2.5"
      data-testid="an-kpi-row"
    >
      <KpiTile
        label="Gross sales" value={kv('gross_sales')} previous={pv('gross_sales')}
        fmt={fmtMoney} series={spark('gross_sales')} state={state}
        why="Gross sales were not reported for this window."
        testId="an-kpi-gross-sales" onClick={drill('gross_sales')}
      />
      <KpiTile
        label="Orders" value={kv('orders')} previous={pv('orders')}
        fmt={fmtInt} series={spark('orders')} state={state}
        why="Order count was not reported for this window."
        testId="an-kpi-orders" onClick={drill('orders')}
      />
      <KpiTile
        label="Sessions" value={kv('sessions')} previous={pv('sessions')}
        fmt={fmtInt} series={spark('sessions')} state={state}
        why="Withheld — part of this window reaches past the 90-day tracking retention, so the visitor spine no longer exists."
        sub={kv('sessions') === null ? 'no visitor spine' : ''}
        testId="an-kpi-sessions" onClick={drill('sessions')}
      />
      <KpiTile
        label="Returning rate" value={returningRate(kpis)} previous={returningRate(previous)}
        fmt={(v) => fmtPctPlain(v, 1)} series={[]} state={state}
        sub="of paying customers"
        why="Needs both the new and returning customer counts. A rate over an unknown denominator is unknown, not 0%."
        testId="an-kpi-returning-rate" onClick={drill('returning_customers')}
      />

      <KpiTile
        label="Net profit" value={kv('net_profit')} previous={pv('net_profit')}
        fmt={fmtMoney} series={spark('net_profit')} state={state}
        sub="after costs and spend"
        why="Withheld — net profit needs full cost coverage AND known spend."
        accent={
          !present(kv('net_profit')) ? undefined
            : Number(kv('net_profit')) >= 0 ? 'text-success' : 'text-danger'
        }
        testId="an-kpi-net-profit" onClick={drill('net_profit')}
      />
      <KpiTile
        label="ROAS" value={kv('roas')} previous={pv('roas')}
        fmt={fmtX} series={[]} state={state}
        why="Withheld — a return on a spend nobody recorded is a ratio over nothing, not 0.00x."
        testId="an-kpi-roas" onClick={drill('roas')}
      />
      <KpiTile
        label="Spend" value={kv('spend')} previous={pv('spend')}
        fmt={fmtMoney} series={spark('spend')} state={state} invert
        sub={kv('spend') === null ? 'no spend synced' : ''}
        why="No spend recorded for this window — bind a campaign or add manual spend."
        testId="an-kpi-spend" onClick={drill('spend')}
      />
      <KpiTile
        label="Net after costs" value={kv('net_after_cogs')} previous={pv('net_after_cogs')}
        fmt={fmtMoney} series={[]} state={state}
        sub="before ad spend"
        why="Withheld — not one order leg in this window is costed. A net-after-costs equal to net sales is a 100%-margin claim."
        accent={
          !present(kv('net_after_cogs')) ? undefined
            : Number(kv('net_after_cogs')) >= 0 ? 'text-success' : 'text-danger'
        }
        testId="an-kpi-net-after-costs" onClick={drill('net_after_cogs')}
      />
    </div>
  );
}
