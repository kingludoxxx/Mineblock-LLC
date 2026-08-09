/**
 * ResultTables — the four data-rendering surfaces, in their own module so they
 * can be RENDERED IN ISOLATION by the harness with fixtures shaped from the
 * real Lane 1 / Lane 2 response builders.
 *
 * They used to live inside index.jsx, where nothing could reach them without a
 * live network: the SSR check rendered the controls, never a row, and every
 * defect in this region shipped green. Extracting them is the fix that makes
 * the rest of the fixes checkable.
 *
 * Field names come from the shipped services:
 *   Lane 1 funnelMetrics.js@3e42a8e   rows[{key,label,...metrics}], totals{...}
 *   Lane 2 funnelAttribution.js@fd52aac
 *     roas rows[{key,label,clicks,bot_clicks,conversions,revenue,cost,
 *                cost_known,cost_source,cost_unknown_reason,cost_note,cpa,roas}]
 *     clicks rows[{id,time,day,network,click_id,campaign,country,device,cpc,
 *                  converted,bot,velocity_flag}]
 */
import { EM_DASH, fmtInt, fmtMoney } from '../format';
import { fmtMultiple, formatInstant, formatterFor, labelFor, zoneLabel } from '../reportConfig';

/* ── shared cells ──────────────────────────────────────────────────────── */

export const TH = ({ children, right }) => (
  <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-faint whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
    {children}
  </th>
);

export const TD = ({ children, right, className = '', title }) => (
  <td
    title={title}
    className={`px-3 py-2 text-xs whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${className}`}
  >
    {children}
  </td>
);

/** The basis the SERVER named. Never a client-side guess — see reportConfig. */
export function BasisFootnote({ basisLabel, extra }) {
  if (!basisLabel && !extra) return null;
  return (
    <p className="mt-2 text-[10px] text-text-faint" data-testid="ax-basis">
      {[basisLabel, extra].filter(Boolean).join(' · ')}
    </p>
  );
}

/* ── query mode ────────────────────────────────────────────────────────── */

/**
 * A delta needs a REAL baseline. A missing previous value, a previous of zero
 * and a non-numeric current all mean "no percentage exists" — printing 0% or
 * +100% there would be a fabricated fact, so the tile says "no baseline".
 */
function deltaPct(cur, prev) {
  if (typeof prev !== 'number' || !Number.isFinite(prev) || prev === 0) return null;
  if (typeof cur !== 'number' || !Number.isFinite(cur)) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function BigNumbers({ metrics, totals, prevTotals, hasPrevious, compare }) {
  const cur = totals || {};
  const prev = prevTotals || {};
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" data-testid="ax-bignumbers">
      {(metrics || []).map((m) => {
        const fmt = formatterFor(m);
        const delta = compare && hasPrevious ? deltaPct(cur[m], prev[m]) : null;
        return (
          <div key={m} className="rounded-xl border border-border-default bg-bg-card p-4" data-testid={`ax-big-${m}`}>
            <p className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">{labelFor(m)}</p>
            <p className="text-2xl font-medium tracking-tight mt-1 text-text-primary tabular-nums">{fmt(cur[m])}</p>
            {compare && (
              delta === null ? (
                <p className="text-[10px] text-text-faint mt-0.5">no baseline</p>
              ) : (
                <p className={`text-xs mt-0.5 tabular-nums ${delta >= 0 ? 'text-emerald-400' : 'text-danger'}`}>
                  {`${delta >= 0 ? '↗' : '↘'} ${Math.abs(delta).toFixed(1)}% vs previous`}
                </p>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The breakdown / series table.
 *
 * TOP-N HONESTY: the engine ranks and CUTS breakdown rows at `limit` and does
 * not publish the pre-cut row count on /query, so the footer says what is
 * actually knowable — "the top {limit}, ranked by {metric}; the window may hold
 * more" — instead of a "Top N of M" whose M would have to be invented.
 */
export function QueryTable({ rows, metrics, headLabel, totals, basisLabel, limit, grouped }) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(metrics) ? metrics : [];
  const hasTotals = totals && Object.keys(totals).length > 0;
  const cut = grouped && limit > 0 && list.length >= limit;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-table">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <TH>{headLabel}</TH>
              {cols.map((m) => <TH key={m} right>{labelFor(m)}</TH>)}
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.key ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-row-${i}`}>
                <TD className="font-medium text-text-primary max-w-[280px] truncate">
                  {r.label ?? r.key ?? EM_DASH}
                </TD>
                {cols.map((m) => (
                  <TD key={m} right className="text-text-primary">{formatterFor(m)(r[m])}</TD>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot>
              <tr className="border-t border-border-default">
                <TD className="font-semibold text-text-primary">Total</TD>
                {cols.map((m) => (
                  <TD key={m} right className="font-semibold text-text-primary">{formatterFor(m)(totals[m])}</TD>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <BasisFootnote
        basisLabel={basisLabel}
        extra={cut ? `top ${limit} by ${labelFor(cols[0])} — the window may hold more rows` : ''}
      />
    </div>
  );
}

/* ── roas mode ─────────────────────────────────────────────────────────── */

/** Why a cost is unknown, in a sentence. The code alone tells nobody anything. */
const COST_UNKNOWN_SENTENCES = {
  no_signal: 'no platform spend, no pin and no click cost for this group',
  api_by_campaign_only: 'platform spend is campaign-granular and this group is finer — it is not divisible',
  pin_ambiguous: 'more than one manual pin matches this group; splitting it would be a guess',
  zero_cost: 'the cost resolved to zero, which is not a measurement',
};

const costTitle = (r) => [
  r.cost_source ? `source: ${r.cost_source}` : '',
  r.cost_unknown_reason ? (COST_UNKNOWN_SENTENCES[r.cost_unknown_reason] || r.cost_unknown_reason) : '',
  r.cost_note || '',
].filter(Boolean).join(' · ');

function ClicksCell({ clicks, bots }) {
  return (
    <>
      {fmtInt(clicks)}
      {bots > 0 && (
        <span className="ml-1.5 text-[10px] text-text-faint" title="bot clicks — counted in Clicks, excluded from Conversions">
          {`${fmtInt(bots)} bot`}
        </span>
      )}
    </>
  );
}

export function RoasTable({ result, dimension }) {
  const rows = (result && result.rows) || [];
  const totals = (result && result.totals) || null;
  const rowsTotal = result && typeof result.rowsTotal === 'number' ? result.rowsTotal : rows.length;
  const dim = (result && result.dimension) || dimension || 'network';
  const totalRevenue = totals ? fmtMoney(totals.revenue) : EM_DASH;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-roas-table">
      <p className="text-sm font-semibold text-text-primary mb-2">{`ROAS by ${dim}`}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <TH>{dim}</TH>
              <TH right>Clicks</TH>
              <TH right>Conversions</TH>
              <TH right>Revenue</TH>
              <TH right>Cost</TH>
              <TH right>CPA</TH>
              <TH right>ROAS</TH>
              <TH right>Cost source</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-roas-row-${i}`}>
                <TD className="font-medium text-text-primary max-w-[260px] truncate">{r.label || r.key || '(none)'}</TD>
                <TD right className="text-text-primary"><ClicksCell clicks={r.clicks} bots={r.bot_clicks} /></TD>
                <TD right className="text-text-primary">{fmtInt(r.conversions)}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.revenue)}</TD>
                <TD right className="text-text-primary" title={costTitle(r)}>{fmtMoney(r.cost)}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.cpa)}</TD>
                <TD right className="text-text-primary">{fmtMultiple(r.roas)}</TD>
                {/* cost_source is a FIELD: an unknown cost is WHY the two
                    columns to its left are dashes, and the reason belongs on
                    screen rather than in a support conversation. */}
                <TD right className="text-text-muted" title={costTitle(r)}>
                  {r.cost_source || EM_DASH}
                  {r.cost_unknown_reason && (
                    <span className="ml-1.5 rounded-full bg-bg-elevated border border-border-default px-1.5 py-0.5 text-[10px]">
                      {r.cost_unknown_reason}
                    </span>
                  )}
                </TD>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t border-border-default">
                <TD className="font-semibold text-text-primary">Total</TD>
                <TD right className="font-semibold text-text-primary"><ClicksCell clicks={totals.clicks} bots={totals.bot_clicks} /></TD>
                <TD right className="font-semibold text-text-primary">{fmtInt(totals.conversions)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMoney(totals.revenue)}</TD>
                <TD right className="font-semibold text-text-primary" title={costTitle(totals)}>{fmtMoney(totals.cost)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMoney(totals.cpa)}</TD>
                <TD right className="font-semibold text-text-primary">{fmtMultiple(totals.roas)}</TD>
                <TD right className="text-text-muted">{totals.cost_source || EM_DASH}</TD>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {/* The footer folds EVERY bucket (Lane 2 dedupes across groups), so it is
          a real "of M" rather than a sum of what fitted on screen. */}
      <BasisFootnote
        basisLabel={result && result.basisLabel}
        extra={`Top ${rows.length} of ${fmtInt(rowsTotal)} · ${totalRevenue}${result && result.rowCap ? ' · list truncated' : ''}`}
      />
    </div>
  );
}

/* ── clicks mode ───────────────────────────────────────────────────────── */

export function ClicksTable({ result, timezone }) {
  const rows = (result && result.rows) || [];
  const byNetwork = (result && result.byNetwork) || {};
  const tz = (result && result.timezone) || timezone;
  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-4" data-testid="ax-clicks-table">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <p className="text-sm font-semibold text-text-primary">Click ledger</p>
        {Object.entries(byNetwork).map(([net, stat]) => (
          <span
            key={net}
            className="rounded-full bg-bg-elevated border border-border-default px-2 py-0.5 text-[10px] text-text-muted tabular-nums"
            title="folded from the rows on this page, not a window total"
          >
            {`${net}: ${fmtInt(stat.clicks)} clicks · ${fmtInt(stat.converted)} conv${stat.bots ? ` · ${fmtInt(stat.bots)} bot` : ''}`}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-border-subtle">
              {/* The zone the SERVER keyed these rows in, named the same way
                  the page header names it. */}
              <TH>{`Time${tz ? ` (${zoneLabel(tz)})` : ''}`}</TH>
              <TH>Network</TH>
              <TH>Click ID</TH>
              <TH>Campaign</TH>
              <TH right>Country</TH>
              <TH right>Device</TH>
              <TH right>CPC</TH>
              <TH right>Flags</TH>
              <TH right>Converted</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i} className="border-b border-border-subtle last:border-b-0" data-testid={`ax-click-row-${i}`}>
                {/* `time` is the instant; `day` is the REPORT-ZONE calendar day
                    the click is reported on. Falling back to `day` keeps the
                    column populated rather than dashing out a real row. */}
                <TD className="text-text-primary tabular-nums">
                  {r.time ? formatInstant(r.time, tz) : (r.day || EM_DASH)}
                </TD>
                <TD className="text-text-primary">{r.network || EM_DASH}</TD>
                <TD className="text-text-muted max-w-[180px] truncate" title={r.click_id}>{r.click_id || EM_DASH}</TD>
                <TD className="text-text-primary max-w-[160px] truncate">{r.campaign || EM_DASH}</TD>
                <TD right className="text-text-primary">{r.country || EM_DASH}</TD>
                <TD right className="text-text-primary">{r.device || EM_DASH}</TD>
                <TD right className="text-text-primary">{fmtMoney(r.cpc)}</TD>
                <TD right>
                  {r.bot && (
                    <span className="rounded-full bg-bg-elevated border border-border-default px-1.5 py-0.5 text-[10px] text-text-muted"
                      title="excluded from conversions and from every ROAS row">bot</span>
                  )}
                  {r.velocity_flag && (
                    <span className="ml-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300"
                      title="velocity heuristic tripped on this click">velocity</span>
                  )}
                  {!r.bot && !r.velocity_flag && <span className="text-text-faint text-[10px]">{EM_DASH}</span>}
                </TD>
                <TD right>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${r.converted ? 'bg-emerald-500/10 text-emerald-400' : 'bg-bg-elevated text-text-muted'}`}>
                    {r.converted ? 'yes' : 'no'}
                  </span>
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result && result.truncated && (
        <p className="mt-2 text-[10px] text-text-faint" data-testid="ax-clicks-truncated">
          {`Newest ${fmtInt(result.limit || rows.length)} clicks only — the ledger holds more.`}
        </p>
      )}
    </div>
  );
}
