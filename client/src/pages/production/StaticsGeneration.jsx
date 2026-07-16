import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ImagePlus,
  Sparkles,
  Download,
  ChevronDown,
  ChevronRight,
  Upload,
  X,
  Loader2,
  Layers,
  ArrowRight,
  Check,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  FileText,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Image,
  RefreshCw,
  Eye,
  Pencil,
  Clock,
  Rocket,
  CheckCircle2,
  CircleDot,
  Send,
  BookOpen,
  Filter,
  Settings,
  Brain,
  Trash2,
  ListPlus,
} from 'lucide-react';
import api from '../../services/api';
import ProductSelector from '../../components/ProductSelector';
import { PipelineView } from './statics/PipelineView';
import { LibraryView } from './statics/LibraryView';
import { TemplateSelectModal } from './statics/TemplateSelectModal';
import { CreativeDetailModal } from './statics/CreativeDetailModal';
import { CreativeDetailModalV2 } from './statics/CreativeDetailModalV2';
// EditImageEditor (full-screen chat-style editor) lives nested INSIDE
// CreativeDetailModalV2 — opened by the pink dot on the 1:1 ratio label.
// StaticsGeneration no longer needs to render it directly.
import { ConfigSidebar } from './statics/ConfigSidebar';
import { AddReferenceModal } from './statics/AddReferenceModal';
import { StaticsSettingsModal } from './statics/StaticsSettingsModal';
import TemplateAnalysisModal from './statics/TemplateAnalysisModal';
import LaunchTemplateEditor from './briefs/LaunchTemplateEditor';
import LaunchTemplatesListModal from './briefs/LaunchTemplatesListModal';
import AdCopySetsManager from './briefs/AdCopySetsManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

function downloadImage(url, filename = 'generated-creative.png') {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STANDARD_CREATIVE_STATUSES = ['review', 'ready', 'queued', 'launched'];
const ADVERTORIAL_STATUSES = ['draft', 'copy_review', 'copy_approved', 'images_pending', 'images_review', 'ready', 'queued', 'launched', 'archived'];

const STATUS_COLORS = {
  review: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/20' },
  approved: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/20' },
  queued: { bg: 'bg-accent-muted', text: 'text-accent-text', border: 'border-accent/20' },
  launched: { bg: 'bg-accent-muted', text: 'text-accent-text', border: 'border-accent/20' },
  draft: { bg: 'bg-slate-500/10', text: 'text-slate-300', border: 'border-slate-500/20' },
  copy_review: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/20' },
  images_pending: { bg: 'bg-accent-muted', text: 'text-accent-text', border: 'border-accent/20' },
  images_review: { bg: 'bg-cyan-500/10', text: 'text-cyan-300', border: 'border-cyan-500/20' },
  ready: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/20' },
  copy_approved: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/20' },
  archived: { bg: 'bg-slate-500/10', text: 'text-slate-300', border: 'border-slate-500/20' },
};

const VARIANT_TYPE_COLORS = {
  direct_adapt: { bg: 'bg-accent-muted', text: 'text-accent-text', border: 'border-accent/20', label: 'Direct Adapt' },
  pain_pivot: { bg: 'bg-orange-500/10', text: 'text-orange-300', border: 'border-orange-500/20', label: 'Pain Pivot' },
  creative_swing: { bg: 'bg-accent-muted', text: 'text-accent-text', border: 'border-accent/20', label: 'Creative Swing' },
};

const TOP_TABS = [
  { key: 'pipeline', label: 'Pipeline', icon: Rocket },
  { key: 'library', label: 'Library', icon: BookOpen },
  { key: 'generated', label: 'Generated', icon: Image },
  { key: 'settings', label: 'Logic & Settings', icon: Settings },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UploadZone({ preview, onFile, onUrlChange, urlValue, onClear, label, compact = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) onFile(file);
    },
    [onFile],
  );

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  };

  if (preview) {
    return (
      <div className="relative group">
        <img
          src={preview}
          alt={label}
          className={`w-full rounded-lg border border-white/[0.06] object-cover ${compact ? 'h-32' : 'h-48'}`}
        />
        <button
          type="button"
          onClick={onClear}
          className="absolute top-2 right-2 p-1 rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`flex flex-col items-center justify-center gap-2 border border-dashed rounded-lg cursor-pointer transition-colors ${
          compact ? 'py-4' : 'py-8'
        } ${
          dragging
            ? 'border-accent/50 bg-accent/5'
            : 'border-white/[0.1] hover:border-white/[0.2] bg-transparent'
        }`}
      >
        <ImagePlus className={`text-slate-600 ${compact ? 'w-5 h-5' : 'w-8 h-8'}`} />
        <span className="text-xs text-slate-500">
          {compact ? 'Click or drop image' : 'Click to upload or drag & drop'}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
      {onUrlChange && (
        <input
          type="text"
          value={urlValue || ''}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Or paste image URL..."
          className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-accent/50 focus:outline-none"
        />
      )}
    </div>
  );
}

function StepperIndicator({ step, currentStep, label }) {
  const isCompleted = currentStep > step;
  const isActive = currentStep === step;

  return (
    <div className="flex items-center gap-3 py-2">
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors ${
          isCompleted
            ? 'bg-emerald-600 text-white'
            : isActive
              ? 'bg-accent text-white'
              : 'bg-white/[0.04] text-slate-600 border border-white/[0.06]'
        }`}
      >
        {isCompleted ? <Check className="w-3.5 h-3.5" /> : step}
      </div>
      <span
        className={`text-sm ${isCompleted ? 'text-emerald-400' : isActive ? 'text-white' : 'text-slate-600'}`}
      >
        {label}
      </span>
      {isActive && <Loader2 className="w-4 h-4 text-accent-text animate-spin ml-auto" />}
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.draft;
  const display = (status || 'draft').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-full ${colors.bg} ${colors.text} border ${colors.border}`}>
      {display}
    </span>
  );
}

function VariantTypeBadge({ type }) {
  const config = VARIANT_TYPE_COLORS[type] || { bg: 'bg-slate-500/10', text: 'text-slate-300', border: 'border-slate-500/20', label: type };
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-full ${config.bg} ${config.text} border ${config.border}`}>
      {config.label}
    </span>
  );
}

function PipelineToggle({ active, onChange }) {
  return (
    <div className="flex p-1 bg-white/[0.02] rounded-lg border border-white/[0.05] inline-flex">
      <button
        type="button"
        onClick={() => onChange('standard')}
        className={`flex items-center justify-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
          active === 'standard'
            ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] border border-white/[0.06]'
            : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
        }`}
      >
        <Image className="w-3.5 h-3.5" />
        Standard Statics
      </button>
      <button
        type="button"
        onClick={() => onChange('advertorial')}
        className={`flex items-center justify-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
          active === 'advertorial'
            ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] border border-white/[0.06]'
            : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
        }`}
      >
        <FileText className="w-3.5 h-3.5" />
        Advertorial
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: derive a human-readable name for a creative that has no explicit name
// ---------------------------------------------------------------------------

function getCreativeName(creative) {
  if (creative.name) return creative.name;
  const parts = [];
  if (creative.angle) parts.push(creative.angle);
  if (creative.created_at) {
    const d = new Date(creative.created_at);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    parts.push(`${mm}/${dd}`);
  }
  return parts.length > 0 ? parts.join(' — ') : 'Untitled';
}

// ---------------------------------------------------------------------------
// Standard Pipeline — Creative Review Card
// ---------------------------------------------------------------------------

function CreativeReviewCard({ creative, onApprove, onReject }) {
  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
      {creative.image_url && (
        <img
          src={creative.image_url}
          alt={getCreativeName(creative)}
          className="w-full h-48 object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white truncate">
            {getCreativeName(creative)}
          </span>
          <StatusBadge status={creative.status || 'review'} />
        </div>
        {creative.angle && (
          <p className="text-xs text-slate-400">Angle: {creative.angle}</p>
        )}
        {creative.status === 'review' && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => onApprove(creative.id)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-sm text-emerald-300 hover:bg-emerald-600/30 transition-colors cursor-pointer"
            >
              <ThumbsUp className="w-3.5 h-3.5" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(creative.id)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              <ThumbsDown className="w-3.5 h-3.5" />
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advertorial Pipeline — Copy Card
// ---------------------------------------------------------------------------

function AdvertorialCopyCard({ copy, onStatusChange, onGenerateImages, generatingImages }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <VariantTypeBadge type={copy.variant_type} />
          <StatusBadge status={copy.status || 'draft'} />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </div>

      {/* Headline / preview */}
      <p className="text-sm text-white font-medium line-clamp-2">
        {copy.headline || copy.title || 'Untitled Variant'}
      </p>

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-white/[0.04]">
          {copy.body && (
            <div>
              <span className="text-xs text-slate-400 mb-1 block">Body</span>
              <p className="text-sm text-slate-300 whitespace-pre-line">{copy.body}</p>
            </div>
          )}
          {copy.cta && (
            <div>
              <span className="text-xs text-slate-400 mb-1 block">CTA</span>
              <span className="inline-block px-3 py-1.5 text-sm rounded-lg bg-accent text-white">
                {copy.cta}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => copyToClipboard(copy.body || copy.headline || '')}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-white transition-colors cursor-pointer"
          >
            <Copy className="w-3 h-3" />
            Copy text
          </button>
        </div>
      )}

      {/* Action buttons based on status */}
      <div className="flex flex-wrap gap-2 pt-1">
        {copy.status === 'draft' && (
          <button
            type="button"
            onClick={() => onStatusChange(copy.id, 'copy_review')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer"
          >
            <Eye className="w-3 h-3" />
            Send to Review
          </button>
        )}
        {copy.status === 'copy_review' && (
          <>
            <button
              type="button"
              onClick={() => onStatusChange(copy.id, 'images_pending')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-xs text-emerald-300 hover:bg-emerald-600/30 transition-colors cursor-pointer"
            >
              <ThumbsUp className="w-3 h-3" />
              Approve Copy
            </button>
            <button
              type="button"
              onClick={() => onStatusChange(copy.id, 'draft')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              <ThumbsDown className="w-3 h-3" />
              Reject
            </button>
          </>
        )}
        {copy.status === 'images_pending' && (
          <button
            type="button"
            onClick={() => onGenerateImages(copy.id)}
            disabled={generatingImages}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
              generatingImages
                ? 'bg-accent-muted border border-accent/20 text-accent-text/50 cursor-not-allowed'
                : 'bg-accent-muted border border-accent/20 text-accent-text hover:bg-accent/20'
            }`}
          >
            {generatingImages ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Image className="w-3 h-3" />
            )}
            Generate Images
          </button>
        )}
        {copy.status === 'images_review' && (
          <button
            type="button"
            onClick={() => onStatusChange(copy.id, 'ready')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-xs text-emerald-300 hover:bg-emerald-600/30 transition-colors cursor-pointer"
          >
            <CheckCircle2 className="w-3 h-3" />
            Approve Images
          </button>
        )}
        {copy.status === 'ready' && (
          <button
            type="button"
            onClick={() => onStatusChange(copy.id, 'launched')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-muted border border-accent/20 text-xs text-accent-text hover:bg-accent/20 transition-colors cursor-pointer"
          >
            <Rocket className="w-3 h-3" />
            Mark Launched
          </button>
        )}
      </div>

      {/* Image grid if images exist */}
      {copy.images && copy.images.length > 0 && (
        <div className="pt-2 border-t border-white/[0.04]">
          <span className="text-xs text-slate-400 mb-2 block">Generated Images</span>
          <div className="grid grid-cols-3 gap-2">
            {copy.images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.url || img}
                  alt={`Archetype ${i + 1}`}
                  className="w-full h-20 rounded-xl object-cover border border-white/[0.06]"
                />
                {img.archetype && (
                  <span className="absolute bottom-1 left-1 px-1.5 py-0.5 text-[9px] rounded bg-black/70 text-white">
                    {img.archetype}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generated Tab — History grid of all generated images
// ---------------------------------------------------------------------------

function GeneratedView({ creatives, loading, onRefresh, onCreativeClick }) {
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = statusFilter === 'all'
    ? creatives
    : creatives.filter((c) => c.status === statusFilter);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-500" />
          <div className="flex gap-1">
            {['all', ...STANDARD_CREATIVE_STATUSES].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer ${
                  statusFilter === s
                    ? 'bg-accent border-accent text-white'
                    : 'bg-transparent border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'
                }`}
              >
                {s === 'all' ? 'All' : s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Grid */}
      {filtered.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-center">
          <Image className="w-12 h-12 text-slate-700 mb-4" />
          <p className="text-sm text-slate-500">No generated images yet</p>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center min-h-[200px]">
          <Loader2 className="w-6 h-6 text-accent-text animate-spin" />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3">
          {filtered.map((creative) => (
            <button
              key={creative.id}
              type="button"
              onClick={() => onCreativeClick(creative)}
              className="group relative bg-[#0a0a0a] border border-white/[0.06] rounded-2xl overflow-hidden hover:border-white/[0.15] hover:shadow-lg hover:shadow-black/30 transition-all duration-200 cursor-pointer text-left"
            >
              {creative.image_url ? (
                <div className="relative w-full h-[120px]">
                  <img
                    src={creative.image_url}
                    alt={getCreativeName(creative)}
                    className="w-full h-[120px] object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      const fb = e.currentTarget.parentElement?.querySelector('.img-fallback');
                      if (fb) fb.style.display = 'flex';
                    }}
                  />
                  <div
                    className="img-fallback absolute inset-0 bg-white/[0.02] flex-col items-center justify-center gap-1"
                    style={{ display: 'none' }}
                  >
                    <Image className="w-5 h-5 text-slate-700" />
                    {creative.status === 'launched' && (
                      <span className="text-[9px] text-slate-600">Live on Meta</span>
                    )}
                  </div>
                  {/* P2: Quality warning badge */}
                  {creative.quality_warning && (
                    <div
                      className="absolute top-1.5 right-1.5 bg-orange-500/90 backdrop-blur-sm rounded-full p-1"
                      title={creative.quality_warning}
                    >
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full h-[120px] bg-white/[0.02] flex items-center justify-center">
                  <Image className="w-5 h-5 text-slate-700" />
                </div>
              )}
              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-2xl">
                <span className="text-[10px] font-medium text-white bg-white/[0.15] backdrop-blur-sm px-2.5 py-1 rounded-full">
                  View Full
                </span>
              </div>
              <div className="px-2.5 py-2 space-y-1">
                <p className="text-[11px] text-gray-200 font-medium truncate">
                  {getCreativeName(creative)}
                </p>
                <StatusBadge status={creative.status || 'review'} />
                {creative.quality_warning && (
                  <p className="text-[9px] text-orange-400 leading-tight truncate" title={creative.quality_warning}>
                    ⚠ {creative.quality_warning}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Per-Angle Analytics (embedded in Logic & Settings tab)
// ---------------------------------------------------------------------------

function AngleAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api.get('/statics-generation/analytics/by-angle');
        setData(res.data?.data || []);
      } catch (err) {
        setError(err.response?.data?.error?.message || err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-muted text-sm py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading angle data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-400 text-sm py-2">Failed to load analytics: {error}</div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-text-faint text-sm py-2">No generations in the last 90 days.</div>
    );
  }

  const maxTotal = Math.max(...data.map(r => r.total), 1);

  return (
    <div className="space-y-3">
      {data.map((row) => {
        const barW = Math.round((row.total / maxTotal) * 100);
        return (
          <div key={row.angle} className="bg-bg-elevated border border-border-default rounded-xl px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary truncate max-w-[60%]">{row.angle}</span>
              <div className="flex items-center gap-3 text-xs text-text-muted shrink-0">
                <span className="text-text-primary font-semibold">{row.total} generated</span>
                {row.total > 0 && (
                  <span className={`font-medium ${row.approval_rate >= 50 ? 'text-emerald-400' : row.approval_rate >= 25 ? 'text-amber-400' : 'text-red-400'}`}>
                    {row.approval_rate}% approved
                  </span>
                )}
              </div>
            </div>
            {/* Volume bar */}
            <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#c9a84c]/70 to-[#c9a84c]/30 rounded-full"
                style={{ width: `${barW}%` }}
              />
            </div>
            {/* Status breakdown */}
            <div className="flex items-center gap-3 text-[10px] text-text-faint">
              {row.approved > 0 && <span className="text-emerald-400">{row.approved} approved</span>}
              {row.launched > 0 && <span className="text-blue-400">{row.launched} launched</span>}
              {row.in_review > 0 && <span className="text-amber-400">{row.in_review} in review</span>}
              {row.rejected > 0 && <span className="text-red-400/70">{row.rejected} rejected</span>}
              {row.last_generated && (
                <span className="ml-auto">
                  last {new Date(row.last_generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Settings Component (for the "Logic & Settings" tab)
// ---------------------------------------------------------------------------

function StaticsSettingsInline() {
  // 3-prompt architecture (migration 036) — same shape as StaticsSettingsModal
  const SECTIONS = [
    {
      key: 'claude_analysis',
      label: '① Claude Analysis',
      icon: Brain,
      desc: 'Step 1 — Claude sees ref + product, emits JSON brief',
      vars: '{{PRODUCT_NAME}} {{PRODUCT_PRICE}} {{PRODUCT_DESCRIPTION}} {{ANGLE}} {{BRAND_VOICE}} {{CUSTOMER}} {{BIG_PROMISE}} {{DIFFERENTIATOR}} {{UNIQUE_MECHANISM}} {{KEY_BENEFITS}} {{TARGET_AUDIENCE}} {{PAIN_POINTS}} {{INGREDIENTS}} {{WINNING_ANGLES}} {{OBJECTIONS}} {{OFFER_HOOK}} {{PRICING}} {{COMPLIANCE}} {{PRODUCT_IMAGE_NOTE}}',
    },
    {
      key: 'nanobanana_image',
      label: '② NanoBanana Image',
      icon: ImagePlus,
      desc: 'Step 2 — NanoBanana sees only product image, generates ad from Claude\'s brief. Has access to the full product library context (Brand Voice, Big Promise, Angle, etc.) — use sparingly; NB likes terse prompts.',
      vars: '{{PRODUCT_NAME}} {{PRODUCT_INSTRUCTION}} {{PRODUCT_RULE}} {{VISUAL_CHANGES}} {{TEXT_SWAPS}} {{PEOPLE_COUNT}} {{CHARACTER_ADAPTATION}} | {{SHORT_NAME}} {{ONELINER}} {{TAGLINE}} {{CATEGORY}} {{PRODUCT_TYPE}} {{PRODUCT_DESCRIPTION}} {{ANGLE}} {{BRAND_VOICE}} {{BIG_PROMISE}} {{UNIQUE_MECHANISM}} {{DIFFERENTIATOR}} {{COMPETITIVE_EDGE}} {{CUSTOMER}} {{CUSTOMER_FRUSTRATION}} {{CUSTOMER_DREAM}} {{PAIN_POINTS}} {{KEY_BENEFITS}} {{TARGET_AUDIENCE}} {{COMPLIANCE}} {{NOTES}}',
    },
    {
      key: 'openai_image',
      label: '②′ OpenAI Image',
      icon: ImagePlus,
      desc: 'Step 2 alt — OpenAI gpt-image-2 renderer. Used when the engine pill is set to OpenAI. Receives the FULL product library context so the visual tone stays on-brand.',
      vars: '{{PRODUCT_NAME}} {{PRODUCT_INSTRUCTION}} {{PRODUCT_RULE}} {{VISUAL_CHANGES}} {{TEXT_SWAPS}} {{PEOPLE_COUNT}} {{CHARACTER_ADAPTATION}} | {{SHORT_NAME}} {{ONELINER}} {{TAGLINE}} {{CATEGORY}} {{PRODUCT_TYPE}} {{PRODUCT_DESCRIPTION}} {{ANGLE}} {{BRAND_VOICE}} {{BIG_PROMISE}} {{UNIQUE_MECHANISM}} {{DIFFERENTIATOR}} {{COMPETITIVE_EDGE}} {{CUSTOMER}} {{CUSTOMER_FRUSTRATION}} {{CUSTOMER_DREAM}} {{PAIN_POINTS}} {{KEY_BENEFITS}} {{TARGET_AUDIENCE}} {{COMPLIANCE}} {{NOTES}}',
    },
    {
      key: 'ai_adjustment',
      label: '③ AI Adjustment',
      icon: Brain,
      desc: 'Optional Step — Claude turns user\'s freeform correction into a precise NanoBanana regen prompt',
      vars: '{{PRODUCT_NAME}} {{ANGLE}} {{ADAPTED_HEADLINE}} {{ADAPTED_CTA}} {{PEOPLE_COUNT}} {{USER_CORRECTION}}',
    },
    {
      key: 'nanobanana_iteration',
      label: '④ NanoBanana Iteration',
      icon: ImagePlus,
      desc: 'Used when iterating a TripleWhale winner via NanoBanana. JSON director\'s brief with strategy-locked single-variable isolation (Hook/CTA/Visual/Proof/Offer auto-assigned).',
      vars: '{{STRATEGY_LABEL}} {{VARIED}} {{LOCKED}} | {{PRODUCT_NAME}} {{PRODUCT_INSTRUCTION}} {{PRODUCT_RULE}} {{VISUAL_CHANGES}} {{TEXT_SWAPS}} {{PEOPLE_COUNT}} {{CHARACTER_ADAPTATION}} {{ANGLE}} {{BRAND_VOICE}}',
    },
    {
      key: 'openai_iteration',
      label: '④′ OpenAI Iteration',
      icon: ImagePlus,
      desc: 'Used when iterating a TripleWhale winner via OpenAI gpt-image-2. Same JSON shape as openai_image plus the iteration_directive block.',
      vars: '{{STRATEGY_LABEL}} {{VARIED}} {{LOCKED}} | {{PRODUCT_NAME}} {{PRODUCT_INSTRUCTION}} {{PRODUCT_RULE}} {{VISUAL_CHANGES}} {{TEXT_SWAPS}} {{PEOPLE_COUNT}} {{CHARACTER_ADAPTATION}} | {{SHORT_NAME}} {{ONELINER}} {{TAGLINE}} {{CATEGORY}} {{PRODUCT_TYPE}} {{PRODUCT_DESCRIPTION}} {{ANGLE}} {{BRAND_VOICE}} {{BIG_PROMISE}} {{UNIQUE_MECHANISM}} {{DIFFERENTIATOR}} {{COMPETITIVE_EDGE}} {{CUSTOMER}} {{CUSTOMER_FRUSTRATION}} {{CUSTOMER_DREAM}} {{PAIN_POINTS}} {{KEY_BENEFITS}} {{TARGET_AUDIENCE}} {{COMPLIANCE}} {{NOTES}}',
    },
  ];

  const [activeSection, setActiveSection] = useState('claude_analysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({});
  const [values, setValues] = useState({});
  const [toast, setToast] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get('/statics-generation/settings/prompts');
        const defs = data?.defaults || {};
        const cur = data?.current || {};
        setDefaults(defs);
        const merged = {};
        for (const s of SECTIONS) {
          merged[s.key] = cur[s.key] ?? defs[s.key] ?? '';
        }
        setValues(merged);
      } catch (err) {
        console.error('Failed to load prompts:', err);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (key, value) => {
    setValues(prev => ({ ...prev, [key]: value }));
  };

  const isFieldCustom = (key) => {
    return (values?.[key] ?? '') !== (defaults?.[key] ?? '');
  };

  const handleResetField = (key) => {
    handleChange(key, defaults?.[key] ?? '');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/statics-generation/settings/prompts', { prompts: values });
      setToast({ type: 'success', message: 'Prompts saved' });
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.message || 'Failed to save';
      setToast({ type: 'error', message: msg });
      setTimeout(() => setToast(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    try {
      await api.post('/statics-generation/settings/prompts/reset');
      const { data } = await api.get('/statics-generation/settings/prompts');
      const defs = data?.defaults || {};
      setDefaults(defs);
      const merged = {};
      for (const s of SECTIONS) merged[s.key] = defs[s.key] ?? '';
      setValues(merged);
      setToast({ type: 'success', message: 'All 3 prompts reset to defaults' });
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast({ type: 'error', message: 'Failed to reset' });
      setTimeout(() => setToast(null), 3000);
    }
  };

  const section = SECTIONS.find(s => s.key === activeSection) || SECTIONS[0];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Section tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          const isActive = activeSection === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setActiveSection(s.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'bg-accent/15 text-accent-text border border-accent/20'
                  : 'text-text-muted hover:text-text-primary bg-bg-elevated border border-border-default hover:bg-bg-hover'
              }`}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Step description + variables */}
      <div className="bg-bg-card border border-border-default rounded-xl p-4">
        <p className="text-xs text-text-muted leading-relaxed">{section.desc}</p>
        <p className="text-[11px] text-text-faint mt-1.5 font-mono break-words">
          Available variables: {section.vars}
        </p>
      </div>

      {/* Single textarea per prompt */}
      <div className="bg-bg-card border border-border-default rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-text-primary">Prompt template</h3>
          {isFieldCustom(activeSection) && (
            <button
              type="button"
              onClick={() => handleResetField(activeSection)}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to Default
            </button>
          )}
        </div>
        <textarea
          value={values?.[activeSection] ?? ''}
          onChange={(e) => handleChange(activeSection, e.target.value)}
          placeholder="Prompt template with {{VARIABLE}} markers..."
          rows={20}
          className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-[13px] text-text-primary font-mono placeholder:text-text-faint resize-y focus:outline-none focus:border-accent/30 transition-colors leading-relaxed"
        />
        <p className="text-[11px] text-text-faint mt-2">
          Use <span className="font-mono text-text-muted">{'{{VARIABLE}}'}</span> syntax for dynamic values. Unknown variables are replaced with empty string.
        </p>
      </div>

      {/* Actions bar */}
      <div className="flex items-center justify-between pt-2 pb-4">
        <button
          type="button"
          onClick={handleResetAll}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          Reset All 3 Prompts
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-hover text-bg-main shadow-[0_1px_12px_rgba(201,162,39,0.25)] transition-all cursor-pointer disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium shadow-lg ${
          toast.type === 'success'
            ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200'
            : 'bg-red-950/90 border-red-500/30 text-red-200'
        }`}>
          {toast.type === 'success' ? <Check className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

// LocalStorage key for the image-engine pill (survives refresh / new session).
const IMAGE_ENGINE_LS_KEY = 'mb.statics.imageEngine.v1';

export default function StaticsGeneration() {
  // Top-level tab
  const [activeTab, setActiveTab] = useState('pipeline');

  // Image engine selector — global per-session. Each /generate call sends
  // this in the body; the backend persists it on each saved creative so
  // refines / variants reuse the same engine. Defaults to NanoBanana.
  const [imageEngine, setImageEngine] = useState(() => {
    try { return localStorage.getItem(IMAGE_ENGINE_LS_KEY) || 'nanobanana'; }
    catch { return 'nanobanana'; }
  });
  const [availableEngines, setAvailableEngines] = useState([]);
  useEffect(() => {
    api.get('/statics-generation/image-engines')
      .then(r => setAvailableEngines(r.data?.data || []))
      .catch(() => setAvailableEngines([
        { name: 'nanobanana', label: 'NanoBanana', available: true },
        { name: 'openai',     label: 'OpenAI',     available: false },
      ]));
  }, []);
  const handleEngineChange = (name) => {
    setImageEngine(name);
    try { localStorage.setItem(IMAGE_ENGINE_LS_KEY, name); } catch { /* private mode */ }
  };

  // Pipeline sub-toggle
  // Advertorial pipeline was removed; only the standard pipeline remains.

  // =========================================================================
  // STANDARD PIPELINE STATE
  // =========================================================================

  // Form state
  const [referenceImageUrl, setReferenceImageUrl] = useState('');
  const [referenceFile, setReferenceFile] = useState(null);
  const [referencePreview, setReferencePreview] = useState('');
  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [productPrice, setProductPrice] = useState('');
  const [productImageUrl, setProductImageUrl] = useState('');
  const [productFile, setProductFile] = useState(null);
  const [productPreview, setProductPreview] = useState('');
  const [selectedProductImages, setSelectedProductImages] = useState([]); // extra images selected for generation
  const [marketingAngle, setMarketingAngle] = useState('');
  const [selectedAngleData, setSelectedAngleData] = useState(null); // full angle object from product library
  const [productAngles, setProductAngles] = useState([]); // angle buttons for the selected product
  const [customAngle, setCustomAngle] = useState('');
  const [aspectRatio, setAspectRatio] = useState('4:5');
  const [profileOpen, setProfileOpen] = useState(false);

  // Profile fields
  const [oneliner, setOneliner] = useState('');
  const [customerAvatar, setCustomerAvatar] = useState('');
  const [customerFrustration, setCustomerFrustration] = useState('');
  const [customerDream, setCustomerDream] = useState('');
  const [bigPromise, setBigPromise] = useState('');
  const [mechanism, setMechanism] = useState('');
  const [differentiator, setDifferentiator] = useState('');
  const [voice, setVoice] = useState('');
  const [guarantee, setGuarantee] = useState('');

  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedProductObj, setSelectedProductObj] = useState(null);
  const selectedProductRef = useRef(null); // full product object for generation

  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const addToast = useCallback((message, type = 'info', duration = 5000) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState(0);
  const [variantsExpanded, setVariantsExpanded] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [generatingAll, setGeneratingAll] = useState(false);

  // Queue state
  const [queue, setQueue] = useState([]);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const queueProcessingRef = useRef(false); // legacy single-slot guard, retained but no longer the bottleneck
  const queueRef = useRef([]);
  // Concurrency: how many queue items can run at the same time. 2 doubles
  // throughput vs the old single-threaded design while staying comfortably
  // under OpenAI/NB per-account concurrency caps. Bump cautiously.
  const MAX_CONCURRENT_QUEUE_ITEMS = 2;
  const queueInFlightCountRef = useRef(0);
  // Ref tracking which item IDs are currently being processed — prevents
  // the same item from being picked up by two parallel processNext calls
  // during the tiny window between findIndex and the updateStatus setState
  // that marks the item as 'generating'.
  const queueInFlightIdsRef = useRef(new Set());

  // Creative review state (Standard pipeline)
  const [creatives, setCreatives] = useState([]);
  const [creativesLoading, setCreativesLoading] = useState(false);
  const [references, setReferences] = useState(() => {
    try {
      const saved = localStorage.getItem('statics_references');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Restore template stubs (is_template: true) and URL-based refs; skip raw base64 uploads
        return Array.isArray(parsed)
          ? parsed.filter(r => r.is_template || (r.image_url && !r.image_url.startsWith('data:')))
          : [];
      }
    } catch {}
    return [];
  });

  // Templates state
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // Modal state
  const [detailModal, setDetailModal] = useState(null);
  const [templateModal, setTemplateModal] = useState(false);
  const [addRefModal, setAddRefModal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // editTarget state moved INTO CreativeDetailModalV2 (the chat-style editor
  // opens nested inside the detail modal). Removed here in the refactor.
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templatesVersion, setTemplatesVersion] = useState(0); // bumped after save → PipelineView re-fetches templates
  // Templates LIST modal (Templates button now opens this; New / Edit / Duplicate / Delete all dispatch from inside it)
  const [templatesListOpen, setTemplatesListOpen] = useState(false);
  const [templatesListData, setTemplatesListData] = useState([]);
  const [templatesListLoading, setTemplatesListLoading] = useState(false);
  const [copySetsOpen, setCopySetsOpen] = useState(false);
  const [analysisModalTemplate, setAnalysisModalTemplate] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null);

  // =========================================================================
  // ADVERTORIAL PIPELINE STATE
  // =========================================================================

  const [advSourceCopy, setAdvSourceCopy] = useState('');
  const [advSelectedProductId, setAdvSelectedProductId] = useState(null);
  const [advProductName, setAdvProductName] = useState('');
  const [advAngle, setAdvAngle] = useState('');
  const [advGenerating, setAdvGenerating] = useState(false);
  const [advCopies, setAdvCopies] = useState([]);
  const [advCopiesLoading, setAdvCopiesLoading] = useState(false);
  const [advError, setAdvError] = useState(null);
  const [advGeneratingImagesFor, setAdvGeneratingImagesFor] = useState(null);

  // =========================================================================
  // STANDARD PIPELINE HANDLERS
  // =========================================================================

  const handleProductSelect = async (product) => {
    if (!product) {
      setSelectedProductId(null);
      setSelectedProductObj(null);
      selectedProductRef.current = null;
      return;
    }
    // Fetch full product profile for rich data (benefits, pain_points, etc.)
    let fullProduct = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await api.get(`/product-profiles/${product.id}`);
        fullProduct = res.data.data || res.data;
        break;
      } catch (err) {
        console.error(`Failed to fetch full product profile (attempt ${attempt + 1}):`, err);
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); // wait 1s before retry
      }
    }

    if (fullProduct) {
      setSelectedProductId(fullProduct.id);
      setSelectedProductObj(fullProduct);
      selectedProductRef.current = fullProduct;
      setProductName(fullProduct.name || '');
      setProductDescription(fullProduct.description || '');
      setProductPrice(fullProduct.price || '');
      if (fullProduct.product_images?.length > 0) {
        setProductImageUrl(fullProduct.product_images[0]);
        setProductPreview(fullProduct.product_images[0]);
      }
      setOneliner(fullProduct.oneliner || '');
      setCustomerAvatar(fullProduct.customer_avatar || '');
      setCustomerFrustration(fullProduct.customer_frustration || '');
      setCustomerDream(fullProduct.customer_dream || '');
      setBigPromise(fullProduct.big_promise || '');
      setMechanism(fullProduct.mechanism || '');
      setDifferentiator(fullProduct.differentiator || '');
      setVoice(fullProduct.voice || '');
      setGuarantee(fullProduct.guarantee || '');
      // Load product angles for sidebar buttons
      const angles = fullProduct.angles || [];
      setProductAngles(angles);
      // Auto-select first angle if one exists, but don't override a user's existing choice
      if (angles.length > 0 && !marketingAngle) {
        setMarketingAngle(angles[0].name || '');
        setSelectedAngleData(angles[0]);
      }
    } else {
      // Fallback to partial product — warn user
      console.error('❌ Could not fetch full product profile after 2 attempts — using partial data');
      setSelectedProductId(product.id);
      setSelectedProductObj(product);
      selectedProductRef.current = product;
      setProductName(product.name || '');
    }
  };

  // Derived
  const hasReferenceImage = !!(referencePreview || referenceImageUrl);
  const hasProductImage = !!(productPreview || productImageUrl);
  const canGenerate = (hasReferenceImage || references.length > 0) && productName.trim() && !generating;

  const handleReferenceFile = useCallback((file) => {
    setReferencePreview((prev) => { if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setReferenceFile(file);
    setReferenceImageUrl('');
  }, []);

  // Persist references to localStorage.
  // Templates are stored as lightweight stubs {id, name, is_template: true} — their base64
  // image_url is too large for localStorage and is re-fetched on mount instead.
  // Raw file uploads (blob/data: URLs) are skipped entirely — they can't be serialized.
  useEffect(() => {
    try {
      const toSave = references
        .map(r => {
          if (r.is_template && r.id) return { id: r.id, name: r.name, is_template: true };
          if (r.image_url && !r.image_url.startsWith('data:') && !r.image_url.startsWith('blob:')) return r;
          return null;
        })
        .filter(Boolean);
      if (toSave.length > 0) {
        localStorage.setItem('statics_references', JSON.stringify(toSave));
      } else {
        localStorage.removeItem('statics_references');
      }
    } catch {}
  }, [references]);

  // Re-hydrate template image_urls after mount (stubs from localStorage have no image_url)
  useEffect(() => {
    const stubs = references.filter(r => r.is_template && !r.image_url);
    if (stubs.length === 0) return;
    api.get('/statics-templates').then(res => {
      const allTemplates = res.data?.data || res.data?.templates || [];
      setReferences(prev =>
        prev.map(ref => {
          if (!ref.is_template || ref.image_url) return ref;
          const found = allTemplates.find(t => t.id === ref.id);
          return found ? { ...ref, image_url: found.image_url } : ref;
        })
      );
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearReference = useCallback(() => {
    setReferencePreview((prev) => { if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev); return ''; });
    setReferenceFile(null);
    setReferenceImageUrl('');
  }, []);

  const handleProductFile = useCallback((file) => {
    setProductPreview((prev) => { if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setProductFile(file);
    setProductImageUrl('');
  }, []);

  const clearProduct = useCallback(() => {
    setProductPreview((prev) => { if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev); return ''; });
    setProductFile(null);
    setProductImageUrl('');
  }, []);

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setGenerating(true);
    setGenerationStep(1);
    setResult(null);
    setError(null);

    // Add a temporary item to the queue so it shows in the Generating column
    const directGenId = `direct-${crypto.randomUUID()}`;
    const directGenItem = {
      id: directGenId,
      references: references.map(r => ({ ...r })),
      angle: customAngle || marketingAngle,
      productName,
      status: 'generating',
      progress: 'Analyzing…',
      createdAt: Date.now(),
    };
    setQueue(prev => {
      const next = [...prev, directGenItem];
      queueRef.current = next;
      return next;
    });

    const removeDirectGen = () => {
      setQueue(prev => {
        const next = prev.filter(q => q.id !== directGenId);
        queueRef.current = next;
        return next;
      });
    };

    try {
      let resolvedReferenceUrl = referenceImageUrl;
      if (referenceFile) {
        resolvedReferenceUrl = await fileToBase64(referenceFile);
      }
      if (!resolvedReferenceUrl && references.length > 0) {
        const ref = references[0];
        resolvedReferenceUrl = ref.image_url || ref.thumbnail || ref.url || '';
        // If still empty and this is a template stub (hydration may not have completed),
        // fetch the template image inline before proceeding
        if (!resolvedReferenceUrl && ref.is_template && ref.id) {
          try {
            const tmplRes = await api.get('/statics-templates');
            const allTmpls = tmplRes.data?.data || tmplRes.data?.templates || [];
            const found = allTmpls.find(t => t.id === ref.id);
            if (found?.image_url) {
              resolvedReferenceUrl = found.image_url;
              setReferences(prev => prev.map(r => r.id === ref.id ? { ...r, image_url: found.image_url } : r));
            }
          } catch { /* fall through — server will reject with a clear error */ }
        }
      }

      // Guard: surface a clear error instead of a silent 400 from the server
      if (!resolvedReferenceUrl) {
        removeDirectGen();
        setError('No reference image found. Please select a template or upload an image before generating.');
        setGenerating(false);
        setGenerationStep(0);
        return;
      }

      // Guard: warn if product has no image — Gemini will hallucinate the product without one
      const fullProduct = selectedProductRef.current;
      if (fullProduct && !fullProduct.product_image_url && (!fullProduct.product_images || fullProduct.product_images.length === 0)) {
        removeDirectGen();
        setError(`"${fullProduct.name}" has no product image configured. Add a product image in the Product Library before generating.`);
        setGenerating(false);
        setGenerationStep(0);
        return;
      }

      let resolvedProductUrl = productImageUrl;
      if (productFile) {
        resolvedProductUrl = await fileToBase64(productFile);
      }

      const profile = {};
      if (oneliner) profile.oneliner = oneliner;
      if (customerAvatar) profile.customerAvatar = customerAvatar;
      if (customerFrustration) profile.customerFrustration = customerFrustration;
      if (customerDream) profile.customerDream = customerDream;
      if (bigPromise) profile.bigPromise = bigPromise;
      if (mechanism) profile.mechanism = mechanism;
      if (differentiator) profile.differentiator = differentiator;
      if (voice) profile.voice = voice;
      if (guarantee) profile.guarantee = guarantee;
      // Pass ALL product profile fields from library — every field matters for ad quality
      const full = selectedProductRef.current;
      if (full) {
        if (full.benefits) profile.benefits = full.benefits;
        if (full.pain_points) profile.painPoints = full.pain_points;
        if (full.common_objections) profile.commonObjections = full.common_objections;
        if (full.winning_angles) profile.winningAngles = full.winning_angles;
        if (full.custom_angles_text) profile.customAngles = full.custom_angles_text;
        if (full.competitive_edge) profile.competitiveEdge = full.competitive_edge;
        if (full.offer_details) profile.offerDetails = full.offer_details;
        if (full.max_discount) profile.maxDiscount = full.max_discount;
        if (full.discount_codes) profile.discountCodes = full.discount_codes;
        if (full.bundle_variants) profile.bundleVariants = full.bundle_variants;
        if (full.compliance_restrictions) profile.complianceRestrictions = full.compliance_restrictions;
        if (full.notes) profile.notes = full.notes;
        // Previously missing fields from product library
        if (full.target_demographics) profile.targetDemographics = full.target_demographics;
        if (full.tagline) profile.tagline = full.tagline;
        if (full.category) profile.category = full.category;
        if (full.product_type) profile.productType = full.product_type;
        if (full.product_url) profile.productUrl = full.product_url;
        if (full.unit_details) profile.unitDetails = full.unit_details;
        if (full.short_name) profile.shortName = full.short_name;
        if (full.offers && full.offers.length > 0) profile.offers = full.offers;
      }

      // Step 1: Submit to server (Claude analysis + NanoBanana submit — returns fast)
      setGenerationStep(1);
      // Detect template ID (UUID from library vs numeric timestamp from upload)
      const refTemplateId = references[0]?.id;
      const isTemplateUUID = typeof refTemplateId === 'string' && refTemplateId.includes('-');

      // Derive the deliberate shot index the operator picked in the sidebar
      // gallery. Falls back to 0 (image #1) whenever the URL isn't found in
      // product_images — the safest default and preserves legacy behavior.
      const _pImages = selectedProductRef.current?.product_images || [];
      const productImageIndex = Math.max(0, _pImages.indexOf(resolvedProductUrl));
      const response = await api.post('/statics-generation/generate', {
        reference_image_url: resolvedReferenceUrl,
        template_id: isTemplateUUID ? refTemplateId : undefined,
        product_id: selectedProductRef.current?.id || selectedProductId || undefined,
        product_image_index: productImageIndex,
        product: {
          id: selectedProductRef.current?.id || selectedProductId || undefined,
          name: productName,
          description: productDescription || undefined,
          price: productPrice || undefined,
          product_image_url: resolvedProductUrl,
          selected_product_images: selectedProductImages.length > 0 ? selectedProductImages : undefined,
          product_images: selectedProductRef.current?.product_images || [],
          logos: selectedProductRef.current?.logos || [],
          logo_url: selectedProductRef.current?.logo_url || undefined,
          brand_colors: selectedProductRef.current?.brand_colors || undefined,
          fonts: selectedProductRef.current?.fonts || undefined,
          profile: Object.keys(profile).length > 0 ? profile : undefined,
        },
        angle: customAngle || marketingAngle || undefined,
        angle_data: !customAngle && selectedAngleData ? selectedAngleData : undefined,
        ratio: 'all',
        image_engine: imageEngine,
      });

      const genResult = response.data?.data || response.data;
      const tasks = genResult.tasks || (genResult.taskId ? [{ taskId: genResult.taskId, ratio: '1:1' }] : []);

      if (tasks.length === 0) {
        removeDirectGen();
        setResult(genResult);
        setGenerationStep(0);
        return;
      }

      // Update queue card progress
      setQueue(prev => {
        const next = prev.map(q => q.id === directGenId ? { ...q, progress: `Generating ${tasks.length} ratio(s)…` } : q);
        queueRef.current = next;
        return next;
      });

      // Step 2: Poll ALL tasks in parallel
      setGenerationStep(2);

      const pollTask = async (task) => {
        // Hard cap ~8 min: 10×2s + 50×4s + 60×6s = 500s = 8m20s
        const maxPolls = 120;
        let consecutiveNetworkErrors = 0;
        for (let i = 0; i < maxPolls; i++) {
          const delay = i < 10 ? 2000 : (i < 60 ? 4000 : 6000);
          await new Promise(r => setTimeout(r, delay));
          try {
            const statusRes = await api.get(`/statics-generation/status/${task.taskId}`);
            consecutiveNetworkErrors = 0;
            const statusData = statusRes.data?.data || statusRes.data;
            if (statusData?.resultImageUrl) {
              return {
                ratio: task.ratio,
                imageUrl: statusData.resultImageUrl,
                taskId: task.taskId,
                claudeAnalysis: statusData.claudeAnalysis || null,
                swapPairs: statusData.swapPairs || null,
                qualityWarning: statusData.quality_warning || null,
              };
            }
            if (statusData?.status === 'failed' || statusData?.error) {
              throw new Error(`Generation failed for ${task.ratio}: ${statusData?.error || 'Unknown error'}`);
            }
          } catch (err) {
            // Let app-level "Generation failed" errors propagate; only swallow network blips.
            if (err.message?.startsWith('Generation failed')) throw err;
            consecutiveNetworkErrors++;
            if (consecutiveNetworkErrors >= 5) {
              throw new Error(`Network error polling for ${task.ratio}: ${err.message || 'unknown'}`);
            }
            // Otherwise retry the loop — transient 5xx / disconnect
          }
        }
        throw new Error(`Generation timed out for ${task.ratio}`);
      };

      const taskResults = await Promise.allSettled(tasks.map(pollTask));
      const completedTasks = taskResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
      const failedTasks = taskResults
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'Unknown error');

      if (completedTasks.length === 0) {
        throw new Error(failedTasks.join('; ') || 'All generation tasks failed');
      }
      if (failedTasks.length > 0) {
        const total = tasks.length;
        const succeeded = completedTasks.length;
        addToast(
          `${succeeded} of ${total} ratio${total !== 1 ? 's' : ''} generated successfully (${failedTasks.length} failed: ${failedTasks.join(', ')})`,
          'warning',
          10000,
        );
      }

      // Step 3: Save creatives — 1:1 first as the parent, then 9:16 as its
      // child (parent_creative_id pointing at 1:1). Frontend renders only the
      // parent card and shows the 9:16 variant inline as a ratio pill, so
      // each reference produces ONE card with two dimensions.
      setGenerationStep(3);
      const groupId = crypto.randomUUID();
      const currentRef = references[references.length - 1] || references[0];
      const resolvedRefUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || resolvedReferenceUrl;

      const parentTask = completedTasks.find(t => t.ratio === '1:1') || completedTasks[0];
      const childTasks = completedTasks.filter(t => t !== parentTask);

      const buildSavePayload = (task, parentId) => ({
        product_id: selectedProductId || null,
        product_name: productName,
        image_url: task.imageUrl,
        angle: marketingAngle || null,
        aspect_ratio: task.ratio,
        group_id: groupId,
        generation_task_id: task.taskId,
        adapted_text: task.claudeAnalysis?.adapted_text || genResult.adaptedText || genResult.claudeAnalysis?.adapted_text,
        swap_pairs: task.swapPairs || genResult.swapPairs,
        claude_analysis: task.claudeAnalysis || genResult.claudeAnalysis,
        reference_thumbnail: resolvedRefUrl,
        reference_name: currentRef?.name || 'Reference',
        source_label: currentRef?.source_label || currentRef?.name || null,
        pipeline: 'standard',
        quality_warning: task.qualityWarning || null,
        parent_creative_id: parentId || null,
        image_engine: genResult.image_engine || imageEngine,
        // Persist the operator's shot pick so regenerate + iterate honor it later.
        product_image_index: productImageIndex,
      });

      const parentRes = await api.post('/statics-generation/creatives', buildSavePayload(parentTask, null));
      const parentRow = parentRes.data?.data || parentRes.data;
      const parentId = parentRow?.id;

      const childRows = await Promise.all(childTasks.map(async (task) => {
        const r = await api.post('/statics-generation/creatives', buildSavePayload(task, parentId));
        return r.data?.data || r.data;
      }));

      const savedCreatives = [parentRow, ...childRows];

      const finalResult = {
        results: completedTasks,
        claudeAnalysis: genResult.claudeAnalysis,
        adaptedText: genResult.adaptedText,
        swapPairs: genResult.swapPairs,
      };
      setResult(finalResult);
      addToast(`${completedTasks.length} creatives generated (${completedTasks.map(t => t.ratio).join(' + ')}) & saved to Pipeline`, 'success', 8000);
      setGenerationStep(0);
      setCreatives(prev => [...savedCreatives, ...prev]);
      // Only clear references on success so a failed generation retains the template selection
      setReferences([]);
      setReferenceImageUrl('');
      setReferencePreview('');
      setReferenceFile(null);
    } catch (err) {
      const message =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        'An unexpected error occurred';
      setError(message);
      addToast(`Generation failed: ${message}`, 'error', 10000);
      setGenerationStep(0);
    } finally {
      removeDirectGen();
      setGenerating(false);
      // Catch-up fetch after direct generation to pick up server-side changes
      // (e.g. auto-generated 9:16 variants). Delay lets the server finish processing.
      setTimeout(() => fetchCreatives(true), 3000);
    }
  };

  const handleGenerateAnother = () => {
    setResult(null);
    setError(null);
    setGenerationStep(0);
  };

  // =========================================================================
  // GENERATE ALL ANGLES
  // Queues one generation request per product angle using the current reference
  // =========================================================================

  const handleGenerateAllAngles = async () => {
    if (!canGenerate || generatingAll || productAngles.length === 0) return;
    setGeneratingAll(true);

    let resolvedReferenceUrl = referenceImageUrl;
    if (referenceFile) {
      resolvedReferenceUrl = await fileToBase64(referenceFile);
    }
    if (!resolvedReferenceUrl && references.length > 0) {
      const ref = references[0];
      resolvedReferenceUrl = ref.image_url || ref.thumbnail || ref.url || '';
    }

    const full = selectedProductRef.current;
    const profile = {};
    if (full) {
      if (full.benefits) profile.benefits = full.benefits;
      if (full.pain_points) profile.painPoints = full.pain_points;
      if (full.winning_angles) profile.winningAngles = full.winning_angles;
      if (full.common_objections) profile.commonObjections = full.common_objections;
      if (full.offer_details) profile.offerDetails = full.offer_details;
      if (full.max_discount) profile.maxDiscount = full.max_discount;
      if (full.discount_codes) profile.discountCodes = full.discount_codes;
    }
    if (oneliner) profile.oneliner = oneliner;
    if (customerAvatar) profile.customerAvatar = customerAvatar;

    let queued = 0;
    let failed = 0;
    const submitted = []; // collect { angleObj, taskId } so we can poll+save in background
    const refTemplateId = references[0]?.id;
    const isTemplateUUID = typeof refTemplateId === 'string' && refTemplateId.includes('-');
    const currentRef = references[references.length - 1] || references[0];

    // Derive index once for this batch — every angle uses the same shot pick
    const _allAnglesImages = full?.product_images || [];
    const allAnglesImageIndex = Math.max(0, _allAnglesImages.indexOf(productImageUrl));

    for (const angleObj of productAngles) {
      try {
        const resp = await api.post('/statics-generation/generate', {
          reference_image_url: resolvedReferenceUrl,
          template_id: isTemplateUUID ? refTemplateId : undefined,
          product_id: full?.id || selectedProductId || undefined,
          product_image_index: allAnglesImageIndex,
          product: {
            id: full?.id || selectedProductId || undefined,
            name: productName,
            description: productDescription || undefined,
            price: productPrice || undefined,
            product_image_url: productImageUrl || undefined,
            product_images: full?.product_images || [],
            logos: full?.logos || [],
            logo_url: full?.logo_url || undefined,
            brand_colors: full?.brand_colors || undefined,
            profile: Object.keys(profile).length > 0 ? profile : undefined,
          },
          angle: angleObj.name,
          angle_data: angleObj,
        });
        const genData = resp.data?.data || resp.data;
        const taskId = genData?.taskId;
        if (taskId) submitted.push({ angleObj, taskId });
        queued++;
        // Small delay between submissions to avoid overwhelming the pipeline
        await new Promise(r => setTimeout(r, 400));
      } catch {
        failed++;
      }
    }

    setGeneratingAll(false);
    if (failed > 0) {
      addToast(`Queued ${queued}/${productAngles.length} angles — ${failed} failed to submit`, 'warning', 8000);
    } else {
      addToast(`All ${queued} angles queued — generating & saving in background`, 'success', 8000);
    }
    // Refresh pipeline shortly after submission
    setTimeout(() => fetchCreatives(true), 1500);

    // ── Background: poll each gen ID and save to DB when complete ──────────
    // This runs fire-and-forget so the UI stays responsive immediately.
    const groupId = crypto.randomUUID();
    const capturedProductId = selectedProductId;
    const capturedProductName = productName;
    const capturedRefUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || resolvedReferenceUrl;
    const capturedRefName = currentRef?.name || 'Reference';

    submitted.forEach(({ angleObj, taskId }) => {
      (async () => {
        try {
          // Poll until the server signals the image is ready
          let imageUrl = null;
          let claudeAnalysis = null;
          let qualityWarning = null;
          for (let i = 0; i < 120; i++) {
            const delay = i < 10 ? 2000 : (i < 60 ? 4000 : 6000);
            await new Promise(r => setTimeout(r, delay));
            try {
              const statusRes = await api.get(`/statics-generation/status/${taskId}`);
              const sd = statusRes.data?.data || statusRes.data;
              if (sd?.resultImageUrl) {
                imageUrl = sd.resultImageUrl;
                claudeAnalysis = sd.claudeAnalysis || null;
                qualityWarning = sd.quality_warning || null;
                break;
              }
              if (sd?.status === 'failed' || (sd?.error && sd.status !== 'processing')) break;
            } catch { /* transient network error — keep polling */ }
          }
          if (!imageUrl) return; // generation failed or timed out

          // Save creative to DB so it appears in the Pipeline
          await api.post('/statics-generation/creatives', {
            product_id: capturedProductId || null,
            product_name: capturedProductName,
            image_url: imageUrl,
            angle: angleObj.name || null,
            aspect_ratio: '1:1',
            group_id: groupId,
            generation_task_id: taskId,
            claude_analysis: claudeAnalysis,
            quality_warning: qualityWarning || undefined,
            reference_thumbnail: capturedRefUrl,
            reference_name: capturedRefName,
            pipeline: 'standard',
            product_image_index: allAnglesImageIndex,
          });
          // Refresh to surface the new card in the Pipeline
          fetchCreatives(true);
        } catch (e) {
          console.error(`[generateAll] Failed to save ${angleObj.name}:`, e.message);
        }
      })();
    });
  };

  // =========================================================================
  // QUEUE HANDLERS
  // =========================================================================

  const handleAddToQueue = () => {
    if (!selectedProductId) return;
    // Accept EITHER references[] (multi-ref / upload / template) OR a single
    // referenceImageUrl (card Select / modal Use as Reference). Mirrors the
    // canGenerate gate in ConfigSidebar.
    if (references.length === 0 && !referenceImageUrl) return;

    // Build the queue item's references array. Prefer references[] when set;
    // otherwise synthesize one entry from the single-pick referenceImageUrl.
    const itemReferences = references.length > 0
      ? references.map(r => ({ ...r }))
      : [{ id: Date.now(), image_url: referenceImageUrl, thumbnail: referencePreview || referenceImageUrl, name: 'Reference' }];

    const item = {
      id: crypto.randomUUID(),
      references: itemReferences,
      angle: marketingAngle,
      angleData: !customAngle && selectedAngleData ? selectedAngleData : null,
      customAngle: customAngle,
      productId: selectedProductId,
      productName: productName,
      productRef: selectedProductRef.current ? { ...selectedProductRef.current } : null,
      productDescription,
      productPrice,
      productImageUrl,
      // Snapshot the picked shot index at enqueue time — the picker state may
      // change before the queue runner fires, and each item must remember its
      // own pick (otherwise every item collapses to whatever the sidebar
      // shows at run time).
      productImageIndex: Math.max(0, (selectedProductRef.current?.product_images || []).indexOf(productImageUrl)),
      aspectRatio,
      // Profile fields snapshot
      oneliner, customerAvatar, customerFrustration, customerDream,
      bigPromise, mechanism, differentiator, voice, guarantee,
      status: 'queued',
      result: null,
      error: null,
      createdAt: Date.now(),
    };

    setQueue(prev => {
      const next = [...prev, item];
      queueRef.current = next;
      return next;
    });

    // Clear references after adding to queue so next template selection starts fresh
    setReferences([]);
    setReferenceImageUrl('');
    setReferencePreview('');
    setReferenceFile(null);

    const pendingCount = queue.filter(q => q.status === 'queued').length + 1;
    addToast(`Added to queue (${pendingCount} item${pendingCount > 1 ? 's' : ''} pending)`, 'info');
  };

  const handleRemoveFromQueue = (id) => {
    setQueue(prev => {
      const next = prev.filter(q => q.id !== id);
      queueRef.current = next;
      return next;
    });
  };

  const handleClearQueue = () => {
    // Only clear done/errored items; keep active (queued, generating) and direct-gen temp items
    setQueue(prev => {
      const next = prev.filter(q => q.id.startsWith('direct-') || q.status === 'queued' || q.status === 'generating');
      queueRef.current = next;
      return next;
    });
  };

  const handleRetryQueueItem = (id) => {
    setQueue(prev => {
      const next = prev.map(q => q.id === id ? { ...q, status: 'queued', error: null, result: null } : q);
      queueRef.current = next;
      return next;
    });
  };

  // Queue processor — runs up to MAX_CONCURRENT_QUEUE_ITEMS in parallel.
  // Was previously single-threaded (~4 min per queue item × N items).
  // Parallel-2 typically halves operator-perceived queue completion time.
  useEffect(() => {
    const hasQueued = queue.some(q => q.status === 'queued');
    const generatingCount = queue.filter(q => q.status === 'generating').length;

    // Wait if: nothing queued, the concurrency cap is hit, OR a non-queue
    // manual /generate is running (the manual button isn't queue-managed
    // so we don't risk overlapping its output with a queue item).
    if (!hasQueued) return;
    if (generatingCount >= MAX_CONCURRENT_QUEUE_ITEMS) return;
    if (queueInFlightCountRef.current >= MAX_CONCURRENT_QUEUE_ITEMS) return;
    if (generating) return;

    const processNext = async () => {
      // Atomic claim: pick an item AND immediately mark it claimed before
      // any await so a parallel useEffect fire can't grab the same item.
      const currentQueue = queueRef.current;
      const item = currentQueue.find(q => q.status === 'queued' && !queueInFlightIdsRef.current.has(q.id));
      if (!item) return;
      queueInFlightIdsRef.current.add(item.id);
      queueInFlightCountRef.current++;
      // Surface a single global "processing" flag for any UI that relied on it.
      if (queueInFlightCountRef.current > 0) {
        queueProcessingRef.current = true;
        setQueueProcessing(true);
      }

      // Mark as generating
      const updateStatus = (id, updates) => {
        setQueue(prev => {
          const next = prev.map(q => q.id === id ? { ...q, ...updates } : q);
          queueRef.current = next;
          return next;
        });
      };

      updateStatus(item.id, { status: 'generating', progress: `0/${item.references.length}` });

      try {
        const full = item.productRef;

        // Build profile once (shared across all references)
        const profile = {};
        if (item.oneliner) profile.oneliner = item.oneliner;
        if (item.customerAvatar) profile.customerAvatar = item.customerAvatar;
        if (item.customerFrustration) profile.customerFrustration = item.customerFrustration;
        if (item.customerDream) profile.customerDream = item.customerDream;
        if (item.bigPromise) profile.bigPromise = item.bigPromise;
        if (item.mechanism) profile.mechanism = item.mechanism;
        if (item.differentiator) profile.differentiator = item.differentiator;
        if (item.voice) profile.voice = item.voice;
        if (item.guarantee) profile.guarantee = item.guarantee;
        if (full) {
          if (full.benefits) profile.benefits = full.benefits;
          if (full.pain_points) profile.painPoints = full.pain_points;
          if (full.common_objections) profile.commonObjections = full.common_objections;
          if (full.winning_angles) profile.winningAngles = full.winning_angles;
          if (full.custom_angles_text) profile.customAngles = full.custom_angles_text;
          if (full.competitive_edge) profile.competitiveEdge = full.competitive_edge;
          if (full.offer_details) profile.offerDetails = full.offer_details;
          if (full.max_discount) profile.maxDiscount = full.max_discount;
          if (full.discount_codes) profile.discountCodes = full.discount_codes;
          if (full.bundle_variants) profile.bundleVariants = full.bundle_variants;
          if (full.compliance_restrictions) profile.complianceRestrictions = full.compliance_restrictions;
          if (full.notes) profile.notes = full.notes;
          // Previously missing fields from product library
          if (full.target_demographics) profile.targetDemographics = full.target_demographics;
          if (full.tagline) profile.tagline = full.tagline;
          if (full.category) profile.category = full.category;
          if (full.product_type) profile.productType = full.product_type;
          if (full.product_url) profile.productUrl = full.product_url;
          if (full.unit_details) profile.unitDetails = full.unit_details;
          if (full.short_name) profile.shortName = full.short_name;
          if (full.offers && full.offers.length > 0) profile.offers = full.offers;
        }

        const productPayload = {
          name: item.productName,
          description: item.productDescription || undefined,
          price: item.productPrice || undefined,
          product_image_url: item.productImageUrl || '',
          product_images: full?.product_images || [],
          logos: full?.logos || [],
          logo_url: full?.logo_url || undefined,
          brand_colors: full?.brand_colors || undefined,
          fonts: full?.fonts || undefined,
          profile: Object.keys(profile).length > 0 ? profile : undefined,
        };

        // Process references with overlapped execution:
        // While polling reference N's tasks, fire off reference N+1's generate call.
        // This overlaps the slow polling step with the fast Claude+NanoBanana submission.
        let totalCreatives = 0;
        const allErrors = [];

        const pollTask = async (task) => {
          const maxPolls = 120;
          let consecutiveNetworkErrors = 0;
          for (let i = 0; i < maxPolls; i++) {
            const delay = i < 10 ? 2000 : (i < 60 ? 4000 : 6000);
            await new Promise(r => setTimeout(r, delay));
            try {
              const statusRes = await api.get(`/statics-generation/status/${task.taskId}`);
              consecutiveNetworkErrors = 0;
              const statusData = statusRes.data?.data || statusRes.data;
              if (statusData?.resultImageUrl) {
                return { ratio: task.ratio, imageUrl: statusData.resultImageUrl, taskId: task.taskId };
              }
              if (statusData?.status === 'failed' || statusData?.error) {
                const errMsg = statusData?.error || `Generation failed (code ${statusData?.successFlag || '?'})`;
                throw new Error(`Failed for ${task.ratio}: ${errMsg}`);
              }
            } catch (err) {
              if (err.message?.startsWith('Failed for')) throw err;
              consecutiveNetworkErrors++;
              if (consecutiveNetworkErrors >= 5) {
                throw new Error(`Network error polling ${task.ratio}: ${err.message || 'unknown'}`);
              }
            }
          }
          throw new Error(`Timed out for ${task.ratio}`);
        };

        // Overlap: fire ref N+1's generate while ref N is still polling.
        // Each iteration awaits only the fast generate call (Step 1),
        // then lets polling (Step 2) run in the background.
        const refPromises = [];

        for (let refIdx = 0; refIdx < item.references.length; refIdx++) {
          updateStatus(item.id, { progress: `${refIdx + 1}/${item.references.length}` });

          // Start this reference's full pipeline (generate + poll).
          // The generate call resolves quickly; polling takes 30-60s.
          // We split so the next iteration can start its generate call
          // as soon as THIS generate call completes.
          const refPromise = (async (idx) => {
            const currentRef = item.references[idx];
            const refUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || '';

            try {
              // Step 1: Submit to server (fast)
              // Pass template_id if the reference is from the template library (UUID)
              const refId = currentRef?.id;
              const isRefTemplate = typeof refId === 'string' && refId.includes('-');

              // Queue item snapshotted the operator's product-image pick at
              // enqueue time (see productImageIndex field). Falls back to 0.
              const queueImageIndex = Number.isInteger(item.productImageIndex) ? item.productImageIndex : 0;
              const response = await api.post('/statics-generation/generate', {
                reference_image_url: refUrl,
                template_id: isRefTemplate ? refId : undefined,
                product_id: item.productId || undefined,
                product_image_index: queueImageIndex,
                product: productPayload,
                angle: item.customAngle || item.angle || undefined,
                angle_data: !item.customAngle && item.angleData ? item.angleData : undefined,
                ratio: 'all',
              });

              const genResult = response.data?.data || response.data;
              const tasks = genResult.tasks || (genResult.taskId ? [{ taskId: genResult.taskId, ratio: '1:1' }] : []);

              // Signal that generate is done — next ref can start
              return { genDone: true, pollPromise: (async () => {
                if (tasks.length === 0) return;

                // Step 2: Poll tasks (slow)
                const taskResults = await Promise.allSettled(tasks.map(pollTask));
                const completedTasks = taskResults.filter(r => r.status === 'fulfilled').map(r => r.value);
                const failedTasks = taskResults.filter(r => r.status === 'rejected').map(r => r.reason?.message);

                if (failedTasks.length > 0) allErrors.push(...failedTasks);
                if (completedTasks.length === 0) return;

                // Step 3: Save creatives — 1:1 as parent, 9:16 as child of 1:1.
                const groupId = crypto.randomUUID();
                const resolvedRefUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || refUrl;

                const parentTask = completedTasks.find(t => t.ratio === '1:1') || completedTasks[0];
                const childTasks = completedTasks.filter(t => t !== parentTask);

                const buildPayload = (task, parentId) => ({
                  product_id: item.productId || null,
                  product_name: item.productName,
                  image_url: task.imageUrl,
                  angle: item.angle || null,
                  aspect_ratio: task.ratio,
                  group_id: groupId,
                  generation_task_id: task.taskId,
                  adapted_text: task.claudeAnalysis?.adapted_text || genResult.adaptedText || genResult.claudeAnalysis?.adapted_text,
                  swap_pairs: task.swapPairs || genResult.swapPairs,
                  claude_analysis: task.claudeAnalysis || genResult.claudeAnalysis,
                  reference_thumbnail: resolvedRefUrl,
                  reference_name: currentRef?.name || 'Reference',
                  source_label: currentRef?.source_label || currentRef?.name || null,
                  pipeline: 'standard',
                  parent_creative_id: parentId || null,
                  // Persist the shot pick so regenerate + iterate honor it.
                  product_image_index: queueImageIndex,
                });

                const parentRes = await api.post('/statics-generation/creatives', buildPayload(parentTask, null));
                const parentRow = parentRes.data?.data || parentRes.data;
                const parentId = parentRow?.id;

                const childRows = await Promise.all(childTasks.map(async (task) => {
                  const r = await api.post('/statics-generation/creatives', buildPayload(task, parentId));
                  return r.data?.data || r.data;
                }));

                const savedCreatives = [parentRow, ...childRows];

                setCreatives(prev => [...savedCreatives, ...prev]);
                totalCreatives += completedTasks.length;
              })() };
            } catch (refErr) {
              allErrors.push(`Ref ${idx + 1}: ${refErr.response?.data?.error || refErr.message}`);
              return { genDone: true, pollPromise: Promise.resolve() };
            }
          })(refIdx);

          // Wait for this ref's generate (Step 1) to finish before starting the next.
          // But do NOT wait for its polling (Step 2) — that runs in the background.
          const result = await refPromise;
          refPromises.push(result.pollPromise);
        }

        // Wait for all polling + saving to complete
        await Promise.allSettled(refPromises);

        if (totalCreatives === 0 && allErrors.length > 0) {
          throw new Error(allErrors.join('; '));
        }

        updateStatus(item.id, {
          status: allErrors.length > 0 ? 'partial' : 'done',
          result: { creativeCount: totalCreatives },
          error: allErrors.length > 0 ? allErrors.join('; ') : null,
        });

        if (allErrors.length > 0) {
          addToast(`Queue: ${totalCreatives} creatives done, ${allErrors.length} error(s): ${allErrors.join('; ')}`, 'warning', 6000);
        } else {
          addToast(`Queue: ${totalCreatives} creative${totalCreatives !== 1 ? 's' : ''} generated from ${item.references.length} ref${item.references.length !== 1 ? 's' : ''}`, 'success', 4000);
        }
      } catch (err) {
        const message = err.response?.data?.error || err.response?.data?.message || err.message || 'An unexpected error occurred';
        updateStatus(item.id, { status: 'error', error: message });
        addToast(`Queue item failed: ${message}`, 'error', 6000);
      } finally {
        // Release the slot
        queueInFlightCountRef.current = Math.max(0, queueInFlightCountRef.current - 1);
        queueInFlightIdsRef.current.delete(item.id);
        if (queueInFlightCountRef.current === 0) {
          queueProcessingRef.current = false;
          setQueueProcessing(false);
        }
        // Catch-up fetch after queue item to pick up server-side 9:16 variants
        setTimeout(() => fetchCreatives(true), 3000);
      }
    };

    // Try to start as many items as the concurrency budget allows in this
    // effect fire. Each call increments queueInFlightCountRef before any
    // await so subsequent calls in the same tick honor the cap correctly.
    while (
      queueInFlightCountRef.current < MAX_CONCURRENT_QUEUE_ITEMS &&
      queueRef.current.some(q => q.status === 'queued' && !queueInFlightIdsRef.current.has(q.id))
    ) {
      processNext();
    }
  }, [queue, queueProcessing, generating]);

  // Fetch creatives for pipeline
  // `silent` skips the loading spinner — used by auto-refresh so the UI
  // doesn't flash a spinner every 8 seconds while items are generating.
  const fetchCreatives = async (silent = false, _retryCount = 0) => {
    if (!silent) setCreativesLoading(true);
    try {
      const res = await api.get('/statics-generation/creatives/pipeline');
      const pipeline = res.data?.data || {};
      const variants = res.data?.variants || [];
      const flat = [
        ...(pipeline.generating || []),
        ...(pipeline.review || []),
        ...(pipeline.ready || []),
        ...(pipeline.launched || []),
        ...variants,
      ];
      setCreatives(flat);
      // If result is unexpectedly empty on initial (non-silent) load, retry once after 1.5s
      // to handle transient auth/network hiccups that silently return empty data.
      if (!silent && flat.length === 0 && _retryCount === 0) {
        setTimeout(() => fetchCreatives(true, 1), 1500);
      }
    } catch {
      // Retry once on failure
      if (_retryCount === 0) {
        setTimeout(() => fetchCreatives(true, 1), 1500);
      }
    } finally {
      if (!silent) setCreativesLoading(false);
    }
  };

  // Fetch all creatives (for Generated tab)
  const fetchAllCreatives = async () => {
    setCreativesLoading(true);
    try {
      const res = await api.get('/statics-generation/creatives');
      setCreatives(res.data?.data || res.data || []);
    } catch {
      // silently fail
    } finally {
      setCreativesLoading(false);
    }
  };

  // Fetch templates
  const fetchTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const res = await api.get('/statics-templates');
      const data = res.data?.data || res.data || [];
      setTemplates(data);
      // Only mark as fetched if we actually got data — on server cold-start
      // the first request can 500, leaving templates empty forever because
      // templatesFetched.current was already set to true.
      if (Array.isArray(data) && data.length > 0) {
        templatesFetched.current = true;
      }
    } catch {
      // silently fail — templatesFetched.current stays false so next
      // interaction retries the fetch
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleApproveCreative = async (id) => {
    try {
      await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'ready' });
      setCreatives((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'ready' } : c)));
    } catch {
      addToast('Failed to mark creative as ready', 'error');
    }
  };

  const handleRejectCreative = async (id) => {
    try {
      await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'rejected' });
      setCreatives((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // silently fail
    }
  };

  // Template selection handler
  const handleTemplateSelect = (template) => {
    if (template.image_url || template.thumbnail_url) {
      const url = template.image_url || template.thumbnail_url;
      setReferenceImageUrl(url);
      setReferencePreview(url);
      setReferenceFile(null);
    }
    setTemplateModal(false);
  };

  // =========================================================================
  // ADVERTORIAL PIPELINE HANDLERS
  // =========================================================================

  const handleAdvProductSelect = (product) => {
    if (!product) {
      setAdvSelectedProductId(null);
      setAdvProductName('');
      return;
    }
    setAdvSelectedProductId(product.id);
    setAdvProductName(product.name || '');
    if (product.angles?.length > 0) {
      setAdvAngle(product.angles[0].name || '');
    }
  };

  const canGenerateAdv = advSourceCopy.trim().length >= 100 && advProductName.trim() && !advGenerating;

  const handleAdvGenerate = async () => {
    if (!canGenerateAdv) return;
    setAdvGenerating(true);
    setAdvError(null);

    try {
      const res = await api.post('/advertorial/copies/generate', {
        source_copy: advSourceCopy,
        product_id: advSelectedProductId || undefined,
        angle: advAngle || undefined,
      });
      const newCopies = res.data?.data?.copies || res.data?.copies || [];
      setAdvCopies((prev) => [...newCopies, ...prev]);
    } catch (err) {
      setAdvError(
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        'Failed to generate copy variants',
      );
    } finally {
      setAdvGenerating(false);
    }
  };

  const fetchAdvCopies = async () => {
    setAdvCopiesLoading(true);
    try {
      const res = await api.get('/advertorial/copies');
      setAdvCopies(res.data?.data || res.data || []);
    } catch {
      // silently fail
    } finally {
      setAdvCopiesLoading(false);
    }
  };

  const handleAdvStatusChange = async (id, newStatus) => {
    try {
      await api.patch(`/advertorial/copies/${id}/status`, { status: newStatus });
      setAdvCopies((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: newStatus } : c)),
      );
    } catch {
      // silently fail
    }
  };

  const handleAdvGenerateImages = async (id) => {
    setAdvGeneratingImagesFor(id);
    try {
      const res = await api.post(`/advertorial/copies/${id}/generate-images`);
      const creatives = res.data?.data?.creatives || res.data?.creatives || [];
      setAdvCopies((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, images: creatives, status: 'images_review' } : c,
        ),
      );
    } catch {
      // silently fail
    } finally {
      setAdvGeneratingImagesFor(null);
    }
  };

  // Fetch data on tab / pipeline switch (with caching)
  const templatesFetched = useRef(false);
  const creativesFetched = useRef(false);

  // Prefetch templates on mount so the library modal opens instantly.
  // templatesFetched.current is set inside fetchTemplates only on success,
  // so a cold-start 500 will be retried on next tab switch or modal open.
  useEffect(() => {
    if (!templatesFetched.current) {
      fetchTemplates();
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'pipeline') {
      fetchCreatives();
    } else if (activeTab === 'library') {
      if (!templatesFetched.current) {
        fetchTemplates(); // ref is set inside on success
      }
    } else if (activeTab === 'generated') {
      if (!creativesFetched.current) {
        fetchAllCreatives();
        creativesFetched.current = true;
      }
    }
  }, [activeTab]);

  // Auto-refresh pipeline when items are generating (variants or standalone)
  // Use refs to avoid infinite re-render: fetchCreatives updates creatives, which
  // would re-trigger this effect if creatives were in the dependency array.
  const hasGeneratingRef = useRef(false);
  const prevHasGeneratingRef = useRef(false);
  useEffect(() => {
    const wasGenerating = hasGeneratingRef.current;
    // Only poll while something is actively generating (not merely queued).
    // Queue items that are 'queued' haven't started yet, so no DB creatives
    // to pick up — polling them just wastes requests.
    hasGeneratingRef.current = creatives.some(c => c.status === 'generating')
      || queue.some(q => q.status === 'generating');
    prevHasGeneratingRef.current = wasGenerating;

    // Catch-up fetch: when generating just finished (was true, now false),
    // do one final silent fetch to pick up any server-side changes like
    // auto-generated 9:16 variants that the optimistic update missed.
    if (wasGenerating && !hasGeneratingRef.current && activeTab === 'pipeline') {
      setTimeout(() => fetchCreatives(true), 2000);
    }
  }, [creatives, queue, activeTab]);

  useEffect(() => {
    if (activeTab !== 'pipeline') return;
    // Check every 8s — only actually fetch if something is generating.
    // Uses silent mode so the refresh button doesn't flash a spinner.
    const interval = setInterval(() => {
      if (hasGeneratingRef.current) fetchCreatives(true);
    }, 8000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // --- Render helpers ---

  const inputClasses =
    'w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-faint focus:border-accent/30 focus:outline-none';
  const labelClasses = 'text-xs text-text-muted mb-1.5 block';

  const ratios = ['4:5', '9:16', '1:1'];

  // Real queue items (excludes temporary direct-gen placeholders)
  const realQueueItems = queue.filter(q => !q.id.startsWith('direct-'));
  const activeQueueCount = realQueueItems.filter(q => q.status === 'queued' || q.status === 'generating').length;
  const clearableQueueCount = realQueueItems.filter(q => q.status === 'done' || q.status === 'error' || q.status === 'partial').length;

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  return (
    <div className="p-6 bg-[#111113] min-h-full">
      {/* Header + Top Navigation */}
      <div className="h-16 border-b border-white/[0.04] bg-[#131315]/80 backdrop-blur-xl flex items-center justify-between px-6 -mx-6 -mt-6 mb-6 relative">
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-[#c9a84c]/10 via-transparent to-transparent" />

        <div className="flex items-center gap-8">
          {/* Page title */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#c9a84c]/10 border border-[#c9a84c]/20 flex items-center justify-center">
              <Layers className="w-4 h-4 text-[#c9a84c]" />
            </div>
            <h1 className="text-lg font-semibold text-white tracking-wide">Static Ads</h1>
          </div>

          {/* Tab navigation */}
          <nav className="flex items-center gap-1 bg-white/[0.02] p-1 rounded-lg border border-white/[0.04]">
            {TOP_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20 shadow-[0_0_10px_rgba(201,168,76,0.1)]'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Image-engine pill — global per-session. Persisted to localStorage.
              Sends image_engine on every /generate call; backend stamps it on
              each saved creative so refines / variants use the same engine. */}
          {availableEngines.length > 0 && (
            <div className="flex items-center gap-2 bg-white/[0.02] border border-white/[0.06] rounded-full pl-3 pr-1 py-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Image Engine</span>
              <div className="flex items-center gap-1">
                {availableEngines.map((eng) => {
                  const isActive = imageEngine === eng.name;
                  const disabled = !eng.available;
                  return (
                    <button
                      key={eng.name}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleEngineChange(eng.name)}
                      title={disabled ? `${eng.label} is not configured (missing API key)` : eng.describe}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-mono uppercase tracking-wide transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        isActive
                          ? 'bg-black text-white shadow-[0_0_8px_rgba(0,0,0,0.4)]'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${disabled ? 'bg-zinc-700' : (isActive ? 'bg-emerald-400' : 'bg-zinc-500')}`} />
                      {eng.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/* Settings button */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
            title="Prompt & Logic Settings"
          >
            <Settings className="w-5 h-5" />
          </button>

          {/* Add Reference button */}
          <button
            type="button"
            onClick={() => setAddRefModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer whitespace-nowrap"
            style={{
              background: 'linear-gradient(135deg, #c9a84c, #d4b55a)',
              color: '#111113',
              boxShadow: '0 0 15px rgba(201,168,76,0.2), 0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.2)',
            }}
          >
            <ImagePlus className="w-4 h-4" />
            Add Reference
          </button>
        </div>
      </div>

      {/* ================================================================= */}
      {/* PIPELINE TAB                                                       */}
      {/* ================================================================= */}
      {activeTab === 'pipeline' && (
          <div className="flex gap-0">
              {/* Left: ConfigSidebar */}
              <div className="w-[280px] shrink-0 space-y-4 pr-0 border-r border-white/[0.04]">
                <ConfigSidebar
                  selectedProduct={selectedProductId}
                  selectedProductObj={selectedProductObj}
                  onProductChange={(product) => handleProductSelect(product)}
                  angle={marketingAngle}
                  onAngleChange={setMarketingAngle}
                  angleData={selectedAngleData}
                  onAngleDataChange={setSelectedAngleData}
                  productAngles={productAngles}
                  customAngle={customAngle}
                  onCustomAngleChange={setCustomAngle}
                  references={references}
                  referenceImageUrl={referenceImageUrl}
                  onOpenLibrary={() => {
                    setTemplateModal(true);
                  }}
                  onUploadReference={async (file) => {
                    const preview = URL.createObjectURL(file);
                    setReferencePreview(preview);
                    // Convert to base64 so the server can receive it (blob URLs are browser-only)
                    const b64 = await fileToBase64(file);
                    setReferenceFile(file);
                    setReferences(prev => [...prev, { id: Date.now(), image_url: b64, thumbnail: preview, name: file.name }]);
                  }}
                  onRemoveReference={(id) => setReferences(prev => prev.filter(r => r.id !== id))}
                  onGenerate={handleGenerate}
                  onGenerateAll={handleGenerateAllAngles}
                  onAddToQueue={handleAddToQueue}
                  generating={generating}
                  generatingAll={generatingAll}
                  generationStep={generationStep}
                  onProductsLoaded={(list) => {
                    // Auto-select Miner Forge Pro if no product is selected yet
                    if (!selectedProductRef.current && list.length > 0) {
                      const miner = list.find(p => /miner\s*forge\s*pro/i.test(p.name));
                      if (miner) {
                        handleProductSelect(miner); // fetches full profile internally
                      }
                    }
                  }}
                />

                {/* Manual product info (when no product selected from library) */}
                {!selectedProductId && (
                  <>
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-4 space-y-3">
                      <h3 className="text-sm font-medium text-white mb-1">Product Info</h3>

                      <div>
                        <label className={labelClasses}>
                          Product Name <span className="text-accent-text">*</span>
                        </label>
                        <input
                          type="text"
                          value={productName}
                          onChange={(e) => setProductName(e.target.value)}
                          placeholder="e.g. GlowSkin Serum"
                          className={inputClasses}
                        />
                      </div>

                      <div>
                        <label className={labelClasses}>Description</label>
                        <textarea
                          value={productDescription}
                          onChange={(e) => setProductDescription(e.target.value)}
                          placeholder="Short product description..."
                          rows={3}
                          className={inputClasses + ' resize-none'}
                        />
                      </div>

                      <div>
                        <label className={labelClasses}>Price</label>
                        <input
                          type="text"
                          value={productPrice}
                          onChange={(e) => setProductPrice(e.target.value)}
                          placeholder="e.g. $49.99"
                          className={inputClasses}
                        />
                      </div>

                      <div>
                        <label className={labelClasses}>
                          Product Photo <span className="text-accent-text">*</span>
                        </label>
                        <UploadZone
                          preview={productPreview}
                          onFile={handleProductFile}
                          onUrlChange={(url) => {
                            setProductImageUrl(url);
                            setProductFile(null);
                            setProductPreview('');
                          }}
                          urlValue={productImageUrl}
                          onClear={clearProduct}
                          label="Product photo"
                          compact
                        />
                        {/* Product image gallery — pick which images to send */}
                        {selectedProductRef.current?.product_images?.length > 1 && (
                          <div className="mt-2">
                            <p className="text-xs text-zinc-500 mb-1.5">Click to set as main · Shift+click to add extra images</p>
                            <div className="flex gap-1.5 flex-wrap">
                              {selectedProductRef.current.product_images.map((img, i) => {
                                const isMain = img === productImageUrl;
                                const isExtra = selectedProductImages.includes(img);
                                return (
                                  <button
                                    key={i}
                                    type="button"
                                    onClick={(e) => {
                                      if (e.shiftKey) {
                                        // Toggle extra image selection
                                        setSelectedProductImages(prev =>
                                          prev.includes(img) ? prev.filter(x => x !== img) : [...prev, img].slice(0, 3)
                                        );
                                      } else {
                                        // Set as main product image
                                        setProductImageUrl(img);
                                        setProductPreview(img);
                                        setProductFile(null);
                                      }
                                    }}
                                    className={`relative w-12 h-12 rounded border-2 overflow-hidden transition-all ${
                                      isMain ? 'border-orange-500 ring-1 ring-orange-500/50' :
                                      isExtra ? 'border-blue-500 ring-1 ring-blue-500/50' :
                                      'border-white/10 hover:border-white/30'
                                    }`}
                                    title={isMain ? 'Main product image' : isExtra ? 'Extra image (shift+click to remove)' : 'Click to set as main · Shift+click to add'}
                                  >
                                    <img src={img} alt="" className="w-full h-full object-cover" />
                                    {isMain && <div className="absolute inset-0 bg-orange-500/20 flex items-center justify-center"><span className="text-[8px] font-bold text-orange-300">MAIN</span></div>}
                                    {isExtra && !isMain && <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center"><span className="text-[8px] font-bold text-blue-300">+</span></div>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Product Profile (collapsible) */}
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg">
                      <button
                        type="button"
                        onClick={() => setProfileOpen(!profileOpen)}
                        className="w-full flex items-center justify-between p-4 cursor-pointer"
                      >
                        <span className="text-sm font-medium text-white">Product Profile</span>
                        {profileOpen ? (
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400" />
                        )}
                      </button>

                      {profileOpen && (
                        <div className="px-4 pb-4 space-y-3 border-t border-white/[0.04] pt-3">
                          <div>
                            <label className={labelClasses}>Oneliner</label>
                            <input type="text" value={oneliner} onChange={(e) => setOneliner(e.target.value)} placeholder="One-sentence product pitch" className={inputClasses} />
                          </div>
                          <div>
                            <label className={labelClasses}>Customer Avatar</label>
                            <input type="text" value={customerAvatar} onChange={(e) => setCustomerAvatar(e.target.value)} placeholder="Who is your ideal customer?" className={inputClasses} />
                          </div>
                          <div>
                            <label className={labelClasses}>Customer Frustration</label>
                            <textarea value={customerFrustration} onChange={(e) => setCustomerFrustration(e.target.value)} placeholder="What frustrates them?" rows={2} className={inputClasses + ' resize-none'} />
                          </div>
                          <div>
                            <label className={labelClasses}>Customer Dream</label>
                            <textarea value={customerDream} onChange={(e) => setCustomerDream(e.target.value)} placeholder="What do they aspire to?" rows={2} className={inputClasses + ' resize-none'} />
                          </div>
                          <div>
                            <label className={labelClasses}>Big Promise</label>
                            <textarea value={bigPromise} onChange={(e) => setBigPromise(e.target.value)} placeholder="Your main value proposition" rows={2} className={inputClasses + ' resize-none'} />
                          </div>
                          <div>
                            <label className={labelClasses}>Mechanism</label>
                            <textarea value={mechanism} onChange={(e) => setMechanism(e.target.value)} placeholder="How does it work?" rows={2} className={inputClasses + ' resize-none'} />
                          </div>
                          <div>
                            <label className={labelClasses}>Differentiator</label>
                            <textarea value={differentiator} onChange={(e) => setDifferentiator(e.target.value)} placeholder="What makes it unique?" rows={2} className={inputClasses + ' resize-none'} />
                          </div>
                          <div>
                            <label className={labelClasses}>Voice / Tone</label>
                            <input type="text" value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="e.g. Bold, friendly, clinical" className={inputClasses} />
                          </div>
                          <div>
                            <label className={labelClasses}>Guarantee</label>
                            <input type="text" value={guarantee} onChange={(e) => setGuarantee(e.target.value)} placeholder="e.g. 30-day money-back guarantee" className={inputClasses} />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Selected product summary */}
              </div>

              {/* Right: Pipeline content (fills remaining) */}
              <div className="flex-1 min-w-0 space-y-6 pl-5">
                <PipelineView
                  creatives={creatives}
                  loading={creativesLoading}
                  onRefresh={fetchCreatives}
                  queue={queue}
                  onRemoveFromQueue={handleRemoveFromQueue}
                  productId={selectedProductId}
                  onSelectReference={(item) => {
                    // null = "user deselected; clear active single reference"
                    if (!item) {
                      setReferenceImageUrl('');
                      setReferencePreview(null);
                      setReferenceFile(null);
                      return;
                    }
                    const url = item.image_url || item.thumbnail_url || item.reference_thumbnail;
                    if (!url) return;
                    setReferenceImageUrl(url);
                    setReferencePreview(url);
                    setReferenceFile(null);
                  }}
                  productAngles={productAngles}
                  onQueueRefWithAngles={(ref, anglesPicked) => {
                    // One reference image × N angles → N queue items.
                    // Each item carries its own angle / angleData snapshot
                    // so the queue runner's existing per-item path generates
                    // the correct creative without any cross-item leakage.
                    if (!selectedProductId) {
                      addToast('Pick a product first before queueing angles', 'error');
                      return;
                    }
                    const refUrl = ref?.image_url || ref?.thumbnail_url || ref?.reference_thumbnail;
                    if (!refUrl) {
                      addToast('Reference has no usable image URL', 'error');
                      return;
                    }
                    if (!Array.isArray(anglesPicked) || anglesPicked.length === 0) {
                      addToast('Pick at least one angle', 'error');
                      return;
                    }
                    // Deduplicate angles defensively by name (cap to actual list).
                    const seen = new Set();
                    const uniqueAngles = anglesPicked.filter(a => {
                      const key = (a?.name || '').trim().toLowerCase();
                      if (!key || seen.has(key)) return false;
                      seen.add(key);
                      return true;
                    });
                    if (uniqueAngles.length === 0) {
                      addToast('Selected angles are empty / invalid', 'error');
                      return;
                    }
                    const refLabel = ref.reference_name || ref.source_label || 'Reference';
                    const newItems = uniqueAngles.map((angleObj) => ({
                      id: crypto.randomUUID(),
                      references: [{ url: refUrl, image_url: refUrl, thumbnail: refUrl, label: refLabel, name: refLabel }],
                      angle: angleObj.name || '',
                      angleData: angleObj,
                      customAngle: '',
                      productId: selectedProductId,
                      productName: productName,
                      productRef: selectedProductRef.current ? { ...selectedProductRef.current } : null,
                      productDescription,
                      productPrice,
                      productImageUrl,
                      productImageIndex: Math.max(0, (selectedProductRef.current?.product_images || []).indexOf(productImageUrl)),
                      aspectRatio,
                      oneliner, customerAvatar, customerFrustration, customerDream,
                      bigPromise, mechanism, differentiator, voice, guarantee,
                      status: 'queued',
                      result: null,
                      error: null,
                      createdAt: Date.now(),
                    }));
                    setQueue(prev => {
                      const next = [...prev, ...newItems];
                      queueRef.current = next;
                      return next;
                    });
                    addToast(`Queued ${newItems.length} angle${newItems.length > 1 ? 's' : ''} from "${refLabel}"`, 'success');
                  }}
                  onAddSelectedToQueue={(picked) => {
                    // Batch: each selected reference becomes its own queue item.
                    // The existing queue runner picks them up sequentially.
                    if (!selectedProductId) {
                      addToast('Pick a product first before queueing references', 'error');
                      return;
                    }
                    if (!Array.isArray(picked) || picked.length === 0) return;
                    const newItems = picked.map((ref) => {
                      const url = ref?.image_url || ref?.thumbnail_url || ref?.reference_thumbnail;
                      if (!url) return null;
                      return {
                        id: crypto.randomUUID(),
                        references: [{ url, label: ref.reference_name || ref.source_label || 'Reference' }],
                        angle: marketingAngle,
                        angleData: !customAngle && selectedAngleData ? selectedAngleData : null,
                        customAngle: customAngle,
                        productId: selectedProductId,
                        productName: productName,
                        productRef: selectedProductRef.current ? { ...selectedProductRef.current } : null,
                        productDescription,
                        productPrice,
                        productImageUrl,
                        productImageIndex: Math.max(0, (ref.product_images || selectedProductRef.current?.product_images || []).indexOf(productImageUrl)),
                        aspectRatio,
                        oneliner, customerAvatar, customerFrustration, customerDream,
                        bigPromise, mechanism, differentiator, voice, guarantee,
                        status: 'queued',
                        result: null,
                        error: null,
                        createdAt: Date.now(),
                      };
                    }).filter(Boolean);
                    if (newItems.length === 0) {
                      addToast('Selected references had no usable image URL', 'error');
                      return;
                    }
                    setQueue(prev => {
                      const next = [...prev, ...newItems];
                      queueRef.current = next;
                      return next;
                    });
                    addToast(`Added ${newItems.length} reference${newItems.length > 1 ? 's' : ''} to queue`, 'info');
                  }}
                  onStatusChange={async (id, newStatus) => {
                    try {
                      await api.patch(`/statics-generation/creatives/${id}/status`, { status: newStatus });
                      setCreatives(prev => prev.map(c => c.id === id ? { ...c, status: newStatus } : c));
                      // Refresh after Ready to pick up auto-generated 9:16 variant
                      if (newStatus === 'ready') setTimeout(() => fetchCreatives(), 3000);
                    } catch (err) {
                      console.error('[Pipeline] Status change failed:', err.message);
                    }
                  }}
                  onAngleChange={async (id, newAngle) => {
                    try {
                      await api.patch(`/statics-generation/creatives/${id}/angle`, { angle: newAngle });
                      setCreatives(prev => prev.map(c => c.id === id ? { ...c, angle: newAngle || null } : c));
                    } catch (err) {
                      console.error('[Pipeline] Angle change failed:', err.message);
                    }
                  }}
                  onCardClick={(creative) => setDetailModal(creative)}
                  onRegenerate={async (creative) => {
                    if (!creative.reference_thumbnail || !creative.product_id) {
                      console.warn('[Pipeline] Cannot regenerate — missing reference or product data');
                      return;
                    }
                    try {
                      // Fetch product data from library
                      const prodRes = await api.get(`/product-library/products/${creative.product_id}`);
                      const prod = prodRes.data?.data || prodRes.data;
                      // Add to queue with status 'queued' so the queue processor handles
                      // polling and saving — same as ADD TO QUEUE
                      const queueId = `regen-${creative.id}-${Date.now()}`;
                      setQueue(prev => {
                        const next = [...prev, {
                          id: queueId,
                          productId: creative.product_id,
                          productName: creative.product_name || prod.name || 'Untitled',
                          productImageUrl: prod.main_image_url || prod.product_images?.[0] || '',
                          productRef: prod,
                          angle: creative.angle || null,
                          aspectRatio: creative.aspect_ratio || '4:5',
                          references: [{ image_url: creative.reference_thumbnail, name: 'Regenerate' }],
                          status: 'queued',
                        }];
                        queueRef.current = next;
                        return next;
                      });
                    } catch (err) {
                      console.error('[Pipeline] Regenerate failed:', err.message);
                    }
                  }}
                  // TEMPLATES button now opens the templates LIST view
                  // (was: direct-to-editor with empty form). New / Edit /
                  // Duplicate / Delete all dispatch from inside the list.
                  onOpenTemplates={async () => {
                    setTemplatesListLoading(true);
                    setTemplatesListOpen(true);
                    try {
                      const { data } = await api.get('/brief-pipeline/launch-templates');
                      setTemplatesListData(data?.data || []);
                    } catch (err) {
                      console.error('[StaticsGeneration] Failed to load templates list:', err.message);
                      setTemplatesListData([]);
                    } finally {
                      setTemplatesListLoading(false);
                    }
                  }}
                  onEditTemplate={(tpl) => { setEditingTemplate(tpl); setTemplateEditorOpen(true); }}
                  templatesVersion={templatesVersion}
                  onOpenCopySets={() => setCopySetsOpen(true)}
                />

                {/* ---- Generation Queue Panel (below pipeline) ---- */}
                {realQueueItems.length > 0 && (
                  <div className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
                      <div className="flex items-center gap-2">
                        <ListPlus className="w-4 h-4 text-accent-text" />
                        <span className="text-sm font-medium text-white">Generation Queue</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-500">
                          {activeQueueCount > 0
                            ? `${activeQueueCount} active`
                            : `${clearableQueueCount} finished`}
                        </span>
                        {clearableQueueCount > 0 && (
                          <button
                            type="button"
                            onClick={handleClearQueue}
                            className="text-[10px] text-slate-600 hover:text-white transition-colors cursor-pointer"
                            title="Clear done & errored items"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="divide-y divide-white/[0.04]">
                      {realQueueItems.map((item) => (
                        <div key={item.id} className={`flex gap-3 px-4 py-2 text-sm ${item.status === 'error' || item.status === 'partial' ? 'items-start' : 'items-center'}`}>
                          <span className="shrink-0 w-5 text-center">
                            {item.status === 'queued' && <Clock className="w-3.5 h-3.5 text-slate-500 inline" />}
                            {item.status === 'generating' && <Loader2 className="w-3.5 h-3.5 text-accent-text animate-spin inline" />}
                            {item.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline" />}
                            {item.status === 'partial' && <AlertCircle className="w-3.5 h-3.5 text-amber-400 inline" />}
                            {item.status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-400 inline" />}
                          </span>
                          <span className={`text-xs font-medium w-[72px] shrink-0 ${
                            item.status === 'queued' ? 'text-slate-500'
                            : item.status === 'generating' ? 'text-accent-text'
                            : item.status === 'done' ? 'text-emerald-400'
                            : item.status === 'partial' ? 'text-amber-400'
                            : 'text-red-400'
                          }`}>
                            {item.status === 'queued' ? 'Queued'
                              : item.status === 'generating' ? `Generating${item.progress ? ` ${item.progress}` : ''}`
                              : item.status === 'done' ? 'Done'
                              : item.status === 'partial' ? 'Partial'
                              : 'Error'}
                          </span>
                          <span className="text-xs text-slate-300 truncate flex-1">
                            {item.customAngle || item.angle || 'No angle'}
                          </span>
                          <span className="text-[11px] text-slate-500 shrink-0">
                            {item.references.length} ref{item.references.length !== 1 ? 's' : ''}
                          </span>
                          {item.status === 'error' ? (
                            <span className="text-[11px] text-red-400 flex-1 min-w-0 break-words whitespace-normal text-right leading-snug" title={item.error}>
                              {item.error}
                            </span>
                          ) : item.status === 'partial' ? (
                            <span className="text-[11px] flex-1 min-w-0 text-right leading-snug">
                              <span className="text-emerald-400">{item.result?.creativeCount || 0} creative{(item.result?.creativeCount || 0) !== 1 ? 's' : ''}</span>
                              {item.error && <span className="text-amber-400 block break-words whitespace-normal" title={item.error}>{item.error}</span>}
                            </span>
                          ) : (
                            <span className="text-[11px] text-right shrink-0 w-[100px] truncate">
                              {item.status === 'done' && item.result?.creativeCount && (
                                <span className="text-emerald-400">{item.result.creativeCount} creative{item.result.creativeCount !== 1 ? 's' : ''}</span>
                              )}
                            </span>
                          )}
                          <span className="w-6 shrink-0 flex justify-center">
                            {(item.status === 'error' || item.status === 'partial') && (
                              <button
                                type="button"
                                onClick={() => handleRetryQueueItem(item.id)}
                                className="text-slate-600 hover:text-amber-400 transition-colors cursor-pointer"
                                title="Retry"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </span>
                          <span className="w-6 shrink-0 flex justify-center">
                            {(item.status === 'queued' || item.status === 'error' || item.status === 'done' || item.status === 'partial') && (
                              <button
                                type="button"
                                onClick={() => handleRemoveFromQueue(item.id)}
                                className="text-slate-600 hover:text-red-400 transition-colors cursor-pointer"
                                title={item.status === 'queued' ? 'Remove from queue' : 'Dismiss'}
                              >
                                {item.status === 'queued' ? <Trash2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ---- Error State ---- */}
                {error && !generating && (
                  <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-6">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="text-sm font-medium text-red-300 mb-1">Generation Failed</h3>
                        <p className="text-sm text-red-400/80">{error}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        handleGenerate();
                      }}
                      className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Try Again
                    </button>
                  </div>
                )}

                {/* ---- Loading State ---- */}
                {generating && (
                  <div className="bg-[#111] border border-white/[0.06] rounded-lg p-8">
                    <h3 className="text-sm font-medium text-white mb-4">Generating your creative...</h3>
                    <div className="space-y-1">
                      <StepperIndicator step={1} currentStep={generationStep} label="Analyzing reference ad with AI..." />
                      <StepperIndicator step={2} currentStep={generationStep} label="Generating new creative..." />
                      <StepperIndicator step={3} currentStep={generationStep} label="Finalizing image..." />
                    </div>
                    <div className="mt-6 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-1000 ease-out"
                        style={{
                          width:
                            generationStep === 1
                              ? '25%'
                              : generationStep === 2
                                ? '60%'
                                : generationStep === 3
                                  ? '90%'
                                  : '0%',
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Results auto-saved to pipeline — click the card there to view */}
                {!generating && result && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm text-emerald-300 font-medium">Creative generated &amp; saved to Pipeline</p>
                      <p className="text-xs text-emerald-400/60 mt-1">Switch to the Pipeline tab to review, approve, or download.</p>
                      <button
                        type="button"
                        onClick={handleGenerateAnother}
                        className="mt-3 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-white transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Generate Another
                      </button>
                    </div>
                  </div>
                )}

                {/* Saved References removed — references show in sidebar */}

                {/* ---- 9:16 Variant Tracker (bottom, collapsed) ---- */}
                {(() => {
                  const parentCreatives = creatives.filter(c => !c.parent_creative_id && c.aspect_ratio !== '9:16');
                  if (parentCreatives.length === 0) return null;
                  const variants = creatives.filter(c => c.parent_creative_id && c.aspect_ratio === '9:16');
                  const tracked = parentCreatives.map(p => {
                    const v = variants.find(v => v.parent_creative_id === p.id);
                    if (!v) return { parent: p, variant: null, status: 'none' };
                    // Treat any 'failed'/'rejected' variant — and any variant stuck in
                    // 'generating' for >7 min — as failed so users can retry it.
                    const STALE_MS = 7 * 60 * 1000;
                    const age = v.created_at ? Date.now() - new Date(v.created_at).getTime() : 0;
                    const isStale = v.status === 'generating' && age > STALE_MS;
                    const status = (v.status === 'rejected' || v.status === 'failed' || isStale) ? 'failed'
                      : v.status === 'generating' ? 'generating'
                      : v.image_url ? 'done' : 'generating';
                    return { parent: p, variant: v, status };
                  });
                  const counts = { generating: 0, done: 0, failed: 0, none: 0 };
                  tracked.forEach(t => counts[t.status]++);
                  return (
                    <div className="mt-6 border-t border-white/[0.04] pt-4">
                      <button
                        type="button"
                        onClick={() => setVariantsExpanded(prev => !prev)}
                        className="w-full flex items-center gap-2 py-1.5 cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        <ChevronRight className={`w-3 h-3 text-zinc-600 transition-transform ${variantsExpanded ? 'rotate-90' : ''}`} />
                        <span className="text-[11px] text-zinc-600">9:16 Variants</span>
                        <div className="flex items-center gap-1.5 ml-auto">
                          {counts.done > 0 && (
                            <span className="text-[10px] bg-emerald-500/10 text-emerald-500/60 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                              <Check className="w-2.5 h-2.5" />{counts.done}
                            </span>
                          )}
                          {counts.generating > 0 && (
                            <span className="text-[10px] bg-accent/10 text-accent-text/60 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                              <Loader2 className="w-2.5 h-2.5 animate-spin" />{counts.generating}
                            </span>
                          )}
                          {counts.failed > 0 && (
                            <span className="text-[10px] bg-red-500/10 text-red-400/60 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                              <AlertCircle className="w-2.5 h-2.5" />{counts.failed}
                            </span>
                          )}
                        </div>
                      </button>
                      {variantsExpanded && (
                        <div className="space-y-1 mt-2 pl-5">
                          {tracked.map(({ parent, variant, status }) => (
                            <div key={parent.id} className="flex items-center gap-2 text-[11px]">
                              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                status === 'generating' ? 'bg-accent animate-pulse'
                                : status === 'done' ? 'bg-emerald-400'
                                : status === 'failed' ? 'bg-red-400'
                                : 'bg-gray-600'
                              }`} />
                              <span className="text-gray-500 truncate flex-1">{parent.product_name || 'Untitled'} — {parent.angle || 'No angle'}</span>
                              <span className={
                                status === 'generating' ? 'text-accent-text/60'
                                : status === 'done' ? 'text-emerald-400/60'
                                : status === 'failed' ? 'text-red-400/60'
                                : 'text-gray-600'
                              }>
                                {status === 'generating' ? 'Generating...'
                                  : status === 'done' ? 'Ready'
                                  : status === 'failed' ? 'Failed'
                                  : '—'}
                              </span>
                              {(status === 'failed' || status === 'none') && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.post(`/statics-generation/creatives/${parent.id}/create-variant`, { aspect_ratio: '9:16' });
                                      fetchCreatives();
                                    } catch (err) {
                                      console.warn('[StaticsGeneration] create-variant failed:', err.message);
                                    }
                                  }}
                                  className="text-[10px] text-accent-text/50 hover:text-accent cursor-pointer shrink-0"
                                >
                                  {status === 'failed' ? 'Retry' : 'Create'}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
      )}

      {/* ================================================================= */}
      {/* LIBRARY TAB                                                        */}
      {/* ================================================================= */}
      {activeTab === 'library' && (
        <LibraryView
          templates={templates}
          onSelectTemplate={(template) => {
            handleTemplateSelect(template);
            setReferences([{ id: template.id || Date.now(), image_url: template.image_url, name: template.name, is_template: !!template.id }]);
            setActiveTab('pipeline');
          }}
          onAddReference={() => setAddRefModal(true)}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          onAnalyzeTemplate={(template) => setAnalysisModalTemplate(template)}
          onAnalyzeAll={async () => {
            try {
              await api.post('/statics-generation/templates/analyze-all');
            } catch (err) {
              console.error('Analyze all failed:', err);
            }
          }}
          onDeleteTemplate={async (template) => {
            if (!window.confirm('Delete this template?')) return;
            try {
              const res = await api.delete(`/statics-generation/templates/${template.id}`);
              if (res.data?.success) {
                setTemplates(prev => prev.filter(t => t.id !== template.id));
              }
            } catch (err) {
              console.error('Delete failed:', err);
            }
          }}
          onUpdateTemplate={async (templateId, updates) => {
            const res = await api.put(`/statics-templates/${templateId}`, updates);
            if (res.data?.success) {
              setTemplates(prev => prev.map(t => t.id === templateId ? { ...t, ...res.data.data } : t));
            }
          }}
        />
      )}

      {/* ================================================================= */}
      {/* GENERATED TAB                                                      */}
      {/* ================================================================= */}
      {activeTab === 'generated' && (
        <GeneratedView
          creatives={creatives}
          loading={creativesLoading}
          onRefresh={fetchAllCreatives}
          onCreativeClick={(creative) => setDetailModal(creative)}
        />
      )}

      {/* ================================================================= */}
      {/* SETTINGS TAB                                                       */}
      {/* ================================================================= */}
      {activeTab === 'settings' && (
        <div className="max-w-4xl space-y-10">
          {/* ---- Per-angle analytics ---- */}
          <div>
            <h2 className="text-base font-semibold text-text-primary mb-1">Angle Performance (last 90 days)</h2>
            <p className="text-sm text-text-muted mb-4">Generations, approval rate, and status breakdown per marketing angle.</p>
            <AngleAnalytics />
          </div>

          {/* ---- Prompt settings ---- */}
          <div>
            <h2 className="text-base font-semibold text-text-primary mb-1">Generation Logic & Prompt Settings</h2>
            <p className="text-sm text-text-muted mb-4">Configure how Claude analyzes reference ads and how images are generated. Changes apply to all future generations.</p>
            <StaticsSettingsInline />
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODALS                                                             */}
      {/* ================================================================= */}
      {templateModal && (
        <TemplateSelectModal
          isOpen={true}
          templates={templates}
          angle={customAngle || marketingAngle}
          onSelect={(template) => {
            handleTemplateSelect(template);
            setReferences([{ id: template.id || Date.now(), image_url: template.image_url, name: template.name, is_template: !!template.id }]);
          }}
          onClose={() => setTemplateModal(false)}
        />
      )}

      {detailModal && (
        <CreativeDetailModalV2
          key={detailModal?.id}
          parent={detailModal}
          allCreatives={creatives}
          isOpen={true}
          onClose={() => setDetailModal(null)}
          onRefresh={() => fetchCreatives()}
        />
      )}

      {/* The inline EditImageModal render block was removed — the new
          chat-style EditImageEditor is rendered nested inside
          CreativeDetailModalV2, which is the only way operators reach the
          editor (via the pink dot next to the 1:1 ratio label). */}

      {/* Legacy modal — kept import for reference flows that may still want
          the old tabbed view. V2 above is the new default for pipeline cards. */}
      {false && detailModal && (
        <CreativeDetailModal
          key={detailModal?.id}
          creative={detailModal}
          variant={creatives.find(c => c.parent_creative_id === detailModal.id && c.aspect_ratio === '9:16')}
          isOpen={true}
          onClose={() => setDetailModal(null)}
          onApprove={async (id) => {
            try {
              await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'ready' });
              setCreatives(prev => prev.map(c => c.id === id ? { ...c, status: 'ready' } : c));
              setDetailModal(null);
              // Refresh after a delay to pick up the auto-generated 9:16 variant
              setTimeout(() => fetchCreatives(), 3000);
            } catch (err) { console.warn('[StaticsGeneration] mark ready failed:', err.message); }
          }}
          onReject={async (id) => {
            try {
              await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'rejected' });
              setCreatives(prev => prev.filter(c => c.id !== id));
              setDetailModal(null);
            } catch (err) { console.warn('[StaticsGeneration] reject failed:', err.message); }
          }}
          onDelete={async (id) => {
            try {
              await api.delete(`/statics-generation/creatives/${id}`);
              setCreatives(prev => prev.filter(c => c.id !== id));
              setDetailModal(null);
            } catch (err) { console.warn('[StaticsGeneration] delete failed:', err.message); }
          }}
          onDownload={(id) => {
            const creative = creatives.find(c => c.id === id);
            if (creative?.image_url) window.open(creative.image_url, '_blank');
          }}
          onRefresh={fetchCreatives}
          onAiAdjust={async (id, instruction) => {
            await api.post(`/statics-generation/creatives/${id}/ai-adjust`, { instruction });
            // Polling in the modal will detect the update and call onRefresh
          }}
          onCreateVariant={async (id) => {
            try {
              await api.post(`/statics-generation/creatives/${id}/create-variant`, { aspect_ratio: '9:16' });
              alert('9:16 variant is being generated. It will appear in the pipeline shortly.');
              setDetailModal(null);
            } catch (err) {
              const msg = err.response?.data?.error?.message || 'Failed to create variant';
              alert(msg);
            }
          }}
          onStatusChange={async (id, status) => {
            try {
              await api.patch(`/statics-generation/creatives/${id}/status`, { status });
              setCreatives(prev => prev.map(c => c.id === id ? { ...c, status } : c));
              setDetailModal(null);
            } catch (err) { console.warn('[StaticsGeneration] statusChange failed:', err.message); }
          }}
        />
      )}

      {addRefModal && (
        <AddReferenceModal
          isOpen={true}
          onClose={() => setAddRefModal(false)}
          onImportComplete={(newTemplates) => {
            setTemplates(prev => [...newTemplates, ...prev]);
            setAddRefModal(false);
          }}
        />
      )}

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-sm ${
                toast.type === 'generating'
                  ? 'bg-amber-950/90 border-accent/30 text-accent-text'
                  : toast.type === 'success'
                    ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200'
                    : toast.type === 'error'
                      ? 'bg-red-950/90 border-red-500/30 text-red-200'
                      : 'bg-[#111]/90 border-white/10 text-slate-200'
              }`}
            >
              {toast.type === 'generating' && <Loader2 className="w-4 h-4 animate-spin text-accent-text shrink-0" />}
              {toast.type === 'success' && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
              {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
              <span className="text-sm font-medium">{toast.message}</span>
              <button
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="ml-2 p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <StaticsSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {templateEditorOpen && (
        <LaunchTemplateEditor
          open
          template={editingTemplate}
          onClose={() => { setTemplateEditorOpen(false); setEditingTemplate(null); }}
          onSaved={async () => {
            setTemplateEditorOpen(false);
            setEditingTemplate(null);
            setTemplatesVersion(v => v + 1);
            // If the LIST modal is still open behind the editor, refresh
            // its data so the new/edited template shows up immediately.
            if (templatesListOpen) {
              try {
                const { data } = await api.get('/brief-pipeline/launch-templates');
                setTemplatesListData(data?.data || []);
              } catch (_) { /* ignore — list will refresh on next open */ }
            }
          }}
        />
      )}

      <LaunchTemplatesListModal
        open={templatesListOpen}
        templates={templatesListLoading ? [] : templatesListData}
        onClose={() => setTemplatesListOpen(false)}
        onNew={() => { setEditingTemplate(null); setTemplateEditorOpen(true); }}
        onEdit={(tpl) => { setEditingTemplate(tpl); setTemplateEditorOpen(true); }}
        onChanged={async () => {
          // Duplicate or delete inside the modal succeeded — reload the list
          // and bump the version so PipelineView's dropdown refreshes too.
          try {
            const { data } = await api.get('/brief-pipeline/launch-templates');
            setTemplatesListData(data?.data || []);
            setTemplatesVersion(v => v + 1);
          } catch (err) {
            console.error('[StaticsGeneration] Failed to refresh templates after change:', err.message);
          }
        }}
      />


      {copySetsOpen && (
        <AdCopySetsManager
          open
          onClose={() => setCopySetsOpen(false)}
          productId={selectedProductId}
          productName={productName}
        />
      )}

      <TemplateAnalysisModal
        isOpen={!!analysisModalTemplate}
        onClose={() => setAnalysisModalTemplate(null)}
        template={analysisModalTemplate}
      />
    </div>
  );
}
