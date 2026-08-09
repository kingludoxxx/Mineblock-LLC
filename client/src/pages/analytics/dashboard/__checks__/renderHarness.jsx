// renderHarness — mounts the REAL DashboardView against ./seed.js
// (NEW FILE, LANE 3, verification only — never imported by the app).
//
// This is not a mock of the page; it is the page. DashboardView is pure, so the
// only thing this file supplies that the app supplies differently is the two
// payloads — which is exactly the variable under test. It renders THREE states
// side by side so one screenshot can be inspected for all of them:
//
//   1. seeded   — a busy window that deliberately contains withheld cells
//   2. withheld — every measurable quantity null (no number may appear)
//   3. loading  — skeletons, which must NOT look like the empty or dead states
//
// Served by vite in dev at
//   /src/pages/analytics/dashboard/__checks__/harness.html
// and driven by ./screenshot.mjs.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DashboardView from '../DashboardView.jsx';
import AnalyticsRoutes from '../../analyticsRoutes.jsx';
import { SEED_DASHBOARD, SEED_MARKETING, WITHHELD_DASHBOARD } from './seed.js';
import '../../../../index.css';

/**
 * A payload with the WRONG SHAPES in every slot — arrays where objects belong,
 * strings where numbers belong, a series that is not a series. Nothing here is
 * realistic; the point is that ErrorBoundary sits at the App root with no
 * boundary between it and this workspace, so ONE thrown render blanks the whole
 * CRM. This state must render, not throw.
 */
const HOSTILE_DASHBOARD = {
  band: [],
  kpis: 'not an object',
  series: { nope: true },
  prev_series: 'also not a series',
  breakdown_summary: [1, 2, 3],
  window: 42,
  meta: { warnings: [null, 7, 'one real warning'] },
};

const noop = () => {};

const common = {
  start: '2026-07-11',
  end: '2026-08-09',
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
 * The three states, as DATA rather than as a local component — this file has no
 * exports, and a component declared in a file with no exports is exactly what
 * the react-refresh lint rule (correctly) rejects. Mapping over a plain array
 * keeps the harness at zero new lint problems, which is one of the gates.
 */
const STATES = [
  {
    id: 'state-seeded',
    title: '1 · Seeded window',
    note: 'Realistic data that DELIBERATELY carries withheld cells: two unmeasured days in the session series, a funnel with no visitor spine, a funnel with zero cost coverage, a funnel with no bound spend, and a campaign bucket with no campaign on the click. Every one of those must be an em dash or an honest label — never a zero.',
    props: { data: SEED_DASHBOARD, marketing: SEED_MARKETING, loadState: 'ready', error: null },
  },
  {
    id: 'state-withheld',
    title: '2 · Everything withheld',
    note: 'Every measurable quantity is null. The page must render in full with no fabricated figure anywhere — the check asserts that in the rendered DOM.',
    props: {
      data: WITHHELD_DASHBOARD,
      marketing: null,
      loadState: 'ready',
      error: 'Could not refresh — showing the last successful load.',
    },
  },
  {
    id: 'state-loading',
    title: '3 · First load in flight',
    note: 'Skeletons, not em dashes and not the empty state: a fetching dashboard must never be pixel-identical to a dead one.',
    props: { data: null, marketing: null, loadState: 'loading', error: null },
  },
  {
    id: 'state-failed',
    title: '4 · Cold failure',
    note: 'The first load failed and there is nothing behind it. The page must SAY so — a dashboard that fails silently into em dashes is indistinguishable from an empty window.',
    props: {
      data: null,
      marketing: null,
      loadState: 'failed',
      error: 'Could not load the analytics dashboard (Network Error)',
    },
  },
  {
    id: 'state-hostile',
    title: '5 · Malformed payload',
    note: 'Every block the wrong shape. ErrorBoundary sits at the App root with nothing between it and this workspace, so one thrown render blanks the whole CRM. This must render, not throw.',
    props: { data: HOSTILE_DASHBOARD, marketing: 'not a payload', loadState: 'ready', error: null },
  },
];

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div className="min-h-screen bg-bg-main">
      {STATES.map((s) => (
        <section key={s.id} id={s.id} className="border-b border-border-strong">
          <div className="px-6 pt-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-accent-text">{s.title}</h2>
            <p className="text-xs text-text-muted mt-0.5 max-w-3xl">{s.note}</p>
          </div>
          <DashboardView {...common} {...s.props} />
        </section>
      ))}

      {/* 6 · THE EXPLORER'S FAILURE PATH, ACTUALLY RUN. Lane 4's module does not
          exist on this branch, so the guarded dynamic import in analyticsRoutes
          REJECTS here — which is the whole point. A catch that has never been
          down its own failure path is a claim about a mechanism, not evidence.
          Mounted at /explorer only: the index route would fire the page's real
          fetches, and this harness must never touch a live API. */}
      <section id="state-explorer" className="border-b border-border-strong">
        <div className="px-6 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-widest text-accent-text">
            6 · Explorer route, Lane 4 not merged
          </h2>
          <p className="text-xs text-text-muted mt-0.5 max-w-3xl">
            The lazy import of Lane 4&apos;s module fails on this branch. The catch must render a
            plain placeholder — not a blank panel, not a spinner that never resolves, and not a
            thrown render.
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
