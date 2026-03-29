import { useMemo, useState } from 'react';
import {
  Eye,
  Check,
  Rocket,
  CheckCircle2,
  RefreshCw,
  Loader2,
  ExternalLink,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS = [
  {
    key: 'review',
    label: 'To Review',
    icon: Eye,
    color: 'gray',
    badgeBg: 'bg-gray-500/20',
    badgeText: 'text-gray-300',
    headerBorder: 'border-gray-500/40',
    placeholder: null,
    actionLabel: 'Approve',
    nextStatus: 'approved',
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: Check,
    color: 'green',
    badgeBg: 'bg-emerald-500/20',
    badgeText: 'text-emerald-300',
    headerBorder: 'border-emerald-500/40',
    placeholder: null,
    actionLabel: 'Ready',
    nextStatus: 'ready',
  },
  {
    key: 'ready',
    label: 'Ready to Launch',
    icon: Rocket,
    color: 'purple',
    badgeBg: 'bg-purple-500/20',
    badgeText: 'text-purple-300',
    headerBorder: 'border-purple-500/40',
    placeholder: 'Drag approved cards here',
    actionLabel: 'Launch',
    nextStatus: 'launched',
  },
  {
    key: 'launched',
    label: 'Launched',
    icon: CheckCircle2,
    color: 'green',
    badgeBg: 'bg-emerald-500/20',
    badgeText: 'text-emerald-300',
    headerBorder: 'border-emerald-500/40',
    placeholder: 'Drag here to mark launched',
    actionLabel: null,
    nextStatus: null,
  },
];

const STATUS_BADGE = {
  review: { bg: 'bg-amber-500/80', text: 'text-white', label: 'To Review' },
  approved: { bg: 'bg-emerald-500/80', text: 'text-white', label: 'Approved' },
  ready: { bg: 'bg-purple-500/80', text: 'text-white', label: 'Ready' },
  launched: { bg: 'bg-blue-500/80', text: 'text-white', label: 'Launched' },
};

// ---------------------------------------------------------------------------
// Creative card
// ---------------------------------------------------------------------------

function CreativeCard({ creative, column, onStatusChange, onCardClick, onPublish, variantStatus }) {
  const badge = STATUS_BADGE[creative.status] || STATUS_BADGE.review;
  const angleLabel = [creative.angle, creative.aspect_ratio]
    .filter(Boolean)
    .join(' \u00b7 ');

  const [wasDragged, setWasDragged] = useState(false);

  return (
    <div
      draggable
      onDragStart={(e) => {
        setWasDragged(true);
        e.dataTransfer.setData('text/plain', JSON.stringify({ id: creative.id, status: creative.status }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setTimeout(() => setWasDragged(false), 100)}
      onClick={() => { if (!wasDragged) onCardClick?.(creative); }}
      className="group bg-[#0a0a0a] border border-white/[0.06] rounded-lg overflow-hidden cursor-grab active:cursor-grabbing
                 hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/20 transition-all duration-150"
    >
      {/* Thumbnail */}
      <div className={`relative ${creative.aspect_ratio === '9:16' ? 'aspect-[9/16]' : 'aspect-[4/5]'} bg-[#0a0a0a]`}>
        {/* Eye fallback / generating state */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-700 gap-2">
          {creative.status === 'generating' ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
              <span className="text-[10px] text-blue-400/70">Generating…</span>
            </>
          ) : (
            <Eye className="w-8 h-8" />
          )}
        </div>
        {creative.image_url && creative.status !== 'generating' && (
          <img
            src={creative.image_url}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        {/* Aspect ratio badge */}
        <span className="absolute top-1.5 right-1.5 text-[9px] font-semibold bg-black/60 text-white/70 px-1.5 py-0.5 rounded">
          {creative.aspect_ratio || '4:5'}
        </span>
        {/* Variant indicator */}
        {creative.parent_creative_id && (
          <span className="absolute top-1.5 left-1.5 text-[9px] font-medium bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">
            Variant
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-1.5">
        <p className="text-sm font-medium text-gray-100 truncate">
          {creative.product_name || 'Untitled'}
        </p>

        {angleLabel && (
          <p className="text-xs text-gray-400 truncate">{angleLabel}</p>
        )}

        {/* 9:16 variant status — only on parent (non-variant) cards */}
        {!creative.parent_creative_id && variantStatus && (
          <div className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md mt-1 ${
            variantStatus === 'generating'
              ? 'bg-blue-500/10 text-blue-400'
              : variantStatus === 'done'
                ? 'bg-emerald-500/10 text-emerald-400'
                : variantStatus === 'failed'
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-gray-500/10 text-gray-500'
          }`}>
            {variantStatus === 'generating' && <Loader2 className="w-3 h-3 animate-spin" />}
            {variantStatus === 'done' && <Check className="w-3 h-3" />}
            {variantStatus === 'failed' && <Eye className="w-3 h-3" />}
            <span>
              {variantStatus === 'generating' ? '9:16 generating...'
                : variantStatus === 'done' ? '9:16 ready'
                : variantStatus === 'failed' ? '9:16 failed'
                : 'No 9:16'}
            </span>
          </div>
        )}

        {/* Action button */}
        {(column.key === 'approved' || column.key === 'ready') && onPublish && !creative.parent_creative_id ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPublish?.(creative.id);
            }}
            className="mt-1 w-full flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md transition-colors bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Publish to ClickUp
          </button>
        ) : column.actionLabel ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange?.(creative.id, column.nextStatus);
            }}
            className={`mt-1 w-full text-xs font-medium py-1.5 rounded-md transition-colors
              ${column.color === 'green'
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : column.color === 'purple'
                  ? 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25'
                  : 'bg-gray-500/15 text-gray-300 hover:bg-gray-500/25'
              } cursor-pointer`}
          >
            {column.actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline column
// ---------------------------------------------------------------------------

function PipelineColumn({ column, items, onStatusChange, onCardClick, onPublish, allCreatives }) {
  const Icon = column.icon;
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e) => {
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
      className="flex flex-col min-w-[260px] max-w-[320px] flex-1"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Column header */}
      <div
        className={`flex items-center gap-2 px-3 py-2.5 border-b-2 ${column.headerBorder} mb-3`}
      >
        <Icon className="w-4 h-4 text-gray-400" />
        <span className="text-sm font-semibold text-gray-200">
          {column.label}
        </span>
        <span
          className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium ${column.badgeBg} ${column.badgeText}`}
        >
          {items.length}
        </span>
      </div>

      {/* Scrollable card list */}
      <div className={`flex-1 overflow-y-auto pr-1 space-y-3 pb-4 custom-scrollbar transition-colors rounded-lg ${dragOver ? 'bg-white/[0.03] ring-1 ring-blue-500/30' : ''}`}>
        {items.length === 0 && column.placeholder ? (
          <div className="flex items-center justify-center h-32 border border-dashed border-gray-700/50 rounded-lg">
            <p className="text-xs text-gray-500 italic">{column.placeholder}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-gray-600">No creatives</p>
          </div>
        ) : (
          items.map((creative) => (
            <CreativeCard
              key={creative.id}
              creative={creative}
              column={column}
              onStatusChange={onStatusChange}
              onCardClick={onCardClick}
              onPublish={onPublish}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PipelineView component
// ---------------------------------------------------------------------------

export function PipelineView({ creatives = [], onStatusChange, onCardClick, onRefresh, loading, onPublish }) {
  // Bucket creatives into columns by status
  const buckets = useMemo(() => {
    const map = { review: [], approved: [], ready: [], launched: [] };
    for (const c of creatives) {
      if (c.status === 'rejected') continue; // filter out rejected
      const status = c.status === 'queued' ? 'ready' : c.status;
      const key = status in map ? status : 'review';
      map[key].push(c);
    }
    return map;
  }, [creatives]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-200">Pipeline</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300
                     bg-white/[0.04] border border-white/[0.06] rounded-md
                     hover:bg-white/[0.08] transition-colors disabled:opacity-40 cursor-pointer"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </button>
      </div>

      {/* Columns */}
      <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto">
        {COLUMNS.map((col) => (
          <PipelineColumn
            key={col.key}
            column={col}
            items={buckets[col.key]}
            onStatusChange={onStatusChange}
            onCardClick={onCardClick}
            onPublish={onPublish}
          />
        ))}
      </div>
    </div>
  );
}

export default PipelineView;
