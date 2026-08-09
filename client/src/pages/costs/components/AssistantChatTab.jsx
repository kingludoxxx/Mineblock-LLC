// AssistantChatTab — conversational COGS entry (NEW FILE, costs lane).
//
// Each turn is INDEPENDENT: no history is sent, and the catalog is re-read
// server-side every time. That is on purpose — the operator's second message
// is usually a correction of the first, and replaying a stale catalog behind
// it is how a corrected cost lands on the variant the first message picked.
//
// Nothing here writes. The Apply buttons post the confirmed proposals to
// /apply, which re-validates them against a fresh catalog and writes through
// the same append-only door the manual rate form uses.
import { useCallback, useState } from 'react';
import { AlertTriangle, HelpCircle, Info } from 'lucide-react';
import Button from '../../../components/ui/Button';
import AssistantComposer from './AssistantComposer';
import ProposalCard from './ProposalCard';
import ApplyPlanTable from './ApplyPlanTable';
import { chatApplyPlan, chatProposalToWire } from '../quoteMatrix';
import {
  applyProposals, assistantError, dropReason, postChat,
} from '../assistantApi';

let turnSeq = 0;

export default function AssistantChatTab({ canEdit, onApplied }) {
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('claude-fable-5');

  const send = useCallback(async ({ message, images }) => {
    turnSeq += 1;
    const userTurn = { id: `u${turnSeq}`, role: 'user', text: message, imageCount: images.length };
    setTurns((prev) => [...prev, userTurn]);
    setBusy(true);
    try {
      const data = await postChat({ message, images, model });
      turnSeq += 1;
      setTurns((prev) => [...prev, {
        id: `a${turnSeq}`, role: 'assistant', data, sourceText: message, model,
        results: {}, errors: {},
      }]);
    } catch (err) {
      turnSeq += 1;
      setTurns((prev) => [...prev, {
        id: `a${turnSeq}`, role: 'assistant', error: assistantError(err),
      }]);
    } finally {
      setBusy(false);
    }
  }, [model]);

  const applyOne = useCallback(async (turnId, index) => {
    setTurns((prev) => prev.map((t) => (t.id === turnId
      ? { ...t, results: { ...t.results, [index]: 'applying' } } : t)));
    const turn = turns.find((t) => t.id === turnId);
    if (!turn) return;
    const proposal = turn.data.proposals[index];
    try {
      const out = await applyProposals({
        proposals: [chatProposalToWire(proposal)],
        kind: 'chat',
        batch_id: turn.data.batch_id,
        model: turn.model,
        source_text: turn.sourceText,
      });
      // Three outcomes, not two. A SKIP is the server saying "this is already
      // in the ledger" — rendering it as a failure would send the operator
      // looking for a problem that does not exist, and rendering it as a fresh
      // write would claim something happened that did not.
      const failed = (out.failed || [])[0];
      const skipped = (out.skipped || [])[0];
      const status = failed ? 'failed' : skipped ? 'skipped' : 'applied';
      setTurns((prev) => prev.map((t) => (t.id === turnId ? {
        ...t,
        results: { ...t.results, [index]: status },
        errors: failed ? { ...t.errors, [index]: failed.code }
          : skipped ? { ...t.errors, [index]: skipped.reason } : t.errors,
      } : t)));
      if (out.applied_count > 0) onApplied?.();
    } catch (err) {
      setTurns((prev) => prev.map((t) => (t.id === turnId ? {
        ...t,
        results: { ...t.results, [index]: 'failed' },
        errors: { ...t.errors, [index]: err?.response?.data?.error?.code || 'internal_error' },
        applyError: assistantError(err),
      } : t)));
    }
  }, [turns, onApplied]);

  // Apply-all goes through the SAME plan table the quote scan confirms with
  // (review M10) — a bulk write is exactly the case where "apply all 12"
  // hides which twelve.
  const [confirming, setConfirming] = useState(null);

  const applyAll = useCallback(async (turnId) => {
    setConfirming(null);
    const turn = turns.find((t) => t.id === turnId);
    if (!turn) return;
    const pending = turn.data.proposals
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => !p.no_change && turn.results[i] !== 'applied');
    if (!pending.length) return;
    setTurns((prev) => prev.map((t) => (t.id === turnId ? {
      ...t, results: pending.reduce((a, { i }) => ({ ...a, [i]: 'applying' }), { ...t.results }),
    } : t)));
    try {
      const out = await applyProposals({
        proposals: pending.map(({ p }) => chatProposalToWire(p)),
        kind: 'chat',
        batch_id: turn.data.batch_id,
        model: turn.model,
        source_text: turn.sourceText,
      });
      // The server reports failures and skips by the index WITHIN THE LIST WE
      // SENT — map them back onto the card, never assume position equality.
      const failedAt = new Map((out.failed || []).map((f) => [f.index, f.code]));
      const skippedAt = new Map((out.skipped || []).map((s) => [s.index, s.reason]));
      setTurns((prev) => prev.map((t) => {
        if (t.id !== turnId) return t;
        const results = { ...t.results };
        const errors = { ...t.errors };
        pending.forEach(({ i }, sentIdx) => {
          const code = failedAt.get(sentIdx);
          const skip = skippedAt.get(sentIdx);
          results[i] = code ? 'failed' : skip ? 'skipped' : 'applied';
          if (code) errors[i] = code;
          else if (skip) errors[i] = skip;
        });
        return { ...t, results, errors };
      }));
      if (out.applied_count > 0) onApplied?.();
    } catch (err) {
      setTurns((prev) => prev.map((t) => (t.id === turnId
        ? { ...t, applyError: assistantError(err), results: { ...t.results } } : t)));
    }
  }, [turns, onApplied]);

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {turns.length === 0 && (
          <p className="text-sm text-text-muted">
            Describe a cost in your own words and the assistant will match it against your variant
            catalog and propose the rate. It never writes anything — you apply what you agree with.
          </p>
        )}

        {turns.map((turn) => (turn.role === 'user' ? (
          <div key={turn.id} className="flex justify-end">
            <div className="max-w-[80%] rounded-xl bg-bg-elevated border border-border-default px-3 py-2">
              <p className="text-sm text-text-primary whitespace-pre-wrap">{turn.text || <em className="text-text-muted">photo only</em>}</p>
              {turn.imageCount > 0 && (
                <p className="text-[10px] text-text-faint mt-1">{turn.imageCount} image(s) attached</p>
              )}
            </div>
          </div>
        ) : (
          <AssistantTurn
            key={turn.id}
            turn={turn}
            canEdit={canEdit}
            onApply={(i) => applyOne(turn.id, i)}
            onApplyAll={() => setConfirming(turn.id)}
          />
        )))}
      </div>

      {confirming && (() => {
        const turn = turns.find((t) => t.id === confirming);
        if (!turn) return null;
        const pending = turn.data.proposals
          .filter((p, i) => !p.no_change && turn.results[i] !== 'applied');
        return (
          <ApplyPlanTable
            plan={chatApplyPlan(pending)}
            onCancel={() => setConfirming(null)}
            onConfirm={() => applyAll(turn.id)}
            sourceHeading="Why this variant"
          />
        );
      })()}

      <AssistantComposer
        busy={busy}
        model={model}
        onModelChange={setModel}
        onSend={send}
        disabled={!canEdit}
      />
      {!canEdit && (
        <p className="text-[11px] text-text-faint">You have read-only access to costs.</p>
      )}
    </div>
  );
}

function AssistantTurn({ turn, canEdit, onApply, onApplyAll }) {
  if (turn.error) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/5 p-3">
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" /> {turn.error}
        </p>
      </div>
    );
  }
  const d = turn.data;
  const applicable = d.proposals.filter((p) => !p.no_change);
  const allDone = applicable.length > 0
    && applicable.every((p, i) => turn.results[d.proposals.indexOf(p)] === 'applied' || i < 0);

  return (
    <div className="rounded-xl border border-border-default bg-bg-card p-3 space-y-3">
      {d.summary && <p className="text-sm text-text-primary">{d.summary}</p>}

      {d.catalog_truncated && (
        <p className="flex items-start gap-2 text-[11px] text-warning">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          Only the top {d.proposals.length ? '' : ''}{`${d.catalog_count > 300 ? 300 : d.catalog_count}`} variants by
          revenue were shown to the assistant (your catalog has {d.catalog_count}). A variant further
          down the list cannot be proposed from here.
        </p>
      )}

      {d.proposals.length > 0 && (
        <div className="space-y-2">
          {d.proposals.map((p, i) => (
            <ProposalCard
              key={`${p.scope}-${p.variant_id || p.cost_item_id}-${i}`}
              proposal={p}
              status={turn.results[i]}
              error={turn.errors[i]}
              canEdit={canEdit}
              onApply={() => onApply(i)}
            />
          ))}
          {applicable.length > 1 && canEdit && !allDone && (
            <div className="flex justify-end">
              <Button size="sm" onClick={onApplyAll}>Apply all {applicable.length}</Button>
            </div>
          )}
        </div>
      )}

      {d.questions?.length > 0 && (
        <ul className="space-y-1">
          {d.questions.map((q) => (
            <li key={q} className="flex items-start gap-2 text-xs text-text-muted italic">
              <HelpCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> {q}
            </li>
          ))}
        </ul>
      )}

      {d.unmatched?.length > 0 && (
        <p className="text-xs text-text-muted">
          Could not place: {d.unmatched.map((u) => `"${u}"`).join(', ')}
        </p>
      )}

      {d.dropped?.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5">
          <p className="text-[11px] font-medium text-warning mb-1">
            {d.dropped.length} line(s) refused
          </p>
          <ul className="space-y-0.5">
            {d.dropped.map((x) => (
              <li key={`${x.index}-${x.reason}`} className="text-[11px] text-text-muted">
                {x.ref ? `${x.ref}: ` : ''}{dropReason(x.reason)}{x.detail ? ` (${x.detail})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {turn.applyError && (
        <p className="flex items-start gap-2 text-[11px] text-danger">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {turn.applyError}
        </p>
      )}

      <p className="text-[10px] text-text-faint">
        {d.model || 'no model call'}
        {d.usage?.input_tokens ? ` · ${d.usage.input_tokens} in / ${d.usage.output_tokens} out` : ''}
        {' · nothing has been written yet'}
      </p>
    </div>
  );
}
