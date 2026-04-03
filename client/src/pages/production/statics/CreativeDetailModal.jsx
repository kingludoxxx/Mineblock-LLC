import { useState } from 'react';
import {
  X,
  Download,
  Check,
  Trash2,
  ThumbsDown,
  ChevronDown,
  ChevronRight,
  Send,
  Sparkles,
  Image,
  Loader2,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  review:   { bg: 'bg-amber-500/10',   text: 'text-amber-300',   border: 'border-amber-500/20' },
  approved: { bg: 'bg-emerald-500/10',  text: 'text-emerald-300', border: 'border-emerald-500/20' },
  rejected: { bg: 'bg-red-500/10',      text: 'text-red-300',     border: 'border-red-500/20' },
  queued:   { bg: 'bg-accent-muted',     text: 'text-accent-text',    border: 'border-accent/20' },
  launched: { bg: 'bg-accent-muted',     text: 'text-accent-text',    border: 'border-accent/20' },
  draft:    { bg: 'bg-slate-500/10',    text: 'text-slate-300',   border: 'border-slate-500/20' },
};

const ADAPTED_TEXT_LABELS = {
  cta: 'Cta',
  body: 'Body',
  badges: 'Badges',
  headline: 'Headline',
  subheadline: 'Subheadline',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.draft;
  const display = (status || 'draft').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className={`inline-block px-2.5 py-1 text-[11px] font-medium rounded-full ${colors.bg} ${colors.text} border ${colors.border}`}
    >
      {display}
    </span>
  );
}

function SectionLabel({ children }) {
  return (
    <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
      {children}
    </h4>
  );
}

// ---------------------------------------------------------------------------
// CreativeDetailModal
// ---------------------------------------------------------------------------

function ReferenceLightbox({ url, name, onClose }) {
  if (!url) return null;
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 z-10 p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="bg-[#111] border border-white/[0.06] rounded-lg px-4 py-2 mb-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Reference Image</p>
          <p className="text-xs text-slate-300 truncate max-w-md">{name || 'Reference'}</p>
        </div>
        <img
          src={url}
          alt="Reference"
          className="max-w-full max-h-[75vh] rounded-xl object-contain shadow-2xl"
        />
      </div>
    </div>
  );
}

export function CreativeDetailModal({
  creative,
  variant,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onDelete,
  onDownload,
  onAiAdjust,
  onStatusChange,
  onCreateVariant,
}) {
  const [aiInstruction, setAiInstruction] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [aiAdjusting, setAiAdjusting] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [refLightbox, setRefLightbox] = useState(false);
  const [activeRatio, setActiveRatio] = useState('primary');

  if (!isOpen || !creative) return null;

  const activeCreative = activeRatio === '9:16' && variant ? variant : creative;

  // Parse adapted_text — may be a JSON string from the DB
  let adaptedText = creative.adapted_text || creative.swap_pairs || {};
  if (typeof adaptedText === 'string') {
    try { adaptedText = JSON.parse(adaptedText); } catch { adaptedText = {}; }
  }
  // If it's an array (swap_pairs), skip — only show object entries
  if (Array.isArray(adaptedText)) adaptedText = {};

  const [aiSuccess, setAiSuccess] = useState(false);
  const [aiPolling, setAiPolling] = useState(false);
  const [aiPollProgress, setAiPollProgress] = useState('');

  const handleAiSubmit = async () => {
    if (!aiInstruction.trim() || aiAdjusting) return;
    setAiAdjusting(true);
    setAiError(null);
    setAiSuccess(false);
    setAiPolling(false);
    setAiPollProgress('');
    try {
      await onAiAdjust?.(creative.id, aiInstruction.trim());
      // Start polling for updated image
      setAiPolling(true);
      setAiPollProgress('Waiting for AI to process...');
      const originalImageUrl = creative.image_url;
      let found = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 5000));
        setAiPollProgress(`Checking for update... (${i + 1})`);
        try {
          const { data } = await api.get(`/statics-generation/creatives/${creative.id}`);
          const updated = data?.data || data;
          if (updated?.image_url && updated.image_url !== originalImageUrl) {
            // Image was updated — refresh the creative in parent
            creative.image_url = updated.image_url;
            creative.generation_prompt = updated.generation_prompt;
            creative.review_notes = updated.review_notes;
            found = true;
            break;
          }
          if (updated?.review_notes && updated.review_notes.startsWith('AI adjustment failed')) {
            throw new Error(updated.review_notes);
          }
        } catch (pollErr) {
          if (pollErr.message?.includes('AI adjustment failed')) throw pollErr;
          // Network error during poll — continue trying
        }
      }
      if (found) {
        setAiSuccess(true);
        setAiInstruction('');
      } else {
        setAiError('Adjustment timed out. The image may still update — try refreshing.');
      }
    } catch (err) {
      setAiError(err.message || 'AI adjustment failed. Please try again.');
    } finally {
      setAiAdjusting(false);
      setAiPolling(false);
      setAiPollProgress('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />

      {/* Modal shell */}
      <div className="relative flex w-full h-full">
        {/* ----------------------------------------------------------------- */}
        {/* Left panel — image preview (70%) */}
        {/* ----------------------------------------------------------------- */}
        <div className="w-[70%] flex flex-col items-center justify-center p-10 overflow-hidden">
          {/* Ratio tabs — show when variant exists or is generating */}
          {!creative.parent_creative_id && (variant || creative.aspect_ratio !== '9:16') && (
            <div className="flex items-center gap-1 mb-4 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setActiveRatio('primary')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  activeRatio === 'primary'
                    ? 'bg-white/[0.1] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {creative.aspect_ratio || '4:5'}
              </button>
              <button
                type="button"
                onClick={() => setActiveRatio('9:16')}
                disabled={!variant}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  activeRatio === '9:16'
                    ? 'bg-white/[0.1] text-white cursor-pointer'
                    : variant
                      ? 'text-slate-500 hover:text-slate-300 cursor-pointer'
                      : 'text-slate-700 cursor-not-allowed'
                }`}
              >
                9:16
                {variant?.status === 'generating' && <Loader2 className="w-3 h-3 animate-spin text-violet-400" />}
                {variant?.image_url && <Check className="w-3 h-3 text-emerald-400" />}
                {!variant && <span className="text-[9px] text-slate-600">—</span>}
              </button>
            </div>
          )}

          {/* Image + reference wrapper */}
          <div className="relative max-w-[520px] w-full">
            {activeCreative.image_url ? (
              <img
                src={activeCreative.image_url}
                alt={activeCreative.product_name || 'Creative'}
                className="w-full rounded-lg object-contain shadow-2xl"
              />
            ) : activeCreative.status === 'generating' ? (
              <div className="flex flex-col items-center justify-center aspect-[4/5] gap-3 text-slate-600">
                <Loader2 className="w-10 h-10 animate-spin text-violet-400" />
                <span className="text-sm text-violet-300">Generating 9:16 version…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center aspect-[4/5] gap-3 text-slate-600">
                <Image className="w-16 h-16" />
                <span className="text-sm">No image available</span>
              </div>
            )}

            {/* Reference image overlay — bottom left, anchored to image */}
            {creative.reference_thumbnail && (
              <button
                type="button"
                onClick={() => setRefLightbox(true)}
                className="absolute -bottom-3 -left-3 group flex items-center gap-2 bg-black/80 border border-white/[0.1] rounded-lg p-1.5 pr-3 hover:bg-black/90 hover:border-white/[0.2] transition-all cursor-pointer shadow-xl"
              >
                <img
                  src={creative.reference_thumbnail}
                  alt="Reference"
                  className="w-12 h-12 rounded-md object-cover border border-white/[0.08]"
                />
                <div className="text-left">
                  <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Reference</p>
                  <p className="text-[11px] text-slate-300 truncate max-w-[100px] group-hover:text-white transition-colors">
                    {creative.reference_name || 'View original'}
                  </p>
                </div>
              </button>
            )}
          </div>

          {/* Reference lightbox */}
          {refLightbox && (
            <ReferenceLightbox
              url={creative.reference_thumbnail}
              name={creative.reference_name}
              onClose={() => setRefLightbox(false)}
            />
          )}
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Right panel — details (30%) */}
        {/* ----------------------------------------------------------------- */}
        <div className="w-[30%] bg-[#111] border-l border-white/[0.06] flex flex-col overflow-y-auto">
          {/* Header row */}
          <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
            <StatusBadge status={creative.status || 'review'} />
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 p-5 space-y-6 overflow-y-auto">
            {/* Product */}
            <div>
              <SectionLabel>Product</SectionLabel>
              <p className="text-sm font-semibold text-white leading-snug">
                {creative.product_name || 'Untitled'}
              </p>
              <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                {creative.angle && <span>Angle: {creative.angle}</span>}
                {creative.aspect_ratio && <span>Ratio: {creative.aspect_ratio}</span>}
              </div>
            </div>

            {/* Reference */}
            {creative.reference_name && (
              <div>
                <SectionLabel>Reference</SectionLabel>
                <p className="text-sm text-slate-300">{creative.reference_name}</p>
              </div>
            )}

            {/* Adapted Text */}
            {Object.keys(adaptedText).length > 0 && (
              <div>
                <SectionLabel>Adapted Text</SectionLabel>
                <div className="space-y-2">
                  {Object.entries(adaptedText).map(([key, value]) => (
                    <div key={key} className="flex gap-2 text-xs">
                      <span className="text-slate-500 shrink-0 w-20 font-medium">
                        {ADAPTED_TEXT_LABELS[key] || key}:
                      </span>
                      <span className="text-slate-300 break-words">
                        {typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : JSON.stringify(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Pipeline Debug — collapsible */}
            <div>
              <button
                type="button"
                onClick={() => setDebugOpen(!debugOpen)}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold hover:text-slate-300 transition-colors cursor-pointer"
              >
                {debugOpen ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                Pipeline Debug
              </button>
              {debugOpen && (
                <div className="mt-3 p-3 bg-[#0a0a0a] border border-white/[0.06] rounded-lg space-y-2 text-xs text-slate-400 font-mono max-h-60 overflow-y-auto">
                  {creative.claude_analysis && (
                    <div>
                      <span className="text-slate-500 block mb-1">Claude Analysis:</span>
                      <pre className="whitespace-pre-wrap break-words text-slate-400">
                        {typeof creative.claude_analysis === 'string'
                          ? creative.claude_analysis
                          : JSON.stringify(creative.claude_analysis, null, 2)}
                      </pre>
                    </div>
                  )}
                  {creative.generation_prompt && (
                    <div>
                      <span className="text-slate-500 block mb-1">Generation Prompt:</span>
                      <pre className="whitespace-pre-wrap break-words text-slate-400">
                        {creative.generation_prompt}
                      </pre>
                    </div>
                  )}
                  {!creative.claude_analysis && !creative.generation_prompt && (
                    <span className="text-slate-600 italic">No debug metadata available.</span>
                  )}
                </div>
              )}
            </div>

            {/* AI Adjustment */}
            <div>
              <SectionLabel>AI Adjustment</SectionLabel>
              <textarea
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder="Describe what to change... e.g. 'make the background darker blue' or 'add more energy to the model'"
                rows={3}
                className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-accent/50 focus:outline-none resize-none"
              />
              <button
                type="button"
                onClick={handleAiSubmit}
                disabled={!aiInstruction.trim() || aiAdjusting}
                className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent-muted border border-accent/30 text-sm text-accent-text hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {aiAdjusting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {aiPolling ? 'Regenerating...' : 'Submitting...'}</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> Regenerate with Correction</>
                )}
              </button>
              {aiPolling && aiPollProgress && (
                <p className="text-xs text-violet-400 mt-1 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin inline" />
                  {aiPollProgress}
                </p>
              )}
              {aiSuccess && (
                <p className="text-xs text-emerald-400 mt-1">✓ Image updated successfully! Close and reopen to see the new version.</p>
              )}
              {aiError && (
                <p className="text-xs text-red-400 mt-1">{aiError}</p>
              )}
            </div>
          </div>

          {/* Action buttons — pinned to bottom */}
          <div className="p-5 border-t border-white/[0.06] space-y-2">
            {/* Download */}
            <button
              type="button"
              onClick={() => onDownload?.(creative.id)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-300 hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Download
            </button>

            {/* Create 9:16 variant */}
            {creative.aspect_ratio !== '9:16' && !creative.parent_creative_id && onCreateVariant && (
              <button
                type="button"
                onClick={() => onCreateVariant(creative.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-purple-600/15 border border-purple-500/25 text-sm text-purple-300 hover:bg-purple-600/25 transition-colors cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                Create 9:16 Version
              </button>
            )}

            {/* Approve */}
            {creative.status === 'review' && (
              <button
                type="button"
                onClick={() => onApprove?.(creative.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer"
              >
                <Check className="w-4 h-4" />
                Approve
              </button>
            )}

            {/* Reject */}
            <button
              type="button"
              onClick={() => onReject?.(creative.id)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/15 border border-red-500/25 text-sm text-red-300 hover:bg-red-500/25 transition-colors cursor-pointer"
            >
              <ThumbsDown className="w-4 h-4" />
              Reject
            </button>

            {/* Delete */}
            <button
              type="button"
              onClick={() => onDelete?.(creative.id)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs text-slate-600 hover:text-red-400 hover:bg-red-500/5 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
