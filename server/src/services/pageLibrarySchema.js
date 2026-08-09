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
