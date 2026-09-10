-- 122_creative_analysis_fresh_shape.sql  (S0b-3 migration reset, Lane A2 — review finding P1-2)
--
-- WHY. creative_analysis has two birth certificates. On a FRESH database 016
-- creates it (id UUID, creative_id VARCHAR(20), creative_type NOT NULL + CHECK,
-- no `type`, UNIQUE (creative_id, hook_id)). On the live databases the route
-- (server/src/routes/creativeAnalysis.js ensureTable) created it first
-- (id SERIAL, TEXT columns, type TEXT NOT NULL DEFAULT 'video',
-- UNIQUE (creative_id, hook_id, week)) and 016 no-oped. 121 only added the
-- route's ADD COLUMN set, so after a clean migrate of an empty database the
-- route's own INSERT still failed: `column "type" does not exist`, then
-- `value too long for type character varying(20)`. (121's header comment
-- claiming "same column list as the route" is wrong; 121 is applied and
-- checksummed, so the fix is this file, not an edit of 121.)
--
-- WHAT. After this file a fresh database's creative_analysis equals the live
-- one column for column on information_schema (name, data_type, length,
-- numeric precision/scale, nullability, default) — asserted by test A8.1
-- against mineblock_copy — and carries the route's ON CONFLICT target.
--
-- HOW. Every statement is guarded by the catalog: on a live-shaped table this
-- file issues NO ALTER at all (pure no-op, test A8.4).
--   Section A — expand, safe on ANY table, rows or not:
--     add `type`; widen the six VARCHAR columns to TEXT; drop creative_type's
--     NOT NULL + CHECK (the route never writes creative_type); swap
--     UNIQUE (creative_id, hook_id) → (creative_id, hook_id, week).
--   Section B — contract to the live shape (id UUID → INTEGER + sequence,
--     purchases NUMERIC → INTEGER, NUMERIC(p,2) precisions, hook_id NOT NULL):
--     ONLY when the table is EMPTY, i.e. on a fresh database. A table WITH rows
--     that still has the 016 shape is neither fresh nor live: its data is left
--     alone, a WARNING names each divergence (run.js prints database warnings,
--     test A8.6), and the route still works there because Section A is all its
--     INSERT needs.
-- No EXCEPTION handler anywhere: a real error fails the run visibly (A5).

-- ── Section A: expand ──────────────────────────────────────────────────────
ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'video';

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creative_analysis'
       AND column_name IN ('creative_id', 'hook_id', 'avatar', 'angle', 'format', 'editor')
       AND data_type = 'character varying'
  LOOP
    EXECUTE format('ALTER TABLE creative_analysis ALTER COLUMN %I TYPE TEXT', r.column_name);
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'creative_analysis'
                AND column_name = 'creative_type' AND is_nullable = 'NO') THEN
    ALTER TABLE creative_analysis ALTER COLUMN creative_type DROP NOT NULL;
  END IF;

  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.creative_analysis'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%creative_type%'
  LOOP
    EXECUTE format('ALTER TABLE creative_analysis DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.creative_analysis'::regclass
                AND conname = 'creative_analysis_creative_id_hook_id_key') THEN
    ALTER TABLE creative_analysis DROP CONSTRAINT creative_analysis_creative_id_hook_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.creative_analysis'::regclass
                    AND conname = 'creative_analysis_creative_id_hook_id_week_key') THEN
    ALTER TABLE creative_analysis ADD CONSTRAINT creative_analysis_creative_id_hook_id_week_key
      UNIQUE (creative_id, hook_id, week);
  END IF;
END $$;

-- ── Section B: contract to the live shape, EMPTY table only ────────────────
DO $$
DECLARE
  divergences TEXT[] := ARRAY[]::TEXT[];
  r RECORD;
  n RECORD;
  has_rows BOOLEAN;
BEGIN
  SELECT data_type INTO r FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'id';
  IF r.data_type IS DISTINCT FROM 'integer' THEN
    divergences := divergences || format('id is %s (live: integer, default nextval(creative_analysis_id_seq))', r.data_type);
  END IF;

  SELECT data_type INTO r FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'purchases';
  IF r.data_type IS DISTINCT FROM 'integer' THEN
    divergences := divergences || format('purchases is %s (live: integer)', r.data_type);
  END IF;

  SELECT is_nullable INTO r FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'hook_id';
  IF r.is_nullable IS DISTINCT FROM 'NO' THEN
    divergences := divergences || 'hook_id is nullable (live: NOT NULL)'::text;
  END IF;

  FOR n IN SELECT * FROM (VALUES ('spend', 12), ('revenue', 12), ('roas', 8), ('cpa', 10),
                                 ('cpm', 10), ('aov', 10), ('cpc', 10), ('ctr', 8)) AS v(col, prec)
  LOOP
    SELECT numeric_precision, numeric_scale INTO r FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = n.col;
    IF r.numeric_precision IS DISTINCT FROM n.prec OR r.numeric_scale IS DISTINCT FROM 2 THEN
      divergences := divergences || format('%s is numeric(%s,%s) (live: numeric(%s,2))',
        n.col, coalesce(r.numeric_precision::text, '-'), coalesce(r.numeric_scale::text, '-'), n.prec);
    END IF;
  END LOOP;

  IF cardinality(divergences) = 0 THEN
    RETURN; -- already the live shape: nothing to do
  END IF;

  SELECT EXISTS (SELECT 1 FROM creative_analysis) INTO has_rows;
  IF has_rows THEN
    RAISE WARNING '122_creative_analysis_fresh_shape: creative_analysis has rows and still differs from the live shape; left untouched (the route works after section A). Divergences: %',
      array_to_string(divergences, '; ');
    RETURN;
  END IF;

  -- Empty table (fresh database): contract to the live shape.
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'id') <> 'integer' THEN
    ALTER TABLE creative_analysis ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE creative_analysis ALTER COLUMN id TYPE INTEGER USING 0; -- no rows: USING is never evaluated
    CREATE SEQUENCE IF NOT EXISTS creative_analysis_id_seq AS INTEGER OWNED BY creative_analysis.id;
    ALTER TABLE creative_analysis ALTER COLUMN id SET DEFAULT nextval('creative_analysis_id_seq');
  END IF;

  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'purchases') <> 'integer' THEN
    ALTER TABLE creative_analysis ALTER COLUMN purchases TYPE INTEGER USING purchases::integer;
  END IF;

  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = 'hook_id') = 'YES' THEN
    ALTER TABLE creative_analysis ALTER COLUMN hook_id SET NOT NULL;
  END IF;

  FOR n IN SELECT * FROM (VALUES ('spend', 12), ('revenue', 12), ('roas', 8), ('cpa', 10),
                                 ('cpm', 10), ('aov', 10), ('cpc', 10), ('ctr', 8)) AS v(col, prec)
  LOOP
    SELECT numeric_precision, numeric_scale INTO r FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creative_analysis' AND column_name = n.col;
    IF r.numeric_precision IS DISTINCT FROM n.prec OR r.numeric_scale IS DISTINCT FROM 2 THEN
      EXECUTE format('ALTER TABLE creative_analysis ALTER COLUMN %I TYPE NUMERIC(%s,2)', n.col, n.prec);
    END IF;
  END LOOP;
END $$;
