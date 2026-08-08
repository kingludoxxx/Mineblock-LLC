// Split-testing subsystem — authed admin CRUD (SELF-CONTAINED, NEW FILE).
//
// Define tests + arms and read results. Follows the repo's route+permission
// pattern (funnels.js): router.use(authenticate, requirePermission(...)).
//
// PERMISSION — DECISION MADE: this router reuses the existing
// requirePermission('funnels', 'access') rather than minting a new 'split'
// permission via an additive migration. Rationale: split testing is a
// sub-feature of the funnel builder, the SuperAdmin wildcard already covers it,
// and adding a permission means editing the shared RBAC seed/migration — which
// the isolation constraint asks me to avoid. To switch to a dedicated 'split'
// permission later, change the requirePermission line below and add a
// migration granting 'split':['access'] to the relevant roles. See INTEGRATION
// HOOKS in the report for the exact mount line (this file does NOT edit
// routes/index.js).
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureSplitTables } from '../services/splitTestSchema.js';
import { readResults } from '../services/splitCredits.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const newId = (prefix) => `${prefix}_${randomBytes(9).toString('hex')}`;
export const SCOPES = new Set(['page', 'offer']);
// Arm keys are bounded to a safe charset so a hostile key can never smuggle
// control chars into a ledger id or a URL.
export const ARM_KEY_RE = /^[a-z0-9_-]{1,32}$/i;
const s = (v, max = 200) => String(v ?? '').slice(0, max);

// Validate + normalise an incoming arm definition. Returns { arm } or { error }.
// Exported so its input-hardening can be exercised by execution without booting
// the full auth stack (all persistence is via parameterized pgQuery anyway).
export function normArm(raw) {
  // Test the RAW value (not a pre-sliced copy): the regex already bounds length
  // to 1-32, so an over-length key is REJECTED rather than silently truncated —
  // truncation could collide two distinct keys onto one arm.
  const arm_key = String(raw?.arm_key ?? '').trim();
  if (!ARM_KEY_RE.test(arm_key)) return { error: 'invalid_arm_key' };
  // Bad weight degrades to 0 (unified with the PATCH path — one rule): a
  // 0-weight arm takes no NEW traffic, and if ALL arms are 0 the resolver
  // degrades to equal weights. Never rejects.
  let weight = Number(raw?.weight);
  if (!Number.isFinite(weight) || weight < 0) weight = 0;
  weight = Math.round(weight * 10000) / 10000;
  return {
    arm: {
      arm_key,
      weight,
      page_id: raw?.page_id ? s(raw.page_id, 120) : null,
      offer_id: raw?.offer_id ? s(raw.offer_id, 120) : null,
      is_control: Boolean(raw?.is_control),
    },
  };
}

// POST /  — create a test, optionally with arms in one call.
router.post('/', async (req, res) => {
  try {
    await ensureSplitTables();
    const b = req.body || {};
    const scope = SCOPES.has(b.scope) ? b.scope : 'page';
    const arms = Array.isArray(b.arms) ? b.arms : [];
    const normed = [];
    const seen = new Set();
    for (const raw of arms) {
      const { arm, error } = normArm(raw);
      if (error) return res.status(422).json({ success: false, error: { code: error } });
      if (seen.has(arm.arm_key)) return res.status(422).json({ success: false, error: { code: 'duplicate_arm_key' } });
      seen.add(arm.arm_key);
      normed.push(arm);
    }
    if (arms.length && normed.length < 2) {
      return res.status(422).json({ success: false, error: { code: 'need_at_least_two_arms' } });
    }
    // EXACTLY one control: >1 flagged is rejected (an ambiguous fail-open
    // target is not a degradable input); none flagged defaults to the first.
    if (normed.filter((a) => a.is_control).length > 1) {
      return res.status(422).json({ success: false, error: { code: 'multiple_control_arms' } });
    }
    if (normed.length && !normed.some((a) => a.is_control)) normed[0].is_control = true;

    const testId = newId('lbsg');
    await pgQuery(
      `INSERT INTO lb_split_tests (id, funnel_id, name, scope, target_page_id, target_offer_id, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))`,
      [testId, b.funnel_id ? s(b.funnel_id, 120) : null, s(b.name, 200), scope,
        b.target_page_id ? s(b.target_page_id, 120) : null,
        b.target_offer_id ? s(b.target_offer_id, 120) : null,
        b.enabled === undefined ? null : Boolean(b.enabled)]
    );
    for (const a of normed) {
      await pgQuery(
        `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, offer_id, is_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('lbsa'), testId, a.arm_key, a.weight, a.page_id, a.offer_id, a.is_control]
      );
    }
    return res.status(201).json({ success: true, data: { id: testId } });
  } catch (err) {
    console.error('[splitTests] create failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// GET /  — list tests (non-archived by default).
router.get('/', async (req, res) => {
  try {
    await ensureSplitTables();
    const includeArchived = String(req.query.archived || '') === '1';
    const rows = await pgQuery(
      `SELECT id, funnel_id, name, scope, target_page_id, target_offer_id,
              enabled, archived, created_at, updated_at
       FROM lb_split_tests
       WHERE ($1 OR NOT archived)
       ORDER BY created_at DESC LIMIT 500`,
      [includeArchived]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[splitTests] list failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// GET /:id  — one test with its arms.
router.get('/:id', async (req, res) => {
  try {
    await ensureSplitTables();
    const tests = await pgQuery(`SELECT * FROM lb_split_tests WHERE id = $1`, [s(req.params.id, 120)]);
    if (!tests.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    const arms = await pgQuery(
      `SELECT id, arm_key, weight, page_id, offer_id, is_control, archived
       FROM lb_split_arms WHERE test_id = $1 ORDER BY arm_key`,
      [tests[0].id]
    );
    return res.json({ success: true, data: { ...tests[0], arms } });
  } catch (err) {
    console.error('[splitTests] get failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// PATCH /:id  — mutate test metadata (name / enabled / archived).
router.patch('/:id', async (req, res) => {
  try {
    await ensureSplitTables();
    const b = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(s(b.name, 200)); }
    if (b.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(Boolean(b.enabled)); }
    if (b.archived !== undefined) { sets.push(`archived = $${i++}`); vals.push(Boolean(b.archived)); }
    if (!sets.length) return res.status(422).json({ success: false, error: { code: 'nothing_to_update' } });
    sets.push(`updated_at = NOW()`);
    vals.push(s(req.params.id, 120));
    const rows = await pgQuery(
      `UPDATE lb_split_tests SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      vals
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    return res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[splitTests] update failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// DELETE /:id  — archive (never hard-delete; the ledger must survive).
router.delete('/:id', async (req, res) => {
  try {
    await ensureSplitTables();
    const rows = await pgQuery(
      `UPDATE lb_split_tests SET archived = TRUE, enabled = FALSE, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [s(req.params.id, 120)]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    return res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[splitTests] delete failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// POST /:id/arms  — add an arm to an existing test.
router.post('/:id/arms', async (req, res) => {
  try {
    await ensureSplitTables();
    const testId = s(req.params.id, 120);
    const tests = await pgQuery(`SELECT id FROM lb_split_tests WHERE id = $1`, [testId]);
    if (!tests.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    const { arm, error } = normArm(req.body || {});
    if (error) return res.status(422).json({ success: false, error: { code: error } });
    const dup = await pgQuery(
      `SELECT 1 FROM lb_split_arms WHERE test_id = $1 AND arm_key = $2 AND NOT archived`,
      [testId, arm.arm_key]
    );
    if (dup.length) return res.status(409).json({ success: false, error: { code: 'arm_key_exists' } });
    if (arm.is_control) {
      const ctrl = await pgQuery(
        `SELECT 1 FROM lb_split_arms WHERE test_id = $1 AND is_control AND NOT archived`,
        [testId]
      );
      if (ctrl.length) return res.status(422).json({ success: false, error: { code: 'multiple_control_arms' } });
    }
    const armId = newId('lbsa');
    await pgQuery(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, offer_id, is_control)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [armId, testId, arm.arm_key, arm.weight, arm.page_id, arm.offer_id, arm.is_control]
    );
    return res.status(201).json({ success: true, data: { id: armId } });
  } catch (err) {
    console.error('[splitTests] add arm failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// PATCH /:id/arms/:armId  — weight / control / archived.
router.patch('/:id/arms/:armId', async (req, res) => {
  try {
    await ensureSplitTables();
    const b = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (b.weight !== undefined) {
      let w = Number(b.weight);
      if (!Number.isFinite(w) || w < 0) w = 0;
      sets.push(`weight = $${i++}`); vals.push(Math.round(w * 10000) / 10000);
    }
    if (b.is_control !== undefined) { sets.push(`is_control = $${i++}`); vals.push(Boolean(b.is_control)); }
    if (b.archived !== undefined) { sets.push(`archived = $${i++}`); vals.push(Boolean(b.archived)); }
    if (!sets.length) return res.status(422).json({ success: false, error: { code: 'nothing_to_update' } });
    // Flipping an arm TO control while another live arm already holds it is
    // rejected (mirror of the create-path rule) — unset the old control first.
    if (b.is_control === true) {
      const ctrl = await pgQuery(
        `SELECT 1 FROM lb_split_arms WHERE test_id = $1 AND is_control AND NOT archived AND id <> $2`,
        [s(req.params.id, 120), s(req.params.armId, 120)]
      );
      if (ctrl.length) return res.status(422).json({ success: false, error: { code: 'multiple_control_arms' } });
    }
    vals.push(s(req.params.armId, 120), s(req.params.id, 120));
    const rows = await pgQuery(
      `UPDATE lb_split_arms SET ${sets.join(', ')} WHERE id = $${i++} AND test_id = $${i} RETURNING id`,
      vals
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    return res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[splitTests] update arm failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// GET /:id/results  — derived exposures vs credited conversions per arm,
// netted against refunds.
router.get('/:id/results', async (req, res) => {
  try {
    const tests = await pgQuery(`SELECT id FROM lb_split_tests WHERE id = $1`, [s(req.params.id, 120)]);
    if (!tests.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    const results = await readResults({ testId: tests[0].id });
    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('[splitTests] results failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

export default router;
