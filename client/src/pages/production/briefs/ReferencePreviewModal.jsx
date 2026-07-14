import { useEffect, useState } from 'react';
import { X, Sparkles, Trash2, Clock, Trophy, Flame, Star, FileText, Play, Eye, TrendingUp, Upload, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../../services/api';

const TIER_META = {
  BANGER: { Icon: Flame,  label: 'Banger',  accent: 'text-zinc-200' },
  CHAMP:  { Icon: Trophy, label: 'Champ',   accent: 'text-zinc-200' },
  A:      { Icon: Star,   label: 'A-Tier',  accent: 'text-zinc-200' },
};

function fmtRoas(n) { return `${(Number(n) || 0).toFixed(2)}×`; }

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const secs = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function ReferencePreviewModal({ reference, open, onClose, onUseAsReference, onDelete }) {
  const navigate = useNavigate();
  // Reset video error state whenever a new reference is opened — by keying
  // the state to reference?.id we get reset-on-change without the
  // setState-in-effect anti-pattern.
  const refKey = reference?.id || null;
  const [videoErrorFor, setVideoErrorFor] = useState(null);
  const [videoLoading, setVideoLoading] = useState(false);
  // Repaired-URL state, keyed by reference id (same reset-on-change pattern).
  const [repairedFor, setRepairedFor] = useState(null);   // { id, url }
  const [repairingFor, setRepairingFor] = useState(null); // id while repair in flight
  const videoError = videoErrorFor === refKey && refKey !== null;
  const repairedUrl = repairedFor?.id === refKey ? repairedFor.url : null;
  const repairing = repairingFor === refKey && refKey !== null;

  // Stored fbcdn URLs expire ~2-4 weeks after scrape. On playback failure,
  // ask the server to recover the video (fresh Ad Library extraction → R2)
  // and retry once with the permanent URL it returns.
  async function handleVideoError(e) {
    setVideoLoading(false);
    console.error('[ReferencePreviewModal] Video load failed:', {
      videoUrl: repairedUrl || reference?.videoUrl,
      errorCode: e.currentTarget?.error?.code,
      errorMessage: e.currentTarget?.error?.message,
    });
    if (repairedUrl || repairing) { setVideoErrorFor(refKey); return; } // already retried once
    setRepairingFor(refKey);
    try {
      const { data } = await api.post(`/brief-pipeline/references/${refKey}/repair-video`, {}, { timeout: 120000 });
      if (data?.videoUrl) {
        setRepairedFor({ id: refKey, url: data.videoUrl });
        setVideoErrorFor(null);
      } else {
        setVideoErrorFor(refKey);
      }
    } catch {
      setVideoErrorFor(refKey);
    } finally {
      setRepairingFor(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !reference) return null;

  const isMeta   = reference.source === 'meta';
  const isUpload = reference.source === 'upload';
  const meta = TIER_META[reference.tier] || TIER_META.A;
  const { Icon: TierIcon } = meta;
  const hasTranscript = !!reference.transcript;
  const md = reference.importedMetadata || {};

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-5xl max-h-[88vh] bg-[#0a0a0a] border border-white/[0.08] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-14 border-b border-white/[0.06] flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {isMeta ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border whitespace-nowrap"
                style={{ color: '#7dd3fc', background: 'rgba(14,165,233,0.18)', borderColor: 'rgba(14,165,233,0.45)' }}
              >
                <TrendingUp className="w-3 h-3" />
                Our Winner
                {md.roas != null && <span className="ml-1">{fmtRoas(md.roas)}</span>}
              </span>
            ) : isUpload ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border bg-white/[0.04] border-white/[0.12] text-zinc-200 whitespace-nowrap">
                <Upload className="w-3 h-3" />
                Upload
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border bg-white/[0.04] border-white/[0.1] text-zinc-200 whitespace-nowrap">
                <TierIcon className="w-3 h-3" />
                {meta.label}
              </span>
            )}
            <div className="min-w-0">
              {reference.headline && (
                <div className="text-sm text-white truncate font-medium leading-snug">
                  {reference.headline}
                </div>
              )}
              <div className="text-[10px] font-mono text-zinc-500 truncate flex items-center gap-2">
                <span>{reference.brandName || 'Unknown brand'}</span>
                <span className="text-zinc-700">·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />
                  {timeAgo(reference.createdAt)}
                </span>
                <span className="text-zinc-700">·</span>
                <span className="text-zinc-600">{reference.adArchiveId}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Video */}
          <div className="p-5">
            {repairing ? (
              <div className="rounded-lg border border-white/[0.06] bg-black/40 p-6 text-center">
                <Loader2 className="w-6 h-6 text-zinc-500 mx-auto mb-3 animate-spin" />
                <div className="text-xs text-zinc-400 mb-1">
                  Video link expired — recovering it from the Ad Library…
                </div>
                <div className="text-[10px] text-zinc-600">This can take up to a minute. The recovered copy is saved permanently.</div>
              </div>
            ) : reference.videoUrl && !videoError ? (
              <div className="rounded-lg overflow-hidden bg-black border border-white/[0.06] relative">
                {videoLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
                    <div className="flex flex-col items-center gap-2">
                      <div className="animate-spin">
                        <Play className="w-6 h-6 text-zinc-400" />
                      </div>
                      <div className="text-xs text-zinc-400">Loading video...</div>
                    </div>
                  </div>
                )}
                <video
                  key={`${reference.id}-${repairedUrl ? 'repaired' : 'stored'}`}
                  src={repairedUrl || reference.videoUrl}
                  controls
                  controlsList="nodownload"
                  playsInline
                  poster={reference.thumbnailUrl || undefined}
                  className="w-full max-h-[44vh] object-contain bg-black mx-auto"
                  onLoadStart={() => setVideoLoading(true)}
                  onCanPlay={() => setVideoLoading(false)}
                  onError={handleVideoError}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-white/[0.06] bg-black/40 p-6 text-center">
                {reference.thumbnailUrl ? (
                  <img
                    src={reference.thumbnailUrl}
                    alt=""
                    className="max-h-[28vh] mx-auto rounded mb-3 opacity-60"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <Play className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
                )}
                <div className="text-xs text-zinc-400 mb-2">
                  {videoError
                    ? "Video failed to load. This usually means the video file is no longer available or is in an incompatible format."
                    : reference.videoUrl
                    ? "Video isn't supported in this player."
                    : 'No direct video URL stored for this ad.'}
                </div>
                {reference.videoUrl && (
                  <div className="text-[11px] text-zinc-500 mb-3">
                    Try opening in a new tab for better compatibility.
                  </div>
                )}
                {reference.videoUrl && (
                  <a
                    href={reference.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:text-blue-200 hover:bg-blue-500/20 hover:border-blue-500/50 transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    Play in New Tab
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Transcript */}
          <div className="px-5 pb-5 space-y-2">
            <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-1.5">
              <FileText className="w-3 h-3" />
              Transcript
              {hasTranscript && <span className="text-emerald-400/80 normal-case tracking-normal">· ready</span>}
            </div>
            {hasTranscript ? (
              <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
                <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {reference.transcript}
                </p>
              </div>
            ) : (
              <div className="text-xs text-zinc-500 bg-white/[0.01] border border-dashed border-white/[0.06] rounded-lg p-4 text-center">
                No transcript yet for this reference.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => { if (onDelete) onDelete(reference.id); onClose(); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-white/[0.06] text-zinc-400 hover:text-red-300 hover:border-red-500/30 hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { onClose(); navigate(`/app/brief-pipeline/reference/${reference.id}`); }}
              className="inline-flex items-center gap-2 px-3 py-2 text-[11px] font-mono font-semibold uppercase tracking-wider rounded-md border border-violet-500/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/20 hover:border-violet-500/60 transition-colors cursor-pointer"
              title="Open full Gemini analysis — visual breakdown, narrative, weaknesses, how-to-beat"
            >
              <Eye className="w-3.5 h-3.5" />
              Full Analysis
            </button>
            <button
              type="button"
              onClick={() => { onUseAsReference(reference); onClose(); }}
              disabled={!hasTranscript}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold uppercase tracking-wider rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={hasTranscript ? {
                background: 'linear-gradient(135deg, #c9a84c, #d4b55a)',
                color: '#111113',
                boxShadow: '0 0 16px rgba(201,168,76,0.25)',
              } : { background: 'rgba(255,255,255,0.04)', color: '#52525b', border: '1px solid rgba(255,255,255,0.04)' }}
              title={hasTranscript ? 'Quick-prefill the Script Generator' : 'Transcript required'}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Quick Use
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
