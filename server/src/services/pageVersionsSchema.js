// PAGE VERSIONS — schema owner (SELF-CONTAINED, NEW FILE).
//
// One table, lb_page_versions: an append-only stack of page snapshots taken
// from funnel_pages. A version is a COPY of the page's content columns at an
// instant, never a diff — restoring is therefore a plain column write, with
// no replay to get wrong.
//
// THE INVARIANT THAT MAKES RESTORE SAFE: a restore ALWAYS snapshots the
// CURRENT state first, in the SAME transaction that overwrites it. There is
// no window in which the pre-restore content exists nowhere. If the UPDATE
// rolls back, the 'before restore' row rolls back with it — the ledger never
// grows a snapshot for a restore that did not happen.
//
// RETENTION: newest 30 per page. The prune runs INSIDE the writing
// transaction (writeVersion below), not on a sweep — a page edited in a burst
// must never be able to outrun a background pruner and grow unbounded, and a
// pruned row must never be visible to a reader that the insert is not.
//
// Same single-in-flight-promise DDL guard as funnels.js / checkoutSchema.js /
// trackingSchema.js: concurrent first requests must not run CREATE TABLE in
// parallel (Postgres throws a pg_type unique violation).
import { pgQuery } from '../db/pg.js';

// Newest N versions kept per page. Exported so the route and the harness read
// ONE number rather than two that can drift apart.
export const VERSION_RETENTION = 30;

// A label is an operator hint ('before AI edit', 'autosnap', 'before restore'),
// not content — cap it so a hostile client cannot store a novel in it.
export const LABEL_MAX = 120;

let tablesReadyPromise = null;

/**
 * Idempotently create the page-versions table. Safe to call on every request.
 * @param {(text: string, params?: any[]) => Promise<any[]>} [query] — injected
 *   query fn (defaults to the shared pgQuery); harnesses pass a scoped client.
 */
export function ensurePageVersionTables(query = pgQuery) {
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
export function __resetPageVersionSchemaCache() {
  tablesReadyPromise = null;
}

async function createTables(query) {
  // funnel_id is carried on the ROW (not only reachable through page_id) so
  // every read can be pinned to the caller's funnel in a single predicate —
  // a version can never be listed, fetched or restored across the funnel
  // boundary even if a page id is guessed.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_page_versions (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      blocks JSONB,
      custom_css TEXT,
      custom_js TEXT,
      seo JSONB,
      title TEXT,
      label TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      bytes BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Existing databases pick the column up on the next request (same additive
  // posture as funnels.settings). Rows written before this column exists keep
  // bytes = NULL, and the client renders an absent size as an em dash rather
  // than as "0 B" — an unknown size must never read as "this version is empty".
  await query(`ALTER TABLE lb_page_versions ADD COLUMN IF NOT EXISTS bytes BIGINT`);
  // The one index the feature needs: the list endpoint and the retention
  // prune both walk (page_id, id DESC).
  await query(
    `CREATE INDEX IF NOT EXISTS idx_lb_page_versions_page ON lb_page_versions (page_id, id DESC)`
  );
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * Snapshot the CURRENT funnel_pages row into lb_page_versions and prune the
 * page back to VERSION_RETENTION — both statements inside the caller's
 * transaction.
 *
 * The content is copied by ONE INSERT…SELECT rather than read into JS and
 * written back. Two consequences, both load-bearing:
 *   • no read-then-write window — a concurrent PATCH cannot land between the
 *     read and the insert and make the "snapshot" describe a state that never
 *     existed as a whole;
 *   • the SELECT is pinned to (id, funnel_id, NOT archived) — exactly the
 *     predicate the duplicate endpoint uses — so a pageId belonging to
 *     ANOTHER funnel copies nothing and the caller gets a 404, never a
 *     cross-funnel read.
 *
 * ⚠️ Adding a content column to funnel_pages? Add it to BOTH lists below or
 * versions will silently drop it (same trap the duplicate endpoint carries).
 *
 * @param {object} tx  — a postgres.js transaction handle (client.begin)
 * @param {object} arg — { pageId, funnelId, label, createdBy }
 * @returns {Promise<object|null>} inserted row, or null when no live page
 *   with that (id, funnel_id) exists.
 */
export async function snapshotCurrentPage(
  tx,
  { pageId, funnelId, label = '', createdBy = null, protectId = null }
) {
  const inserted = await tx.unsafe(
    `INSERT INTO lb_page_versions
       (page_id, funnel_id, blocks, custom_css, custom_js, seo, title, label, created_by, bytes)
     SELECT id, funnel_id, blocks, custom_css, custom_js, seo, title, $3, $4,
            octet_length(COALESCE(blocks::text, ''))
              + octet_length(COALESCE(custom_css, ''))
              + octet_length(COALESCE(custom_js, ''))
              + octet_length(COALESCE(seo::text, ''))
              + octet_length(COALESCE(title, ''))
       FROM funnel_pages
      WHERE id = $1 AND funnel_id = $2 AND NOT archived
     RETURNING id, page_id, funnel_id, label, created_by, bytes, created_at`,
    [pageId, funnelId, String(label || '').slice(0, LABEL_MAX), createdBy]
  );
  if (!inserted.length) return null;

  // Retention, same transaction. The subquery is the SAME (page_id, id DESC)
  // order the list endpoint reads, so "what survives" is exactly "what the
  // first page of the list would have shown".
  //
  // `protectId` is the version a RESTORE is reading right now. Without it, a
  // restore of the OLDEST row on a page at the retention cap deletes that very
  // row — the pre-restore snapshot pushes the page to 31, the prune trims back
  // to the newest 30, and the oldest is exactly the one being restored. The
  // call still succeeded and still reported restored_version_id, so the
  // response pointed at a row that no longer existed.
  //
  // The protected row is kept IN ADDITION to the newest (RETENTION - 1), so
  // the page still lands on exactly RETENTION rows — the prune takes the
  // next-oldest instead. Protecting without lowering the limit would leave the
  // page one row over cap.
  const keep = protectId == null ? VERSION_RETENTION : VERSION_RETENTION - 1;
  await tx.unsafe(
    `DELETE FROM lb_page_versions
      WHERE page_id = $1
        AND ($2::bigint IS NULL OR id <> $2::bigint)
        AND id NOT IN (
          SELECT id FROM lb_page_versions
           WHERE page_id = $1
             AND ($2::bigint IS NULL OR id <> $2::bigint)
           ORDER BY id DESC
           LIMIT ${keep}
        )`,
    [pageId, protectId == null ? null : String(protectId)]
  );

  return inserted[0];
}

// The projection the LIST endpoint returns: metadata only. `blocks` can be a
// megabyte per row — a 30-row list that carried them would be a 30MB
// response for a sidebar that shows timestamps.
//
// `bytes` is READ, not recomputed: it is measured once at INSERT and stored.
// Recomputing it per list call meant casting every blocks column to text on
// every open of the drawer — 30 rows of up-to-2MB JSONB detoasted to answer a
// sidebar. It is the on-the-wire octet count of the snapshot's content, NOT
// pg_column_size, which reports TOASTed/compressed storage and would tell an
// operator their 400KB page is 40KB.
//
// block_count stays computed: jsonb_array_length reads the JSONB header only.
export const VERSION_LIST_COLUMNS = `
  id, label, created_by, created_at, bytes,
  CASE WHEN jsonb_typeof(blocks) = 'array' THEN jsonb_array_length(blocks) ELSE 0 END AS block_count
`;
