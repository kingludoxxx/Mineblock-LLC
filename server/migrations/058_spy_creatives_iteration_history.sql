-- 058: spy_creatives.iteration_history — per-ratio refinement carousel
--
-- Phase A of the statics-pipeline-v2 brief. Each row stores up to 6 prior
-- generations of itself so the To-Review detail modal can show a carousel
-- of "previous versions" the operator can revert to.
--
-- Shape (JSONB):
--   [
--     {
--       "image_url": "https://r2.dev/…",
--       "claude_analysis": { … },
--       "refine_instruction": "make the headline bolder",
--       "created_at": "2026-05-30T01:23:45Z"
--     },
--     …
--   ]
--
-- Capped at the application layer (6 entries) on each refine write —
-- we shift the oldest off when we push a new one. No DB-side enforcement
-- needed (JSONB doesn't have a built-in length constraint).
--
-- Idempotent: IF NOT EXISTS guards the add.

ALTER TABLE spy_creatives
  ADD COLUMN IF NOT EXISTS iteration_history JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN spy_creatives.iteration_history IS
  'Per-ratio refinement carousel — last 6 prior generations of this row. Set by /creatives/:id/refine.';
