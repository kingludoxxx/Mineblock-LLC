import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Loader2, Sparkles, Check, RotateCcw, AlertTriangle, Pencil,
} from 'lucide-react';
import api from '../../../services/api';

/**
 * EditImageModal — operator-driven inline image editing via OpenAI gpt-image-2.
 *
 * Big centered modal (matches CreativeDetailModalV2 family). Side-by-side
 * Original vs Edited preview. Operator types a freeform prompt; Generate
 * fires /creatives/:id/edit (pending result stored on backend). Accept
 * promotes the pending edit to live + cascades 4:5/9:16 regeneration.
 *
 * Status gate: backend rejects with 409 if creative.status !== 'review'.
 */
export function EditImageModal({ creative, isOpen, onClose, onAccepted }) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [pendingUrl, setPendingUrl] = useState(creative?.pending_edit_url || null);
  const [editToken, setEditToken] = useState(creative?.pending_edit_token || null);
  const [error, setError] = useState(null);
  const [accepting, setAccepting] = useState(false);

  // Reset state when modal opens for a new creative
  useEffect(() => {
    if (isOpen && creative) {
      setPrompt('');
      setPendingUrl(creative.pending_edit_url || null);
      setEditToken(creative.pending_edit_token || null);
      setError(null);
      setGenerating(false);
      setAccepting(false);
    }
  }, [isOpen, creative?.id, creative?.pending_edit_url, creative?.pending_edit_token]);

  // Close on Escape (only when nothing is in flight)
  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => { if (e.key === 'Escape' && !generating && !accepting) onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen, onClose, generating, accepting]);

  const handleGenerate = useCallback(async () => {
    const p = prompt.trim();
    if (!p) { setError('Describe what you want to change'); return; }
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const { data } = await api.post(
        `/statics-generation/creatives/${creative.id}/edit`,
        { prompt: p }
      );
      const result = data?.data || data;
      setPendingUrl(result.pending_edit_url);
      setEditToken(result.edit_token);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setGenerating(false);
    }
  }, [prompt, generating, creative?.id]);

  const handleAccept = useCallback(async () => {
    if (accepting || !pendingUrl) return;
    setAccepting(true);
    setError(null);
    try {
      const { data } = await api.post(
        `/statics-generation/creatives/${creative.id}/edit/accept`,
        { edit_token: editToken }
      );
      const result = data?.data || data;
      onAccepted?.(result);
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
      setAccepting(false);
    }
  }, [accepting, pendingUrl, editToken, creative?.id, onAccepted, onClose]);

  const handleDiscard = useCallback(async () => {
    if (generating || accepting) return;
    try {
      if (pendingUrl) {
        await api.post(`/statics-generation/creatives/${creative.id}/edit/discard`).catch(() => {});
      }
    } finally {
      onClose?.();
    }
  }, [generating, accepting, pendingUrl, creative?.id, onClose]);

  const handleTryAgain = useCallback(() => {
    setPendingUrl(null);
    setEditToken(null);
    setError(null);
    // Keep the prompt so operator can tweak it
  }, []);

  if (!isOpen || !creative) return null;

  const originalUrl = creative.image_url;
  const title = creative.angle || creative.product_name || 'Creative';

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
      onClick={() => { if (!generating && !accepting) handleDiscard(); }}
    >
      <div
        className="relative bg-zinc-950 border border-white/[0.08] rounded-xl max-w-[1280px] w-full max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <Pencil className="w-4 h-4 text-fuchsia-400 shrink-0" />
            <h3 className="text-sm font-mono text-white truncate" title={title}>
              Edit Image: {title}
            </h3>
            {creative.id && (
              <span className="text-[10px] font-mono text-zinc-600">{creative.id.slice(0, 12)}…</span>
            )}
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase tracking-wide">
              In Review
            </span>
          </div>
          <button
            type="button"
            onClick={handleDiscard}
            disabled={generating || accepting}
            className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/30 text-xs text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {String(error)}
          </div>
        )}

        {/* Body — side-by-side comparison */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-2 gap-5">
          {/* Original */}
          <div className="flex flex-col">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-2">Original</div>
            <div className="flex-1 bg-black/40 border border-white/[0.06] rounded-lg overflow-hidden flex items-center justify-center min-h-[300px]">
              {originalUrl ? (
                <img src={originalUrl} alt="Original" className="max-w-full max-h-[60vh] object-contain" />
              ) : (
                <div className="text-zinc-600 text-xs">No image</div>
              )}
            </div>
          </div>

          {/* Edited preview */}
          <div className="flex flex-col">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-2">
              {pendingUrl ? 'Edited Preview' : (generating ? 'Generating…' : 'Edited Preview (none yet)')}
            </div>
            <div className="flex-1 bg-black/40 border border-white/[0.06] rounded-lg overflow-hidden flex items-center justify-center min-h-[300px] relative">
              {generating && (
                <div className="flex flex-col items-center gap-2 text-zinc-500">
                  <Loader2 className="w-6 h-6 animate-spin text-fuchsia-400" />
                  <span className="text-[10px] font-mono">~20-40s</span>
                </div>
              )}
              {!generating && pendingUrl && (
                <img src={pendingUrl} alt="Edited preview" className="max-w-full max-h-[60vh] object-contain" />
              )}
              {!generating && !pendingUrl && (
                <div className="text-zinc-600 text-xs text-center px-6">
                  Type an instruction below and click Generate to preview an edit.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Prompt + actions */}
        <div className="border-t border-white/[0.06] px-5 py-3 shrink-0 space-y-3">
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 block mb-1.5">
              Describe the change
            </label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !generating && !accepting) handleGenerate(); }}
              placeholder='e.g. "Change the background to navy blue" or "Make the CTA button red"'
              disabled={generating || accepting}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-fuchsia-500/50 transition-colors disabled:opacity-50"
              autoFocus
            />
          </div>

          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={generating || accepting}
              className="px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wide text-zinc-400 hover:text-white hover:bg-white/[0.05] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>

            {pendingUrl && !generating && (
              <button
                type="button"
                onClick={handleTryAgain}
                disabled={accepting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wide border border-white/[0.1] text-zinc-300 hover:bg-white/[0.05] cursor-pointer disabled:opacity-40"
                title="Discard this preview and try a different prompt"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Try Again
              </button>
            )}

            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || accepting || !prompt.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-mono font-semibold uppercase tracking-wide bg-fuchsia-500/15 hover:bg-fuchsia-500/25 text-fuchsia-300 border border-fuchsia-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {generating
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
                : <><Sparkles className="w-3.5 h-3.5" /> {pendingUrl ? 'Regenerate' : 'Generate'}</>}
            </button>

            {pendingUrl && (
              <button
                type="button"
                onClick={handleAccept}
                disabled={generating || accepting}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-mono font-semibold uppercase tracking-wide bg-emerald-500/90 hover:bg-emerald-500 text-black cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="Replace the live image + regenerate 4:5 and 9:16"
              >
                {accepting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Accepting…</>
                  : <><Check className="w-3.5 h-3.5" /> Accept</>}
              </button>
            )}
          </div>

          {pendingUrl && (
            <div className="text-[10px] font-mono text-zinc-500 text-right">
              Accept replaces the 1:1 + regenerates 4:5 and 9:16 from the edited version.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default EditImageModal;
