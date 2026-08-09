// AssistantAuditTab — every batch the assistant has written (NEW FILE, costs
// lane).
//
// A batch row states BOTH instants, because they are routinely months apart:
// when it was written, and what day the rate it wrote applies from. It also
// names the model and the operator's own words, so "why is this cost 4.20"
// resolves to a sentence somebody typed rather than to a machine id.
//
// The empty state and the error state are DELIBERATELY different sentences.
// On a page about trusting numbers, "nothing has been written yet" and "we
// could not read the history" must not look the same.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { EM_DASH, fmtDateTime, formatCost } from '../costTargets';
import { assistantError, fetchAudit } from '../assistantApi';

const KINDS = [
  { value: '', label: 'All' },
  { value: 'chat', label: 'Chat' },
  { value: 'quote', label: 'Quote scan' },
];

export default function AssistantAuditTab({ reloadKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchAudit({ limit: 100, ...(kind ? { kind } : {}) });
      setRows(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(assistantError(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load, reloadKey]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={`px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors ${
                kind === k.value
                  ? 'bg-bg-elevated text-text-primary border border-border-default'
                  : 'text-text-muted hover:text-text-primary border border-transparent'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading the history…
        </p>
      )}

      {!loading && error && (
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" /> Could not read the write history. {error}
        </p>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-text-muted">The assistant has not written a cost yet.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <p className="text-[11px] text-text-faint">{total} batch(es)</p>
          <ul className="space-y-2">
            {rows.map((r) => <AuditRow key={r.id} row={r} />)}
          </ul>
        </>
      )}
    </div>
  );
}

function AuditRow({ row }) {
  const applied = Array.isArray(row.applied) ? row.applied : [];
  return (
    <li className="rounded-lg border border-border-default bg-bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text-primary">
            {row.applied_count} rate row(s) written
            {row.rejected_count > 0 ? ` · ${row.rejected_count} refused` : ''}
          </p>
          <p className="text-[11px] text-text-faint truncate">
            {row.created_by || EM_DASH} · {fmtDateTime(row.created_at)} · {row.kind}
            {row.model ? ` · ${row.model}` : ''}
            {row.quote_scan_id ? ` · scan ${row.quote_scan_id}` : ''}
          </p>
        </div>
        <span className="text-[10px] text-text-faint font-mono shrink-0">{row.batch_id}</span>
      </div>

      {row.source_text && (
        <p className="mt-1.5 text-[11px] text-text-muted italic">&ldquo;{row.source_text}&rdquo;</p>
      )}

      {applied.length > 0 && (
        <ul className="mt-2 space-y-1">
          {applied.map((a) => (
            <li key={a.rate_id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <span className="font-mono text-text-muted">{a.variant_id || a.cost_item_id}</span>
              <span className="tabular-nums text-text-primary">{formatCost(a.unit_cogs).text}</span>
              {a.ship && Object.entries(a.ship).some(([, v]) => v !== null && v !== undefined) && (
                <span className="text-text-muted">
                  ship {Object.entries(a.ship)
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([k, v]) => `${k} ${formatCost(v).text}`).join(', ')}
                </span>
              )}
              <span className="text-text-faint">applies from {a.effective_from}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[10px] text-text-faint">
        Written {fmtDateTime(row.created_at)}
        {applied[0]?.effective_from ? ` · applies from ${applied[0].effective_from}` : ''}
      </p>
    </li>
  );
}
