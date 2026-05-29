-- Migration 055: Amazon (Sellerboard) daily KPIs cache
-- Stores one row per Amazon-day (Pacific Time, tagged to the matching
-- Berlin calendar date — see Option A in the timezone discussion).
-- Source: Sellerboard "Dashboard by day" CSV automation feed, polled daily.

CREATE TABLE IF NOT EXISTS amazon_daily_kpis (
  kpi_date         DATE PRIMARY KEY,
  gross_sales      NUMERIC(12, 2) DEFAULT 0,     -- SalesOrganic + SalesPPC
  units            INTEGER DEFAULT 0,             -- UnitsOrganic + UnitsPPC
  orders           INTEGER DEFAULT 0,
  ppc_spend        NUMERIC(12, 2) DEFAULT 0,     -- abs(SponsoredProducts + SponsoredDisplay + SponsoredBrands + SponsoredBrandsVideo)
  amazon_fees      NUMERIC(12, 2) DEFAULT 0,     -- abs(AmazonFees)
  refunds          INTEGER DEFAULT 0,
  net_profit       NUMERIC(12, 2) DEFAULT 0,     -- Sellerboard NetProfit (overstated until COGS configured in Sellerboard)
  raw_row          JSONB,                         -- full CSV row preserved for forensics
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amazon_daily_kpis_synced_at ON amazon_daily_kpis(synced_at DESC);
