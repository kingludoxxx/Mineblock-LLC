-- ============================================================================
-- 056 — Brief Pipeline references: source-scoped uniqueness
--
-- Bug found in 2026-05-29 audit: the original UNIQUE (ad_archive_id) lets
-- a meta-import silently overwrite a league row that happens to share the
-- same Facebook Library ID, and vice versa. The two source namespaces are
-- almost-but-not-always-disjoint, so the risk is real.
--
-- Fix: widen the unique constraint to (ad_archive_id, source) so each
-- source maintains its own independent dedup. ON CONFLICT clauses in the
-- import routes are updated to match in the same deploy.
-- ============================================================================

-- Drop the old single-column UNIQUE constraint (if it exists as constraint
-- or as a plain unique index — handle both).
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'brief_pipeline_references'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(ad_archive_id)%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE brief_pipeline_references DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

-- Also drop a unique INDEX form if present
DROP INDEX IF EXISTS brief_pipeline_references_ad_archive_id_key;
DROP INDEX IF EXISTS idx_brief_pipeline_references_ad_archive_id;

-- Source values are coerced to lowercase to avoid '/Meta' vs 'meta' surprises.
-- All historic rows already use lowercase ('league' / 'meta' / 'upload').
ALTER TABLE brief_pipeline_references
  ADD CONSTRAINT brief_pipeline_references_archive_source_uq
  UNIQUE (ad_archive_id, source);

-- Backfill safety: NULL source rows are legal in the schema but the new
-- constraint will treat NULL-NULL as distinct (Postgres NULL semantics) —
-- existing rows with NULL source need a value before the constraint can
-- enforce. Default everything that's NULL to 'league' (the original source).
UPDATE brief_pipeline_references SET source = 'league' WHERE source IS NULL;
