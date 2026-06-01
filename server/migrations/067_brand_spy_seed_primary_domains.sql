-- Seed brand_domains with each brand's canonical primary domain.
--
-- The worker only inserts domains it observes in ad link_urls. For brands
-- whose ads all link to a subdomain (e.g. sale.getairmoto.com but never
-- getairmoto.com directly), the bare brand domain never made it into
-- brand_domains and the UI showed "no primary domain" for that brand.
--
-- Backfill: for every brand, ensure its `domain` column appears in
-- brand_domains with is_primary=true. Idempotent — uses ON CONFLICT.

INSERT INTO brand_spy.brand_domains (brand_id, domain, is_primary)
SELECT id, domain, TRUE
  FROM brand_spy.brands
ON CONFLICT (brand_id, domain) DO UPDATE SET is_primary = TRUE;
