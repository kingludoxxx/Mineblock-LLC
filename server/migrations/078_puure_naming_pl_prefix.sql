-- Puure briefs must be NAMED with the brand short code 'PL', not 'PUURE'
-- (the DB product_code column stays PUURE for master-brief context lookups).
-- Rewrite the leading code for briefs NOT yet pushed to ClickUp; pushed
-- tasks keep their names so DB and ClickUp titles don't drift.
--
-- Also (re)applies the ' - Uly' editor strip from 077 idempotently, so this
-- one migration fully normalizes unpushed names even if 077 didn't run.
UPDATE brief_pipeline_generated
   SET naming_convention = REPLACE(naming_convention, ' - Uly - ', ' - '),
       editor = NULL
 WHERE clickup_task_id IS NULL
   AND naming_convention LIKE '% - Uly - %';

UPDATE brief_pipeline_generated
   SET naming_convention = 'PL - ' || SUBSTRING(naming_convention FROM LENGTH('PUURE - ') + 1)
 WHERE clickup_task_id IS NULL
   AND naming_convention LIKE 'PUURE - %';
