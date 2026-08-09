// Split-testing subsystem — ARM ELIGIBILITY (SELF-CONTAINED, NEW FILE).
//
// Which of a funnel's pages may be an arm of a split, and — for the ones that
// may not — WHY. The operator UI greys the ineligible ones and shows the
// reason verbatim, so the reason strings here are load-bearing product copy,
// not debug text.
//
// Ported from funnel-os split_groups_service's create-time invariant:
//   "new arms must all be SCOREABLE — no post-purchase page type, no home
//    page, no page pinned as default_page_id (each of those resolves OUTSIDE
//    the splitter, so it can never be measured)."
//
// The reason that matters is the one in the parenthesis: these pages are not
// banned because they are special, they are banned because traffic reaches
// them WITHOUT passing the splitter. An arm that can be reached without an
// assignment reports impressions against an exposure row that was never
// written — an un-closable gap between the numerator and the denominator.
//
// READ-ONLY. Nothing in this file writes anything, least of all a ledger row.
import { pgQuery } from '../db/pg.js';
import { ensureSplitTables } from './splitTestSchema.js';

// Post-purchase page types. These sit BEHIND the checkout: a visitor arrives
// with a paid session, routed by the funnel's own flow, never by a splitter.
// (An offer-scope split tests those — but it tests the OFFER, not the page.)
export const POST_PURCHASE_TYPES = new Set(['upsell', 'downsell', 'thankyou']);

export const INELIGIBLE_REASONS = {
  post_purchase: 'post-purchase page',
  funnel_default: 'funnel default page',
  archived: 'archived',
  in_other_test: 'already an arm of another split',
};

/**
 * Classify every live page of a funnel as an eligible arm or not.
 *
 * @param {object}  args
 * @param {string}  args.funnelId
 * @param {string}  [args.testId] — the test being edited. Pages that are arms
 *   of THIS test stay eligible (they are the arms); only membership in a
 *   DIFFERENT live test disqualifies.
 * @returns {Promise<{pages: Array, counts: {post_purchase:number, funnel_default:number, in_other_test:number, archived:number, ineligible:number, eligible:number}}>}
 */
export async function listArmEligiblePages({ funnelId, testId = null }, { query = pgQuery } = {}) {
  const fid = String(funnelId ?? '').trim().slice(0, 120);
  if (!fid) return { pages: [], counts: emptyCounts() };
  await ensureSplitTables(query);

  // seo + updated_at ride along for the operator UI: seo.title backs the
  // "use name as title" control, updated_at keys the thumbnail cache.
  const pages = await query(
    `SELECT id, slug, type, title, status, archived, is_home, seo, updated_at
     FROM funnel_pages
     WHERE funnel_id = $1 AND NOT archived
     ORDER BY is_home DESC, slug`,
    [fid]
  );

  // Pages already claimed by a LIVE arm of a live test on this funnel. The
  // test being edited is excluded by id, so its own arms remain selectable.
  const claimed = await query(
    `SELECT DISTINCT a.page_id, a.test_id
     FROM lb_split_arms a
     JOIN lb_split_tests t ON t.id = a.test_id
     WHERE t.funnel_id = $1 AND NOT t.archived AND NOT a.archived
       AND a.page_id IS NOT NULL
       AND ($2::text IS NULL OR a.test_id <> $2)`,
    [fid, testId ? String(testId).slice(0, 120) : null]
  );
  const claimedBy = new Map(claimed.map((r) => [r.page_id, r.test_id]));

  const counts = emptyCounts();
  const out = pages.map((p) => {
    // FIRST match wins and the order is deliberate: a home page that is ALSO
    // a thankyou page is reported as the funnel default, because that is the
    // reason the operator can actually act on.
    let reason = null;
    if (p.archived) reason = 'archived';
    else if (p.is_home) reason = 'funnel_default';
    else if (POST_PURCHASE_TYPES.has(String(p.type))) reason = 'post_purchase';
    else if (claimedBy.has(p.id)) reason = 'in_other_test';

    if (reason) counts[reason] += 1;
    return {
      id: p.id,
      slug: p.slug,
      type: p.type,
      title: p.title,
      status: p.status,
      is_home: p.is_home,
      seo: p.seo || {},
      updated_at: p.updated_at,
      eligible: reason === null,
      reason,
      reason_label: reason ? INELIGIBLE_REASONS[reason] : null,
      in_test_id: claimedBy.get(p.id) || null,
    };
  });

  counts.ineligible = out.filter((p) => !p.eligible).length;
  counts.eligible = out.length - counts.ineligible;
  return { pages: out, counts };
}

function emptyCounts() {
  return { post_purchase: 0, funnel_default: 0, in_other_test: 0, archived: 0, ineligible: 0, eligible: 0 };
}

// ── Handle validation ──────────────────────────────────────────────────────
// The handle becomes a URL PATH SEGMENT. Bounding it to this charset is what
// makes it safe to interpolate into a link anywhere in the UI without
// encoding, and stops a hostile handle from smuggling a path traversal, a
// scheme, a query string or control characters into a route.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Segments the platform already owns. A split handle that shadows one of these
// either never receives traffic (the platform route wins) or, worse, shadows
// the platform route — and either way the operator's link silently does
// something other than what the setup modal promises. Refused at write time so
// the collision is a 422 the operator can read, not a mystery in production.
export const RESERVED_HANDLES = new Set([
  'api', 'f', 'app', 'admin', 'login', 'assets', 'static', 'checkout', 'www',
]);

/**
 * Normalise an operator-typed handle. Accepts a leading '/', lowercases, and
 * REJECTS anything that is not a clean single segment (it never silently
 * rewrites a bad handle into a different valid one — a truncated handle is a
 * different route, and the operator would never see the swap).
 * @returns {{handle: string|null}|{error: string}}
 */
export function normHandle(raw) {
  if (raw === null || raw === undefined || raw === '') return { handle: null };
  let v = String(raw).trim();
  if (v.startsWith('/')) v = v.slice(1);
  v = v.toLowerCase();
  if (v === '') return { handle: null };
  if (!HANDLE_RE.test(v)) return { error: 'invalid_handle' };
  if (RESERVED_HANDLES.has(v)) return { error: 'handle_reserved' };
  return { handle: v };
}

/**
 * Does this handle collide with a live PAGE slug on the same funnel?
 *
 * A page slug is stored as '/foo'; a split handle is served at '/foo' too. Both
 * are currently accepted independently, so `handle: 'shadow'` and a page
 * `/shadow` can coexist and the serve layer would have to pick one — a coin
 * flip decided by route order, months after the operator set it up. Checked at
 * write time instead.
 *
 * @returns {Promise<boolean>} true when a live page already owns that path.
 */
export async function handleCollidesWithPageSlug(
  { funnelId, handle },
  { query = pgQuery } = {}
) {
  if (!handle || !funnelId) return false;
  const rows = await query(
    `SELECT 1 FROM funnel_pages
     WHERE funnel_id = $1 AND NOT archived AND slug = $2
     LIMIT 1`,
    [String(funnelId).slice(0, 120), `/${handle}`]
  );
  return rows.length > 0;
}

// A domain is a host, never a URL. Same argument as the handle: bounded so it
// can be rendered and compared without escaping. Blank means "funnel default".
export const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** @returns {{domain: string|null}|{error: string}} */
export function normDomain(raw) {
  if (raw === null || raw === undefined || raw === '') return { domain: null };
  const v = String(raw).trim().toLowerCase();
  if (v === '') return { domain: null };
  if (!DOMAIN_RE.test(v)) return { error: 'invalid_domain' };
  return { domain: v };
}
