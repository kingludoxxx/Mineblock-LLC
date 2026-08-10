// InsightsStrip — the deterministic detector cards, above the fold
// (NEW FILE, LANE 5).
//
// Six detectors, each producing at most one card, ranked worst-first by the
// server. This component renders them and CLAIMS NOTHING: the headline, the
// prose, the severity and the drill target are all the server's, because the
// thresholds that produced them are the server's too.
//
// ── THE FIVE STATES, and one of them is new ─────────────────────────────────
//
//   loading   → skeleton. A fetching strip must not look like a quiet one.
//   failed    → the couldn't-load well. ⚠️ NEVER "nothing to report": that is a
//               POSITIVE CLAIM about the business, made off a request that
//               never came back, on the one surface whose entire job is to tell
//               the operator when something is wrong. It is the single worst
//               absent-means-zero bug this page could ship.
//   degraded  → some detectors could not run. The cards that DID fire are shown
//               AND the blind ones are named — a strip that is quiet because it
//               is broken must not look like a strip that is quiet because the
//               business is fine.
//   quiet     → every detector ran and none fired. This is the ONLY state
//               allowed to say "nothing stood out", and it says which detectors
//               looked, so the silence is evidence rather than an absence of it.
//   cards     → the ranked list.
//
// ── WHY THE "WHAT WAS CHECKED" LINE IS NOT OPTIONAL ─────────────────────────
// A silent detector and a missing one are indistinguishable on screen, and they
// have opposite meanings. `detectors[]` carries `ran` and `fired` per kind, so
// the strip can say "six checks ran, none fired" rather than leaving an empty
// band that an operator reads as either "all good" or "this feature is broken"
// depending on their mood.
import { useState } from 'react';
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, Info, Sparkles, TriangleAlert,
} from 'lucide-react';
import { CardSkeleton, FailedState } from './cardKit.jsx';
import { KIND_LABELS } from './insightShapes.js';
import { EM_DASH, fmtInt } from './dashFormat.js';

/**
 * Severity → chrome. Four severities, four looks, and the DOWNWARD ones are the
 * loud ones: a "good" card in the same red as a dead tracking rail would train
 * the operator to ignore the colour.
 */
const SEVERITY = Object.freeze({
  bad: {
    Icon: TriangleAlert,
    ring: 'border-danger/35 bg-danger/[0.06]',
    text: 'text-danger',
    label: 'Needs attention',
  },
  warn: {
    Icon: AlertTriangle,
    ring: 'border-warning/35 bg-warning/[0.05]',
    text: 'text-warning',
    label: 'Worth a look',
  },
  good: {
    Icon: CheckCircle2,
    ring: 'border-success/30 bg-success/[0.05]',
    text: 'text-success',
    label: 'Good news',
  },
  info: {
    Icon: Info,
    ring: 'border-border-default bg-bg-elevated/40',
    text: 'text-text-muted',
    label: 'For information',
  },
});

function InsightCard({ card, onDrill }) {
  const [open, setOpen] = useState(false);
  const s = SEVERITY[card.severity] || SEVERITY.info;
  const { Icon } = s;
  // Only an EXPLORER link is followable from here. A `funnel_tracking` deep link
  // names a settings screen this lane does not own a route for, so the card
  // carries the instruction in its prose instead of a button that goes nowhere —
  // a dead button is worse than no button.
  const drillable = Boolean(onDrill && card.deepLink && card.deepLink.page === 'explorer');
  return (
    <li
      className={`rounded-lg border px-3 py-2.5 ${s.ring}`}
      data-testid={`an-insight-${card.kind}`}
      data-severity={card.severity}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <Icon className={`w-4 h-4 shrink-0 mt-px ${s.text}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[9.5px] uppercase tracking-wide font-semibold text-text-faint">
              {KIND_LABELS[card.kind] || card.kind}
            </span>
            <span className={`text-[9.5px] uppercase tracking-wide font-semibold ${s.text}`}>
              {s.label}
            </span>
          </div>
          <p className="text-[12.5px] font-medium text-text-primary mt-0.5 leading-snug">
            {card.headline}
          </p>
          {/* THE PROSE IS THE EVIDENCE, and it is one click away rather than
              hidden: the headline says WHAT, the sentence says what it was
              judged against. A card an operator cannot audit is a card they
              have to take on faith. */}
          {open && (
            <p
              className="text-[11px] text-text-muted mt-1.5 leading-relaxed"
              data-testid={`an-insight-${card.kind}-prose`}
            >
              {card.prose}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1.5">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-[10.5px] text-text-faint hover:text-text-muted focus:outline-none focus-visible:underline"
              aria-expanded={open}
            >
              {open ? 'Hide the reasoning' : 'Why this fired'}
            </button>
            {drillable && (
              <button
                type="button"
                onClick={() => onDrill(card.deepLink)}
                className="inline-flex items-center gap-1 text-[10.5px] text-accent-text hover:underline focus:outline-none focus-visible:underline"
                data-testid={`an-insight-${card.kind}-drill`}
              >
                Open in the explorer
                <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default function InsightsStrip({
  insights, state, error, onDrill, testid = 'an-insights-strip',
}) {
  const data = insights || null;
  const cards = data ? data.cards : [];
  const detectors = data ? data.detectors : [];
  const degraded = data ? data.degraded : [];
  const warnings = data ? data.warnings : [];

  const ran = detectors.filter((d) => d.ran === true).length;
  const blind = detectors.filter((d) => d.ran === false);
  // THE DAY IS IN PROGRESS. The server withheld every downward card and told us
  // so; the strip labels the day rather than letting the operator read a short
  // list as "all clear" when it is really "half the day isn't in yet".
  const partial = Boolean(data && data.partial);

  const header = (
    <header className="flex items-baseline justify-between gap-2 mb-2">
      <div className="flex items-baseline gap-2 min-w-0">
        <Sparkles className="w-3.5 h-3.5 text-accent-text shrink-0 self-center" aria-hidden="true" />
        <h3 className="text-[13px] font-semibold tracking-tight text-text-primary">
          What changed
        </h3>
        <span className="text-[10.5px] text-text-faint truncate">
          {data && data.day ? `for ${data.day}` : ''}
        </span>
        {partial && (
          <span
            className="text-[9.5px] uppercase tracking-wide font-semibold text-warning/90 border border-warning/30 rounded px-1 py-px shrink-0"
            data-testid={`${testid}-partial`}
            title="Today is still in progress. Its totals are a fraction of a full day's, so downward findings are withheld until the day is over."
          >
            in progress
          </span>
        )}
      </div>
      {/* THE PROVENANCE OF THE SILENCE. Rendered whenever the payload told us
          how many detectors looked — never guessed from the card count. */}
      {detectors.length > 0 && (
        <span className="text-[10px] text-text-faint tabular-nums shrink-0" data-testid={`${testid}-checks`}>
          {`${fmtInt(ran)} of ${fmtInt(detectors.length)} checks ran`}
        </span>
      )}
    </header>
  );

  return (
    <section
      className="rounded-xl border border-border-default bg-bg-card p-4"
      data-testid={testid}
    >
      {header}

      {state === 'loading' && <CardSkeleton rows={3} height={96} />}

      {/* ⚠️ THE FAILURE WELL, NOT THE QUIET STATE. "Nothing stood out" over a
          request that never came back is this page's most dangerous sentence. */}
      {state === 'failed' && (
        <FailedState
          reason={error ? String(error) : 'The insight layer did not answer.'}
          height={96}
        />
      )}

      {state === 'ready' && (
        <>
          {cards.length > 0 && (
            <ul className="space-y-2" data-testid={`${testid}-cards`}>
              {cards.map((c, i) => (
                <InsightCard key={`${c.kind}-${i}`} card={c} onDrill={onDrill} />
              ))}
            </ul>
          )}

          {/* THE QUIET STATE — reachable only when every detector actually ran,
              NONE was withheld, and the day is COMPLETE. A blind detector falls
              through to the degradation notice; a partial day falls through to
              its own warning below. "Nothing stood out" is a confident claim
              about the business, and it may only be made about a settled day
              that was fully examined. */}
          {cards.length === 0 && blind.length === 0 && detectors.length > 0
            && !partial && !detectors.some((d) => d.suppressed) && (
            <div
              className="flex flex-col items-center justify-center text-center gap-1 py-6"
              data-testid={`${testid}-quiet`}
            >
              <p className="text-xs text-text-muted">Nothing stood out</p>
              <p className="text-[10.5px] text-text-faint max-w-[420px] leading-relaxed">
                {`All ${fmtInt(detectors.length)} checks ran and none of them fired: `}
                {detectors.map((d) => KIND_LABELS[d.kind] || d.kind).join(', ').toLowerCase()}
                . A quiet strip is a result, not an absence of one.
              </p>
            </div>
          )}

          {/* A PARTIAL DAY WITH NOTHING LEFT TO SHOW. Not the quiet state — the
              day is not over, so "nothing stood out" would be a claim nobody can
              make yet. The today_partial warning below carries the detail; this
              is the neutral placeholder so the strip is not blank. */}
          {cards.length === 0 && blind.length === 0 && detectors.length > 0
            && (partial || detectors.some((d) => d.suppressed)) && (
            <div
              className="flex flex-col items-center justify-center text-center gap-1 py-6"
              data-testid={`${testid}-partial-empty`}
            >
              <p className="text-xs text-text-muted">Today is still in progress</p>
              <p className="text-[10.5px] text-text-faint max-w-[420px] leading-relaxed">
                Downward findings are withheld until the day is over — a half-finished day is below a
                full day&apos;s baseline by the clock, not the business. Check back tomorrow, or read
                yesterday&apos;s settled strip.
              </p>
            </div>
          )}

          {/* No detector list at all — say THAT, rather than claiming silence
              on the strength of a payload that never described itself. */}
          {cards.length === 0 && detectors.length === 0 && (
            <div
              className="flex items-center justify-center py-6 text-xs text-text-muted"
              data-testid={`${testid}-unknown`}
            >
              {`${EM_DASH} the insight layer did not report which checks it ran`}
            </div>
          )}

          {/* DEGRADATION — a detector that could not look, named. This sits
              BELOW the cards that did fire, because those are still true. */}
          {blind.length > 0 && (
            <div
              className="mt-2 rounded-md border border-warning/25 bg-warning/5 px-2.5 py-1.5"
              data-testid={`${testid}-blind`}
            >
              <p className="text-[10.5px] text-warning/90 leading-snug">
                {`${blind.map((d) => KIND_LABELS[d.kind] || d.kind).join(', ')} `}
                {blind.length === 1 ? 'could not run' : 'could not run'}
                {' for this window, so nothing above rules out what it would have found.'}
              </p>
            </div>
          )}

          {(degraded.length > 0 || warnings.length > 0) && (
            <ul className="mt-2 space-y-0.5" data-testid={`${testid}-notes`}>
              {degraded.map((w, i) => (
                <li key={`d-${i}`} className="text-[10.5px] text-danger/90 leading-snug">
                  <span className="font-medium">{w.source ? `${w.source}: ` : ''}</span>
                  {w.text}
                </li>
              ))}
              {warnings.map((w, i) => (
                <li key={`w-${i}`} className="text-[10.5px] text-text-faint leading-snug">
                  <span className="font-medium">{w.source ? `${w.source}: ` : ''}</span>
                  {w.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
