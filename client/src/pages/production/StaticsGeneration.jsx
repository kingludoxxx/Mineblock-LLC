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
import { ConfigSidebar } from './statics/ConfigSidebar';
import { AddReferenceModal } from './statics/AddReferenceModal';
import { StaticsSettingsModal } from './statics/StaticsSettingsModal';
import LaunchTemplateEditor from './briefs/LaunchTemplateEditor';
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

const STANDARD_CREATIVE_STATUSES = ['review', 'approved', 'queued', 'launched'];
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
// Standard Pipeline — Creative Review Card
// ---------------------------------------------------------------------------

function CreativeReviewCard({ creative, onApprove, onReject }) {
  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
      {creative.image_url && (
        <img
          src={creative.image_url}
          alt={creative.name || 'Creative'}
          className="w-full h-48 object-cover"
        />
      )}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white truncate">
            {creative.name || 'Untitled Creative'}
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
                <img
                  src={creative.image_url}
                  alt={creative.name || 'Creative'}
                  className="w-full h-[120px] object-cover"
                />
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
                  {creative.name || 'Untitled'}
                </p>
                <StatusBadge status={creative.status || 'review'} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Settings Component (for the "Logic & Settings" tab)
// ---------------------------------------------------------------------------

function StaticsSettingsInline() {
  const [activeSection, setActiveSection] = useState('claudeAnalysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({});
  const [values, setValues] = useState({});
  const [toast, setToast] = useState(null);

  const SECTIONS = [
    { key: 'claudeAnalysis', label: 'Claude Analysis', icon: Brain },
    { key: 'nanoBanana', label: 'Image Generation', icon: ImagePlus },
  ];

  const FIELDS = {
    claudeAnalysis: [
      { key: 'productIdentity', label: 'Product Identity', desc: 'How the AI understands your product' },
      { key: 'headlineRules', label: 'Headline Rules', desc: 'Rules for adapting headlines' },
      { key: 'headlineExamples', label: 'Headline Examples', desc: 'Example headlines for reference' },
      { key: 'pricingRules', label: 'Pricing Rules', desc: 'Pricing constraints and formats' },
      { key: 'formulaPreservation', label: 'Formula Preservation', desc: 'How to preserve copywriting formulas' },
      { key: 'crossNicheAdaptation', label: 'Cross-Niche Adaptation', desc: 'Rules for adapting across product niches' },
      { key: 'visualAdaptation', label: 'Visual Adaptation', desc: 'How to map visual elements to your product' },
      { key: 'bannedPhrases', label: 'Banned Phrases', desc: 'Phrases the AI must never use in copy' },
    ],
    nanoBanana: [
      { key: 'productRules', label: 'Product Replacement Rules', desc: 'How to swap product imagery' },
      { key: 'textRules', label: 'Text Rendering Rules', desc: 'Typography and text placement rules' },
      { key: 'absoluteRules', label: 'Absolute Constraints', desc: 'Hard rules that cannot be broken' },
    ],
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get('/statics-generation/settings/prompts');
        setDefaults(data.defaults || {});
        const merged = {};
        for (const section of Object.keys(FIELDS)) {
          merged[section] = {};
          for (const field of FIELDS[section]) {
            merged[section][field.key] = data.custom?.[section]?.[field.key] ?? data.defaults?.[section]?.[field.key] ?? '';
          }
        }
        setValues(merged);
      } catch (err) {
        console.error('Failed to load settings:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleChange = (section, key, value) => {
    setValues(prev => ({ ...prev, [section]: { ...prev[section], [key]: value } }));
  };

  const isFieldCustom = (section, key) => {
    return (values?.[section]?.[key] ?? '') !== (defaults?.[section]?.[key] ?? '');
  };

  const handleResetField = (section, key) => {
    handleChange(section, key, defaults?.[section]?.[key] ?? '');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/statics-generation/settings/prompts', { prompts: values });
      setToast({ type: 'success', message: 'Settings saved' });
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast({ type: 'error', message: 'Failed to save' });
      setTimeout(() => setToast(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    try {
      await api.post('/statics-generation/settings/prompts/reset');
      const { data } = await api.get('/statics-generation/settings/prompts');
      setDefaults(data.defaults || {});
      const merged = {};
      for (const section of Object.keys(FIELDS)) {
        merged[section] = {};
        for (const field of FIELDS[section]) {
          merged[section][field.key] = data.defaults?.[section]?.[field.key] ?? '';
        }
      }
      setValues(merged);
      setToast({ type: 'success', message: 'All prompts reset to defaults' });
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast({ type: 'error', message: 'Failed to reset' });
      setTimeout(() => setToast(null), 3000);
    }
  };

  const fields = FIELDS[activeSection] || [];

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
      <div className="flex items-center gap-2">
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

      {/* Fields */}
      <div className="space-y-4">
        {fields.map(field => (
          <div key={field.key} className="bg-bg-card border border-border-default rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-medium text-text-primary">{field.label}</h3>
                <p className="text-xs text-text-faint mt-0.5">{field.desc}</p>
              </div>
              {isFieldCustom(activeSection, field.key) && (
                <button
                  type="button"
                  onClick={() => handleResetField(activeSection, field.key)}
                  className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              )}
            </div>
            <textarea
              value={values?.[activeSection]?.[field.key] ?? ''}
              onChange={(e) => handleChange(activeSection, field.key, e.target.value)}
              rows={5}
              className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-faint resize-y focus:outline-none focus:border-accent/30 transition-colors"
            />
          </div>
        ))}
      </div>

      {/* Actions bar */}
      <div className="flex items-center justify-between pt-2 pb-4">
        <button
          type="button"
          onClick={handleResetAll}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          Reset All
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

export default function StaticsGeneration() {
  // Top-level tab
  const [activeTab, setActiveTab] = useState('pipeline');

  // Pipeline sub-toggle
  const [activePipeline, setActivePipeline] = useState('standard');

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

  // Queue state
  const [queue, setQueue] = useState([]);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const queueProcessingRef = useRef(false);
  const queueRef = useRef([]);

  // Creative review state (Standard pipeline)
  const [creatives, setCreatives] = useState([]);
  const [creativesLoading, setCreativesLoading] = useState(false);
  const [references, setReferences] = useState([]);

  // Templates state
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // Modal state
  const [detailModal, setDetailModal] = useState(null);
  const [templateModal, setTemplateModal] = useState(false);
  const [addRefModal, setAddRefModal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [copySetsOpen, setCopySetsOpen] = useState(false);
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
    try {
      const res = await api.get(`/product-profiles/${product.id}`);
      const fullProduct = res.data.data || res.data;
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
      if (fullProduct.angles?.length > 0) {
        setMarketingAngle(fullProduct.angles[0].name || '');
      }
    } catch (err) {
      console.error('Failed to fetch full product profile:', err);
      // Fallback to the partial product
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
        resolvedReferenceUrl = references[0].image_url || references[0].thumbnail || references[0].url || '';
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
      // Pass all new product profile fields from library
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
      }

      // Step 1: Submit to server (Claude analysis + NanoBanana submit — returns fast)
      setGenerationStep(1);
      // Detect template ID (UUID from library vs numeric timestamp from upload)
      const refTemplateId = references[0]?.id;
      const isTemplateUUID = typeof refTemplateId === 'string' && refTemplateId.includes('-');

      const response = await api.post('/statics-generation/generate', {
        reference_image_url: resolvedReferenceUrl,
        template_id: isTemplateUUID ? refTemplateId : undefined,
        product: {
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
        ratio: aspectRatio,
      });

      const genResult = response.data?.data || response.data;
      const tasks = genResult.tasks || (genResult.taskId ? [{ taskId: genResult.taskId, ratio: aspectRatio }] : []);

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
        const maxPolls = 60;
        for (let i = 0; i < maxPolls; i++) {
          // Fast polls first (2s for first 10), then back off to 4s
          const delay = i < 10 ? 2000 : 4000;
          await new Promise(r => setTimeout(r, delay));
          const statusRes = await api.get(`/statics-generation/status/${task.taskId}`);
          const statusData = statusRes.data?.data || statusRes.data;
          if (statusData?.resultImageUrl) {
            return { ratio: task.ratio, imageUrl: statusData.resultImageUrl, taskId: task.taskId };
          }
          if (statusData?.status === 'failed' || statusData?.error) {
            throw new Error(`Generation failed for ${task.ratio}: ${statusData?.error || 'Unknown error'}`);
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
        addToast(`Warning: ${failedTasks.length} ratio(s) failed — ${failedTasks.join(', ')}`, 'warning', 8000);
      }

      // Step 3: Save all creatives with shared group
      setGenerationStep(3);
      const groupId = crypto.randomUUID();
      const currentRef = references[0];
      const resolvedRefUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || resolvedReferenceUrl;

      const savedCreatives = await Promise.all(completedTasks.map(async (task) => {
        const saveRes = await api.post('/statics-generation/creatives', {
          product_id: selectedProductId || null,
          product_name: productName,
          image_url: task.imageUrl,
          angle: marketingAngle || null,
          aspect_ratio: task.ratio,
          group_id: groupId,
          generation_task_id: task.taskId,
          adapted_text: genResult.adaptedText || genResult.claudeAnalysis?.adapted_text,
          swap_pairs: genResult.swapPairs,
          claude_analysis: genResult.claudeAnalysis,
          reference_thumbnail: resolvedRefUrl,
          reference_name: currentRef?.name || 'Reference',
          source_label: currentRef?.source_label || currentRef?.name || null,
          pipeline: 'standard',
        });
        return saveRes.data?.data || saveRes.data;
      }));

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
  // QUEUE HANDLERS
  // =========================================================================

  const handleAddToQueue = () => {
    if (!selectedProductId || references.length === 0) return;

    const item = {
      id: crypto.randomUUID(),
      references: references.map(r => ({ ...r })),
      angle: marketingAngle,
      customAngle: customAngle,
      productId: selectedProductId,
      productName: productName,
      productRef: selectedProductRef.current ? { ...selectedProductRef.current } : null,
      productDescription,
      productPrice,
      productImageUrl,
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

  // Queue processor — runs queued items sequentially
  useEffect(() => {
    const hasQueued = queue.some(q => q.status === 'queued');
    const hasGenerating = queue.some(q => q.status === 'generating');

    // Wait if: nothing queued, already generating (queue or manual), or processing flag set.
    // Use ref as primary guard to prevent race condition where React hasn't yet
    // batched the setQueueProcessing(true) state update from a prior invocation.
    if (!hasQueued || hasGenerating || queueProcessingRef.current || queueProcessing || generating) return;

    const processNext = async () => {
      queueProcessingRef.current = true;
      setQueueProcessing(true);

      // Find first queued item
      const currentQueue = queueRef.current;
      const itemIndex = currentQueue.findIndex(q => q.status === 'queued');
      if (itemIndex === -1) {
        queueProcessingRef.current = false;
        setQueueProcessing(false);
        return;
      }

      const item = currentQueue[itemIndex];

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
          const maxPolls = 60;
          for (let i = 0; i < maxPolls; i++) {
            const delay = i < 10 ? 2000 : 4000;
            await new Promise(r => setTimeout(r, delay));
            const statusRes = await api.get(`/statics-generation/status/${task.taskId}`);
            const statusData = statusRes.data?.data || statusRes.data;
            if (statusData?.resultImageUrl) {
              return { ratio: task.ratio, imageUrl: statusData.resultImageUrl, taskId: task.taskId };
            }
            if (statusData?.status === 'failed' || statusData?.error) {
              const errMsg = statusData?.error || `Generation failed (code ${statusData?.successFlag || '?'})`;
              throw new Error(`Failed for ${task.ratio}: ${errMsg}`);
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

              const response = await api.post('/statics-generation/generate', {
                reference_image_url: refUrl,
                template_id: isRefTemplate ? refId : undefined,
                product: productPayload,
                angle: item.customAngle || item.angle || undefined,
                ratio: item.aspectRatio,
              });

              const genResult = response.data?.data || response.data;
              const tasks = genResult.tasks || (genResult.taskId ? [{ taskId: genResult.taskId, ratio: item.aspectRatio }] : []);

              // Signal that generate is done — next ref can start
              return { genDone: true, pollPromise: (async () => {
                if (tasks.length === 0) return;

                // Step 2: Poll tasks (slow)
                const taskResults = await Promise.allSettled(tasks.map(pollTask));
                const completedTasks = taskResults.filter(r => r.status === 'fulfilled').map(r => r.value);
                const failedTasks = taskResults.filter(r => r.status === 'rejected').map(r => r.reason?.message);

                if (failedTasks.length > 0) allErrors.push(...failedTasks);
                if (completedTasks.length === 0) return;

                // Step 3: Save creatives
                const groupId = crypto.randomUUID();
                const resolvedRefUrl = currentRef?.image_url || currentRef?.thumbnail || currentRef?.url || refUrl;

                const savedCreatives = await Promise.all(completedTasks.map(async (task) => {
                  const saveRes = await api.post('/statics-generation/creatives', {
                    product_id: item.productId || null,
                    product_name: item.productName,
                    image_url: task.imageUrl,
                    angle: item.angle || null,
                    aspect_ratio: task.ratio,
                    group_id: groupId,
                    generation_task_id: task.taskId,
                    adapted_text: genResult.adaptedText || genResult.claudeAnalysis?.adapted_text,
                    swap_pairs: genResult.swapPairs,
                    claude_analysis: genResult.claudeAnalysis,
                    reference_thumbnail: resolvedRefUrl,
                    reference_name: currentRef?.name || 'Reference',
                    source_label: currentRef?.source_label || currentRef?.name || null,
                    pipeline: 'standard',
                  });
                  return saveRes.data?.data || saveRes.data;
                }));

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
        queueProcessingRef.current = false;
        setQueueProcessing(false);
        // Catch-up fetch after queue item to pick up server-side 9:16 variants
        setTimeout(() => fetchCreatives(true), 3000);
      }
    };

    processNext();
  }, [queue, queueProcessing, generating]);

  // Fetch creatives for pipeline
  // `silent` skips the loading spinner — used by auto-refresh so the UI
  // doesn't flash a spinner every 8 seconds while items are generating.
  const fetchCreatives = async (silent = false) => {
    if (!silent) setCreativesLoading(true);
    try {
      const res = await api.get('/statics-generation/creatives/pipeline');
      const pipeline = res.data?.data || {};
      const variants = res.data?.variants || [];
      const flat = [
        ...(pipeline.generating || []),
        ...(pipeline.review || []),
        ...(pipeline.approved || []),
        ...(pipeline.ready || []),
        ...(pipeline.launched || []),
        ...variants,
      ];
      setCreatives(flat);
    } catch {
      // silently fail
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
      setTemplates(res.data?.data || res.data || []);
    } catch {
      // silently fail
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleApproveCreative = async (id) => {
    try {
      await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'approved' });
      setCreatives((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'approved' } : c)));
    } catch {
      addToast('Failed to approve creative', 'error');
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

  // Prefetch templates on mount so the library modal opens instantly
  useEffect(() => {
    if (!templatesFetched.current) {
      fetchTemplates();
      templatesFetched.current = true;
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'pipeline') {
      if (activePipeline === 'standard') {
        fetchCreatives();
      } else {
        fetchAdvCopies();
      }
    } else if (activeTab === 'library') {
      if (!templatesFetched.current) {
        fetchTemplates();
        templatesFetched.current = true;
      }
    } else if (activeTab === 'generated') {
      if (!creativesFetched.current) {
        fetchAllCreatives();
        creativesFetched.current = true;
      }
    }
  }, [activeTab, activePipeline]);

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
        <>
          {/* Sub-tab: Standard / Advertorial toggle */}
          <div className="mb-6">
            <PipelineToggle active={activePipeline} onChange={setActivePipeline} />
          </div>

          {/* ---- Standard Pipeline ---- */}
          {activePipeline === 'standard' && (
            <div className="flex gap-0">
              {/* Left: ConfigSidebar */}
              <div className="w-[280px] shrink-0 space-y-4 pr-0 border-r border-white/[0.04]">
                <ConfigSidebar
                  selectedProduct={selectedProductId}
                  selectedProductObj={selectedProductObj}
                  onProductChange={(product) => handleProductSelect(product)}
                  angle={marketingAngle}
                  onAngleChange={setMarketingAngle}
                  customAngle={customAngle}
                  onCustomAngleChange={setCustomAngle}
                  references={references}
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
                  onAddToQueue={handleAddToQueue}
                  generating={generating}
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
                {/* ---- Generation Queue Panel ---- */}
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
                          {/* Status icon */}
                          <span className="shrink-0 w-5 text-center">
                            {item.status === 'queued' && <Clock className="w-3.5 h-3.5 text-slate-500 inline" />}
                            {item.status === 'generating' && <Loader2 className="w-3.5 h-3.5 text-accent-text animate-spin inline" />}
                            {item.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline" />}
                            {item.status === 'partial' && <AlertCircle className="w-3.5 h-3.5 text-amber-400 inline" />}
                            {item.status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-400 inline" />}
                          </span>
                          {/* Status label */}
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
                          {/* Angle */}
                          <span className="text-xs text-slate-300 truncate flex-1">
                            {item.customAngle || item.angle || 'No angle'}
                          </span>
                          {/* Reference count */}
                          <span className="text-[11px] text-slate-500 shrink-0">
                            {item.references.length} ref{item.references.length !== 1 ? 's' : ''}
                          </span>
                          {/* Result info or error */}
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
                          {/* Retry button (error or partial) */}
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
                          {/* Remove / dismiss button (queued, error, done) */}
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

                <PipelineView
                  creatives={creatives}
                  loading={creativesLoading}
                  onRefresh={fetchCreatives}
                  queue={queue}
                  onRemoveFromQueue={handleRemoveFromQueue}
                  onStatusChange={async (id, newStatus) => {
                    try {
                      await api.patch(`/statics-generation/creatives/${id}/status`, { status: newStatus });
                      setCreatives(prev => prev.map(c => c.id === id ? { ...c, status: newStatus } : c));
                      // Refresh after approval to pick up auto-generated 9:16 variant
                      if (newStatus === 'approved') setTimeout(() => fetchCreatives(), 3000);
                    } catch (err) {
                      console.error('[Pipeline] Status change failed:', err.message);
                    }
                  }}
                  onCardClick={(creative) => setDetailModal(creative)}
                  onOpenTemplates={() => setTemplateEditorOpen(true)}
                  onOpenCopySets={() => setCopySetsOpen(true)}
                />

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
                    const status = v.status === 'generating' ? 'generating'
                      : v.status === 'rejected' ? 'failed'
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
                                    } catch {}
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

          {/* ---- Advertorial Pipeline ---- */}
          {activePipeline === 'advertorial' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* LEFT PANEL -- Advertorial Form */}
              <div className="lg:col-span-1 space-y-4">
                {/* Product Selector */}
                <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
                  <label className={labelClasses}>Product</label>
                  <ProductSelector
                    selectedId={advSelectedProductId}
                    onSelect={handleAdvProductSelect}
                  />
                  {!advSelectedProductId && (
                    <div className="pt-1">
                      <label className={labelClasses}>
                        Product Name <span className="text-accent-text">*</span>
                      </label>
                      <input
                        type="text"
                        value={advProductName}
                        onChange={(e) => setAdvProductName(e.target.value)}
                        placeholder="e.g. GlowSkin Serum"
                        className={inputClasses}
                      />
                    </div>
                  )}
                  {advSelectedProductId && (
                    <div className="flex items-center gap-2 pt-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-sm text-emerald-300">{advProductName}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setAdvSelectedProductId(null);
                          setAdvProductName('');
                        }}
                        className="ml-auto text-[10px] text-slate-500 hover:text-white cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>

                {/* Marketing Angle */}
                <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                  <label className={labelClasses}>Angle / Hook Direction</label>
                  <input
                    type="text"
                    value={advAngle}
                    onChange={(e) => setAdvAngle(e.target.value)}
                    placeholder="e.g. Pain point, social proof, curiosity"
                    className={inputClasses}
                  />
                </div>

                {/* Source Copy */}
                <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className={labelClasses + ' mb-0'}>
                      Source Copy <span className="text-accent-text">*</span>
                    </label>
                    <span className={`text-[10px] ${advSourceCopy.length >= 100 ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {advSourceCopy.split(/\s+/).filter(Boolean).length} words
                    </span>
                  </div>
                  <textarea
                    value={advSourceCopy}
                    onChange={(e) => setAdvSourceCopy(e.target.value)}
                    placeholder="Paste competitor's advertorial copy here (300+ words recommended)..."
                    rows={12}
                    className={inputClasses + ' resize-none'}
                  />
                  {advSourceCopy.trim().length > 0 && advSourceCopy.trim().length < 100 && (
                    <p className="text-[10px] text-amber-400">
                      Copy is short. 300+ words recommended for best results.
                    </p>
                  )}
                </div>

                {/* Generate Button */}
                <button
                  type="button"
                  onClick={handleAdvGenerate}
                  disabled={!canGenerateAdv}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                    canGenerateAdv
                      ? 'bg-accent hover:bg-accent-hover text-white'
                      : 'bg-accent/30 text-white/40 cursor-not-allowed'
                  }`}
                >
                  {advGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating Variants...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Generate 3 Copy Variants
                    </>
                  )}
                </button>

                {/* Status flow legend */}
                <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                  <label className={labelClasses}>Status Flow</label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ADVERTORIAL_STATUSES.map((s, i) => (
                      <div key={s} className="flex items-center gap-1.5">
                        <StatusBadge status={s} />
                        {i < ADVERTORIAL_STATUSES.length - 1 && (
                          <ArrowRight className="w-3 h-3 text-slate-600" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT PANEL -- Advertorial Copies */}
              <div className="lg:col-span-2 space-y-6">
                {/* Error */}
                {advError && !advGenerating && (
                  <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-6">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="text-sm font-medium text-red-300 mb-1">Generation Failed</h3>
                        <p className="text-sm text-red-400/80">{advError}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAdvError(null)}
                      className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Loading */}
                {advGenerating && (
                  <div className="bg-[#111] border border-white/[0.06] rounded-lg p-8">
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-5 h-5 text-accent-text animate-spin" />
                      <div>
                        <h3 className="text-sm font-medium text-white">Generating copy variants...</h3>
                        <p className="text-xs text-slate-400 mt-1">
                          Creating direct adapt, pain pivot, and creative swing variants
                        </p>
                      </div>
                    </div>
                    <div className="mt-6 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                      <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '60%' }} />
                    </div>
                  </div>
                )}

                {/* Empty State */}
                {!advGenerating && advCopies.length === 0 && !advError && (
                  <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
                    <FileText className="w-12 h-12 text-slate-700 mb-4" />
                    <p className="text-sm text-slate-500 max-w-xs">
                      Paste competitor copy and select a product to generate advertorial variants
                    </p>
                    <div className="flex items-center gap-4 mt-6">
                      {Object.entries(VARIANT_TYPE_COLORS).map(([key, config]) => (
                        <div key={key} className="flex items-center gap-1.5">
                          <CircleDot className={`w-3 h-3 ${config.text}`} />
                          <span className="text-xs text-slate-500">{config.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Copy Cards */}
                {advCopies.length > 0 && !advGenerating && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-medium text-white">
                        Copy Variants
                        <span className="ml-2 text-xs text-slate-500">({advCopies.length})</span>
                      </h3>
                      <button
                        type="button"
                        onClick={fetchAdvCopies}
                        disabled={advCopiesLoading}
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
                      >
                        <RefreshCw className={`w-3 h-3 ${advCopiesLoading ? 'animate-spin' : ''}`} />
                        Refresh
                      </button>
                    </div>
                    <div className="space-y-4">
                      {advCopies.map((copy) => (
                        <AdvertorialCopyCard
                          key={copy.id}
                          copy={copy}
                          onStatusChange={handleAdvStatusChange}
                          onGenerateImages={handleAdvGenerateImages}
                          generatingImages={advGeneratingImagesFor === copy.id}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ================================================================= */}
      {/* LIBRARY TAB                                                        */}
      {/* ================================================================= */}
      {activeTab === 'library' && (
        <LibraryView
          templates={templates}
          onSelectTemplate={(template) => {
            handleTemplateSelect(template);
            setReferences(prev => [...prev, { id: template.id || Date.now(), image_url: template.image_url, name: template.name }]);
            setActiveTab('pipeline');
          }}
          onAddReference={() => setAddRefModal(true)}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
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
        <div className="max-w-4xl">
          <div className="mb-6">
            <h2 className="text-base font-semibold text-text-primary mb-1">Generation Logic & Prompt Settings</h2>
            <p className="text-sm text-text-muted">Configure how Claude analyzes reference ads and how images are generated. Changes apply to all future generations.</p>
          </div>
          <StaticsSettingsInline />
        </div>
      )}

      {/* ================================================================= */}
      {/* MODALS                                                             */}
      {/* ================================================================= */}
      {templateModal && (
        <TemplateSelectModal
          isOpen={true}
          templates={templates}
          onSelect={(template) => {
            handleTemplateSelect(template);
            setReferences(prev => [...prev, { id: template.id || Date.now(), image_url: template.image_url, name: template.name }]);
          }}
          onClose={() => setTemplateModal(false)}
        />
      )}

      {detailModal && (
        <CreativeDetailModal
          key={detailModal?.id}
          creative={detailModal}
          variant={creatives.find(c => c.parent_creative_id === detailModal.id && c.aspect_ratio === '9:16')}
          isOpen={true}
          onClose={() => setDetailModal(null)}
          onApprove={async (id) => {
            try {
              await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'approved' });
              setCreatives(prev => prev.map(c => c.id === id ? { ...c, status: 'approved' } : c));
              setDetailModal(null);
              // Refresh after a delay to pick up the auto-generated 9:16 variant
              setTimeout(() => fetchCreatives(), 3000);
            } catch { /* silently fail */ }
          }}
          onReject={async (id) => {
            try {
              await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'rejected' });
              setCreatives(prev => prev.filter(c => c.id !== id));
              setDetailModal(null);
            } catch { /* silently fail */ }
          }}
          onDelete={async (id) => {
            try {
              await api.delete(`/statics-generation/creatives/${id}`);
              setCreatives(prev => prev.filter(c => c.id !== id));
              setDetailModal(null);
            } catch { /* silently fail */ }
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
            } catch { /* silently fail */ }
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
          onSaved={() => { setTemplateEditorOpen(false); setEditingTemplate(null); }}
        />
      )}

      {copySetsOpen && (
        <AdCopySetsManager
          open
          onClose={() => setCopySetsOpen(false)}
          productId={selectedProductId}
          productName={productName}
        />
      )}
    </div>
  );
}
