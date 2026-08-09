// ApplyPlanTable — the confirm, shared by both apply paths (NEW FILE, costs
// lane; extracted from QuoteScanPanel for review M10).
//
// "Apply 12 proposals?" is not a confirm. This spells out every rate row that
// will be written, the variant it lands on, and what happens to EACH FIELD:
//
//   set      a value is written
//   kept     the field was left blank, so the value already in force is
//            CARRIED onto the new row. Said out loud because a rate row
//            REPLACES what came before it — a blank that was not carried
//            would erase a real cost, which is exactly the bug this wording
//            exists to make impossible to ship again.
//   cleared  the operator asked to remove it. A null IS written and the field
//            becomes unknown. Rendered RED, and the footer counts it, because
//            clearing a cost withholds profit for every leg that used it.
//   unknown  it was not known before and is not known now.
//
// Both callers pass the same row shape (quoteMatrix.applyPlan for the scan
// table, quoteMatrix.chatApplyPlan for the assistant's Apply-all), so the two
// confirms cannot drift apart.
import { AlertTriangle } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { EM_DASH, formatCost } from '../costTargets';

const OUTCOME_STYLE = {
  set: 'text-text-primary',
  kept: 'text-text-muted',
  cleared: 'text-danger font-medium',
  unknown: 'text-text-faint',
};

function FieldCell({ outcome, before, after }) {
  const cls = OUTCOME_STYLE[outcome] || OUTCOME_STYLE.unknown;
  if (outcome === 'cleared') {
    return (
      <td className="p-1.5 tabular-nums">
        <span className="text-text-muted">{formatCost(before).text}</span>
        {' → '}
        <span className={cls}>cleared</span>
      </td>
    );
  }
  if (outcome === 'kept') {
    return (
      <td className="p-1.5 tabular-nums">
        <span className={cls}>{formatCost(before).text} kept</span>
      </td>
    );
  }
  if (outcome === 'unknown') {
    return <td className={`p-1.5 tabular-nums ${cls}`}>{EM_DASH}</td>;
  }
  return (
    <td className="p-1.5 tabular-nums">
      <span className="text-text-muted">{formatCost(before).text}</span>
      {' → '}
      <span className={cls}>{formatCost(after).text}</span>
    </td>
  );
}

export default function ApplyPlanTable({
  plan, busy, onCancel, onConfirm, confirmLabel, sourceHeading = 'From the quote',
}) {
  const destructive = plan.filter((p) => p.destructive);

  return (
    <div className={`rounded-xl border p-4 space-y-3 bg-bg-card ${destructive.length ? 'border-danger/50' : 'border-accent/40'}`}>
      <p className="text-sm text-text-primary font-medium">
        These {plan.length} rate row(s) will be written
      </p>

      {destructive.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          {destructive.length} of them CLEAR a value that is currently set. Those legs will report
          no profit until a cost is entered again.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-text-muted">
            <tr>
              <th className="p-1.5 text-left font-medium">Variant</th>
              <th className="p-1.5 text-left font-medium">Cost</th>
              <th className="p-1.5 text-left font-medium">Shipping</th>
              <th className="p-1.5 text-left font-medium">{sourceHeading}</th>
            </tr>
          </thead>
          <tbody>
            {plan.map((p) => (
              <tr
                key={p.row_id}
                className={`border-t border-border-subtle/60 ${p.destructive ? 'bg-danger/5' : ''}`}
              >
                <td className="p-1.5 text-text-primary">{p.label}</td>
                <FieldCell outcome={p.cogs_outcome} before={p.current_unit_cogs} after={p.unit_cogs} />
                <FieldCell outcome={p.ship_outcome} before={p.current_ship} after={p.ship} />
                <td className="p-1.5 text-text-faint">
                  {p.quote_label}
                  {p.qty_break ? ` · qty ${p.qty_break}` : ''}
                  {p.edited ? ' · edited' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-text-muted">
        Each of these appends a new row to the cost history — nothing is overwritten in place, and a
        first cost for a variant backdates to its first sale so past reports stop showing 100% margin.
        A field marked &ldquo;kept&rdquo; is copied onto the new row so it is not lost.
      </p>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          variant={destructive.length ? 'danger' : 'primary'}
          loading={busy}
          onClick={onConfirm}
        >
          {confirmLabel || `Write ${plan.length} rate row(s)`}
        </Button>
      </div>
    </div>
  );
}
