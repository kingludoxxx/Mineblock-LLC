import { useMemo, useState } from 'react';
import {
  Eye,
  Check,
  Rocket,
  CheckCircle2,
  RefreshCw,
  Loader2,
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
  launched: { bg: 'bg-accent/80', text: 'text-white', label: 'Launched' },
};

// ---------------------------------------------------------------------------
// Creative card
// ---------------------------------------------------------------------------

function CreativeCard({ creative, column, onStatusChange, onCardClick, variantStatus }) {
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
      className="group bg-[#0a0a0a] border border-white/[0.06] rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing
                 hover:border-white/[0.15] hover:shadow-lg hover:shadow-black/30 transition-all duration-200"
    >
      {/* Thumbnail — fixed compact height, uniform for all cards */}
      <div className="relative h-[140px] bg-[#080808]">
        {/* Fallback / generating state */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-700 gap-1.5">
          {creative.status === 'generating' ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin text-accent-text" />
              <span className="text-[9px] text-accent-text/70">Generating…</span>
            </>
          ) : (
            <Eye className="w-5 h-5" />
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
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-[10px] font-medium text-white bg-white/[0.15] backdrop-blur-sm px-2.5 py-1 rounded-full">
            View Full
          </span>
        </div>
        {/* Aspect ratio badge */}
        <span className="absolute top-1.5 right-1.5 text-[8px] font-semibold bg-black/60 text-white/60 px-1.5 py-0.5 rounded-full">
          {creative.aspect_ratio || '4:5'}
        </span>
        {/* Variant indicator */}
        {creative.parent_creative_id && (
          <span className="absolute top-1.5 left-1.5 text-[8px] font-medium bg-accent/20 text-accent-text px-1.5 py-0.5 rounded-full">
            Variant
          </span>
        )}
      </div>

      {/* Info — compact */}
      <div className="px-2.5 py-2 space-y-1">
        <p className="text-[11px] font-medium text-gray-200 truncate">
          {creative.product_name || 'Untitled'}
        </p>

        <div className="flex items-center justify-between">
          {angleLabel && (
            <p className="text-[10px] text-gray-500 truncate">{angleLabel}</p>
          )}

          {/* 9:16 variant status — compact inline */}
          {!creative.parent_creative_id && variantStatus && (
            <span className={`flex items-center gap-1 text-[9px] ${
              variantStatus === 'generating' ? 'text-accent-text'
                : variantStatus === 'done' ? 'text-emerald-400'
                : variantStatus === 'failed' ? 'text-red-400'
                : 'text-gray-500'
            }`}>
              {variantStatus === 'generating' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              {variantStatus === 'done' && <Check className="w-2.5 h-2.5" />}
              {variantStatus === 'generating' ? '9:16...' : variantStatus === 'done' ? '9:16' : ''}
            </span>
          )}
        </div>

        {/* Action button — slim */}
        {column.actionLabel ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange?.(creative.id, column.nextStatus);
            }}
            className={`mt-0.5 w-full text-[10px] font-medium py-1 rounded-lg transition-colors
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

function PipelineColumn({ column, items, onStatusChange, onCardClick, allCreatives }) {
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
      className="flex flex-col min-w-[200px] max-w-[260px] flex-1"
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
      <div className={`flex-1 overflow-y-auto pr-1 space-y-2 pb-4 custom-scrollbar transition-colors rounded-lg ${dragOver ? 'bg-white/[0.03] ring-1 ring-accent/30' : ''}`}>
        {items.length === 0 && column.placeholder ? (
          <div className="flex items-center justify-center h-32 border border-dashed border-gray-700/50 rounded-lg">
            <p className="text-xs text-gray-500 italic">{column.placeholder}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-gray-600">No creatives</p>
          </div>
        ) : (
          items.map((creative) => {
            // Compute 9:16 variant status for parent cards
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
// Main PipelineView component
// ---------------------------------------------------------------------------

export function PipelineView({ creatives = [], onStatusChange, onCardClick, onRefresh, loading }) {
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
            allCreatives={creatives}
          />
        ))}
      </div>
    </div>
  );
}

export default PipelineView;
