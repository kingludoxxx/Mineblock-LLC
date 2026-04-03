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
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS = [
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
    actionLabel: 'Launch',
    nextStatus: 'launched',
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

function CreativeCard({ creative, column, onStatusChange, onCardClick, variantStatus }) {
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
      className="animated-border-gradient rounded-xl cursor-grab active:cursor-grabbing"
    >
      <div className="glass-card border border-white/[0.05] rounded-xl overflow-hidden group hover:border-white/[0.1] transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] relative z-10">
        {/* Thumbnail */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-black/40">
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 gap-1.5">
            {creative.status === 'generating' ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-[#c9a84c]" />
                <span className="text-[9px] text-[#c9a84c]/70">Generating…</span>
              </>
            ) : (
              <Eye className="w-5 h-5" />
            )}
          </div>
          {creative.image_url && creative.status !== 'generating' && (
            <img
              src={creative.image_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          )}
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span className="text-[10px] font-medium text-white bg-white/[0.15] backdrop-blur-sm px-2.5 py-1 rounded-full">
              View Full
            </span>
          </div>
          {/* Variant indicator */}
          {creative.parent_creative_id && (
            <span className="absolute top-2 left-2 text-[9px] font-mono bg-[#c9a84c]/20 text-[#e8d5a3] px-1.5 py-0.5 rounded border border-[#c9a84c]/30 backdrop-blur-md">
              Variant
            </span>
          )}
          {/* Ratio pills — top right */}
          {!creative.parent_creative_id && (
            <div className="absolute top-2 right-2 flex items-center gap-1">
              <RatioPill label={creative.aspect_ratio || '4:5'} status="done" />
              <RatioPill label="9:16" status={variantStatus || null} />
            </div>
          )}
          {creative.parent_creative_id && (
            <span className="absolute top-2 right-2 text-[9px] font-mono bg-black/50 text-zinc-300 px-1.5 py-0.5 rounded border border-white/[0.1] backdrop-blur-md">
              9:16
            </span>
          )}
        </div>

        {/* Info */}
        <div className="p-3 space-y-3">
          <div>
            <h4 className="text-xs font-medium text-zinc-200 mb-1 truncate">
              {creative.product_name || 'Untitled'}
            </h4>
            {creative.angle && (
              <span className="text-[10px] text-zinc-500">{creative.angle}</span>
            )}
          </div>

          {/* Action button */}
          {column.actionLabel ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange?.(creative.id, column.nextStatus);
              }}
              className={`w-full py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer
                ${column.color === 'green'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                  : column.color === 'cyan'
                    ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20 hover:bg-cyan-500/20'
                    : 'bg-white/[0.03] text-zinc-300 border-white/[0.05] hover:bg-white/[0.06]'
                }`}
            >
              {column.actionLabel}
            </button>
          ) : null}
        </div>
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
      className="flex flex-col min-w-[200px] max-w-[280px] flex-1 relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Column header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/[0.04] relative">
        <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-current to-transparent opacity-30" />
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${column.iconClass}`} />
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
            {column.label}
          </h3>
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${column.badgeBg} ${column.badgeText} ${column.badgeBorder}`}>
          {items.length}
        </span>
      </div>

      {/* Scrollable card list */}
      <div className={`flex-1 overflow-y-auto pr-2 space-y-4 pb-4 custom-scrollbar transition-colors rounded-lg ${dragOver ? 'bg-white/[0.03] ring-1 ring-[#c9a84c]/30' : ''}`}>
        {items.length === 0 && column.placeholder ? (
          <div className="h-32 border border-dashed border-white/[0.08] rounded-xl flex items-center justify-center text-sm text-zinc-600 italic bg-white/[0.01]">
            {column.placeholder}
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-zinc-600">No creatives</p>
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

export function PipelineView({ creatives = [], onStatusChange, onCardClick, onRefresh, loading, onOpenTemplates, onOpenCopySets }) {
  // Bucket creatives into columns by status
  // Variants (9:16 children) are shown as pills on their parent card, not as separate cards
  const buckets = useMemo(() => {
    const map = { review: [], approved: [], ready: [], launched: [] };
    for (const c of creatives) {
      if (c.status === 'rejected') continue;
      if (c.parent_creative_id) continue;
      if (c.status === 'generating') continue;
      const status = c.status === 'queued' ? 'ready' : c.status;
      const key = status in map ? status : 'review';
      map[key].push(c);
    }
    return map;
  }, [creatives]);

  // Launch state
  const [selectedForLaunch, setSelectedForLaunch] = useState([]);
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [launchTemplates, setLaunchTemplates] = useState([]);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);

  // Fetch launch templates
  useEffect(() => {
    api.get('/brief-pipeline/launch-templates')
      .then(({ data }) => setLaunchTemplates(data.data || []))
      .catch(() => {});
  }, []);

  const toggleSelectForLaunch = (id) => {
    setSelectedForLaunch(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleLaunch = async (templateId) => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const { data } = await api.post('/brief-pipeline/launch', {
        brief_ids: selectedForLaunch,
        template_id: templateId,
      });
      // Update statuses locally
      const launchedIds = (data.data?.results || []).filter(r => r.status === 'launched').map(r => r.brief_id);
      for (const id of launchedIds) {
        onStatusChange?.(id, 'launched');
      }
      const failed = (data.data?.results || []).filter(r => r.status === 'failed');
      if (failed.length) {
        setLaunchError(`${launchedIds.length} launched, ${failed.length} failed`);
      }
      setSelectedForLaunch([]);
      setLaunchModalOpen(false);
      onRefresh?.();
    } catch (err) {
      setLaunchError(err.response?.data?.error?.message || 'Launch failed');
    } finally {
      setLaunching(false);
    }
  };

  // Custom status change handler — intercept "launched" to use Meta launch flow
  const handleStatusChange = (id, newStatus) => {
    if (newStatus === 'launched') {
      // Instead of directly changing status, add to launch selection
      if (!selectedForLaunch.includes(id)) {
        setSelectedForLaunch(prev => [...prev, id]);
      }
      setLaunchModalOpen(true);
      return;
    }
    onStatusChange?.(id, newStatus);
  };

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

      {/* Launch selection bar */}
      {selectedForLaunch.length > 0 && (
        <div className="mb-4 glass-card border border-cyan-500/20 rounded-lg px-4 py-3 flex items-center justify-between animate-[fadeIn_0.2s_ease-out]">
          <span className="text-xs font-mono text-cyan-300">
            {selectedForLaunch.length} creative{selectedForLaunch.length > 1 ? 's' : ''} selected for launch
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedForLaunch([])} className="text-xs text-zinc-400 hover:text-white px-2 py-1 cursor-pointer">Clear</button>
            <button
              onClick={() => setLaunchModalOpen(true)}
              disabled={launching}
              className="inline-flex items-center gap-1.5 bg-cyan-500 hover:bg-cyan-600 text-white text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer disabled:opacity-50"
            >
              {launching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              Launch to Meta
            </button>
          </div>
        </div>
      )}

      {/* Error toast */}
      {launchError && (
        <div className="mb-4 glass-card border border-red-500/20 rounded-lg px-4 py-2 flex items-center justify-between">
          <span className="text-xs text-red-300">{launchError}</span>
          <button onClick={() => setLaunchError(null)} className="text-red-400 hover:text-red-200 text-xs cursor-pointer">Dismiss</button>
        </div>
      )}

      {/* Columns */}
      <div className="flex gap-6 flex-1 min-h-0 overflow-x-auto">
        {COLUMNS.map((col) => (
          <PipelineColumn
            key={col.key}
            column={col}
            items={buckets[col.key]}
            onStatusChange={handleStatusChange}
            onCardClick={onCardClick}
            allCreatives={creatives}
          />
        ))}
      </div>

      {/* Launch confirmation modal */}
      {launchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !launching && setLaunchModalOpen(false)}>
          <div className="glass-card border border-white/[0.08] rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-mono font-semibold text-white uppercase tracking-wide flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-400" />
                Launch {selectedForLaunch.length} Creative{selectedForLaunch.length > 1 ? 's' : ''} to Meta
              </h3>
              <button onClick={() => setLaunchModalOpen(false)} className="text-zinc-500 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>

            <div className="space-y-3 mb-6">
              <div>
                <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-1.5">Launch Template</label>
                <select
                  id="statics-launch-template"
                  className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20"
                  defaultValue=""
                >
                  <option value="" disabled>Select a template...</option>
                  {launchTemplates.map(t => (
                    <option key={t.id} value={t.id}>{t.name} — {t.ad_account_name || t.ad_account_id}</option>
                  ))}
                </select>
                {launchTemplates.length === 0 && (
                  <p className="text-[10px] text-zinc-500 mt-1">No templates yet. Create one in Templates.</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 justify-end">
              <button onClick={() => setLaunchModalOpen(false)} disabled={launching} className="text-xs text-zinc-400 hover:text-white px-3 py-2 cursor-pointer">Cancel</button>
              <button
                onClick={() => {
                  const sel = document.getElementById('statics-launch-template');
                  if (!sel?.value) return;
                  handleLaunch(sel.value);
                }}
                disabled={launching || launchTemplates.length === 0}
                className="inline-flex items-center gap-1.5 bg-cyan-500 hover:bg-cyan-600 text-white text-xs font-semibold px-4 py-2 rounded-lg cursor-pointer disabled:opacity-50"
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
