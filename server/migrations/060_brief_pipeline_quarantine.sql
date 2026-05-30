-- 060_brief_pipeline_quarantine.sql
-- Quarantine flag for brief_pipeline_references rows whose Meta linkage points
-- at a non-Mineblock account (or otherwise unresolvable via Meta API).
--
-- See P0.4 of the brief-pipeline contamination scope: once flipped, the row
-- is hidden from the default Reference column query and the iterate guard
-- blocks any attempt to generate from it. Operator can review/unquarantine
-- via the admin Linkage Audit page (P2.1).

ALTER TABLE brief_pipeline_references
  ADD COLUMN IF NOT EXISTS is_quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

-- Partial index — most rows are not quarantined, so we only index the bad ones.
-- Used by the admin audit page filter and the daily ownership re-verify cron.
CREATE INDEX IF NOT EXISTS idx_bpr_quarantined
  ON brief_pipeline_references (is_quarantined, quarantined_at DESC)
  WHERE is_quarantined = TRUE;
