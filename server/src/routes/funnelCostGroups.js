// COST GROUPS + PROPOSALS — authed operator surface over funnelCostGroups.js
// (membership) and funnelCostGroupDetect.js (the candidate detector).
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/funnel-cost-groups', funnelCostGroupsRoutes);
//
// A SEPARATE ROUTE FILE ON PURPOSE. /api/v1/funnel-costs is the money
// surface: the P&L endpoints, the one rate write door, the spend feed. This
// lane adds a dozen endpoints that touch none of that, so they live apart
// rather than growing the file every costs change has to re-read.
//
// THERE IS NO RATE ENDPOINT HERE, DELIBERATELY. A group's cost is written
// through POST /api/v1/funnel-costs/rates with {scope:'item', cost_item_id},
// the same append-only, effective-dated door as a variant rate. A second
// write path would be a second history — and the one thing money data cannot
// have is two ledgers.
//
// Same guard as the other funnel surfaces: authenticate +
// requirePermission('funnels','access'). Services LET IT THROW; this file is
// the boundary that maps CostError → 4xx {success:false, error:{code}} and
// everything else → 500 internal_error (message logged, never a token).
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureFunnelCostsTables } from '../services/funnelCostsSchema.js';
import { CostError } from '../services/funnelCosts.js';
import {
  listGroups, getGroup, groupRateHistory, groupMemberHistory, createGroup,
  updateGroup, addMembers, removeMembers, deleteGroup,
} from '../services/funnelCostGroups.js';
import {
  detectProposals, listProposals, getProposal, dismissProposal,
  reopenProposal, acceptProposal,
} from '../services/funnelCostGroupDetect.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

router.use(async (req, res, next) => {
  try {
    await ensureFunnelCostsTables();
    next();
  } catch (err) {
    next(err);
  }
});

// The one error boundary — same contract as funnelCosts.js. CONFLICT codes
// answer 409: they mean "the world moved under you", not "your payload is
// malformed", and a client retrying a 422 forever is a different bug from one
// that re-reads and shows the operator what changed.
const CONFLICT_CODES = new Set([
  'already_accepted', 'name_taken', 'variant_in_other_group', 'group_archived',
]);
const NOT_FOUND_CODES = new Set(['group_not_found', 'unknown_proposal', 'item_not_found']);

const guard = (name, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof CostError) {
      const status = CONFLICT_CODES.has(err.code) ? 409
        : NOT_FOUND_CODES.has(err.code) ? 404
          : 422;
      return res.status(status).json({ success: false, error: { code: err.code } });
    }
    console.error(`[funnelCostGroups] ${name} failed:`, err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
};

const userId = (req) => String((req.user && (req.user.email || req.user.id)) || '');
const truthy = (v) => v === true || v === 'true' || v === '1';

// ── proposals ───────────────────────────────────────────────────────────────
// Declared BEFORE /:costItemId so the literal path is not swallowed by the
// parameterised one.

// POST /proposals/detect — re-run the rule. Idempotent: a proposal's identity
// is the sha1 of its stem set, so a re-run refreshes rows rather than
// duplicating them, and never resurrects a dismissal.
router.post('/proposals/detect', guard('proposals-detect', async (req, res) => {
  res.json({ success: true, data: await detectProposals() });
}));

// GET /proposals?status=open|accepted|dismissed|all&limit
router.get('/proposals', guard('proposals-list', async (req, res) => {
  const out = await listProposals({
    status: req.query.status ? String(req.query.status) : 'open',
    limit: req.query.limit,
  });
  res.json({ success: true, data: out });
}));

router.get('/proposals/:id', guard('proposal-get', async (req, res) => {
  res.json({ success: true, data: { proposal: await getProposal(String(req.params.id)) } });
}));

// POST /proposals/:id/accept — the proposal becomes a group.
// Body: {name?, note?, members?}. Members default to the proposal's
// members_ready (pack size known, not already in another group); passing them
// explicitly is how the operator drops or re-sizes one before binding.
// Creates NO rate — the group is costed through the rates door.
router.post('/proposals/:id/accept', guard('proposal-accept', async (req, res) => {
  const b = req.body || {};
  const out = await acceptProposal(String(req.params.id), {
    name: b.name === undefined ? '' : String(b.name),
    note: b.note === undefined ? '' : String(b.note),
    members: Array.isArray(b.members) ? b.members : null,
    actor: userId(req),
    steal: b.steal === true,
  });
  res.json({ success: true, data: out });
}));

// POST /proposals/:id/dismiss — idempotent, and STICKY: detect re-writes a
// dismissed proposal's contents but never its status.
router.post('/proposals/:id/dismiss', guard('proposal-dismiss', async (req, res) => {
  const b = req.body || {};
  const out = await dismissProposal(String(req.params.id), {
    reason: b.reason === undefined ? '' : String(b.reason),
    actor: userId(req),
  });
  res.json({ success: true, data: out });
}));

// POST /proposals/:id/reopen — undo a dismissal. Without this a mis-click
// hides a real grouping forever, since detect refuses to resurrect one.
router.post('/proposals/:id/reopen', guard('proposal-reopen', async (req, res) => {
  res.json({ success: true, data: await reopenProposal(String(req.params.id)) });
}));

// ── groups ──────────────────────────────────────────────────────────────────

// GET / — the Groups tab. Each group carries its members (with resolved
// for-today cost and which layer answered), its rate in force today, and its
// own coverage rollup.
router.get('/', guard('groups-list', async (req, res) => {
  const out = await listGroups({
    includeArchived: truthy(req.query.include_archived),
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data: out });
}));

// POST / — create a group and bind its members in one call.
// Body: {name, note?, members:[{variant_id, units_per?}|variant_id]}.
router.post('/', guard('group-create', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.members)) {
    return res.status(422).json({ success: false, error: { code: 'bad_members' } });
  }
  const out = await createGroup({
    name: b.name === undefined ? '' : b.name,
    note: b.note === undefined ? '' : b.note,
    members: b.members,
    createdBy: userId(req),
    // Moving a variant out of another group changes which rate answers its
    // cost, so it takes an explicit act — never a side effect of this call.
    steal: b.steal === true,
  });
  res.status(201).json({ success: true, data: out });
}));

router.get('/:costItemId', guard('group-get', async (req, res) => {
  res.json({ success: true, data: { group: await getGroup(String(req.params.costItemId)) } });
}));

// PATCH /:costItemId — identity only {name?, note?, archived?}. Membership
// has its own endpoints; a rate has its own door.
router.patch('/:costItemId', guard('group-patch', async (req, res) => {
  const b = req.body || {};
  const allowed = ['name', 'note', 'archived'];
  for (const k of Object.keys(b)) {
    if (!allowed.includes(k)) {
      return res.status(422).json({ success: false, error: { code: 'unknown_field' } });
    }
  }
  const group = await updateGroup(String(req.params.costItemId), b, userId(req));
  res.json({ success: true, data: { group } });
}));

// DELETE /:costItemId — ARCHIVE + unbind, never a row drop. The group's rate
// rows are money history and are kept, so a past day's P&L stays
// reconstructible after the operator retires a grouping.
router.delete('/:costItemId', guard('group-delete', async (req, res) => {
  res.json({ success: true, data: await deleteGroup(String(req.params.costItemId), userId(req)) });
}));

// POST /:costItemId/members — bind. A variant already in ANOTHER group is
// MOVED, and the move is reported in `moved` rather than done quietly: a
// rebind changes which rate answers that variant's cost.
router.post('/:costItemId/members', guard('members-add', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.members)) {
    return res.status(422).json({ success: false, error: { code: 'bad_members' } });
  }
  res.json({
    success: true,
    data: await addMembers(String(req.params.costItemId), b.members, {
      steal: b.steal === true, actor: userId(req),
    }),
  });
}));

// DELETE /:costItemId/members/:variantId — unbind ONE. The variant keeps
// every rate it ever had; only the group pointer is cleared, so its cost
// falls back to its own variant rate or to unknown (never 0).
router.delete('/:costItemId/members/:variantId', guard('member-remove', async (req, res) => {
  const out = await removeMembers(String(req.params.costItemId), [String(req.params.variantId)]);
  res.json({ success: true, data: out });
}));

// POST /:costItemId/members/remove — unbind MANY. Body {members:[variant_id]}.
router.post('/:costItemId/members/remove', guard('members-remove', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.members)) {
    return res.status(422).json({ success: false, error: { code: 'bad_members' } });
  }
  res.json({ success: true, data: await removeMembers(String(req.params.costItemId), b.members) });
}));

// GET /:costItemId/history — the group's rate ledger, newest first. Same
// append-only rows as a variant's history, filtered to scope='item'.
router.get('/:costItemId/history', guard('group-history', async (req, res) => {
  res.json({
    success: true,
    data: await groupRateHistory(String(req.params.costItemId), req.query.limit),
  });
}));

// GET /:costItemId/members/history — the MEMBERSHIP ledger: who was in this
// group, with what units_per, from when. Membership is an input to a price,
// so this is the audit trail for "why did March price the way it did".
router.get('/:costItemId/members/history', guard('member-history', async (req, res) => {
  res.json({
    success: true,
    data: await groupMemberHistory(String(req.params.costItemId), req.query.limit),
  });
}));

export default router;
