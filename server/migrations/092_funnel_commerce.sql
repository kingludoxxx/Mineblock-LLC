-- 092_funnel_commerce.sql
-- Funnel Settings → Commerce → Products / Shipping.
--
-- Mirrors services/funnelCommerceSchema.js exactly (that module also creates
-- these on first request, so a fresh DB boots without a migrate run — this
-- file is the declared, reviewable form of the same DDL).
--
-- co_funnel_products.price / .variants[].price are DISPLAY DATA ONLY. The
-- checkout re-prices every variant server-side against the live Shopify Admin
-- API (services/checkoutPricing.js) before charging, so a stale row here can
-- never mis-charge a buyer.

CREATE TABLE IF NOT EXISTS co_funnel_products (
  funnel_id TEXT NOT NULL,
  shopify_product_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  price NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT '',
  variants_count INT NOT NULL DEFAULT 0,
  variants JSONB NOT NULL DEFAULT '[]',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (funnel_id, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS idx_co_funnel_products_funnel
  ON co_funnel_products (funnel_id, title);

-- UNIQUE (funnel_id, shopify_product_id): re-running "Map to Whop" upserts and
-- can never fan one Shopify product into two links. The reverse direction is
-- deliberately NOT unique — several Shopify products may back one Whop product
-- (a bundle).
CREATE TABLE IF NOT EXISTS co_whop_product_map (
  id TEXT PRIMARY KEY,
  funnel_id TEXT NOT NULL,
  shopify_product_id TEXT NOT NULL,
  shopify_title TEXT NOT NULL DEFAULT '',
  shopify_price NUMERIC(12,2),
  whop_product_id TEXT NOT NULL DEFAULT '',
  whop_product_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'linked',
  status TEXT NOT NULL DEFAULT 'unmapped',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (funnel_id, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS idx_co_whop_map_funnel
  ON co_whop_product_map (funnel_id, status);
