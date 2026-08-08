// Checkout admin — authenticated CRM surface over the money path (sessions,
// orders, upsell charges, unmatched-payments queue). Mount (integrator-owned,
// app.js or routes/index.js):
//   app.use('/api/v1/checkout', checkoutAdminRoutes);
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureCheckoutTables } from '../services/checkoutSchema.js';

const router = Router();

router.use(authenticate, requirePermission('checkout', 'access'));

// GET / — list sessions. Filters: status, q (email/id prefix), limit/offset.
router.get('/', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`status = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).slice(0, 100)}%`);
      where.push(`(id ILIKE $${params.length} OR customer->>'email' ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = await pgQuery(
      `SELECT id, funnel_id, page_id, status, subtotal, shipping, tax, total,
              currency, customer->>'email' AS email, gateway, import_status,
              needs_review_reason, paid_at, created_at, updated_at,
              COUNT(*) OVER() AS total_count
       FROM co_sessions ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({
      success: true,
      data: {
        sessions: rows.map(({ total_count, ...r }) => r),
        total: rows.length ? Number(rows[0].total_count) : 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('[checkoutAdmin] list failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /stats — money numbers. Revenue = status 'paid' ONLY ('processing' is
// intent, not money — the single most common analytics bug in the reference).
router.get('/stats', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const [row] = await pgQuery(`
      SELECT
        COUNT(*)::int                                            AS sessions_total,
        COUNT(*) FILTER (WHERE status = 'paid')::int             AS sessions_paid,
        COUNT(*) FILTER (WHERE status = 'processing')::int       AS sessions_processing,
        COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0)   AS revenue_paid,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS sessions_today,
        COALESCE(SUM(total) FILTER (
          WHERE status = 'paid' AND paid_at >= date_trunc('day', NOW())), 0) AS revenue_today
      FROM co_sessions
    `);
    const [unmatched] = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM co_unmatched_payments WHERE NOT resolved`
    );
    return res.json({
      success: true,
      data: {
        ...row,
        revenue_paid: Number(row.revenue_paid),
        revenue_today: Number(row.revenue_today),
        unmatched_payments_open: unmatched.n,
      },
    });
  } catch (err) {
    console.error('[checkoutAdmin] stats failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /:id — full session detail: row + event trail + orders + upsell charges.
router.get('/:id', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const id = String(req.params.id || '').slice(0, 80);
    const rows = await pgQuery(`SELECT * FROM co_sessions WHERE id = $1`, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found' } });
    }
    const [events, orders, charges] = await Promise.all([
      pgQuery(
        `SELECT kind, data, created_at FROM co_events
         WHERE session_id = $1 ORDER BY created_at ASC LIMIT 200`, [id]
      ),
      pgQuery(
        `SELECT id, idempotency_key, gateway, external_order_id, line_items,
                total, currency, created_at
         FROM co_orders WHERE session_id = $1 ORDER BY created_at ASC`, [id]
      ),
      pgQuery(
        `SELECT id, offer_id, charge_id, amount, currency, status,
                declined_by_user, created_at
         FROM co_upsell_charges WHERE session_id = $1 ORDER BY created_at ASC`, [id]
      ),
    ]);
    return res.json({
      success: true,
      data: { session: rows[0], events, orders, upsell_charges: charges },
    });
  } catch (err) {
    console.error('[checkoutAdmin] detail failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

export default router;
