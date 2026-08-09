// PAGE LIBRARY — pure model. No React, no imports: everything here is a
// function of its arguments, so it is unit-testable from a node harness the
// same way codeFormat.js / versionFormat.js are (see
// server/tests/page-library/library-model.mjs).
//
// The band layout is ported from funnel-os's PageLibraryPanel GROUPS and
// remapped onto OUR page-type enum (server/src/routes/funnels.js PAGE_TYPES:
// listicle | lead | quiz | checkout | upsell | downsell | thankyou | generic |
// optin | storefront). His "Portal" band has no counterpart — the canvas
// palette maps Customer Portal onto `generic` — so it is folded into
// Survey / Generic rather than shown as a band that can never fill.

export const GROUPS = [
  { label: 'Quiz', types: ['quiz'] },
  { label: 'Listicle / Advertorial', types: ['listicle', 'lead'] },
  { label: 'Upsell / Downsell', types: ['upsell', 'downsell'] },
  { label: 'Product / Storefront', types: ['storefront'] },
  { label: 'Checkout', types: ['checkout'] },
  { label: 'Survey / Generic', types: ['generic', 'optin'] },
  { label: 'Thank You', types: ['thankyou'] },
];

export const OTHER_LABEL = 'Other';

const KNOWN_TYPES = new Set(GROUPS.flatMap((g) => g.types));

/**
 * Bucket a funnel's pages into the display bands, in GROUPS order, dropping
 * empty bands.
 *
 * Two properties are load-bearing and are what the harness pins:
 *
 *   1. NOTHING IS EVER DROPPED. A page whose type no band names (a new enum
 *      value, a legacy row, a null) still lands — in a trailing "Other" band.
 *      A page the operator can see on the canvas but cannot find in the library
 *      would read as data loss, and silently swallowing it is the easy bug.
 *   2. Order inside a band follows the INPUT order, which the funnels API
 *      already sorts (is_home DESC, created_at ASC). Re-sorting here would make
 *      the library disagree with the Pages tab about which page is "first".
 *
 * @param {Array<{id?: string, type?: string}>} pages
 * @returns {Array<{label: string, items: Array<object>}>}
 */
export function groupPagesByBand(pages) {
  const byType = new Map();
  const other = [];
  for (const p of Array.isArray(pages) ? pages : []) {
    // A HOLE IS NOT A PAGE. Property 1 above says nothing is dropped, and a
    // null/primitive entry looks like it should therefore be kept — but the
    // renderer keys each tile on `p.id` and reads `p.title`, so a kept null is
    // a crash, not a preserved page. "Nothing is dropped" is a promise about
    // PAGES; a hole in the array is not one. (The harness caught this by
    // crashing on exactly this input.)
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue;
    // A missing type is `generic` everywhere else in this codebase
    // (funnel_pages.type DEFAULT 'generic'), so it is generic here too — an
    // absent value is a default, not an unknown.
    const raw = p.type;
    const t = raw === undefined || raw === null || raw === '' ? 'generic' : String(raw);
    if (KNOWN_TYPES.has(t)) {
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(p);
    } else {
      other.push(p);
    }
  }
  const bands = GROUPS.map((g) => ({
    label: g.label,
    items: g.types.flatMap((t) => byType.get(t) || []),
  })).filter((g) => g.items.length > 0);
  if (other.length) bands.push({ label: OTHER_LABEL, items: other });
  return bands;
}

/**
 * Human byte size for a library entry's stored weight.
 *
 * An UNKNOWN size renders as an em dash, never as "0 B" — the same rule the
 * canvas metric chips follow (pages/analytics/format.js): null means "could not
 * measure", and telling an operator their 400KB page is empty is worse than
 * telling them nothing.
 */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Pluralised page count for the rail sub-label ("45 pages · drag to clone").
 * The reference tool derives this live from the loaded page array — it is NOT
 * a stored total, and a non-array must read as 0 rather than as NaN.
 */
export function pageCountLabel(pages) {
  const n = Array.isArray(pages) ? pages.length : 0;
  return `${n} page${n === 1 ? '' : 's'}`;
}
