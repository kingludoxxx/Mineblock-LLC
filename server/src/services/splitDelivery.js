// Split-testing subsystem — DELIVERY (the causal half).
//
// funnel-os serves a split by intercepting the group's route: `resolve_split_page`
// matches the request path against the group slug, stickily picks an arm, and
// serves that arm's page (inline when the arm owns the slug, 302 otherwise).
// This port delivers INLINE ONLY — the visitor stays on /<handle> and receives
// the assigned arm's page — which funnel-os supports behind LB_SPLIT_INLINE_ARMS
// and which sidesteps the whole 302/return-leg/coverage-asymmetry machinery.
//
// Stickiness needs no cookie map: assignment is a pure hash of
// (visitor id, test id) — the same visitor always gets the same arm, on every
// hop, forever (splitResolver.js). What IS minted here is the visitor id
// itself when a first-touch server render has none (client tracking mints it
// too late for the very first page).
//
// FAIL-OPEN END TO END (DECISIONS #16 "fail open for serving"): every function
// returns null / does nothing on any error. A split outage must cost a
// measurement, never the traffic. The caller falls through to normal
// slug serving unbranched.
import { pgQuery } from '../db/pg.js';
import { ensureSplitTables } from './splitTestSchema.js';
import { pickArm } from './splitResolver.js';

/**
 * Match a live page-scope split on this funnel whose handle owns the requested
 * path, stickily pick the visitor's arm, and return the arm's LIVE page row.
 *
 * Eligibility mirrors funnel-os: only arms whose page is published and not
 * archived are servable. A chosen arm whose page has gone dark is re-picked
 * among the remaining live arms (deterministically — the hash re-runs over the
 * smaller set), so a mid-test unpublish degrades the test, never the traffic.
 *
 * The ENTRY arm (falling back to control) serves two non-experiment cases
 * deterministically: a request whose visitor id is genuinely empty, and a
 * PAUSED test (which keeps owning its route — see below).
 *
 * @param {{funnelId:string, relPath:string, visitorId:string}} p
 *   relPath is mount-relative with a leading '/' (funnelPublic's convention).
 * @returns {Promise<{test:object, arm:object, page:object}|null>} null = no
 *   live split owns this path (or anything failed) — serve normally.
 */
export async function resolvePageSplit(
  { funnelId, relPath, visitorId },
  { query = pgQuery } = {}
) {
  try {
    if (!funnelId || !relPath) return null;
    // Handles are stored WITHOUT the leading slash ('tp-fb-lp1'); the request
    // path arrives with one. Single-segment only — a nested path can't be a
    // handle (same rule as page slugs).
    const path = String(relPath).replace(/^\//, '').toLowerCase();
    if (!path || path.includes('/')) return null;
    await ensureSplitTables(query);

    // NOT filtered on `enabled`: a PAUSED (disabled, non-archived) test still
    // OWNS its route — live ads point at /<handle> and a pause must never 404
    // the traffic. A paused test serves its entry/control arm unbranched (no
    // view recorded, no experiment). Only archiving releases the route.
    const [test] = await query(
      `SELECT id, funnel_id, handle, enabled FROM lb_split_tests
       WHERE funnel_id = $1 AND scope = 'page' AND handle = $2 AND NOT archived
       LIMIT 1`,
      [String(funnelId).slice(0, 64), path.slice(0, 120)]
    );
    if (!test) return null;

    const arms = await query(
      `SELECT id, arm_key, weight, page_id, offer_id, is_control, is_entry, archived
       FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
      [test.id]
    );
    if (!arms.length) return null;

    // A paused test pins everyone to the entry/control arm — deterministic,
    // unbranched serving that keeps the route alive with zero measurement.
    const paused = !test.enabled;

    // Deterministic pick, then verify the arm's page is actually servable.
    // An unservable arm — dark page, archived page, OR a null/dangling
    // page_id — is filtered out and the pick re-runs over the remainder, so a
    // misconfigured arm degrades the test, never the traffic.
    let candidates = arms;
    while (candidates.length) {
      const arm = (visitorId && !paused)
        ? pickArm(visitorId, test.id, candidates)
        : (candidates.find((a) => a.is_entry) || pickArm('', test.id, candidates));
      if (!arm) return null;
      if (!arm.page_id) { candidates = candidates.filter((a) => a !== arm); continue; }
      const [page] = await query(
        `SELECT * FROM funnel_pages
         WHERE id = $1 AND funnel_id = $2 AND NOT archived AND status = 'published'`,
        [String(arm.page_id), String(funnelId)]
      );
      if (page) return { test, arm, page, paused };
      candidates = candidates.filter((a) => a !== arm);
    }
    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitDelivery] resolvePageSplit failed (fail-open):', err.message);
    return null;
  }
}

/**
 * Count the delivered render — the "Visitors" denominator of a page-scope
 * test. One row per (test, visitor), first touch wins (assignment is sticky,
 * so the arm can never differ on a later view). Idempotent, fail-open,
 * fire-and-forget from the serve path.
 *
 * @returns {Promise<'recorded'|'duplicate'|'refused'|'failed'>}
 */
export async function recordView(
  { testId, armKey, visitorId },
  { query = pgQuery } = {}
) {
  const tidV = String(testId || '').trim().slice(0, 120);
  const arm = String(armKey || '').trim().slice(0, 32);
  const vid = String(visitorId || '').trim().slice(0, 120);
  if (!tidV || !arm || !vid) return 'refused';
  try {
    await ensureSplitTables(query);
    const rows = await query(
      `INSERT INTO lb_split_views (test_id, visitor_id, arm_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (test_id, visitor_id) DO NOTHING
       RETURNING test_id`,
      [tidV, vid, arm]
    );
    // First delivered render = the test's DELIVERY EPOCH. Idempotent one-time
    // stamp; the verdict engine refuses/clamps windows before this instant
    // (exposures recorded while arms served identical content are noise).
    if (rows.length) {
      await query(
        `UPDATE lb_split_tests SET delivery_epoch_at = NOW()
         WHERE id = $1 AND delivery_epoch_at IS NULL`,
        [tidV]
      );
    }
    return rows.length ? 'recorded' : 'duplicate';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[splitDelivery] recordView failed:', err.message);
    return 'failed';
  }
}
