// CohortCard — new-customer cohorts, their LTV and their repeat retention
// (NEW FILE, LANE 5).
//
// This card is also where the ORPHANED `pages/performance/LTV.jsx` went. That
// page was built but never routed, and every figure on it was a hardcoded
// literal — `{'2025-Q4': {avg: 312, d30: 48, d60: 89, d90: 142}}` — with a
// retention grid of invented percentages and a chart that was a dashed
// placeholder box. Wiring it to a route would have shipped a screen of numbers
// that look exactly like measurements and are not, on the workspace whose one
// rule is that a number we did not measure is an em dash. So its VIEW was kept
// (metric tiles + a retention grid + an LTV table) and its DATA was replaced
// with the real cohort fold. See ../../performance/LTV.jsx, which is now a thin
// re-export onto the real surface. DECISION recorded in that file's header.
//
// ── THE TWO CELL STATES THAT LOOK THE SAME AND ARE NOT ──────────────────────
//
//   null in `ltv[i]`  → THE AGING GUARD. The cohort has not lived long enough
//                       to reach that horizon. It is drawn as an em dash with
//                       "not aged yet" on the title, and it must NEVER become
//                       $0.00 — "$0.00 at D90" reads as "these customers came
//                       back with nothing", which is a claim about customers
//                       nobody has observed.
//   0 in `ltv[i]`     → a MEASURED zero. Those buyers were observed to that
//                       horizon and spent nothing more. That is real and prints.
//
// The `aged[]` column is drawn beside them precisely so the difference is
// visible: a D30 cell over 0 aged buyers cannot be a measurement, and a D30
// cell over 40 of 200 says the average describes a fifth of the cohort.
//
// ── WHAT THE HEAT COLOURING IS AND IS NOT ───────────────────────────────────
// Retention cells are shaded by their own value against the WIDEST measured
// cell in the table — a relative scale, computed from the data, with no
// threshold invented anywhere. An un-aged cell gets NO colour at all, because
// colouring an absence is the fastest way to make it look like a low number.
import { useMemo } from 'react';
import { Download } from 'lucide-react';
import { Card } from './cardKit.jsx';
import { cohortsOf } from '../insightsApi.js';
import { GROUP_BY_LABELS } from './insightShapes.js';
import {
  EM_DASH, fmtInt, fmtMoney, fmtPctPlain, present,
} from './dashFormat.js';

/** A retention cell's tint — relative to the table, never to a target. */
function retentionTint(value, max) {
  if (value === null || max === null || max <= 0) return '';
  const share = Math.max(0, Math.min(1, value / max));
  if (share >= 0.75) return 'bg-success/15 text-success';
  if (share >= 0.5) return 'bg-accent/15 text-accent-text';
  if (share >= 0.25) return 'bg-warning/12 text-warning';
  return 'bg-danger/10 text-danger';
}

export default function CohortCard({
  cohorts, state, error, groupBy = 'day', onGroupByChange, csvUrl,
  limit = 8, testid = 'an-card-cohorts',
}) {
  const c = useMemo(() => cohortsOf(cohorts), [cohorts]);
  const horizons = c.horizons.length ? c.horizons : [0, 7, 30, 90];
  const rows = c.rows.slice(0, Math.max(1, limit));

  // The colour scale's anchor: the widest MEASURED retention cell anywhere in
  // the table, un-aged cells excluded (they are not small, they are absent).
  const maxRetention = useMemo(() => {
    let m = null;
    for (const r of c.rows) {
      for (const v of r.retention) {
        if (v !== null && (m === null || v > m)) m = v;
      }
    }
    return m;
  }, [c.rows]);

  const action = (
    <div className="flex items-center gap-1 shrink-0">
      {onGroupByChange && (
        <select
          value={groupBy}
          onChange={(e) => onGroupByChange(e.target.value)}
          className="text-[10px] bg-bg-elevated border border-border-default rounded px-1.5 py-0.5 text-text-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Group cohorts by"
          data-testid={`${testid}-group-by`}
        >
          {Object.entries(GROUP_BY_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      )}
      {csvUrl && (
        <a
          href={csvUrl}
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border-default text-text-faint hover:text-text-muted"
          data-testid={`${testid}-csv`}
          /* A download, not a navigation — the server sets the filename and the
             attachment header, so this link must not open in the SPA router. */
          download
        >
          <Download className="w-3 h-3" aria-hidden="true" />
          CSV
        </a>
      )}
    </div>
  );

  const body = () => {
    if (state === 'loading') {
      return (
        <div className="space-y-2 min-h-[160px]" data-testid="an-card-skeleton" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 rounded bg-bg-elevated animate-pulse" style={{ width: `${94 - i * 8}%` }} />
          ))}
        </div>
      );
    }
    if (state === 'failed') {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[160px]"
          data-testid="an-card-failed"
          role="status"
        >
          <p className="text-xs text-warning/90">Couldn&apos;t load this card</p>
          {error ? <p className="text-[10.5px] text-text-faint max-w-[300px]">{String(error)}</p> : null}
          <p className="text-[10.5px] text-text-faint max-w-[300px]">
            This is not a period with no new customers — nothing is known about it either way.
          </p>
        </div>
      );
    }
    if (!c.sent) {
      return (
        <div className="flex items-center justify-center min-h-[160px] px-3 text-center" data-testid={`${testid}-absent`}>
          <p className="text-[11px] text-text-faint max-w-[320px] leading-relaxed">
            No cohort table was returned for this window.
          </p>
        </div>
      );
    }
    if (!c.rows.length) {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[160px]"
          data-testid="an-card-empty"
        >
          <p className="text-xs text-text-muted">No new customers were acquired in this date range</p>
          <p className="text-[10.5px] text-text-faint max-w-[340px] leading-relaxed">
            A cohort is a buyer whose FIRST EVER paid order falls inside the window. Repeat buyers
            are not acquisitions, and orders with no email cannot be tied to a person at all.
          </p>
        </div>
      );
    }
    return (
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-[11px]" data-testid={`${testid}-table`}>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-text-muted border-b border-border-default">
              <th className="font-medium py-1.5 text-left pr-2">{GROUP_BY_LABELS[c.groupBy] || 'Cohort'}</th>
              <th className="font-medium py-1.5 text-right pl-2">Buyers</th>
              {horizons.map((h) => (
                <th key={`l${h}`} className="font-medium py-1.5 text-right pl-2" title={`Cumulative revenue per buyer through day ${h}`}>
                  {`LTV D${h}`}
                </th>
              ))}
              {horizons.filter((h) => h > 0).map((h) => (
                <th key={`r${h}`} className="font-medium py-1.5 text-right pl-2" title={`Share of the cohort that bought again by day ${h}`}>
                  {`Rep D${h}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="h-8 border-b border-border-default/50 last:border-b-0"
                data-testid={`${testid}-row-${r.key}`}
              >
                <td className="text-left pr-2 truncate max-w-[180px]" title={r.label}>{r.label}</td>
                <td className="text-right tabular-nums pl-2">{present(r.size) ? fmtInt(r.size) : EM_DASH}</td>
                {horizons.map((h, i) => {
                  const v = r.ltv[i] === undefined ? null : r.ltv[i];
                  const aged = r.aged[i] === undefined ? null : r.aged[i];
                  const unaged = v === null;
                  return (
                    <td
                      key={`l${h}`}
                      className={`text-right tabular-nums pl-2 ${unaged ? 'text-text-faint' : ''}`}
                      title={unaged
                        ? `Not aged yet — this cohort has not lived ${h} days, so there is nothing to measure. This is not $0.00.`
                        : `${fmtInt(aged ?? 0)} buyer(s) old enough to be measured at D${h}.`}
                      data-testid={`${testid}-ltv-${r.key}-${h}`}
                    >
                      {unaged ? EM_DASH : fmtMoney(v)}
                    </td>
                  );
                })}
                {horizons.map((h, i) => {
                  if (h === 0) return null;
                  const v = r.retention[i] === undefined ? null : r.retention[i];
                  const unaged = v === null;
                  return (
                    <td key={`r${h}`} className="text-right tabular-nums pl-2" data-testid={`${testid}-ret-${r.key}-${h}`}>
                      <span
                        className={`inline-block px-1 rounded ${unaged ? 'text-text-faint' : retentionTint(v, maxRetention)}`}
                        title={unaged
                          ? `Not aged yet — nobody in this cohort has had ${h} days to come back.`
                          : `Share of the aged buyers who placed a later order within ${h} days.`}
                      >
                        {unaged ? EM_DASH : fmtPctPlain(v, 1)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {/* THE WEIGHTED AVERAGE, on its own rule. It is weighted over the
                AGED buyers AT EACH HORIZON — a different population per column,
                which is the only way the D90 average is not dragged toward zero
                by cohorts that cannot have a D90 yet. */}
            {c.average && (
              <tr className="border-t border-border-default font-semibold" data-testid={`${testid}-average`}>
                <td className="text-left pr-2 py-1.5">Weighted average</td>
                <td className="text-right tabular-nums pl-2">
                  {present(c.totals && c.totals.buyers) ? fmtInt(c.totals.buyers) : EM_DASH}
                </td>
                {horizons.map((h, i) => {
                  const v = c.average.ltv[i] === undefined ? null : c.average.ltv[i];
                  const aged = c.average.aged[i] === undefined ? null : c.average.aged[i];
                  return (
                    <td
                      key={`al${h}`}
                      className={`text-right tabular-nums pl-2 ${v === null ? 'text-text-faint font-normal' : ''}`}
                      title={v === null
                        ? `No cohort in this table has reached D${h} yet.`
                        : `Weighted over ${fmtInt(aged ?? 0)} buyer(s) old enough to be measured at D${h}.`}
                    >
                      {v === null ? EM_DASH : fmtMoney(v)}
                    </td>
                  );
                })}
                {horizons.map((h, i) => {
                  if (h === 0) return null;
                  const v = c.average.retention[i] === undefined ? null : c.average.retention[i];
                  return (
                    <td key={`ar${h}`} className={`text-right tabular-nums pl-2 ${v === null ? 'text-text-faint font-normal' : ''}`}>
                      {v === null ? EM_DASH : fmtPctPlain(v, 1)}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
        {c.rows.length > rows.length && (
          <p className="text-[10.5px] text-text-faint mt-1.5">
            {`+${c.rows.length - rows.length} more cohorts — the CSV carries every one of them.`}
          </p>
        )}
      </div>
    );
  };

  const truncated = c.totals && c.totals.truncated === true;

  return (
    <Card
      title="Customer cohorts & LTV"
      sub={c.range && c.range.start
        ? `New buyers acquired ${c.range.start} → ${c.range.end}`
        : 'New buyers by acquisition'}
      action={action}
      notice={truncated
        ? 'This window acquired more new buyers than one request folds, so the table below is built '
          + 'from a subset and is NOT a complete cohort average. Narrow the window.'
        : undefined}
      testid={testid}
      footer={(
        <div className="mt-2 pt-2 border-t border-border-default space-y-1">
          <p className="text-[10.5px] text-text-faint leading-relaxed">
            {c.basis ? `${c.basis[0].toUpperCase()}${c.basis.slice(1)}. ` : ''}
            {c.identity ? `Identity: ${c.identity}. ` : ''}
            A blank cell is the AGING GUARD — the cohort has not lived long enough to reach that
            horizon, so there is nothing to report. It is never $0.00, which would read as
            &ldquo;they came back and spent nothing&rdquo;.
          </p>
          {c.warnings.length > 0 && (
            <ul className="space-y-0.5" data-testid={`${testid}-warnings`}>
              {c.warnings.map((w, i) => (
                <li key={i} className="text-[10.5px] text-warning/85 leading-snug">
                  <span className="font-medium">{w.source ? `${w.source}: ` : ''}</span>
                  {w.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    >
      {body()}
    </Card>
  );
}
