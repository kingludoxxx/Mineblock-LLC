// MoversCard — the funnels that moved most against the comparison window
// (NEW FILE, LANE 5).
//
// Reads `data.movers` out of the composite the page ALREADY fetches. The metrics
// engine has been shipping this block since Lane 1 and nothing was drawing it.
// No new request.
//
// ── THE RULE THIS CARD EXISTS TO MAKE VISIBLE ───────────────────────────────
//
// The server refuses to rank a funnel with NO measured previous value:
// "a funnel with no previous window has an UNKNOWN change, not a 0% one, and it
// must not be ranked against funnels whose change is measured"
// (funnelMetrics.moversFrom). So the list can be SHORTER than the funnel count,
// or empty on a window where nothing has a baseline — and this card says that
// out loud instead of letting a short list read as "only two funnels moved".
//
// ── DELTA vs DELTA_PCT ──────────────────────────────────────────────────────
// Both are the server's. The MONEY is the headline because it is what the
// operator acts on; the percentage is context and is omitted entirely when the
// server withheld it (a percentage over a zero baseline is not a small number,
// it is no number).
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Card } from './cardKit.jsx';
import { moversOf } from './insightShapes.js';
import {
  EM_DASH, fmtMoney, fmtPctPlain, present,
} from './dashFormat.js';

export default function MoversCard({
  data, window: win, state, reason, onPickFunnel, testid = 'an-card-movers',
}) {
  const mv = moversOf(data);
  const rows = mv.rows;
  const compare = win && win.prev_start && win.prev_end
    ? `vs ${win.prev_start} → ${win.prev_end}`
    : 'vs the previous period';

  const body = () => {
    if (state === 'loading') {
      return (
        <div className="space-y-2 min-h-[120px]" data-testid="an-card-skeleton" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-6 rounded bg-bg-elevated animate-pulse" style={{ width: `${92 - i * 12}%` }} />
          ))}
        </div>
      );
    }
    if (state === 'failed') {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[120px]"
          data-testid="an-card-failed"
          role="status"
        >
          <p className="text-xs text-warning/90">Couldn&apos;t load this card</p>
          {reason ? <p className="text-[10.5px] text-text-faint max-w-[280px]">{String(reason)}</p> : null}
          <p className="text-[10.5px] text-text-faint max-w-[280px]">
            This is not a period in which nothing moved — nothing is known about it either way.
          </p>
        </div>
      );
    }
    if (!mv.sent) {
      // The key was never on the payload. That is "this build did not report
      // it", which is a different sentence from "nothing moved".
      return (
        <div className="flex items-center justify-center min-h-[120px] px-3 text-center" data-testid={`${testid}-absent`}>
          <p className="text-[11px] text-text-faint max-w-[300px] leading-relaxed">
            This response did not carry a movers block, so there is nothing to rank. That is an
            absence in the response, not a period in which no funnel moved.
          </p>
        </div>
      );
    }
    if (!rows.length) {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[120px]"
          data-testid="an-card-empty"
        >
          <p className="text-xs text-text-muted">No funnel has a measured change</p>
          <p className="text-[10.5px] text-text-faint max-w-[320px] leading-relaxed">
            A mover needs money in BOTH periods. Every funnel here either had no comparison-period
            sales or had them withheld, so its change is unknown — not zero.
          </p>
        </div>
      );
    }
    return (
      <ul className="space-y-2 mt-1.5" data-testid={`${testid}-rows`}>
        {rows.map((r, i) => {
          const up = r.delta > 0;
          const Arrow = up ? ArrowUpRight : ArrowDownRight;
          const clickable = Boolean(onPickFunnel && r.key && r.key !== '(none)');
          const Tag = clickable ? 'button' : 'div';
          return (
            <li key={`${r.key}-${i}`}>
              <Tag
                {...(clickable ? { type: 'button', onClick: () => onPickFunnel(r.key) } : {})}
                className={`w-full text-left min-w-0 ${clickable ? 'cursor-pointer hover:bg-bg-elevated/40 rounded-md -mx-1 px-1 py-0.5' : ''}`}
                data-testid={`${testid}-row-${r.key}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-text-muted truncate" title={r.label}>{r.label}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums font-medium whitespace-nowrap ${
                      up ? 'text-success' : 'text-danger'
                    }`}
                  >
                    <Arrow className="w-3 h-3" aria-hidden="true" />
                    {`${up ? '+' : '−'}${fmtMoney(Math.abs(r.delta))}`}
                  </span>
                </div>
                <p className="text-[10px] text-text-faint tabular-nums mt-0.5">
                  {present(r.netSales) ? fmtMoney(r.netSales) : EM_DASH}
                  {' now · '}
                  {present(r.previous) ? fmtMoney(r.previous) : EM_DASH}
                  {' before'}
                  {/* OMITTED, not zeroed, when the server withheld it. */}
                  {present(r.deltaPct) ? ` · ${up ? '+' : '−'}${fmtPctPlain(Math.abs(r.deltaPct), 1)}` : ''}
                </p>
              </Tag>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <Card
      title="Biggest movers"
      sub={`Net sales, ${compare}`}
      testid={testid}
      footer={(
        <p className="text-[10.5px] text-text-faint mt-2 leading-relaxed">
          Ranked on the absolute change in net sales. A funnel with no measured sales in the
          comparison period is NOT ranked — its change is unknown, not its whole value — so this
          list can be shorter than the number of funnels that took money.
        </p>
      )}
    >
      {body()}
    </Card>
  );
}
