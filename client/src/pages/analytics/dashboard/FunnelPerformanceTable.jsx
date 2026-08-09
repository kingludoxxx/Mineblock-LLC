// FunnelPerformanceTable — the economics table this dashboard exists for
// (NEW FILE, LANE 3). Built FIRST, per the work order.
//
// Eighteen columns, one row per funnel, and every one of them is either the
// server's own figure or an em dash. NOTHING on this table is re-aggregated on
// the client and nothing is derived from a denominator the server withheld.
//
//   Funnel · Sessions · Orders · Conv · Gross · Net · AOV · $/session ·
//   Refunds · COGS · Fees · GP · GP% · Coverage · Spend · Net profit ·
//   ROAS · CPA
//
// THE TWO WITHHOLDINGS, and why each cell dashes rather than prints:
//
//   1. SESSIONS (and every rate over them). Lane 1 §7: when any day of the
//      window crosses the 90-day lb_touches TTL the visitor spine is gone, so
//      sessions are withheld and Conv and $/session go with them. Coercing
//      those to zero produces, verbatim, "Sessions 0 · Orders 412 · Conv
//      0.00% · Gross $52,000" — an argument to kill a funnel that is earning.
//      Orders, Gross, Net and Refunds keep printing: those are always measured,
//      and a genuine 0 there is a fact.
//
//   2. COSTS AND SPEND. GP, GP%, Net profit, ROAS and CPA are withheld at zero
//      cost coverage or unknown spend (funnelCosts.js precedent). A gross
//      profit equal to net sales is the 100%-margin lie, and a ROAS against a
//      spend nobody recorded is a ratio over nothing. Coverage carries the
//      missing-leg count so a partial figure is never mistaken for a complete
//      one.
//
// Row click scopes the whole page to that funnel; clicking the active row zooms
// back out.
import { EM_DASH, fmtInt, fmtMoney, fmtPctPlain, fmtX, present } from './dashFormat.js';

/* ── cells ───────────────────────────────────────────────────────────────── */

const TH = ({ children, right, title }) => (
  <th
    title={title}
    className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted whitespace-nowrap ${
      right ? 'text-right' : 'text-left'
    }`}
  >
    {children}
  </th>
);

const TD = ({ children, right, className = '' }) => (
  <td className={`px-2 py-1.5 text-[11px] whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${className}`}>
    {children}
  </td>
);

/**
 * A withheld cell says WHY on hover. A dash with no reason reads as a rendering
 * bug on a money page, which is how an honest refusal gets reported as broken.
 */
const Dash = ({ why }) => (
  <span className="text-text-faint" title={why || undefined}>{EM_DASH}</span>
);

/** Money that keeps null (withheld) distinct from a real number — including $0.00. */
function Money({ v, why, cls = 'text-text-primary' }) {
  if (!present(v) || !Number.isFinite(Number(v))) return <Dash why={why} />;
  const n = Number(v);
  return <span className={n < 0 ? 'text-danger' : cls}>{fmtMoney(n)}</span>;
}

/** Coverage % plus the missing-leg counts that qualify every partial number. */
function CoverageCell({ row }) {
  const pct = row.cost_coverage_pct;
  if (!present(pct)) {
    return <Dash why="Cost coverage was not reported for this funnel in this window" />;
  }
  const n = Number(pct);
  const tone = n >= 100 ? 'bg-success' : n > 0 ? 'bg-warning' : 'bg-danger';
  const missing = present(row.missing_legs) ? Number(row.missing_legs) : null;
  return (
    <div className="flex items-center gap-2 justify-end">
      {missing !== null && missing > 0 && (
        <span
          className="text-[10px] text-warning tabular-nums"
          title={`${missing} order leg${missing === 1 ? '' : 's'} in this window have no cost`}
        >
          {missing} legs
        </span>
      )}
      <span className="tabular-nums text-[10px] text-text-muted w-[34px] text-right">{n.toFixed(0)}%</span>
      <span className="h-1.5 w-12 rounded-full bg-bg-elevated overflow-hidden shrink-0">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, n))}%` }} />
      </span>
    </div>
  );
}

/* ── row reader ──────────────────────────────────────────────────────────── */

/**
 * ONE place that names the row vocabulary. Lane 1's funnel breakdown rows carry
 * the frozen metric keys; the alternates here are the two spellings the work
 * order itself uses for the same quantity (GP === net_after_cogs, GP% ===
 * margin_pct, $/session === rev_per_session). `??` is used ONLY between two
 * spellings of the SAME field — never between a field and a zero.
 */
const read = (r) => ({
  id: r.id ?? r.key ?? r.funnel_id ?? null,
  name: r.name ?? r.label ?? r.id ?? r.key ?? EM_DASH,
  sessions: r.sessions,
  orders: r.orders,
  conv_pct: r.conv_pct,
  gross_sales: r.gross_sales,
  net_sales: r.net_sales,
  aov: r.aov,
  rev_per_session: r.rev_per_session ?? r.epc,
  refunds: r.refunds,
  cogs: r.cogs,
  fees: r.fees,
  gp: r.gp ?? r.net_after_cogs,
  gp_pct: r.gp_pct ?? r.margin_pct,
  cost_coverage_pct: r.cost_coverage_pct,
  missing_legs: r.missing_legs,
  spend: r.spend,
  spend_known: r.spend_known,
  net_profit: r.net_profit,
  roas: r.roas,
  cpa: r.cpa,
});

const WHY = {
  sessionsTtl:
    'Withheld — part of this window reaches past the 90-day tracking retention, '
    + 'so the visitor spine for it no longer exists.',
  sessions: 'Sessions were not measured for this funnel in this window.',
  conv: 'A conversion rate over an unmeasured session count is unknown, not 0%.',
  eps: 'Revenue per session needs a session count. It is unknown, not $0.00.',
  aov: 'AOV needs orders. With no orders there is no average — not $0.00.',
  cogs: 'No cost coverage — COGS is unknown for this window.',
  fees: 'Fees were not reported for this window.',
  gp: 'Withheld — cost coverage is incomplete. Gross profit equal to net sales would be a 100%-margin claim.',
  gpPct: 'Withheld — margin is unknown, not 100%.',
  spend: 'No spend recorded — bind a campaign or add manual spend.',
  netProfit: 'Withheld — net profit needs full costs AND known spend.',
  roas: 'Withheld — a return on a spend nobody recorded is a ratio over nothing.',
  cpa: 'Withheld — cost per acquisition needs known spend.',
};

/* ── the table ───────────────────────────────────────────────────────────── */

export default function FunnelPerformanceTable({
  rows,
  totals,
  basisLabel,
  loading,
  sessionsUnknown,
  activeFunnelId,
  onPickFunnel,
}) {
  const list = (Array.isArray(rows) ? rows.filter(Boolean) : []).map(read);
  const t = totals ? read(totals) : null;

  // A dash in the sessions column has two different reasons and the header note
  // has to name the right one: the TTL breach is a property of the WINDOW, a
  // per-funnel null is a property of that row.
  const sessionWhy = sessionsUnknown ? WHY.sessionsTtl : WHY.sessions;

  return (
    <section
      className="rounded-xl border border-border-default bg-bg-card overflow-hidden"
      data-testid="an-funnel-performance"
    >
      <div className="px-4 py-3 border-b border-border-default flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-text-primary">Funnel performance</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Click a row to scope the whole page to that funnel.
          </p>
        </div>
        {basisLabel ? (
          <span className="text-[10.5px] text-text-faint max-w-[420px] text-right">{basisLabel}</span>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        {loading && !list.length ? (
          <div className="text-xs text-text-muted py-10 text-center">Loading…</div>
        ) : !list.length ? (
          <div className="text-xs text-text-muted py-10 text-center" data-testid="an-funnel-performance-empty">
            No funnel took money in this window.
          </div>
        ) : (
          <table className="w-full min-w-[1480px] border-collapse" data-testid="an-funnel-performance-table">
            <thead>
              <tr className="border-b border-border-default">
                <TH>Funnel</TH>
                <TH right>Sessions</TH>
                <TH right>Orders</TH>
                <TH right title="Orders ÷ sessions">Conv</TH>
                <TH right title="Collected money including upsell and rebill legs">Gross</TH>
                <TH right title="Gross less refunds">Net</TH>
                <TH right title="Net sales ÷ orders">AOV</TH>
                <TH right title="Net sales ÷ sessions">$/session</TH>
                <TH right>Refunds</TH>
                <TH right>COGS</TH>
                <TH right>Fees</TH>
                <TH right title="Net sales − COGS − shipping − fees. Before ad spend.">GP</TH>
                <TH right>GP%</TH>
                <TH right title="Share of order legs in this window that carry a cost">Coverage</TH>
                <TH right>Spend</TH>
                <TH right title="GP − spend">Net profit</TH>
                <TH right title="Gross sales ÷ spend">ROAS</TH>
                <TH right title="Spend ÷ orders">CPA</TH>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => {
                const active = r.id !== null && String(r.id) === String(activeFunnelId || '');
                const spendUnknown = r.spend_known === false;
                return (
                  <tr
                    key={r.id ?? i}
                    onClick={() => onPickFunnel && r.id !== null && onPickFunnel(r)}
                    className={`border-b border-border-default/50 last:border-b-0 ${
                      onPickFunnel && r.id !== null ? 'cursor-pointer hover:bg-bg-elevated/40' : ''
                    } ${active ? 'bg-bg-elevated/60' : ''}`}
                    data-testid={`an-funnel-row-${r.id ?? i}`}
                  >
                    <TD className="max-w-[220px]">
                      <span className="font-medium text-text-primary truncate block" title={String(r.name)}>
                        {r.name}
                      </span>
                    </TD>
                    <TD right className="text-text-muted">
                      {present(r.sessions) ? fmtInt(r.sessions) : <Dash why={sessionWhy} />}
                    </TD>
                    <TD right className="text-text-muted">{fmtInt(r.orders)}</TD>
                    <TD right>
                      {present(r.conv_pct)
                        ? <span className="text-text-primary">{fmtPctPlain(r.conv_pct)}</span>
                        : <Dash why={WHY.conv} />}
                    </TD>
                    <TD right><Money v={r.gross_sales} /></TD>
                    <TD right><Money v={r.net_sales} /></TD>
                    <TD right><Money v={r.aov} why={WHY.aov} cls="text-text-muted" /></TD>
                    <TD right><Money v={r.rev_per_session} why={WHY.eps} cls="text-text-muted" /></TD>
                    <TD right><Money v={r.refunds} cls="text-text-muted" /></TD>
                    <TD right><Money v={r.cogs} why={WHY.cogs} cls="text-text-muted" /></TD>
                    <TD right><Money v={r.fees} why={WHY.fees} cls="text-text-muted" /></TD>
                    <TD right><Money v={r.gp} why={WHY.gp} /></TD>
                    <TD right>
                      {present(r.gp_pct)
                        ? <span className="text-text-primary">{fmtPctPlain(r.gp_pct, 1)}</span>
                        : <Dash why={WHY.gpPct} />}
                    </TD>
                    <TD right><CoverageCell row={r} /></TD>
                    <TD right>
                      {spendUnknown ? <Dash why={WHY.spend} /> : <Money v={r.spend} why={WHY.spend} cls="text-text-muted" />}
                    </TD>
                    <TD right><Money v={r.net_profit} why={spendUnknown ? WHY.spend : WHY.netProfit} /></TD>
                    <TD right>
                      {present(r.roas)
                        ? <span className="text-text-primary">{fmtX(r.roas)}</span>
                        : <Dash why={WHY.roas} />}
                    </TD>
                    <TD right><Money v={r.cpa} why={WHY.cpa} cls="text-text-muted" /></TD>
                  </tr>
                );
              })}
            </tbody>
            {t && (
              /* THE WINDOW TOTAL, NOT A SUM OF THE ROWS. The rows are a ranked
                 breakdown and may be truncated; these are the server's own
                 window-scoped KPIs. Adding the visible rows here would produce
                 a "total" that silently omits the tail. */
              <tfoot>
                <tr className="border-t border-border-default bg-bg-elevated/20">
                  <TD><span className="font-semibold text-text-primary">Window total</span></TD>
                  <TD right className="text-text-muted">
                    {present(t.sessions) ? fmtInt(t.sessions) : <Dash why={sessionWhy} />}
                  </TD>
                  <TD right className="text-text-muted">{fmtInt(t.orders)}</TD>
                  <TD right>
                    {present(t.conv_pct) ? <span className="text-text-primary">{fmtPctPlain(t.conv_pct)}</span> : <Dash why={WHY.conv} />}
                  </TD>
                  <TD right><Money v={t.gross_sales} /></TD>
                  <TD right><Money v={t.net_sales} /></TD>
                  <TD right><Money v={t.aov} why={WHY.aov} cls="text-text-muted" /></TD>
                  <TD right><Money v={t.rev_per_session} why={WHY.eps} cls="text-text-muted" /></TD>
                  <TD right><Money v={t.refunds} cls="text-text-muted" /></TD>
                  <TD right><Money v={t.cogs} why={WHY.cogs} cls="text-text-muted" /></TD>
                  <TD right><Money v={t.fees} why={WHY.fees} cls="text-text-muted" /></TD>
                  <TD right><Money v={t.gp} why={WHY.gp} /></TD>
                  <TD right>
                    {present(t.gp_pct) ? <span className="text-text-primary">{fmtPctPlain(t.gp_pct, 1)}</span> : <Dash why={WHY.gpPct} />}
                  </TD>
                  <TD right><CoverageCell row={t} /></TD>
                  <TD right>
                    {t.spend_known === false ? <Dash why={WHY.spend} /> : <Money v={t.spend} why={WHY.spend} cls="text-text-muted" />}
                  </TD>
                  <TD right><Money v={t.net_profit} why={WHY.netProfit} /></TD>
                  <TD right>
                    {present(t.roas) ? <span className="text-text-primary">{fmtX(t.roas)}</span> : <Dash why={WHY.roas} />}
                  </TD>
                  <TD right><Money v={t.cpa} why={WHY.cpa} cls="text-text-muted" /></TD>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* WHY THREE COLUMNS ARE DASHES. Without this the table reads as broken
          rather than as honest, and the one field that explains the dashes
          would be on the wire with no reader. */}
      {sessionsUnknown && !loading && list.length > 0 && (
        <p className="text-[10.5px] text-text-faint px-4 py-2 border-t border-border-default" data-testid="an-funnel-sessions-note">
          Sessions, Conv and $/session are “{EM_DASH}” because part of this window reaches past the
          90-day tracking retention — the visitor spine for those days no longer exists. Orders, Gross,
          Net and Refunds are measured.
        </p>
      )}
      {t && !loading && list.length > 0 && (
        <p className="text-[10.5px] text-text-faint px-4 pb-2.5">
          The total row is the server&apos;s window-scoped figure, not a sum of the rows above — the
          breakdown is ranked and may be truncated.
        </p>
      )}
    </section>
  );
}
