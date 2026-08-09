// Media library schema — single owner of the lb_media DDL.
//
// One row per library asset. The row is an INDEX over a CDN object, never the
// bytes: `url` is the only thing a rendered funnel page ever sees, so the
// table stays tiny and a page render never touches this table at all.
//
// Deliberate omissions, so nobody re-adds them by accident:
//   - NO bytea / base64 column. Postgres is not a CDN; a 4 MB hero image in a
//     row makes every SELECT * on the library a 4 MB transfer, and the money
//     path shares this pool.
//   - NO local-disk path column. Render's filesystem is ephemeral — an asset
//     stored on disk dies at the next deploy, silently, and the funnel page
//     that references it 404s in front of paid traffic.
//   - NO hard delete route. `archived` only. An archived asset may still be
//     referenced by a LIVE page (there is no usage index in v1 — see the
//     builder-hookup TODO), so removing the CDN object would break it.
//
// Ensure-on-demand, same single-in-flight-promise guard as
// checkoutSchema/trackingSchema: two concurrent first requests must not run
// CREATE TABLE in parallel (pg_type unique violation).
import { pgQuery } from '../db/pg.js';

let tablesReadyPromise = null;

export function ensureMediaTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      // Reset so the NEXT request retries rather than inheriting a poisoned
      // resolved-once promise (a transient DB blip must not disable the
      // library for the life of the process).
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'image',
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT,
      mime TEXT,
      bytes INTEGER,
      width INTEGER,
      height INTEGER,
      alt TEXT NOT NULL DEFAULT '',
      shopify_file_id TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  // The library grid's ONE query: WHERE archived = $1 ORDER BY created_at DESC.
  // The reference tool sorts an unindexed created_at (funnel-os
  // listicle_builders.py:6377) and the grid degrades as the library grows —
  // this index is the fix, not an optimisation.
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_lb_media_archived_created
       ON lb_media (archived, created_at DESC)`
  );

  // Search is a case-insensitive substring over filename+alt. Postgres cannot
  // index a leading-wildcard LIKE without pg_trgm (an extension this DB is not
  // guaranteed to have), so search deliberately falls back to a scan over the
  // archived-filtered slice. Documented rather than hidden: at v1 library
  // sizes (hundreds of rows) that scan is free, and the honest fix later is
  // `CREATE EXTENSION pg_trgm` + a GIN index, not a silently wrong query.
}

export default { ensureMediaTables };
