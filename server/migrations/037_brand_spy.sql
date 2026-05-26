-- ============================================================================
-- Brand Spy — Phase 1 + Phase 2 combined schema
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS brand_spy;

CREATE TABLE IF NOT EXISTS brand_spy.brands (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       UUID,
  workspace_id        UUID,
  domain              TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  notes               TEXT,
  active_ads_count    INTEGER NOT NULL DEFAULT 0,
  total_ads_count     INTEGER NOT NULL DEFAULT 0,
  pages_count         INTEGER NOT NULL DEFAULT 0,
  domains_count       INTEGER NOT NULL DEFAULT 0,
  banger_count        INTEGER,
  champ_count         INTEGER,
  tier_a_count        INTEGER,
  tier_b_count        INTEGER,
  tier_c_count        INTEGER,
  tier_low_count      INTEGER,
  tier_test_count     INTEGER,
  last_scraped_at     TIMESTAMPTZ,
  last_scrape_status  TEXT,
  last_scrape_error   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brands_status_check CHECK (status IN ('ACTIVE', 'NOISY', 'PAUSED', 'ERROR'))
);

CREATE UNIQUE INDEX IF NOT EXISTS brands_workspace_domain_uniq
  ON brand_spy.brands (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), domain);
CREATE INDEX IF NOT EXISTS brands_status_idx ON brand_spy.brands (status);
CREATE INDEX IF NOT EXISTS brands_last_scraped_idx ON brand_spy.brands (last_scraped_at);

CREATE TABLE IF NOT EXISTS brand_spy.brand_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  meta_page_id        TEXT NOT NULL,
  page_name           TEXT NOT NULL,
  page_profile_url    TEXT,
  page_profile_pic    TEXT,
  active_ads_count    INTEGER NOT NULL DEFAULT 0,
  total_ads_count     INTEGER NOT NULL DEFAULT 0,
  match_confidence    NUMERIC(3,2),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_pages_brand_meta_uniq UNIQUE (brand_id, meta_page_id)
);

CREATE INDEX IF NOT EXISTS brand_pages_brand_idx ON brand_spy.brand_pages (brand_id);

CREATE TABLE IF NOT EXISTS brand_spy.brand_domains (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL,
  is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
  active_ads_count    INTEGER NOT NULL DEFAULT 0,
  total_ads_count     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_domains_brand_domain_uniq UNIQUE (brand_id, domain)
);

CREATE INDEX IF NOT EXISTS brand_domains_brand_idx ON brand_spy.brand_domains (brand_id);

CREATE TABLE IF NOT EXISTS brand_spy.ads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  brand_page_id       UUID REFERENCES brand_spy.brand_pages(id) ON DELETE SET NULL,
  ad_archive_id       TEXT NOT NULL,
  meta_page_id        TEXT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,
  start_date          TIMESTAMPTZ,
  end_date            TIMESTAMPTZ,
  total_active_time   INTEGER,
  active_days         INTEGER,
  display_format      TEXT,
  cta_text            TEXT,
  cta_type            TEXT,
  headline            TEXT,
  body_text           TEXT,
  link_url            TEXT,
  caption             TEXT,
  publisher_platforms TEXT[],
  collation_id        TEXT,
  collation_count     INTEGER,
  tier                TEXT,
  tier_score          NUMERIC(6,3),
  current_rank        INTEGER,
  rank_3d             INTEGER,
  rank_7d             INTEGER,
  rank_21d            INTEGER,
  velocity_7d         INTEGER,
  velocity_21d        INTEGER,
  pool_size           INTEGER,
  tier_updated_at     TIMESTAMPTZ,
  raw_snapshot        JSONB,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ads_brand_archive_uniq UNIQUE (brand_id, ad_archive_id)
);

CREATE INDEX IF NOT EXISTS ads_brand_active_idx  ON brand_spy.ads (brand_id, is_active);
CREATE INDEX IF NOT EXISTS ads_brand_page_idx    ON brand_spy.ads (brand_page_id);
CREATE INDEX IF NOT EXISTS ads_archive_idx       ON brand_spy.ads (ad_archive_id);
CREATE INDEX IF NOT EXISTS ads_tier_idx          ON brand_spy.ads (brand_id, tier);
CREATE INDEX IF NOT EXISTS ads_last_seen_idx     ON brand_spy.ads (last_seen_at);
CREATE INDEX IF NOT EXISTS ads_brand_rank_idx    ON brand_spy.ads (brand_id, current_rank) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS ads_velocity_7d_idx   ON brand_spy.ads (brand_id, velocity_7d);

CREATE TABLE IF NOT EXISTS brand_spy.scrape_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  job_type            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'QUEUED',
  trigger             TEXT NOT NULL,
  pages_discovered    INTEGER NOT NULL DEFAULT 0,
  ads_discovered      INTEGER NOT NULL DEFAULT 0,
  ads_updated         INTEGER NOT NULL DEFAULT 0,
  credits_used        INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  CONSTRAINT scrape_jobs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'ERROR')),
  CONSTRAINT scrape_jobs_type_check   CHECK (job_type IN ('DISCOVER', 'REFRESH'))
);

CREATE INDEX IF NOT EXISTS scrape_jobs_brand_idx  ON brand_spy.scrape_jobs (brand_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS scrape_jobs_status_idx ON brand_spy.scrape_jobs (status) WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS brand_spy.ad_rank_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brand_spy.brands(id) ON DELETE CASCADE,
  ad_id               UUID NOT NULL REFERENCES brand_spy.ads(id) ON DELETE CASCADE,
  ad_archive_id       TEXT NOT NULL,
  rank                INTEGER NOT NULL,
  pool_size           INTEGER NOT NULL,
  tier                TEXT,
  is_active           BOOLEAN NOT NULL,
  snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ad_rank_snapshots_tier_check
    CHECK (tier IS NULL OR tier IN ('BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'))
);

CREATE INDEX IF NOT EXISTS ad_rank_snapshots_brand_time_idx   ON brand_spy.ad_rank_snapshots (brand_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS ad_rank_snapshots_ad_time_idx      ON brand_spy.ad_rank_snapshots (ad_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS ad_rank_snapshots_archive_time_idx ON brand_spy.ad_rank_snapshots (ad_archive_id, snapshot_at DESC);

CREATE OR REPLACE FUNCTION brand_spy.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brands_set_updated_at ON brand_spy.brands;
CREATE TRIGGER brands_set_updated_at
  BEFORE UPDATE ON brand_spy.brands
  FOR EACH ROW EXECUTE FUNCTION brand_spy.set_updated_at();

CREATE OR REPLACE FUNCTION brand_spy.prune_rank_snapshots(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM brand_spy.ad_rank_snapshots
   WHERE snapshot_at < NOW() - (days_to_keep || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
