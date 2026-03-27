import { useMemo } from 'react';
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
    nextStatus: 'queued',
  },
  {
    key: 'queued',
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
  queued: { bg: 'bg-purple-500/80', text: 'text-white', label: 'Ready' },
  launched: { bg: 'bg-blue-500/80', text: 'text-white', label: 'Launched' },
};

// ---------------------------------------------------------------------------
// Creative card
// ---------------------------------------------------------------------------

function CreativeCard({ creative, column, onStatusChange, onCardClick }) {
  const badge = STATUS_BADGE[creative.status] || STATUS_BADGE.review;
  const angleLabel = [creative.angle, creative.aspect_ratio]
    .filter(Boolean)
    .join(' \u00b7 ');

  return (
    <div
      onClick={() => onCardClick?.(creative)}
      className="group bg-[#1a1a2e] border border-gray-700/60 rounded-lg overflow-hidden cursor-pointer
                 hover:border-gray-500/60 hover:shadow-lg hover:shadow-black/20 transition-all duration-150"
    >
      {/* Thumbnail */}
      <div className="relative aspect-square bg-black/30">
        {creative.image_url ? (
          <img
            src={creative.image_url}
            alt={creative.product_name || 'Creative'}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <Eye className="w-8 h-8" />
          </div>
        )}

        {/* Status badge overlay */}
        <span
          className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Info */}
      <div className="p-3 space-y-1.5">
        <p className="text-sm font-medium text-gray-100 truncate">
          {creative.product_name || 'Untitled'}
        </p>

        {angleLabel && (
          <p className="text-xs text-gray-400 truncate">{angleLabel}</p>
        )}

        {/* Action button */}
        {column.actionLabel && (
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
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline column
// ---------------------------------------------------------------------------

function PipelineColumn({ column, items, onStatusChange, onCardClick }) {
  const Icon = column.icon;

  return (
    <div className="flex flex-col min-w-[260px] max-w-[320px] flex-1">
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
      <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4 custom-scrollbar">
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

export function PipelineView({ creatives = [], onStatusChange, onCardClick, onRefresh, loading }) {
  // Bucket creatives into columns by status
  const buckets = useMemo(() => {
    const map = { review: [], approved: [], queued: [], launched: [] };
    for (const c of creatives) {
      const key = c.status in map ? c.status : 'review';
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
          />
        ))}
      </div>
    </div>
  );
}

export default PipelineView;
