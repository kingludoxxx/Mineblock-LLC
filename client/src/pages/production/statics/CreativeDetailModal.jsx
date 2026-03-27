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
  ExternalLink,
  Loader2,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  review:   { bg: 'bg-amber-500/10',   text: 'text-amber-300',   border: 'border-amber-500/20' },
  approved: { bg: 'bg-emerald-500/10',  text: 'text-emerald-300', border: 'border-emerald-500/20' },
  rejected: { bg: 'bg-red-500/10',      text: 'text-red-300',     border: 'border-red-500/20' },
  queued:   { bg: 'bg-blue-500/10',     text: 'text-blue-300',    border: 'border-blue-500/20' },
  launched: { bg: 'bg-blue-500/10',     text: 'text-blue-300',    border: 'border-blue-500/20' },
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

export function CreativeDetailModal({
  creative,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onDelete,
  onDownload,
  onAiAdjust,
  onStatusChange,
  onPublish,
}) {
  const [aiInstruction, setAiInstruction] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(null);
  const [aiAdjusting, setAiAdjusting] = useState(false);
  const [aiError, setAiError] = useState(null);

  if (!isOpen || !creative) return null;

  const adaptedText = creative.adapted_text || creative.swap_pairs || {};

  const handleAiSubmit = async () => {
    if (!aiInstruction.trim() || aiAdjusting) return;
    setAiAdjusting(true);
    setAiError(null);
    try {
      await onAiAdjust?.(creative.id, aiInstruction.trim());
      setAiInstruction('');
    } catch (err) {
      setAiError(err.message || 'AI adjustment failed. Please try again.');
    } finally {
      setAiAdjusting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />

      {/* Modal shell */}
      <div className="relative flex w-full h-full">
        {/* ----------------------------------------------------------------- */}
        {/* Left panel — image preview (70%) */}
        {/* ----------------------------------------------------------------- */}
        <div className="w-[70%] flex flex-col items-center justify-center p-8 overflow-hidden">
          {/* Main preview */}
          <div className="flex-1 flex items-center justify-center w-full min-h-0">
            {creative.image_url ? (
              <img
                src={creative.image_url}
                alt={creative.product_name || 'Creative'}
                className="max-w-full max-h-full rounded-lg object-contain shadow-2xl"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-slate-600">
                <Image className="w-16 h-16" />
                <span className="text-sm">No image available</span>
              </div>
            )}
          </div>

          {/* Reference thumbnail */}
          {creative.reference_thumbnail && (
            <div className="mt-6 flex items-center gap-3">
              <img
                src={creative.reference_thumbnail}
                alt="Reference"
                className="w-16 h-16 rounded-md border border-white/[0.08] object-cover"
              />
              <span className="text-xs text-slate-400">
                {creative.reference_name || 'Reference template'}
              </span>
            </div>
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
                        {typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}
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
                className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-blue-500/50 focus:outline-none resize-none"
              />
              <button
                type="button"
                onClick={handleAiSubmit}
                disabled={!aiInstruction.trim() || aiAdjusting}
                className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600/20 border border-blue-500/30 text-sm text-blue-300 hover:bg-blue-600/30 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {aiAdjusting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> Regenerate with Correction</>
                )}
              </button>
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

            {/* Approve */}
            {creative.status !== 'approved' && (
              <button
                type="button"
                onClick={() => onApprove?.(creative.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer"
              >
                <Check className="w-4 h-4" />
                Approve
              </button>
            )}

            {/* Publish to ClickUp */}
            {creative.status === 'approved' && (
              <>
                <button
                  type="button"
                  disabled={publishing}
                  onClick={async () => {
                    setPublishing(true);
                    setPublishSuccess(null);
                    try {
                      const url = await onPublish?.(creative.id);
                      setPublishSuccess(url || true);
                    } catch {
                      setPublishSuccess(null);
                    } finally {
                      setPublishing(false);
                    }
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {publishing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ExternalLink className="w-4 h-4" />
                  )}
                  {publishing ? 'Publishing...' : 'Publish to ClickUp'}
                </button>
                {publishSuccess && (
                  <p className="text-xs text-emerald-400 text-center">
                    Published!{' '}
                    {typeof publishSuccess === 'string' && (
                      <a href={publishSuccess} target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-300">
                        View in ClickUp
                      </a>
                    )}
                  </p>
                )}
              </>
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
