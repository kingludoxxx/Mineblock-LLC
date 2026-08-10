// analyticsRoutes — the analytics workspace's own router (NEW FILE, LANE 3).
//
// Mounted from App.jsx by ONE additive route line (`analytics/*`), so this lane
// owns its own URL space and no other lane has to touch the app router again:
//
//   /app/analytics            -> the dashboard (LANE 3)
//   /app/analytics/explorer   -> the report explorer (LANE 4)
//
// ── THE EXPLORER IMPORT ─────────────────────────────────────────────────────
//
// Lane 4 built `./explorer/index.jsx` in a PARALLEL worktree, so until it
// merged the specifier had to be held in a variable behind `@vite-ignore` (the
// bundler could not analyse it, and a rejected resolution rendered an honest
// "not installed" placeholder instead of a blank screen).
//
// Lane 4 IS MERGED. That scaffolding is gone: this is now the ordinary static
// lazy import, so Rollup code-splits the explorer into its own chunk and a
// missing module would be a BUILD failure rather than a silent placeholder.
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import AnalyticsDashboardPage from './dashboard/index.jsx';
import { CardSkeleton } from './dashboard/cardKit.jsx';

const Explorer = lazy(() => import('./explorer/index.jsx'));
// LANE 5 — the cohort / LTV surface. Lazy for the same reason the explorer is:
// it is a second full page and the dashboard should not pay for its bundle.
const Cohorts = lazy(() => import('./CohortsPage.jsx'));

function ExplorerFallback() {
  return (
    <div className="p-6">
      <div className="rounded-xl border border-border-default bg-bg-card p-4">
        <CardSkeleton rows={8} height={240} />
      </div>
    </div>
  );
}

export default function AnalyticsRoutes() {
  return (
    <Routes>
      <Route index element={<AnalyticsDashboardPage />} />
      <Route
        path="explorer"
        element={(
          <Suspense fallback={<ExplorerFallback />}>
            <Explorer />
          </Suspense>
        )}
      />
      {/* /app/analytics/cohorts — new-acquisition cohorts, their LTV curves and
          the CSV. This is also where the previously-unrouted
          pages/performance/LTV.jsx landed: its view survived, its hardcoded
          numbers did not (see CohortsPage.jsx's header). */}
      <Route
        path="cohorts"
        element={(
          <Suspense fallback={<ExplorerFallback />}>
            <Cohorts />
          </Suspense>
        )}
      />
      {/* Any deeper path is the dashboard, not a 404 inside the workspace. */}
      <Route path="*" element={<AnalyticsDashboardPage />} />
    </Routes>
  );
}
