-- 085_spy_creatives_gen_task_id_unique.sql
-- Statics forever-fix F3 — race-safe auto-save.
--
-- The pipeline's auto-save block (POST /generate ~line 2733) and the legacy
-- client-driven POST /creatives handler both INSERT spy_creatives keyed by
-- generation_task_id. When both callers race (queue worker persists
-- server-side while a still-open tab persists client-side), the SELECT-then-
-- INSERT idempotency guard doesn't hold and we get duplicate rows.
--
-- Fix: enforce uniqueness at the DB layer + switch both writers to
-- INSERT … ON CONFLICT (generation_task_id) DO NOTHING. Whoever writes first
-- wins; the loser no-ops silently.
--
-- Prerequisite: dedupe any rows that already collide, or the CREATE UNIQUE
-- INDEX fails. We keep the earliest row per generation_task_id (matches the
-- "first-write-wins" semantics of the ON CONFLICT DO NOTHING that follows)
-- and delete the newer duplicates. Non-NULL generation_task_id only — NULLs
-- are legitimate for hand-created rows and stay unconstrained.
--
-- NOTE: plain (not CONCURRENTLY) — the migration runner wraps every file in
-- BEGIN/COMMIT and CREATE INDEX CONCURRENTLY refuses to run inside a
-- transaction. Brief window of table-lock is acceptable for a one-off
-- schema fix.

-- Step 1: dedupe. Keep the row with the smallest created_at (ties broken by
-- id) per generation_task_id; delete the rest.
DELETE FROM spy_creatives
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            row_number() OVER (
              PARTITION BY generation_task_id
              ORDER BY created_at ASC, id ASC
            ) AS rn
       FROM spy_creatives
      WHERE generation_task_id IS NOT NULL
   ) ranked
    WHERE rn > 1
 );

-- Step 2: partial unique index — the "WHERE generation_task_id IS NOT NULL"
-- predicate lets NULLs coexist without needing three-valued-logic tricks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spy_creatives_generation_task_id
  ON spy_creatives (generation_task_id)
  WHERE generation_task_id IS NOT NULL;
