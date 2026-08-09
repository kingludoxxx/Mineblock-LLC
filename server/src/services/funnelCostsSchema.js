// COGS / per-funnel P&L schema — single owner of all lb_* cost DDL so the
// engine (funnelCosts.js), the spend feed (funnelSpend.js) and the route file
// can never drift. Port of funnel-os lb_cogs_service's data model
// (backend/app/services/lb_cogs_service.py :46-92) to Postgres, single-tenant.
//
// Money-correctness lives in the shape, not in application checks:
//   - lb_cost_rates is APPEND-ONLY and effective-dated. An "edit" is a new
//     row; a revert is a new row restoring the old values. Nothing is ever
//     updated in place, so the rate in force for any past day is always
//     reconstructible and editing a cost today can never silently rewrite
//     last quarter's gross profit.
//   - unit_cogs NUMERIC NULL: NULL means *nobody has told us* (the leg is a
//     miss and profit is withheld); 0 means *known free* and is a real
//     answer. The column is nullable ON PURPOSE — a NOT NULL DEFAULT 0 here
//     would be the blank→0 coercion bug in DDL form.
//   - lb_ad_spend_daily PK (source, ref_id, day) → a re-sync upserts, never
//     duplicates a day of spend.
import { pgQuery } from '../db/pg.js';

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries. (Same pattern as checkoutSchema.js / trackingSchema.js.)
let tablesReadyPromise = null;

export function ensureFunnelCostsTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // ── lb_variant_costs — one row per detected sold variant (the catalog) ──
  // Written by the SOLD-only detect sweep (funnelCosts.runDetectSweep), which
  // $sets OBSERVED FACTS only. Operator-owned columns (coverage='ignored',
  // pays_shipping, kind_override, cost_item_id, units_per) are never moved by
  // the sweep — that split is the whole reason the sweep is safe to re-run.
  //
  // by_funnel is the PER-FUNNEL SPLIT: {fid: {revenue_30d, units_30d}}.
  // revenue_30d (top-level) is the variant's total across every funnel; a
  // funnel may only ever be credited with the money its own sessions
  // produced — attributing the total to each funnel double-counts a shared
  // variant (the reference's "two funnels report the same $40k" bug).
  //
  // first_sold (day key) exists for ONE reason: the FIRST cost entered for a
  // variant backdates to its first sale by default (funnel-os
  // resolve_effective_from :1106-1127) — "effective from today" on a first
  // entry would keep every historical report at 100% margin.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_variant_costs (
      variant_id TEXT PRIMARY KEY,
      product_title TEXT NOT NULL DEFAULT '',
      variant_title TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      shopify_product_id TEXT NOT NULL DEFAULT '',
      shopify_handle TEXT NOT NULL DEFAULT '',
      shopify_product_title TEXT NOT NULL DEFAULT '',
      contexts JSONB NOT NULL DEFAULT '[]',
      funnels JSONB NOT NULL DEFAULT '[]',
      by_funnel JSONB NOT NULL DEFAULT '{}',
      revenue_30d NUMERIC(14,2) NOT NULL DEFAULT 0,
      units_30d INT NOT NULL DEFAULT 0,
      price NUMERIC(12,2),
      first_sold TEXT NOT NULL DEFAULT '',
      last_sold TEXT NOT NULL DEFAULT '',
      kind_auto TEXT NOT NULL DEFAULT 'main',
      coverage TEXT NOT NULL DEFAULT 'needs_cost'
        CHECK (coverage IN ('needs_cost','ready','ignored')),
      pays_shipping BOOLEAN NOT NULL DEFAULT TRUE,
      kind_override TEXT,
      cost_item_id TEXT,
      units_per INT NOT NULL DEFAULT 1,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_variant_costs_coverage ON lb_variant_costs (coverage)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_variant_costs_revenue ON lb_variant_costs (revenue_30d DESC)`);

  // ── lb_cost_rates — APPEND-ONLY, effective-dated. THE ONE WRITE DOOR ──
  // The rate in force for day D is the row with the greatest
  // effective_from <= D (created_at, then id, break ties: the later WRITE
  // wins, so correcting today's typo is deterministic). Resolution happens in
  // JS (funnelCosts.buildRateIndex — load the rows once, bisect per lookup).
  // unit_cogs: NULL = unknown, 0 = known free — see the header.
  // ship: {default, main, upsell, addon, bump} per-unit per-context map;
  // each value number|null with the same null-vs-zero rule.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_cost_rates (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'variant' CHECK (scope IN ('variant','item')),
      variant_id TEXT,
      cost_item_id TEXT,
      effective_from DATE NOT NULL,
      unit_cogs NUMERIC(12,4),
      ship JSONB NOT NULL DEFAULT '{}',
      currency TEXT NOT NULL DEFAULT 'USD',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual','import','detect','revert')),
      batch_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_lb_cost_rates_variant
    ON lb_cost_rates (variant_id, effective_from DESC) WHERE scope = 'variant'
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_lb_cost_rates_item
    ON lb_cost_rates (cost_item_id, effective_from DESC) WHERE scope = 'item'
  `);

  // ── lb_fee_settings — single row (id = 1) ──
  // gateways: {"whop":null,"stripe":null,"paypal":null,"nmi":null} — a key
  // present but null means "this rail runs on the default rate". Seeding the
  // keys is the point: the operator sees the rails that exist without having
  // to know their names, and the flat 6% is satisfied on day one.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_fee_settings (
      id INT PRIMARY KEY CHECK (id = 1),
      default_pct NUMERIC(6,3) NOT NULL DEFAULT 6.0,
      default_fixed NUMERIC(10,4) NOT NULL DEFAULT 0,
      gateways JSONB NOT NULL DEFAULT '{"whop":null,"stripe":null,"paypal":null,"nmi":null}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL DEFAULT ''
    )
  `);

  // ── lb_ad_spend_daily — one row per (source, ref, day) of spend ──
  // source 'meta': ref_id = campaign_id (written by the sync).
  // source 'manual': ref_id = funnel_id (written by the operator).
  // day is a 'YYYY-MM-DD' UTC day key (TEXT so the whole lane compares day
  // keys as strings — no timezone re-parse anywhere).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_ad_spend_daily (
      source TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      day TEXT NOT NULL,
      spend NUMERIC(14,2) NOT NULL DEFAULT 0,
      campaign_name TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, ref_id, day)
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_ad_spend_day ON lb_ad_spend_daily (day)`);

  // ── lb_campaign_map — operator pins ONLY ──
  // Derived (majority-vote) bindings are computed per request from lb_clicks
  // and NEVER stored — a stored guess would be a frozen vote new sales could
  // not correct. A row here is the operator saying "this campaign IS this
  // funnel", and it wins over any derived binding.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_campaign_map (
      campaign_id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL DEFAULT ''
    )
  `);

  // ── lb_spend_sync_state — spend-feed health, one row per source ──
  // last_sync moves ONLY on success; last_attempt on every try. The gap
  // between them is the outage clock (/spend/status: stale >= 6h), and
  // last_sync is what the self-healing window (catchupDays) reads — a feed
  // that has been down re-pulls wide enough to close its own gap.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_spend_sync_state (
      source TEXT PRIMARY KEY,
      last_sync TIMESTAMPTZ,
      last_attempt TIMESTAMPTZ,
      last_ok BOOLEAN,
      error TEXT,
      fail_streak INT NOT NULL DEFAULT 0,
      state JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export default { ensureFunnelCostsTables };
