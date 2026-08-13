-- Persist the triage verdict on every autopilot-queued job.
--
-- The fit score was computed at selection time and thrown away, which made the
-- one question that audits the triage unanswerable: does its judgement predict
-- the operator's? With fit stored beside the job (and the job linked to the
-- brief the operator later approves or rejects), that correlation becomes a
-- single query — and the day it stops correlating is the day the triage prompt
-- needs recalibrating.
ALTER TABLE brief_generation_jobs ADD COLUMN IF NOT EXISTS fit_score  NUMERIC;
ALTER TABLE brief_generation_jobs ADD COLUMN IF NOT EXISTS fit_angle  TEXT;
ALTER TABLE brief_generation_jobs ADD COLUMN IF NOT EXISTS fit_why    TEXT;
