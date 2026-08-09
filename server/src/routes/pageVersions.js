// PAGE VERSIONS — snapshot / list / read / restore for a funnel page.
// Mounted at /api/v1/page-versions (authenticate + funnels:access).
//
// A version is a COPY of funnel_pages' content columns at an instant, taken
// by INSERT…SELECT so it can never describe a state the page never held.
// Restore is the mirror: one transaction that snapshots the CURRENT state
// ('before restore') and then writes the chosen version's content back. If
// anything in that transaction fails, BOTH halves roll back — there is no
// path that overwrites a page without first having recorded what it replaced.
//
// EVERY read and write is pinned to (page_id, funnel_id) — the same predicate
// the duplicate endpoint uses — so a version can never be listed, fetched or
// restored across the funnel boundary.
//
// The only tables touched are lb_page_versions (owned here) and funnel_pages
// (read + one UPDATE of content columns on restore). No shared route file is
// modified beyond the single mount line in routes/index.js.
import { Router } from 'express';
import { client, pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTables, validateBlocks } from './funnels.js';
import {
  ensurePageVersionTables,
  snapshotCurrentPage,
  VERSION_LIST_COLUMNS,
  VERSION_RETENTION,
  LABEL_MAX,
} from '../services/pageVersionsSchema.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// The list is capped at the retention count — there can never be more.
const LIST_LIMIT = VERSION_RETENTION;

// BIGSERIAL. A non-numeric path segment is a malformed request (400), not a
// missing row (404): binding it would make Postgres throw and answer 500.
const VERSION_ID_RE = /^[1-9][0-9]{0,18}$/;

const readLabel = (raw) => {
  if (raw == null) return { label: '' };
  if (typeof raw !== 'string') return { error: 'label must be a string' };
  return { label: raw.trim().slice(0, LABEL_MAX) };
};

// One ensure per request, both schemas. funnel_pages is created by the
// funnels router's promise (shared, serialized); lb_page_versions by ours.
const ensureAll = async () => {
  await ensureTables();
  await ensurePageVersionTables();
};

// ---------------------------------------------------------------------------
// POST /:funnelId/:pageId/snapshot — { label? } → the new version's metadata
// ---------------------------------------------------------------------------
router.post('/:funnelId/:pageId/snapshot', async (req, res) => {
  try {
    await ensureAll();
    const { label, error } = readLabel(req.body?.label);
    if (error) return res.status(400).json({ error });

    const row = await client.begin((tx) =>
      snapshotCurrentPage(tx, {
        pageId: req.params.pageId,
        funnelId: req.params.funnelId,
        label,
        createdBy: req.user?.id || null,
      })
    );
    // null ⇒ no live page with that (id, funnel_id). Same answer whether the
    // page does not exist, is archived, or belongs to another funnel: the
    // caller must not be able to probe the boundary by reading the message.
    if (!row) return res.status(404).json({ error: 'Page not found' });

    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('[page-versions] snapshot failed:', err);
    return res.status(500).json({ error: 'Failed to snapshot the page' });
  }
});

// ---------------------------------------------------------------------------
// GET /:funnelId/:pageId — metadata list, newest first. NEVER the blocks.
// ---------------------------------------------------------------------------
router.get('/:funnelId/:pageId', async (req, res) => {
  try {
    await ensureAll();
    // Ownership is checked against the PAGE, not only the version rows: a
    // page with zero versions must answer 200 [] when it is yours and 404
    // when it is not — an empty list for both would leak nothing but would
    // also hide a genuinely missing page from the operator.
    const pageRows = await pgQuery(
      `SELECT id FROM funnel_pages WHERE id = $1 AND funnel_id = $2 AND NOT archived`,
      [req.params.pageId, req.params.funnelId]
    );
    if (!pageRows.length) return res.status(404).json({ error: 'Page not found' });

    const rows = await pgQuery(
      `SELECT ${VERSION_LIST_COLUMNS}
         FROM lb_page_versions
        WHERE page_id = $1 AND funnel_id = $2
        ORDER BY id DESC
        LIMIT ${LIST_LIMIT}`,
      [req.params.pageId, req.params.funnelId]
    );

    return res.json({
      success: true,
      data: { versions: rows, retention: VERSION_RETENTION },
    });
  } catch (err) {
    console.error('[page-versions] list failed:', err);
    return res.status(500).json({ error: 'Failed to list versions' });
  }
});

// ---------------------------------------------------------------------------
// GET /:funnelId/:pageId/:versionId — the FULL version (blocks included)
// ---------------------------------------------------------------------------
router.get('/:funnelId/:pageId/:versionId', async (req, res) => {
  try {
    await ensureAll();
    const { versionId } = req.params;
    if (!VERSION_ID_RE.test(versionId)) {
      return res.status(400).json({ error: 'versionId must be a positive integer' });
    }

    const rows = await pgQuery(
      `SELECT id, page_id, funnel_id, blocks, custom_css, custom_js, seo, title,
              label, created_by, created_at
         FROM lb_page_versions
        WHERE id = $1 AND page_id = $2 AND funnel_id = $3`,
      [versionId, req.params.pageId, req.params.funnelId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[page-versions] get failed:', err);
    return res.status(500).json({ error: 'Failed to read the version' });
  }
});

// ---------------------------------------------------------------------------
// POST /:funnelId/:pageId/:versionId/restore — { confirm: true }
//
// ONE transaction:
//   1. lock the page row (FOR UPDATE) — serializes concurrent restores and
//      pins ownership;
//   2. snapshot the CURRENT state as 'before restore' (+ retention prune);
//   3. write the chosen version's content back onto funnel_pages.
// Step 2 before step 3 is the whole safety story: the operator's live page is
// recorded BEFORE it is replaced, in the same atomic unit.
//
// Deliberately NOT restored: slug, type, status, is_home, archived. Those are
// routing/publishing facts about the page, not its content — rolling a page's
// CONTENT back must never quietly republish it, move its URL, or steal the
// home slot.
// ---------------------------------------------------------------------------
router.post('/:funnelId/:pageId/:versionId/restore', async (req, res) => {
  try {
    await ensureAll();
    const { funnelId, pageId, versionId } = req.params;
    if (!VERSION_ID_RE.test(versionId)) {
      return res.status(400).json({ error: 'versionId must be a positive integer' });
    }
    // A restore is destructive to the on-screen state. It requires an
    // explicit boolean true — not 'true', not 1, not any truthy value that a
    // sloppy client could send by accident.
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirm must be true to restore a version' });
    }

    const outcome = await client.begin(async (tx) => {
      // 1. Lock + ownership. FOR UPDATE means two restores of the same page
      //    cannot interleave their snapshot/overwrite halves.
      const pageRows = await tx.unsafe(
        `SELECT id FROM funnel_pages
          WHERE id = $1 AND funnel_id = $2 AND NOT archived
          FOR UPDATE`,
        [pageId, funnelId]
      );
      if (!pageRows.length) return { status: 404, error: 'Page not found' };

      // 2. The version to restore — pinned to this page AND this funnel.
      const verRows = await tx.unsafe(
        `SELECT id, blocks, custom_css, custom_js, seo, title
           FROM lb_page_versions
          WHERE id = $1 AND page_id = $2 AND funnel_id = $3`,
        [versionId, pageId, funnelId]
      );
      if (!verRows.length) return { status: 404, error: 'Version not found' };
      const version = verRows[0];

      // A version can predate a tightening of the block caps. Refuse loudly
      // rather than write a payload the page router would later reject —
      // and refuse BEFORE the pre-restore snapshot, so a refused restore
      // leaves no junk row behind.
      //
      // ⚠️ NOT `Array.isArray(x) ? x : []`. A row whose blocks column is not
      // an array (a hand-written row, a JSONB scalar, a NULL from a column
      // added later) would then restore as an EMPTY page — the exact silent-
      // empty-copy failure the atomic duplicate endpoint was written to kill.
      // A shape we cannot restore is a REFUSAL, never an empty page.
      const blocks = version.blocks;
      const blocksError = validateBlocks(blocks);
      if (blocksError) {
        return { status: 422, error: `This version can no longer be restored: ${blocksError}` };
      }

      // 3. Snapshot the CURRENT state first. Same transaction — if the
      //    UPDATE below throws, this row rolls back with it.
      const preSnap = await snapshotCurrentPage(tx, {
        pageId,
        funnelId,
        label: 'before restore',
        createdBy: req.user?.id || null,
      });
      if (!preSnap) return { status: 404, error: 'Page not found' };

      // 4. Content write. seo is JSONB and may legitimately be null in an
      //    old snapshot — COALESCE to {} so the column keeps its shape.
      const updated = await tx.unsafe(
        `UPDATE funnel_pages
            SET blocks = $1,
                custom_css = $2,
                custom_js = $3,
                seo = COALESCE($4, '{}'::jsonb),
                title = $5,
                updated_at = NOW()
          WHERE id = $6 AND funnel_id = $7
        RETURNING *`,
        [
          blocks,
          version.custom_css ?? '',
          version.custom_js ?? '',
          version.seo ?? null,
          version.title ?? '',
          pageId,
          funnelId,
        ]
      );

      return {
        status: 200,
        page: updated[0],
        restored_version_id: Number(version.id),
        pre_restore_version_id: Number(preSnap.id),
      };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({
      success: true,
      data: {
        page: outcome.page,
        restored_version_id: outcome.restored_version_id,
        pre_restore_version_id: outcome.pre_restore_version_id,
      },
    });
  } catch (err) {
    console.error('[page-versions] restore failed:', err);
    return res.status(500).json({ error: 'Failed to restore the version' });
  }
});

export default router;
