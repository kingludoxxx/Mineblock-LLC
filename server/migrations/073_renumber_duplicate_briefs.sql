-- Renumber generated briefs that share a duplicate brief_number.
-- getNextBriefNumber() used to read only ClickUp (max task = 349), so every
-- DB-only brief got 350 and the identical naming string — indistinguishable
-- cards in the UI, and the operator opened the wrong one. Keep the oldest
-- row's number; each newer duplicate gets the next free number, oldest first,
-- and its naming_convention 'B0350'-style token is rewritten to match.
WITH ranked AS (
  SELECT id,
         brief_number,
         ROW_NUMBER() OVER (PARTITION BY brief_number ORDER BY created_at ASC) - 1 AS dup_index
  FROM brief_pipeline_generated
  WHERE brief_number IS NOT NULL
),
maxn AS (
  SELECT COALESCE(MAX(brief_number), 0) AS max_num FROM brief_pipeline_generated
),
renumbered AS (
  SELECT r.id,
         r.brief_number AS old_num,
         (SELECT max_num FROM maxn)
           + ROW_NUMBER() OVER (ORDER BY r.brief_number, r.dup_index) AS new_num
  FROM ranked r
  WHERE r.dup_index > 0
)
UPDATE brief_pipeline_generated g
   SET brief_number = rn.new_num,
       naming_convention = REPLACE(
         naming_convention,
         'B' || LPAD(rn.old_num::text, 4, '0'),
         'B' || LPAD(rn.new_num::text, 4, '0')
       )
  FROM renumbered rn
 WHERE g.id = rn.id;
