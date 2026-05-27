-- Add domain classification and freshness tracking to brand_domains
ALTER TABLE brand_spy.brand_domains
  ADD COLUMN IF NOT EXISTS domain_type  TEXT NOT NULL DEFAULT 'cross',
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE brand_spy.brand_domains
  DROP CONSTRAINT IF EXISTS brand_domains_type_check;

ALTER TABLE brand_spy.brand_domains
  ADD CONSTRAINT brand_domains_type_check
  CHECK (domain_type IN ('primary', 'subdomain', 'cross'));

-- Back-fill: mark the is_primary=true rows as 'primary'
UPDATE brand_spy.brand_domains SET domain_type = 'primary' WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS brand_domains_type_idx
  ON brand_spy.brand_domains (brand_id, domain_type);
