// Orders module — every order placed through funnels, across all gateways.
// Phase 1 of the CRM build: list + detail UI backed by crm_orders, which is
// backfilled from shopify_orders_cache and enriched by the Shopify webhook.
// Funnel/attribution fields (funnel_name, utm, touches) are wired but stay
// empty until the tracking phase lands.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { buildOrderJourney } from '../services/orderJourney.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

// crm_orders.order_id is BIGINT, so a non-numeric ':id' reaching a query would
// surface as a Postgres cast error — a 500 that reads like a server fault when
// the truth is "no such order". Refuse it here instead. The leading '-' is
// REQUIRED, not incidental: manually recorded orders carry negative ids by
// construction (see POST /manual), and rejecting them would make every manual
// order unopenable.
router.param('id', (req, res, next, value) => {
  if (!/^-?\d+$/.test(String(value))) {
    return res.status(404).json({ error: 'Order not found' });
  }
  return next();
});

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries.
let tablesReadyPromise = null;

function ensureTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {

  await pgQuery(`
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
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_orders_created ON crm_orders (created_at DESC)`);
  // Added after initial table creation — safe on both fresh and existing DBs
  await pgQuery(`ALTER TABLE crm_orders ADD COLUMN IF NOT EXISTS fulfillments JSONB DEFAULT '[]'`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_orders_email ON crm_orders (customer_email)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_orders_archived ON crm_orders (archived)`);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS crm_order_comments (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      author TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_order_comments_order ON crm_order_comments (order_id, created_at DESC)`);

  // Provenance. 'shopify' = mirrored from the store (webhook / sync-shopify);
  // 'manual' = recorded by an operator through POST /manual. This column is the
  // ONLY thing that distinguishes them, and every money-path query in this repo
  // reads co_sessions / co_orders — never crm_orders — so a manual row can
  // never be mistaken for settled revenue by the gateway or settlement code.
  await pgQuery(`ALTER TABLE crm_orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'shopify'`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_orders_source ON crm_orders (source)`);

  // Saved views — named filter presets over the orders list, PER USER.
  // Ported from funnel-os's lb_order_view_prefs, with two deliberate changes:
  // theirs stores one prefs DOC per (workspace, user) holding an array of
  // views, so renaming one view rewrites the whole array and two tabs racing
  // lose each other's edits. Ours is one ROW per view, so CRUD is addressable
  // and concurrent edits to different views cannot clobber one another.
  // user_id is NOT NULL and every query filters on it — isolation is a WHERE
  // clause on every single statement, not a filter applied after the read.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lb_order_views (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}',
      sort TEXT NOT NULL DEFAULT 'created_at:desc',
      columns JSONB,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_lb_order_views_user ON lb_order_views (user_id, position, created_at)`);
  // One name per user. The DB arbitrates the duplicate, never a read-then-write.
  await pgQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_lb_order_views_user_name
    ON lb_order_views (user_id, lower(name))
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS crm_order_events (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_crm_order_events_order ON crm_order_events (order_id, created_at DESC)`);

  // Product image cache — Shopify order payloads carry no image URLs, so the
  // detail endpoint resolves them via the Products API and caches here.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS crm_product_images (
      product_id BIGINT PRIMARY KEY,
      image_src TEXT,
      variant_images JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Optional backfill from the KPI system's Shopify cache. OPT-IN via
  // CRM_BACKFILL_FROM_CACHE=1 — the cache may belong to a different store
  // than this deployment's (e.g. Mineblock cache on the Puure service), so
  // it must never run implicitly. Prefer POST /sync-shopify, which pulls
  // from the store this deployment is actually configured for.
  // ON CONFLICT DO NOTHING makes re-runs harmless.
  try {
    const reg =
      process.env.CRM_BACKFILL_FROM_CACHE === '1'
        ? await pgQuery(`SELECT to_regclass('shopify_orders_cache') AS t`)
        : null;
    if (reg?.[0]?.t) {
      await pgQuery(`
        INSERT INTO crm_orders (
          order_id, order_number, created_at, financial_status, fulfillment_status,
          total_price, subtotal_price, total_discounts, currency,
          destination_country, customer_email, line_items, item_count,
          cogs, refund_amount, refunded_at, shopify_order_id, synced_at
        )
        SELECT
          order_id, '#' || order_number::text, created_at, financial_status, fulfillment_status,
          total_price, subtotal_price, total_discounts, currency,
          country, customer_email,
          -- line_items may be double-encoded (jsonb string) in legacy cache rows
          CASE WHEN jsonb_typeof(line_items) = 'array' THEN line_items
               WHEN jsonb_typeof(line_items) = 'string' THEN (line_items #>> '{}')::jsonb
               ELSE '[]'::jsonb END,
          COALESCE(jsonb_array_length(
            CASE WHEN jsonb_typeof(line_items) = 'array' THEN line_items
                 WHEN jsonb_typeof(line_items) = 'string' THEN (line_items #>> '{}')::jsonb
                 ELSE '[]'::jsonb END), 0),
          cogs, COALESCE(refund_amount, 0), refunded_at, order_id, synced_at
        FROM shopify_orders_cache
        ON CONFLICT (order_id) DO NOTHING
      `);
    }
  } catch (err) {
    // Backfill is best-effort; the module works without the KPI cache.
    console.error('[orders] backfill from shopify_orders_cache failed:', err.message);
  }

}

// Upsert one order from a raw Shopify webhook payload. Called by
// shopifyWebhook.js (fail-open there) and available for backfill scripts.
export async function upsertOrderFromShopify(order) {
  await ensureTables();
  const ship = order.shipping_address || null;
  const bill = order.billing_address || null;
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const utm = extractUtms(order);
  await pgQuery(
    `
    INSERT INTO crm_orders (
      order_id, order_number, created_at, financial_status, fulfillment_status,
      total_price, subtotal_price, shipping_price, total_discounts, currency,
      customer_email, customer_first_name, customer_last_name, customer_phone,
      shipping_address, billing_address,
      destination_city, destination_state, destination_country,
      line_items, item_count, gateway, utm, client_order_id, order_type,
      customer_ip, refund_amount, tags, shopify_order_id, raw, fulfillments, synced_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW()
    )
    ON CONFLICT (order_id) DO UPDATE SET
      financial_status = EXCLUDED.financial_status,
      fulfillment_status = EXCLUDED.fulfillment_status,
      total_price = EXCLUDED.total_price,
      subtotal_price = EXCLUDED.subtotal_price,
      shipping_price = EXCLUDED.shipping_price,
      total_discounts = EXCLUDED.total_discounts,
      customer_email = COALESCE(EXCLUDED.customer_email, crm_orders.customer_email),
      customer_first_name = COALESCE(EXCLUDED.customer_first_name, crm_orders.customer_first_name),
      customer_last_name = COALESCE(EXCLUDED.customer_last_name, crm_orders.customer_last_name),
      customer_phone = COALESCE(EXCLUDED.customer_phone, crm_orders.customer_phone),
      shipping_address = COALESCE(EXCLUDED.shipping_address, crm_orders.shipping_address),
      billing_address = COALESCE(EXCLUDED.billing_address, crm_orders.billing_address),
      destination_city = COALESCE(EXCLUDED.destination_city, crm_orders.destination_city),
      destination_state = COALESCE(EXCLUDED.destination_state, crm_orders.destination_state),
      destination_country = COALESCE(EXCLUDED.destination_country, crm_orders.destination_country),
      line_items = EXCLUDED.line_items,
      item_count = EXCLUDED.item_count,
      gateway = COALESCE(EXCLUDED.gateway, crm_orders.gateway),
      utm = COALESCE(EXCLUDED.utm, crm_orders.utm),
      refund_amount = EXCLUDED.refund_amount,
      raw = EXCLUDED.raw,
      fulfillments = EXCLUDED.fulfillments,
      synced_at = NOW()
    `,
    [
      order.id,
      order.name || ('#' + order.order_number),
      order.created_at,
      order.financial_status,
      order.fulfillment_status,
      parseFloat(order.total_price || 0),
      parseFloat(order.subtotal_price || 0),
      parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0),
      parseFloat(order.total_discounts || 0),
      order.currency || 'USD',
      order.customer?.email || order.email || null,
      order.customer?.first_name || ship?.first_name || null,
      order.customer?.last_name || ship?.last_name || null,
      order.customer?.phone || ship?.phone || null,
      ship,
      bill,
      ship?.city || null,
      ship?.province_code || ship?.province || null,
      ship?.country_code || ship?.country || bill?.country_code || null,
      items,
      items.reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0),
      (order.payment_gateway_names && order.payment_gateway_names[0]) || order.gateway || null,
      utm,
      order.checkout_token || null,
      'NEW_SALE',
      order.client_details?.browser_ip || null,
      parseFloat(order.total_refunded || 0) ||
        (order.refunds || []).reduce(
          (sum, r) =>
            sum +
            (r.transactions || []).reduce((s, t) => s + parseFloat(t.amount || 0), 0),
          0
        ),
      (order.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      order.id,
      order,
      (order.fulfillments || []).map((f) => ({
        id: f.id,
        status: f.status,
        shipment_status: f.shipment_status || null,
        tracking_number: f.tracking_number || (f.tracking_numbers || [])[0] || null,
        tracking_company: f.tracking_company || null,
        tracking_url: f.tracking_url || (f.tracking_urls || [])[0] || null,
        created_at: f.created_at,
      })),
    ]
  );
}

// Resolve product images for line items via the Products API, cached in
// crm_product_images. Fail-open: image resolution must never break the page.
async function resolveLineItemImages(lineItems) {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
  const items = Array.isArray(lineItems) ? lineItems : [];
  const productIds = [...new Set(items.map((li) => li.product_id).filter(Boolean))];
  if (!productIds.length) return items;

  const imageMap = {}; // product_id -> { image_src, variant_images }
  try {
    const cached = await pgQuery(
      `SELECT product_id, image_src, variant_images FROM crm_product_images WHERE product_id = ANY($1)`,
      [productIds]
    );
    for (const row of cached) imageMap[row.product_id] = row;

    const missing = productIds.filter((id) => !imageMap[id]);
    if (missing.length && store && token) {
      for (const pid of missing.slice(0, 10)) {
        try {
          const resp = await fetch(
            `https://${store}/admin/api/${apiVersion}/products/${pid}.json?fields=id,image,images,variants`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (!resp.ok) continue; // deleted product, permissions, etc.
          const { product } = await resp.json();
          const variantImages = {};
          const imagesById = {};
          for (const img of product.images || []) imagesById[img.id] = img.src;
          for (const v of product.variants || []) {
            if (v.image_id && imagesById[v.image_id]) variantImages[v.id] = imagesById[v.image_id];
          }
          const row = {
            product_id: pid,
            image_src: product.image?.src || null,
            variant_images: variantImages,
          };
          imageMap[pid] = row;
          await pgQuery(
            `INSERT INTO crm_product_images (product_id, image_src, variant_images, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (product_id) DO UPDATE SET
               image_src = EXCLUDED.image_src,
               variant_images = EXCLUDED.variant_images,
               updated_at = NOW()`,
            [pid, row.image_src, row.variant_images]
          );
        } catch {
          /* per-product fail-open */
        }
      }
    }
  } catch (err) {
    console.error('[orders] image resolution failed (non-fatal):', err.message);
    return items;
  }

  return items.map((li) => {
    const entry = li.product_id ? imageMap[li.product_id] : null;
    if (!entry) return li;
    const vimgs =
      typeof entry.variant_images === 'string'
        ? JSON.parse(entry.variant_images)
        : entry.variant_images || {};
    return { ...li, image_url: vimgs[li.variant_id] || entry.image_src || null };
  });
}

function extractUtms(order) {
  const site = order.landing_site || '';
  const attrs = {};
  for (const na of order.note_attributes || []) {
    if (na?.name) attrs[na.name] = na.value;
  }
  let fromUrl = {};
  try {
    const qs = site.includes('?') ? site.split('?')[1] : '';
    fromUrl = Object.fromEntries(new URLSearchParams(qs));
  } catch {
    fromUrl = {};
  }
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  const utm = {};
  for (const k of keys) {
    const v = attrs[k] || fromUrl[k];
    if (v) utm[k] = v;
  }
  return Object.keys(utm).length ? utm : null;
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

function buildFilters(query) {
  const where = [];
  const params = [];
  let i = 1;

  if (query.archived === 'true') {
    where.push(`archived = TRUE`);
  } else {
    where.push(`archived = FALSE`);
  }
  if (query.q) {
    where.push(`(
      order_number ILIKE $${i} OR customer_email ILIKE $${i}
      OR (COALESCE(customer_first_name,'') || ' ' || COALESCE(customer_last_name,'')) ILIKE $${i}
    )`);
    params.push(`%${escapeLike(query.q)}%`);
    i += 1;
  }
  if (query.payment) {
    where.push(`financial_status = $${i}`);
    params.push(query.payment);
    i += 1;
  }
  if (query.fulfillment === 'unfulfilled') {
    where.push(`(fulfillment_status IS NULL OR fulfillment_status = 'unfulfilled')`);
  } else if (query.fulfillment) {
    where.push(`fulfillment_status = $${i}`);
    params.push(query.fulfillment);
    i += 1;
  }
  if (query.gateway) {
    where.push(`gateway ILIKE $${i}`);
    params.push(query.gateway);
    i += 1;
  }
  if (query.date_from) {
    where.push(`created_at >= $${i}`);
    params.push(query.date_from);
    i += 1;
  }
  if (query.date_to) {
    where.push(`created_at <= $${i}`);
    params.push(query.date_to);
    i += 1;
  }
  if (query.source) {
    where.push(`source = $${i}`);
    params.push(query.source);
    i += 1;
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params, next: i };
}

// Every filter key a saved view is allowed to carry. Anything else is dropped
// at write time, so a stored view can never smuggle an unexpected key into
// buildFilters — the view is data, and data does not get to name new columns.
const FILTER_KEYS = [
  'q',
  'payment',
  'fulfillment',
  'gateway',
  'date_from',
  'date_to',
  'archived',
  'source',
];

// ORDER BY is a WHITELIST, never interpolation. `sort` arrives as
// "<column>:<dir>"; an unknown column or direction falls back to the default
// rather than being passed through — a sort key is not a place to accept SQL.
const SORT_COLUMNS = {
  created_at: 'created_at',
  total_price: 'total_price',
  order_number: 'order_number',
  financial_status: 'financial_status',
  fulfillment_status: 'fulfillment_status',
  item_count: 'item_count',
};
const DEFAULT_SORT = 'created_at:desc';

function buildSort(sort) {
  const [rawCol, rawDir] = String(sort || DEFAULT_SORT).split(':');
  // An unrecognized column discards the WHOLE spec, direction included. A
  // half-honored sort ("your column was ignored but your ASC was kept") is the
  // kind of answer that reads as working and is not, so the fallback is total.
  const known = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, rawCol);
  const col = known ? SORT_COLUMNS[rawCol] : SORT_COLUMNS.created_at;
  const dir = known && String(rawDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // order_id is the tiebreaker so pagination is stable when the sort column
  // ties (two orders in the same second is routine under load).
  return { orderSql: `ORDER BY ${col} ${dir}, order_id DESC`, applied: `${col}:${dir.toLowerCase()}` };
}

const LIST_COLUMNS = `
  order_id, order_number, created_at, financial_status, fulfillment_status,
  delivery_status, total_price, currency, customer_email,
  customer_first_name, customer_last_name,
  destination_city, destination_state, destination_country,
  item_count, gateway, funnel_name, funnel_source, cogs, processing_fee,
  net_after_costs, refund_amount, tags, archived, shopify_order_id, source
`;

// GET /api/v1/orders — paginated list with search + filters
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const { whereSql, params, next } = buildFilters(req.query);
    const { orderSql, applied } = buildSort(req.query.sort);

    const totalResult = await pgQuery(
      `SELECT COUNT(*)::int AS total FROM crm_orders ${whereSql}`,
      params
    );
    const total = totalResult[0].total;

    const rows = await pgQuery(
      `SELECT ${LIST_COLUMNS}
       FROM crm_orders ${whereSql}
       ${orderSql}
       LIMIT $${next} OFFSET $${next + 1}`,
      [...params, limit, (page - 1) * limit]
    );

    res.json({
      success: true,
      data: {
        orders: rows,
        total,
        page,
        pages: Math.max(Math.ceil(total / limit), 1),
        // Echoed so the UI can show what actually ran — a silently-rejected
        // sort key must not look like it was honored.
        sort: applied,
      },
    });
  } catch (err) {
    console.error('[orders] list failed:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /api/v1/orders/stats/today — the KPI strip
router.get('/stats/today', async (req, res) => {
  try {
    await ensureTables();
    const stats = await pgQuery(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS orders_today,
        COALESCE(SUM(item_count) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::int AS items_today,
        COALESCE(SUM(refund_amount) FILTER (WHERE refunded_at >= date_trunc('day', NOW())), 0) AS returns_today,
        COALESCE(SUM(total_price) FILTER (
          WHERE created_at >= date_trunc('day', NOW())
            AND financial_status IN ('paid', 'partially_refunded', 'partially_paid')
        ), 0) AS revenue_today,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('day', NOW()) AND shopify_order_id IS NOT NULL
        )::int AS shopify_orders_today,
        AVG(EXTRACT(EPOCH FROM (fulfilled_at - created_at)) / 3600.0) FILTER (
          WHERE fulfilled_at IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
        ) AS avg_fulfillment_hours
      FROM crm_orders
      WHERE archived = FALSE
    `);
    res.json({ success: true, data: stats[0] });
  } catch (err) {
    console.error('[orders] stats failed:', err);
    res.status(500).json({ error: 'Failed to load order stats' });
  }
});

// GET /api/v1/orders/subscriptions — placeholder until the subscriptions phase
router.get('/subscriptions', async (req, res) => {
  res.json({ success: true, data: { subscriptions: [], total: 0 } });
});

// POST /api/v1/orders/sync-shopify — pull ALL orders from the configured
// Shopify store into crm_orders. Paginates via Link/page_info, respects the
// 2 req/s REST limit. Idempotent: upserts by order_id. Used for the initial
// import and as a manual catch-up; webhooks keep it live afterwards.
router.post('/sync-shopify', async (req, res) => {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) {
    return res.status(400).json({
      error:
        'Shopify not configured: set PUURE_SHOPIFY_STORE (or SHOPIFY_STORE_DOMAIN) and PUURE_SHOPIFY_TOKEN (or SHOPIFY_ACCESS_TOKEN)',
    });
  }
  try {
    await ensureTables();

    // Authoritative total for the success check
    const countRes = await fetch(
      `https://${store}/admin/api/${apiVersion}/orders/count.json?status=any`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    if (!countRes.ok) {
      const body = (await countRes.text()).slice(0, 200);
      return res
        .status(502)
        .json({ error: `Shopify count failed: HTTP ${countRes.status} ${body}` });
    }
    const shopifyTotal = (await countRes.json()).count;

    let url = `https://${store}/admin/api/${apiVersion}/orders.json?status=any&limit=250`;
    let imported = 0;
    let failed = 0;
    const failures = [];
    let pages = 0;

    while (url && pages < 200) {
      const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (resp.status === 429) {
        // Rate limited — honor Retry-After and retry the same page
        const wait = parseFloat(resp.headers.get('retry-after') || '2') * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 200);
        return res
          .status(502)
          .json({ error: `Shopify orders fetch failed: HTTP ${resp.status} ${body}`, imported });
      }
      const { orders } = await resp.json();
      for (const o of orders) {
        try {
          await upsertOrderFromShopify(o);
          imported += 1;
        } catch (e) {
          failed += 1;
          if (failures.length < 5) failures.push({ order: o.name, error: e.message });
        }
      }
      pages += 1;

      // Cursor pagination via the Link header
      const link = resp.headers.get('link') || '';
      const next = link.split(',').find((p) => p.includes('rel="next"'));
      url = next ? next.match(/<([^>]+)>/)?.[1] : null;
      if (url) await new Promise((r) => setTimeout(r, 550)); // stay under 2 req/s
    }

    const local = await pgQuery(`SELECT COUNT(*)::int AS n FROM crm_orders WHERE archived = FALSE`);
    res.json({
      success: true,
      data: {
        shopify_total: shopifyTotal,
        imported,
        failed,
        failures,
        pages,
        crm_orders_total: local[0].n,
        complete: failed === 0 && imported >= shopifyTotal,
      },
    });
  } catch (err) {
    console.error('[orders] sync-shopify failed:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// GET /api/v1/orders/export — CSV of the current filter set
router.get('/export', async (req, res) => {
  try {
    await ensureTables();
    const { whereSql, params } = buildFilters(req.query);
    const { orderSql } = buildSort(req.query.sort);
    const rows = await pgQuery(
      `SELECT order_number, created_at, customer_first_name, customer_last_name,
              customer_email, total_price, currency, financial_status,
              fulfillment_status, item_count, destination_city, destination_state,
              destination_country, gateway, refund_amount, source
       FROM crm_orders ${whereSql}
       ${orderSql}
       LIMIT 10000`,
      params
    );
    const header =
      'order,date,customer,email,total,currency,payment,fulfillment,items,destination,gateway,refunded,source';
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.order_number,
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        `${r.customer_first_name || ''} ${r.customer_last_name || ''}`.trim(),
        r.customer_email,
        r.total_price,
        r.currency,
        r.financial_status,
        r.fulfillment_status || 'unfulfilled',
        r.item_count,
        [r.destination_city, r.destination_state, r.destination_country].filter(Boolean).join(' '),
        r.gateway,
        r.refund_amount,
        r.source,
      ]
        .map(esc)
        .join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    console.error('[orders] export failed:', err);
    res.status(500).json({ error: 'Failed to export orders' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SAVED VIEWS — named filter presets over the orders list, per user.
//
// ROUTE ORDER IS LOAD-BEARING: every route below is a single literal segment
// and MUST be registered ahead of '/:id'. Express matches in declaration
// order, so a '/views' declared after '/:id' would be swallowed by it and —
// because order_id is BIGINT — would surface as a Postgres cast error 500,
// not a 404. Same for '/needs-review' and '/manual'.
// ═══════════════════════════════════════════════════════════════════════════

// The caller's identity. Saved views are per USER, so this is the isolation
// key; every statement below filters on it. authenticate() has already run, so
// req.user is present — but we refuse rather than fall back to a shared bucket
// if it somehow is not, because a missing key must never silently mean
// "everyone's views".
function viewOwner(req) {
  return req.user?.id || req.user?.userId || null;
}

// Keep only the filter keys the list endpoint actually understands, as strings.
// A view is stored data; it does not get to introduce new query keys.
function cleanFilters(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of FILTER_KEYS) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

// Columns are display-only hints for the client. Cap count and length so a
// view row cannot grow without bound; null means "the page default".
function cleanColumns(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) return null;
  return input.map((c) => String(c).slice(0, 40)).filter(Boolean).slice(0, 60);
}

function normalizeSort(sort) {
  return buildSort(sort).applied;
}

const VIEW_COLUMNS = `id, name, filters, sort, columns, position, created_at, updated_at`;

// GET /api/v1/orders/views — the caller's saved views
router.get('/views', async (req, res) => {
  try {
    await ensureTables();
    const userId = viewOwner(req);
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });
    const rows = await pgQuery(
      `SELECT ${VIEW_COLUMNS} FROM lb_order_views
       WHERE user_id = $1 ORDER BY position ASC, created_at ASC`,
      [userId]
    );
    res.json({ success: true, data: { views: rows } });
  } catch (err) {
    console.error('[orders] list views failed:', err);
    res.status(500).json({ error: 'Failed to load saved views' });
  }
});

// POST /api/v1/orders/views — { name, filters, sort, columns, position }
router.post('/views', async (req, res) => {
  try {
    await ensureTables();
    const userId = viewOwner(req);
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'View name is required' });

    const id = `ov_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const rows = await pgQuery(
      `INSERT INTO lb_order_views (id, user_id, name, filters, sort, columns, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, lower(name)) DO NOTHING
       RETURNING ${VIEW_COLUMNS}`,
      [
        id,
        userId,
        name,
        // The OBJECT, never JSON.stringify(...). This driver (postgres.js)
        // serializes a JS object into a jsonb OBJECT, but a pre-stringified
        // param is sent as text and lands as a jsonb STRING SCALAR — which
        // round-trips back as a string and silently breaks every reader.
        // Verified by execution; matches how utm/line_items are passed above.
        cleanFilters(req.body?.filters),
        normalizeSort(req.body?.sort),
        cleanColumns(req.body?.columns),
        Number.isFinite(Number(req.body?.position)) ? Number(req.body.position) : 0,
      ]
    );
    // Zero rows = the unique index refused a duplicate name for THIS user. The
    // database arbitrated it; we never read-then-wrote, so two tabs racing the
    // same name produce one view and one honest 409.
    if (!rows.length) {
      return res.status(409).json({ error: 'A view with that name already exists' });
    }
    res.status(201).json({ success: true, data: { view: rows[0] } });
  } catch (err) {
    console.error('[orders] create view failed:', err);
    res.status(500).json({ error: 'Failed to save view' });
  }
});

// PUT /api/v1/orders/views/:viewId — partial update; omitted fields unchanged
router.put('/views/:viewId', async (req, res) => {
  try {
    await ensureTables();
    const userId = viewOwner(req);
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const sets = [];
    const params = [req.params.viewId, userId];
    let i = 3;
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'View name cannot be empty' });
      sets.push(`name = $${i}`);
      params.push(name);
      i += 1;
    }
    if (req.body?.filters !== undefined) {
      // Object, not a string — see the note on the INSERT above.
      sets.push(`filters = $${i}`);
      params.push(cleanFilters(req.body.filters));
      i += 1;
    }
    if (req.body?.sort !== undefined) {
      sets.push(`sort = $${i}`);
      params.push(normalizeSort(req.body.sort));
      i += 1;
    }
    if (req.body?.columns !== undefined) {
      sets.push(`columns = $${i}`);
      params.push(cleanColumns(req.body.columns));
      i += 1;
    }
    if (req.body?.position !== undefined && Number.isFinite(Number(req.body.position))) {
      sets.push(`position = $${i}`);
      params.push(Number(req.body.position));
      i += 1;
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // The user_id predicate is the isolation gate: another user's view id
    // matches zero rows and returns 404 — it is never read, never updated, and
    // its existence is never disclosed.
    let rows;
    try {
      rows = await pgQuery(
        `UPDATE lb_order_views SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING ${VIEW_COLUMNS}`,
        params
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A view with that name already exists' });
      }
      throw err;
    }
    if (!rows.length) return res.status(404).json({ error: 'View not found' });
    res.json({ success: true, data: { view: rows[0] } });
  } catch (err) {
    console.error('[orders] update view failed:', err);
    res.status(500).json({ error: 'Failed to update view' });
  }
});

// DELETE /api/v1/orders/views/:viewId
router.delete('/views/:viewId', async (req, res) => {
  try {
    await ensureTables();
    const userId = viewOwner(req);
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });
    const rows = await pgQuery(
      `DELETE FROM lb_order_views WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.viewId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'View not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[orders] delete view failed:', err);
    res.status(500).json({ error: 'Failed to delete view' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NEEDS REVIEW — read-only surfacing of the money path's own distress signals.
//
// Three independent sources, each written by code this module does not touch:
//   co_sessions.needs_review_reason   settlement / webhook / sweep gave up
//   co_upsell_charges.status          a 1-click upsell charge went sideways
//   co_orders.shopify_status          the Shopify mirror-create failed
// Every one of those is set by checkout/gateway/settle code. We READ it. There
// is no action here beyond linking into the existing detail views — a row that
// says "a human owns this" must not get an auto-retry button bolted onto it.
// ═══════════════════════════════════════════════════════════════════════════

const NEEDS_REVIEW_TABLES = ['co_sessions', 'co_upsell_charges', 'co_orders'];

router.get('/needs-review', async (req, res) => {
  try {
    await ensureTables();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const presence = await pgQuery(
      `SELECT t AS name, to_regclass(t) IS NOT NULL AS present
       FROM unnest($1::text[]) AS t`,
      [NEEDS_REVIEW_TABLES]
    );
    const present = new Set(presence.filter((r) => r.present).map((r) => r.name));
    const unavailable = NEEDS_REVIEW_TABLES.filter((t) => !present.has(t));

    const sessions = present.has('co_sessions')
      ? await pgQuery(
          `SELECT s.id AS session_id, s.status, s.needs_review_reason AS reason,
                  s.total, s.currency, s.gateway, s.paid_at, s.created_at,
                  s.customer ->> 'email' AS customer_email,
                  ${present.has('co_orders') ? 'o.shopify_order_id' : 'NULL::text AS shopify_order_id'}
           FROM co_sessions s
           ${present.has('co_orders') ? 'LEFT JOIN co_orders o ON o.session_id = s.id' : ''}
           WHERE s.needs_review_reason IS NOT NULL
           ORDER BY s.created_at DESC
           LIMIT $1`,
          [limit]
        )
      : [];

    const upsells = present.has('co_upsell_charges')
      ? await pgQuery(
          `SELECT c.id, c.session_id, c.offer_id, c.charge_id, c.amount, c.currency,
                  c.status, c.declined_by_user, c.created_at, c.updated_at
           FROM co_upsell_charges c
           WHERE c.status IN ('needs_review', 'canceled')
           ORDER BY c.updated_at DESC
           LIMIT $1`,
          [limit]
        )
      : [];

    const shopifyCreates = present.has('co_orders')
      ? await pgQuery(
          `SELECT id, session_id, shopify_status, shopify_error, shopify_claimed_at,
                  total, currency, created_at
           FROM co_orders
           WHERE shopify_status = 'needs_review'
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        )
      : [];

    res.json({
      success: true,
      data: {
        sessions,
        upsell_charges: upsells,
        shopify_creates: shopifyCreates,
        counts: {
          sessions: sessions.length,
          upsell_charges: upsells.length,
          shopify_creates: shopifyCreates.length,
        },
        // A source whose table is absent is named, never silently counted as
        // zero — "no problems" and "not provisioned" are different facts.
        sources_unavailable: unavailable,
        capped: limit,
      },
    });
  } catch (err) {
    console.error('[orders] needs-review failed:', err);
    res.status(500).json({ error: 'Failed to load needs-review queue' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL ORDER — bookkeeping only.
//
// WHAT THE REFERENCE DOES, AND WHY WE DID NOT PORT IT WHOLE:
// funnel-os's create_manual_order (lb_order_edit_service.py:1375) inserts a
// draft co_sessions doc and then calls
//     client.create_checkout_session(amount=…, currency=…, metadata=…)
// against the live Whop gateway to mint a hosted payment link. No card is
// charged in that call, but it IS a gateway call-site on the money path, and
// the session it mints is later settled by the payment.succeeded webhook. That
// half belongs to the checkout/gateway lane, not here.
//
// WHAT THIS ENDPOINT IS: an operator-recorded order. It writes exactly ONE row
// to crm_orders with source='manual', and one audit row to crm_order_events.
// It writes NOTHING to co_sessions, co_orders or co_upsell_charges, calls no
// gateway, and cannot be settled — because settlement reads co_sessions, and a
// manual order has no session. It flows into the list, the stats strip and the
// CSV export like any other row, tagged so it can always be told apart.
//
// The order_id is NEGATIVE by construction. Shopify order ids are always
// positive, so the sign alone guarantees a manual row can never collide with,
// or be mistaken for, a mirrored store order — including by the ON CONFLICT
// (order_id) upsert that the Shopify webhook uses.
//
// FOR THE INTEGRATOR — the payment-link half, if it is ever wanted, is one
// call added in the checkout lane (NOT here):
//   1. in the gateway service, mint the link:
//        const link = await createCheckoutSession({ amount, currency,
//          metadata: { crm_manual_order_id: order_id, manual: '1' } });
//   2. persist link.purchase_url on the crm_orders row and return it;
//   3. the existing gatewayWebhooks settlement path already reconciles a paid
//      session — it needs no change, but the manual row must then be RETIRED
//      (or reconciled) when the real Shopify order arrives, or the store will
//      show the order twice.
// Until that lands, this endpoint is complete and honest on its own terms.
// ═══════════════════════════════════════════════════════════════════════════

const MANUAL_FINANCIAL = ['paid', 'pending', 'partially_paid', 'refunded', 'voided'];

router.post('/manual', async (req, res) => {
  try {
    await ensureTables();
    const b = req.body || {};

    const rawItems = Array.isArray(b.line_items) ? b.line_items : [];
    const items = rawItems
      .map((li) => ({
        title: String(li?.title || '').trim().slice(0, 200),
        quantity: Math.max(parseInt(li?.quantity, 10) || 0, 0),
        price: Number(li?.price),
        sku: li?.sku ? String(li.sku).slice(0, 100) : null,
      }))
      .filter((li) => li.title && li.quantity > 0 && Number.isFinite(li.price) && li.price >= 0)
      .slice(0, 100);
    if (!items.length) {
      return res
        .status(400)
        .json({ error: 'At least one line item with a title, quantity and price is required' });
    }

    const email = String(b.customer_email || '').trim().slice(0, 200);
    if (!email) return res.status(400).json({ error: 'Customer email is required' });

    const financialStatus = MANUAL_FINANCIAL.includes(b.financial_status)
      ? b.financial_status
      : 'paid';

    const subtotal = items.reduce((s, li) => s + li.price * li.quantity, 0);
    const shipping = Number.isFinite(Number(b.shipping_price)) ? Number(b.shipping_price) : 0;
    const discounts = Number.isFinite(Number(b.total_discounts)) ? Number(b.total_discounts) : 0;
    const total = Math.round((subtotal + shipping - discounts) * 100) / 100;
    if (total < 0) return res.status(400).json({ error: 'Order total cannot be negative' });

    // Negative id — see the block comment above.
    const orderId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    const orderNumber = String(b.reference || '').trim().slice(0, 40) ||
      `MAN-${String(Math.abs(orderId)).slice(-8)}`;
    const itemCount = items.reduce((n, li) => n + li.quantity, 0);
    const author =
      [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
      req.user?.email ||
      'Staff';

    const inserted = await pgQuery(
      `INSERT INTO crm_orders (
         order_id, order_number, created_at, financial_status, fulfillment_status,
         total_price, subtotal_price, shipping_price, total_discounts, currency,
         customer_email, customer_first_name, customer_last_name, customer_phone,
         shipping_address, destination_city, destination_state, destination_country,
         line_items, item_count, gateway, order_type, source, raw, synced_at
       ) VALUES (
         $1,$2,COALESCE($3::timestamptz, NOW()),$4,NULL,
         $5,$6,$7,$8,$9,
         $10,$11,$12,$13,
         $14,$15,$16,$17,
         $18,$19,'manual','MANUAL','manual',$20,NOW()
       )
       RETURNING ${LIST_COLUMNS}`,
      [
        orderId,
        orderNumber,
        b.created_at || null,
        financialStatus,
        total,
        Math.round(subtotal * 100) / 100,
        shipping,
        discounts,
        String(b.currency || 'USD').toUpperCase().slice(0, 8),
        email,
        String(b.customer_first_name || '').trim().slice(0, 120) || null,
        String(b.customer_last_name || '').trim().slice(0, 120) || null,
        String(b.customer_phone || '').trim().slice(0, 40) || null,
        b.shipping_address && typeof b.shipping_address === 'object' ? b.shipping_address : null,
        String(b.destination_city || '').trim().slice(0, 120) || null,
        String(b.destination_state || '').trim().slice(0, 120) || null,
        String(b.destination_country || '').trim().slice(0, 8) || null,
        JSON.stringify(items),
        itemCount,
        { manual: true, created_by: author, note: String(b.note || '').slice(0, 2000) || null },
      ]
    );

    await pgQuery(
      `INSERT INTO crm_order_events (order_id, kind, message, meta)
       VALUES ($1, 'manual_create', $2, $3)`,
      [
        orderId,
        `Manual order recorded by ${author}.`,
        { by: author, items: items.length, total, currency: inserted[0].currency },
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        order: inserted[0],
        // Stated on every response so no caller can mistake this for a charge.
        money_moved: false,
        note: 'Bookkeeping record only — no gateway was called and no payment was taken.',
      },
    });
  } catch (err) {
    console.error('[orders] manual create failed:', err);
    res.status(500).json({ error: 'Failed to record manual order' });
  }
});

// GET /api/v1/orders/:id — full detail with comments + timeline
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const id = req.params.id;
    const order = await pgQuery(`SELECT * FROM crm_orders WHERE order_id = $1`, [id]);
    if (!order.length) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const [comments, events, neighbors] = await Promise.all([
      pgQuery(
        `SELECT id, author, body, created_at FROM crm_order_comments
         WHERE order_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      pgQuery(
        `SELECT id, kind, message, meta, created_at FROM crm_order_events
         WHERE order_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      pgQuery(
        `SELECT
           (SELECT order_id FROM crm_orders
            WHERE created_at > (SELECT created_at FROM crm_orders WHERE order_id = $1)
              AND archived = FALSE
            ORDER BY created_at ASC LIMIT 1) AS newer,
           (SELECT order_id FROM crm_orders
            WHERE created_at < (SELECT created_at FROM crm_orders WHERE order_id = $1)
              AND archived = FALSE
            ORDER BY created_at DESC LIMIT 1) AS older`,
        [id]
      ),
    ]);
    const row = order[0];
    // Decorate line items with product images (cached; fail-open)
    row.line_items = await resolveLineItemImages(row.line_items);
    const customerOrders = row.customer_email
      ? await pgQuery(
          `SELECT COUNT(*)::int AS n FROM crm_orders WHERE customer_email = $1`,
          [row.customer_email]
        )
      : [{ n: 1 }];

    res.json({
      success: true,
      data: {
        order: row,
        comments,
        events,
        neighbors: neighbors[0],
        customer_order_count: customerOrders[0].n,
      },
    });
  } catch (err) {
    console.error('[orders] detail failed:', err);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// GET /api/v1/orders/:id/journey — the full cross-system event trail.
// STRICTLY READ-ONLY: the service it calls issues SELECTs only and touches no
// gateway. See services/orderJourney.js for the link chain and the sources.
router.get('/:id/journey', async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT order_id, order_number, created_at, shopify_order_id, source
       FROM crm_orders WHERE order_id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const journey = await buildOrderJourney(req.params.id, rows[0]);
    res.json({ success: true, data: journey });
  } catch (err) {
    console.error('[orders] journey failed:', err);
    res.status(500).json({ error: 'Failed to load order journey' });
  }
});

// POST /api/v1/orders/:id/comments — staff timeline comment
router.post('/:id/comments', async (req, res) => {
  try {
    await ensureTables();
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment body is required' });
    if (body.length > 5000) return res.status(400).json({ error: 'Comment too long' });
    const author =
      [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
      req.user?.email ||
      'Staff';
    const inserted = await pgQuery(
      `INSERT INTO crm_order_comments (order_id, author, body)
       VALUES ($1, $2, $3) RETURNING id, author, body, created_at`,
      [req.params.id, author, body]
    );
    res.json({ success: true, data: inserted[0] });
  } catch (err) {
    console.error('[orders] comment failed:', err);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

// POST /api/v1/orders/:id/fulfill — local mark-as-fulfilled (Shopify sync later)
router.post('/:id/fulfill', async (req, res) => {
  try {
    await ensureTables();
    const updated = await pgQuery(
      `UPDATE crm_orders
       SET fulfillment_status = 'fulfilled', fulfilled_at = NOW()
       WHERE order_id = $1 RETURNING order_id`,
      [req.params.id]
    );
    if (!updated.length) return res.status(404).json({ error: 'Order not found' });
    await pgQuery(
      `INSERT INTO crm_order_events (order_id, kind, message)
       VALUES ($1, 'fulfillment', $2)`,
      [req.params.id, `Marked as fulfilled by ${req.user?.email || 'staff'}.`]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[orders] fulfill failed:', err);
    res.status(500).json({ error: 'Failed to mark as fulfilled' });
  }
});

// POST /api/v1/orders/:id/archive — { archived: true|false }
router.post('/:id/archive', async (req, res) => {
  try {
    await ensureTables();
    const archived = req.body?.archived !== false;
    const updated = await pgQuery(
      `UPDATE crm_orders SET archived = $2 WHERE order_id = $1 RETURNING order_id`,
      [req.params.id, archived]
    );
    if (!updated.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[orders] archive failed:', err);
    res.status(500).json({ error: 'Failed to archive order' });
  }
});

// PUT /api/v1/orders/:id/tags — { tags: string[] }
router.put('/:id/tags', async (req, res) => {
  try {
    await ensureTables();
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50)
      : [];
    const updated = await pgQuery(
      `UPDATE crm_orders SET tags = $2 WHERE order_id = $1 RETURNING tags`,
      [req.params.id, tags]
    );
    if (!updated.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, data: { tags: updated[0].tags } });
  } catch (err) {
    console.error('[orders] tags failed:', err);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

export default router;
