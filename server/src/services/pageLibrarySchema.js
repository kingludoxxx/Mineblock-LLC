// PAGE LIBRARY — schema owner (SELF-CONTAINED, NEW FILE).
//
// One table, funnel_page_library: operator-saved page SNAPSHOTS that can be
// cloned into ANY funnel. An entry is a COPY of a funnel_pages row's content
// columns at the instant it was saved — never a live reference — so the entry
// survives its source page being edited, archived, or deleted outright.
//
// ⚠️ THE MISSING FOREIGN KEY IS DELIBERATE. source_funnel_id / source_page_id
// carry PROVENANCE only (they let the canvas ask the existing
// /page-thumbnails/:funnelId/:pageId endpoint for a preview). They are NOT
// references: a REFERENCES funnels(id) here would make deleting a funnel
// either fail or cascade away the library the operator built out of it, which
// is the exact opposite of what a library is for. Readers must treat both as
// possibly-dangling — the thumbnail endpoint already 404s (client falls back
// to its placeholder) and nothing else dereferences them.
//
// Same single-in-flight-promise DDL guard as funnels.js / pageVersionsSchema.js
// / trackingSchema.js: concurrent first requests must not run CREATE TABLE in
// parallel (Postgres throws a pg_type unique violation).
import { pgQuery } from '../db/pg.js';

// Operator-facing metadata caps. Exported so the route and the harness read
// ONE number rather than two that can drift apart.
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const CATEGORY_MAX = 80;
// Hard ceiling on LIVE entries. A library is browsed in one flyout with no
// pagination past `limit`; unbounded growth turns a UI affordance into a table
// scan, and every entry can carry up to 2MB of blocks.
export const LIBRARY_MAX_ENTRIES = 500;

// Advisory-lock key guarding the capacity gate. A count-then-insert is NOT a
// capacity check under READ COMMITTED: N concurrent savers each take their
// snapshot before any of the others commit, all read N-1, and all insert —
// measured at 501/500. Folding the count into the INSERT…SELECT as a subquery
// does not help either, because the subquery reads the SAME snapshot. Only
// serialization does, so every save takes this transaction-scoped advisory lock
// before counting. It is released automatically at COMMIT/ROLLBACK.
//
// The number is arbitrary but must be STABLE — it is the identity of the lock,
// so changing it silently un-serializes every saver running the old code
// against a deployment running the new one.
export const LIBRARY_CAPACITY_LOCK_KEY = 8412207001;

// Per-transaction statement timeout for the library's two write transactions.
//
// DECISION MADE (review m5): client.begin() bypasses pgQuery's circuit breaker
// AND its 8s Promise.race timeout — inside a transaction there is only the
// connection-level statement_timeout of 15s (db/pg.js). 15s is too long to hold
// a FOR UPDATE lock on a funnel row, because every concurrent clone into that
// same funnel queues behind it. So each transaction sets its own SET LOCAL
// ceiling, matching pgQuery's 8s so the two paths degrade on the same clock.
// SET LOCAL reverts at transaction end and never leaks onto the pooled
// connection.
export const TX_STATEMENT_TIMEOUT_MS = 8000;

// Slug budget for a derived clone slug.
//
// funnel_pages.slug is TEXT (no DB truncation) and PAGE_SLUG_RE has no length
// bound, so this is a self-imposed cap — but it has to be imposed on the BASE,
// never on the joined result. Capping the joined string is what made the
// collision retry a no-op: `/${base}-${hex}`.slice(0, 81) with an 80-char base
// truncates the random suffix straight back off, so the retry re-submitted the
// slug that had just raised 23505 and the second violation escaped as a 500.
// Reserving the suffix room up front means every derived form — `/base`,
// `/base-2`, `/base-a1b2` — fits inside the budget by construction.
export const SLUG_BODY_MAX = 80;        // characters after the leading '/'
export const SLUG_SUFFIX_RESERVE = 6;   // '-' + 4 hex, which also covers '-NN'
export const SLUG_BASE_MAX = SLUG_BODY_MAX - SLUG_SUFFIX_RESERVE; // 74
// Fallback category for a save that names none. Stored, never null, so GROUP BY
// and the client's filter pills never have to special-case a null bucket. Kept
// byte-identical to the column DEFAULT in createTables below — a save that goes
// through the route and a row written by a bare INSERT must land in the SAME
// bucket, or the flyout grows two pills that mean the same thing.
export const DEFAULT_CATEGORY = 'Uncategorized';

let tablesReadyPromise = null;

/**
 * Idempotently create the page-library table. Safe to call on every request.
 * @param {(text: string, params?: any[]) => Promise<any[]>} [query] — injected
 *   query fn (defaults to the shared pgQuery); harnesses pass a scoped client.
 */
export function ensurePageLibraryTables(query = pgQuery) {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables(query).catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

// Test-only: drop the memoized promise so a harness can re-run DDL against a
// fresh database inside one process. Never called by the server.
export function __resetPageLibrarySchemaCache() {
  tablesReadyPromise = null;
}

async function createTables(query) {
  // The content columns mirror funnel_pages EXACTLY (blocks + seo + the five
  // escape hatches). That is what makes save and clone a straight column copy
  // in SQL rather than a hand-maintained mapping in JS.
  //
  // ⚠️ Adding a content column to funnel_pages? Add it HERE and in BOTH
  // column lists in routes/pageLibrary.js (save INSERT…SELECT, clone
  // INSERT…SELECT) or the library will silently drop it — the same trap
  // funnels.js flags on its duplicate endpoint.
  await query(`
    CREATE TABLE IF NOT EXISTS funnel_page_library (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Uncategorized',
      type TEXT NOT NULL DEFAULT 'generic',
      blocks JSONB NOT NULL DEFAULT '[]',
      seo JSONB NOT NULL DEFAULT '{}',
      custom_html TEXT NOT NULL DEFAULT '',
      custom_css TEXT NOT NULL DEFAULT '',
      custom_js TEXT NOT NULL DEFAULT '',
      head_html TEXT NOT NULL DEFAULT '',
      body_end_html TEXT NOT NULL DEFAULT '',
      source_funnel_id TEXT,
      source_page_id TEXT,
      source_title TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The browse query walks (archived, created_at DESC) and filters on type /
  // category inside that. One composite index covers the flyout's only read.
  await query(
    `CREATE INDEX IF NOT EXISTS idx_funnel_page_library_browse
       ON funnel_page_library (archived, created_at DESC)`
  );
  // Provenance lookup: "is this page already in the library?" (the node
  // toolbar dims its Save action) is a point read on the source pair.
  await query(
    `CREATE INDEX IF NOT EXISTS idx_funnel_page_library_source
       ON funnel_page_library (source_funnel_id, source_page_id)`
  );
}

// ---------------------------------------------------------------------------
// ⛔ NOT SHIPPED — the exactly-one-home DB constraint (review m4)
//
// The review asked for
//   CREATE UNIQUE INDEX ... ON funnel_pages (funnel_id) WHERE is_home AND NOT archived
// to turn the exactly-one-home convention into a DB fact. It is not here, and
// the reason is a REPRODUCTION, not a preference:
//
//   funnels.js:1172 makes a page home with ONE set-flip statement —
//     UPDATE funnel_pages SET is_home = (id = $2) WHERE funnel_id = $1 AND NOT archived
//   A non-deferrable unique index is checked AFTER EACH ROW, so whether that
//   statement survives depends on the physical order rows happen to be visited
//   in: if the new home is updated before the old one is cleared, both rows are
//   momentarily is_home=TRUE and the statement dies with 23505. Probed against
//   a scratch database: the first flip PASSED and the very next flip FAILED
//   with 23505 on the same three rows. Shipping the index would therefore have
//   broken PATCH /funnels/:id/pages/:pageId {is_home:true} intermittently — in
//   funnels.js, a file this lane is forbidden to edit, and on an endpoint no
//   test in this lane exercises. A non-fatal CREATE INDEX guard does not help:
//   the index creates fine on today's clean data; it is the LATER writes that
//   fail.
//
// A variant that DOES hold was probed and passed 5/5 set-flips while still
// refusing a genuine second home:
//   ALTER TABLE funnel_pages ADD COLUMN home_key TEXT GENERATED ALWAYS AS
//     (CASE WHEN is_home AND NOT archived THEN funnel_id END) STORED;
//   ALTER TABLE funnel_pages ADD CONSTRAINT uq_funnel_pages_home
//     UNIQUE (home_key) DEFERRABLE INITIALLY IMMEDIATE;
// (DEFERRABLE moves the check from per-row to per-statement, which is exactly
// the set-flip's problem; a partial INDEX cannot be deferrable, and a UNIQUE
// CONSTRAINT cannot be partial — hence the generated column.)
//
// It is not shipped either, because it ALTERS THE SHAPE of funnel_pages: every
// `SELECT *` / `RETURNING *` in funnels.js, pageClone.js and pageVersions.js
// would start carrying a home_key field into their API responses. That is a
// cross-lane schema decision, and CLAUDE.md §5 says to stop and coordinate
// rather than take it inside one branch.
//
// What this lane guarantees WITHOUT it: the clone path decides is_home inside
// the INSERT, behind a FOR UPDATE lock on the parent funnel, so two concurrent
// library clones into an empty funnel cannot both become home (pinned by the
// harness). That closes this route; it does not close funnels.js's own unlocked
// COUNT path, which is what the constraint was meant to cover.
// ---------------------------------------------------------------------------

// The projection the LIST endpoint returns: metadata only.
//
// `blocks` can be 2MB per row — a 500-row browse that carried them would be a
// gigabyte response for a flyout that shows names and thumbnails. `bytes` is
// therefore COMPUTED here rather than stored: unlike page versions (where the
// value is measured once at insert), a library entry's content is immutable
// after save, so there is no drift to guard against, and the flyout is opened
// rarely enough that one octet_length pass is cheaper than an extra column
// that a future save path could forget to fill.
//
// block_count uses jsonb_array_length, which reads the JSONB header only.
export const LIBRARY_LIST_COLUMNS = `
  id, name, description, category, type,
  source_funnel_id, source_page_id, source_title, created_by,
  created_at, updated_at,
  CASE WHEN jsonb_typeof(blocks) = 'array' THEN jsonb_array_length(blocks) ELSE 0 END AS block_count,
  octet_length(blocks::text)
    + octet_length(COALESCE(seo::text, ''))
    + octet_length(custom_html) + octet_length(custom_css) + octet_length(custom_js)
    + octet_length(head_html) + octet_length(body_end_html) AS bytes
`;
