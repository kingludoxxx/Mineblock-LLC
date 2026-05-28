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
} from 'lucide-react';

const TIER_META = {
  BANGER: { Icon: Flame,  color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/30',  label: 'Banger' },
  CHAMP:  { Icon: Trophy, color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', label: 'Champ' },
  A:      { Icon: Star,   color: 'text-sky-400',    bg: 'bg-sky-500/10',    border: 'border-sky-500/30',    label: 'A-Tier' },
};

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

export default function ReferenceCard({ reference, onGenerateFromReference, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = TIER_META[reference.tier] || TIER_META.A;
  const { Icon: TierIcon } = meta;
  const hasTranscript = !!reference.transcript;

  const handleGenerate = (e) => {
    e.stopPropagation();
    if (!hasTranscript) return;
    if (onGenerateFromReference) onGenerateFromReference(reference);
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 2500);
      return;
    }
    setDeleting(true);
    try {
      if (onDelete) await onDelete(reference.id);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const transcriptPreview = hasTranscript
    ? reference.transcript.slice(0, 120).replace(/\s+/g, ' ').trim() + (reference.transcript.length > 120 ? '…' : '')
    : null;

  return (
    <div className="group relative bg-white/[0.02] border border-white/[0.06] hover:border-violet-500/30 rounded-lg overflow-hidden transition-all duration-200 hover:bg-white/[0.03] hover:shadow-[0_0_18px_rgba(139,92,246,0.06)]">
      {/* Thumbnail */}
      <div className="relative aspect-[16/10] bg-black/40 overflow-hidden">
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
        {/* Tier badge over thumbnail */}
        <div className="absolute top-2 left-2">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border ${meta.bg} ${meta.border} ${meta.color} backdrop-blur-sm whitespace-nowrap`}>
            <TierIcon className="w-2.5 h-2.5" />
            {meta.label}
          </span>
        </div>
        {/* Delete affordance — top-right, fades in on hover */}
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className={`absolute top-2 right-2 p-1.5 rounded-md transition-all ${
            confirmDelete
              ? 'bg-red-500/20 border border-red-500/40 text-red-300 opacity-100'
              : 'bg-black/60 border border-white/[0.08] text-zinc-400 hover:text-red-300 hover:bg-red-500/15 hover:border-red-500/30 opacity-0 group-hover:opacity-100'
          } cursor-pointer disabled:opacity-40`}
          title={confirmDelete ? 'Click again to confirm delete' : 'Delete reference'}
        >
          {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
        </button>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
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

        {/* Transcript preview */}
        <div className="text-[11px] leading-relaxed">
          {hasTranscript ? (
            <div className="flex items-start gap-1.5 text-zinc-500">
              <FileText className="w-3 h-3 mt-0.5 text-violet-400/60 shrink-0" />
              <span className="line-clamp-2 italic">{transcriptPreview}</span>
            </div>
          ) : (
            <div className="text-zinc-600 italic">No transcript yet</div>
          )}
        </div>

        {/* Generate brief CTA */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!hasTranscript}
          className="w-full inline-flex items-center justify-center gap-1.5 py-2 mt-1 rounded-md text-[11px] font-mono font-semibold uppercase tracking-wider transition-all cursor-pointer disabled:cursor-not-allowed"
          style={hasTranscript ? {
            background: 'linear-gradient(135deg, rgba(139,92,246,0.16), rgba(167,139,250,0.08))',
            border: '1px solid rgba(139,92,246,0.35)',
            color: '#c4b5fd',
            boxShadow: '0 0 12px rgba(139,92,246,0.08)',
          } : {
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            color: '#52525b',
          }}
          title={hasTranscript ? 'Open the brief generator with this transcript' : 'Transcript needed before generating'}
        >
          <Sparkles className="w-3 h-3" />
          {hasTranscript ? 'Generate Brief' : 'Awaiting transcript'}
        </button>
      </div>
    </div>
  );
}
