import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Loader2, Send, CheckCircle2, MousePointer2,
  Pencil, AlertTriangle, RotateCcw,
} from 'lucide-react';
import api from '../../../services/api';

/**
 * EditImageEditor — full-screen ChatGPT-style image editor.
 *
 * Opens over CreativeDetailModalV2 when operator clicks the pink dot next
 * to the 1:1 ratio label. Compound edits flow as a chat — each prompt
 * edits the previous result. Region selection ("Seleziona") paints a mask
 * for area-targeted edits. Accept commits the final image as the new live
 * 1:1 and cascades 4:5/9:16.
 *
 * History is in-memory only (lost on page close). Each chat turn becomes a
 * thumbnail in the left sidebar; click any thumbnail to revert to that
 * point + use it as the source for the next edit.
 */
export function EditImageEditor({ creative, isOpen, onClose, onAccepted }) {
  // history[] = list of { prompt, imageUrl, ts } — first entry is the original.
  const [history, setHistory] = useState(() => (
    creative?.image_url ? [{ prompt: null, imageUrl: creative.image_url, ts: Date.now(), original: true }] : []
  ));
  const [currentIdx, setCurrentIdx] = useState(0);
  const [chatInput, setChatInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [editToken, setEditToken] = useState(null);

  // Region select state
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const drawingRef = useRef(false);

  // Accept flow
  const [accepting, setAccepting] = useState(false);

  // Mounted ref — set false on unmount so async pollers can skip setState
  // and we don't leak warnings ("can't update state on unmounted component").
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const current = history[currentIdx] || null;
  const sourceImageUrl = current?.imageUrl;

  // Reset history if a different creative is loaded
  useEffect(() => {
    if (isOpen && creative?.image_url) {
      setHistory([{ prompt: null, imageUrl: creative.image_url, ts: Date.now(), original: true }]);
      setCurrentIdx(0);
      setChatInput('');
      setError(null);
      setGenerating(false);
      setSelectingRegion(false);
      setHasMask(false);
      setEditToken(null);
    }
  }, [isOpen, creative?.id, creative?.image_url]);

  // Close on Escape (only when nothing in flight)
  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => { if (e.key === 'Escape' && !generating && !accepting) onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen, onClose, generating, accepting]);

  // ── Canvas / mask drawing ───────────────────────────────────────────────
  // The image is rendered inside a 1:1 aspect-square wrapper so the canvas
  // can use absolute inset-0 to perfectly overlay. Canvas pixel dimensions
  // are sync'd to the wrapper's CSS pixel dimensions on every interaction
  // so we always draw on a buffer the same size as the visible canvas
  // (no scaling needed, brush position stays accurate).
  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return false;
    if (canvas.width !== w || canvas.height !== h) {
      // Preserve any existing drawing when we resize (capture → resize → restore)
      const prev = canvas.width > 0 && canvas.height > 0
        ? canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        : null;
      canvas.width = w;
      canvas.height = h;
      if (prev) {
        try { canvas.getContext('2d').putImageData(prev, 0, 0); } catch {}
      }
    }
    return true;
  }, []);

  useEffect(() => {
    if (!selectingRegion) return;
    // Run after layout commits, so canvas has its CSS dimensions resolved
    const raf = requestAnimationFrame(syncCanvasSize);
    const onResize = () => syncCanvasSize();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [selectingRegion, syncCanvasSize, sourceImageUrl]);

  // Helper — draws the brush mark and sets hasMask. Defensive: re-syncs
  // canvas size on every event so an early click before the wrapper has
  // settled still draws correctly.
  const drawBrush = useCallback((e) => {
    if (!syncCanvasSize()) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    // Click coords are in CSS pixels; canvas buffer is sized to same CSS dims
    // so no scaling needed. Brush radius stays visually consistent.
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    ctx.fillStyle = 'rgba(217, 70, 239, 0.55)'; // fuchsia-500 @ 55% — brighter
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    setHasMask(true);
  }, [syncCanvasSize]);

  const onCanvasDown = (e) => {
    if (!selectingRegion) return;
    e.preventDefault(); // prevent text selection drag
    drawingRef.current = true;
    drawBrush(e);
  };
  const onCanvasMove = (e) => {
    if (!selectingRegion || !drawingRef.current) return;
    drawBrush(e);
  };
  const onCanvasUp = () => { drawingRef.current = false; };

  const clearMask = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasMask(false);
  };

  // Convert the magenta brush canvas into an OpenAI-format mask:
  // TRANSPARENT pixels = edit, OPAQUE pixels = preserve.
  // The image needs to be the same dimensions as the source. We render to
  // the OpenAI size (matches source ratio) so OpenAI accepts it.
  const buildMaskDataUrl = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !hasMask) return null;

    // Get pixel data from the displayed canvas
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Build a destination canvas the same size as the natural image
    const dest = document.createElement('canvas');
    dest.width = img.naturalWidth;
    dest.height = img.naturalHeight;
    const dctx = dest.getContext('2d');
    // Fill with white (preserve everything by default)
    dctx.fillStyle = 'rgba(0, 0, 0, 1)';
    dctx.fillRect(0, 0, dest.width, dest.height);

    // Map painted pixels (canvas → image)
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    const out = dctx.getImageData(0, 0, dest.width, dest.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4;
        const a = imgData.data[idx + 3];
        if (a > 0) {
          // Map this painted point to dest coords
          const dx = Math.round(x * scaleX);
          const dy = Math.round(y * scaleY);
          const didx = (dy * dest.width + dx) * 4;
          // Make transparent at this pixel
          out.data[didx + 3] = 0;
        }
      }
    }
    dctx.putImageData(out, 0, 0);
    return dest.toDataURL('image/png');
  }, [hasMask]);

  // ── Send a chat message (edit prompt) ───────────────────────────────────
  const handleSend = useCallback(async () => {
    const p = chatInput.trim();
    if (!p) { setError('Type what you want to change'); return; }
    if (generating) return;
    setGenerating(true);
    setError(null);

    const maskDataUrl = hasMask ? buildMaskDataUrl() : null;

    try {
      const { data: submitData } = await api.post(
        `/statics-generation/creatives/${creative.id}/edit`,
        {
          prompt: p,
          source_image_url: sourceImageUrl,
          mask: maskDataUrl,
        }
      );
      const submit = submitData?.data || submitData;
      const myToken = submit.edit_token;
      setEditToken(myToken);

      // Poll for completion
      const POLL_MS = 2500;
      const MAX_POLLS = 120; // ~5 min
      let polls = 0;
      const poll = async () => {
        // Guard: if the component unmounted (operator closed the editor
        // somehow), drop the poll silently — backend keeps the row state.
        if (!mountedRef.current) return;
        polls++;
        try {
          const { data: cdata } = await api.get(`/statics-generation/creatives/${creative.id}`);
          if (!mountedRef.current) return;
          const c = cdata?.data || cdata;
          if (c.last_edit_error) {
            setError(`Edit failed: ${c.last_edit_error}`);
            setGenerating(false);
            return;
          }
          if (c.pending_edit_url && c.pending_edit_token === myToken) {
            // New history entry; advance current to it
            setHistory((h) => {
              const next = [...h, { prompt: p, imageUrl: c.pending_edit_url, ts: Date.now() }];
              setCurrentIdx(next.length - 1);
              return next;
            });
            setChatInput('');
            clearMask();
            setSelectingRegion(false);
            setGenerating(false);
            return;
          }
          if (c.pending_edit_token !== myToken && c.pending_edit_token !== null) {
            setError('Edit was superseded by a newer Generate');
            setGenerating(false);
            return;
          }
          if (polls >= MAX_POLLS) {
            setError('Edit timed out after 5 minutes');
            setGenerating(false);
            return;
          }
          setTimeout(poll, POLL_MS);
        } catch (e) {
          if (!mountedRef.current) return;
          setError(e.response?.data?.error?.message || e.message);
          setGenerating(false);
        }
      };
      setTimeout(poll, POLL_MS);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
      setGenerating(false);
    }
  }, [chatInput, generating, hasMask, buildMaskDataUrl, sourceImageUrl, creative?.id]);

  // ── Accept current image → cascade ──────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (accepting || generating || !current || current.original) return;
    const ok = window.confirm(
      `Apply this edit to the live image?\n\n4:5 and 9:16 will be regenerated automatically from the edited 1:1.`
    );
    if (!ok) return;
    setAccepting(true);
    setError(null);
    try {
      await api.post(
        `/statics-generation/creatives/${creative.id}/edit/accept`,
        { edit_token: editToken, image_url: current.imageUrl }
      );
      onAccepted?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
      setAccepting(false);
    }
  }, [accepting, generating, current, editToken, creative?.id, onAccepted]);

  const handleClose = useCallback(async () => {
    if (generating || accepting) return;
    // Discard any orphan pending edit on the row
    try {
      if (editToken) {
        await api.post(`/statics-generation/creatives/${creative.id}/edit/discard`).catch(() => {});
      }
    } finally {
      onClose?.();
    }
  }, [generating, accepting, editToken, creative?.id, onClose]);

  const newChat = () => {
    if (generating || accepting) return;
    setHistory([{ prompt: null, imageUrl: creative.image_url, ts: Date.now(), original: true }]);
    setCurrentIdx(0);
    setChatInput('');
    setError(null);
    clearMask();
    setSelectingRegion(false);
  };

  if (!isOpen || !creative) return null;

  const title = creative.angle || creative.product_name || 'Edit Image';

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-zinc-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={handleClose}
            disabled={generating || accepting}
            className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer disabled:opacity-40"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <Pencil className="w-4 h-4 text-fuchsia-400 shrink-0" />
          <h3 className="text-sm font-mono text-white truncate" title={title}>{title}</h3>
          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase tracking-wide">
            In Review
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectingRegion((v) => !v)}
            disabled={generating || accepting}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold uppercase tracking-wide transition-colors cursor-pointer disabled:opacity-40 ${
              selectingRegion
                ? 'bg-fuchsia-500 text-white'
                : 'border border-fuchsia-500/40 text-fuchsia-300 hover:bg-fuchsia-500/10'
            }`}
            title={selectingRegion ? 'Exit region select' : 'Paint a region to edit only that area'}
          >
            <MousePointer2 className="w-3.5 h-3.5" />
            Seleziona
          </button>
          {hasMask && (
            <button
              type="button"
              onClick={clearMask}
              className="px-2 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wide border border-white/[0.1] text-zinc-300 hover:bg-white/[0.05] cursor-pointer"
              title="Clear region selection"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={handleAccept}
            disabled={accepting || generating || !current || current.original}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-black text-xs font-mono font-semibold uppercase tracking-wide transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={current?.original ? 'Make an edit first' : 'Apply this edit + regenerate 4:5 and 9:16'}
          >
            {accepting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…</>
              : <><CheckCircle2 className="w-3.5 h-3.5" /> Accept</>}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/30 text-xs text-red-300 flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {String(error)}
        </div>
      )}

      {/* Body: sidebar + center */}
      <div className="flex-1 flex overflow-hidden">
        {/* History sidebar */}
        <div className="w-[160px] border-r border-white/[0.06] flex flex-col bg-zinc-950 shrink-0">
          <button
            type="button"
            onClick={newChat}
            disabled={generating || accepting || history.length <= 1}
            className="m-3 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-mono uppercase tracking-wide bg-white/[0.04] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reset history to original"
          >
            <RotateCcw className="w-3 h-3" />
            New chat
          </button>
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
            {history.map((h, idx) => (
              <button
                key={h.ts + ':' + idx}
                type="button"
                onClick={() => { if (!generating && !accepting) setCurrentIdx(idx); }}
                disabled={generating || accepting}
                className={`block w-full rounded-md overflow-hidden border-2 transition-all cursor-pointer disabled:opacity-50 ${
                  idx === currentIdx ? 'border-fuchsia-500' : 'border-white/[0.06] hover:border-white/[0.2]'
                }`}
                title={h.prompt || 'Original'}
              >
                <div className="aspect-square bg-black/40">
                  <img src={h.imageUrl} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="px-1.5 py-1 text-[9px] font-mono text-zinc-400 truncate text-left">
                  {h.original ? 'Original' : (h.prompt || `Step ${idx}`)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Center: image + mask canvas
            FIXED 1:1 wrapper — the editor only opens on 1:1 cards per
            operator rule, so we lock the wrapper to a square. This gives
            the canvas a deterministic size to lay over, with no flex
            shrink-wrap ambiguity. Canvas uses inset-0 = perfect overlay. */}
        <div className="flex-1 flex items-center justify-center p-6 relative overflow-hidden">
          {sourceImageUrl ? (
            <div
              className={`relative aspect-square h-full max-h-[calc(100vh-260px)] max-w-full transition-shadow ${
                selectingRegion ? 'ring-2 ring-fuchsia-500 ring-offset-2 ring-offset-zinc-950 shadow-[0_0_30px_rgba(217,70,239,0.4)]' : ''
              }`}
              style={{ aspectRatio: '1 / 1' }}
            >
              <img
                ref={imageRef}
                src={sourceImageUrl}
                alt=""
                onLoad={syncCanvasSize}
                className="absolute inset-0 w-full h-full object-contain rounded-md select-none"
                draggable={false}
              />
              {selectingRegion && (
                <canvas
                  ref={canvasRef}
                  onMouseDown={onCanvasDown}
                  onMouseMove={onCanvasMove}
                  onMouseUp={onCanvasUp}
                  onMouseLeave={onCanvasUp}
                  className="absolute inset-0 w-full h-full cursor-crosshair rounded-md"
                  style={{ touchAction: 'none' }}
                />
              )}
              {selectingRegion && !hasMask && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-fuchsia-500/90 text-white text-[11px] font-mono uppercase tracking-wide pointer-events-none shadow-lg">
                  Click + drag to paint a region
                </div>
              )}
              {generating && (
                <div className="absolute inset-0 bg-zinc-950/70 flex items-center justify-center rounded-md">
                  <div className="flex flex-col items-center gap-2 text-zinc-200">
                    <Loader2 className="w-8 h-8 animate-spin text-fuchsia-400" />
                    <span className="text-xs font-mono">Editing… ~30-90s</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-zinc-500 text-xs">No image</div>
          )}
        </div>
      </div>

      {/* Bottom input */}
      <div className="border-t border-white/[0.06] px-5 py-3 shrink-0">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          {/* Mask status — visible whenever a mask exists (even after the
              operator exits select mode), because the next Send WILL include
              the mask. Prevents silent "why did only part of my image change?"
              confusion. Click ✕ to drop the mask. */}
          {hasMask && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono text-fuchsia-300 uppercase tracking-wide whitespace-nowrap"
              title="Mask will apply to your next prompt"
            >
              Region selected
              <button
                type="button"
                onClick={clearMask}
                disabled={generating || accepting}
                className="ml-1 p-0.5 rounded hover:bg-fuchsia-500/20 cursor-pointer disabled:opacity-40"
                title="Drop mask"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {selectingRegion && !hasMask && (
            <span className="text-[10px] font-mono text-fuchsia-300 uppercase tracking-wide whitespace-nowrap">
              Region mode
            </span>
          )}
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !generating && !accepting) handleSend(); }}
            placeholder={hasMask
              ? 'Describe what to change in the painted region…'
              : 'Describe the change… ("make the background red", "remove the watermark")'}
            disabled={generating || accepting}
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-fuchsia-500/50 transition-colors disabled:opacity-50"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={generating || accepting || !chatInput.trim()}
            className="p-2.5 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Send (Enter)"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <div className="text-[10px] font-mono text-zinc-600 text-center mt-1.5">
          History is in-memory — close without Accept and edits are lost. Accept commits + regenerates 4:5 and 9:16.
        </div>
      </div>
    </div>,
    document.body
  );
}

export default EditImageEditor;
