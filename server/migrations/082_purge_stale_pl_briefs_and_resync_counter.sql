-- Finish the PL brief-number resync that migration 081 could not.
--
-- Why 081 wasn't enough: it set the counter to
--   GREATEST(21, MAX(brief_number) WHERE product_code IN ('PUURE','PL'))
-- and that MAX is taken over EVERY row, including ones the app's
-- GET /generated never shows (it filters `status != 'rejected'`). Leftover
-- REJECTED Puure test briefs still carried numbers up to 448, so 081 actually
-- pinned the counter at 448 and the next generation came out B0449.
--
-- getNextBriefNumber() reads the same unfiltered MAX for its floor, so those
-- hidden rows poison BOTH inputs to allocateBriefNumber()'s
-- GREATEST(counter, floor) + 1. Rewinding the counter alone can never work
-- while they exist — the rows themselves have to go.
--
-- Scope: only Puure/PL rows numbered above 21. The genuine PL briefs in this
-- table are 12 and 13 (the cards now named B0016/B0017); the operator's real
-- B0009-B0021 live only in ClickUp and were never in this table. So everything
-- above 21 here is throwaway test residue from building the pipeline.
--
-- The NOTICEs print exactly what was removed, so the Render boot log is the
-- audit trail for this one-time data fix.
DO $$
DECLARE
  r          RECORD;
  v_deleted  INT;
  v_max      INT;
  v_counter  INT;
BEGIN
  RAISE NOTICE '[082] PUURE/PL briefs with brief_number > 21 (to be deleted):';
  FOR r IN
    SELECT brief_number, status, (clickup_task_id IS NOT NULL) AS pushed
      FROM brief_pipeline_generated
     WHERE product_code IN ('PUURE', 'PL')
       AND brief_number > 21
     ORDER BY brief_number
  LOOP
    RAISE NOTICE '[082]   B% status=% pushed=%', r.brief_number, r.status, r.pushed;
  END LOOP;

  DELETE FROM brief_pipeline_generated
   WHERE product_code IN ('PUURE', 'PL')
     AND brief_number > 21;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE '[082] deleted % stale PUURE/PL brief row(s)', v_deleted;

  SELECT COALESCE(MAX(brief_number), 0) INTO v_max
    FROM brief_pipeline_generated
   WHERE product_code IN ('PUURE', 'PL');
  RAISE NOTICE '[082] PUURE/PL max brief_number after purge = %', v_max;

  -- Rewind the PL counter to the true ceiling. 21 = highest real ClickUp card
  -- (B0021); GREATEST() guards against ever rewinding below a brief the table
  -- still knows about, which would hand out a duplicate number.
  UPDATE brief_number_counter
     SET value = GREATEST(21, v_max)
   WHERE id = 2
  RETURNING value INTO v_counter;

  RAISE NOTICE '[082] PL counter (id=2) = % -> next generated brief will be B%',
    v_counter, LPAD((v_counter + 1)::text, 4, '0');
END $$;
