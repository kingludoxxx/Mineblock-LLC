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

// The rate sample floor the analytics service itself uses
// (analyticsStats.MIN_RATE_SAMPLE). Mirrored, not imported — this is client
// code — and pinned by a harness assertion against the server constant.
export const MIN_RATE_SAMPLE = 30;

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

/** "1 arm" / "2 arms" — a count and its noun agree. */
export function armCountLabel(n) {
  const c = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
  return `${c} ${c === 1 ? 'arm' : 'arms'}`;
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

// ── The canvas tile spec ───────────────────────────────────────────────────
// The three tiles are DATA, not JSX, so the harness can assert the rendered
// labels and tooltips instead of grepping the component for them. SplitGroupNode
// maps over CANVAS_TILES; there is no second list to drift from this one.

/**
 * Where a tile's numbers came from. The two sources count DIFFERENT things and
 * the tooltip must say which, so a per-arm figure is never explained with the
 * other source's definition.
 *
 *  'overlay' — funnelAnalytics' per-arm rows. Its `visitors` is a checkout-mint
 *              count (`submits: visitors`, "an exposure IS a checkout mint here"),
 *              i.e. visitors who REACHED CHECKOUT — the results modal's own
 *              wording for the same number.
 *  'ledger'  — lb_split_credits exposure rows: visitors ASSIGNED to the arm by
 *              the splitter, whether or not they went any further.
 */
export const TILE_SOURCES = ['overlay', 'ledger'];

const VISITORS_TITLE = {
  overlay:
    "Visitors who reached checkout on this arm, over the test's lifetime. Bot-inclusive. Blank means nothing was recorded, not zero.",
  ledger:
    "Visitors assigned to this arm by the splitter, over the test's lifetime. Bot-inclusive. Blank means nothing was recorded, not zero.",
};

const CTR_TITLE =
  'No per-ARM click is recorded: the split ledger has never carried one, and the analytics service returns a constant for a per-arm click rate. The per-PAGE ctr does exist, but it is a labelled proxy over a different window, so showing it here would answer a question nobody asked. Left blank as a product call.';

const CVR_TITLE_BASE =
  "Conversions ÷ visitors over the test's lifetime. Blank means the source withheld it (too small a sample) or recorded nothing — never zero.";

/**
 * The three canvas tiles, in reference order. `value`/`title` are functions of
 * one arm so the harness can render them without React.
 */
export const CANVAS_TILES = [
  {
    key: 'visitors',
    label: 'Visitors',
    value: (arm) => fmtCount(arm?.visitors),
    title: (arm) => VISITORS_TITLE[arm?.source] || VISITORS_TITLE.ledger,
  },
  {
    key: 'ctr',
    label: 'CTR %',
    value: (arm) => fmtRate1(arm?.ctr),
    title: () => CTR_TITLE,
  },
  {
    key: 'cvr',
    label: 'CVR %',
    value: (arm) => fmtRate1(arm?.cvr),
    title: (arm) => {
      const parts = [CVR_TITLE_BASE, `Orders: ${fmtCount(arm?.orders)}.`];
      if (arm?.cvr_withheld) {
        parts.push(`Withheld below ${MIN_RATE_SAMPLE} visitors — a rate off a handful of visitors reads as precision and is noise.`);
      }
      if (arm?.cvr_clamped) {
        parts.push('The denominator was floored by the conversion count: a rate over 100% is a lost beacon, not a fact.');
      }
      return parts.join(' ');
    },
  },
];

/** Just the labels, for a cheap parity assertion. */
export const CANVAS_TILE_LABELS = CANVAS_TILES.map((t) => t.label);

/**
 * The ledger-fallback CVR, held to the SAME rules the analytics service applies
 * in overlay mode — otherwise the same arm reports a rate under one source that
 * the other would have refused to state.
 *
 *  • CLAMP: you cannot convert without being exposed, so the denominator is
 *    floored by the numerator. A rate over 100% is a lost beacon, not a fact.
 *  • WITHHOLD: below MIN_RATE_SAMPLE the rate is not reported at all.
 *
 * @returns {{cvr: number|undefined, cvr_withheld: boolean, cvr_clamped: boolean}}
 */
export function ledgerCvr({ exposures, conversions } = {}) {
  const exp = Number(exposures);
  const conv = Number(conversions);
  const e = Number.isFinite(exp) && exp > 0 ? exp : 0;
  const c = Number.isFinite(conv) && conv > 0 ? conv : 0;
  const denom = Math.max(e, c);
  if (denom <= 0) return { cvr: undefined, cvr_withheld: false, cvr_clamped: false };
  const clamped = denom > e;
  if (denom < MIN_RATE_SAMPLE) return { cvr: undefined, cvr_withheld: true, cvr_clamped: clamped };
  return { cvr: (c / denom) * 100, cvr_withheld: false, cvr_clamped: clamped };
}

// ── Page-picker copy (quick-create B, per-arm "Choose / import page",
//    and the add-arm column's "Import existing page") ──────────────────────

/**
 * THE eligibility predicate. One definition, used everywhere, keyed on an
 * EXPLICIT `false`: a page whose eligibility the server did not state is not
 * thereby ineligible. Since the PATCH route now guards arm assignment itself
 * (splitTests.js assertArmPageAssignable), offering an unclassified page is
 * safe — the server refuses it with a named reason — whereas hiding it is not,
 * because the operator cannot ask about an option that is not there.
 */
export function isIneligible(page) {
  return page?.eligible === false;
}

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
  if (isIneligible(page)) return `${base} — ${page.reason_label || 'cannot be an arm'}`;
  if (page && page.status && page.status !== 'published') {
    return `${base} · draft (won't serve until published)`;
  }
  return base;
}

/** The reason a same-test sibling page cannot be picked. Rendered, not hidden. */
export const SAME_TEST_REASON = 'already an arm of this test';

/** Option text for a page held by ANOTHER live arm of the SAME test. */
export function sameTestOptionText(page) {
  return `${pageOptionLabel(page)} — ${SAME_TEST_REASON}`;
}

/**
 * Split the funnel's pages into what a picker may offer, what it must grey out
 * for the server's stated reason, and what it must grey out because ANOTHER arm
 * of this same test already holds it.
 *
 * The third bucket exists because those pages used to simply vanish: the server
 * calls them eligible (they are arms of the test being edited), so filtering
 * them silently left the operator looking for a page that was on screen a
 * moment ago with no explanation. They are now rendered, disabled, with the
 * reason — and the server refuses the same assignment with page_already_an_arm.
 *
 * `currentPageId` is kept offerable so an arm's own page still shows as the
 * select's current value.
 */
export function partitionArmPages({ pages, liveArms = [], currentPageId = null } = {}) {
  const armPageIds = new Set(
    (Array.isArray(liveArms) ? liveArms : [])
      .map((a) => a?.page_id)
      .filter((pid) => pid && pid !== currentPageId)
  );
  const all = (Array.isArray(pages) ? pages : []).filter(Boolean);
  const ineligible = all.filter(isIneligible);
  const rest = all.filter((p) => !isIneligible(p));
  return {
    importable: rest.filter((p) => !armPageIds.has(p.id)),
    sameTest: rest.filter((p) => armPageIds.has(p.id)),
    ineligible,
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

// ── Arm keys and the "+ Add Split C" header ────────────────────────────────

/**
 * The arm_key the modal will mint next: the FIRST UNUSED letter among the live
 * arms, not the next index.
 *
 * These two disagree whenever an arm in the middle was archived — live arms
 * a and c means the next key is 'b', while a count-based letter would say 'c'.
 * The header used to be count-based while the POST was first-unused, so the
 * column promised "Add Split C" and the server minted arm 'b'. ONE function
 * now answers both, so they cannot drift again.
 */
export function nextArmKey(liveArms) {
  const used = new Set(
    (Array.isArray(liveArms) ? liveArms : [])
      .map((a) => (typeof a === 'string' ? a : a?.arm_key))
      .filter((k) => k !== undefined && k !== null)
      .map((k) => String(k).toLowerCase())
  );
  for (let i = 0; i < 26 * 27; i += 1) {
    const k = indexLetter(i).toLowerCase();
    if (!used.has(k)) return k;
  }
  return `arm${Date.now()}`;
}

/** The letter shown in the "+ Add Split <X>" header — nextArmKey, upper-cased. */
export function nextSplitLetter(liveArms) {
  return nextArmKey(liveArms).toUpperCase();
}

/**
 * Letter for an index: A, B, C … then AA. Mirrors splitApi.armLetter; the
 * harness pins them together so the two cannot drift.
 */
export function indexLetter(index) {
  const n = Number(index);
  let i = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  let s = '';
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}

/**
 * May this arm's page be re-pointed? NOT an index test.
 *
 * The CONTROL arm is the baseline every other arm is measured against, so
 * swapping its page would change what the comparison MEANS without changing a
 * single number on screen. Keying this on position was wrong twice over: the
 * control is not necessarily first (POST .../control can move it), and arm
 * order is a display concern (`ORDER BY archived, sort_order, arm_key`) that an
 * operator can reshuffle.
 */
export function canChoosePage(arm) {
  return Boolean(arm) && !arm.is_control;
}

/**
 * The sentence shown before an arm's page is re-pointed. Names BOTH pages and
 * what survives the change — the same posture /promote takes (an explicit
 * confirm), because this write is just as live.
 */
export function repointConfirmText({ letter, fromPage, toPage } = {}) {
  const from = fromPage ? pageOptionLabel(fromPage) : 'no page';
  const to = toPage ? pageOptionLabel(toPage) : 'no page';
  return `Arm ${letter || '?'} will serve ${to} instead of ${from}. Traffic already assigned to arm ${letter || '?'} stays with the arm, and every figure recorded so far keeps counting toward it.`;
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
