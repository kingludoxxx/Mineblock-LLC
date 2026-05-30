-- 061_creative_analysis_ownership.sql
-- Per-row Meta ownership verification on creative_analysis +
-- meta_account_audit table for boot-time env verification.
--
-- See P0.1 and P1.3 of the brief-pipeline contamination scope. The
-- verified-at stamp gates the import grid: rows older than 7 days are
-- treated as stale and re-verified before being shown. is_linkage_quarantined
-- hides rows whose Meta linkage has been confirmed wrong.

-- Per-row verification stamps
ALTER TABLE creative_analysis
  ADD COLUMN IF NOT EXISTS meta_account_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meta_account_verified_id TEXT,
  ADD COLUMN IF NOT EXISTS is_linkage_quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS linkage_quarantine_reason TEXT;

-- Partial index — only quarantined rows matter for admin review
CREATE INDEX IF NOT EXISTS idx_ca_linkage_quarantined
  ON creative_analysis (is_linkage_quarantined, meta_account_verified_at DESC)
  WHERE is_linkage_quarantined = TRUE;

-- Verified-at index for stale-row sweeps (the daily re-verify cron)
CREATE INDEX IF NOT EXISTS idx_ca_verified_stale
  ON creative_analysis (meta_account_verified_at NULLS FIRST)
  WHERE meta_ad_id IS NOT NULL;

-- ── Boot-time env audit table ────────────────────────────────────────────
-- Populated by the boot helper on every server start. Lets the runtime
-- consult "is this account trusted, and when did we last confirm it owned
-- by Mineblock's Business Manager" without re-hitting Meta on every check.
CREATE TABLE IF NOT EXISTS meta_account_audit (
  account_id        TEXT PRIMARY KEY,
  business_id       TEXT,
  business_name     TEXT,
  account_name      TEXT,
  account_status    INTEGER,
  is_trusted        BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_meta_account_audit_trusted
  ON meta_account_audit (is_trusted, verified_at DESC);

-- ── Unmatched Meta ads table ─────────────────────────────────────────────
-- syncMetaThumbnails (post-P1.1) will only do exact ad_name matches. Any
-- Meta ad that doesn't match an existing creative_analysis row gets logged
-- here for operator review. Helps catch:
--   - Mineblock launched a new ad we haven't synced yet
--   - Naming convention drift (operator typo'd the ad name)
--   - Foreign ads in a trusted account (env got polluted)
CREATE TABLE IF NOT EXISTS meta_sync_unmatched (
  meta_ad_id       TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  ad_name          TEXT NOT NULL,
  has_video        BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count       INTEGER NOT NULL DEFAULT 1,
  resolved         BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at      TIMESTAMPTZ,
  PRIMARY KEY (meta_ad_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_unmatched_unresolved
  ON meta_sync_unmatched (last_seen_at DESC)
  WHERE resolved = FALSE;
