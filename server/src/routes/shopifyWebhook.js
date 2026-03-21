import { Router } from 'express';
import crypto from 'crypto';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import logger from '../utils/logger.js';
import {
  calculateOrderCosts,
  ensureTables,
  seedStaticData,
  MIN_ORDER_NUMBER,
} from './kpiSystem.js';

const router = Router();

const SHOPIFY_STORE = '17cca0-2.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';

// ── HMAC Verification ───────────────────────────────────────────────
function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    logger.warn('[Shopify Webhook] SHOPIFY_WEBHOOK_SECRET not configured');
    return false;
  }
  if (!hmacHeader) return false;

  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(hmacHeader)
  );
}

// ── Upsert a single order into shopify_orders_cache ─────────────────
async function upsertOrder(order) {
  const costs = calculateOrderCosts(order);

  await pgQuery(`
    INSERT INTO shopify_orders_cache (
      order_id, order_number, created_at, financial_status, fulfillment_status,
      total_price, subtotal_price, total_discounts, currency, country,
      customer_email, line_items, total_miners, total_rig_units,
      cogs, shipping_cost, gross_profit, profit_margin, synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
    ON CONFLICT (order_id) DO UPDATE SET
      financial_status = EXCLUDED.financial_status,
      fulfillment_status = EXCLUDED.fulfillment_status,
      total_price = EXCLUDED.total_price,
      subtotal_price = EXCLUDED.subtotal_price,
      total_discounts = EXCLUDED.total_discounts,
      line_items = EXCLUDED.line_items,
      total_miners = EXCLUDED.total_miners,
      total_rig_units = EXCLUDED.total_rig_units,
      cogs = EXCLUDED.cogs,
      shipping_cost = EXCLUDED.shipping_cost,
      gross_profit = EXCLUDED.gross_profit,
      profit_margin = EXCLUDED.profit_margin,
      synced_at = NOW()
  `, [
    order.id,
    order.order_number,
    order.created_at,
    order.financial_status,
    order.fulfillment_status,
    parseFloat(order.total_price || 0),
    parseFloat(order.subtotal_price || 0),
    parseFloat(order.total_discounts || 0),
    order.currency || 'USD',
    order.shipping_address?.country || order.billing_address?.country || 'Unknown',
    order.customer?.email || order.email || null,
    JSON.stringify(order.line_items || []),
    costs.totalMiners,
    costs.totalRigUnits,
    costs.cogs,
    costs.shippingCost,
    costs.grossProfit,
    costs.profitMargin,
  ]);

  return costs;
}

// ── Recalculate daily snapshot for a specific date ──────────────────
async function recalculateSnapshotForDate(dateStr) {
  const allOrders = await pgQuery(`
    SELECT * FROM shopify_orders_cache WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1
  `, [dateStr]);

  if (allOrders.length === 0) return;

  // Exclude refunded/voided orders from revenue calculations (consistent with main kpiSystem.js)
  const orders = allOrders.filter(o => !['refunded', 'voided'].includes(o.financial_status));
  const refundedOrders = allOrders.filter(o => ['refunded', 'voided'].includes(o.financial_status));

  const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.subtotal_price || o.total_price || 0), 0);
  const totalCogs = orders.reduce((s, o) => s + parseFloat(o.cogs || 0), 0);
  const totalShipping = orders.reduce((s, o) => s + parseFloat(o.shipping_cost || 0), 0);
  const totalDiscounts = orders.reduce((s, o) => s + parseFloat(o.total_discounts || 0), 0);
  const grossProfit = totalRevenue - totalCogs - totalShipping;
  const avgOv = orders.length > 0 ? totalRevenue / orders.length : 0;
  const avgMargin = orders.length > 0 ? orders.reduce((s, o) => s + parseFloat(o.profit_margin || 0), 0) / orders.length : 0;
  const totalMiners = orders.reduce((s, o) => s + (parseInt(o.total_miners) || 0), 0);
  const totalRigs = orders.reduce((s, o) => s + (parseInt(o.total_rig_units) || 0), 0);
  const refunds = refundedOrders.length;

  // Find top SKU
  const skuCounts = {};
  for (const o of orders) {
    const items = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items || []);
    for (const item of items) {
      if (item.sku) {
        skuCounts[item.sku] = (skuCounts[item.sku] || 0) + (item.quantity || 1);
      }
    }
  }
  const topSku = Object.entries(skuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  await pgQuery(`
    INSERT INTO daily_kpi_snapshots (
      snapshot_date, total_orders, total_revenue, total_cogs, total_shipping,
      total_discounts, gross_profit, avg_order_value, avg_profit_margin,
      total_miners_sold, total_rigs_sold, top_sku, refund_count, computed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT (snapshot_date) DO UPDATE SET
      total_orders = EXCLUDED.total_orders,
      total_revenue = EXCLUDED.total_revenue,
      total_cogs = EXCLUDED.total_cogs,
      total_shipping = EXCLUDED.total_shipping,
      total_discounts = EXCLUDED.total_discounts,
      gross_profit = EXCLUDED.gross_profit,
      avg_order_value = EXCLUDED.avg_order_value,
      avg_profit_margin = EXCLUDED.avg_profit_margin,
      total_miners_sold = EXCLUDED.total_miners_sold,
      total_rigs_sold = EXCLUDED.total_rigs_sold,
      top_sku = EXCLUDED.top_sku,
      refund_count = EXCLUDED.refund_count,
      computed_at = NOW()
  `, [
    dateStr, orders.length,
    Math.round(totalRevenue * 100) / 100,
    Math.round(totalCogs * 100) / 100,
    Math.round(totalShipping * 100) / 100,
    Math.round(totalDiscounts * 100) / 100,
    Math.round(grossProfit * 100) / 100,
    Math.round(avgOv * 100) / 100,
    Math.round(avgMargin * 100) / 100,
    totalMiners, totalRigs, topSku, refunds,
  ]);
}

// ── POST /orders — Shopify webhook receiver ─────────────────────────
router.post('/orders', async (req, res) => {
  // Respond 200 immediately — Shopify requires fast response
  res.status(200).json({ received: true });

  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const rawBody = req.rawBody;

    if (!rawBody) {
      logger.error('[Shopify Webhook] No raw body available — rawBody middleware may not be configured');
      return;
    }

    if (!verifyShopifyHmac(rawBody, hmac)) {
      logger.warn('[Shopify Webhook] HMAC verification failed');
      return;
    }

    const allowedTopics = ['orders/create', 'orders/updated', 'orders/paid'];
    if (!allowedTopics.includes(topic)) {
      logger.info(`[Shopify Webhook] Ignoring topic: ${topic}`);
      return;
    }

    const order = JSON.parse(rawBody);

    if ((order.order_number || 0) < MIN_ORDER_NUMBER) {
      logger.info(`[Shopify Webhook] Skipping order #${order.order_number} (below MIN_ORDER_NUMBER ${MIN_ORDER_NUMBER})`);
      return;
    }

    await ensureTables();
    await seedStaticData();

    const costs = await upsertOrder(order);

    // Recalculate the daily snapshot for this order's date
    const orderDate = new Date(order.created_at).toISOString().slice(0, 10);
    await recalculateSnapshotForDate(orderDate);

    logger.info(`[Shopify Webhook] Processed ${topic} — order #${order.order_number} | revenue=$${order.total_price} | cogs=$${costs.cogs} | profit=$${costs.grossProfit}`);
  } catch (err) {
    logger.error(`[Shopify Webhook] Error processing webhook: ${err.message}`, { stack: err.stack });
  }
});

// ── POST /register — Register webhook with Shopify ──────────────────
router.post('/register', authenticate, async (req, res) => {
  try {
    if (!SHOPIFY_TOKEN) {
      return res.status(400).json({ success: false, error: { message: 'SHOPIFY_ACCESS_TOKEN not configured' } });
    }

    const webhookAddress = 'https://mineblock-dashboard.onrender.com/api/v1/shopify-webhook/orders';

    const topics = ['orders/create', 'orders/updated', 'orders/paid'];
    const results = [];

    for (const topic of topics) {
      const resp = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            webhook: {
              topic,
              address: webhookAddress,
              format: 'json',
            },
          }),
        }
      );

      const data = await resp.json();

      if (resp.ok) {
        results.push({ topic, success: true, webhookId: data.webhook?.id });
        logger.info(`[Shopify Webhook] Registered webhook for ${topic} — id=${data.webhook?.id}`);
      } else {
        results.push({ topic, success: false, error: data.errors || data });
        logger.warn(`[Shopify Webhook] Failed to register ${topic}: ${JSON.stringify(data.errors || data)}`);
      }
    }

    res.json({ success: true, data: { results } });
  } catch (err) {
    logger.error(`[Shopify Webhook] Registration error: ${err.message}`);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
