// Funnel COMMERCE schema — single owner of the two tables behind Funnel
// Settings → Commerce → Products (and its Whop mapping popup).
//
//   co_funnel_products    the funnel's SYNCED Shopify catalog snapshot.
//                         DISPLAY DATA ONLY. Nothing here is ever charged:
//                         checkoutPricing.js re-prices every variant against
//                         the live Shopify Admin API before a card is touched,
//                         so a stale row can misinform an operator but can
//                         never mis-charge a buyer.
//   co_whop_product_map   Shopify product ↔ Whop product links, per funnel.
//                         UNIQUE (funnel_id, shopify_product_id) is the whole
//                         correctness story: re-running "Map to Whop" upserts
//                         and can never fan one Shopify product into two links.
//                         Several Shopify products MAY point at the same Whop
//                         product (a bundle) — that direction is deliberately
//                         not unique.
//
// Same single-in-flight-promise guard as trackingSchema/checkoutSchema:
// concurrent first requests must not run CREATE TABLE in parallel (pg_type
// unique violation). Mirrors migrations/092_funnel_commerce.sql — a fresh DB
// that has never run `npm run migrate` still boots.
import { pgQuery } from '../db/pg.js';

let tablesReadyPromise = null;

export function ensureCommerceTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  // ── co_funnel_products — the synced Shopify catalog, per funnel ──
  // `price` is the product's DISPLAY price (its first variant's). It is a
  // LABEL, exactly like shopifyVariants.js's price field — never an input to
  // any charge. `variants` is the full per-variant list as jsonb.
  await pgQuery(`
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
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_co_funnel_products_funnel
       ON co_funnel_products (funnel_id, title)`
  );

  // ── co_whop_product_map — Shopify product ↔ Whop product ──
  // source: 'matched'  an existing Whop product with the SAME name was found
  //         'created'  we minted one in Whop with that name
  //         'linked'   an operator picked the target by hand in the popup
  await pgQuery(`
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
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_co_whop_map_funnel
       ON co_whop_product_map (funnel_id, status)`
  );
}

export default { ensureCommerceTables };
