// ProposalCard — one proposed rate, and what applying it would change
// (NEW FILE, costs lane).
//
// The card shows BEFORE → AFTER per field, not just the number being
// proposed. "$4.20" tells the operator nothing; "$3.90 → $4.20" is the thing
// they can actually check. A proposal whose values equal what is already in
// force says so and offers no apply button — appending it would add a
// duplicate row to an append-only ledger.
//
// The model's confidence is DISPLAYED and nothing more. It never gates the
// button, never sorts, never pre-selects. A number the model wrote about its
// own reliability is evidence for the operator, not authority over the write.
import { AlertTriangle, ArrowRight, Check, Loader2, MinusCircle } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { EM_DASH, formatCost } from '../costTargets';
import { confidenceText, proposalChanges } from '../quoteMatrix';
import { applyFailure, skipReason } from '../assistantApi';

export default function ProposalCard({ proposal, status, error, canEdit, onApply }) {
  const changes = proposalChanges(proposal);
  const label = [proposal.product_title, proposal.variant_title].filter(Boolean).join(' — ')
    || proposal.variant_id || proposal.cost_item_id || EM_DASH;
  const applied = status === 'applied';
  const failed = status === 'failed';
  // A SKIP is not a failure. The server refused to append a row because the
  // value is already in the ledger — from an earlier click on this same card,
  // or because it is already the cost in force. Shown as its own state so it
  // reads as "nothing to do", not as "something went wrong".
  const skipped = status === 'skipped';
  const settled = applied || failed || skipped;

  const border = failed ? 'border-danger/40 bg-danger/5'
    : applied ? 'border-success/40 bg-success/5'
      : skipped ? 'border-border-strong bg-bg-elevated'
        : 'border-border-default bg-bg-elevated';

  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text-primary truncate">{label}</p>
          <p className="text-[11px] text-text-faint truncate">
            {proposal.variant_id || proposal.cost_item_id}
            {proposal.price !== null && proposal.price !== undefined ? ` · sells at ${formatCost(proposal.price).text}` : ''}
            {' · '}{confidenceText(proposal.confidence)}
          </p>
        </div>
        {!settled && canEdit && !proposal.no_change && (
          <Button size="sm" variant="secondary" onClick={onApply} loading={status === 'applying'}>
            {status === 'applying' ? null : <Check className="w-3.5 h-3.5" />} Apply
          </Button>
        )}
        {applied && (
          <span className="inline-flex items-center gap-1 text-[11px] text-success shrink-0">
            <Check className="w-3.5 h-3.5" /> applied
          </span>
        )}
        {skipped && (
          <span className="inline-flex items-center gap-1 text-[11px] text-text-muted shrink-0">
            <MinusCircle className="w-3.5 h-3.5" /> no write needed
          </span>
        )}
        {status === 'applying' && <Loader2 className="w-4 h-4 animate-spin text-text-muted shrink-0" />}
      </div>

      {proposal.reason && (
        <p className="mt-1.5 text-[11px] text-text-muted italic">{proposal.reason}</p>
      )}

      {proposal.no_change ? (
        <p className="mt-2 text-[11px] text-text-muted">
          This is already the cost in force — applying it would only add a duplicate row to the history.
        </p>
      ) : changes.length === 0 ? (
        <p className="mt-2 text-[11px] text-text-muted">No visible change to the resolved cost.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {changes.map((c) => (
            <li key={c.field} className="flex items-center gap-2 text-xs">
              <span className="text-text-muted w-[132px] shrink-0">{c.field}</span>
              <span className="tabular-nums text-text-muted">{c.before}</span>
              <ArrowRight className="w-3 h-3 text-text-faint" />
              <span className="tabular-nums text-text-primary font-medium">{c.after}</span>
            </li>
          ))}
        </ul>
      )}

      {(proposal.carried_cogs || (proposal.carried_ship || []).length > 0) && (
        <p className="mt-2 text-[11px] text-text-faint">
          Carried forward so this row does not erase them:
          {proposal.carried_cogs ? ' cost' : ''}
          {proposal.carried_cogs && (proposal.carried_ship || []).length ? ',' : ''}
          {(proposal.carried_ship || []).map((s) => ` shipping (${s.context})`).join(',')}
          . A rate row replaces what is in force from its date — it is not a patch.
        </p>
      )}

      {failed && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-danger">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          Not applied — {applyFailure(error)}.
        </p>
      )}

      {skipped && (
        <p className="mt-2 text-[11px] text-text-muted">
          Nothing written — {skipReason(error)}.
        </p>
      )}
    </div>
  );
}
