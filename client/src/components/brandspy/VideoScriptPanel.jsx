/**
 * VideoScriptPanel — right-side slide-out shown alongside the IntelDrawer
 * in pageMode. Renders a timestamped Whisper transcript (Atria-reference
 * layout), a Copy Script button, and a close X.
 *
 * State is driven by props so the parent (BrandSpyAdDetailPage) can keep
 * the panel open across re-renders.
 */

import { useState } from 'react';
import { X, Copy, FileText, Loader2 } from 'lucide-react';

function formatTimestamp(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function VideoScriptPanel({
  open,
  onClose,
  loading = false,
  error = null,
  transcript = null,
  segments = null,
  cached = false,
}) {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  async function handleCopy() {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  }

  return (
    <aside
      className="flex flex-col h-full overflow-hidden shrink-0"
      style={{
        width: 360,
        background: '#161618',
        borderLeft: '1px solid #2a2a2a',
      }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid #2a2a2a' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-orange-400 shrink-0" />
          <p className="text-sm font-semibold text-zinc-200 truncate">Video Script</p>
          {cached && (
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Cached
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            disabled={!transcript}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors px-2 py-1 rounded"
            title="Copy transcript"
          >
            <Copy className="w-3 h-3" />
            {copied ? 'Copied' : 'Copy Script'}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 transition-colors"
            title="Close panel"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {loading && !transcript ? (
          <div className="h-full flex items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Transcribing…
          </div>
        ) : error ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs uppercase tracking-wider text-rose-400 font-semibold">
              Transcription failed
            </p>
            <p className="text-sm text-zinc-300 leading-relaxed">{error}</p>
          </div>
        ) : segments && segments.length > 0 ? (
          // Timestamped script — Atria-reference layout. Two-column rows:
          // monospace timestamp on the left, soft-wrapped sentence on the
          // right. Whisper segments are roughly one sentence each, perfect
          // for skim-reading.
          <div className="space-y-3.5">
            <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-zinc-500 mb-2">
              Video 1
            </p>
            {segments.map((seg, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  // Cross-component seek without prop-drilling a video ref.
                  // IntelDrawer listens for this event and forwards to its
                  // <video> element. Falls through silently if no video.
                  document.dispatchEvent(new CustomEvent('brand-spy:seek-video', {
                    detail: { seconds: seg.start },
                  }));
                }}
                className="w-full flex gap-3 items-start text-left rounded px-1 py-0.5 -mx-1 -my-0.5 hover:bg-zinc-800/60 transition-colors"
                title={`Jump to ${formatTimestamp(seg.start)}`}
              >
                <span
                  className="text-[11px] font-medium tabular-nums shrink-0 mt-0.5"
                  style={{ color: '#f97316', minWidth: 32 }}
                >
                  {formatTimestamp(seg.start)}
                </span>
                <p className="text-[13px] text-zinc-200 leading-snug flex-1">
                  {seg.text}
                </p>
              </button>
            ))}
          </div>
        ) : transcript ? (
          // Fallback: plain transcript text (no segment data). Whisper
          // verbose_json should always return segments, but older rows
          // transcribed before migration 050 stored only the text.
          <div>
            <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-zinc-500 mb-2">
              Video 1
            </p>
            <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
              {transcript}
            </p>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500">
            Click "Transcribe script" to generate.
          </div>
        )}
      </div>
    </aside>
  );
}
