// CoverageBanner — "X of Y variants costed", and the money that fact is
// currently costing you (NEW FILE, costs lane).
//
// The second line is the whole point: "62 of 85 costed" is an abstraction;
// "$40,000 of the last 30 days' revenue is still booked at 100% margin" is the
// number that gets the catalog filled in.
//
// Detect is an explicit button and never a side effect of a GET — the
// reference's legacy catalog fired an unbounded replay from inside a list
// endpoint, so detection here is the server sweep or this button, nothing else.
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { fmtMoney, fmtDateTime } from '../costTargets';

export default function CoverageBanner({
  coverage = { costed: 0, total: 0 },
  uncostedRevenue30d = 0,
  lastDetectedAt = null,
  detecting = false,
  canEdit = false,
  onDetect,
}) {
  const { costed, total } = coverage;
  const pct = total ? Math.round((costed / total) * 100) : 0;
  const complete = total > 0 && costed === total;
  const Icon = complete ? ShieldCheck : ShieldAlert;
  const toneText = complete ? 'text-green-400' : 'text-amber-400';
  const toneBar = complete ? 'bg-green-400' : 'bg-amber-400';

  return (
    <section
      className="rounded-xl border border-border-default bg-bg-card px-5 py-4"
      data-testid="costs-coverage"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className={`w-4 h-4 ${toneText}`} strokeWidth={1.75} />
            <p className="text-sm font-medium text-text-primary">
              <span className="tabular-nums">{costed.toLocaleString()}</span>
              <span className="text-text-muted"> of </span>
              <span className="tabular-nums">{total.toLocaleString()}</span>
              <span className="text-text-muted"> variants costed</span>
            </p>
            <span className="tabular-nums text-[11px] text-text-muted">{pct}%</span>
          </div>

          <p className="mt-1.5 text-[12px] text-text-muted">
            {complete ? (
              'Every live variant has a cost. Margin figures downstream are real.'
            ) : (
              <>
                <span className="tabular-nums text-text-primary">{fmtMoney(uncostedRevenue30d)}</span>{' '}
                of the last 30 days&rsquo; revenue is still booked at 100% margin.
              </>
            )}
          </p>

          {lastDetectedAt && (
            <p className="mt-1 text-[11px] text-text-faint">
              Last detected {fmtDateTime(lastDetectedAt)}
            </p>
          )}
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={onDetect}
            disabled={detecting}
            data-testid="costs-detect"
            title="Re-scan sold variants across every live funnel (90d)"
            className="inline-flex items-center gap-1.5 h-[34px] px-3 rounded-lg border border-border-default
                       bg-bg-elevated text-sm text-text-muted hover:text-text-primary disabled:opacity-50
                       transition-colors shrink-0"
          >
            {detecting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            {detecting ? 'Detecting…' : 'Detect now'}
          </button>
        )}
      </div>

      <div
        className="mt-3 h-1.5 w-full rounded-full bg-bg-elevated overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Cost coverage"
      >
        <div className={`h-full rounded-full ${toneBar}`} style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}
