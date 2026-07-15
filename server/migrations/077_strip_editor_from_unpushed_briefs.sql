-- Remove the hardcoded ' - Uly' editor segment from briefs that were
-- generated before fix 300b855 (editor is assigned in ClickUp AFTER push,
-- so generated names must not carry one) and that have NOT been pushed to
-- ClickUp yet — pushed tasks keep their names to avoid drifting from the
-- ClickUp task titles.
UPDATE brief_pipeline_generated
   SET naming_convention = REPLACE(naming_convention, ' - Uly - ', ' - '),
       editor = NULL
 WHERE clickup_task_id IS NULL
   AND naming_convention LIKE '% - Uly - %';
