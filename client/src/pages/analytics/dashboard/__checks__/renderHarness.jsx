// renderHarness — mounts the REAL DashboardView against CAPTURED payloads
// (LANE 3, verification only — never imported by the app).
//
// This is not a mock of the page; it is the page. DashboardView is pure, so the
// only thing this file supplies that the app supplies differently is the two
// payloads — and those now come from ./seed.js, which is a view onto output
// captured from Lane 1's and Lane 2's real services (see ./captureSeed.mjs).
//
// Eight states, so one screenshot pass covers all of them:
//   1 measured    — a fully measured 30-day window, real names, real net_sales
//   2 ttl         — a window past the 90-day touch retention: sessions and every
//                   rate over them withheld, with the server's own warnings
//   3 withheld    — every measurable quantity null (no figure may appear)
//   4 loading     — skeletons, which must NOT look like empty or dead
//   5 failed      — a cold failure, which must NOT look like an empty window
//   6 hostile     — wrong type in every block; must render, not throw
//   7 live        — the REAL route end to end (index.jsx + the hook + axios),
//                   served the same captured payloads over the wire
//   8 explorer    — Lane 4's route with its module genuinely absent
//
// The catch-all '(none)' funnel bucket needs NO state of its own: Lane 1's real
// fold already emits one, so state 1 carries it. An earlier revision appended a
// synthetic '(none)' row for this — and collided with the real one, which React
// reported as a duplicate key. Capturing beats inventing twice over.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DashboardView from '../DashboardView.jsx';
import AnalyticsRoutes from '../../analyticsRoutes.jsx';
import {
  CAPTURE, CAPTURE_WINDOWS, SEED_DASHBOARD, SEED_MARKETING,
  SEED_MARKETING_UNATTRIBUTED, TTL_DASHBOARD, WITHHELD_DASHBOARD,
} from './seed.js';
import '../../../../index.css';

/**
 * A payload with the WRONG SHAPES in every slot — arrays where objects belong,
 * strings where numbers belong, a series that is not a series. Nothing here is
 * realistic; the point is that ErrorBoundary sits at the App root with no
 * boundary between it and this workspace, so ONE thrown render blanks the whole
 * CRM. This state must render, not throw. It is the one payload that CANNOT be
 * captured — no server emits it — so it stays hand-built on purpose.
 */
const HOSTILE_DASHBOARD = {
  band: [],
  kpis: 'not an object',
  series: { nope: true },
  prev_series: 'also not a series',
  breakdown_summary: [1, 2, 3],
  window: 42,
  meta: { warnings: [null, 7, 'one real warning', { source: 'x' }, { reason: 'a real reason' }] },
};

const noop = () => {};

const common = {
  start: CAPTURE_WINDOWS.a.start,
  end: CAPTURE_WINDOWS.a.end,
  funnelId: '',
  collapsed: false,
  onToggleCollapsed: noop,
  onScopeChange: noop,
  onRangeChange: noop,
  onRefresh: noop,
  onOpenExplorer: noop,
  onOpenLive: noop,
  onDrillMetric: noop,
};

/**
 * The states, as DATA rather than as a local component — this file has no
 * exports, and a component declared in a file with no exports is exactly what
 * the react-refresh lint rule (correctly) rejects.
 */
const STATES = [
  {
    id: 'state-measured',
    title: '1 · Measured window (captured)',
    note: 'Lane 1 runDashboard output for a 30-day window, verbatim. The money column is net_sales and the cards must say so; the funnel table draws only the columns the payload actually carries and names the rest underneath.',
    props: { data: SEED_DASHBOARD, marketing: SEED_MARKETING, loadState: 'ready', error: null },
  },
  {
    id: 'state-ttl',
    title: '2 · Past the touch retention (captured)',
    note: 'A window reaching past the 90-day lb_touches TTL. sessions_unknown is true on the wire, sessions and every rate over them are withheld, and the two {source, reason} warnings are the server’s own. The marketing card here is the dimension whose real fold contains BOTH unattributed states.',
    props: {
      /* The captured TTL payload, with the SESSION metrics added to the funnel
         rows as nulls. Lane 1's funnel breakdown folds three metrics today
         (net_sales, orders, aov), so the table has no sessions column to
         withhold and the TTL note it guards could never run. The engine's own
         semantics are unambiguous about what those cells WOULD be — breakdownRows
         marks every bucket `sessions_unknown` under ttlRisk and computeMetrics
         returns null for a rate it cannot measure — so the columns are added as
         null here to run that path down its failure case. Derived, and labelled
         as derived. */
      data: {
        ...TTL_DASHBOARD,
        breakdown_summary: {
          ...TTL_DASHBOARD.breakdown_summary,
          funnels: {
            ...TTL_DASHBOARD.breakdown_summary.funnels,
            rows: TTL_DASHBOARD.breakdown_summary.funnels.rows.map((r) => ({
              ...r, sessions: null, conv_pct: null, rev_per_session: null,
            })),
          },
        },
      },
      marketing: SEED_MARKETING_UNATTRIBUTED,
      loadState: 'ready',
      error: null,
    },
  },
  {
    id: 'state-withheld',
    title: '3 · Every measurement withheld (derived from the capture)',
    note: 'The captured shape with every numeric leaf nulled. The page must render in full with no fabricated figure anywhere — the check asserts that against the rendered DOM.',
    props: {
      data: WITHHELD_DASHBOARD,
      marketing: null,
      marketingError: 'Could not load marketing attribution (HTTP 502)',
      loadState: 'ready',
      error: 'Could not refresh — showing the last successful load.',
    },
  },
  {
    id: 'state-loading',
    title: '4 · First load in flight',
    note: 'Skeletons, not em dashes and not the empty state: a fetching dashboard must never be pixel-identical to a dead one.',
    props: { data: null, marketing: null, loadState: 'loading', error: null },
  },
  {
    id: 'state-failed',
    title: '5 · Cold failure',
    note: 'The first load failed and there is nothing behind it. Every card must say the request did not come back — and NOT ONE may print an empty state, because "no data for this date range" is a claim about the world that nobody is in a position to make.',
    props: {
      data: null,
      marketing: null,
      marketingError: 'Could not load marketing attribution (Network Error)',
      loadState: 'failed',
      error: 'Could not load the analytics dashboard (Network Error)',
    },
  },
  {
    id: 'state-hostile',
    title: '6 · Malformed payload',
    note: 'Every block the wrong shape. ErrorBoundary sits at the App root with nothing between it and this workspace, so one thrown render blanks the whole CRM. This must render, not throw.',
    props: { data: HOSTILE_DASHBOARD, marketing: 'not a payload', loadState: 'ready', error: null },
  },
];

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div className="min-h-screen bg-bg-main">
      <div className="px-6 pt-5 pb-1">
        <p className="text-[11px] text-text-faint" data-testid="an-capture-provenance">
          {`Payloads captured from metrics@${CAPTURE.metrics_commit} · attribution@${CAPTURE.attribution_commit} · REPORT_TZ ${CAPTURE.report_tz} · ${CAPTURE.database}`}
        </p>
      </div>

      {STATES.map((s) => (
        <section key={s.id} id={s.id} className="border-b border-border-strong">
          <div className="px-6 pt-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-accent-text">{s.title}</h2>
            <p className="text-xs text-text-muted mt-0.5 max-w-3xl">{s.note}</p>
          </div>
          <DashboardView {...common} {...s.props} />
        </section>
      ))}

      {/* 7 · THE REAL PAGE, END TO END. Every state above mounts DashboardView
          directly, which leaves index.jsx + useDashboardData + the axios layer
          with NO coverage at all — and that is precisely where a
          reference-before-declaration crash hid until it was found by hand. This
          section mounts the ACTUAL route, so the page state, the fetch loop, the
          window-echo adoption callback and the 15s heartbeat all really run. The
          responses are served by the screenshot driver from the SAME captured
          payloads (playwright route interception, not a mocked axios). */}
      <section id="state-live" className="border-b border-border-strong">
        <div className="px-6 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-widest text-accent-text">
            7 · The real route, end to end
          </h2>
          <p className="text-xs text-text-muted mt-0.5 max-w-3xl">
            AnalyticsRoutes at its index path: the real page component, the real hook, the real
            axios client. The captured payloads are served over the wire by the driver.
          </p>
        </div>
        <MemoryRouter initialEntries={['/an']}>
          <Routes>
            <Route path="/an/*" element={<AnalyticsRoutes />} />
          </Routes>
        </MemoryRouter>
      </section>

      {/* 8 · THE EXPLORER ROUTE, POST-MERGE. Lane 4's module now exists, so the
          static lazy import in analyticsRoutes RESOLVES and the real explorer
          mounts here. Mounted at /explorer only: the index route would fire the
          page's real fetches, and this harness must never touch a live API.
          The explorer's own fetches are effects — they do not run before the
          first paint, which is what this section screenshots. */}
      <section id="state-explorer" className="border-b border-border-strong">
        <div className="px-6 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-widest text-accent-text">
            8 · Explorer route, Lane 4 merged
          </h2>
          <p className="text-xs text-text-muted mt-0.5 max-w-3xl">
            The lazy import of Lane 4&apos;s module resolves on this branch. The real explorer must
            mount through the shared Suspense boundary — not a placeholder, not a spinner that
            never resolves, and not a thrown render.
          </p>
        </div>
        <MemoryRouter initialEntries={['/an/explorer']}>
          <Routes>
            <Route path="/an/*" element={<AnalyticsRoutes />} />
          </Routes>
        </MemoryRouter>
      </section>
    </div>
  </StrictMode>,
);
