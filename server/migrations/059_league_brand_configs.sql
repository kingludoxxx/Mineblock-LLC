-- 059: league_brand_configs — per-followed-brand import preferences
--
-- The operator follows brands via spy_brand_follows. This table layers
-- per-brand preferences for the FROM LEAGUE auto-import flow:
--
--   top_pct                 (1-100) % of the brand's active image ads to
--                           import on each sync, ranked by tier_score DESC
--                           with current_rank ASC tiebreak. Default 10%.
--
--   tier_filter             optional whitelist of tiers (BANGER, CHAMP, A,
--                           B, C, MID, TEST). NULL = all tiers. Applied
--                           BEFORE top_pct so "top 10% of BANGERs only"
--                           is meaningful.
--
--   max_copy_length         optional cap on body_text + headline + caption
--                           total chars. NULL = no limit.
--
--   auto_sync_enabled       background CRON respects this. Phase 2 ships
--                           the actual worker; for now manual sync via the
--                           UI's "sync now" button is what fires.
--
--   auto_sync_interval_hours minimum hours between auto-syncs for this brand.
--
--   last_synced_at          most recent sync (manual or auto). Drives the
--                           "Last synced 3d ago" label in the UI.
--
-- brand_id is intentionally NOT a FK to brand_spy.brands — cross-schema FKs
-- are fragile, and brand_spy is owned by a different worker. The relationship
-- is enforced at query time.

CREATE TABLE IF NOT EXISTS league_brand_configs (
  brand_id                 UUID PRIMARY KEY,
  top_pct                  INTEGER     NOT NULL DEFAULT 10 CHECK (top_pct BETWEEN 1 AND 100),
  tier_filter              TEXT[]      DEFAULT NULL,
  max_copy_length          INTEGER     DEFAULT NULL CHECK (max_copy_length IS NULL OR max_copy_length > 0),
  auto_sync_enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_sync_interval_hours INTEGER     NOT NULL DEFAULT 4 CHECK (auto_sync_interval_hours BETWEEN 1 AND 168),
  last_synced_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE league_brand_configs IS
  'Per-brand import preferences for the FROM LEAGUE column. Layered on top of spy_brand_follows.';
