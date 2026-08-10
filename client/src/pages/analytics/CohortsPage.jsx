// CohortsPage — the full-page cohort / LTV surface (NEW FILE, LANE 5).
//
// Mounted at /app/analytics/cohorts. It is the standalone home of the same
// CohortCard the dashboard carries, with the acquisition window, the grouping
// and the horizons under the operator's control instead of fixed.
//
// ── THIS IS WHERE THE ORPHANED LTV PAGE WENT ────────────────────────────────
//
// `pages/performance/LTV.jsx` was built and never routed. Its view was good —
// four LTV tiles, a retention grid, a cohort table — and its DATA was four
// hardcoded object literals: `ltvMetrics['2025-Q4'] = {avg: 312, d30: 48, …}`,
// a `cohortTable` of invented retention percentages, and a dashed placeholder
// box captioned "Retention curve chart".
//
// DECISION MADE — FOLD, NOT WIRE. Routing that file would have shipped a screen
// of numbers that are indistinguishable from measurements and are not, on the
// one workspace whose whole discipline is that an unmeasured number is an em
// dash. Its VIEW is preserved here (the tiles are below; the retention grid is
// the card's own) and its data comes from the real cohort fold. The old file is
// now a thin re-export onto this page, so any link that ever pointed at it
// lands on the real thing rather than 404ing.
//
// ── THE TILES CLAIM EXACTLY WHAT THE SERVER CLAIMS ──────────────────────────
// Each tile is one horizon of the server's SIZE-WEIGHTED average, and each says
// how many buyers that average was weighted over. A horizon no cohort has
// reached renders an em dash and names the reason — never $0.00, which is what
// the fabricated page printed for every cell it had not invented a value for.
import { useMemo, useState } from 'react';
import { Calendar, DollarSign, TrendingUp, Users } from 'lucide-react';
import CohortCard from './dashboard/CohortCard.jsx';
import useInsightsData, { COHORT_WINDOW_DAYS } from './dashboard/useInsightsData.js';
import { cohortsOf } from './insightsApi.js';
import {
  EM_DASH, daysAgoIso, fmtInt, fmtMoney, prettyRange, todayIso,
} from './dashboard/dashFormat.js';

const WINDOWS = Object.freeze([
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '365 days' },
]);

const TILE_ICONS = [DollarSign, Calendar, TrendingUp, Users];

export default function CohortsPage() {
  const [windowDays, setWindowDays] = useState(COHORT_WINDOW_DAYS);
  const [groupBy, setGroupBy] = useState('day');

  const cohortEnd = todayIso();
  const cohortStart = daysAgoIso(windowDays - 1);

  const {
    cohorts, cohortsError, cohortsState, cohortsCsvUrl,
  } = useInsightsData({
    // `day: null` — this page has no insight strip, so the hook skips that read
    // entirely rather than spending an engine query per page load on a payload
    // nothing renders.
    day: null,
    funnelId: '',
    cohortStart,
    cohortEnd,
    groupBy,
  });

  const c = useMemo(() => cohortsOf(cohorts), [cohorts]);
  const horizons = c.horizons.length ? c.horizons : [0, 7, 30, 90];
  const avg = c.average;

  const loading = cohortsState === 'loading';
  const failed = cohortsState === 'failed';

  return (
    <div className="p-6 space-y-4 max-w-[1800px]" data-testid="an-cohorts-page">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Customer lifetime value
          </h1>
          <p className="text-[11px] text-text-muted mt-0.5">
            {`New buyers acquired ${prettyRange(cohortStart, cohortEnd)}, and what they spent afterwards.`}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Acquisition window">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setWindowDays(w.days)}
              aria-pressed={w.days === windowDays}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                w.days === windowDays
                  ? 'border-accent/45 text-accent-text bg-accent/10'
                  : 'border-border-default text-text-faint hover:text-text-muted'
              }`}
              data-testid={`an-cohorts-window-${w.days}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {failed && (
        <div
          className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger"
          role="alert"
          data-testid="an-cohorts-error"
        >
          {String(cohortsError || 'Could not load cohorts.')}
          {' Nothing below is a measurement of this window — the request did not come back.'}
        </div>
      )}

      {/* ── the tiles the orphaned page had, with real figures behind them ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="an-cohorts-tiles">
        {horizons.map((h, i) => {
          const Icon = TILE_ICONS[i % TILE_ICONS.length];
          const value = avg && avg.ltv[i] !== undefined ? avg.ltv[i] : null;
          const aged = avg && avg.aged[i] !== undefined ? avg.aged[i] : null;
          const retention = avg && avg.retention[i] !== undefined ? avg.retention[i] : null;
          return (
            <div
              key={h}
              className="rounded-xl border border-border-default bg-bg-card p-4"
              data-testid={`an-cohorts-tile-d${h}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="p-1.5 bg-bg-elevated rounded-lg">
                  <Icon className="w-3.5 h-3.5 text-accent-text" aria-hidden="true" />
                </span>
                <span className="text-[11px] text-text-muted">
                  {h === 0 ? 'LTV on day 0' : `LTV through day ${h}`}
                </span>
              </div>
              {loading ? (
                <div className="h-7 w-24 rounded bg-bg-elevated animate-pulse" data-testid="an-cohorts-tile-skeleton" />
              ) : (
                <p
                  className={`text-2xl tabular-nums font-medium tracking-tight ${
                    value === null ? 'text-text-faint' : 'text-text-primary'
                  }`}
                  title={value === null
                    ? `No cohort in this window has lived ${h} days yet, so there is nothing to average. This is not $0.00.`
                    : `Size-weighted over ${fmtInt(aged ?? 0)} buyer(s) old enough to be measured at D${h}.`}
                >
                  {value === null ? EM_DASH : fmtMoney(value)}
                </p>
              )}
              <p className="text-[10px] text-text-faint mt-1 tabular-nums">
                {failed
                  ? 'couldn’t load'
                  : value === null
                    ? 'not aged yet'
                    : `over ${fmtInt(aged ?? 0)} buyers${
                      retention === null || h === 0 ? '' : ` · ${retention.toFixed(1)}% repeat`
                    }`}
              </p>
            </div>
          );
        })}
      </div>

      <CohortCard
        cohorts={cohorts}
        state={cohortsState}
        error={cohortsError}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        csvUrl={cohortsCsvUrl}
        limit={40}
        testid="an-cohorts-table"
      />

      <p className="text-[11px] text-text-faint leading-relaxed max-w-4xl">
        A cohort is every buyer whose FIRST EVER paid order landed inside the acquisition window;
        a repeat buyer is not an acquisition, and an order with no email cannot be tied to a person
        at all. LTV counts every later order those buyers placed on ANY funnel, because lifetime
        value is a property of the customer rather than of the page that acquired them — so these
        figures will not tie out to a single funnel&apos;s net sales, by construction. A horizon a
        cohort has not lived long enough to reach is blank. It is never zero.
      </p>
    </div>
  );
}
