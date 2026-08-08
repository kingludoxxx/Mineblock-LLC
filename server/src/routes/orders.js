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

let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;

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

  // One-time backfill from the KPI system's Shopify cache, if it exists.
  // ON CONFLICT DO NOTHING makes re-runs harmless.
  try {
    const reg = await pgQuery(`SELECT to_regclass('shopify_orders_cache') AS t`);
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
          country, customer_email, COALESCE(line_items, '[]'::jsonb),
          COALESCE(jsonb_array_length(COALESCE(line_items, '[]'::jsonb)), 0),
          cogs, COALESCE(refund_amount, 0), refunded_at, order_id, synced_at
        FROM shopify_orders_cache
        ON CONFLICT (order_id) DO NOTHING
      `);
    }
  } catch (err) {
    // Backfill is best-effort; the module works without the KPI cache.
    console.error('[orders] backfill from shopify_orders_cache failed:', err.message);
  }

  tablesReady = true;
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
      customer_ip, refund_amount, tags, shopify_order_id, raw, synced_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW()
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
    ]
  );
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
    params.push(`%${query.q}%`);
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
