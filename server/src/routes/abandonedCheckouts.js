// Abandoned Checkouts — CRM Lane 1. People who started checkout on the store
// but never paid: recoverable revenue. Pulled from Shopify's checkouts API
// (webhook-less; synced on demand + on list load when stale). Gated under
// orders:access — same audience as Orders, deliberately no extra permission.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

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
    CREATE TABLE IF NOT EXISTS crm_abandoned_checkouts (
      checkout_id BIGINT PRIMARY KEY,
      token TEXT,
      email TEXT,
      customer_first_name TEXT,
      customer_last_name TEXT,
      phone TEXT,
      total_price NUMERIC(12,2) DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      line_items JSONB DEFAULT '[]',
      item_count INT DEFAULT 0,
      recovery_url TEXT,
      destination_city TEXT,
      destination_state TEXT,
      destination_country TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      raw JSONB,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_abandoned_created ON crm_abandoned_checkouts (created_at DESC)`
  );
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

async function syncFromShopify() {
  const store = process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) {
    throw new Error('Shopify not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN)');
  }
  let url = `https://${store}/admin/api/${apiVersion}/checkouts.json?limit=250&status=open`;
  let imported = 0;
  let pages = 0;
  while (url && pages < 40) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (resp.status === 429) {
      const wait = parseFloat(resp.headers.get('retry-after') || '2') * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 200);
      throw new Error(`Shopify checkouts fetch failed: HTTP ${resp.status} ${body}`);
    }
    const { checkouts } = await resp.json();
    for (const c of checkouts || []) {
      const ship = c.shipping_address || c.billing_address || null;
      const items = Array.isArray(c.line_items) ? c.line_items : [];
      await pgQuery(
        `
        INSERT INTO crm_abandoned_checkouts (
          checkout_id, token, email, customer_first_name, customer_last_name, phone,
          total_price, currency, line_items, item_count, recovery_url,
          destination_city, destination_state, destination_country,
          created_at, updated_at, completed_at, raw, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (checkout_id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, crm_abandoned_checkouts.email),
          total_price = EXCLUDED.total_price,
          line_items = EXCLUDED.line_items,
          item_count = EXCLUDED.item_count,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at,
          raw = EXCLUDED.raw,
          synced_at = NOW()
        `,
        [
          c.id,
          c.token || null,
          c.email || null,
          c.customer?.first_name || ship?.first_name || null,
          c.customer?.last_name || ship?.last_name || null,
          c.phone || c.customer?.phone || null,
          parseFloat(c.total_price || 0),
          c.currency || 'USD',
          items,
          items.reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0),
          c.abandoned_checkout_url || null,
          ship?.city || null,
          ship?.province_code || ship?.province || null,
          ship?.country_code || ship?.country || null,
          c.created_at,
          c.updated_at,
          c.completed_at || null,
          c,
        ]
      );
      imported += 1;
    }
    pages += 1;
    const link = resp.headers.get('link') || '';
    const next = link.split(',').find((p) => p.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)?.[1] : null;
    if (url) await new Promise((r) => setTimeout(r, 550));
  }
  return imported;
}

// GET /api/v1/abandoned — list (auto-syncs when stale > 10 min)
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const stale = await pgQuery(
      `SELECT COALESCE(MAX(synced_at) < NOW() - INTERVAL '10 minutes', TRUE) AS stale
       FROM crm_abandoned_checkouts`
    );
    if (stale[0].stale && req.query.nosync !== '1') {
      try {
        await syncFromShopify();
      } catch (err) {
        console.error('[abandoned] auto-sync failed (serving cached):', err.message);
      }
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const params = [];
    let where = `WHERE completed_at IS NULL`;
    if (req.query.q) {
      params.push(`%${escapeLike(req.query.q)}%`);
      where += ` AND (email ILIKE $1 OR (COALESCE(customer_first_name,'') || ' ' || COALESCE(customer_last_name,'')) ILIKE $1)`;
    }
    const total = await pgQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_price),0) AS value,
              COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS with_email
       FROM crm_abandoned_checkouts ${where}`,
      params
    );
    const rows = await pgQuery(
      `SELECT checkout_id, email, customer_first_name, customer_last_name, phone,
              total_price, currency, item_count, line_items, recovery_url,
              destination_city, destination_state, destination_country, created_at
       FROM crm_abandoned_checkouts ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({
      success: true,
      data: {
        checkouts: rows,
        total: total[0].n,
        value_at_stake: total[0].value,
        with_email: total[0].with_email,
        page,
        pages: Math.max(Math.ceil(total[0].n / limit), 1),
      },
    });
  } catch (err) {
    console.error('[abandoned] list failed:', err);
    res.status(500).json({ error: 'Failed to load abandoned checkouts' });
  }
});

// POST /api/v1/abandoned/sync — manual refresh
router.post('/sync', async (req, res) => {
  try {
    await ensureTables();
    const imported = await syncFromShopify();
    res.json({ success: true, data: { imported } });
  } catch (err) {
    console.error('[abandoned] sync failed:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

export default router;
