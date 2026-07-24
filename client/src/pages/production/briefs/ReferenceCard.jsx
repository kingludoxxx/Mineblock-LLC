import { useState } from 'react';
import {
  Trophy,
  Flame,
  Star,
  Sparkles,
  Trash2,
  Play,
  FileText,
  Clock,
  Loader2,
  Upload,
  TrendingUp,
  CheckCircle2,
} from 'lucide-react';

const TIER_META = {
  BANGER: { Icon: Flame,  label: 'Banger' },
  CHAMP:  { Icon: Trophy, label: 'Champ' },
  A:      { Icon: Star,   label: 'A-Tier' },
  OUR:    { Icon: TrendingUp, label: 'Our Winner' },
  UPLOAD: { Icon: Upload, label: 'Upload' },
};

function fmtRoas(n) { return `${(Number(n) || 0).toFixed(2)}×`; }
function fmt$(n) {
  if (n == null) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

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

export default function ReferenceCard({ reference, onPreview, onGenerateFromReference, onDelete, onRetryTranscribe }) {
  const [deleting, setDeleting] = useState(false);
  const isMeta   = reference.source === 'meta';
  const isUpload = reference.source === 'upload';
  // Source overrides tier badge for META + UPLOAD rows.
  const metaKey = isMeta ? 'OUR' : isUpload ? 'UPLOAD' : reference.tier;
  const meta = TIER_META[metaKey] || TIER_META.A;
  const { Icon: TierIcon } = meta;
  const hasTranscript = !!reference.transcript;
  // Granular progress states from the new Playwright + parallel pipeline.
  // status: 'pending' | 'extracting' | 'transcribing' | 'transcribed' | 'error'
  const isPending      = reference.status === 'pending';
  const isExtracting   = reference.status === 'extracting';
  const isTranscribing = reference.status === 'transcribing';
  const isInProgress   = isPending || isExtracting || isTranscribing;
  const transcribeError = !hasTranscript && reference.analysisError && !isInProgress;
  const md = reference.importedMetadata || {};
  // "Used" = this reference already produced a brief that was PUSHED to ClickUp.
  // Lets the operator see, at a glance, which competitor videos they've already
  // cloned so they don't do it twice. Locally-generated-but-unpushed briefs
  // don't count (set server-side).
  const pushedBriefNumbers = Array.isArray(reference.pushedBriefNumbers) ? reference.pushedBriefNumbers : [];
  const usedInPushedBrief = reference.usedInPushedBrief || pushedBriefNumbers.length > 0;
  const usedBriefLabel = pushedBriefNumbers.length
    ? `B${String(pushedBriefNumbers[0]).padStart(4, '0')}${pushedBriefNumbers.length > 1 ? ` +${pushedBriefNumbers.length - 1}` : ''}`
    : '';

  const handleGenerate = (e) => {
    e.stopPropagation();
    if (!hasTranscript) return;
    if (onGenerateFromReference) onGenerateFromReference(reference);
  };

  // Single-click delete with optimistic UI (parent handles the API + re-add on error).
  const handleDelete = async (e) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      if (onDelete) await onDelete(reference.id);
    } finally {
      setDeleting(false);
    }
  };

  const handleCardClick = () => {
    if (onPreview) onPreview(reference);
  };

  const transcriptPreview = hasTranscript
    ? reference.transcript.slice(0, 120).replace(/\s+/g, ' ').trim() + (reference.transcript.length > 120 ? '…' : '')
    : null;

  return (
    <div className={`group relative bg-white/[0.02] border rounded-lg overflow-hidden transition-all duration-200 hover:bg-white/[0.03] ${usedInPushedBrief ? 'border-emerald-500/40 hover:border-emerald-500/60' : 'border-white/[0.06] hover:border-white/[0.12]'}`}>
      {/* Thumbnail — click to preview */}
      <button
        type="button"
        onClick={handleCardClick}
        aria-label={`Preview reference video and transcript for ${reference.headline || reference.brandName || 'this reference'}`}
        className="block w-full relative aspect-[16/10] bg-black/40 overflow-hidden cursor-pointer text-left"
        title="Click to preview video and transcript"
      >
        {reference.thumbnailUrl ? (
          <img
            src={reference.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play className="w-6 h-6 text-zinc-700" />
          </div>
        )}
        {/* Hover tint — clicking the thumbnail opens the preview modal. The old
            play-button overlay was removed: the card never had an inline player,
            and the icon misleadingly implied one. */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
        {/* Source/tier badge over thumbnail */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border backdrop-blur-sm whitespace-nowrap"
            style={isMeta ? {
              background: 'rgba(14,165,233,0.18)',
              borderColor: 'rgba(14,165,233,0.45)',
              color: '#7dd3fc',
            } : isUpload ? {
              background: 'rgba(0,0,0,0.6)',
              borderColor: 'rgba(255,255,255,0.12)',
              color: '#e4e4e7',
            } : {
              background: 'rgba(0,0,0,0.6)',
              borderColor: 'rgba(255,255,255,0.12)',
              color: '#f4f4f5',
            }}
          >
            <TierIcon className="w-2.5 h-2.5" />
            {meta.label}
          </span>
          {isMeta && md.roas != null && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold backdrop-blur-sm whitespace-nowrap"
              style={{
                background: 'rgba(14,165,233,0.18)',
                border: '1px solid rgba(14,165,233,0.45)',
                color: '#7dd3fc',
              }}
            >
              {fmtRoas(md.roas)}
            </span>
          )}
          {isPending && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase tracking-wider bg-amber-500/15 border border-amber-500/40 text-amber-300 backdrop-blur-sm whitespace-nowrap">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              Transcribing
            </span>
          )}
          {usedInPushedBrief && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase tracking-wider bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 backdrop-blur-sm whitespace-nowrap"
              title={`Already used to push ${pushedBriefNumbers.length} brief(s) to ClickUp: ${pushedBriefNumbers.map((n) => 'B' + String(n).padStart(4, '0')).join(', ')}`}
            >
              <CheckCircle2 className="w-2.5 h-2.5" />
              {usedBriefLabel ? `Used · ${usedBriefLabel}` : 'Used'}
            </span>
          )}
        </div>
      </button>

      {/* Delete trash icon — separate from the card-click area, top-right of the card */}
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-black/60 backdrop-blur-sm border border-white/[0.08] text-zinc-400 hover:text-red-300 hover:bg-red-500/15 hover:border-red-500/30 transition-all opacity-0 group-hover:opacity-100 cursor-pointer disabled:opacity-40 z-10"
        title="Delete reference"
      >
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
      </button>

      {/* Body — also click to preview */}
      <button
        type="button"
        onClick={handleCardClick}
        className="block w-full text-left p-3 space-y-2 cursor-pointer"
      >
        {/* Brand + age */}
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
            {reference.brandName || 'Unknown brand'}
          </div>
          <div className="text-[10px] font-mono text-zinc-600 inline-flex items-center gap-1 shrink-0">
            <Clock className="w-2.5 h-2.5" />
            {timeAgo(reference.createdAt)}
          </div>
        </div>

        {/* Headline */}
        {reference.headline && (
          <div className="text-xs text-zinc-200 line-clamp-2 leading-snug">
            {reference.headline}
          </div>
        )}

        {/* Meta performance strip — Spend / CPA / ROAS scoped to the
            time-window the user picked when importing (e.g. 7d / 30d / 90d). */}
        {isMeta && (
          <div className="text-[10px] font-mono text-zinc-500">
            {md.spend != null && <>Spend {fmt$(md.spend)} · </>}
            {md.cpa != null && md.cpa > 0 && <>CPA {fmt$(md.cpa)} · </>}
            {md.roas != null && <>ROAS {(Number(md.roas) || 0).toFixed(2)}×</>}
            {md.window_days != null && <span className="text-zinc-600 ml-1">({md.window_days}d)</span>}
          </div>
        )}

        {/* Transcript preview */}
        <div className="text-[11px] leading-relaxed">
          {hasTranscript ? (
            <div className="flex items-start gap-1.5 text-zinc-500">
              <FileText className="w-3 h-3 mt-0.5 text-zinc-500 shrink-0" />
              <span className="line-clamp-2 italic">{transcriptPreview}</span>
            </div>
          ) : transcribeError ? (
            <div className="space-y-1.5">
              <div className="text-red-400/80 italic line-clamp-2">{transcribeError}</div>
              {onRetryTranscribe && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRetryTranscribe(reference.id); }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15 cursor-pointer"
                >
                  Retry transcribe
                </button>
              )}
            </div>
          ) : isExtracting ? (
            <div className="text-violet-300/80 italic">Extracting video URL…</div>
          ) : isTranscribing ? (
            <div className="text-sky-300/80 italic">Transcribing video…</div>
          ) : isPending ? (
            <div className="text-amber-300/80 italic">Queued for transcription…</div>
          ) : (
            <div className="text-zinc-600 italic">No transcript yet</div>
          )}
        </div>
      </button>

      {/* CTA — Generate Iterations for META, Generate Brief for LEAGUE/UPLOAD */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!hasTranscript}
          className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-md text-[11px] font-mono font-semibold uppercase tracking-wider transition-all cursor-pointer disabled:cursor-not-allowed"
          style={hasTranscript ? (isMeta ? {
            background: 'linear-gradient(135deg, rgba(14,165,233,0.20), rgba(56,189,248,0.10))',
            border: '1px solid rgba(14,165,233,0.45)',
            color: '#7dd3fc',
            boxShadow: '0 0 12px rgba(14,165,233,0.12)',
          } : {
            background: 'linear-gradient(135deg, rgba(201,168,76,0.18), rgba(212,181,90,0.1))',
            border: '1px solid rgba(201,168,76,0.4)',
            color: '#e8d5a3',
            boxShadow: '0 0 12px rgba(201,168,76,0.1)',
          }) : {
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            color: '#52525b',
          }}
          title={
            hasTranscript
              ? (isMeta ? 'Generate iterations of this winning ad' : 'Open the brief generator with this transcript')
              : 'Transcript needed before generating'
          }
        >
          <Sparkles className="w-3 h-3" />
          {hasTranscript ? (isMeta ? 'Generate Iterations' : 'Generate Brief') : 'Awaiting transcript'}
        </button>
      </div>
    </div>
  );
}
