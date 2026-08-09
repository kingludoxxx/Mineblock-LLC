// COGS / per-funnel P&L — authed operator surface over the cost engine
// (funnelCosts.js) and the spend feed (funnelSpend.js). Mount
// (integrator-owned, routes/index.js):
//   app.use('/api/v1/funnel-costs', funnelCostsRoutes);
//
// Same guard as the other funnel surfaces: authenticate +
// requirePermission('funnels','access'). Services LET IT THROW; this file is
// the boundary that maps CostError → 4xx {success:false, error:{code}} and
// everything else → 500 internal_error (message logged, never a token).
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureFunnelCostsTables } from '../services/funnelCostsSchema.js';
import { ensureCheckoutTables } from '../services/checkoutSchema.js';
import { ensureTrackingTables } from '../services/trackingSchema.js';
import {
  CostError, appendRate, listRates, rateHistory, getFeeSettings,
  updateFeeSettings, runDetectSweep, coverageSummary, listVariants,
  listByFunnel, patchVariant, pnlOverview, pnlFunnel, round2,
} from '../services/funnelCosts.js';
import {
  syncMetaCampaignSpend, spendStatus, startSpendTicker,
  SPEND_CATCHUP_MAX_DAYS,
} from '../services/funnelSpend.js';
import { pgQuery } from '../db/pg.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// Ensure-on-demand + start the in-process 30-min spend tick (throttled on
// attempt inside funnelSpend — this call is idempotent and cheap).
router.use(async (req, res, next) => {
  try {
    // The engine reads co_sessions/co_upsell_charges + lb_clicks raw — on a
    // fresh DB those owners must ensure too (sweep finding F2: 42P01 without).
    await ensureFunnelCostsTables();
    await ensureCheckoutTables();
    await ensureTrackingTables();
    startSpendTicker();
    next();
  } catch (err) {
    next(err);
  }
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The one error boundary. CostError carries an operator-actionable .code →
// 422 (window-bound codes are 400 per contract v2); anything else is logged
// (message only) and returns 500.
const COST_ERROR_STATUS = { window_too_small: 400, window_too_large: 400 };
const guard = (name, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof CostError) {
      return res.status(COST_ERROR_STATUS[err.code] || 422)
        .json({ success: false, error: { code: err.code } });
    }
    console.error(`[funnelCosts] ${name} failed:`, err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
};

const userId = (req) => String((req.user && (req.user.email || req.user.id)) || '');

// ── catalog ─────────────────────────────────────────────────────────────────
// GET /variants — the grid. Filters: coverage/context/funnel_id/q, paging.
// Each row carries resolved-for-today COGS/ship.
router.get('/variants', guard('variants', async (req, res) => {
  const out = await listVariants({
    coverage: req.query.coverage ? String(req.query.coverage) : null,
    context: req.query.context ? String(req.query.context) : null,
    funnelId: req.query.funnel_id ? String(req.query.funnel_id) : null,
    q: req.query.q ? String(req.query.q) : null,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data: out });
}));

// GET /by-funnel — funnel → variants, credited per-funnel (never the
// cross-funnel total).
router.get('/by-funnel', guard('by-funnel', async (req, res) => {
  res.json({ success: true, data: await listByFunnel() });
}));

// GET /coverage-summary — counts + revenue_at_risk_30d.
router.get('/coverage-summary', guard('coverage-summary', async (req, res) => {
  res.json({ success: true, data: await coverageSummary() });
}));

// POST /detect?days — rebuild the SOLD variant catalog. Idempotent; never
// runs implicitly on a GET. Window bounds per contract v2: days < 30 makes
// revenue_30d a partial-window lie → 400 window_too_small; > 400 → 400
// window_too_large.
router.post('/detect', guard('detect', async (req, res) => {
  const days = req.query.days ? parseInt(String(req.query.days), 10) : 90;
  if (Number.isNaN(days) || days < 30) {
    return res.status(400).json({ success: false, error: { code: 'window_too_small' } });
  }
  if (days > 400) {
    return res.status(400).json({ success: false, error: { code: 'window_too_large' } });
  }
  res.json({ success: true, data: await runDetectSweep({ days }) });
}));

// PATCH /variants/:id — operator fields ONLY (pays_shipping, ignored,
// kind_override). The sweep owns everything else.
router.patch('/variants/:id', guard('variant-patch', async (req, res) => {
  const body = req.body || {};
  const allowed = ['pays_shipping', 'ignored', 'kind_override'];
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) {
      return res.status(422).json({ success: false, error: { code: 'unknown_field' } });
    }
  }
  const row = await patchVariant(String(req.params.id), body);
  res.json({ success: true, data: { variant: row } });
}));

// ── rates (append-only, effective-dated — THE ONE WRITE DOOR) ───────────────
router.get('/rates', guard('rates-list', async (req, res) => {
  const rows = await listRates({
    variantId: req.query.variant_id ? String(req.query.variant_id) : null,
    costItemId: req.query.cost_item_id ? String(req.query.cost_item_id) : null,
    limit: req.query.limit,
  });
  res.json({ success: true, data: { items: rows, count: rows.length } });
}));

// POST /rates — append a rate. An "edit" is a new row; a revert is a new
// row. unit_cogs/ship values: null = unknown (stays null — NEVER coerced to
// 0), 0 = known free. appendRate validates and throws CostError on garbage.
router.post('/rates', guard('rate-create', async (req, res) => {
  const b = req.body || {};
  const scope = b.scope === undefined ? 'variant' : String(b.scope);
  const ref = scope === 'variant' ? b.variant_id : b.cost_item_id;
  if (!ref) {
    return res.status(422).json({
      success: false,
      error: { code: scope === 'variant' ? 'variant_id_required' : 'cost_item_id_required' },
    });
  }
  const row = await appendRate({
    scope,
    refId: String(ref),
    unitCogs: b.unit_cogs === undefined ? null : b.unit_cogs,
    ship: b.ship === undefined ? null : b.ship,
    effectiveFrom: b.effective_from ? String(b.effective_from) : null,
    onlyFromToday: Boolean(b.only_from_today),
    currency: b.currency ? String(b.currency) : 'USD',
    source: b.source ? String(b.source) : 'manual',
    batchId: b.batch_id ? String(b.batch_id) : '',
    note: b.note ? String(b.note) : '',
    createdBy: userId(req),
  });
  // Contract v2 m13: the rate payload is EXACTLY these keys — the client
  // reads rate.effective_from for its confirmation line.
  res.json({
    success: true,
    data: {
      rate: {
        id: row.id,
        scope: row.scope,
        variant_id: row.variant_id,
        cost_item_id: row.cost_item_id,
        effective_from: row.effective_from,
        unit_cogs: row.unit_cogs,
        ship: row.ship,
        currency: row.currency,
        source: row.source,
        note: row.note,
        created_at: row.created_at,
      },
    },
  });
}));

// GET /rates/history/:variantId — newest-first audit trail, incl. the
// variant's cost group's rows.
router.get('/rates/history/:variantId', guard('rate-history', async (req, res) => {
  const rows = await rateHistory(String(req.params.variantId), req.query.limit);
  res.json({ success: true, data: { variant_id: String(req.params.variantId), items: rows, count: rows.length } });
}));

// ── fee settings ────────────────────────────────────────────────────────────
router.get('/fee-settings', guard('fee-get', async (req, res) => {
  res.json({ success: true, data: await getFeeSettings() });
}));

// PATCH /fee-settings — default pct/fixed + per-gateway overrides. A gateway
// mapped to null clears its override back to the default; a gateway omitted
// is left alone; a blank pct/fixed inside an override inherits the default.
router.patch('/fee-settings', guard('fee-patch', async (req, res) => {
  res.json({ success: true, data: await updateFeeSettings(req.body || {}, userId(req)) });
}));

// ── P&L (computed on-read) ──────────────────────────────────────────────────
router.get('/pnl/overview', guard('pnl-overview', async (req, res) => {
  res.json({ success: true, data: await pnlOverview(String(req.query.start || ''), String(req.query.end || '')) });
}));

router.get('/pnl/funnel/:fid', guard('pnl-funnel', async (req, res) => {
  res.json({
    success: true,
    data: await pnlFunnel(String(req.params.fid), String(req.query.start || ''), String(req.query.end || '')),
  });
}));

// ── spend feed ──────────────────────────────────────────────────────────────
// Contract v2 M2: {sources:[{source, configured, last_sync, last_attempt,
// last_ok, stale, error, fail_streak}]} — the service keeps the rich shape
// for internal callers; this is the projection the client renders.
router.get('/spend/status', guard('spend-status', async (req, res) => {
  const st = await spendStatus();
  res.json({
    success: true,
    data: {
      sources: [{
        source: 'meta',
        configured: st.configured,
        last_sync: st.last_sync,
        last_attempt: st.last_attempt,
        last_ok: st.last_ok,
        stale: st.stale,
        error: st.error,
        fail_streak: st.fail_streak,
      }],
    },
  });
}));

// POST /spend/sync?days — runs in the BACKGROUND (Meta insights across many
// accounts can take a while for long ranges). Failures are recorded in
// lb_spend_sync_state by the sync itself, never lost.
router.post('/spend/sync', guard('spend-sync', async (req, res) => {
  const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
  if (Number.isNaN(days) || days < 1 || days > SPEND_CATCHUP_MAX_DAYS) {
    return res.status(422).json({ success: false, error: { code: 'bad_days' } });
  }
  syncMetaCampaignSpend(days).then((out) => {
    console.log(`[funnelCosts] manual spend sync → ok=${out.ok} rows=${out.rows ?? 0}`);
  }).catch((err) => {
    console.error('[funnelCosts] manual spend sync failed:', err && err.message ? err.message : err);
  });
  res.json({ success: true, data: { started: true, days } });
}));

// POST /campaign-map {campaign_id, funnel_id?, action} — operator pins.
// action 'pin' requires funnel_id; action 'unpin' deletes the pin (the
// derived binding takes back over).
router.post('/campaign-map', guard('campaign-map', async (req, res) => {
  const b = req.body || {};
  const cid = String(b.campaign_id || '').trim();
  if (!cid || cid.length > 64) {
    return res.status(422).json({ success: false, error: { code: 'campaign_id_required' } });
  }
  const action = String(b.action || 'pin');
  if (action === 'unpin' || action === 'remove') {
    await pgQuery(`DELETE FROM lb_campaign_map WHERE campaign_id = $1`, [cid]);
    return res.json({ success: true, data: { campaign_id: cid, pinned: false } });
  }
  if (action !== 'pin' && action !== 'add') {
    return res.status(422).json({ success: false, error: { code: 'bad_action' } });
  }
  const fid = String(b.funnel_id || '').trim();
  if (!fid || fid.length > 64) {
    return res.status(422).json({ success: false, error: { code: 'funnel_id_required' } });
  }
  await pgQuery(
    `INSERT INTO lb_campaign_map (campaign_id, funnel_id, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (campaign_id) DO UPDATE SET
       funnel_id = EXCLUDED.funnel_id, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [cid, fid, userId(req)]
  );
  res.json({ success: true, data: { campaign_id: cid, funnel_id: fid, pinned: true } });
}));

// POST /pnl/funnel/:fid/spend-manual {day, spend, note?} — operator-typed
// spend for a funnel-day (contract v2 B3: the field is `spend`, matching
// the column). Keyed (source='manual', ref_id=fid, day): upsert, never
// duplicate.
router.post('/pnl/funnel/:fid/spend-manual', guard('spend-manual', async (req, res) => {
  const fid = String(req.params.fid || '').trim().slice(0, 64);
  const b = req.body || {};
  const day = String(b.day || '');
  if (!DAY_RE.test(day)) {
    return res.status(422).json({ success: false, error: { code: 'bad_day' } });
  }
  const amount = Number(b.spend);
  if (b.spend === null || b.spend === undefined || b.spend === '' || Number.isNaN(amount) || !Number.isFinite(amount) || amount < 0) {
    return res.status(422).json({ success: false, error: { code: 'bad_spend' } });
  }
  await pgQuery(
    `INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend, note, updated_by, synced_at)
     VALUES ('manual', $1, $2, $3, $4, $5, NOW())
     ON CONFLICT (source, ref_id, day) DO UPDATE SET
       spend = EXCLUDED.spend, note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by, synced_at = NOW()`,
    [fid, day, round2(amount), String(b.note || '').slice(0, 200), userId(req)]
  );
  res.json({ success: true, data: { fid, day, spend: round2(amount) } });
}));

// DELETE /pnl/funnel/:fid/spend-manual/:day
router.delete('/pnl/funnel/:fid/spend-manual/:day', guard('spend-manual-delete', async (req, res) => {
  const fid = String(req.params.fid || '').trim().slice(0, 64);
  const day = String(req.params.day || '');
  if (!DAY_RE.test(day)) {
    return res.status(422).json({ success: false, error: { code: 'bad_day' } });
  }
  const rows = await pgQuery(
    `DELETE FROM lb_ad_spend_daily WHERE source = 'manual' AND ref_id = $1 AND day = $2 RETURNING day`,
    [fid, day]
  );
  res.json({ success: true, data: { fid, day, deleted: rows.length > 0 } });
}));

export default router;
