import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Loader2, Send, CheckCircle2, MousePointer2, MessageSquarePlus,
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
  // Resize canvas to match the rendered image element exactly so brush
  // coordinates map 1:1.
  const syncCanvasSize = useCallback(() => {
    const img = imageRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const rect = img.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
  }, []);

  useEffect(() => {
    if (!selectingRegion) return;
    syncCanvasSize();
    const onResize = () => syncCanvasSize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [selectingRegion, syncCanvasSize, sourceImageUrl]);

  const onCanvasDown = (e) => {
    if (!selectingRegion) return;
    drawingRef.current = true;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(217, 70, 239, 0.45)'; // fuchsia-500 @ 45%
    ctx.beginPath();
    ctx.arc(e.clientX - rect.left, e.clientY - rect.top, 18, 0, Math.PI * 2);
    ctx.fill();
    setHasMask(true);
  };
  const onCanvasMove = (e) => {
    if (!selectingRegion || !drawingRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(217, 70, 239, 0.45)';
    ctx.beginPath();
    ctx.arc(e.clientX - rect.left, e.clientY - rect.top, 18, 0, Math.PI * 2);
    ctx.fill();
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
    const destSize = Math.max(img.naturalWidth, img.naturalHeight, canvas.width);
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
        polls++;
        try {
          const { data: cdata } = await api.get(`/statics-generation/creatives/${creative.id}`);
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
            disabled={generating || accepting || current?.original === false ? false : false}
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

        {/* Center: image + mask canvas */}
        <div className="flex-1 flex items-center justify-center p-6 relative overflow-hidden">
          {sourceImageUrl ? (
            <div className="relative max-w-full max-h-full flex items-center justify-center">
              <img
                ref={imageRef}
                src={sourceImageUrl}
                alt=""
                onLoad={syncCanvasSize}
                className="max-w-full max-h-[calc(100vh-260px)] object-contain rounded-md select-none"
                draggable={false}
              />
              {selectingRegion && (
                <canvas
                  ref={canvasRef}
                  onMouseDown={onCanvasDown}
                  onMouseMove={onCanvasMove}
                  onMouseUp={onCanvasUp}
                  onMouseLeave={onCanvasUp}
                  className="absolute inset-0 cursor-crosshair m-auto"
                  style={{ width: imageRef.current?.getBoundingClientRect().width, height: imageRef.current?.getBoundingClientRect().height }}
                />
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
          {selectingRegion && (
            <span className="text-[10px] font-mono text-fuchsia-300 uppercase tracking-wide whitespace-nowrap">
              Region {hasMask ? 'selected' : 'mode'}
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
