// QuoteScanPanel — upload a supplier quote, read the extracted cost matrix,
// edit it, confirm the rows, apply them (NEW FILE, costs lane).
//
// THE TABLE IS THE POINT. It renders one row per priced line in the order the
// document printed them, with the extracted figure in an editable field and
// the verifier's findings beside it. A number the operator retypes wins over
// the one the model read — and the card says "edited" so the note on the rate
// row records that too.
//
// WHAT CANNOT BE TICKED. A row the verify pass blocked (bad arithmetic, a
// second currency, quarantined text, nothing priced) has its checkbox
// DISABLED with the reason next to it, rather than silently dropped at apply
// time. A row with no chosen variant is likewise not tickable — the operator
// picks from the suggestions or types the id.
//
// THE FILE IS NOT KEPT. It is read into base64, posted, and dropped. The
// server persists the matrix and a sha256 of the bytes, never the document.
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, FileUp, Info, Loader2, Upload,
} from 'lucide-react';
import Button from '../../../components/ui/Button';
import { EM_DASH, formatCost, variantLabel } from '../costTargets';
import {
  MATCH_LABELS, RULE_LABELS, applyPlan, documentFindings, draftErrors,
  isEdited, moneyDraftError, parseMoneyDraft, rowState, selectedProposals, toDrafts,
} from '../quoteMatrix';
import {
  MAX_UPLOAD_BYTES, applyProposals, assistantError, fileToBase64, postQuoteScan, MODELS,
} from '../assistantApi';

export default function QuoteScanPanel({ canEdit, catalogRows, onApplied }) {
  const [file, setFile] = useState(null);
  const [scan, setScan] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const [model, setModel] = useState('claude-fable-5');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const catalogById = useMemo(
    () => new Map((catalogRows || []).map((r) => [String(r.variant_id), r])),
    [catalogRows]
  );

  const pick = useCallback(async (fileList) => {
    const f = Array.from(fileList || [])[0];
    if (!f) return;
    setError('');
    setResult(null);
    try {
      const out = await fileToBase64(f, MAX_UPLOAD_BYTES);
      setFile(out);
    } catch (err) {
      setFile(null);
      setError(err.message);
    }
  }, []);

  const runScan = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await postQuoteScan({ file: file.data, filename: file.name, model });
      setScan(data);
      setDrafts(toDrafts(data.rows));
    } catch (err) {
      setScan(null);
      setDrafts([]);
      setError(assistantError(err));
    } finally {
      setBusy(false);
    }
  }, [file, model]);

  const patch = (rowId, next) => setDrafts((prev) => prev.map((d) => (d.row_id === rowId ? { ...d, ...next } : d)));

  const errors = useMemo(() => draftErrors(drafts), [drafts]);
  const selected = useMemo(() => drafts.filter((d) => d.selected), [drafts]);
  const plan = useMemo(
    () => applyPlan(drafts, catalogById, { scanId: scan?.scan_id }),
    [drafts, catalogById, scan]
  );
  const blockedByError = selected.some((d) => errors[d.row_id]);

  const apply = useCallback(async () => {
    if (!scan || !selected.length) return;
    setApplying(true);
    try {
      const out = await applyProposals({
        proposals: selectedProposals(drafts, { scanId: scan.scan_id }),
        kind: 'quote',
        batch_id: scan.batch_id,
        quote_scan_id: scan.scan_id,
        model: scan.model,
        source_text: `${scan.header?.supplier || 'supplier quote'} ${scan.header?.quote_ref || ''}`.trim(),
      });
      setResult(out);
      setConfirming(false);
      setDrafts((prev) => prev.map((d) => (d.selected ? { ...d, selected: false, applied: true } : d)));
      if (out.applied_count > 0) onApplied?.();
    } catch (err) {
      setError(assistantError(err));
      setConfirming(false);
    } finally {
      setApplying(false);
    }
  }, [scan, selected, drafts, onApplied]);

  const docFindings = documentFindings(scan?.verify);

  return (
    <div className="space-y-4">
      {/* ── upload ─────────────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer?.files); }}
        className={`rounded-xl border border-dashed p-5 text-center transition-colors ${dragging ? 'border-accent bg-bg-hover' : 'border-border-default bg-bg-card'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          className="hidden"
          onChange={(e) => { pick(e.target.files); e.target.value = ''; }}
        />
        <Upload className="w-5 h-5 mx-auto text-text-faint" />
        <p className="mt-2 text-sm text-text-primary">
          {file ? file.name : 'Drop a supplier quote or invoice here'}
        </p>
        <p className="text-[11px] text-text-faint">
          PNG, JPEG, WebP, GIF or PDF · up to {MAX_UPLOAD_BYTES / 1048576} MB.
          The file is read once and never stored — only the extracted table and a checksum are kept.
        </p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={!canEdit}>
            <FileUp className="w-3.5 h-3.5" /> Choose file
          </Button>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model"
            className="bg-bg-elevated border border-border-default rounded-lg px-2 py-1 text-xs text-text-muted cursor-pointer"
          >
            {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <Button size="sm" onClick={runScan} disabled={!file || busy || !canEdit}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {busy ? 'Reading the sheet…' : 'Scan'}
          </Button>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" /> {error}
        </p>
      )}

      {/* ── the matrix ─────────────────────────────────────────────────── */}
      {scan && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-text-muted">
            <span className="text-text-primary font-medium">{scan.header?.supplier || 'Unnamed supplier'}</span>
            {scan.header?.quote_ref && <span>ref {scan.header.quote_ref}</span>}
            {scan.header?.quote_date && <span>{scan.header.quote_date}</span>}
            <span>{scan.header?.currency || 'no currency stated'}</span>
            {scan.header?.incoterm && <span>{scan.header.incoterm}</span>}
            <span className="text-text-faint">{scan.model}</span>
          </div>

          {scan.prior_scans?.length > 0 && (
            <p className="flex items-start gap-2 text-[11px] text-text-muted">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              These exact bytes were scanned before ({scan.prior_scans.length} time(s)) — the newest on{' '}
              {new Date(scan.prior_scans[0].created_at).toLocaleDateString('en-GB')}.
            </p>
          )}

          {docFindings.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 space-y-1">
              {docFindings.map((f, i) => (
                <p key={`${f.rule}-${i}`} className={`text-[11px] ${f.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                  <span className="font-medium">{RULE_LABELS[f.rule] || f.rule}:</span> {f.message}
                </p>
              ))}
            </div>
          )}

          {scan.unreadable?.length > 0 && (
            <p className="text-[11px] text-text-muted">
              Not read: {scan.unreadable.join(' · ')}
            </p>
          )}

          <div className="overflow-x-auto rounded-xl border border-border-default">
            <table className="w-full text-xs">
              <thead className="bg-bg-elevated text-text-muted">
                <tr>
                  <th className="p-2 w-8" aria-label="select" />
                  <th className="p-2 text-left font-medium">On the quote</th>
                  <th className="p-2 text-left font-medium">Qty break</th>
                  <th className="p-2 text-left font-medium">Variant</th>
                  <th className="p-2 text-left font-medium">Unit cost</th>
                  <th className="p-2 text-left font-medium">Shipping / unit</th>
                  <th className="p-2 text-left font-medium">Checks</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const st = rowState(d, scan.verify);
                  const rowErrs = errors[d.row_id] || [];
                  const entry = catalogById.get(String(d.variant_id));
                  return (
                    <tr key={d.row_id} className={`border-t border-border-subtle/60 ${st.blocked ? 'opacity-60' : ''}`}>
                      <td className="p-2 align-top">
                        <input
                          type="checkbox"
                          checked={d.selected}
                          disabled={!st.selectable || !canEdit || rowErrs.length > 0}
                          onChange={(e) => patch(d.row_id, { selected: e.target.checked })}
                          aria-label={`Apply ${d.label}`}
                          className="cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      <td className="p-2 align-top max-w-[220px]">
                        <p className="text-text-primary truncate" title={d.label}>{d.label || EM_DASH}</p>
                        {d.supplier_sku && <p className="text-[10px] text-text-faint">{d.supplier_sku}</p>}
                        {d.notes && <p className="text-[10px] text-text-faint truncate" title={d.notes}>{d.notes}</p>}
                      </td>
                      <td className="p-2 align-top tabular-nums text-text-muted">{d.qty_break ?? EM_DASH}</td>
                      <td className="p-2 align-top min-w-[180px]">
                        <select
                          value={d.variant_id}
                          disabled={!canEdit}
                          onChange={(e) => patch(d.row_id, { variant_id: e.target.value })}
                          className="w-full bg-bg-elevated border border-border-default rounded px-1.5 py-1 text-[11px] text-text-primary cursor-pointer"
                        >
                          <option value="">— pick a variant —</option>
                          {(catalogRows || []).map((r) => (
                            <option key={r.variant_id} value={r.variant_id}>{variantLabel(r)}</option>
                          ))}
                        </select>
                        <p className="text-[10px] text-text-faint mt-0.5">
                          {MATCH_LABELS[d.match_confidence] || d.match_confidence}
                          {entry && entry.unit_cogs !== null && entry.unit_cogs !== undefined
                            ? ` · now ${formatCost(entry.unit_cogs).text}` : ''}
                        </p>
                      </td>
                      <MoneyCell
                        draft={d}
                        field="unit_cost"
                        freeField="unitKnownFree"
                        canEdit={canEdit}
                        demoted={d.unit_cost_demoted}
                        onPatch={(n) => patch(d.row_id, n)}
                        err={rowErrs.find((e) => e.field === 'unit_cost')}
                      />
                      <MoneyCell
                        draft={d}
                        field="shipping"
                        freeField="shipKnownFree"
                        canEdit={canEdit}
                        demoted={d.shipping_demoted}
                        onPatch={(n) => patch(d.row_id, n)}
                        err={rowErrs.find((e) => e.field === 'shipping')}
                      />
                      <td className="p-2 align-top max-w-[240px]">
                        {st.findings.length === 0 && !st.needsVariant && (
                          <span className="text-[10px] text-success">no findings</span>
                        )}
                        {st.needsVariant && (
                          <p className="text-[10px] text-warning">Pick a variant before this can be applied.</p>
                        )}
                        {st.findings.map((f, i) => (
                          <p key={`${f.rule}-${i}`} className={`text-[10px] ${f.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                            {RULE_LABELS[f.rule] || f.rule}: {f.message}
                          </p>
                        ))}
                        {isEdited(d) && <p className="text-[10px] text-text-faint">edited by you</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-text-muted">
              {selected.length} of {drafts.length} row(s) ticked.
              {blockedByError ? ' Fix the highlighted fields first.' : ''}
              {' '}Nothing has been written yet.
            </p>
            {canEdit && (
              <Button size="sm" disabled={!selected.length || blockedByError} onClick={() => setConfirming(true)}>
                Review {selected.length || ''} and apply
              </Button>
            )}
          </div>

          {result && (
            <div className="rounded-lg border border-success/40 bg-success/5 p-2.5">
              <p className="flex items-start gap-2 text-xs text-success">
                <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> {result.summary}
              </p>
              {(result.failed || []).map((f) => (
                <p key={f.index} className="text-[11px] text-danger mt-1">
                  Row {f.index + 1}: {f.code}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── the confirm ────────────────────────────────────────────────── */}
      {confirming && (
        <div className="rounded-xl border border-accent/40 bg-bg-card p-4 space-y-3">
          <p className="text-sm text-text-primary font-medium">
            These {plan.length} rate row(s) will be written
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted">
                <tr>
                  <th className="p-1.5 text-left font-medium">Variant</th>
                  <th className="p-1.5 text-left font-medium">Cost</th>
                  <th className="p-1.5 text-left font-medium">Shipping</th>
                  <th className="p-1.5 text-left font-medium">From the quote</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.row_id} className="border-t border-border-subtle/60">
                    <td className="p-1.5 text-text-primary">{p.label}</td>
                    <td className="p-1.5 tabular-nums">
                      {formatCost(p.current_unit_cogs).text} → <span className="text-text-primary">{p.unit_text}</span>
                    </td>
                    <td className="p-1.5 tabular-nums text-text-primary">{p.ship_text}</td>
                    <td className="p-1.5 text-text-faint">
                      {p.quote_label}{p.qty_break ? ` · qty ${p.qty_break}` : ''}{p.edited ? ' · edited' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-text-muted">
            Each of these appends a new row to the cost history — nothing is overwritten, and a first
            cost for a variant backdates to its first sale so past reports stop showing 100% margin.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" loading={applying} onClick={apply}>Write {plan.length} rate row(s)</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// One editable money field. Blank means UNKNOWN; a real $0.00 requires the
// explicit toggle — the same rule the manual rate drawer enforces.
function MoneyCell({ draft, field, freeField, canEdit, demoted, onPatch, err }) {
  const known = draft[freeField];
  const parsed = parseMoneyDraft(draft[field], { knownFree: known });
  return (
    <td className="p-2 align-top min-w-[130px]">
      <input
        type="text"
        inputMode="decimal"
        value={known ? '0.00' : draft[field]}
        disabled={!canEdit || known}
        onChange={(e) => onPatch({ [field]: e.target.value })}
        placeholder="unknown"
        aria-label={field}
        className={`w-full bg-bg-elevated border rounded px-1.5 py-1 text-[11px] tabular-nums text-text-primary
          ${err ? 'border-danger' : 'border-border-default'}`}
      />
      <label className="mt-0.5 flex items-center gap-1 text-[10px] text-text-faint cursor-pointer">
        <input
          type="checkbox"
          checked={known}
          disabled={!canEdit}
          onChange={(e) => onPatch({ [freeField]: e.target.checked })}
          className="cursor-pointer"
        />
        known free
      </label>
      {err && <p className="text-[10px] text-danger mt-0.5">{moneyDraftError(err.code)}</p>}
      {demoted && (
        <p className="text-[10px] text-warning mt-0.5">
          The model read a 0 here. Recorded as unknown — type it if the sheet really says free.
        </p>
      )}
      {!err && parsed.value === null && !known && (
        <p className="text-[10px] text-text-faint mt-0.5">unknown</p>
      )}
    </td>
  );
}
