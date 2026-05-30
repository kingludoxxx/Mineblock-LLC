-- Persistent FROM LEAGUE dismissals.
-- Operator clicks the red X on a card → row inserted here. /league/ads
-- LEFT-JOIN-EXCLUDES against this table so dismissed ads never reappear
-- (until the operator explicitly undoes via DELETE).
CREATE TABLE IF NOT EXISTS league_dismissed_ads (
  brand_id       UUID        NOT NULL,
  ad_archive_id  TEXT        NOT NULL,
  dismissed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, ad_archive_id)
);

CREATE INDEX IF NOT EXISTS idx_league_dismissed_brand
  ON league_dismissed_ads (brand_id);
