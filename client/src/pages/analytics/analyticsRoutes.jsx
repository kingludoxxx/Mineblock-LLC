// analyticsRoutes — the analytics workspace's own router (NEW FILE, LANE 3).
//
// Mounted from App.jsx by ONE additive route line (`analytics/*`), so this lane
// owns its own URL space and no other lane has to touch the app router again:
//
//   /app/analytics            -> the dashboard (LANE 3)
//   /app/analytics/explorer   -> the report explorer (LANE 4)
//
// ── WHY THE EXPLORER IMPORT LOOKS LIKE THAT ─────────────────────────────────
//
// Lane 4 builds `./explorer/index.jsx` in a PARALLEL worktree; it does not
// exist on this branch. A static `import('./explorer/index.jsx')` would be
// resolved by Rollup at build time and fail the build outright ("could not
// resolve"), so this branch could not ship at all until Lane 4 merged — which
// is exactly the coupling contract-first parallel lanes exist to avoid.
//
// So the specifier is held in a variable and marked `@vite-ignore`: the bundler
// cannot analyse it, leaves it alone, and the resolution happens in the browser
// at click time. Until Lane 4 lands, that resolution FAILS and the catch renders
// a plain, honest placeholder instead of a blank screen or a thrown render.
// After Lane 4 merges, the integrator swaps these three lines for the ordinary
// static import (see INTEGRATION note below) and the placeholder disappears.
//
// It is deliberately NOT a stub file under ./explorer/ — that directory is Lane
// 4's fence, and a placeholder committed there would collide with their work.
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import AnalyticsDashboardPage from './dashboard/index.jsx';
import { CardSkeleton } from './dashboard/cardKit.jsx';

/** INTEGRATION (post-merge): replace the next four statements with
 *  `const Explorer = lazy(() => import('./explorer/index.jsx'));` */
const EXPLORER_MODULE = './explorer/index.jsx';
const Explorer = lazy(() =>
  import(/* @vite-ignore */ EXPLORER_MODULE).catch(() => ({ default: ExplorerNotInstalled })));

/**
 * The explorer module is not in this build. Said plainly — a blank panel would
 * read as a crash, and a spinner would promise something that is never coming.
 */
function ExplorerNotInstalled() {
  return (
    <div className="p-6 max-w-[900px]" data-testid="an-explorer-missing">
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-5 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text-primary">Explorer is not installed in this build</h1>
          <p className="text-sm text-text-muted mt-1 leading-relaxed">
            The report explorer ships in its own lane and is not part of this bundle yet. The dashboard
            is unaffected — nothing on it is computed by the explorer.
          </p>
        </div>
      </div>
    </div>
  );
}

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
      {/* Any deeper path is the dashboard, not a 404 inside the workspace. */}
      <Route path="*" element={<AnalyticsDashboardPage />} />
    </Routes>
  );
}
