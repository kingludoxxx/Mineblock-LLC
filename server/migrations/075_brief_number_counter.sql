-- Atomic brief-number allocation. The queue worker generates briefs with
-- concurrency 2, and getNextBriefNumber() (read-MAX-then-insert-later) let
-- two concurrent jobs read the same MAX and both mint the same number
-- (two B0432 rows on 2026-07-15). A single-row counter updated with an
-- atomic UPDATE ... RETURNING is race-free.

-- 1. Renumber any existing duplicate-numbered briefs (same logic as 073:
--    oldest keeps its number, newer duplicates get the next free numbers).
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

-- 2. Counter table, seeded from the post-renumber max.
CREATE TABLE IF NOT EXISTS brief_number_counter (
  id    INTEGER PRIMARY KEY DEFAULT 1,
  value INTEGER NOT NULL
);

INSERT INTO brief_number_counter (id, value)
SELECT 1, COALESCE(MAX(brief_number), 0) FROM brief_pipeline_generated
ON CONFLICT (id) DO UPDATE
  SET value = GREATEST(brief_number_counter.value, EXCLUDED.value);
