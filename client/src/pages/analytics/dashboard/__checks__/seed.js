// seed — the render harness's payloads, CAPTURED (not authored)
// (LANE 3, verification only — never imported by the app).
//
// ── THE META-FIX ────────────────────────────────────────────────────────────
//
// This file used to contain ~280 lines of hand-written fixture. Every honesty
// rule passed against it and three readers were still wrong, because the
// fixture encoded the same misunderstanding the readers did — it asserted
// `gross_sales` on breakdown rows that carry `net_sales`, a scalar `total` on a
// breakdown that nests `totals`, and string warnings in an array of
// `{source, reason}` objects. A fixture an author invents agrees with whatever
// that author believed; it can prove behaviour and it CANNOT prove shape.
//
// So there is no fixture here any more. Everything below is a named view onto
// ./seed.generated.json, which ./captureSeed.mjs produces by calling Lane 1's
// `runDashboard`/`runBand` and Lane 2's `getMarketing` against a real Postgres
// (Lane 1's own engine-harness fixture, so these seeds inherit the SERVER
// lane's edge cases rather than this lane's guesses about them).
//
// Re-capture after any server-lane change:
//     node client/src/pages/analytics/dashboard/__checks__/captureSeed.mjs
//
// If a lane renames a key, the capture changes, the render check fails loudly,
// and the drift is caught at the boundary instead of being rendered as an
// em dash that looks like an honest withholding.
import captured from './seed.generated.json';

/** Provenance — which commits and which window these payloads came from. */
export const CAPTURE = captured.captured_from;
export const CAPTURE_WINDOWS = captured.windows;

/**
 * A. THE EVERYDAY WINDOW — 30 REPORT_TZ days ending today, fully measured.
 * Real funnel names, real net_sales money column, real `total_metric`, real
 * `rows_total`, real `band.in_window`.
 */
export const SEED_DASHBOARD = captured.dashboard;

/**
 * B. A WINDOW PAST THE 90-DAY TOUCH RETENTION — the state the TTL note, the
 * withheld sessions column and `meta.sessions_unknown` all hang off.
 *
 * The hand-written version of this claimed `sessions_unknown:false` beside
 * withheld sessions, which is a payload the server cannot emit: the real one
 * carries `sessions_unknown:true` AND two `{source, reason}` warnings
 * (lb_touches and sessions). That contradiction is exactly the class of
 * impossible fixture capturing removes.
 */
export const TTL_DASHBOARD = captured.dashboard_ttl;

/**
 * C. EVERY MEASURABLE QUANTITY WITHHELD — derived from A by nulling every
 * numeric leaf, keys and strings untouched.
 *
 * DERIVED, NOT AUTHORED, and the distinction matters: the SHAPE is the
 * server's (that is the part that drifts) and only the measurements are forced
 * to the withheld case, which is the thing under test. Nothing here asserts a
 * key that the server does not emit.
 */
export const WITHHELD_DASHBOARD = captured.withheld;

/** D. The heartbeat's own payload — its window is always [yesterday, today]. */
export const SEED_BAND = captured.band;

/** E. Lane 2's campaign bars — fully attributed in this fixture. */
export const SEED_MARKETING = captured.marketing;

/**
 * F. The dimension whose REAL fold contains both unattributed states:
 *   'direct / none' -> attribution 'none'     (nothing measured)
 *   '(not set)'     -> attribution 'untagged' (visit seen, dimension not tagged)
 *
 * Two different diagnoses that look identical on a bar chart, which is why the
 * card has to name them separately. Captured rather than constructed, so the
 * labels are the server's own disambiguated ones.
 */
export const SEED_MARKETING_UNATTRIBUTED = captured.marketing_unattributed;
export const SEED_MARKETING_UNATTRIBUTED_DIMENSION = captured.marketing_unattributed_dimension;

/** Every dimension's fold, for checks that need to pick one. */
export const SEED_MARKETING_BY_DIMENSION = captured.marketing_by_dimension;

/* ══════════════════════════════════════════════════════════════════════════
 * LANE 5 — the insight layer's payloads, captured the same way and for the
 * same reason (./captureInsightsSeed.mjs).
 *
 * Re-capture after any insight/cohort service change:
 *     node client/src/pages/analytics/dashboard/__checks__/captureInsightsSeed.mjs
 * ═════════════════════════════════════════════════════════════════════════ */
import capturedInsights from './insights.seed.generated.json';

export const INSIGHT_CAPTURE = capturedInsights.captured_from;
export const INSIGHT_WINDOWS = capturedInsights.windows;

/**
 * G. THE EVERYDAY STRIP — several detectors fired, and by luck of the fixture
 * ALL FOUR SEVERITIES are present (bad · warn · good · info), which is exactly
 * what the ranking assertion needs and is not something an author would have
 * thought to stage.
 */
export const SEED_INSIGHTS = capturedInsights.insights;

/** H. The same day scoped to one funnel — a strictly smaller card set. */
export const SEED_INSIGHTS_SCOPED = capturedInsights.insights_scoped;

/**
 * I. NOTHING FIRED — DERIVED from G by emptying the card list while leaving
 * every detector marked as HAVING RUN. It cannot be captured: the detectors are
 * good enough that even a two-order funnel legitimately fires, and a fixture
 * empty enough to silence all six produces the DEGRADED state instead — which
 * is the one thing this state must not look like.
 */
export const SEED_INSIGHTS_NONE = capturedInsights.insights_none;

/**
 * J. A DETECTOR THAT COULD NOT RUN. Captured by making the step read genuinely
 * throw, so `meta.degraded` and `detectors[].ran:false` are the SERVICE'S own
 * output with its own wording — not this file's guess at it.
 */
export const SEED_INSIGHTS_DEGRADED = capturedInsights.insights_degraded;

/**
 * K. THE COHORT TABLE, carrying BOTH ages at once: a cohort acquired today
 * (aged [4,0,0,0] — D7/D30/D90 are NULL) beside one acquired 100 days ago (aged
 * at every horizon). Those nulls are the aging guard, and they are the single
 * most important cells in this seed: the render check asserts they draw an em
 * dash and that "$0.00" appears nowhere near them.
 */
export const SEED_COHORTS = capturedInsights.cohorts;
export const SEED_COHORTS_BY_FUNNEL = capturedInsights.cohorts_by_funnel;
export const SEED_COHORTS_BY_CAMPAIGN = capturedInsights.cohorts_by_campaign;

/** L. A window with no acquisitions — the genuine empty state, captured. */
export const SEED_COHORTS_EMPTY = capturedInsights.cohorts_empty;
