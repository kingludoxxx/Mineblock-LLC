// CostGroupsTab — several variants under ONE cost item, and the suggestions
// that propose those groupings (NEW FILE, cost-groups lane).
//
// WHY A GROUP EXISTS. The same bottle sells as 1x / 3x / 5x, and the same tee
// in six colours. Costing each variant separately is the same number typed
// six times and wrong within a week. A group carries ONE rate, and every
// member resolves through it — multiplied by units_per, because COGS is per
// unit OF THE VARIANT (a "3 Pack" bound to a single-bottle group costs 3x).
//
// ── WHAT THIS TAB DELIBERATELY CANNOT DO ─────────────────────────────────
// It cannot write a cost. The rate lives behind the same append-only door as
// every variant rate (RateDrawer → POST /rates with scope 'item'), so a group
// rate gets the same history and the same null-vs-0 rule. This tab binds
// members and shows what that binding is doing to the numbers.
//
// ── THE THREE THINGS AN OPERATOR HAS TO SEE ──────────────────────────────
//   1. SHADOWED members. Precedence is variant-rate BEATS group-rate, so a
//      member with its own rate does not move when the group rate changes.
//      Hiding that produces "I set the group cost and nothing happened".
//   2. Unknown vs free. A member with no cost reads "—", never "$0.00". The
//      P&L withholds profit on unknown and grants it on a real 0; the UI must
//      not blur the two into one glyph.
//   3. Cross-funnel reach. A group rate moves every funnel its members sell
//      on, not just the one being looked at.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Layers, Loader2, Plus,
  RefreshCw, Search, Sparkles, Trash2, X,
} from 'lucide-react';
import Card from '../../../components/ui/Card';
import Button from '../../../components/ui/Button';
import {
  acceptProposal, addCostGroupMembers, costApiError, createCostGroup,
  deleteCostGroup, dismissProposal, fetchCostGroups, fetchProposals,
  postProposalsDetect, removeCostGroupMember,
} from '../costsApi';
import { fmtMoney } from '../costTargets';

/** Unknown reads as a dash. NEVER as $0.00 — see the header. */
const money = (v) => (v === null || v === undefined ? '—' : fmtMoney(v));

const CONFIDENCE_TONE = {
  certain: 'text-green-400 border-green-400/30 bg-green-400/10',
  high: 'text-sky-400 border-sky-400/30 bg-sky-400/10',
  review: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
};

function Chip({ tone = 'neutral', title, children }) {
  const tones = {
    neutral: 'text-text-muted border-border-default bg-bg-elevated/60',
    warn: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
    good: 'text-green-400 border-green-400/30 bg-green-400/10',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-none ${tones[tone] || tones.neutral}`}
    >
      {children}
    </span>
  );
}

// ── Proposal card ──────────────────────────────────────────────────────────
// Shows the VERDICT, not just the answer: which checks passed, what is
// blocking a one-click, and every member it would bind. A suggestion the
// operator cannot audit is one they should not accept.
function ProposalCard({ proposal, canEdit, busy, onAccept, onDismiss }) {
  const [open, setOpen] = useState(false);
  const p = proposal;
  const failed = (p.checks || []).filter((c) => !c.ok);
  const ready = p.members_ready || [];
  const canOneClick = canEdit && ready.length >= 2;

  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated/30 p-3" data-testid="cost-group-proposal">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="w-3.5 h-3.5 text-accent-text shrink-0" />
            <span className="text-sm text-text-primary truncate">{p.suggested_name || p.proposal_id}</span>
            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] leading-none ${CONFIDENCE_TONE[p.confidence] || CONFIDENCE_TONE.review}`}>
              {p.confidence}
            </span>
            {p.linked && (
              <Chip title="This grouping spans more than one Shopify product — it links them on an exact title match">
                links {(p.shopify_product_ids || []).length} products
              </Chip>
            )}
          </div>
          <p className="mt-1 text-[12px] text-text-muted">
            {(p.members || []).length} variants
            {' · '}
            <span className="tabular-nums">{fmtMoney(p.revenue_30d)}</span> in the last 30 days
            {ready.length !== (p.members || []).length && (
              <span className="text-amber-400">
                {' · '}{(p.members || []).length - ready.length} blocked
              </span>
            )}
          </p>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="primary"
              loading={busy === `accept:${p.proposal_id}`}
              disabled={!canOneClick || Boolean(busy)}
              onClick={() => onAccept(p)}
              title={canOneClick
                ? `Create a cost group from the ${ready.length} bindable variants`
                : 'Not enough bindable variants — resolve the blockers first'}
              data-testid="cost-group-proposal-accept"
            >
              <Check className="w-3.5 h-3.5" />
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => onDismiss(p)}
              title="Hide this suggestion. It stays hidden across future detection runs."
              data-testid="cost-group-proposal-dismiss"
            >
              <X className="w-3.5 h-3.5" />
              Dismiss
            </Button>
          </div>
        )}
      </div>

      {/* The verdict. Failures are stated, never silently absorbed. */}
      {(failed.length > 0 || (p.blockers || []).length > 0) && (
        <ul className="mt-2 space-y-1">
          {failed.map((c) => (
            <li key={c.code} className="flex items-start gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle className="w-3 h-3 mt-[2px] shrink-0" />
              <span>{c.detail}</span>
            </li>
          ))}
          {(p.blockers || []).map((b, i) => (
            <li key={`${b.code}-${b.variant_id || i}`} className="flex items-start gap-1.5 text-[11px] text-text-muted">
              <AlertTriangle className="w-3 h-3 mt-[2px] shrink-0" />
              <span>{b.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {open ? 'Hide' : 'Show'} the {(p.members || []).length} variants
      </button>

      {open && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-text-faint">
              <tr className="text-left">
                <th className="font-normal py-1 pr-3">Variant</th>
                <th className="font-normal py-1 pr-3 text-right">Units per</th>
                <th className="font-normal py-1 pr-3 text-right">Price</th>
                <th className="font-normal py-1 pr-3 text-right">30d units</th>
                <th className="font-normal py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {(p.members || []).map((m) => (
                <tr key={m.variant_id} className="border-t border-border-default/50">
                  <td className="py-1 pr-3 text-text-primary">
                    <span className="text-text-muted">{m.product_title}</span>
                    {m.variant_title ? ` · ${m.variant_title}` : ''}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {/* Unknown pack size is a dash — a silent 1 would understate a 3-pack's cost threefold. */}
                    {m.units_per === null || m.units_per === undefined ? '—' : `× ${m.units_per}`}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{money(m.price)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{m.units_30d ?? 0}</td>
                  <td className="py-1">
                    {ready.includes(m.variant_id)
                      ? <Chip tone="good">will bind</Chip>
                      : <Chip tone="warn" title={m.already_bound_to ? `Already in ${m.already_bound_to}` : 'Pack size unreadable'}>blocked</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Member picker ──────────────────────────────────────────────────────────
// Searches the ALREADY-LOADED variant rows (the same page the grid renders),
// so it can never disagree with what the operator just saw. Variants already
// in this group are excluded; ones in ANOTHER group are shown with a warning,
// because binding them is a MOVE that changes which rate answers their cost.
function MemberPicker({ rows, exclude, onAdd, busy }) {
  const [q, setQ] = useState('');
  const [unitsPer, setUnitsPer] = useState({});
  // A variant already in another group needs a SECOND, deliberate click: the
  // server refuses the move without an explicit steal flag, and the operator
  // should see what they are taking it out of before that flag is sent.
  const [armed, setArmed] = useState('');

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return rows
      .filter((r) => !exclude.has(String(r.variant_id)))
      .filter((r) => `${r.product_title} ${r.variant_title} ${r.variant_id}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [q, rows, exclude]);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Add a variant — search by product, variant or id"
            className="w-full h-[30px] pl-8 pr-2 rounded-lg border border-border-default bg-bg-elevated
                       text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none
                       focus:border-border-strong"
            data-testid="cost-group-member-search"
          />
        </div>
      </div>
      {matches.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {matches.map((r) => (
            <li key={r.variant_id} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 truncate text-text-primary">
                <span className="text-text-muted">{r.product_title}</span>
                {r.variant_title ? ` · ${r.variant_title}` : ''}
              </span>
              {r.cost_item_id && (
                <Chip tone="warn" title="Adding this variant MOVES it out of the group it is in now">
                  moves group
                </Chip>
              )}
              <span className="ml-auto flex items-center gap-1.5 shrink-0">
                <label className="text-text-faint" htmlFor={`up-${r.variant_id}`}>units</label>
                <input
                  id={`up-${r.variant_id}`}
                  type="number"
                  min="1"
                  step="1"
                  value={unitsPer[r.variant_id] ?? 1}
                  onChange={(e) => setUnitsPer((s) => ({ ...s, [r.variant_id]: e.target.value }))}
                  className="w-14 h-[26px] px-1.5 rounded-md border border-border-default bg-bg-elevated
                             text-right tabular-nums text-text-primary focus:outline-none"
                  title="How many of the GROUP's unit this variant contains — a 3-pack is 3"
                />
                <Button
                  size="sm"
                  variant={armed === r.variant_id ? 'danger' : 'secondary'}
                  disabled={Boolean(busy)}
                  title={r.cost_item_id
                    ? 'This variant is in another cost group — moving it changes which rate answers its cost'
                    : 'Add this variant to the group'}
                  onClick={() => {
                    // Not in a group → add outright. In one → arm, then move.
                    if (!r.cost_item_id) {
                      onAdd(r.variant_id, unitsPer[r.variant_id] ?? 1, false);
                      setQ('');
                      return;
                    }
                    if (armed !== r.variant_id) { setArmed(r.variant_id); return; }
                    onAdd(r.variant_id, unitsPer[r.variant_id] ?? 1, true);
                    setArmed('');
                    setQ('');
                  }}
                >
                  {r.cost_item_id
                    ? (armed === r.variant_id ? 'Confirm move' : 'Move here')
                    : <Plus className="w-3 h-3" />}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── New-group panel ────────────────────────────────────────────────────────
// The operator PICKS the members. An earlier draft grabbed the first two
// unbound variants off the page — variants nobody chose, bound to a cost
// item that is about to carry a real rate. Selection is explicit here, and
// the submit stays disabled below two, because a one-member group is a rate
// that reaches one variant by a longer route.
function NewGroupPanel({ rows, busy, onCancel, onCreate }) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({}); // variant_id → units_per

  const available = useMemo(
    () => rows.filter((r) => !r.cost_item_id && r.coverage !== 'ignored'),
    [rows],
  );
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = needle
      ? available.filter((r) => `${r.product_title} ${r.variant_title} ${r.variant_id}`.toLowerCase().includes(needle))
      : available;
    return base.slice(0, 40);
  }, [q, available]);

  const chosen = Object.keys(picked);
  const toggle = (vid) => setPicked((s) => {
    const next = { ...s };
    if (next[vid] === undefined) next[vid] = 1; else delete next[vid];
    return next;
  });

  return (
    <div className="mt-3 rounded-lg border border-border-default bg-bg-elevated/30 p-3 space-y-3" data-testid="cost-group-new">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Group name — e.g. Breast Lift bottle"
        className="w-full h-[32px] px-2.5 rounded-lg border border-border-default bg-bg-elevated
                   text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none
                   focus:border-border-strong"
        data-testid="cost-group-new-name"
      />

      <div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${available.length} variants that are not in a group yet`}
            className="w-full h-[30px] pl-8 pr-2 rounded-lg border border-border-default bg-bg-elevated
                       text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none"
            data-testid="cost-group-new-search"
          />
        </div>
        {available.length === 0 ? (
          <p className="mt-2 text-[11px] text-text-muted">
            Every variant in the catalog is already in a group. Unbind one first, or run detection.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 max-h-[240px] overflow-y-auto">
            {matches.map((r) => {
              const on = picked[r.variant_id] !== undefined;
              return (
                <li key={r.variant_id} className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    id={`pick-${r.variant_id}`}
                    checked={on}
                    onChange={() => toggle(r.variant_id)}
                    className="shrink-0 accent-accent"
                  />
                  <label htmlFor={`pick-${r.variant_id}`} className="min-w-0 truncate text-text-primary cursor-pointer">
                    <span className="text-text-muted">{r.product_title}</span>
                    {r.variant_title ? ` · ${r.variant_title}` : ''}
                  </label>
                  {on && (
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      <label className="text-text-faint" htmlFor={`nu-${r.variant_id}`}>units</label>
                      <input
                        id={`nu-${r.variant_id}`}
                        type="number"
                        min="1"
                        step="1"
                        value={picked[r.variant_id]}
                        onChange={(e) => setPicked((s) => ({ ...s, [r.variant_id]: e.target.value }))}
                        className="w-14 h-[26px] px-1.5 rounded-md border border-border-default bg-bg-elevated
                                   text-right tabular-nums text-text-primary focus:outline-none"
                        title="How many of the GROUP's unit this variant contains — a 3-pack is 3"
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-text-muted">
          {chosen.length} selected{chosen.length < 2 ? ' — a group needs at least two' : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy === 'create'}
            disabled={!name.trim() || chosen.length < 2 || Boolean(busy)}
            onClick={() => onCreate(name.trim(), chosen.map((vid) => ({
              variant_id: vid, units_per: Number(picked[vid]) || 1,
            })))}
            data-testid="cost-group-new-submit"
          >
            Create group
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </span>
      </div>
    </div>
  );
}

// ── Delete confirm ─────────────────────────────────────────────────────────
// Archiving a group unbinds every member, so from today those variants lose
// the cost the group was giving them. That is a margin change on live
// revenue, and it takes more than one stray click: the operator types the
// group's name back.
function DeleteConfirm({ group, busy, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toLowerCase() === String(group.name || '').trim().toLowerCase();
  return (
    <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 space-y-2" data-testid="cost-group-delete-confirm">
      <p className="text-[12px] text-text-primary flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 mt-[2px] text-danger shrink-0" />
        <span>
          Archiving <strong>{group.name}</strong> unbinds its{' '}
          <span className="tabular-nums">{group.member_count}</span> variant
          {group.member_count === 1 ? '' : 's'}. From today they lose this group&rsquo;s cost and fall back to
          their own rate, or to no cost at all — which withholds their profit rather than reporting it as
          100% margin. Days they were already members keep their cost, and the group&rsquo;s rate history is kept.
        </span>
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type "${group.name}" to confirm`}
          className="flex-1 min-w-[200px] h-[30px] px-2.5 rounded-lg border border-border-default bg-bg-elevated
                     text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none"
          data-testid="cost-group-delete-typed"
        />
        <Button
          size="sm"
          variant="danger"
          disabled={!armed || Boolean(busy)}
          loading={busy === `del:${group.cost_item_id}`}
          onClick={onConfirm}
          data-testid="cost-group-delete-confirm-btn"
        >
          Archive group
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ── Group row ──────────────────────────────────────────────────────────────
function GroupCard({ group, rows, canEdit, busy, onAddMember, onRemoveMember, onDelete }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const g = group;
  const exclude = useMemo(
    () => new Set((g.members || []).map((m) => String(m.variant_id))),
    [g.members],
  );
  const rate = g.rate;
  const shadowed = g.coverage?.shadowed ?? 0;

  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated/30 p-3" data-testid="cost-group">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-2 min-w-0 text-left"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 mt-1 text-text-muted" /> : <ChevronRight className="w-3.5 h-3.5 mt-1 text-text-muted" />}
          <span className="min-w-0">
            <span className="flex items-center gap-2 flex-wrap">
              <Layers className="w-3.5 h-3.5 text-accent-text shrink-0" />
              <span className="text-sm text-text-primary truncate">{g.name}</span>
              <Chip>{g.member_count} variants</Chip>
              {/* A group everything was unbound out of still holds a rate that
                  now reaches nobody. Say so — an ordinary empty row reads as
                  "nothing to see". */}
              {g.is_empty && (
                <Chip tone="warn" title="This group has no members, so its rate reaches no variant">
                  empty — rate reaches nobody
                </Chip>
              )}
              {/* One member short of being a group — almost always what a
                  steal leaves behind. Its rate still prices that member, so
                  this is a smell, not a fault. */}
              {g.is_understaffed && !g.is_empty && (
                <Chip tone="warn" title="A group needs two variants to be worth having — this one has been reduced to one, probably by a move">
                  only 1 member
                </Chip>
              )}
              {shadowed > 0 && (
                <Chip
                  tone="warn"
                  title="These members have their OWN variant rate, which beats the group rate — the group cost does not move them"
                >
                  {shadowed} shadowed
                </Chip>
              )}
              {/* N5 — a ship-only variant rate shadows the group's SHIPPING
                  but not its COGS. Calling both "shadowed" would say the
                  group cost is inert when it is doing all the work. */}
              {(g.coverage?.ship_shadowed ?? 0) > 0 && (
                <Chip
                  tone="warn"
                  title="These members have their own SHIPPING rate, which beats the group's ship map. Their group COGS still applies."
                >
                  {g.coverage.ship_shadowed} ship-only
                </Chip>
              )}
            </span>
            <span className="mt-1 block text-[12px] text-text-muted">
              {/* The group's rate, or the honest absence of one. */}
              {rate && rate.unit_cogs !== null
                ? <>Rate <span className="tabular-nums text-text-primary">{money(rate.unit_cogs)}</span>/unit since {rate.effective_from}</>
                : <span className="text-amber-400">No cost entered — every member is booked at 100% margin</span>}
              {' · '}
              <span className="tabular-nums">{fmtMoney(g.coverage?.revenue_30d ?? 0)}</span> in 30d
              {(g.coverage?.revenue_at_risk_30d ?? 0) > 0 && (
                <span className="text-amber-400">
                  {' · '}<span className="tabular-nums">{fmtMoney(g.coverage.revenue_at_risk_30d)}</span> at risk
                </span>
              )}
            </span>
          </span>
        </button>

        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => setConfirming((v) => !v)}
            title="Archive this group and unbind its variants. Its rate history is kept."
            data-testid="cost-group-delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {confirming && canEdit && (
        <DeleteConfirm
          group={g}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => { await onDelete(g); setConfirming(false); }}
        />
      )}

      {open && (
        <div className="mt-3">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="text-text-faint">
                <tr className="text-left">
                  <th className="font-normal py-1 pr-3">Variant</th>
                  <th className="font-normal py-1 pr-3 text-right">Units per</th>
                  <th className="font-normal py-1 pr-3 text-right">Unit cost</th>
                  <th className="font-normal py-1 pr-3">Source</th>
                  <th className="font-normal py-1 pr-3 text-right">30d rev</th>
                  <th className="font-normal py-1" />
                </tr>
              </thead>
              <tbody>
                {(g.members || []).map((m) => (
                  <tr key={m.variant_id} className="border-t border-border-default/50">
                    <td className="py-1 pr-3 text-text-primary">
                      <span className="text-text-muted">{m.product_title}</span>
                      {m.variant_title ? ` · ${m.variant_title}` : ''}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">× {m.units_per}</td>
                    {/* Unknown is a dash. An explicit 0 prints as $0.00 — a real
                        answer meaning "known free", and a different fact. */}
                    <td className="py-1 pr-3 text-right tabular-nums text-text-primary">{money(m.unit_cogs)}</td>
                    <td className="py-1 pr-3">
                      {m.shadowed_by_variant_rate
                        ? (
                          <Chip tone="warn" title="This variant has its own rate, which BEATS the group rate. Changing the group cost will not move it.">
                            own rate wins
                          </Chip>
                        )
                        : m.cogs_source === 'item'
                          ? <Chip tone="good">group</Chip>
                          : <Chip tone="warn">no cost</Chip>}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{fmtMoney(m.revenue_30d)}</td>
                    <td className="py-1 text-right">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => onRemoveMember(g, m)}
                          disabled={Boolean(busy)}
                          title="Unbind. The variant keeps its own rates; only the group pointer is cleared."
                          className="text-text-faint hover:text-danger disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <MemberPicker
              rows={rows}
              exclude={exclude}
              busy={busy}
              onAdd={(vid, up) => onAddMember(g, vid, up)}
            />
          )}

          <p className="mt-2 text-[11px] text-text-faint">
            Enter this group&rsquo;s cost from any member&rsquo;s rate drawer — pick the
            &ldquo;Cost group&rdquo; scope. One rate covers every member, multiplied by its units-per.
          </p>
        </div>
      )}
    </div>
  );
}

// ── The tab ────────────────────────────────────────────────────────────────
export default function CostGroupsTab({ rows = [], canEdit = false, notify, onChanged }) {
  const [groups, setGroups] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, p] = await Promise.all([
        fetchCostGroups(),
        // A failed suggestions call must not take the group list down with it.
        fetchProposals({ status: 'open' }).catch(() => null),
      ]);
      setGroups(g?.items || []);
      if (p) setProposals(p.items || []);
      setLoadError(null);
    } catch (e) {
      setLoadError(costApiError(e, 'Could not load cost groups'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Every write reloads BOTH this tab and the page's variant rows: binding a
  // member changes that variant's resolved cost, and a stale grid row would
  // feed the next rate save a cost that is no longer true.
  const after = useCallback(async () => {
    await load();
    if (onChanged) await onChanged();
  }, [load, onChanged]);

  const runDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = await postProposalsDetect();
      notify?.(`Detection finished — ${res?.open ?? 0} open suggestions (${res?.certain ?? 0} certain, ${res?.review ?? 0} to review)`);
      await load();
    } catch (e) {
      notify?.(costApiError(e, 'Detection failed'), true);
    } finally {
      setDetecting(false);
    }
  }, [load, notify]);

  const onAccept = useCallback(async (p) => {
    setBusy(`accept:${p.proposal_id}`);
    try {
      const res = await acceptProposal(p.proposal_id);
      notify?.(`Created "${res?.group?.name}" with ${res?.group?.member_count ?? 0} variants. It has no cost yet — enter one from any member.`);
      await after();
    } catch (e) {
      notify?.(costApiError(e, 'Could not accept that suggestion'), true);
    } finally {
      setBusy(null);
    }
  }, [after, notify]);

  const onDismiss = useCallback(async (p) => {
    setBusy(`dismiss:${p.proposal_id}`);
    try {
      await dismissProposal(p.proposal_id);
      notify?.('Suggestion dismissed — it stays hidden across future detection runs.');
      await load();
    } catch (e) {
      notify?.(costApiError(e, 'Could not dismiss that suggestion'), true);
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  const onAddMember = useCallback(async (g, variantId, unitsPer, steal = false) => {
    setBusy(`add:${g.cost_item_id}`);
    try {
      const res = await addCostGroupMembers(
        g.cost_item_id,
        [{ variant_id: variantId, units_per: Number(unitsPer) || 1 }],
        steal,
      );
      // A move is never silent — it changes which rate answers that variant,
      // AND it can strand the group it came from below two members.
      if (res?.source_understaffed?.length) {
        const names = res.source_understaffed.map((s) => `"${s.name}" (${s.member_count} left)`).join(', ');
        notify?.(`Moved the variant here — but this left ${names} below two members. Its rate now prices almost nothing.`, true);
      } else if (res?.moved?.length) {
        notify?.(`Moved ${res.moved.length} variant(s) out of another cost group.`);
      } else if (res?.missing?.length) {
        notify?.('That variant has no catalog row yet — run detection first.', true);
      } else {
        notify?.('Variant added to the group.');
      }
      await after();
    } catch (e) {
      notify?.(costApiError(e, 'Could not add that variant'), true);
    } finally {
      setBusy(null);
    }
  }, [after, notify]);

  const onRemoveMember = useCallback(async (g, m) => {
    setBusy(`rm:${g.cost_item_id}`);
    try {
      await removeCostGroupMember(g.cost_item_id, m.variant_id);
      notify?.('Variant unbound — it keeps its own rates.');
      await after();
    } catch (e) {
      notify?.(costApiError(e, 'Could not unbind that variant'), true);
    } finally {
      setBusy(null);
    }
  }, [after, notify]);

  const onDelete = useCallback(async (g) => {
    setBusy(`del:${g.cost_item_id}`);
    try {
      await deleteCostGroup(g.cost_item_id);
      notify?.(`"${g.name}" archived — its variants are unbound and its rate history is kept.`);
      await after();
    } catch (e) {
      notify?.(costApiError(e, 'Could not archive that group'), true);
    } finally {
      setBusy(null);
    }
  }, [after, notify]);

  // The members come from the operator's OWN selection in NewGroupPanel —
  // never from whatever happened to be first on the page.
  const onCreate = useCallback(async (name, members) => {
    setBusy('create');
    try {
      await createCostGroup({ name, members });
      notify?.(`Created "${name}" with ${members.length} variants. It has no cost yet — enter one from any member.`);
      setCreating(false);
      await after();
    } catch (e) {
      notify?.(costApiError(e, 'Could not create that group'), true);
    } finally {
      setBusy(null);
    }
  }, [after, notify]);

  return (
    <div className="space-y-4" data-testid="cost-groups-tab">
      {loadError && (
        <Card className="border-danger/30 bg-danger/5 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {loadError}
        </Card>
      )}

      {/* ── suggestions ── */}
      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent-text" />
              Suggested groups
            </h2>
            <p className="mt-0.5 text-[12px] text-text-muted max-w-[640px]">
              Variants that look like the same good sold in different sizes. Matched on an exact
              product-title match only — never on a partial or similar name, because a wrong
              grouping prices two different products the same.
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="secondary"
              loading={detecting}
              disabled={detecting}
              onClick={runDetect}
              data-testid="cost-groups-detect"
            >
              {!detecting && <RefreshCw className="w-3.5 h-3.5" />}
              {detecting ? 'Detecting…' : 'Find groups'}
            </Button>
          )}
        </div>

        <div className="mt-3 space-y-2">
          {loading && (
            <p className="text-[12px] text-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </p>
          )}
          {!loading && proposals.length === 0 && (
            <p className="text-[12px] text-text-muted">
              No open suggestions. Run &ldquo;Find groups&rdquo; after a detection sweep to look again.
            </p>
          )}
          {proposals.map((p) => (
            <ProposalCard
              key={p.proposal_id}
              proposal={p}
              canEdit={canEdit}
              busy={busy}
              onAccept={onAccept}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      </Card>

      {/* ── groups ── */}
      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Layers className="w-4 h-4 text-accent-text" />
              Cost groups
            </h2>
            <p className="mt-0.5 text-[12px] text-text-muted max-w-[640px]">
              One cost, many variants. A member&rsquo;s own rate always wins over the group&rsquo;s —
              those members are marked, so a group edit that cannot move them is never a surprise.
            </p>
          </div>
          {canEdit && !creating && (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus className="w-3.5 h-3.5" />
              New group
            </Button>
          )}
        </div>

        {creating && (
          <NewGroupPanel
            rows={rows}
            busy={busy}
            onCancel={() => setCreating(false)}
            onCreate={onCreate}
          />
        )}

        <div className="mt-3 space-y-2">
          {loading && (
            <p className="text-[12px] text-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </p>
          )}
          {!loading && groups.length === 0 && (
            <p className="text-[12px] text-text-muted">
              No cost groups yet. Accept a suggestion above, or create one and add its variants.
            </p>
          )}
          {groups.map((g) => (
            <GroupCard
              key={g.cost_item_id}
              group={g}
              rows={rows}
              canEdit={canEdit}
              busy={busy}
              onAddMember={onAddMember}
              onRemoveMember={onRemoveMember}
              onDelete={onDelete}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
