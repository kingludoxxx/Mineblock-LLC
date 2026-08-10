// StepWaterfallCard — visitors per funnel step, and where they fall out
// (NEW FILE, LANE 5).
//
// Reads `data.waterfall` out of the composite the page ALREADY fetches — the
// metrics engine has been shipping this block since Lane 1 and nothing was
// drawing it. No new request.
//
// ── THE TWO NUMBERS, AND WHY BOTH ───────────────────────────────────────────
//
//   `pct_of_top`   — the server's own figure: this step's visitors as a share
//                    of the WIDEST step. It is the bar's length, and it is what
//                    makes the chart have an honest 100% anchor.
//   step-to-step   — visitors on this step ÷ visitors on the PREVIOUS one,
//                    derived here. It is the drop-off an operator acts on:
//                    "half of everyone who saw the product page reached
//                    checkout" is a different sentence from "checkout is 50% of
//                    the widest step", and on a funnel with a fat upsell page
//                    the two disagree.
//
// The derived one is computed with `safeRate`, so a zero or missing upstream
// step yields NULL and renders an em dash — never "0%", which would read as
// "nobody got through" for a step nobody could measure.
//
// ⚠️ WHAT THIS IS NOT. `lb_touches` is a VIEW ledger: these are distinct
// visitors who loaded a page of that type, not form submits and not purchases.
// The basis line says so, verbatim from the server, because a "checkout" bar
// read as "checkouts started" is a materially different number.
//
// ⚠️ A STEP THE FUNNEL DOES NOT HAVE IS ABSENT, NOT ZERO. The server only emits
// steps it observed, so a funnel with no downsell has no downsell row — and
// this card must not synthesise one at 0 visitors, which would draw a cliff
// into a funnel that simply does not have that page.
import { Card } from './cardKit.jsx';
import { waterfallOf } from './insightShapes.js';
import {
  EM_DASH, fmtInt, fmtPctPlain, present, safeRate,
} from './dashFormat.js';

export default function StepWaterfallCard({
  data, state, reason, testid = 'an-card-step-waterfall',
}) {
  const wf = waterfallOf(data);
  const steps = wf.steps;

  // The bar scale is the widest MEASURED step. Falling back to the server's
  // pct_of_top when it sent one keeps the two definitions from drifting.
  const widest = steps.reduce((m, s) => (s.visitors !== null ? Math.max(m, s.visitors) : m), 0);

  const rows = steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1] : null;
    // A THROUGH-RATE NEEDS AN UPSTREAM DENOMINATOR. No previous step (this is
    // the entry), or an unmeasured/zero one, means the rate is UNKNOWN.
    const through = prev ? safeRate(s.visitors, prev.visitors) : null;
    const share = s.pctOfTop !== null
      ? s.pctOfTop
      : (widest > 0 && s.visitors !== null ? (s.visitors / widest) * 100 : null);
    return { ...s, through: through === null ? null : through * 100, share, prev };
  });

  const body = () => {
    if (state === 'loading') {
      return <div className="space-y-2 min-h-[140px]" data-testid="an-card-skeleton" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-4 rounded bg-bg-elevated animate-pulse" style={{ width: `${90 - i * 14}%` }} />
        ))}
      </div>;
    }
    if (state === 'failed') {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[140px]"
          data-testid="an-card-failed"
          role="status"
        >
          <p className="text-xs text-warning/90">Couldn&apos;t load this card</p>
          {reason ? <p className="text-[10.5px] text-text-faint max-w-[280px]">{String(reason)}</p> : null}
          <p className="text-[10.5px] text-text-faint max-w-[280px]">
            This is not a funnel with no traffic — nothing is known about it either way.
          </p>
        </div>
      );
    }
    // The server sent the block and it has no steps: this window really did see
    // no page of any known type. That IS the empty state, and it is only
    // reachable from a successful read.
    if (!rows.length) {
      return (
        <div
          className="flex flex-col items-center justify-center gap-1 text-center px-3 min-h-[140px]"
          data-testid="an-card-empty"
        >
          <p className="text-xs text-text-muted">No funnel steps were visited in this date range</p>
          <p className="text-[10.5px] text-text-faint max-w-[300px] leading-relaxed">
            Steps come from the page types in the builder. A funnel whose pages have no type set
            has no steps to draw.
          </p>
        </div>
      );
    }
    return (
      <ol className="space-y-2 mt-1.5" data-testid={`${testid}-steps`}>
        {rows.map((r, i) => (
          <li key={`${r.step}-${i}`} data-testid={`${testid}-step-${r.step}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-text-muted truncate">{r.label}</span>
              <span className="text-[11px] tabular-nums text-text-primary whitespace-nowrap">
                {r.visitors === null ? EM_DASH : fmtInt(r.visitors)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="h-3 flex-1 rounded-[3px] bg-bg-elevated overflow-hidden">
                {r.share !== null && (
                  <div
                    className="h-full rounded-[3px]"
                    style={{ width: `${Math.max(2, Math.min(100, r.share))}%`, background: '#c9a84c' }}
                  />
                )}
              </div>
              {/* THE DROP-OFF, tri-state. The entry step has no upstream, so it
                  says so rather than printing 100% — "100% of nothing" is a
                  claim, and the wrong one. */}
              <span
                className="text-[10px] tabular-nums text-text-faint whitespace-nowrap w-[86px] text-right"
                title={i === 0
                  ? 'The first step has no upstream step, so there is no through-rate to state.'
                  : `Visitors on ${r.label} ÷ visitors on ${r.prev ? r.prev.label : 'the previous step'}.`}
                data-testid={`${testid}-through-${r.step}`}
              >
                {i === 0
                  ? 'entry'
                  : present(r.through) ? `${fmtPctPlain(r.through, 1)} through` : `${EM_DASH} through`}
              </span>
            </div>
          </li>
        ))}
      </ol>
    );
  };

  return (
    <Card
      title="Funnel steps"
      sub="Distinct visitors per step, in flow order"
      testid={testid}
      footer={(
        <p className="text-[10.5px] text-text-faint mt-2 leading-relaxed">
          {wf.basis ? `Basis: ${wf.basis}. ` : ''}
          These are page VIEWS, not submits or purchases — this build records no submit event, so a
          step&apos;s bar is the visitors who loaded a page of that type. A step a funnel does not have
          is missing from the list, never drawn at zero.
        </p>
      )}
    >
      {body()}
    </Card>
  );
}
