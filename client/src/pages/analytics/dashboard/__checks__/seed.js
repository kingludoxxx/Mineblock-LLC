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
