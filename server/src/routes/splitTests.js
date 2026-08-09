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
import pgDb, { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureSplitTables } from '../services/splitTestSchema.js';
import { readResults } from '../services/splitCredits.js';
import {
  listArmEligiblePages, normHandle, normDomain, handleCollidesWithPageSlug,
} from '../services/splitPages.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const newId = (prefix) => `${prefix}_${randomBytes(9).toString('hex')}`;
export const SCOPES = new Set(['page', 'offer']);
// Arm keys are bounded to a safe charset so a hostile key can never smuggle
// control chars into a ledger id or a URL.
export const ARM_KEY_RE = /^[a-z0-9_-]{1,32}$/i;
const s = (v, max = 200) => String(v ?? '').slice(0, max);
const UNIQUE_VIOLATION = '23505';

// The columns the operator surfaces read. Spelled out rather than SELECT * so
// a future column can never leak into an API response by accident.
const TEST_COLS = `id, funnel_id, name, scope, target_page_id, target_offer_id,
                   handle, domain, enabled, archived, created_at, updated_at`;
const ARM_COLS = `id, arm_key, weight, page_id, offer_id, is_control, is_entry,
                  sort_order, archived, created_at`;
// Total order: operator order first, arm_key as the tie-break so the list can
// never flicker between two equal sort_orders.
const ARM_ORDER = `ORDER BY archived, sort_order, arm_key`;

// A handle collision is the database refusing a duplicate route, not a bug.
function isHandleCollision(err) {
  return err?.code === UNIQUE_VIOLATION && String(err?.constraint_name || err?.constraint || '').includes('handle');
}

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
  // sort_order is cosmetic (left-to-right arm order in the UI) — a bad value
  // degrades to 0 and the arm_key tie-break still gives a total order.
  let sort_order = Number(raw?.sort_order);
  if (!Number.isInteger(sort_order) || sort_order < 0 || sort_order > 1e6) sort_order = 0;
  return {
    arm: {
      arm_key,
      weight,
      page_id: raw?.page_id ? s(raw.page_id, 120) : null,
      offer_id: raw?.offer_id ? s(raw.offer_id, 120) : null,
      is_control: Boolean(raw?.is_control),
      is_entry: Boolean(raw?.is_entry),
      sort_order,
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
    // Same rule for the ENTRY arm, and it is a SEPARATE rule: >1 entry is
    // ambiguous (two arms cannot both answer the bare route); none flagged
    // defaults to the CONTROL arm, which is the least surprising default and
    // matches what an operator who has not thought about it expects.
    if (normed.filter((a) => a.is_entry).length > 1) {
      return res.status(422).json({ success: false, error: { code: 'multiple_entry_arms' } });
    }
    if (normed.length && !normed.some((a) => a.is_entry)) {
      (normed.find((a) => a.is_control) || normed[0]).is_entry = true;
    }
    // Arms created in one call get their array order as their display order
    // unless the caller specified one.
    normed.forEach((a, i) => { if (!a.sort_order) a.sort_order = i; });

    const h = normHandle(b.handle);
    if (h.error) return res.status(422).json({ success: false, error: { code: h.error } });
    const d = normDomain(b.domain);
    if (d.error) return res.status(422).json({ success: false, error: { code: d.error } });
    const funnelId = b.funnel_id ? s(b.funnel_id, 120) : null;
    // A handle that shadows a live page slug on the same funnel is refused —
    // both would serve at the same path and the winner would be decided by
    // route order, not by the operator.
    if (h.handle && funnelId && (await handleCollidesWithPageSlug({ funnelId, handle: h.handle }))) {
      return res.status(409).json({ success: false, error: { code: 'handle_conflicts_page_slug' } });
    }

    const testId = newId('lbsg');
    await pgQuery(
      `INSERT INTO lb_split_tests (id, funnel_id, name, scope, target_page_id, target_offer_id, handle, domain, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, TRUE))`,
      [testId, funnelId, s(b.name, 200), scope,
        b.target_page_id ? s(b.target_page_id, 120) : null,
        b.target_offer_id ? s(b.target_offer_id, 120) : null,
        h.handle, d.domain,
        b.enabled === undefined ? null : Boolean(b.enabled)]
    );
    for (const a of normed) {
      await pgQuery(
        `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, offer_id, is_control, is_entry, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [newId('lbsa'), testId, a.arm_key, a.weight, a.page_id, a.offer_id, a.is_control, a.is_entry, a.sort_order]
      );
    }
    return res.status(201).json({ success: true, data: { id: testId } });
  } catch (err) {
    if (isHandleCollision(err)) {
      return res.status(409).json({ success: false, error: { code: 'handle_exists' } });
    }
    console.error('[splitTests] create failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// GET /eligible-pages?funnel_id=&test_id=  — which of a funnel's pages may be
// an arm, and WHY not for the rest. Declared BEFORE '/:id' so the literal path
// is not swallowed by the id param.
router.get('/eligible-pages', async (req, res) => {
  try {
    const funnelId = s(req.query.funnel_id, 120);
    if (!funnelId) return res.status(422).json({ success: false, error: { code: 'funnel_id_required' } });
    const data = await listArmEligiblePages({
      funnelId,
      testId: req.query.test_id ? s(req.query.test_id, 120) : null,
    });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[splitTests] eligible-pages failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// GET /  — list tests (non-archived by default).
router.get('/', async (req, res) => {
  try {
    await ensureSplitTables();
    const includeArchived = String(req.query.archived || '') === '1';
    // funnel_id filter: the canvas asks "does THIS funnel have a split?" on
    // every load, and an unfiltered 500-row list would answer it by accident.
    const funnelId = req.query.funnel_id ? s(req.query.funnel_id, 120) : null;
    const rows = await pgQuery(
      `SELECT ${TEST_COLS}
       FROM lb_split_tests
       WHERE ($1 OR NOT archived)
         AND ($2::text IS NULL OR funnel_id = $2)
       ORDER BY created_at DESC LIMIT 500`,
      [includeArchived, funnelId]
    );
    // with_arms=1 — one extra round trip instead of N+1 from the client.
    if (String(req.query.with_arms || '') === '1' && rows.length) {
      const arms = await pgQuery(
        `SELECT test_id, ${ARM_COLS} FROM lb_split_arms
         WHERE test_id = ANY($1) ${ARM_ORDER}`,
        [rows.map((r) => r.id)]
      );
      const byTest = new Map(rows.map((r) => [r.id, []]));
      for (const a of arms) byTest.get(a.test_id)?.push(a);
      return res.json({ success: true, data: rows.map((r) => ({ ...r, arms: byTest.get(r.id) || [] })) });
    }
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
    const tests = await pgQuery(`SELECT ${TEST_COLS} FROM lb_split_tests WHERE id = $1`, [s(req.params.id, 120)]);
    if (!tests.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    const arms = await pgQuery(
      `SELECT ${ARM_COLS} FROM lb_split_arms WHERE test_id = $1 ${ARM_ORDER}`,
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
    if (b.handle !== undefined) {
      const h = normHandle(b.handle);
      if (h.error) return res.status(422).json({ success: false, error: { code: h.error } });
      if (h.handle) {
        const owner = await pgQuery(`SELECT funnel_id FROM lb_split_tests WHERE id = $1`, [s(req.params.id, 120)]);
        if (!owner.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
        if (owner[0].funnel_id
          && (await handleCollidesWithPageSlug({ funnelId: owner[0].funnel_id, handle: h.handle }))) {
          return res.status(409).json({ success: false, error: { code: 'handle_conflicts_page_slug' } });
        }
      }
      sets.push(`handle = $${i++}`); vals.push(h.handle);
    }
    if (b.domain !== undefined) {
      const d = normDomain(b.domain);
      if (d.error) return res.status(422).json({ success: false, error: { code: d.error } });
      sets.push(`domain = $${i++}`); vals.push(d.domain);
    }
    if (!sets.length) return res.status(422).json({ success: false, error: { code: 'nothing_to_update' } });
    sets.push(`updated_at = NOW()`);
    vals.push(s(req.params.id, 120));
    const rows = await pgQuery(
      `UPDATE lb_split_tests SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${TEST_COLS}`,
      vals
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    // Two operators renaming two tests onto the same handle: the database
    // refuses the second. A 409 is the honest answer — the UI re-reads.
    if (isHandleCollision(err)) {
      return res.status(409).json({ success: false, error: { code: 'handle_exists' } });
    }
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
    // An arm ADDED to a running test never steals the entry role implicitly —
    // that would silently repoint the live route mid-experiment. Marking it
    // entry is an explicit second call (POST /:id/arms/:armId/entry).
    if (arm.is_entry) {
      return res.status(422).json({ success: false, error: { code: 'entry_must_be_set_explicitly' } });
    }
    // Append to the end of the operator's order unless one was given.
    let sortOrder = arm.sort_order;
    if (!sortOrder) {
      const [{ next } = {}] = await pgQuery(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
        [testId]
      );
      sortOrder = Number(next) || 0;
    }
    const armId = newId('lbsa');
    await pgQuery(
      `INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, offer_id, is_control, is_entry, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)`,
      [armId, testId, arm.arm_key, arm.weight, arm.page_id, arm.offer_id, arm.is_control, sortOrder]
    );
    return res.status(201).json({ success: true, data: { id: armId } });
  } catch (err) {
    console.error('[splitTests] add arm failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// PATCH /:id/arms/:armId  — weight / control / archived / page / order.
//
// THE BASELINE IS MONEY-MEANING, SO IT IS GUARDED IN BOTH DIRECTIONS.
// analyticsStats.buildVerdict resolves the control as
//   rows.find(r => r.is_control) || ranked[ranked.length - 1]
// — i.e. with ZERO live controls the WORST arm by revenue per visitor silently
// becomes the baseline, which flips every vs-control number and can flip the
// verdict itself. is_entry was made a separate flag precisely so a serving
// change could not move the baseline; leaving is_control able to reach zero
// would have re-opened the same hole from the other side. So:
//   • a patch that would leave zero live controls is REFUSED (control_required);
//   • archiving the live control is REFUSED (move the control first);
//   • archiving the LAST live arm is REFUSED (last_live_arm) — it would leave
//     the split route with nothing behind it;
//   • moving the control between arms goes through POST .../control, which does
//     it atomically (the two guards above make a two-step PATCH move impossible
//     on purpose — there is no window in which the baseline is undefined).
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
    if (b.page_id !== undefined) { sets.push(`page_id = $${i++}`); vals.push(b.page_id ? s(b.page_id, 120) : null); }
    if (b.sort_order !== undefined) {
      let so = Number(b.sort_order);
      if (!Number.isInteger(so) || so < 0 || so > 1e6) so = 0;
      sets.push(`sort_order = $${i++}`); vals.push(so);
    }
    // is_entry is NOT settable here: moving it is a two-row swap that must be
    // atomic. POST /:id/arms/:armId/entry does that in one transaction.
    if (b.is_entry !== undefined) {
      return res.status(422).json({ success: false, error: { code: 'use_entry_endpoint' } });
    }
    if (!sets.length) return res.status(422).json({ success: false, error: { code: 'nothing_to_update' } });

    const testId = s(req.params.id, 120);
    const armId = s(req.params.armId, 120);
    // Flipping an arm TO control while another live arm already holds it is
    // rejected (mirror of the create-path rule) — use POST .../control instead.
    if (b.is_control === true) {
      const ctrl = await pgQuery(
        `SELECT 1 FROM lb_split_arms WHERE test_id = $1 AND is_control AND NOT archived AND id <> $2`,
        [testId, armId]
      );
      if (ctrl.length) return res.status(422).json({ success: false, error: { code: 'multiple_control_arms' } });
    }
    // ── The baseline guards ────────────────────────────────────────────────
    const wouldUnsetControl = b.is_control === false;
    const wouldArchive = b.archived === true;
    if (wouldUnsetControl || wouldArchive) {
      const live = await pgQuery(
        `SELECT id, is_control FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
        [testId]
      );
      const target = live.find((a) => a.id === armId);
      // Only guard when the row is currently a LIVE arm — patching an already
      // archived arm cannot change how many live controls exist.
      if (target) {
        if (wouldArchive && live.length <= 1) {
          return res.status(422).json({ success: false, error: { code: 'last_live_arm' } });
        }
        if (target.is_control) {
          if (wouldArchive) {
            return res.status(422).json({ success: false, error: { code: 'control_required' } });
          }
          if (wouldUnsetControl && !live.some((a) => a.is_control && a.id !== armId)) {
            return res.status(422).json({ success: false, error: { code: 'control_required' } });
          }
        }
      }
    }
    vals.push(armId, testId);
    const rows = await pgQuery(
      `UPDATE lb_split_arms SET ${sets.join(', ')} WHERE id = $${i++} AND test_id = $${i} RETURNING id, is_entry, archived`,
      vals
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'not_found' } });
    // ARCHIVING THE ENTRY ARM would leave /<handle> pointing at a retired page
    // — a live route with nothing behind it. Hand the role to the control (or,
    // failing that, the first live arm) instead of refusing: the operator's
    // intent (retire this arm) is unambiguous, and a route that answers is
    // strictly better than one that does not. The partial unique index makes
    // the promotion safe — it can never produce a second entry.
    if (rows[0].archived && rows[0].is_entry) {
      await pgQuery(`UPDATE lb_split_arms SET is_entry = FALSE WHERE id = $1`, [rows[0].id]);
      await pgQuery(
        `UPDATE lb_split_arms SET is_entry = TRUE WHERE id = (
           SELECT id FROM lb_split_arms
           WHERE test_id = $1 AND NOT archived
           ORDER BY is_control DESC, sort_order, arm_key LIMIT 1
         )`,
        [s(req.params.id, 120)]
      );
    }
    return res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[splitTests] update arm failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// POST /:id/arms/:armId/entry  — mark THIS arm as the one served at the bare
// /<handle> route. Atomic two-row swap: clear the old entry and set the new one
// inside ONE transaction, so a concurrent request can never observe (or leave)
// two entry arms — and never zero, which would leave the route unanswered.
//
// This writes NOTHING to the ledger. Changing the entry arm changes which page
// a NEW visitor sees first; every exposure and credit already recorded stays
// exactly where it is, keyed to the arm that was actually served.
router.post('/:id/arms/:armId/entry', async (req, res) => {
  try {
    await ensureSplitTables();
    const testId = s(req.params.id, 120);
    const armId = s(req.params.armId, 120);
    const result = await pgDb.begin(async (tx) => {
      const q = (text, params = []) => tx.unsafe(text, params);
      // LOCK THE PARENT TEST ROW, NOT THE ARM ROWS.
      // `SELECT ... FROM lb_split_arms WHERE test_id = $1 FOR UPDATE` locks N
      // tuples in whatever order the plan returns them, so two concurrent moves
      // on the same test can grab them in opposite orders and deadlock —
      // measured: 12 concurrent moves produced 6 × HTTP 500 (Postgres 40P01).
      // A single parent row has no ordering to disagree about, so the moves
      // serialize cleanly. The child rows still cannot be modified
      // concurrently, because every writer takes this same lock first.
      const test = await q(`SELECT id FROM lb_split_tests WHERE id = $1 FOR UPDATE`, [testId]);
      if (!test.length) return { error: 'not_found' };
      const arms = await q(
        `SELECT id, is_entry, archived FROM lb_split_arms WHERE test_id = $1`,
        [testId]
      );
      const target = arms.find((a) => a.id === armId);
      if (!target) return { error: 'not_found' };
      // An archived arm takes no traffic; making it the entry would point the
      // live route at a page the operator has already retired.
      if (target.archived) return { error: 'arm_archived' };
      await q(`UPDATE lb_split_arms SET is_entry = FALSE WHERE test_id = $1 AND is_entry AND id <> $2`, [testId, armId]);
      await q(`UPDATE lb_split_arms SET is_entry = TRUE WHERE id = $1`, [armId]);
      await q(`UPDATE lb_split_tests SET updated_at = NOW() WHERE id = $1`, [testId]);
      return { id: armId };
    });
    if (result.error === 'not_found') return res.status(404).json({ success: false, error: { code: 'not_found' } });
    if (result.error) return res.status(422).json({ success: false, error: { code: result.error } });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[splitTests] set entry failed:', err);
    return res.status(500).json({ success: false, error: { code: 'server_error' } });
  }
});

// POST /:id/arms/:armId/control  — move the STATISTICAL BASELINE to this arm.
//
// The only supported way to change the control, and it is atomic for the same
// reason the entry move is: the baseline must never be observable as zero arms
// (buildVerdict would fall back to the WORST arm by revenue per visitor) nor as
// two arms (ambiguous). One transaction, parent-row lock, clear-then-set.
//
// ⚠️ THIS CHANGES WHAT EVERY PUBLISHED vs-control NUMBER MEANS. It is a
// deliberate, explicit operator act with its own endpoint precisely so it can
// never happen as a side effect of archiving an arm or of moving the entry.
// Writes NOTHING to the ledger.
router.post('/:id/arms/:armId/control', async (req, res) => {
  try {
    await ensureSplitTables();
    const testId = s(req.params.id, 120);
    const armId = s(req.params.armId, 120);
    const result = await pgDb.begin(async (tx) => {
      const q = (text, params = []) => tx.unsafe(text, params);
      const test = await q(`SELECT id FROM lb_split_tests WHERE id = $1 FOR UPDATE`, [testId]);
      if (!test.length) return { error: 'not_found' };
      const arms = await q(
        `SELECT id, is_control, archived FROM lb_split_arms WHERE test_id = $1`,
        [testId]
      );
      const target = arms.find((a) => a.id === armId);
      if (!target) return { error: 'not_found' };
      // An archived arm takes no NEW traffic, so its sample can only shrink
      // relative to the others — a frozen baseline every live arm is measured
      // against. Refused for the same reason an archived arm cannot be entry.
      if (target.archived) return { error: 'arm_archived' };
      await q(`UPDATE lb_split_arms SET is_control = FALSE WHERE test_id = $1 AND is_control AND id <> $2`, [testId, armId]);
      await q(`UPDATE lb_split_arms SET is_control = TRUE WHERE id = $1`, [armId]);
      await q(`UPDATE lb_split_tests SET updated_at = NOW() WHERE id = $1`, [testId]);
      return { id: armId };
    });
    if (result.error === 'not_found') return res.status(404).json({ success: false, error: { code: 'not_found' } });
    if (result.error) return res.status(422).json({ success: false, error: { code: result.error } });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[splitTests] set control failed:', err);
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
