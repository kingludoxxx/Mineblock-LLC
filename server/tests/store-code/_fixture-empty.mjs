// Minimal stand-in for the post-099 schema on an EMPTY database.
//
// The real 001-099 chain does not apply on an empty DB today (061 needs
// creative_analysis.meta_ad_id, which only the app adds lazily). Per the brief,
// the test creates the minimal tables Lane C's migrations ALTER. Lane A's
// 120_create_product_profiles.sql IS merged and is applied here for real. Column subsets mirror the real DDL cited in
// discovery/data-map.md §1a; nothing here is read by the app.
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR } from './_db.mjs';

export const EMPTY_FIXTURE_SQL = `
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
CREATE TABLE IF NOT EXISTS integrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID, provider TEXT);
CREATE TABLE IF NOT EXISTS creative_analysis (id SERIAL PRIMARY KEY, creative_id TEXT, ad_name TEXT);
CREATE TABLE IF NOT EXISTS spy_custom_images (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER NOT NULL, image_url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spy_creatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER, image_url TEXT, thumbnail_url TEXT,
  reference_thumbnail TEXT, im_number INTEGER, status TEXT DEFAULT 'review', created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS advertorial_copies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER NOT NULL, ad_copy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS organic_images (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), image_url TEXT NOT NULL, product_id INTEGER);
CREATE TABLE IF NOT EXISTS image_scrape_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), platform TEXT NOT NULL DEFAULT 'reddit', product_id INTEGER);
CREATE TABLE IF NOT EXISTS ad_batches (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER NOT NULL, name TEXT);
CREATE TABLE IF NOT EXISTS ad_launches (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID, creative_id UUID);
CREATE TABLE IF NOT EXISTS spy_brand_follows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER, brand_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS brief_pipeline_winners (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), creative_id TEXT NOT NULL, ad_name TEXT, product_code TEXT DEFAULT 'MR');
CREATE TABLE IF NOT EXISTS brief_pipeline_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), winner_id UUID, parent_creative_id TEXT NOT NULL DEFAULT 'MANUAL-TEST',
  brief_number INTEGER, product_code TEXT DEFAULT 'MR', naming_convention TEXT, status TEXT DEFAULT 'generated',
  clickup_task_id TEXT, clickup_task_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS launch_templates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, product_id INTEGER);
CREATE TABLE IF NOT EXISTS brief_copy_sets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER, angle TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS brief_launches (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brief_id UUID, template_id UUID, copy_set_id UUID);
CREATE TABLE IF NOT EXISTS statics_launches (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), creative_id UUID, ad_name TEXT);
CREATE TABLE IF NOT EXISTS image_store (id TEXT PRIMARY KEY, data BYTEA NOT NULL, content_type TEXT NOT NULL DEFAULT 'image/png', created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS statics_generation_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id INTEGER, product_name TEXT, status TEXT NOT NULL DEFAULT 'success');
CREATE TABLE IF NOT EXISTS brief_pipeline_references (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ad_archive_id TEXT NOT NULL, generated_brief_id UUID);
CREATE TABLE IF NOT EXISTS amazon_daily_kpis (id SERIAL PRIMARY KEY, kpi_date DATE);
CREATE TABLE IF NOT EXISTS meta_account_audit (id SERIAL PRIMARY KEY, account_id TEXT);
CREATE TABLE IF NOT EXISTS meta_sync_unmatched (id SERIAL PRIMARY KEY, account_id TEXT);
CREATE TABLE IF NOT EXISTS dismissed_iteration_winners (creative_id TEXT PRIMARY KEY, dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS brief_generation_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_spy_ad_id TEXT NOT NULL DEFAULT 'x', product_id INTEGER, product_code TEXT, status TEXT NOT NULL DEFAULT 'queued');
CREATE TABLE IF NOT EXISTS brief_number_counter (id INTEGER PRIMARY KEY DEFAULT 1, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS product_im_counters (product_id INTEGER PRIMARY KEY, next_im INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS statics_queue (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'queued', product_id INTEGER, "references" JSONB NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS co_funnel_products (id SERIAL PRIMARY KEY, funnel_id TEXT, shopify_product_id BIGINT);
CREATE TABLE IF NOT EXISTS co_whop_product_map (id SERIAL PRIMARY KEY, shopify_product_id BIGINT, whop_product_id TEXT);
CREATE TABLE IF NOT EXISTS statics_composer_imports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'processing', product_id INTEGER);
CREATE TABLE IF NOT EXISTS statics_iteration_configs (account_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE);
`;

// Lane A's 120 is merged now, so product_profiles comes from the REAL file that
// will precede Lane C's in order.json — not from a stand-in (review A1 note, F8).
export const PRECEDING_REAL_MIGRATIONS = ['120_create_product_profiles.sql'];

export async function loadEmptyFixture(c) {
  for (const f of PRECEDING_REAL_MIGRATIONS) {
    await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  }
  await c.query(EMPTY_FIXTURE_SQL);
}
