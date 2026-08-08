// Orders module — every order placed through funnels, across all gateways.
// Phase 1 of the CRM build: list + detail UI backed by crm_orders, which is
// backfilled from shopify_orders_cache and enriched by the Shopify webhook.
// Funnel/attribution fields (funnel_name, utm, touches) are wired but stay
// empty until the tracking phase lands.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

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
  return { whereSql: `WHERE ${where.join(' AND ')}`, params, next: i };
}

const LIST_COLUMNS = `
  order_id, order_number, created_at, financial_status, fulfillment_status,
  delivery_status, total_price, currency, customer_email,
  customer_first_name, customer_last_name,
  destination_city, destination_state, destination_country,
  item_count, gateway, funnel_name, funnel_source, cogs, processing_fee,
  net_after_costs, refund_amount, tags, archived, shopify_order_id
`;

// GET /api/v1/orders — paginated list with search + filters
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const { whereSql, params, next } = buildFilters(req.query);

    const totalResult = await pgQuery(
      `SELECT COUNT(*)::int AS total FROM crm_orders ${whereSql}`,
      params
    );
    const total = totalResult[0].total;

    const rows = await pgQuery(
      `SELECT ${LIST_COLUMNS}
       FROM crm_orders ${whereSql}
       ORDER BY created_at DESC
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
    const rows = await pgQuery(
      `SELECT order_number, created_at, customer_first_name, customer_last_name,
              customer_email, total_price, currency, financial_status,
              fulfillment_status, item_count, destination_city, destination_state,
              destination_country, gateway, refund_amount
       FROM crm_orders ${whereSql}
       ORDER BY created_at DESC
       LIMIT 10000`,
      params
    );
    const header =
      'order,date,customer,email,total,currency,payment,fulfillment,items,destination,gateway,refunded';
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
