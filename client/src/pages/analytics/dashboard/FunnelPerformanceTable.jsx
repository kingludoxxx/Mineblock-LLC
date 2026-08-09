// FunnelPerformanceTable — the economics table this dashboard exists for
// (NEW FILE, LANE 3). Built FIRST, per the work order.
//
// Eighteen columns are DECLARED; every one of them is either the server's own
// figure, an em dash with a reason, or — when this build's payload carries the
// metric for nobody — a named absence under the table. NOTHING here is
// re-aggregated on the client and nothing is derived from a denominator the
// server withheld.
//
//   Funnel · Sessions · Orders · Conv · Gross · Net · AOV · $/session ·
//   Refunds · COGS · Fees · GP · GP% · Coverage · Spend · Net profit ·
//   ROAS · CPA
//
// ── THE THREE WITHHOLDINGS, and why each cell dashes rather than prints ─────
//
//   1. SESSIONS (and every rate over them). When the window crosses the 90-day
//      lb_touches retention the visitor spine is gone, so sessions are withheld
//      and Conv and $/session go with them. Coercing those to zero produces,
//      verbatim, "Sessions 0 · Orders 412 · Conv 0.00% · Gross $52,000" — an
//      argument to kill a funnel that is earning. Orders, Gross, Net and
//      Refunds keep printing: those are always measured, and a genuine 0 there
//      is a fact.
//
//   2. COSTS AND SPEND. GP, GP%, Net profit, ROAS and CPA are withheld at zero
//      cost coverage or unknown spend. A gross profit equal to net sales is the
//      100%-margin lie, and a ROAS against a spend nobody recorded is a ratio
//      over nothing. Coverage carries the missing-leg count so a partial figure
//      is never mistaken for a complete one.
//
//   3. NOT CARRIED BY THIS PAYLOAD — a different fact from either of the above,
//      and the one this table used to get wrong. Lane 1's funnel breakdown is
//      folded on three metrics (net_sales, orders, aov); the other fifteen
//      columns are not in the response AT ALL. Rendering them as fifteen
//      columns of em dashes says "we measured fifteen things about your funnels
//      and refuse to tell you", which is false and unreadable. A column no row
//      carries is COLLAPSED and named underneath, so the gap is visible, the
//      table stays legible, and the column reappears by itself the moment the
//      server starts folding it. `hasKey` is what separates this from case 1/2:
//      absent ≠ null.
//
// A FAILED LOAD IS NOT AN EMPTY WINDOW. "No funnel took money in this window"
// is a positive claim about the world; it is only ever printed after a request
// actually succeeded.
//
// Row click scopes the whole page to that funnel; clicking the active row zooms
// back out. A bucket that is not a funnel (the '(none)' catch-all) is not
// clickable — there is nothing to scope to.
import { AlertTriangle } from 'lucide-react';
import {
  EM_DASH, fmtInt, fmtMoney, fmtPctPlain, fmtX, present,
} from './dashFormat.js';
import { hasKey } from '../metricsApi.js';

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
function CoverageCell({ value, missingLegs, why }) {
  if (!present(value)) return <Dash why={why} />;
  const n = Number(value);
  const tone = n >= 100 ? 'bg-success' : n > 0 ? 'bg-warning' : 'bg-danger';
  const missing = present(missingLegs) ? Number(missingLegs) : null;
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

/* ── why a cell is blank ─────────────────────────────────────────────────── */

const WHY = {
  sessionsTtl:
    'Withheld — part of this window reaches past the 90-day tracking retention, '
    + 'so the visitor spine for it no longer exists.',
  sessions: 'Sessions were not measured for this funnel in this window.',
  conv: 'A conversion rate over an unmeasured session count is unknown, not 0%.',
  eps: 'Revenue per session needs a session count. It is unknown, not $0.00.',
  aov: 'AOV needs orders. With no orders there is no average — not $0.00.',
  money: 'Not reported for this funnel in this window.',
  cogs: 'No cost coverage — COGS is unknown for this window.',
  fees: 'Fees were not reported for this window.',
  gp: 'Withheld — cost coverage is incomplete. Gross profit equal to net sales would be a 100%-margin claim.',
  gpPct: 'Withheld — margin is unknown, not 100%.',
  coverage: 'Cost coverage was not reported for this funnel in this window.',
  spend: 'No spend recorded — bind a campaign or add manual spend.',
  netProfit: 'Withheld — net profit needs full costs AND known spend.',
  roas: 'Withheld — a return on a spend nobody recorded is a ratio over nothing.',
  cpa: 'Withheld — cost per acquisition needs known spend.',
};

/* ── the declared column set ─────────────────────────────────────────────── */

/**
 * ONE place that names the row vocabulary. `alt` is the SECOND SPELLING OF THE
 * SAME QUANTITY — never a different quantity, and never a fallback to zero.
 * (GP === net_after_cogs, GP% === margin_pct, $/session === rev_per_session ===
 * epc.) Presence is tested against the RAW row so an absent key and a null one
 * stay distinguishable.
 */
const COLUMNS = [
  { key: 'sessions', label: 'Sessions', kind: 'int', muted: true, why: WHY.sessions },
  { key: 'orders', label: 'Orders', kind: 'int', muted: true, why: WHY.money },
  { key: 'conv_pct', label: 'Conv', kind: 'pct2', why: WHY.conv, title: 'Orders ÷ sessions' },
  { key: 'gross_sales', label: 'Gross', kind: 'money', why: WHY.money, title: 'Collected money including upsell and rebill legs' },
  { key: 'net_sales', label: 'Net', kind: 'money', why: WHY.money, title: 'Gross less refunds' },
  { key: 'aov', label: 'AOV', kind: 'money', muted: true, why: WHY.aov, title: 'Net sales ÷ orders' },
  { key: 'rev_per_session', alt: 'epc', label: '$/session', kind: 'money', muted: true, why: WHY.eps, title: 'Net sales ÷ sessions' },
  { key: 'refunds', label: 'Refunds', kind: 'money', muted: true, why: WHY.money },
  { key: 'cogs', label: 'COGS', kind: 'money', muted: true, why: WHY.cogs },
  { key: 'fees', label: 'Fees', kind: 'money', muted: true, why: WHY.fees },
  { key: 'gp', alt: 'net_after_cogs', label: 'GP', kind: 'money', why: WHY.gp, title: 'Net sales − COGS − shipping − fees. Before ad spend.' },
  { key: 'gp_pct', alt: 'margin_pct', label: 'GP%', kind: 'pct1', why: WHY.gpPct },
  { key: 'cost_coverage_pct', label: 'Coverage', kind: 'coverage', why: WHY.coverage, title: 'Share of order legs in this window that carry a cost' },
  { key: 'spend', label: 'Spend', kind: 'money', muted: true, why: WHY.spend },
  { key: 'net_profit', label: 'Net profit', kind: 'money', why: WHY.netProfit, title: 'GP − spend' },
  { key: 'roas', label: 'ROAS', kind: 'x', why: WHY.roas, title: 'Gross sales ÷ spend' },
  { key: 'cpa', label: 'CPA', kind: 'money', muted: true, why: WHY.cpa, title: 'Spend ÷ orders' },
];

/** Does this row carry the column's metric AT ALL (under either spelling)? */
const carries = (row, col) => hasKey(row, col.key) || (!!col.alt && hasKey(row, col.alt));

/** The value, under whichever spelling the row used. Null when withheld. */
const valueOf = (row, col) => {
  if (!row) return null;
  if (hasKey(row, col.key) && present(row[col.key])) return row[col.key];
  if (col.alt && hasKey(row, col.alt) && present(row[col.alt])) return row[col.alt];
  return null;
};

/** The catch-all bucket key Lane 1 uses for rows that belong to no funnel. */
const NON_FUNNEL_KEYS = new Set(['(none)', 'none', '', 'null', 'undefined']);
const isScopable = (id) => !!id && !NON_FUNNEL_KEYS.has(String(id).trim().toLowerCase());

const rowId = (r) => r.key ?? r.id ?? r.funnel_id ?? null;
const rowName = (r) => r.name ?? r.label ?? rowId(r) ?? EM_DASH;

/* ── the table ───────────────────────────────────────────────────────────── */

export default function FunnelPerformanceTable({
  rows,
  totals,
  basisLabel,
  metricLabel,
  state,
  reason,
  sessionsUnknown,
  activeFunnelId,
  onPickFunnel,
}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];

  // PRESENCE IS DECIDED BY THE ROWS, not by the totals. The totals block is the
  // window-wide KPI set and carries far more metrics than the per-funnel fold —
  // letting it vote would resurrect fifteen columns of dashes that no row can
  // ever fill.
  const shown = COLUMNS.filter((c) => list.some((r) => carries(r, c)));
  const hidden = COLUMNS.filter((c) => !shown.includes(c));

  // A dash in the sessions column has two different reasons and the note has to
  // name the right one: the TTL breach is a property of the WINDOW, a per-funnel
  // null is a property of that row.
  const whyFor = (col) => (col.key === 'sessions' && sessionsUnknown ? WHY.sessionsTtl : col.why);

  const cell = (row, col) => {
    const v = valueOf(row, col);
    const why = whyFor(col);
    const cls = col.muted ? 'text-text-muted' : 'text-text-primary';
    switch (col.kind) {
      case 'int':
        return present(v) ? <span className={cls}>{fmtInt(v)}</span> : <Dash why={why} />;
      case 'pct2':
        return present(v) ? <span className="text-text-primary">{fmtPctPlain(v)}</span> : <Dash why={why} />;
      case 'pct1':
        return present(v) ? <span className="text-text-primary">{fmtPctPlain(v, 1)}</span> : <Dash why={why} />;
      case 'x':
        return present(v) ? <span className="text-text-primary">{fmtX(v)}</span> : <Dash why={why} />;
      case 'coverage':
        return <CoverageCell value={v} missingLegs={valueOf(row, { key: 'missing_legs' })} why={why} />;
      default: {
        // `spend_known:false` is the server SAYING it does not know, which is a
        // stronger statement than a null and gets the spend-specific reason.
        const unknownSpend = col.key === 'spend' && row && row.spend_known === false;
        return <Money v={unknownSpend ? null : v} why={why} cls={col.muted ? 'text-text-muted' : 'text-text-primary'} />;
      }
    }
  };

  const body = () => {
    if (state === 'loading' && !list.length) {
      return <div className="text-xs text-text-muted py-10 text-center">Loading…</div>;
    }
    if (state === 'failed' && !list.length) {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 py-10 text-center"
          data-testid="an-funnel-performance-failed"
          role="status"
        >
          <AlertTriangle className="w-4 h-4 text-warning" />
          <p className="text-xs text-warning/90">Couldn&apos;t load funnel performance</p>
          {reason ? <p className="text-[10.5px] text-text-faint max-w-[420px]">{reason}</p> : null}
          <p className="text-[10.5px] text-text-faint max-w-[420px]">
            This is NOT &ldquo;no funnel took money&rdquo; — the request did not come back, so nothing
            is known about this window either way.
          </p>
        </div>
      );
    }
    if (!list.length) {
      return (
        <div className="text-xs text-text-muted py-10 text-center" data-testid="an-funnel-performance-empty">
          No funnel took money in this window.
        </div>
      );
    }
    return (
      <table className="w-full text-[11px] border-collapse" data-testid="an-funnel-performance-table">
        <thead>
          <tr className="border-b border-border-default">
            <TH>Funnel</TH>
            {shown.map((c) => <TH key={c.key} right title={c.title}>{c.label}</TH>)}
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => {
            const id = rowId(r);
            const scopable = isScopable(id);
            const active = scopable && String(id) === String(activeFunnelId || '');
            const name = rowName(r);
            const isRawId = String(name) === String(id);
            return (
              <tr
                key={id ?? i}
                onClick={scopable && onPickFunnel ? () => onPickFunnel(r) : undefined}
                className={`border-b border-border-default/50 last:border-b-0 ${
                  scopable && onPickFunnel ? 'cursor-pointer hover:bg-bg-elevated/40' : ''
                } ${active ? 'bg-bg-elevated/60' : ''}`}
                data-testid={`an-funnel-row-${id ?? i}`}
              >
                <TD className="max-w-[240px]">
                  <span
                    className="font-medium text-text-primary truncate block"
                    title={isRawId
                      ? `Funnel id ${id} — this payload does not carry a display name for it`
                      : String(name)}
                  >
                    {name}
                  </span>
                </TD>
                {shown.map((c) => <TD key={c.key} right>{cell(r, c)}</TD>)}
              </tr>
            );
          })}
        </tbody>
        {totals && (
          /* THE WINDOW TOTAL, NOT A SUM OF THE ROWS. The rows are a ranked
             breakdown and may be truncated; these are the server's own
             window-scoped KPIs. Adding the visible rows here would produce a
             "total" that silently omits the tail. */
          <tfoot>
            <tr className="border-t border-border-default bg-bg-elevated/20">
              <TD><span className="font-semibold text-text-primary">Window total</span></TD>
              {shown.map((c) => <TD key={c.key} right>{cell(totals, c)}</TD>)}
            </tr>
          </tfoot>
        )}
      </table>
    );
  };

  const settled = state !== 'loading' && state !== 'failed';

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
        {(metricLabel || basisLabel) ? (
          <span className="text-[10.5px] text-text-faint max-w-[460px] text-right" data-testid="an-funnel-performance-basis">
            {[metricLabel, basisLabel].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto">{body()}</div>

      {/* WHY THREE COLUMNS ARE DASHES. Without this the table reads as broken
          rather than as honest, and the one field that explains the dashes
          would be on the wire with no reader. */}
      {sessionsUnknown && settled && list.length > 0 && shown.some((c) => c.key === 'sessions') && (
        <p className="text-[10.5px] text-text-faint px-4 py-2 border-t border-border-default" data-testid="an-funnel-sessions-note">
          Sessions, Conv and $/session are “{EM_DASH}” because part of this window reaches past the
          90-day tracking retention — the visitor spine for those days no longer exists. Orders, Gross,
          Net and Refunds are measured.
        </p>
      )}

      {/* A COLUMN NOBODY CARRIES IS NAMED, NOT SILENTLY DROPPED. */}
      {settled && list.length > 0 && hidden.length > 0 && (
        <p className="text-[10.5px] text-text-faint px-4 py-2 border-t border-border-default" data-testid="an-funnel-absent-note">
          Not carried per funnel by this build&apos;s dashboard payload, so the column is not drawn:{' '}
          <span className="text-text-muted">{hidden.map((c) => c.label).join(' · ')}</span>. This is an
          absence in the response, not a withheld measurement — the columns return on their own once the
          breakdown folds them.
        </p>
      )}

      {totals && settled && list.length > 0 && (
        <p className="text-[10.5px] text-text-faint px-4 pb-2.5 pt-2">
          The total row is the server&apos;s window-scoped figure, not a sum of the rows above — the
          breakdown is ranked and may be truncated.
        </p>
      )}
    </section>
  );
}
