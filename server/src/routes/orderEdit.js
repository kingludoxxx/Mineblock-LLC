// ORDER EDIT — admin surface for changing a settled order's line items and
// shipping address after purchase.
//
// Mounted at /api/v1/order-edit. Every route is behind the same
// authenticate + orders:access chain the rest of the CRM uses.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MONEY SEAM — READ THIS BEFORE WIRING A CHARGE
//
// NOTHING IN THIS ROUTER MOVES MONEY. Not the commit, not the settlement
// resolve, not anything. An edit that changes what the buyer owes writes a
// NEEDS-SETTLEMENT row and stops there.
//
// The contract for the integrator who wires the incremental charge/refund:
//
//   TRIGGER   a row in co_order_edit_settlements with status='needs_settlement'.
//             `direction` is 'charge' (buyer owes us) or 'refund' (we owe the
//             buyer); `amount` is ALWAYS a positive magnitude, so no caller can
//             accidentally add a refund into revenue.
//
//   CHARGE    idempotency key  `orderedit_<edit_row_id>`
//             edit_row_id is deterministic — sha256(session_id:edit_id) — so
//             the same edit maps to the same key forever, across processes and
//             restarts. Metadata must carry
//               { co_session_id, kind: 'order_edit', edit_row_id, version }
//             so an async settlement webhook routes to the order-edit handler
//             and not to the base-order settler (which would reconcile the
//             increment against the session total and park a false mismatch).
//
//   REFUND    route through the EXISTING refund path (gateway refund →
//             gatewayWebhooks applies the ledger → shopifyRefund reflects into
//             the store). Do NOT invent a second refund writer; the session
//             refunds[] ledger and the Shopify reflection are already
//             exactly-once and already agree with each other.
//
//   REPORT    call POST /order-edit/settlements/:editRowId/resolve with
//             action 'settled' + gateway_payment_id + settled_amount. That is
//             an atomic claim on a still-open row, so a webhook and an operator
//             racing the same settlement produce one transition.
//             On a decline, action 'failed' with the reason in `note`.
//
//   NEVER     write co_sessions.total from the charge path. `total` is what
//             the gateway captured for the ORIGINAL sale and is the ceiling
//             every refund path reads. The increment is its own transaction
//             with its own payment id; conflating them rewrites history and
//             silently moves the refund cap.
//
// SHOPIFY WRITE-BACK is implemented in services/shopifyOrderEdit.js and is OFF
// unless SHOPIFY_ORDER_EDIT_ENABLED=1 — see that file's header for why an
// additive, non-idempotent orderEditCommit must be opt-in per deployment.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { PricingUnavailableError } from '../services/checkoutPricing.js';
import {
  ensureOrderEditTables,
  loadSession,
  buildPreview,
  commitEdit,
  readEditState,
  listSettlements,
  resolveSettlement,
} from '../services/orderEditService.js';

const router = Router();

router.use(authenticate, requirePermission('orders', 'access'));

const actorOf = (req) =>
  [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
  req.user?.email ||
  req.user?.id ||
  'staff';

// co_sessions.id is TEXT, so there is no cast-error class to guard here the way
// routes/orders.js must for its BIGINT key — but a 5KB "session id" would still
// reach the driver as a parameter, so bound it.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const badSessionId = (v) => !SESSION_ID_RE.test(String(v || ''));

// ── settlement queue (declared BEFORE '/:sessionId' so 'settlements' is never
//    swallowed as a session id) ───────────────────────────────────────────────

router.get('/settlements', async (req, res) => {
  try {
    await ensureOrderEditTables();
    const out = await listSettlements({
      status: req.query.status ? String(req.query.status) : 'needs_settlement',
      days: req.query.days,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('[orderEdit] settlements list failed:', err);
    res.status(500).json({ error: 'Failed to load the settlement queue' });
  }
});

// Records an OUTCOME. Moves no money — see the MONEY SEAM block above.
router.post('/settlements/:editRowId/resolve', async (req, res) => {
  try {
    const out = await resolveSettlement({
      editRowId: String(req.params.editRowId || '').slice(0, 80),
      action: req.body?.action,
      actor: actorOf(req),
      note: req.body?.note,
      gatewayPaymentId: req.body?.gateway_payment_id,
      settledAmount: req.body?.settled_amount,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error, ...out });
    res.json({ success: true, data: out.settlement, money_moved: false });
  } catch (err) {
    console.error('[orderEdit] settlement resolve failed:', err);
    res.status(500).json({ error: 'Failed to resolve the settlement' });
  }
});

// ── order-keyed entry point ─────────────────────────────────────────────────
// The detail page is keyed on crm_orders.order_id (the Shopify order id). The
// ONLY link to a checkout session is co_orders.shopify_order_id → session_id —
// the same chain services/orderJourney.js documents. An order imported straight
// from Shopify has no session, and that is reported as linked:false with a
// reason rather than as an empty editor that reads like a bug.
router.get('/by-order/:orderId', async (req, res) => {
  try {
    if (!/^-?\d+$/.test(String(req.params.orderId))) {
      return res.status(404).json({ error: 'Order not found' });
    }
    await ensureOrderEditTables();
    const rows = await pgQuery(
      `SELECT c.order_id, c.shopify_order_id, c.source, c.fulfillment_status,
              c.financial_status, c.currency,
              (SELECT session_id FROM co_orders o
                WHERE o.shopify_order_id = c.shopify_order_id::text
                ORDER BY o.created_at ASC LIMIT 1) AS session_id
         FROM crm_orders c WHERE c.order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const row = rows[0];
    if (!row.session_id) {
      return res.json({
        success: true,
        data: {
          linked: false,
          reason: row.source === 'manual'
            ? 'manual_order_has_no_checkout_session'
            : row.shopify_order_id
              ? 'no_checkout_session_for_this_store_order'
              : 'order_never_mirrored_to_shopify',
          order_id: row.order_id,
        },
      });
    }
    const state = await readEditState(row.session_id, { historyLimit: req.query.history_limit });
    if (!state.ok) {
      return res.json({
        success: true,
        data: { linked: false, reason: 'session_row_missing', order_id: row.order_id, session_id: row.session_id },
      });
    }
    res.json({ success: true, data: { linked: true, order_id: row.order_id, ...state } });
  } catch (err) {
    console.error('[orderEdit] by-order failed:', err);
    res.status(500).json({ error: 'Failed to load order edit state' });
  }
});

// ── session-keyed ───────────────────────────────────────────────────────────

router.get('/:sessionId', async (req, res) => {
  try {
    if (badSessionId(req.params.sessionId)) return res.status(404).json({ error: 'Session not found' });
    const state = await readEditState(req.params.sessionId, { historyLimit: req.query.history_limit });
    if (!state.ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, data: state });
  } catch (err) {
    console.error('[orderEdit] state failed:', err);
    res.status(500).json({ error: 'Failed to load order edit state' });
  }
});

// PREVIEW — writes NOTHING. Server-side re-pricing of every added line, a full
// change list, and the total delta the operator is about to authorize.
router.post('/:sessionId/preview', async (req, res) => {
  try {
    if (badSessionId(req.params.sessionId)) return res.status(404).json({ error: 'Session not found' });
    await ensureOrderEditTables();
    const session = await loadSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let out;
    try {
      out = await buildPreview(session, req.body || {});
    } catch (err) {
      // Transport-class pricing failure is RETRYABLE and must never be
      // reported as a bad variant — a Shopify blip is not cart tampering.
      if (err instanceof PricingUnavailableError) {
        return res.status(503).json({ error: 'pricing_unavailable', retryable: true });
      }
      throw err;
    }
    if (!out.ok) return res.status(422).json({ error: out.error, ...out });

    // `_internal` carries the intermediate arrays the commit path reuses; it is
    // an implementation detail and never crosses the wire.
    const { _internal, ...clean } = out;
    void _internal;
    res.json({ success: true, data: { ...clean.preview, version: await currentVersionSafe(session.id) } });
  } catch (err) {
    console.error('[orderEdit] preview failed:', err);
    res.status(500).json({ error: 'Failed to build the edit preview' });
  }
});

async function currentVersionSafe(sessionId) {
  try {
    const rows = await pgQuery(
      `SELECT COALESCE(MAX(version), 0)::int AS v FROM co_order_edits WHERE session_id = $1`,
      [sessionId]
    );
    return rows[0]?.v ?? 0;
  } catch {
    return 0;
  }
}

// COMMIT — applies the edit. Writes the immutable version row, the settlement
// row, the snapshot mirror and (when armed) the Shopify push. Charges nothing.
router.post('/:sessionId/commit', async (req, res) => {
  try {
    if (badSessionId(req.params.sessionId)) return res.status(404).json({ error: 'Session not found' });
    const out = await commitEdit({
      sessionId: req.params.sessionId,
      body: req.body || {},
      actor: actorOf(req),
    });
    if (!out.ok) {
      const { status, ...rest } = out;
      return res.status(status || 422).json({ error: out.error, ...rest });
    }
    res.json({ success: true, data: out, money_moved: false });
  } catch (err) {
    console.error('[orderEdit] commit failed:', err);
    res.status(500).json({ error: 'Failed to apply the order edit' });
  }
});

export default router;
