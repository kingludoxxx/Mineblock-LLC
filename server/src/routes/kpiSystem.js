import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const SHOPIFY_STORE = '17cca0-2.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';
const MIN_ORDER_NUMBER = 6009;

const UNIT_COST_PER_MINER = 10.92;

const MR_MINER_COUNTS = {
  'MR-01': 1, 'MR-02': 2, 'MR-04': 4, 'M5-05': 5,
};

const RIG_UNIT_COSTS = {
  'RIG-1': 1.96, 'RIG-2': 2.91, 'RIG-4': 3.87,
};

const RIG_SLOT_COUNTS = {
  'RIG-1': 1, 'RIG-2': 2, 'RIG-4': 4,
};

const SHIPPING_RATES_MR = {
  1:6.50,2:8.02,3:9.55,4:10.90,5:12.40,6:13.80,7:15.29,8:16.78,
  9:18.27,10:19.76,11:21.25,12:22.56,13:24.04,14:25.52,15:27.00,
  16:28.48,17:29.72,18:31.18,19:32.65,20:34.12,21:35.30,
};

const SHIPPING_RATES_RIG = { 1: 0.28, 2: 0.65, 4: 1.20 };

// ── DB Setup ────────────────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS supplier_costs (
      sku TEXT PRIMARY KEY,
      product_type TEXT NOT NULL,
      unit_cost NUMERIC(10,2) NOT NULL,
      miner_count INT DEFAULT 0,
      slot_count INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shipping_rates_mr (
      country TEXT NOT NULL,
      miner_count INT NOT NULL,
      rate NUMERIC(10,2) NOT NULL,
      PRIMARY KEY (country, miner_count)
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shipping_rates_rig (
      country TEXT NOT NULL,
      unit_count INT NOT NULL,
      rate NUMERIC(10,2) NOT NULL,
      PRIMARY KEY (country, unit_count)
    )
  `);

  await pgQuery(`
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
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS daily_kpi_snapshots (
      snapshot_date DATE PRIMARY KEY,
      total_orders INT DEFAULT 0,
      total_revenue NUMERIC(12,2) DEFAULT 0,
      total_cogs NUMERIC(12,2) DEFAULT 0,
      total_shipping NUMERIC(12,2) DEFAULT 0,
      total_discounts NUMERIC(12,2) DEFAULT 0,
      gross_profit NUMERIC(12,2) DEFAULT 0,
      avg_order_value NUMERIC(10,2) DEFAULT 0,
      avg_profit_margin NUMERIC(6,2) DEFAULT 0,
      total_miners_sold INT DEFAULT 0,
      total_rigs_sold INT DEFAULT 0,
      top_sku TEXT,
      refund_count INT DEFAULT 0,
      computed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS kpi_alerts (
      id SERIAL PRIMARY KEY,
      alert_type TEXT NOT NULL,
      severity TEXT DEFAULT 'warning',
      message TEXT NOT NULL,
      metric_name TEXT,
      metric_value NUMERIC,
      threshold NUMERIC,
      snapshot_date DATE,
      acknowledged BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  tablesReady = true;
}

async function seedStaticData() {
  // Seed supplier costs if empty
  const existing = await pgQuery('SELECT COUNT(*) as count FROM supplier_costs');
  if (parseInt(existing[0].count) === 0) {
    for (const [sku, count] of Object.entries(MR_MINER_COUNTS)) {
      await pgQuery(
        `INSERT INTO supplier_costs (sku, product_type, unit_cost, miner_count) VALUES ($1, 'MR', $2, $3) ON CONFLICT DO NOTHING`,
        [sku, UNIT_COST_PER_MINER, count]
      );
    }
    for (const [sku, cost] of Object.entries(RIG_UNIT_COSTS)) {
      await pgQuery(
        `INSERT INTO supplier_costs (sku, product_type, unit_cost, slot_count) VALUES ($1, 'RIG', $2, $3) ON CONFLICT DO NOTHING`,
        [sku, cost, RIG_SLOT_COUNTS[sku]]
      );
    }
  }

  // Seed MR shipping rates if empty
  const mrCount = await pgQuery('SELECT COUNT(*) as count FROM shipping_rates_mr');
  if (parseInt(mrCount[0].count) === 0) {
    for (const [count, rate] of Object.entries(SHIPPING_RATES_MR)) {
      await pgQuery(
        `INSERT INTO shipping_rates_mr (country, miner_count, rate) VALUES ('United States', $1, $2) ON CONFLICT DO NOTHING`,
        [parseInt(count), rate]
      );
    }
  }

  // Seed RIG shipping rates if empty
  const rigCount = await pgQuery('SELECT COUNT(*) as count FROM shipping_rates_rig');
  if (parseInt(rigCount[0].count) === 0) {
    for (const [count, rate] of Object.entries(SHIPPING_RATES_RIG)) {
      await pgQuery(
        `INSERT INTO shipping_rates_rig (country, unit_count, rate) VALUES ('United States', $1, $2) ON CONFLICT DO NOTHING`,
        [parseInt(count), rate]
      );
    }
  }
}

// ── Shopify API ─────────────────────────────────────────────────────
async function shopifyFetch(endpoint, params = {}) {
  const url = new URL(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
  });

  const linkHeader = resp.headers.get('link');
  let nextUrl = null;
  if (linkHeader) {
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (match) nextUrl = match[1];
  }

  const data = await resp.json();
  return { data, nextUrl };
}

async function fetchAllOrders(sinceId = null, extraQueryStr = '') {
  const allOrders = [];
  const params = { limit: '250', status: 'any' };
  if (sinceId) params.since_id = sinceId.toString();
  // Parse extra query params like &created_at_min=...
  if (extraQueryStr) {
    const extra = new URLSearchParams(extraQueryStr.replace(/^&/, ''));
    for (const [k, v] of extra) params[k] = v;
  }

  let result = await shopifyFetch('orders.json', params);
  allOrders.push(...(result.data.orders || []));

  while (result.nextUrl) {
    const resp = await fetch(result.nextUrl, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    const linkHeader = resp.headers.get('link');
    let nextUrl = null;
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextUrl = match[1];
    }
    const data = await resp.json();
    allOrders.push(...(data.orders || []));
    result = { data, nextUrl };
  }

  return allOrders;
}

// ── Cost Calculation ────────────────────────────────────────────────
function parseSku(sku) {
  if (!sku) return null;
  const upper = sku.toUpperCase().trim();

  for (const [prefix, minerCount] of Object.entries(MR_MINER_COUNTS)) {
    if (upper === prefix || upper.startsWith(prefix + '-') || upper.startsWith(prefix)) {
      return { type: 'MR', sku: prefix, minerCount };
    }
  }

  for (const [rigSku, cost] of Object.entries(RIG_UNIT_COSTS)) {
    if (upper === rigSku || upper.startsWith(rigSku + '-') || upper.startsWith(rigSku)) {
      return { type: 'RIG', sku: rigSku, unitCost: cost, slotCount: RIG_SLOT_COUNTS[rigSku] };
    }
  }

  return null;
}

function calculateOrderCosts(order) {
  const lineItems = order.line_items || [];
  const country = order.shipping_address?.country || order.billing_address?.country || 'United States';

  let totalMiners = 0;
  let totalRigUnits = 0;
  let rigCogs = 0;
  const skuBreakdown = [];

  for (const item of lineItems) {
    const parsed = parseSku(item.sku);
    if (!parsed) continue;

    if (parsed.type === 'MR') {
      const minersInLine = parsed.minerCount * (item.quantity || 1);
      totalMiners += minersInLine;
      skuBreakdown.push({ sku: parsed.sku, type: 'MR', quantity: item.quantity, miners: minersInLine });
    } else if (parsed.type === 'RIG') {
      const qty = item.quantity || 1;
      rigCogs += parsed.unitCost * qty;
      totalRigUnits += parsed.slotCount * qty;
      skuBreakdown.push({ sku: parsed.sku, type: 'RIG', quantity: qty, units: parsed.slotCount * qty });
    }
  }

  // MR COGS = total miners * unit cost
  const mrCogs = totalMiners * UNIT_COST_PER_MINER;

  // MR shipping lookup — extrapolate beyond max defined rate
  let mrShipping = 0;
  if (totalMiners > 0) {
    const maxDefined = Math.max(...Object.keys(SHIPPING_RATES_MR).map(Number));
    if (totalMiners <= maxDefined) {
      mrShipping = SHIPPING_RATES_MR[totalMiners] || SHIPPING_RATES_MR[maxDefined] || 0;
    } else {
      // Extrapolate: use max rate + per-unit rate for additional miners
      const maxRate = SHIPPING_RATES_MR[maxDefined];
      const prevRate = SHIPPING_RATES_MR[maxDefined - 1] || maxRate;
      const perUnitRate = maxRate - prevRate; // incremental cost per miner
      mrShipping = Math.round((maxRate + perUnitRate * (totalMiners - maxDefined)) * 100) / 100;
    }
  }

  // RIG shipping lookup — scale linearly for quantities beyond defined rates
  let rigShipping = 0;
  if (totalRigUnits > 0) {
    if (SHIPPING_RATES_RIG[totalRigUnits]) {
      rigShipping = SHIPPING_RATES_RIG[totalRigUnits];
    } else {
      // For undefined slot counts, calculate proportionally using the per-slot rate from 4-slot
      const perSlotRate = SHIPPING_RATES_RIG[4] / 4; // $0.30 per slot
      rigShipping = Math.round(perSlotRate * totalRigUnits * 100) / 100;
    }
  }

  const totalCogs = mrCogs + rigCogs;
  const totalShipping = mrShipping + rigShipping;
  // Use subtotal_price (product revenue only, excludes customer-paid shipping)
  const revenue = parseFloat(order.subtotal_price || order.total_price || 0);
  const grossProfit = revenue - totalCogs - totalShipping;
  const profitMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  return {
    totalMiners,
    totalRigUnits,
    cogs: Math.round(totalCogs * 100) / 100,
    shippingCost: Math.round(totalShipping * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    profitMargin: Math.round(profitMargin * 100) / 100,
    skuBreakdown,
  };
}

// ── Anomaly Detection ───────────────────────────────────────────────
async function runAnomalyDetection(snapshotDate) {
  // Get the last 14 days of snapshots for baseline
  const history = await pgQuery(`
    SELECT * FROM daily_kpi_snapshots
    WHERE snapshot_date < $1
    ORDER BY snapshot_date DESC
    LIMIT 14
  `, [snapshotDate]);

  if (history.length < 3) return; // Not enough data

  const today = await pgQuery(
    'SELECT * FROM daily_kpi_snapshots WHERE snapshot_date = $1',
    [snapshotDate]
  );
  if (today.length === 0) return;
  const snap = today[0];

  const avgRevenue = history.reduce((s, h) => s + parseFloat(h.total_revenue), 0) / history.length;
  const avgOrders = history.reduce((s, h) => s + parseInt(h.total_orders), 0) / history.length;
  const avgMargin = history.reduce((s, h) => s + parseFloat(h.avg_profit_margin), 0) / history.length;

  const alerts = [];

  // Revenue drop > 50%
  if (avgRevenue > 0 && parseFloat(snap.total_revenue) < avgRevenue * 0.5) {
    alerts.push({
      type: 'revenue_drop',
      severity: 'critical',
      message: `Revenue dropped to $${snap.total_revenue} (avg: $${avgRevenue.toFixed(2)})`,
      metric: 'total_revenue',
      value: parseFloat(snap.total_revenue),
      threshold: avgRevenue * 0.5,
    });
  }

  // Revenue spike > 200%
  if (avgRevenue > 0 && parseFloat(snap.total_revenue) > avgRevenue * 2) {
    alerts.push({
      type: 'revenue_spike',
      severity: 'info',
      message: `Revenue spiked to $${snap.total_revenue} (avg: $${avgRevenue.toFixed(2)})`,
      metric: 'total_revenue',
      value: parseFloat(snap.total_revenue),
      threshold: avgRevenue * 2,
    });
  }

  // Order count drop > 60%
  if (avgOrders > 0 && parseInt(snap.total_orders) < avgOrders * 0.4) {
    alerts.push({
      type: 'order_drop',
      severity: 'warning',
      message: `Orders dropped to ${snap.total_orders} (avg: ${avgOrders.toFixed(1)})`,
      metric: 'total_orders',
      value: parseInt(snap.total_orders),
      threshold: avgOrders * 0.4,
    });
  }

  // Margin below 20%
  if (parseFloat(snap.avg_profit_margin) < 20 && parseInt(snap.total_orders) > 0) {
    alerts.push({
      type: 'low_margin',
      severity: 'warning',
      message: `Profit margin at ${snap.avg_profit_margin}% (below 20% threshold)`,
      metric: 'avg_profit_margin',
      value: parseFloat(snap.avg_profit_margin),
      threshold: 20,
    });
  }

  // Margin shift > 15 points from average
  if (Math.abs(parseFloat(snap.avg_profit_margin) - avgMargin) > 15 && parseInt(snap.total_orders) > 0) {
    alerts.push({
      type: 'margin_shift',
      severity: 'warning',
      message: `Profit margin shifted to ${snap.avg_profit_margin}% (avg: ${avgMargin.toFixed(1)}%)`,
      metric: 'avg_profit_margin',
      value: parseFloat(snap.avg_profit_margin),
      threshold: avgMargin,
    });
  }

  for (const alert of alerts) {
    await pgQuery(`
      INSERT INTO kpi_alerts (alert_type, severity, message, metric_name, metric_value, threshold, snapshot_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [alert.type, alert.severity, alert.message, alert.metric, alert.value, alert.threshold, snapshotDate]);
  }
}

// ── Snapshot Recalculation ──────────────────────────────────────────
async function recalculateSnapshots() {
  const dates = await pgQuery(`
    SELECT DISTINCT DATE(created_at) as d
    FROM shopify_orders_cache
    ORDER BY d
  `);

  for (const row of dates) {
    const d = row.d;
    const allOrders = await pgQuery(`
      SELECT * FROM shopify_orders_cache WHERE DATE(created_at AT TIME ZONE 'UTC') = $1
    `, [d]);

    if (allOrders.length === 0) continue;

    // Filter out refunded/voided/cancelled orders from revenue calculations
    const orders = allOrders.filter(o => !['refunded', 'voided'].includes(o.financial_status));
    const refundedOrders = allOrders.filter(o => ['refunded', 'voided'].includes(o.financial_status));

    // Use subtotal_price (product revenue, excludes customer-paid shipping)
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
      d, orders.length,
      Math.round(totalRevenue * 100) / 100,
      Math.round(totalCogs * 100) / 100,
      Math.round(totalShipping * 100) / 100,
      Math.round(totalDiscounts * 100) / 100,
      Math.round(grossProfit * 100) / 100,
      Math.round(avgOv * 100) / 100,
      Math.round(avgMargin * 100) / 100,
      totalMiners, totalRigs, topSku, refunds,
    ]);

    await runAnomalyDetection(d);
  }
}

// ── Period Helpers ───────────────────────────────────────────────────
function getPeriodRange(period, dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  let start, end;

  if (period === 'daily') {
    start = dateStr;
    end = dateStr;
  } else if (period === 'weekly') {
    const day = date.getUTCDay();
    const diff = day === 0 ? 6 : day - 1; // Monday start
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - diff);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    start = monday.toISOString().slice(0, 10);
    end = sunday.toISOString().slice(0, 10);
  } else if (period === 'monthly') {
    start = dateStr.slice(0, 7) + '-01';
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    end = dateStr.slice(0, 7) + '-' + String(lastDay).padStart(2, '0');
  } else {
    start = dateStr;
    end = dateStr;
  }

  return { start, end };
}

// ── Routes ──────────────────────────────────────────────────────────

/** POST /sync — Pull Shopify orders, calculate costs, store KPIs */
router.post('/sync', authenticate, async (req, res) => {
  try {
    if (!SHOPIFY_TOKEN) {
      return res.status(400).json({ success: false, error: { message: 'SHOPIFY_ACCESS_TOKEN not configured' } });
    }

    await ensureTables();
    await seedStaticData();

    // Incremental sync: fetch new orders + re-fetch recent orders (last 3 days) to catch status changes
    const lastSynced = await pgQuery('SELECT MAX(order_id) as max_id FROM shopify_orders_cache');
    const sinceId = lastSynced[0]?.max_id || null;

    // Fetch new orders
    const newOrders = await fetchAllOrders(sinceId);

    // Also re-fetch orders from last 3 days to catch refunds/status changes
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const recentOrders = await fetchAllOrders(null, `&created_at_min=${threeDaysAgo}`);

    // Merge: use Map to deduplicate by order ID
    const orderMap = new Map();
    for (const o of [...newOrders, ...recentOrders]) {
      orderMap.set(o.id, o);
    }
    const orders = Array.from(orderMap.values());
    const eligible = orders.filter(o => (o.order_number || 0) >= MIN_ORDER_NUMBER);

    let synced = 0;
    let skipped = 0;

    for (const order of eligible) {
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
      synced++;
    }

    skipped = orders.length - eligible.length;

    // Recalculate daily snapshots
    await recalculateSnapshots();

    const totalOrders = await pgQuery('SELECT COUNT(*) as count FROM shopify_orders_cache');

    res.json({
      success: true,
      data: {
        fetched: orders.length,
        synced,
        skipped,
        totalCached: parseInt(totalOrders[0].count),
        incremental: !!sinceId,
      },
    });
  } catch (err) {
    console.error('[KPI Sync] Error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /dashboard — Aggregated KPIs for a period */
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period = 'daily', date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required (YYYY-MM-DD)' } });

    const { start, end } = getPeriodRange(period, date);

    const snapshots = await pgQuery(`
      SELECT * FROM daily_kpi_snapshots
      WHERE snapshot_date BETWEEN $1 AND $2
      ORDER BY snapshot_date
    `, [start, end]);

    if (snapshots.length === 0) {
      return res.json({
        success: true,
        data: {
          period, start, end,
          totalOrders: 0, totalRevenue: 0, totalCogs: 0, totalShipping: 0,
          totalDiscounts: 0, grossProfit: 0, avgOrderValue: 0, avgProfitMargin: 0,
          totalMinersSold: 0, totalRigsSold: 0, refundCount: 0, topSku: null,
          days: [],
        },
      });
    }

    const agg = {
      totalOrders: snapshots.reduce((s, r) => s + parseInt(r.total_orders), 0),
      totalRevenue: snapshots.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      totalCogs: snapshots.reduce((s, r) => s + parseFloat(r.total_cogs), 0),
      totalShipping: snapshots.reduce((s, r) => s + parseFloat(r.total_shipping), 0),
      totalDiscounts: snapshots.reduce((s, r) => s + parseFloat(r.total_discounts), 0),
      grossProfit: snapshots.reduce((s, r) => s + parseFloat(r.gross_profit), 0),
      totalMinersSold: snapshots.reduce((s, r) => s + parseInt(r.total_miners_sold || 0), 0),
      totalRigsSold: snapshots.reduce((s, r) => s + parseInt(r.total_rigs_sold || 0), 0),
      refundCount: snapshots.reduce((s, r) => s + parseInt(r.refund_count || 0), 0),
    };
    agg.avgOrderValue = agg.totalOrders > 0 ? Math.round((agg.totalRevenue / agg.totalOrders) * 100) / 100 : 0;
    agg.avgProfitMargin = agg.totalRevenue > 0 ? Math.round((agg.grossProfit / agg.totalRevenue) * 10000) / 100 : 0;

    // Find overall top SKU from the period's snapshots
    const skuFreq = {};
    for (const s of snapshots) {
      if (s.top_sku) skuFreq[s.top_sku] = (skuFreq[s.top_sku] || 0) + 1;
    }
    const topSku = Object.entries(skuFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    res.json({
      success: true,
      data: {
        period, start, end,
        ...agg,
        topSku,
        days: snapshots.map(s => ({
          date: s.snapshot_date,
          orders: parseInt(s.total_orders),
          revenue: parseFloat(s.total_revenue),
          cogs: parseFloat(s.total_cogs),
          shipping: parseFloat(s.total_shipping),
          grossProfit: parseFloat(s.gross_profit),
          margin: parseFloat(s.avg_profit_margin),
          minersSold: parseInt(s.total_miners_sold || 0),
          rigsSold: parseInt(s.total_rigs_sold || 0),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /cost-sheet — Detailed cost breakdown for a period */
router.get('/cost-sheet', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period = 'daily', date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required' } });

    const { start, end } = getPeriodRange(period, date);

    const orders = await pgQuery(`
      SELECT order_number, created_at, total_price, subtotal_price, cogs, shipping_cost,
             gross_profit, profit_margin, total_miners, total_rig_units,
             line_items, country, financial_status
      FROM shopify_orders_cache
      WHERE DATE(created_at) BETWEEN $1 AND $2
        AND financial_status NOT IN ('refunded', 'voided')
      ORDER BY created_at DESC
    `, [start, end]);

    const summary = {
      totalOrders: orders.length,
      totalRevenue: orders.reduce((s, o) => s + parseFloat(o.subtotal_price || o.total_price), 0),
      totalCogs: orders.reduce((s, o) => s + parseFloat(o.cogs), 0),
      totalShipping: orders.reduce((s, o) => s + parseFloat(o.shipping_cost), 0),
      totalGrossProfit: orders.reduce((s, o) => s + parseFloat(o.gross_profit), 0),
    };
    summary.overallMargin = summary.totalRevenue > 0
      ? Math.round((summary.totalGrossProfit / summary.totalRevenue) * 10000) / 100
      : 0;

    res.json({
      success: true,
      data: {
        period, start, end,
        summary,
        orders: orders.map(o => ({
          orderNumber: o.order_number,
          date: o.created_at,
          revenue: parseFloat(o.subtotal_price || o.total_price),
          cogs: parseFloat(o.cogs),
          shipping: parseFloat(o.shipping_cost),
          grossProfit: parseFloat(o.gross_profit),
          margin: parseFloat(o.profit_margin),
          miners: parseInt(o.total_miners),
          rigs: parseInt(o.total_rig_units),
          country: o.country,
          status: o.financial_status,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /trends — Revenue/profit/order trends over N days */
router.get('/trends', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const days = parseInt(req.query.days) || 30;

    const snapshots = await pgQuery(`
      SELECT * FROM daily_kpi_snapshots
      ORDER BY snapshot_date DESC
      LIMIT $1
    `, [days]);

    const sorted = snapshots.reverse();

    // Compute moving averages (7-day)
    const withMa = sorted.map((s, i) => {
      const window = sorted.slice(Math.max(0, i - 6), i + 1);
      return {
        date: s.snapshot_date,
        orders: parseInt(s.total_orders),
        revenue: parseFloat(s.total_revenue),
        cogs: parseFloat(s.total_cogs),
        shipping: parseFloat(s.total_shipping),
        grossProfit: parseFloat(s.gross_profit),
        margin: parseFloat(s.avg_profit_margin),
        minersSold: parseInt(s.total_miners_sold || 0),
        rigsSold: parseInt(s.total_rigs_sold || 0),
        aov: parseFloat(s.avg_order_value),
        ma7Revenue: Math.round(window.reduce((s2, w) => s2 + parseFloat(w.total_revenue), 0) / window.length * 100) / 100,
        ma7Orders: Math.round(window.reduce((s2, w) => s2 + parseInt(w.total_orders), 0) / window.length * 10) / 10,
        ma7Margin: Math.round(window.reduce((s2, w) => s2 + parseFloat(w.avg_profit_margin), 0) / window.length * 100) / 100,
      };
    });

    // Period-over-period comparison
    const currentPeriod = sorted.slice(-Math.min(days, sorted.length));
    const priorPeriod = sorted.slice(0, Math.max(0, sorted.length - days));

    const current = {
      revenue: currentPeriod.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      orders: currentPeriod.reduce((s, r) => s + parseInt(r.total_orders), 0),
    };
    const prior = {
      revenue: priorPeriod.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      orders: priorPeriod.reduce((s, r) => s + parseInt(r.total_orders), 0),
    };

    res.json({
      success: true,
      data: {
        days,
        dataPoints: withMa,
        comparison: {
          revenueChange: prior.revenue > 0
            ? Math.round(((current.revenue - prior.revenue) / prior.revenue) * 10000) / 100
            : null,
          orderChange: prior.orders > 0
            ? Math.round(((current.orders - prior.orders) / prior.orders) * 10000) / 100
            : null,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /sku-breakdown — Sales breakdown by SKU for a date range */
router.get('/sku-breakdown', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: { message: 'startDate and endDate are required' } });
    }

    const orders = await pgQuery(`
      SELECT line_items, total_price, cogs, shipping_cost, gross_profit
      FROM shopify_orders_cache
      WHERE DATE(created_at) BETWEEN $1 AND $2
    `, [startDate, endDate]);

    const skuData = {};

    for (const order of orders) {
      const items = typeof order.line_items === 'string' ? JSON.parse(order.line_items) : (order.line_items || []);
      for (const item of items) {
        const sku = item.sku || 'UNKNOWN';
        if (!skuData[sku]) {
          skuData[sku] = { sku, unitsSold: 0, revenue: 0, cogs: 0, orderCount: 0, title: item.title || sku };
        }
        const qty = item.quantity || 1;
        skuData[sku].unitsSold += qty;
        skuData[sku].revenue += parseFloat(item.price || 0) * qty;
        skuData[sku].orderCount++;

        // Calculate COGS per SKU
        const parsed = parseSku(sku);
        if (parsed.type === 'MR') {
          skuData[sku].cogs += UNIT_COST_PER_MINER * parsed.minerCount * qty;
        } else if (parsed.type === 'RIG') {
          skuData[sku].cogs += parsed.unitCost * qty;
        }
      }
    }

    const breakdown = Object.values(skuData).sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = breakdown.reduce((s, b) => s + b.revenue, 0);

    res.json({
      success: true,
      data: {
        startDate, endDate,
        totalSkus: breakdown.length,
        breakdown: breakdown.map(b => {
          const profit = b.revenue - b.cogs;
          const margin = b.revenue > 0 ? (profit / b.revenue) * 100 : 0;
          return {
            ...b,
            revenue: Math.round(b.revenue * 100) / 100,
            cogs: Math.round(b.cogs * 100) / 100,
            profit: Math.round(profit * 100) / 100,
            margin: Math.round(margin * 100) / 100,
            revenueShare: totalRevenue > 0 ? Math.round((b.revenue / totalRevenue) * 10000) / 100 : 0,
          };
        }),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /alerts — Recent anomaly alerts */
router.get('/alerts', authenticate, async (req, res) => {
  try {
    await ensureTables();

    const alerts = await pgQuery(`
      SELECT * FROM kpi_alerts
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const unacknowledged = alerts.filter(a => !a.acknowledged).length;

    res.json({
      success: true,
      data: {
        total: alerts.length,
        unacknowledged,
        alerts: alerts.map(a => ({
          id: a.id,
          type: a.alert_type,
          severity: a.severity,
          message: a.message,
          metric: a.metric_name,
          value: a.metric_value ? parseFloat(a.metric_value) : null,
          threshold: a.threshold ? parseFloat(a.threshold) : null,
          date: a.snapshot_date,
          acknowledged: a.acknowledged,
          createdAt: a.created_at,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /export — CSV export of KPI data */
router.get('/export', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period = 'daily', date, format = 'csv' } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required' } });
    if (format !== 'csv') return res.status(400).json({ success: false, error: { message: 'Only csv format is supported' } });

    const { start, end } = getPeriodRange(period, date);

    const orders = await pgQuery(`
      SELECT order_number, created_at, financial_status, fulfillment_status,
             total_price, subtotal_price, total_discounts, country,
             total_miners, total_rig_units, cogs, shipping_cost,
             gross_profit, profit_margin
      FROM shopify_orders_cache
      WHERE DATE(created_at) BETWEEN $1 AND $2
      ORDER BY created_at
    `, [start, end]);

    const headers = [
      'Order Number', 'Date', 'Financial Status', 'Fulfillment Status',
      'Revenue', 'Subtotal', 'Discounts', 'Country',
      'Miners', 'Rig Units', 'COGS', 'Shipping Cost',
      'Gross Profit', 'Profit Margin %',
    ];

    const rows = orders.map(o => [
      o.order_number,
      new Date(o.created_at).toISOString().slice(0, 19),
      o.financial_status || '',
      o.fulfillment_status || '',
      o.total_price,
      o.subtotal_price,
      o.total_discounts,
      o.country || '',
      o.total_miners,
      o.total_rig_units,
      o.cogs,
      o.shipping_cost,
      o.gross_profit,
      o.profit_margin,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.map(v => {
        const str = String(v ?? '');
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kpi-${period}-${date}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
export {
  calculateOrderCosts,
  ensureTables,
  parseSku,
  seedStaticData,
  runAnomalyDetection,
  UNIT_COST_PER_MINER,
  MR_MINER_COUNTS,
  RIG_UNIT_COSTS,
  RIG_SLOT_COUNTS,
  SHIPPING_RATES_MR,
  SHIPPING_RATES_RIG,
  MIN_ORDER_NUMBER,
};
