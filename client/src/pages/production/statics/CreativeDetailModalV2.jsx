import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  X, Download, Trash2, Loader2, CheckCircle2, RefreshCw, ArrowLeft, Sparkles, AlertTriangle, Pencil,
} from 'lucide-react';
import api from '../../../services/api';
import { EditImageModal } from './EditImageModal';

const RATIOS = ['1:1', '4:5', '9:16'];

/**
 * Statics-pipeline-v2 detail modal.
 *
 * Three columns side-by-side, one per ratio (1:1 / 4:5 / 9:16). Each column:
 *   - Image (or placeholder)
 *   - Download, Delete
 *   - Refine textarea (Claude+NB, persists to iteration_history JSONB)
 *   - Regenerate icon (re-fires last refine)
 *   - Horizontal carousel of previous iterations (up to 6)
 *   - Per-ratio Approve button
 *
 * Top-right "Approve all" approves the parent + all children in one click.
 *
 * Backend integration:
 *   - POST /creatives/:id/ai-adjust  (refine — already wraps Claude+NB+R2)
 *   - POST /creatives/:id/approve    (new Phase B endpoint, parent-wide)
 *   - GET  /creatives/:id/iterations (new Phase B endpoint)
 *   - DELETE /creatives/:id          (single ratio)
 */
export function CreativeDetailModalV2({
  parent,
  allCreatives,
  isOpen,
  onClose,
  onRefresh,
}) {
  // Resolve the three ratios from the creative tree. The clicked row
  // (`parent` prop) may be the actual 1:1 parent OR a child (e.g. a
  // launched 9:16 rendered separately). Either way, walk to the true
  // parent first, then collect parent + children into ratioMap.
  const ratioMap = useMemo(() => {
    if (!parent) return { trueParent: null };
    const arr = Array.isArray(allCreatives) ? allCreatives : [];
    // Walk up: if parent has parent_creative_id, find the actual parent row.
    let root = parent;
    if (parent.parent_creative_id) {
      const found = arr.find((c) => c.id === parent.parent_creative_id);
      if (found) root = found;
    }
    const map = { trueParent: root };
    const rootRatio = root.aspect_ratio || '1:1';
    map[rootRatio] = root;
    for (const c of arr) {
      if (c.parent_creative_id === root.id && c.aspect_ratio) {
        map[c.aspect_ratio] = c;
      }
    }
    return map;
  }, [parent, allCreatives]);

  const trueParent = ratioMap.trueParent || parent;

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen, onClose]);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(null);
  const [deletingCard, setDeletingCard] = useState(false);
  const [deleteCardError, setDeleteCardError] = useState(null);
  // editTarget = the 1:1 parent being edited (always the 1:1 — cascade
  // regenerates 4:5 + 9:16 from edited 1:1). null = modal closed.
  const [editTarget, setEditTarget] = useState(null);

  const handleApproveAll = useCallback(async () => {
    if (!trueParent || approving) return;
    setApproving(true);
    setApproveError(null);
    try {
      await api.post(`/statics-generation/creatives/${trueParent.id}/approve`);
      onRefresh?.();
      onClose?.();
    } catch (err) {
      setApproveError(err.response?.data?.error?.message || err.message);
    } finally {
      setApproving(false);
    }
  }, [trueParent, approving, onRefresh, onClose]);

  // Whole-card delete — DELETE /creatives/:parentId cascades to all children
  // (1:1 + 4:5 + 9:16 all removed in one transaction on the backend).
  const handleDeleteCard = useCallback(async () => {
    if (!trueParent || deletingCard) return;
    const ratiosFound = ['1:1','4:5','9:16'].filter(r => ratioMap[r]).length;
    const ok = window.confirm(
      `Delete this entire card?\n\n"${trueParent.angle || trueParent.product_name || 'Creative'}"\n${ratiosFound} ratio${ratiosFound === 1 ? '' : 's'} will be removed. This cannot be undone.`
    );
    if (!ok) return;
    setDeletingCard(true);
    setDeleteCardError(null);
    try {
      await api.delete(`/statics-generation/creatives/${trueParent.id}`);
      onRefresh?.();
      onClose?.();
    } catch (err) {
      setDeleteCardError(err.response?.data?.error?.message || err.message);
    } finally {
      setDeletingCard(false);
    }
  }, [trueParent, deletingCard, ratioMap, onRefresh, onClose]);

  if (!isOpen || !parent) return null;

  const title = trueParent.angle || trueParent.product_name || 'Creative';
  const shortId = trueParent.id ? trueParent.id.slice(0, 12) + '…' : '';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6" onClick={onClose}>
      <div
        className="relative bg-zinc-950 border border-white/[0.08] rounded-xl max-w-[1280px] w-full max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer"
              title="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h3 className="text-sm font-mono text-white truncate" title={title}>{title}</h3>
            {shortId && (
              <span className="text-[10px] font-mono text-zinc-600">{shortId}</span>
            )}
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase tracking-wide">
              In Review
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDeleteCard}
              disabled={deletingCard || approving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50"
              title="Delete this entire card (all ratios) — cannot be undone"
            >
              {deletingCard
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Deleting…</>
                : <><Trash2 className="w-3.5 h-3.5" /> Delete card</>}
            </button>
            {/* Edit Image — opens OpenAI gpt-image-2 editor on the 1:1 parent.
                Only available in Review (operator rule). Accept cascades 4:5/9:16. */}
            {trueParent?.status === 'review' && trueParent?.image_url && (
              <button
                type="button"
                onClick={() => setEditTarget(trueParent)}
                disabled={approving || deletingCard}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-fuchsia-500/40 text-fuchsia-300 hover:bg-fuchsia-500/15 text-xs font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50"
                title="Edit this image with AI (OpenAI gpt-image-2)"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit Image
              </button>
            )}
            <button
              type="button"
              onClick={handleApproveAll}
              disabled={approving || deletingCard}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-black text-xs font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50"
              title="Approve all 3 ratios — moves to Ready to Launch"
            >
              {approving
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Approving…</>
                : <><CheckCircle2 className="w-3.5 h-3.5" /> Approve</>}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {approveError && (
          <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/30 text-xs text-red-300">
            {approveError}
          </div>
        )}
        {deleteCardError && (
          <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/30 text-xs text-red-300">
            {deleteCardError}
          </div>
        )}

        {/* 3-column body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-3 gap-5">
            {RATIOS.map((ratio) => (
              <RatioColumn
                key={ratio}
                ratio={ratio}
                creative={ratioMap[ratio] || null}
                parentId={trueParent.id}
                parentReviewNotes={trueParent.review_notes}
                onRefresh={onRefresh}
                onAfterDelete={onRefresh}
                onApproved={() => { onRefresh?.(); onClose?.(); }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Edit Image — opens nested over this modal. When accepted, parent
          board refreshes + this modal closes (cascade runs in background). */}
      {editTarget && (
        <EditImageModal
          key={editTarget.id}
          creative={editTarget}
          isOpen={true}
          onClose={() => setEditTarget(null)}
          onAccepted={() => {
            setEditTarget(null);
            onRefresh?.();
            onClose?.();
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Single-ratio column
 * -------------------------------------------------------------------------- */

function RatioColumn({ ratio, creative, parentId, parentReviewNotes, onRefresh, onAfterDelete, onApproved }) {
  const [refineInput, setRefineInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [iterations, setIterations] = useState([]);
  const [loadingIters, setLoadingIters] = useState(false);
  const abortRef = useRef(false);

  useEffect(() => () => { abortRef.current = true; }, []);

  const fetchIterations = useCallback(async () => {
    if (!creative?.id) { setIterations([]); return; }
    setLoadingIters(true);
    try {
      const { data } = await api.get(`/statics-generation/creatives/${creative.id}/iterations`);
      if (abortRef.current) return;
      setIterations(data?.data?.iterations || []);
    } catch {
      if (!abortRef.current) setIterations([]);
    } finally {
      if (!abortRef.current) setLoadingIters(false);
    }
  }, [creative?.id]);

  useEffect(() => { fetchIterations(); }, [fetchIterations]);

  const handleRefine = async () => {
    if (!creative?.id || !refineInput.trim() || refining) return;
    setRefining(true);
    setRefineError(null);
    try {
      await api.post(`/statics-generation/creatives/${creative.id}/ai-adjust`, {
        correction: refineInput.trim(),
      });
      // Poll for updated image — same pattern as the legacy modal.
      const originalUrl = creative.image_url;
      for (let i = 0; i < 40; i++) {
        if (abortRef.current) return;
        await new Promise((r) => setTimeout(r, 5000));
        if (abortRef.current) return;
        try {
          const { data } = await api.get(`/statics-generation/creatives/${creative.id}`);
          const updated = data?.data || data;
          if (updated?.image_url && updated.image_url !== originalUrl) {
            setRefineInput('');
            onRefresh?.();
            fetchIterations();
            break;
          }
          if (updated?.review_notes?.startsWith('AI adjustment failed')) {
            throw new Error(updated.review_notes);
          }
        } catch (e) {
          if (e.message?.includes('AI adjustment failed')) throw e;
        }
      }
    } catch (err) {
      setRefineError(err.response?.data?.error?.message || err.message);
    } finally {
      if (!abortRef.current) setRefining(false);
    }
  };

  const handleDelete = async () => {
    if (!creative?.id || deleting) return;
    if (!window.confirm(`Delete the ${ratio} version?`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/statics-generation/creatives/${creative.id}`);
      onAfterDelete?.();
    } catch (err) {
      setDeleteError(err.response?.data?.error?.message || err.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleDownload = () => {
    if (!creative?.image_url) return;
    const a = document.createElement('a');
    a.href = creative.image_url;
    a.download = `${creative.id}-${ratio}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleApprove = async () => {
    if (!creative?.id || approving) return;
    setApproving(true);
    setApproveError(null);
    try {
      // Backend resolves child → parent + approves the whole tree.
      // Per-ratio approve = full-card approve (intentional — the operator
      // shouldn't need to approve each ratio separately).
      await api.post(`/statics-generation/creatives/${creative.id}/approve`);
      onApproved?.();
    } catch (err) {
      setApproveError(err.response?.data?.error?.message || err.message);
    } finally {
      setApproving(false);
    }
  };

  const isMissing = !creative;

  // Generate this missing ratio from the 1:1 parent. The backend's
  // /create-variant endpoint resizes the parent via NanoBanana (same path
  // the initial 3-ratio fan-out uses) and inserts a child row with
  // parent_creative_id=parentId. Then we poll until the row appears with
  // a non-null image_url so the modal can re-render with the new variant.
  const handleGenerateMissing = async () => {
    if (!parentId || generating || ratio === '1:1') return;
    setGenerating(true);
    setGenerateError(null);
    try {
      await api.post(`/statics-generation/creatives/${parentId}/create-variant`, {
        aspect_ratio: ratio,
      });
      // Poll for the new variant to land. The backend's pollNanoBanana
      // usually completes in 30-90s; cap at ~5 min.
      for (let i = 0; i < 60; i++) {
        if (abortRef.current) return;
        await new Promise((r) => setTimeout(r, 5000));
        if (abortRef.current) return;
        try {
          const { data } = await api.get(`/statics-generation/creatives?parent_creative_id=${parentId}`);
          const children = data?.data || [];
          const found = children.find((c) => c.aspect_ratio === ratio && c.image_url);
          if (found) {
            onRefresh?.();
            return;
          }
          // Surface backend's recorded failure note if it gave up.
          const failed = children.find((c) => c.aspect_ratio === ratio && c.review_notes?.includes('Variant resize failed'));
          if (failed) throw new Error(failed.review_notes);
        } catch (e) {
          if (e.message?.includes('Variant resize failed')) throw e;
        }
      }
      throw new Error(`Timed out waiting for ${ratio} variant`);
    } catch (err) {
      setGenerateError(err.response?.data?.error?.message || err.message);
    } finally {
      if (!abortRef.current) setGenerating(false);
    }
  };

  return (
    <div className="flex flex-col bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
      {/* Image preview */}
      <div className="relative bg-black/40 aspect-square flex items-center justify-center p-4">
        {isMissing ? (
          <div className="flex flex-col items-center gap-3 text-center max-w-[80%]">
            <div className="flex items-center gap-1.5 text-amber-300/80">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-[11px] font-mono">No {ratio} variant</span>
            </div>
            <div className="text-[10px] text-zinc-500 leading-relaxed">
              The {ratio} generation didn't complete on the first pass. NanoBanana usually flakes ~1 in 30 ratios. Click to generate it now from the 1:1 parent.
            </div>
            {ratio !== '1:1' ? (
              <button
                type="button"
                onClick={handleGenerateMissing}
                disabled={!parentId || generating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 border border-violet-400/40 hover:bg-violet-500/30 text-violet-200 text-[11px] font-mono font-semibold uppercase tracking-wide cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={`Resize the 1:1 parent into ${ratio} via NanoBanana`}
              >
                {generating
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
                  : <><Sparkles className="w-3.5 h-3.5" /> Generate {ratio}</>}
              </button>
            ) : (
              <div className="text-[10px] text-zinc-600 italic">
                The 1:1 parent is the root — if it failed, re-run the whole creative from the Reference column.
              </div>
            )}
            {generateError && <div className="text-[10px] text-red-400 leading-tight">{generateError}</div>}
          </div>
        ) : creative.image_url ? (
          <img
            src={creative.image_url}
            alt={ratio}
            loading="lazy"
            decoding="async"
            className="max-w-full max-h-full object-contain"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-violet-300/70">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-[10px] font-mono">Generating…</span>
          </div>
        )}
      </div>

      {/* Ratio badge + utility row */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/[0.05]">
        <span className="text-[11px] font-mono font-bold text-zinc-300">{ratio}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleDownload}
            disabled={!creative?.image_url}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08] text-[10px] font-mono cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Download"
          >
            <Download className="w-3 h-3" /> Download
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!creative?.id || deleting}
            className="p-1.5 rounded-md bg-white/[0.04] border border-white/[0.08] text-red-300 hover:bg-red-500/20 hover:border-red-400/40 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Delete this ratio"
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          </button>
        </div>
      </div>
      {deleteError && <div className="px-3 pb-1 text-[10px] text-red-400">{deleteError}</div>}

      {/* Refine input + regenerate */}
      <div className="px-3 py-2 border-t border-white/[0.05] space-y-2">
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={refineInput}
            onChange={(e) => setRefineInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !refining) handleRefine(); }}
            placeholder="Refine this version…"
            disabled={!creative?.id || refining}
            className="flex-1 px-2.5 py-1.5 rounded-md bg-white/[0.04] border border-white/[0.08] text-zinc-200 placeholder:text-zinc-600 text-[11px] font-mono focus:outline-none focus:border-violet-400/40 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleRefine}
            disabled={!creative?.id || !refineInput.trim() || refining}
            className="shrink-0 px-2 rounded-md bg-amber-500/15 border border-amber-400/30 text-amber-300 hover:bg-amber-500/25 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Regenerate with this instruction"
          >
            {refining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
        {refineError && <div className="text-[10px] text-red-400">{refineError}</div>}
      </div>

      {/* Iteration carousel */}
      <div className="px-3 py-2 border-t border-white/[0.05]">
        <div className="text-[9px] font-mono text-zinc-600 uppercase tracking-wide mb-1.5">
          Previous {iterations.length > 0 ? `(${iterations.length})` : ''}
        </div>
        {loadingIters ? (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />
          </div>
        ) : iterations.length === 0 ? (
          <div className="text-[10px] text-zinc-700 italic">No prior versions yet</div>
        ) : (
          <div className="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar">
            {iterations.slice().reverse().map((it, idx) => (
              <div
                key={idx}
                className="shrink-0 w-12 h-12 rounded-md border border-white/[0.08] bg-black/30 overflow-hidden"
                title={it.refine_instruction || ''}
              >
                {it.image_url ? (
                  <img
                    src={it.image_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                    onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-ratio Approve */}
      <div className="px-3 pb-3 pt-2 border-t border-white/[0.05]">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!creative?.id || approving}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-black text-[11px] font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {approving
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Approving…</>
            : <><CheckCircle2 className="w-3.5 h-3.5" /> Approve</>}
        </button>
        {approveError && <div className="mt-1.5 text-[10px] text-red-400">{approveError}</div>}
      </div>
    </div>
  );
}

export default CreativeDetailModalV2;
