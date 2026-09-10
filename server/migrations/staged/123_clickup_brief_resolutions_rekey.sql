-- staged/123_clickup_brief_resolutions_rekey.sql — Lane C (S1-1). CONTRACT STEP, STAGED.
--
-- NOT auto-run: server/src/server.js and server/migrations/run.js read only
-- *.sql directly under server/migrations/. Move this file there (keeping its
-- number) in the SAME release as the code change below, never before.
--
-- PRECONDITION (hard): server/src/routes/adsReporting.js:714 must upsert with
--   ON CONFLICT (product_code, brief_number)
-- and adsReporting.js:635 should read WHERE (product_code, brief_number) IN ...
-- Today's `ON CONFLICT (brief_number)` cannot be planned once the PRIMARY KEY
-- on brief_number is gone (SQLSTATE 42P10) — proven by
-- server/tests/store-code/a4-coexist.test.mjs.
--
-- What it does: drops the single-column primary key so a P1 brief number and a
-- PL brief number can coexist, and makes (product_code, brief_number) the key.
-- NULLS NOT DISTINCT (PostgreSQL 15+; Render runs 16) keeps not-yet-attributed
-- rows unique per number exactly as they are today.
DO $$
DECLARE pk TEXT;
BEGIN
  SELECT conname INTO pk FROM pg_constraint
   WHERE conrelid = 'clickup_brief_resolutions'::regclass AND contype = 'p';
  IF pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE clickup_brief_resolutions DROP CONSTRAINT %I', pk);
    RAISE NOTICE '[123] dropped primary key % on clickup_brief_resolutions', pk;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_clickup_brief_resolutions_code_number
  ON clickup_brief_resolutions (product_code, brief_number) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS idx_clickup_brief_resolutions_code_number;
