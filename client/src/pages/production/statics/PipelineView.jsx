import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Eye,
  Check,
  Rocket,
  CheckCircle2,
  RefreshCw,
  Loader2,
  FileText,
  Package,
  Zap,
  Send,
  X,
  ChevronDown,
  AlertTriangle,
  Lock,
  Settings,
  Tag,
  RotateCcw,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADSET_SIZE = 6; // 6 creatives = 1 complete ad set

const COLUMNS = [
  {
    key: 'generating',
    label: 'Generating',
    icon: Loader2,
    color: 'violet',
    iconClass: 'text-violet-400 drop-shadow-[0_0_6px_rgba(139,92,246,0.5)]',
    badgeBg: 'bg-violet-500/10',
    badgeText: 'text-violet-400',
    badgeBorder: 'border-violet-500/25',
    placeholder: 'Queued items appear here',
    actionLabel: null,
    nextStatus: null,
    noDropZone: true,
  },
  {
    key: 'review',
    label: 'To Review',
    icon: Eye,
    color: 'gold',
    iconClass: 'text-[#d4b55a] drop-shadow-[0_0_6px_rgba(201,168,76,0.5)]',
    badgeBg: 'bg-[#c9a84c]/10',
    badgeText: 'text-[#d4b55a]',
    badgeBorder: 'border-[#c9a84c]/25',
    placeholder: null,
    actionLabel: 'Approve',
    nextStatus: 'approved',
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: CheckCircle2,
    color: 'green',
    iconClass: 'text-emerald-400 drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-400',
    badgeBorder: 'border-emerald-500/25',
    placeholder: null,
    actionLabel: 'Ready',
    nextStatus: 'ready',
  },
  {
    key: 'ready',
    label: 'Ready to Launch',
    icon: Rocket,
    color: 'cyan',
    iconClass: 'text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.4)]',
    badgeBg: 'bg-cyan-500/10',
    badgeText: 'text-cyan-400',
    badgeBorder: 'border-cyan-500/25',
    placeholder: 'Drag approved cards here',
    actionLabel: null,
    nextStatus: null,
  },
  {
    key: 'launched',
    label: 'Launched',
    icon: CheckCircle2,
    color: 'green',
    iconClass: 'text-emerald-500 drop-shadow-[0_0_6px_rgba(16,185,129,0.4)]',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-500',
    badgeBorder: 'border-emerald-500/25',
    placeholder: 'Launched ads appear here',
    actionLabel: null,
    nextStatus: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByAngle(creatives) {
  const groups = {};
  for (const c of creatives) {
    const angle = c.angle || 'Uncategorized';
    if (!groups[angle]) groups[angle] = [];
    groups[angle].push(c);
  }
  // Sort: complete (>=ADSET_SIZE) first, then by count desc
  return Object.entries(groups).sort(([, a], [, b]) => {
    const aReady = a.length >= ADSET_SIZE;
    const bReady = b.length >= ADSET_SIZE;
    if (aReady !== bReady) return bReady - aReady;
    return b.length - a.length;
  });
}

// Group launched creatives by ad set batch (not just angle)
function groupByAdSet(creatives) {
  const groups = {};
  for (const c of creatives) {
    // Use batch_number from launch_batch if available, otherwise fall back to angle
    const batchKey = c.launch_batch?.batch_number
      ? `batch_${c.launch_batch.batch_number}`
      : `angle_${c.angle || 'Uncategorized'}`;
    if (!groups[batchKey]) {
      groups[batchKey] = {
        label: c.launch_batch?.adset_name || c.angle || 'Uncategorized',
        creatives: [],
      };
    }
    groups[batchKey].creatives.push(c);
  }
  // Sort by count desc
  return Object.entries(groups)
    .map(([key, { label, creatives: cs }]) => [label, cs])
    .sort(([, a], [, b]) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Creative card (compact version for ad set groups)
// ---------------------------------------------------------------------------

function RatioPill({ label, status }) {
  if (!status) return (
    <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-white/[0.04] text-gray-600 border border-white/[0.04]">
      {label}
    </span>
  );
  if (status === 'generating') return (
    <span className="flex items-center gap-0.5 text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20">
      <Loader2 className="w-2 h-2 animate-spin" />{label}
    </span>
  );
  if (status === 'done') return (
    <span className="flex items-center gap-0.5 text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
      <Check className="w-2 h-2" />{label}
    </span>
  );
  if (status === 'failed') return (
    <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-300 border border-red-500/20">
      {label} ✕
    </span>
  );
  return null;
}

function CreativeCard({ creative, column, onStatusChange, onCardClick, onRegenerate, variantStatus }) {
  const [wasDragged, setWasDragged] = useState(false);
  const isDraggable = !column.noDropZone;

  return (
    <div
      draggable={isDraggable}
      onDragStart={isDraggable ? (e) => {
        setWasDragged(true);
        e.dataTransfer.setData('text/plain', JSON.stringify({ id: creative.id, status: creative.status, angle: creative.angle || 'Uncategorized', type: 'angle-move' }));
        e.dataTransfer.effectAllowed = 'move';
      } : undefined}
      onDragEnd={isDraggable ? () => setTimeout(() => setWasDragged(false), 100) : undefined}
      onClick={() => { if (!wasDragged) onCardClick?.(creative); }}
      className={`animated-border-gradient rounded-xl ${isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      <div className="glass-card border border-white/[0.05] rounded-xl overflow-hidden group hover:border-white/[0.1] transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] relative z-10">
        {/* Thumbnail */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-black/40">
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 gap-1.5">
            {creative.status === 'generating' ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
                <span className="text-[9px] text-violet-300/70">Generating…</span>
              </>
            ) : (
              <Eye className="w-5 h-5" />
            )}
          </div>
          {creative.status === 'generating' && creative.reference_thumbnail ? (
            <img
              src={creative.reference_thumbnail}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-40"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          ) : creative.image_url && creative.status !== 'generating' ? (
            <img
              src={creative.image_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          ) : null}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span className="text-[10px] font-medium text-white bg-white/[0.15] backdrop-blur-sm px-2.5 py-1 rounded-full">
              View Full
            </span>
          </div>
          {creative.parent_creative_id && (
            <span className="absolute top-2 left-2 text-[9px] font-mono bg-[#c9a84c]/20 text-[#e8d5a3] px-1.5 py-0.5 rounded border border-[#c9a84c]/30 backdrop-blur-md">
              Variant
            </span>
          )}
          {creative.parent_creative_id && (
            <span className="absolute top-2 right-2 text-[9px] font-mono bg-black/50 text-zinc-300 px-1.5 py-0.5 rounded border border-white/[0.1] backdrop-blur-md">
              9:16
            </span>
          )}
        </div>

        {/* Info */}
        <div className="px-3 pt-2.5 pb-3 space-y-2.5">
          {/* Angle badge + ratio dots row */}
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-200 border border-white/[0.1] truncate">
              {creative.angle || 'Uncategorized'}
            </span>
            {!creative.parent_creative_id && (
              <div className="flex items-center gap-2.5">
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 font-mono">
                  <span className={`w-[6px] h-[6px] rounded-full ${creative.image_url ? 'bg-yellow-400' : 'bg-zinc-600'}`} />
                  {creative.aspect_ratio || '4:5'}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 font-mono">
                  <span className={`w-[6px] h-[6px] rounded-full ${
                    variantStatus === 'done' ? 'bg-yellow-400'
                    : variantStatus === 'generating' ? 'bg-yellow-400 animate-pulse'
                    : variantStatus === 'failed' ? 'bg-red-400'
                    : 'bg-yellow-400'
                  }`} />
                  9:16
                </span>
              </div>
            )}
          </div>

          {/* Action buttons — Approve dominates, icons compact */}
          {column.actionLabel ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStatusChange?.(creative.id, column.nextStatus);
                }}
                className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12px] font-semibold border border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {column.actionLabel}
              </button>
              {column.key === 'review' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStatusChange?.(creative.id, 'rejected');
                  }}
                  className="h-9 w-9 flex items-center justify-center rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-colors cursor-pointer shrink-0"
                  title="Reject"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerate?.(creative);
                }}
                className="h-9 w-8 flex items-center justify-center rounded-lg bg-white/[0.05] border border-white/[0.08] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.1] transition-colors cursor-pointer shrink-0"
                title="Regenerate"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCardClick?.(creative);
                }}
                className="h-9 w-8 flex items-center justify-center rounded-lg bg-white/[0.05] border border-white/[0.08] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.1] transition-colors cursor-pointer shrink-0"
                title="Settings"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact creative thumbnail for ad set groups
// ---------------------------------------------------------------------------

function AdSetThumb({ creative, onCardClick }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({
          id: creative.id,
          status: creative.status,
          angle: creative.angle || 'Uncategorized',
          type: 'angle-move',
        }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onCardClick?.(creative)}
      className="relative aspect-square w-full rounded-lg overflow-hidden bg-black/40 cursor-grab active:cursor-grabbing group"
    >
      {creative.image_url ? (
        <img
          src={creative.image_url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Eye className="w-4 h-4 text-zinc-700" />
        </div>
      )}
      <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      {/* Ratio pills at bottom */}
      <div className="absolute bottom-1 left-1 right-1 flex items-center gap-0.5 justify-center">
        <span className="text-[7px] font-medium px-1 py-0.5 rounded bg-black/60 text-zinc-300 backdrop-blur-sm">
          {creative.aspect_ratio || '4:5'}
        </span>
      </div>
    </div>
  );
}

// Empty slot placeholder for incomplete ad sets
function EmptySlot() {
  return (
    <div className="relative aspect-square w-full rounded-lg border border-dashed border-white/[0.08] bg-white/[0.01] flex items-center justify-center">
      <span className="text-zinc-700 text-lg">+</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ad Set Group Card (for Ready to Launch column)
// ---------------------------------------------------------------------------

function AdSetGroupCard({ angle, creatives, isComplete, onLaunch, onCardClick, onAngleChange }) {
  const count = creatives.length;
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          if (data.id && data.type === 'angle-move' && data.angle !== angle) {
            onAngleChange?.(data.id, angle === 'Uncategorized' ? '' : angle);
          }
        } catch { /* ignore */ }
      }}
      className={`rounded-xl border-2 transition-colors overflow-hidden ${
        dragOver
          ? 'border-[#c9a84c]/50 bg-[#c9a84c]/[0.05] ring-1 ring-[#c9a84c]/30'
          : isComplete
            ? 'border-emerald-500/30 bg-emerald-500/[0.02]'
            : 'border-red-500/20 bg-red-500/[0.02]'
      }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {isComplete ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <h4 className="text-sm font-semibold text-white truncate">
            {angle}
          </h4>
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
            isComplete
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}>
            {count}/{ADSET_SIZE}
          </span>
        </div>
        {isComplete ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLaunch(angle, creatives); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-transparent border border-white/[0.08] rounded-lg hover:border-emerald-500/30 hover:text-emerald-300 transition-colors cursor-pointer"
          >
            <Rocket className="w-3 h-3" />
            Launch
          </button>
        ) : (
          <span className="text-[11px] text-red-400/70 font-medium">
            Need {ADSET_SIZE - count} more
          </span>
        )}
      </div>

      {/* Creative grid */}
      <div className="px-4 pb-4">
        <div className="grid grid-cols-6 gap-2">
          {creatives.slice(0, ADSET_SIZE).map((c) => (
            <AdSetThumb key={c.id} creative={c} onCardClick={onCardClick} />
          ))}
          {/* Empty slots for incomplete sets */}
          {count < ADSET_SIZE && Array.from({ length: ADSET_SIZE - count }).map((_, i) => (
            <EmptySlot key={`empty-${i}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launched group card
// ---------------------------------------------------------------------------

function LaunchedGroupCard({ angle, creatives, onCardClick, onReset }) {
  const count = creatives.length;
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-xs font-semibold text-white truncate">{angle}</h4>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
            {count}
          </span>
        </div>
        {onReset && (
          <button
            type="button"
            onClick={() => onReset(creatives)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer shrink-0"
            title="Reset to ready"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Creative grid */}
      <div className="px-3 pb-3">
        <div className="grid grid-cols-3 gap-1.5">
          {creatives.map((c) => (
            <div
              key={c.id}
              onClick={() => onCardClick?.(c)}
              className="relative aspect-square rounded-lg overflow-hidden bg-black/40 cursor-pointer group"
            >
              {c.image_url ? (
                <img
                  src={c.image_url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Eye className="w-3 h-3 text-zinc-700" />
                </div>
              )}
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue card (generating column)
// ---------------------------------------------------------------------------

function QueueCard({ item, onRemove }) {
  const refImage = item.references?.[0];
  const refThumb = refImage?.image_url || refImage?.url || refImage?.thumbnail || null;
  const isGenerating = item.status === 'generating';

  return (
    <div className="animated-border-gradient rounded-xl">
      <div className="glass-card border border-white/[0.05] rounded-xl overflow-hidden relative z-10">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-black/40">
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 gap-1.5">
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
                <span className="text-[9px] text-violet-300/70">{item.progress || 'Generating…'}</span>
              </>
            ) : (
              <>
                <Package className="w-5 h-5 text-zinc-600" />
                <span className="text-[9px] text-zinc-500">Queued</span>
              </>
            )}
          </div>
          {refThumb && (
            <img
              src={refThumb}
              alt=""
              className={`absolute inset-0 w-full h-full object-cover transition-opacity ${isGenerating ? 'opacity-40' : 'opacity-60'}`}
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          )}
          <span className={`absolute top-2 left-2 text-[9px] font-mono px-1.5 py-0.5 rounded border backdrop-blur-md ${
            isGenerating
              ? 'bg-violet-500/20 text-violet-300 border-violet-500/30'
              : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
          }`}>
            {isGenerating ? 'Generating' : 'Queued'}
          </span>
          {item.references?.length > 1 && (
            <span className="absolute top-2 right-2 text-[9px] font-mono bg-black/50 text-zinc-300 px-1.5 py-0.5 rounded border border-white/[0.1] backdrop-blur-md">
              {item.references.length} refs
            </span>
          )}
        </div>
        <div className="p-3 space-y-2">
          <div>
            <h4 className="text-xs font-medium text-zinc-200 mb-0.5 truncate">
              {item.productName || 'Untitled'}
            </h4>
            {item.angle && (
              <span className="text-[10px] text-zinc-500 line-clamp-1">{item.angle}</span>
            )}
          </div>
          {!isGenerating && onRemove && (
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="w-full py-1 rounded-md text-[10px] font-medium border border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Standard pipeline column (generating, review, approved)
// ---------------------------------------------------------------------------

function PipelineColumn({ column, items, onStatusChange, onCardClick, onRegenerate, allCreatives, queueItems, onRemoveFromQueue }) {
  const Icon = column.icon;
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e) => {
    if (column.noDropZone) return;
    e.preventDefault();
    setDragOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.id && data.status !== column.key) {
        onStatusChange?.(data.id, column.key);
      }
    } catch { /* ignore */ }
  };

  return (
    <div
      className="flex flex-col min-w-[240px] max-w-[340px] flex-1 relative"
      onDragOver={column.noDropZone ? undefined : (e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={column.noDropZone ? undefined : () => setDragOver(false)}
      onDrop={column.noDropZone ? undefined : handleDrop}
    >
      {/* Column header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/[0.04] relative">
        <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-current to-transparent opacity-30" />
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${column.iconClass}${column.key === 'generating' && (items.length > 0 || queueItems?.length > 0) ? ' animate-spin' : ''}`} />
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
            {column.label}
          </h3>
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${column.badgeBg} ${column.badgeText} ${column.badgeBorder}`}>
          {items.length + (queueItems?.length || 0)}
        </span>
      </div>

      {/* Scrollable card list */}
      <div className={`flex-1 overflow-y-auto pr-2 space-y-4 pb-4 custom-scrollbar transition-colors rounded-lg ${dragOver ? 'bg-white/[0.03] ring-1 ring-[#c9a84c]/30' : ''}`}>
        {queueItems?.map((qItem) => (
          <QueueCard key={qItem.id} item={qItem} onRemove={onRemoveFromQueue} />
        ))}
        {items.length === 0 && !queueItems?.length && column.placeholder ? (
          <div className="h-32 border border-dashed border-white/[0.08] rounded-xl flex items-center justify-center text-sm text-zinc-600 italic bg-white/[0.01]">
            {column.placeholder}
          </div>
        ) : items.length === 0 && !queueItems?.length ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-zinc-600">No creatives</p>
          </div>
        ) : (
          items.map((creative) => {
            let vStatus = null;
            if (!creative.parent_creative_id && allCreatives) {
              const variant = allCreatives.find(c => c.parent_creative_id === creative.id && c.aspect_ratio === '9:16');
              if (variant) {
                vStatus = variant.status === 'generating' ? 'generating'
                  : variant.status === 'rejected' ? 'failed'
                  : variant.image_url ? 'done' : 'generating';
              }
            }
            return (
              <CreativeCard
                key={creative.id}
                creative={creative}
                column={column}
                onStatusChange={onStatusChange}
                onCardClick={onCardClick}
                onRegenerate={onRegenerate}
                variantStatus={vStatus}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ready to Launch column (grouped by angle)
// ---------------------------------------------------------------------------

function ReadyToLaunchColumn({ column, items, onCardClick, onLaunchGroup, onBulkLaunch, launchTemplates, selectedTemplateId, onSelectTemplate, copySets, selectedCopySetId, onSelectCopySet, onStatusChange, onAngleChange }) {
  const Icon = column.icon;
  const [dragOver, setDragOver] = useState(false);

  const angleGroups = useMemo(() => groupByAngle(items), [items]);
  const completeGroups = useMemo(() => angleGroups.filter(([, cs]) => cs.length >= ADSET_SIZE), [angleGroups]);
  const readyAdSets = completeGroups.length;

  return (
    <div
      className="flex flex-col min-w-[340px] max-w-[480px] flex-[1.8] relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          if (data.id && data.status !== 'ready') {
            onStatusChange?.(data.id, 'ready');
          }
        } catch { /* ignore */ }
      }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-white/[0.04] relative">
        <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-cyan-400/30 to-transparent" />
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${column.iconClass}`} />
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
            {column.label}
          </h3>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${column.badgeBg} ${column.badgeText} ${column.badgeBorder}`}>
            {items.length}
          </span>
        </div>
        <span className="text-[11px] font-medium text-cyan-400">
          {readyAdSets} ad set{readyAdSets !== 1 ? 's' : ''} ready
        </span>
      </div>

      {/* Template + Copy selectors + Bulk launch */}
      <div className="space-y-2 mb-4">
        {/* Row 1: Template selector */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <select
              value={selectedTemplateId}
              onChange={(e) => onSelectTemplate(e.target.value)}
              className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-xs text-white appearance-none cursor-pointer focus:ring-1 focus:ring-cyan-500/30 focus:border-cyan-500/20 pr-8"
            >
              <option value="">Select template...</option>
              {launchTemplates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} — ${Number(t.daily_budget || 0).toFixed(0)}/day
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          </div>
          {selectedTemplateId && (
            <Lock className="w-3.5 h-3.5 text-zinc-600 shrink-0" title="Linked to template" />
          )}
        </div>

        {/* Row 2: Copy set selector + Bulk launch */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <select
              value={selectedCopySetId}
              onChange={(e) => onSelectCopySet(e.target.value)}
              className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-xs text-white appearance-none cursor-pointer focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 pr-8"
            >
              <option value="">Select copy...</option>
              {copySets.map(cs => (
                <option key={cs.id} value={cs.id}>{cs.angle}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          </div>
          {readyAdSets > 0 && selectedTemplateId && selectedCopySetId && (
            <button
              type="button"
              onClick={() => onBulkLaunch(completeGroups)}
              className="inline-flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold px-3.5 py-2 rounded-lg cursor-pointer shrink-0 transition-colors"
            >
              <Rocket className="w-3.5 h-3.5" />
              Bulk Launch ({readyAdSets})
            </button>
          )}
        </div>
      </div>

      {/* Grouped ad sets */}
      <div className={`flex-1 overflow-y-auto pr-2 space-y-4 pb-4 custom-scrollbar transition-colors rounded-lg ${dragOver ? 'bg-white/[0.03] ring-1 ring-cyan-500/30' : ''}`}>
        {angleGroups.length === 0 ? (
          <div className="h-32 border border-dashed border-white/[0.08] rounded-xl flex items-center justify-center text-sm text-zinc-600 italic bg-white/[0.01]">
            {column.placeholder}
          </div>
        ) : (
          angleGroups.map(([angle, cs]) => (
            <AdSetGroupCard
              key={angle}
              angle={angle}
              creatives={cs}
              isComplete={cs.length >= ADSET_SIZE}
              onLaunch={onLaunchGroup}
              onCardClick={onCardClick}
              onAngleChange={onAngleChange}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launched column (grouped by angle)
// ---------------------------------------------------------------------------

function LaunchedColumn({ column, items, onCardClick, onStatusChange }) {
  const Icon = column.icon;
  const angleGroups = useMemo(() => groupByAdSet(items), [items]);
  const adSetCount = angleGroups.length;

  const handleReset = (creatives) => {
    for (const c of creatives) {
      onStatusChange?.(c.id, 'ready');
    }
  };

  return (
    <div className="flex flex-col min-w-[260px] max-w-[340px] flex-1 relative">
      {/* Column header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/[0.04] relative">
        <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-emerald-500/30 to-transparent" />
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${column.iconClass}`} />
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
            {column.label}
          </h3>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${column.badgeBg} ${column.badgeText} ${column.badgeBorder}`}>
            {items.length}
          </span>
        </div>
        {adSetCount > 0 && (
          <span className="text-[11px] font-medium text-emerald-400">
            {adSetCount} ad set{adSetCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Scrollable ad set list */}
      <div className="flex-1 overflow-y-auto pr-2 space-y-4 pb-4 custom-scrollbar">
        {angleGroups.length === 0 ? (
          <div className="h-32 border border-dashed border-white/[0.08] rounded-xl flex items-center justify-center text-sm text-zinc-600 italic bg-white/[0.01]">
            {column.placeholder}
          </div>
        ) : (
          angleGroups.map(([angle, cs]) => (
            <LaunchedGroupCard key={angle} angle={angle} creatives={cs} onCardClick={onCardClick} onReset={handleReset} />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PipelineView component
// ---------------------------------------------------------------------------

export function PipelineView({ creatives = [], onStatusChange, onAngleChange, onCardClick, onRegenerate, onRefresh, loading, onOpenTemplates, onOpenCopySets, queue = [], onRemoveFromQueue }) {
  // Bucket creatives into columns by status
  const buckets = useMemo(() => {
    const map = { generating: [], review: [], approved: [], ready: [], launched: [] };
    for (const c of creatives) {
      if (c.status === 'rejected' || c.status === 'archived') continue;
      // Show launched variants even if they have a parent — their parents may no longer exist
      if (c.parent_creative_id && c.status !== 'launched') continue;
      if (c.status === 'launching') continue;
      if (c.status === 'generating') {
        map.generating.push(c);
        continue;
      }
      const status = c.status === 'queued' ? 'ready' : c.status;
      const key = status in map ? status : 'review';
      map[key].push(c);
    }
    return map;
  }, [creatives]);

  // Launch state
  const [launchTemplates, setLaunchTemplates] = useState([]);
  const [copySets, setCopySets] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [pendingLaunch, setPendingLaunch] = useState(null); // { angle, creativeIds, isBulk, groups }
  const [selectedCopySetId, setSelectedCopySetId] = useState('');

  // Fetch launch templates & copy sets
  const fetchLaunchData = useCallback(() => {
    api.get('/brief-pipeline/launch-templates')
      .then(({ data }) => {
        const templates = data.data || [];
        setLaunchTemplates(templates);
        // Auto-select default template if none selected
        setSelectedTemplateId(prev => {
          if (prev) return prev;
          const def = templates.find(t => t.is_default);
          if (def) return def.id;
          if (templates.length === 1) return templates[0].id;
          return prev;
        });
      })
      .catch(() => {});
    api.get('/brief-pipeline/copy-sets')
      .then(({ data }) => setCopySets(data.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchLaunchData(); }, [fetchLaunchData]);

  // Handle launching a single ad set group
  const handleLaunchGroup = (angle, groupCreatives) => {
    if (!selectedTemplateId) {
      setLaunchError('Select a launch template first');
      return;
    }
    if (!selectedCopySetId) {
      setLaunchError('Select a copy set first');
      return;
    }
    setPendingLaunch({
      angle,
      creativeIds: groupCreatives.map(c => c.id),
      isBulk: false,
    });
    setLaunchModalOpen(true);
  };

  // Handle bulk launch of all complete groups
  const handleBulkLaunch = (completeGroups) => {
    if (!selectedTemplateId) {
      setLaunchError('Select a launch template first');
      return;
    }
    if (!selectedCopySetId) {
      setLaunchError('Select a copy set first');
      return;
    }
    const allIds = completeGroups.flatMap(([, cs]) => cs.map(c => c.id));
    const angles = completeGroups.map(([angle]) => angle);
    setPendingLaunch({
      angle: angles.join(', '),
      creativeIds: allIds,
      isBulk: true,
      groupCount: completeGroups.length,
    });
    setLaunchModalOpen(true);
  };

  // Execute launch
  const executeLaunch = async () => {
    if (!pendingLaunch || !selectedTemplateId || !selectedCopySetId) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { data } = await api.post('/statics-generation/launch', {
        creative_ids: pendingLaunch.creativeIds,
        template_id: selectedTemplateId,
        copy_set_id: selectedCopySetId || undefined,
      });
      const launchedIds = (data.data?.results || []).filter(r => r.status === 'launched').map(r => r.creative_id);
      const failed = (data.data?.results || []).filter(r => r.status === 'failed');
      if (failed.length) {
        setLaunchError(`${launchedIds.length} launched, ${failed.length} failed: ${failed[0]?.error || ''}`);
      } else {
        setLaunchModalOpen(false);
        setPendingLaunch(null);
      }
      onRefresh?.();
    } catch (err) {
      setLaunchError(err.response?.data?.error?.message || 'Launch failed');
    } finally {
      setLaunching(false);
    }
  };

  // Status change handler — pass through to parent for non-launch actions
  const handleStatusChange = (id, newStatus) => {
    onStatusChange?.(id, newStatus);
  };

  // Standard columns (generating, review, approved)
  const standardColumns = COLUMNS.filter(c => !['ready', 'launched'].includes(c.key));
  const readyColumn = COLUMNS.find(c => c.key === 'ready');
  const launchedColumn = COLUMNS.find(c => c.key === 'launched');

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-mono text-sm font-semibold text-white tracking-[0.15em] uppercase">Pipeline</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenTemplates}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-zinc-400 uppercase tracking-wide
                       bg-transparent border border-white/[0.05] rounded-md
                       hover:border-white/[0.1] hover:text-zinc-200 transition-all cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            Templates
          </button>
          <button
            type="button"
            onClick={onOpenCopySets}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-zinc-400 uppercase tracking-wide
                       bg-transparent border border-white/[0.05] rounded-md
                       hover:border-white/[0.1] hover:text-zinc-200 transition-all cursor-pointer"
          >
            <Package className="w-3.5 h-3.5" />
            Copy Sets
          </button>
          <div className="h-4 w-px bg-white/[0.06]" />
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-zinc-400 uppercase tracking-wide
                       bg-transparent border border-white/[0.05] rounded-md
                       hover:border-white/[0.1] hover:text-zinc-200 transition-all disabled:opacity-40 cursor-pointer"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Error toast */}
      {launchError && (
        <div className="mb-4 glass-card border border-red-500/20 rounded-lg px-4 py-2 flex items-center justify-between">
          <span className="text-xs text-red-300">{launchError}</span>
          <button onClick={() => setLaunchError(null)} className="text-red-400 hover:text-red-200 text-xs cursor-pointer">Dismiss</button>
        </div>
      )}

      {/* Columns */}
      <div className="flex gap-6 flex-1 min-h-0 overflow-x-auto">
        {/* Standard columns: generating, review, approved */}
        {standardColumns.map((col) => (
          <PipelineColumn
            key={col.key}
            column={col}
            items={buckets[col.key]}
            onStatusChange={handleStatusChange}
            onCardClick={onCardClick}
            onRegenerate={onRegenerate}
            allCreatives={creatives}
            queueItems={col.key === 'generating' ? queue.filter(q => q.status === 'queued' || q.status === 'generating') : undefined}
            onRemoveFromQueue={onRemoveFromQueue}
          />
        ))}

        {/* Ready to Launch column — grouped by angle */}
        <ReadyToLaunchColumn
          column={readyColumn}
          items={buckets.ready}
          onCardClick={onCardClick}
          onLaunchGroup={handleLaunchGroup}
          onBulkLaunch={handleBulkLaunch}
          launchTemplates={launchTemplates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          copySets={copySets}
          selectedCopySetId={selectedCopySetId}
          onSelectCopySet={setSelectedCopySetId}
          onStatusChange={handleStatusChange}
          onAngleChange={onAngleChange}
        />

        {/* Launched column — grouped by angle */}
        <LaunchedColumn
          column={launchedColumn}
          items={buckets.launched}
          onCardClick={onCardClick}
          onStatusChange={onStatusChange}
        />
      </div>

      {/* Launch confirmation modal */}
      {launchModalOpen && pendingLaunch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !launching && setLaunchModalOpen(false)}>
          <div className="glass-card border border-white/[0.08] rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-mono font-semibold text-white uppercase tracking-wide flex items-center gap-2">
                <Rocket className="w-4 h-4 text-emerald-400" />
                {pendingLaunch.isBulk
                  ? `Bulk Launch ${pendingLaunch.groupCount} Ad Set${pendingLaunch.groupCount > 1 ? 's' : ''}`
                  : `Launch "${pendingLaunch.angle}" Ad Set`
                }
              </h3>
              <button onClick={() => { if (!launching) { setLaunchModalOpen(false); setPendingLaunch(null); } }} disabled={launching} className="text-zinc-500 hover:text-white cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 mb-6">
              {/* Template info */}
              <div className="glass-card border border-white/[0.05] rounded-lg px-3 py-2">
                <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-1">Template</span>
                <p className="text-sm text-white">{launchTemplates.find(t => t.id === selectedTemplateId)?.name || 'None'}</p>
              </div>

              {/* Creative count */}
              <div className="glass-card border border-white/[0.05] rounded-lg px-3 py-2">
                <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-1">Creatives</span>
                <p className="text-sm text-white">{pendingLaunch.creativeIds.length} images → {pendingLaunch.angle}</p>
              </div>

              {/* Copy set info */}
              <div className="glass-card border border-white/[0.05] rounded-lg px-3 py-2">
                <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-1">Copy</span>
                <p className="text-sm text-white">{copySets.find(cs => cs.id === selectedCopySetId)?.angle || 'None selected'}</p>
              </div>

              {launchError && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {launchError}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 justify-end">
              <button onClick={() => { setLaunchModalOpen(false); setPendingLaunch(null); }} disabled={launching} className="text-xs text-zinc-400 hover:text-white px-3 py-2 cursor-pointer">Cancel</button>
              <button
                onClick={executeLaunch}
                disabled={launching || !selectedTemplateId || !selectedCopySetId}
                className="inline-flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold px-4 py-2 rounded-lg cursor-pointer disabled:opacity-50"
              >
                {launching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {launching ? 'Launching...' : 'Confirm Launch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PipelineView;
