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
  POST_PURCHASE_TYPES,
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
    if (b.enabled !== undefined) {
      sets.push(`enabled = $${i++}`); vals.push(Boolean(b.enabled));
      // Re-enabling a promoted test RESTARTS the experiment: traffic branches
      // across the arms again, so "this arm won" stops describing what is
      // happening. The stamp is retracted with it (review MED #6) — otherwise
      // the row keeps asserting a winner while the ledger fills with fresh,
      // contradicting exposures.
      if (b.enabled === true) {
        await ensurePromoteColumns();
        sets.push('promoted_arm_id = NULL', 'promoted_at = NULL');
      }
    }
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

// ── ARM PAGE ASSIGNMENT GUARD (review B1) ──────────────────────────────────
//
// PATCH page_id re-points a LIVE arm at a different page. It is every bit as
// money-meaning as /promote — it changes what a visitor assigned to that arm
// sees, while the arm keeps its key, its weight and its whole ledger history —
// and it was the ONLY write in this router with no validation at all. A page
// id was taken on trust, truncated to 120 chars and written.
//
// The predicate below mirrors listArmEligiblePages (the same rules the picker
// greys pages out with) plus /promote's published check, so the server refuses
// exactly what the UI declines to offer. The UI is now a convenience over this
// guard rather than the only thing enforcing it.
//
// SAME-TEST DUPLICATE IS ITS OWN REFUSAL, and it is the one a mirror of
// listArmEligiblePages would have missed. That function deliberately keeps THIS
// test's own arm pages "eligible" — they ARE the arms — so mirroring it alone
// would let arm B be pointed at arm A's page: a test measuring X against X,
// which produces a real-looking split, real traffic, and a difference that is
// pure noise by construction.
const ARM_PAGE_REFUSALS = {
  page_not_found: 'That page is not on this funnel, or it has been archived.',
  arm_page_not_published: 'That page is a draft. Publish it first — a draft arm holds weight but never serves, so the split would quietly run on one page.',
  page_is_funnel_default: 'The funnel default page is reached without passing the splitter, so an arm pointed at it can never be measured.',
  page_post_purchase: 'That is a post-purchase page. It sits behind the checkout and is routed by the funnel itself, never by the splitter.',
  page_in_other_test: 'That page is already an arm of another live split on this funnel.',
  page_already_an_arm: 'That page is already an arm of THIS test. A split cannot measure a page against itself.',
};

/**
 * @returns {Promise<string|null>} a refusal code, or null when assignable.
 * Runs inside the caller's transaction — every read is under the parent-row
 * lock the handler already holds.
 */
async function assertArmPageAssignable(q, { testId, funnelId, armId, pageId }) {
  // FOR SHARE, exactly as /promote does and for the same reason: the page's
  // published state is a PRECONDITION of this write, and without the share lock
  // a concurrent un-publish could land between this read and the commit,
  // arming a page that is dark by the time the response is written.
  const [page] = await q(
    `SELECT id, is_home, type, status FROM funnel_pages
     WHERE id = $1 AND funnel_id = $2 AND NOT archived
     FOR SHARE`,
    [pageId, funnelId]
  );
  if (!page) return 'page_not_found';
  if (String(page.status) !== 'published') return 'arm_page_not_published';
  if (page.is_home) return 'page_is_funnel_default';
  if (POST_PURCHASE_TYPES.has(String(page.type))) return 'page_post_purchase';

  // Claimed by a LIVE arm of a LIVE test on this funnel. Split into two codes
  // so the operator gets the reason they can act on: another test is somebody
  // else's experiment, this test is their own duplicate.
  const claimed = await q(
    `SELECT a.test_id FROM lb_split_arms a
     JOIN lb_split_tests t ON t.id = a.test_id
     WHERE t.funnel_id = $1 AND NOT t.archived AND NOT a.archived
       AND a.page_id = $2 AND a.id <> $3`,
    [funnelId, pageId, armId]
  );
  if (claimed.some((r) => r.test_id !== testId)) return 'page_in_other_test';
  if (claimed.length) return 'page_already_an_arm';
  return null;
}

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
    await ensurePromoteColumns(); // this handler clears promoted_arm_id (MED #6)
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

    // ── REVIEW MED #7: THIS ENDPOINT NOW TAKES THE PARENT LOCK TOO ─────────
    // The promote endpoint's comment claimed "every writer takes this same lock
    // first". It was not true of THIS handler, and the gap was reachable: its
    // guards were read-then-write against the SHARED pool, so a concurrent
    // `archived: true` here could land between promote's arms read and
    // promote's UPDATE. Measured by the reviewer: a 200 promote of an arm that
    // was archived and therefore does not serve — a "winner" pointing at a
    // retired page.
    //
    // Wrapping this handler in the SAME parent-row SELECT … FOR UPDATE makes
    // the claim true. Every guard below now reads inside that lock, so it sees
    // a state no concurrent writer can change underneath it. Parent row, not
    // arm rows, for the reason documented on the entry endpoint: N tuples
    // locked in plan order deadlock (40P01), one parent row cannot.
    const result = await pgDb.begin(async (tx) => {
      const q = (text, params = []) => tx.unsafe(text, params);
      const [test] = await q(
        `SELECT id, funnel_id FROM lb_split_tests WHERE id = $1 FOR UPDATE`,
        [testId]
      );
      if (!test) return { error: 'not_found', status: 404 };

      // ── ARM PAGE ASSIGNMENT (review B1) ─────────────────────────────────
      // The arm's existence is checked HERE rather than being left to the
      // UPDATE's zero-row case, so a patch aimed at a non-existent arm answers
      // not_found instead of a page refusal about an arm that isn't there.
      if (b.page_id !== undefined) {
        const [targetArm] = await q(
          `SELECT id FROM lb_split_arms WHERE id = $1 AND test_id = $2`,
          [armId, testId]
        );
        if (!targetArm) return { error: 'not_found', status: 404 };
        // Only a NON-NULL assignment is guarded. Clearing an arm's page stays
        // allowed: the resolver already treats a page-less arm as dark and
        // re-picks around it (split-delivery T13), so clearing is a retreat to
        // a safe state, not a new reachable one.
        const pid = b.page_id ? s(b.page_id, 120) : null;
        if (pid) {
          const refusal = await assertArmPageAssignable(q, {
            testId, funnelId: test.funnel_id, armId, pageId: pid,
          });
          if (refusal) {
            return { error: refusal, status: 422, message: ARM_PAGE_REFUSALS[refusal] };
          }
        }
      }

      // Flipping an arm TO control while another live arm already holds it is
      // rejected (mirror of the create-path rule) — use POST .../control instead.
      if (b.is_control === true) {
        const ctrl = await q(
          `SELECT 1 FROM lb_split_arms WHERE test_id = $1 AND is_control AND NOT archived AND id <> $2`,
          [testId, armId]
        );
        if (ctrl.length) return { error: 'multiple_control_arms', status: 422 };
      }
      // ── The baseline guards ──────────────────────────────────────────────
      const wouldUnsetControl = b.is_control === false;
      const wouldArchive = b.archived === true;
      if (wouldUnsetControl || wouldArchive) {
        const live = await q(
          `SELECT id, is_control FROM lb_split_arms WHERE test_id = $1 AND NOT archived`,
          [testId]
        );
        const target = live.find((a) => a.id === armId);
        // Only guard when the row is currently a LIVE arm — patching an already
        // archived arm cannot change how many live controls exist.
        if (target) {
          if (wouldArchive && live.length <= 1) return { error: 'last_live_arm', status: 422 };
          if (target.is_control) {
            if (wouldArchive) return { error: 'control_required', status: 422 };
            if (wouldUnsetControl && !live.some((a) => a.is_control && a.id !== armId)) {
              return { error: 'control_required', status: 422 };
            }
          }
        }
      }
      const rows = await q(
        `UPDATE lb_split_arms SET ${sets.join(', ')} WHERE id = $${i++} AND test_id = $${i} RETURNING id, is_entry, archived`,
        [...vals, armId, testId]
      );
      if (!rows.length) return { error: 'not_found', status: 404 };
      // ARCHIVING THE ENTRY ARM would leave /<handle> pointing at a retired page
      // — a live route with nothing behind it. Hand the role to the control (or,
      // failing that, the first live arm) instead of refusing: the operator's
      // intent (retire this arm) is unambiguous, and a route that answers is
      // strictly better than one that does not. The partial unique index makes
      // the promotion safe — it can never produce a second entry.
      if (rows[0].archived && rows[0].is_entry) {
        await q(`UPDATE lb_split_arms SET is_entry = FALSE WHERE id = $1`, [rows[0].id]);
        await q(
          `UPDATE lb_split_arms SET is_entry = TRUE WHERE id = (
             SELECT id FROM lb_split_arms
             WHERE test_id = $1 AND NOT archived
             ORDER BY is_control DESC, sort_order, arm_key LIMIT 1
           )`,
          [testId]
        );
        // The entry arm moved off the promoted arm as a side effect of
        // retiring it — the promotion no longer describes what serves, so the
        // stamp goes with it (review MED #6).
        await q(
          `UPDATE lb_split_tests SET promoted_arm_id = NULL, promoted_at = NULL, updated_at = NOW()
           WHERE id = $1 AND promoted_arm_id = $2`,
          [testId, rows[0].id]
        );
      }
      return { id: rows[0].id };
    });

    if (result.error) {
      // Named code + prose. Every other refusal in this router is code-only and
      // the client maps it; the page refusals carry the sentence too, because
      // they are the ones that say WHY a page the operator can see cannot be
      // used, and that reason is not derivable from the code alone.
      return res.status(result.status).json({
        success: false,
        error: { code: result.error, ...(result.message ? { message: result.message } : {}) },
      });
    }
    return res.json({ success: true, data: { id: result.id } });
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
    await ensurePromoteColumns(); // this handler retracts a promotion (MED #6)
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
      // REVIEW MED #6 — THIS IS THE ESCAPE HATCH THE PROMOTE ENDPOINT PROMISED.
      // Promote's 409 comment said the operator "clears it with the existing
      // entry endpoint". That was FALSE: this handler never touched
      // promoted_arm_id, so a promoted test was a permanent dead end — a second
      // promote could never succeed, and worse, moving the entry away left
      // promoted_arm_id asserting a winner that was no longer being served,
      // which is a stale claim about money sitting next to a live ledger.
      // Moving the entry to a DIFFERENT arm now retracts the promotion.
      await q(
        `UPDATE lb_split_tests SET promoted_arm_id = NULL, promoted_at = NULL
         WHERE id = $1 AND promoted_arm_id IS NOT NULL AND promoted_arm_id <> $2`,
        [testId, armId]
      );
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

// ── PROMOTE THE WINNER ─────────────────────────────────────────────────────
//
// THERE IS NO `status` COLUMN ON lb_split_tests. The table's live/terminal axis
// is `enabled` (boolean) plus `archived` (boolean) — see splitTestSchema.js:67.
// So "paused" here means exactly what it means everywhere else in this
// subsystem: enabled = FALSE, archived unchanged. There is no 'completed'
// status to reach for; inventing one would mean a CHECK-less string column that
// no reader understands.
//
// A PAUSED TEST KEEPS SERVING. splitDelivery.js:55-58 does NOT filter on
// `enabled`: a disabled, non-archived test still OWNS its route and pins every
// visitor to the ENTRY arm, unbranched, with no view recorded. That is what
// makes "promote" a complete act — set the entry arm to the winner, then pause,
// and /<handle> serves the winner to 100% of traffic with the experiment
// stopped. Nothing in splitDelivery is touched by this endpoint.
//
// promoted_arm_id / promoted_at record WHICH arm won and WHEN, so a paused test
// can be told apart from a promoted one (both read enabled=FALSE).
//
// DECISION MADE — the additive DDL lives HERE, not in splitTestSchema.js.
// The change fence for this task admits splitTests.js and not splitTestSchema.js.
// The pattern is copied verbatim from that file (addOperatorColumns): ADD COLUMN
// IF NOT EXISTS only, no drop, no retype, no backfill, serialized behind a
// single in-flight promise that resets on failure so the next request retries.
// A database created before this lane picks the columns up on the next promote
// call with its ledger untouched. To relocate it later, move these two
// statements into addOperatorColumns and delete this block.
let promoteColumnsPromise = null;
function ensurePromoteColumns() {
  if (!promoteColumnsPromise) {
    promoteColumnsPromise = (async () => {
      await pgQuery(`ALTER TABLE lb_split_tests ADD COLUMN IF NOT EXISTS promoted_arm_id TEXT`);
      await pgQuery(`ALTER TABLE lb_split_tests ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`);
    })().catch((err) => { promoteColumnsPromise = null; throw err; });
  }
  return promoteColumnsPromise;
}

// The promote response's own column list. TEST_COLS is shared with every other
// endpoint in this file; widening it would change four responses to ship one.
const PROMOTE_TEST_COLS = `${TEST_COLS}, promoted_arm_id, promoted_at`;

// POST /:id/promote  { arm_id, confirm: true }
//
// Atomic, parent-row-locked, for the same reason the entry swap is
// (POST /:id/arms/:armId/entry): this moves the live route. One transaction,
// lock lb_split_tests FOR UPDATE first, clear-then-set, then pause.
//
// REFUSALS, and why each one exists:
//   confirm !== true      → 400. This repoints live traffic. It is the same
//                           posture reassignDomain takes on a connected host.
//   unknown test / arm    → 404.
//   archived arm          → 422. An archived arm takes no traffic; promoting it
//                           would point /<handle> at a retired page (the same
//                           rule the entry endpoint enforces at :490).
//   arm has no page       → 422. Nothing to serve.
//   arm's page is a draft → 422. splitDelivery only resolves a page that is
//                           `NOT archived AND status = 'published'` (:91). A
//                           draft arm would fall through the re-pick loop and
//                           the "winner" would never be what serves — a promote
//                           that silently does not promote.
//
// REPLAY — DECISION MADE: idempotent for the SAME arm, 409 for a DIFFERENT one.
// Re-promoting the winner is a retry (a dropped response, a double click) and
// re-asserts the same end state, so it answers 200 with the unchanged test.
// Promoting a second, different arm onto an already-promoted test is not a
// retry — it is a new decision about which page earns the traffic, and the
// ledger behind the first verdict no longer describes what is serving. That
// answers 409 `already_promoted`.
//
// ⚠️ THE 409 IS RECOVERABLE, AND IT ONLY BECAME SO IN THIS CHANGE (review
// MED #6). An earlier version of this comment claimed the operator could clear
// the state with the entry endpoint; that endpoint did not touch
// promoted_arm_id, so the 409 was permanent and the row went on asserting a
// winner that had stopped serving. TWO paths now retract a promotion, both
// deliberate operator acts:
//   • POST /:id/arms/:armId/entry with a DIFFERENT arm — the entry moved, so
//     the promotion no longer describes what serves.
//   • PATCH /:id { enabled: true } — the experiment restarted, so there is no
//     winner any more.
// Archiving the promoted entry arm retracts it too, because that handler hands
// the entry role to another arm.
router.post('/:id/promote', async (req, res) => {
  try {
    await ensureSplitTables();
    await ensurePromoteColumns();
    const b = req.body || {};
    if (b.confirm !== true) {
      return res.status(400).json({ success: false, error: { code: 'confirm_required' } });
    }
    const testId = s(req.params.id, 120);
    const armId = s(b.arm_id, 120);
    if (!armId) return res.status(422).json({ success: false, error: { code: 'arm_id_required' } });

    const result = await pgDb.begin(async (tx) => {
      const q = (text, params = []) => tx.unsafe(text, params);
      // Parent-row lock, NOT a lock over the arm rows — N tuples locked in plan
      // order deadlock under concurrency (measured on the entry swap: 12
      // concurrent moves → 6 × 40P01). One parent row has no ordering to
      // disagree about, and every writer here takes this same lock first.
      const [test] = await q(
        `SELECT id, promoted_arm_id FROM lb_split_tests WHERE id = $1 FOR UPDATE`,
        [testId]
      );
      if (!test) return { error: 'not_found', status: 404 };

      const arms = await q(
        `SELECT id, arm_key, page_id, archived FROM lb_split_arms WHERE test_id = $1`,
        [testId]
      );
      const target = arms.find((a) => a.id === armId);
      if (!target) return { error: 'not_found', status: 404 };
      if (test.promoted_arm_id && test.promoted_arm_id !== armId) {
        return { error: 'already_promoted', status: 409 };
      }
      if (target.archived) return { error: 'arm_archived', status: 422 };
      if (!target.page_id) return { error: 'arm_has_no_page', status: 422 };
      // The exact predicate splitDelivery uses to decide an arm is servable.
      // FOR SHARE (review LOW #15): the page's published state is a PRECONDITION
      // of this promote, and without a share lock a concurrent PATCH could
      // un-publish the page between this read and the commit — promoting a
      // winner onto a page that is dark by the time the response is written.
      // A share lock blocks that UPDATE until this transaction ends without
      // blocking other readers.
      const [page] = await q(
        `SELECT id FROM funnel_pages
         WHERE id = $1 AND NOT archived AND status = 'published'
         FOR SHARE`,
        [String(target.page_id)]
      );
      if (!page) return { error: 'arm_page_not_published', status: 422 };

      await q(
        `UPDATE lb_split_arms SET is_entry = FALSE WHERE test_id = $1 AND is_entry AND id <> $2`,
        [testId, armId]
      );
      // Structural belt for MED #7: even with the arm PATCH now taking this
      // same parent lock, the promotion refuses to set an archived arm as
      // entry at the STATEMENT level. Zero rows here means the arm was retired
      // under us; the transaction returns arm_archived instead of a 200 that
      // crowns a page nobody will ever see.
      const entrySet = await q(
        `UPDATE lb_split_arms SET is_entry = TRUE WHERE id = $1 AND NOT archived RETURNING id`,
        [armId]
      );
      if (!entrySet.length) return { error: 'arm_archived', status: 422 };
      const [row] = await q(
        `UPDATE lb_split_tests
         SET enabled = FALSE, promoted_arm_id = $2,
             promoted_at = COALESCE(promoted_at, NOW()), updated_at = NOW()
         WHERE id = $1
         RETURNING ${PROMOTE_TEST_COLS}`,
        [testId, armId]
      );
      return { test: row, arm_key: target.arm_key };
    });

    if (result.error) {
      return res.status(result.status).json({ success: false, error: { code: result.error } });
    }
    return res.json({
      success: true,
      data: { ...result.test, promoted_arm_key: result.arm_key },
    });
  } catch (err) {
    console.error('[splitTests] promote failed:', err);
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
