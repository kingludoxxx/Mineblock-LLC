// Customers module — CRM Lane 1. Customers are DERIVED from crm_orders by
// customer_email (no separate customer table yet): profiles, LTV, order
// history. Notes are the only owned table. Follows the orders.js house
// pattern: single route file, lazy DDL, pgQuery, {success, data} envelope.
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, requirePermission('customers', 'access'));

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
    CREATE TABLE IF NOT EXISTS crm_customer_notes (
      id BIGSERIAL PRIMARY KEY,
      customer_email TEXT NOT NULL,
      author TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_crm_customer_notes_email ON crm_customer_notes (customer_email, created_at DESC)`
  );
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

// Aggregation source: one row per customer_email. Identity fields come from
// the most recent order (latest name/phone/address wins).
//
// SOURCE AWARENESS (added with the manual-orders feature): `total_spent` is
// GATEWAY revenue only. A manual order is an operator's record of a sale taken
// somewhere else — no gateway confirmed it and no settlement backs it — so
// folding it into LTV would report spend the platform cannot substantiate, and
// a customer who exists ONLY as manual rows would show an LTV built entirely
// out of typed-in numbers. It is not hidden: `manual_spent` and
// `manual_orders_count` sit beside the real figures so an operator can see
// both, and `orders_count` still counts every order the customer placed.
//
// Retired rows (a manual record superseded by the real store order it was
// reconciled with) are excluded entirely — counting both is the double-count
// this whole column pair exists to prevent.
const CUSTOMER_AGG = `
  SELECT
    o.customer_email,
    (ARRAY_AGG(o.customer_first_name ORDER BY o.created_at DESC))[1] AS first_name,
    (ARRAY_AGG(o.customer_last_name  ORDER BY o.created_at DESC))[1] AS last_name,
    (ARRAY_AGG(o.customer_phone     ORDER BY o.created_at DESC))[1] AS phone,
    (ARRAY_AGG(o.destination_city    ORDER BY o.created_at DESC))[1] AS city,
    (ARRAY_AGG(o.destination_state   ORDER BY o.created_at DESC))[1] AS state,
    (ARRAY_AGG(o.destination_country ORDER BY o.created_at DESC))[1] AS country,
    COUNT(*)::int AS orders_count,
    COUNT(*) FILTER (WHERE o.source = 'manual')::int AS manual_orders_count,
    COALESCE(SUM(o.total_price) FILTER (WHERE o.source <> 'manual'), 0) AS total_spent,
    COALESCE(SUM(o.total_price) FILTER (WHERE o.source = 'manual'), 0) AS manual_spent,
    SUM(o.refund_amount) AS total_refunded,
    MIN(o.created_at) AS first_order_at,
    MAX(o.created_at) AS last_order_at
  FROM crm_orders o
  WHERE o.customer_email IS NOT NULL AND o.archived = FALSE AND o.retired_at IS NULL
`;

// GET /api/v1/customers — paginated list with search + sort
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const params = [];
    let having = '';
    if (req.query.q) {
      params.push(`%${escapeLike(req.query.q)}%`);
      having = `HAVING o.customer_email ILIKE $1
        OR (COALESCE((ARRAY_AGG(o.customer_first_name ORDER BY o.created_at DESC))[1], '') || ' ' ||
            COALESCE((ARRAY_AGG(o.customer_last_name ORDER BY o.created_at DESC))[1], '')) ILIKE $1`;
    }
    const sortMap = {
      total_spent: 'total_spent DESC NULLS LAST',
      orders: 'orders_count DESC',
      recent: 'last_order_at DESC',
      oldest: 'first_order_at ASC',
    };
    const orderBy = sortMap[req.query.sort] || sortMap.recent;

    const base = `${CUSTOMER_AGG} GROUP BY o.customer_email ${having}`;
    const totalRows = await pgQuery(`SELECT COUNT(*)::int AS n FROM (${base}) t`, params);
    const rows = await pgQuery(
      `SELECT * FROM (${base}) t ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({
      success: true,
      data: {
        customers: rows,
        total: totalRows[0].n,
        page,
        pages: Math.max(Math.ceil(totalRows[0].n / limit), 1),
      },
    });
  } catch (err) {
    console.error('[customers] list failed:', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// GET /api/v1/customers/stats — the KPI strip
router.get('/stats', async (req, res) => {
  try {
    await ensureTables();
    // avg_ltv and lifetime_revenue are GATEWAY revenue, for the reason spelled
    // out on CUSTOMER_AGG. The manual figures are reported alongside rather
    // than folded in or dropped, so the breakout is visible instead of implied.
    const rows = await pgQuery(`
      WITH per_customer AS (
        SELECT customer_email,
               COUNT(*)::int AS n,
               COALESCE(SUM(total_price) FILTER (WHERE source <> 'manual'), 0) AS spent,
               COALESCE(SUM(total_price) FILTER (WHERE source = 'manual'), 0) AS manual_spent,
               MIN(created_at) AS first_at
        FROM crm_orders
        WHERE customer_email IS NOT NULL AND archived = FALSE AND retired_at IS NULL
        GROUP BY customer_email
      )
      SELECT
        COUNT(*)::int AS total_customers,
        COUNT(*) FILTER (WHERE first_at >= date_trunc('day', NOW()))::int AS new_today,
        COUNT(*) FILTER (WHERE first_at >= NOW() - INTERVAL '30 days')::int AS new_30d,
        COUNT(*) FILTER (WHERE n > 1)::int AS repeat_customers,
        COALESCE(AVG(spent), 0) AS avg_ltv,
        COALESCE(SUM(spent), 0) AS lifetime_revenue,
        COALESCE(SUM(manual_spent), 0) AS manual_lifetime_revenue,
        COUNT(*) FILTER (WHERE manual_spent > 0)::int AS customers_with_manual_orders
      FROM per_customer
    `);
    const s = rows[0];
    s.repeat_rate =
      s.total_customers > 0 ? Math.round((s.repeat_customers / s.total_customers) * 1000) / 10 : 0;
    res.json({ success: true, data: s });
  } catch (err) {
    console.error('[customers] stats failed:', err);
    res.status(500).json({ error: 'Failed to load customer stats' });
  }
});

// GET /api/v1/customers/:email — profile + order history + notes
router.get('/:email', async (req, res) => {
  try {
    await ensureTables();
    const email = decodeURIComponent(req.params.email);
    const profile = await pgQuery(
      `SELECT * FROM (${CUSTOMER_AGG} AND o.customer_email = $1 GROUP BY o.customer_email) t`,
      [email]
    );
    if (!profile.length) return res.status(404).json({ error: 'Customer not found' });

    const [orders, notes, latest] = await Promise.all([
      pgQuery(
        // `source` rides along so the history table can badge a manual row —
        // without it the UI shows a typed-in number identically to a settled
        // charge, which is exactly the confusion the breakout exists to stop.
        `SELECT order_id, order_number, created_at, financial_status, fulfillment_status,
                total_price, currency, item_count, gateway, refund_amount, source
         FROM crm_orders
         WHERE customer_email = $1 AND archived = FALSE AND retired_at IS NULL
         ORDER BY created_at DESC LIMIT 100`,
        [email]
      ),
      pgQuery(
        `SELECT id, author, body, created_at FROM crm_customer_notes
         WHERE customer_email = $1 ORDER BY created_at DESC`,
        [email]
      ),
      pgQuery(
        `SELECT shipping_address, billing_address FROM crm_orders
         WHERE customer_email = $1 AND shipping_address IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      ),
    ]);

    res.json({
      success: true,
      data: {
        customer: profile[0],
        orders,
        notes,
        shipping_address: latest[0]?.shipping_address || null,
        billing_address: latest[0]?.billing_address || null,
      },
    });
  } catch (err) {
    console.error('[customers] detail failed:', err);
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

// POST /api/v1/customers/:email/notes
router.post('/:email/notes', async (req, res) => {
  try {
    await ensureTables();
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note body is required' });
    if (body.length > 5000) return res.status(400).json({ error: 'Note too long' });
    const author =
      [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
      req.user?.email ||
      'Staff';
    const inserted = await pgQuery(
      `INSERT INTO crm_customer_notes (customer_email, author, body)
       VALUES ($1, $2, $3) RETURNING id, author, body, created_at`,
      [decodeURIComponent(req.params.email), author, body]
    );
    res.json({ success: true, data: inserted[0] });
  } catch (err) {
    console.error('[customers] note failed:', err);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

export default router;
