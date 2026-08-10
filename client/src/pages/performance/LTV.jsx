// LTV — FOLDED INTO THE REAL COHORT SURFACE (LANE 5).
//
// ── WHAT THIS FILE USED TO BE ───────────────────────────────────────────────
//
// A complete, never-routed LTV page whose every figure was a hardcoded literal:
//
//     const ltvMetrics = { '2025-Q4': { avg: 312, d30: 48, d60: 89, d90: 142 }, … }
//     const cohortTable = [{ month: 'Month 1', '2025-Q4': 68, '2025-Q3': 62, … }, …]
//
// — four quarters of invented LTV, seven rows of invented retention, and a
// dashed placeholder box captioned "Retention curve chart". The audit found it
// built but unrouted.
//
// ── DECISION MADE: FOLD, DO NOT WIRE ────────────────────────────────────────
//
// Routing it would have shipped a screen of numbers that are pixel-identical to
// measurements and are not — on the one workspace whose entire discipline is
// that a figure nobody measured renders an em dash. "Placeholder data" is a
// distinction that exists in the source file and NOWHERE on the operator's
// screen, and the numbers were plausible enough to act on ($312 average LTV,
// 68% month-1 retention). That is the most expensive class of bug this codebase
// has rules against.
//
// So the VIEW was kept and the DATA was replaced. `pages/analytics/CohortsPage`
// carries the same four LTV tiles and the same cohort/retention grid, computed
// by `server/src/services/funnelCohorts.js` over real `co_sessions` money, with
// the aging guard that renders an un-reached horizon as a dash instead of a
// zero. It is routed at `/app/analytics/cohorts`.
//
// This module stays as a REDIRECT rather than being deleted: it was reachable
// by import (and by any bookmark a route may once have had), and a component
// that quietly disappears is a broken screen for whoever finds it. Anything
// still importing `pages/performance/LTV` now lands on the real surface.
import { Navigate } from 'react-router-dom';

/** Where the real thing lives. */
export const COHORTS_PATH = '/app/analytics/cohorts';

export default function LTV() {
  return <Navigate to={COHORTS_PATH} replace />;
}
