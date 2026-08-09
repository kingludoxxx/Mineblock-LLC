// PURE COPY + OPTION HELPERS for the split creation/management/canvas surfaces.
//
// Everything in here is a total function of its arguments — no React, no `api`,
// no DOM. That is deliberate: `scripts/verifySplitUiGuards.mjs` imports this
// file DIRECTLY (no stubbing) and exercises every branch, which is only
// possible while it stays free of Vite-only extensionless imports.
//
// DASH is re-declared rather than imported from splitApi.js for exactly that
// reason (splitApi imports `../../../services/api`, which node cannot resolve).
// `assertDashParity` below is the executable guard against the two drifting.
export const DASH = '—';

// ── Canvas node copy ───────────────────────────────────────────────────────

/**
 * The grouped canvas node's header: "<handle> A/B".
 * No leading slash — the reference tool titles the group, it does not print a
 * route there (the route is what the setup modal's handle field owns).
 */
export function splitNodeTitle(handle) {
  const h = typeof handle === 'string' ? handle.trim().replace(/^\/+/, '') : '';
  return `${h || 'split'} A/B`;
}

/**
 * The letters chip under the node: "A/B", "A/B/C", or DASH with no arms.
 * Accepts arm objects ({ letter }) or bare strings.
 */
export function armLettersChip(arms) {
  const letters = (Array.isArray(arms) ? arms : [])
    .map((a) => (typeof a === 'string' ? a : a?.letter))
    .filter((l) => typeof l === 'string' && l.length > 0)
    .map((l) => l.toUpperCase());
  return letters.length ? letters.join('/') : DASH;
}

/**
 * A rate that the LABEL already carries the unit for ("CTR %", "CVR %") —
 * one decimal, no percent sign in the value. Reference formatting.
 *
 * `undefined`/`null`/non-finite → DASH. A measurement we do not have must
 * never render as 0.0, which reads as "measured, and it was zero".
 */
export function fmtRate1(v) {
  if (v === undefined || v === null || v === '') return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return n.toFixed(1);
}

/** A count for a canvas tile — thousands-separated, DASH when unmeasured. */
export function fmtCount(v) {
  if (v === undefined || v === null || v === '') return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return Math.round(n).toLocaleString('en-US');
}

// ── Page-picker copy (quick-create B, per-arm "Choose / import page",
//    and the add-arm column's "Import existing page") ──────────────────────

/** "Lead Page · /lead" — the option label every split page picker uses. */
export function pageOptionLabel(page) {
  const title = (page?.title || '').trim() || 'Untitled';
  const slug = (page?.slug || '').trim();
  return slug ? `${title} · ${slug}` : title;
}

/**
 * The full option text, INCLUDING the reason an option cannot be chosen and
 * the warning that a draft arm will not serve. Ineligible pages are LISTED
 * (disabled), never hidden — an option that vanishes is unexplainable.
 */
export function pageOptionText(page) {
  const base = pageOptionLabel(page);
  if (page && page.eligible === false) return `${base} — ${page.reason_label || 'cannot be an arm'}`;
  if (page && page.status && page.status !== 'published') {
    return `${base} · draft (won't serve until published)`;
  }
  return base;
}

/**
 * Split the funnel's pages into what a picker may offer and what it must grey
 * out. `currentPageId` is kept offerable so an arm's own page still shows as
 * the select's current value.
 */
export function partitionArmPages({ pages, liveArms = [], currentPageId = null } = {}) {
  const armPageIds = new Set(
    (Array.isArray(liveArms) ? liveArms : [])
      .map((a) => a?.page_id)
      .filter((pid) => pid && pid !== currentPageId)
  );
  const all = Array.isArray(pages) ? pages : [];
  return {
    importable: all.filter((p) => p?.eligible && !armPageIds.has(p.id)),
    ineligible: all.filter((p) => p && !p.eligible),
  };
}

/** "2 post-purchase, 1 funnel default, 1 in another split" — omits zeroes. */
export function ineligibleCountsPhrase(counts) {
  const c = counts || {};
  return [
    c.post_purchase ? `${c.post_purchase} post-purchase` : null,
    c.funnel_default ? `${c.funnel_default} funnel default` : null,
    c.in_other_test ? `${c.in_other_test} in another split` : null,
  ].filter(Boolean).join(', ');
}

/**
 * The next split letter for the "+ Add Split C" column. A, B, C … Z, then AA.
 * Mirrors splitApi's armLetter so the column header and the arm_key the modal
 * mints cannot disagree.
 */
export function nextSplitLetter(liveArmCount) {
  const n = Number(liveArmCount);
  const i = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  let s = '';
  let x = i;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
}

/**
 * Executable invariant for the harness: this module's DASH must be the SAME
 * character splitApi renders, or a canvas tile and a modal tile would print
 * two different "no measurement" glyphs. Pass splitApi's DASH in.
 */
export function assertDashParity(otherDash) {
  return otherDash === DASH
    ? []
    : [`DASH drift: splitUiCopy has ${JSON.stringify(DASH)}, splitApi has ${JSON.stringify(otherDash)}`];
}
