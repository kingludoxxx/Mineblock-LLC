-- 123_store_code_tagging.sql — Lane C (S1-1) store-code tagging. ADDITIVE ONLY (R6).
--
-- Adds `store_code TEXT NOT NULL DEFAULT <store>` and, where a product is
-- identifiable, `product_code TEXT` to every PER-STORE / PER-PRODUCT table of
-- discovery/data-map.md §1a/§1b named in the lane brief. No read path changes;
-- no row is moved; existing rows take the default and are refined by
-- server/scripts/backfill-store-codes.mjs.
--
-- Store code: the transaction-local setting `app.store_code`, which
-- server/migrations/run.js sets from env STORE_CODE
-- (SELECT set_config('app.store_code', $STORE_CODE, true)) inside the migration
-- transaction. There is NO fallback: unset, empty, or not ^[A-Z0-9]{2,4}$ RAISES
-- (review F1 — a default would have tagged every Puure row 'MB').
--
-- Tables the app creates LAZILY (data-map §1b) are created here first, so the tag
-- column exists before the route's CREATE TABLE IF NOT EXISTS ever runs. The DDL
-- is the owning route's base CREATE TABLE as of this commit (same pattern as
-- 024a); later columns the route adds with its own ALTER ... IF NOT EXISTS
-- (e.g. crm_orders.fulfillments, orders.js) still arrive from the route, and
-- both sides are IF NOT EXISTS, so whichever runs first wins (review F8).

-- ── 1. Lazily-created tables (verbatim DDL) ──────────────────────────────────

-- product_profiles is NOT re-created here: 120_create_product_profiles.sql (Lane A)
-- runs earlier in order.json and owns that DDL. Duplicating it made 123 lag the
-- route's column list (review F8).

-- server/src/routes/orders.js:48 (createTables)
CREATE TABLE IF NOT EXISTS crm_orders (
  order_id BIGINT PRIMARY KEY,
  order_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  financial_status TEXT,
  fulfillment_status TEXT,
  delivery_status TEXT,
  total_price NUMERIC(12,2) DEFAULT 0,
  subtotal_price NUMERIC(12,2) DEFAULT 0,
  shipping_price NUMERIC(12,2) DEFAULT 0,
  total_discounts NUMERIC(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  customer_email TEXT,
  customer_first_name TEXT,
  customer_last_name TEXT,
  customer_phone TEXT,
  shipping_address JSONB,
  billing_address JSONB,
  destination_city TEXT,
  destination_state TEXT,
  destination_country TEXT,
  line_items JSONB DEFAULT '[]',
  item_count INT DEFAULT 0,
  gateway TEXT,
  funnel_name TEXT,
  funnel_source TEXT,
  utm JSONB,
  client_order_id TEXT,
  order_type TEXT,
  customer_ip TEXT,
  cogs NUMERIC(12,2),
  processing_fee NUMERIC(12,2),
  net_after_costs NUMERIC(12,2),
  refund_amount NUMERIC(12,2) DEFAULT 0,
  refunded_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  archived BOOLEAN DEFAULT FALSE,
  shopify_order_id BIGINT,
  raw JSONB,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- server/src/routes/kpiSystem.js:593
CREATE TABLE IF NOT EXISTS shopify_orders_cache (
  order_id BIGINT PRIMARY KEY,
  order_number INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  financial_status TEXT,
  fulfillment_status TEXT,
  total_price NUMERIC(10,2),
  subtotal_price NUMERIC(10,2),
  total_discounts NUMERIC(10,2) DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  country TEXT,
  customer_email TEXT,
  line_items JSONB,
  total_miners INT DEFAULT 0,
  total_rig_units INT DEFAULT 0,
  cogs NUMERIC(10,2) DEFAULT 0,
  shipping_cost NUMERIC(10,2) DEFAULT 0,
  gross_profit NUMERIC(10,2) DEFAULT 0,
  profit_margin NUMERIC(6,2) DEFAULT 0,
  refund_amount NUMERIC(10,2) DEFAULT 0,
  refunded_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- server/src/routes/videoAdsLauncher.js:59 / :85
CREATE TABLE IF NOT EXISTS video_ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  original_name TEXT,
  file_size INTEGER DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  content_type TEXT DEFAULT 'video/mp4',
  source TEXT DEFAULT 'upload',
  source_url TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  meta_video_id TEXT,
  meta_video_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'uploaded',
  angle TEXT,
  product_id INTEGER,
  ad_copy JSONB DEFAULT '{}',
  launch_config JSONB DEFAULT '{}',
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_ad_launches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_ad_id UUID REFERENCES video_ads(id) ON DELETE CASCADE,
  template_id UUID,
  ad_account_id TEXT,
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  meta_video_id TEXT,
  ad_name TEXT,
  adset_name TEXT,
  page_id TEXT,
  page_name TEXT,
  batch_number INTEGER,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 029_create_image_store.sql / staticsGeneration.js:1616
CREATE TABLE IF NOT EXISTS image_store (
  id TEXT PRIMARY KEY,
  data BYTEA NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- server/src/routes/adsReporting.js:62
CREATE TABLE IF NOT EXISTS clickup_brief_resolutions (
  brief_number INTEGER PRIMARY KEY,
  task_id      TEXT,
  task_url     TEXT NOT NULL,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- server/src/routes/staticsGeneration.js:4891 (legacy global IM counter)
CREATE TABLE IF NOT EXISTS statics_im_counter (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_number INTEGER NOT NULL DEFAULT 1
);

-- server/src/routes/briefPipeline.js:1290
CREATE TABLE IF NOT EXISTS brief_pipeline_analysis_cache (
  creative_id TEXT PRIMARY KEY,
  script_hash TEXT,
  win_analysis JSONB,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Tag columns ───────────────────────────────────────────────────────────
DO $$
DECLARE
  sc TEXT := NULLIF(current_setting('app.store_code', true), '');
  t  TEXT;
  -- store_code only: the product is not identifiable per row, or the table
  -- already carries product_code (product_profiles, brief_pipeline_*,
  -- brief_generation_jobs).
  store_only TEXT[] := ARRAY[
    'product_profiles', 'integrations', 'creative_analysis',
    'brief_pipeline_winners', 'brief_pipeline_generated', 'brief_generation_jobs',
    'brief_pipeline_analysis_cache', 'amazon_daily_kpis', 'meta_account_audit',
    'meta_sync_unmatched', 'co_funnel_products', 'co_whop_product_map',
    'statics_iteration_configs', 'crm_orders', 'shopify_orders_cache'
  ];
  -- store_code + product_code: product identifiable (product_id, a parent row,
  -- a naming prefix, or a referencing creative).
  tag_both TEXT[] := ARRAY[
    'spy_custom_images', 'spy_creatives', 'advertorial_copies', 'organic_images',
    'image_scrape_jobs', 'ad_batches', 'ad_launches', 'spy_brand_follows',
    'launch_templates', 'brief_copy_sets', 'brief_launches', 'statics_launches',
    'image_store', 'statics_generation_events', 'brief_pipeline_references',
    'dismissed_iteration_winners', 'brief_number_counter', 'product_im_counters',
    'statics_queue', 'statics_composer_imports', 'video_ads', 'video_ad_launches',
    'clickup_brief_resolutions', 'statics_im_counter'
  ];
BEGIN
  -- FAIL CLOSED (review F1). No fallback code lives in this file: a default here
  -- would tag every row of whichever store forgot the variable, and 'MB' in engine
  -- SQL is a store literal (R15). server/migrations/run.js sets app.store_code from
  -- env STORE_CODE inside this transaction and REFUSES the run when it is unset.
  IF sc IS NULL THEN
    RAISE EXCEPTION '123: app.store_code is not set. This migration tags every row with the deploying store''s code; running it without one would label this database as another store. Run it through server/migrations/run.js with STORE_CODE set (^[A-Z0-9]{2,4}$).';
  END IF;
  IF sc !~ '^[A-Z0-9]{2,4}$' THEN
    RAISE EXCEPTION '123: app.store_code % is not a valid store_code (expected ^[A-Z0-9]{2,4}$)', quote_literal(sc);
  END IF;
  RAISE NOTICE '[123] store_code default = %', sc;

  FOREACH t IN ARRAY store_only || tag_both LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION '123: table % does not exist; it is created by 001-099 and must be present', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS store_code TEXT NOT NULL DEFAULT %L', t, sc);
  END LOOP;

  FOREACH t IN ARRAY tag_both LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS product_code TEXT', t);
  END LOOP;
END $$;

-- ── 3. Counters become keyed by product code ─────────────────────────────────
-- One counter row per product code. The primary keys (id / product_id / id=1)
-- are untouched so the current increment code keeps working; the partial
-- unique index is the new key. The code that increments them changes in a
-- later slice (see docs/lanes/lane-c.md).
CREATE UNIQUE INDEX IF NOT EXISTS ux_brief_number_counter_product_code
  ON brief_number_counter (product_code) WHERE product_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_statics_im_counter_product_code
  ON statics_im_counter (product_code) WHERE product_code IS NOT NULL;

-- product_im_counters is the exception (review F2). It is keyed PER PRODUCT
-- (product_id, 099:41), and product_profiles.product_code is NOT unique
-- (069_add_puure_product.sql:6) — one code legitimately covers several products,
-- which is Puure's shape. A UNIQUE (product_code) here therefore aborts the
-- backfill on a perfectly legal database. The key is (product_code, product_id):
-- it can never be violated (product_id is already the primary key), and it is the
-- index the per-code lookup of a later slice will use. Making one counter row per
-- CODE instead of per PRODUCT is a design decision the lead has not taken; until
-- then this index states the real key rather than a wished-for one.
DROP INDEX IF EXISTS ux_product_im_counters_product_code;
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_im_counters_code_product
  ON product_im_counters (product_code, product_id) WHERE product_code IS NOT NULL;

-- clickup_brief_resolutions keeps its PRIMARY KEY (brief_number) here because
-- adsReporting.js:714 upserts with ON CONFLICT (brief_number), which can only
-- be planned while that unique index exists. The key swap to
-- (product_code, brief_number) is server/migrations/staged/125_*.sql and ships
-- together with the keyed upsert.
CREATE INDEX IF NOT EXISTS idx_clickup_brief_resolutions_code_number
  ON clickup_brief_resolutions (product_code, brief_number);

COMMENT ON COLUMN clickup_brief_resolutions.product_code IS
  'Product code (PL, P1, MR, ...) the brief number belongs to. NULL = not yet attributed by the backfill.';
COMMENT ON COLUMN brief_number_counter.product_code IS
  'Product code this counter row serves. Unique per code. NULL = legacy row not yet attributed.';
COMMENT ON COLUMN product_im_counters.product_code IS
  'Product code of product_id, copied from product_profiles by the backfill. NOT unique on its own: one code may cover several products (review F2).';
COMMENT ON COLUMN statics_im_counter.product_code IS
  'Legacy global IM counter. CHECK (id = 1) still limits it to one row; keyed use needs the increment code to change first.';
