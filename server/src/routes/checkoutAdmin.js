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

// ── Gateway credentials (per-funnel operator data) ─────────────────────────
// WRITE-ONLY semantics: null keeps the stored value, "" clears it, a value
// replaces it (encrypted at rest). Reads return only `*_set` booleans.

// GET /gateways/:funnelId — safe view of every gateway's config state.
router.get('/gateways/:funnelId', async (req, res) => {
  try {
    const { GATEWAYS, getPublicConfig } = await import('../services/gatewayConfigs.js');
    const funnelId = String(req.params.funnelId || '').slice(0, 64);
    const out = {};
    for (const gw of Object.keys(GATEWAYS)) {
      out[gw] = await getPublicConfig(funnelId, gw);
    }
    return res.json({ success: true, data: out });
  } catch (err) {
    console.error('[checkoutAdmin] gateways read failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// PUT /gateways/:funnelId/:gateway — write-only patch.
router.put('/gateways/:funnelId/:gateway', async (req, res) => {
  try {
    const { GATEWAYS, patchConfig } = await import('../services/gatewayConfigs.js');
    const gateway = String(req.params.gateway || '');
    if (!GATEWAYS[gateway]) {
      return res.status(404).json({ success: false, error: { code: 'unknown_gateway' } });
    }
    const funnelId = String(req.params.funnelId || '').slice(0, 64);
    if (!funnelId) {
      return res.status(422).json({ success: false, error: { code: 'funnel_required' } });
    }
    const view = await patchConfig(funnelId, gateway, req.body || {});
    return res.json({ success: true, data: view });
  } catch (err) {
    console.error('[checkoutAdmin] gateway patch failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// ── Upsell offers (co_upsells) — the CRM's offer definitions ───────────────
// variant_id '' = "charge whatever the on-page selection control resolves
// to"; price NULL = re-price the variant live from Shopify at accept time.

router.get('/upsells', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const params = [];
    let where = '';
    if (req.query.funnel_id) {
      params.push(String(req.query.funnel_id).slice(0, 64));
      where = `WHERE funnel_id = $1`;
    }
    const rows = await pgQuery(
      `SELECT * FROM co_upsells ${where} ORDER BY created_at DESC LIMIT 200`, params
    );
    return res.json({ success: true, data: { upsells: rows } });
  } catch (err) {
    console.error('[checkoutAdmin] upsells list failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

router.post('/upsells', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const b = req.body || {};
    const price = b.price === null || b.price === undefined || b.price === ''
      ? null
      : Math.round(Number(b.price) * 100) / 100;
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return res.status(422).json({ success: false, error: { code: 'invalid_price' } });
    }
    const { randomBytes } = await import('crypto');
    const id = `up_${randomBytes(8).toString('hex')}`;
    const [row] = await pgQuery(
      `INSERT INTO co_upsells (id, funnel_id, page_id, variant_id, price, title, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE)) RETURNING *`,
      [id,
        b.funnel_id ? String(b.funnel_id).slice(0, 64) : null,
        b.page_id ? String(b.page_id).slice(0, 64) : null,
        String(b.variant_id ?? '').slice(0, 80),
        price,
        String(b.title || '').slice(0, 200),
        typeof b.enabled === 'boolean' ? b.enabled : null]
    );
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[checkoutAdmin] upsell create failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

router.put('/upsells/:id', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const b = req.body || {};
    const sets = [];
    const params = [String(req.params.id).slice(0, 80)];
    const set = (sql, v) => { params.push(v); sets.push(`${sql} = $${params.length}`); };
    if (b.title !== undefined) set('title', String(b.title || '').slice(0, 200));
    if (b.variant_id !== undefined) set('variant_id', String(b.variant_id ?? '').slice(0, 80));
    if (b.price !== undefined) {
      set('price', b.price === null || b.price === '' ? null : Math.round(Number(b.price) * 100) / 100);
    }
    if (b.enabled !== undefined) set('enabled', Boolean(b.enabled));
    if (b.page_id !== undefined) set('page_id', b.page_id ? String(b.page_id).slice(0, 64) : null);
    if (!sets.length) {
      return res.status(422).json({ success: false, error: { code: 'nothing_to_update' } });
    }
    const rows = await pgQuery(
      `UPDATE co_upsells SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found' } });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[checkoutAdmin] upsell update failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// POST /sweeps/run — manual reconciliation trigger (ops). Same code path as
// the 10-minute cron.
router.post('/sweeps/run', async (req, res) => {
  try {
    const { runMoneySweepOnce } = await import('../services/moneySweeps.js');
    const stats = await runMoneySweepOnce();
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('[checkoutAdmin] sweep run failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
});

// GET /unmatched-payments — the operator queue of real money the system
// could not attribute. Check this queue.
router.get('/unmatched-payments', async (req, res) => {
  try {
    await ensureCheckoutTables();
    const rows = await pgQuery(
      `SELECT webhook_id, gateway, amount, currency, reason, resolved, created_at
       FROM co_unmatched_payments
       ORDER BY created_at DESC LIMIT 200`
    );
    return res.json({ success: true, data: { payments: rows } });
  } catch (err) {
    console.error('[checkoutAdmin] unmatched list failed:', err.message);
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
