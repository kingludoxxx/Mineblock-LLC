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
} from 'lucide-react';
import api from '../../services/api';
import ProductSelector from '../../components/ProductSelector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileToBase64 = (file) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
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
  queued: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/20' },
  launched: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/20' },
  draft: { bg: 'bg-slate-500/10', text: 'text-slate-300', border: 'border-slate-500/20' },
  copy_review: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/20' },
  images_pending: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/20' },
  images_review: { bg: 'bg-cyan-500/10', text: 'text-cyan-300', border: 'border-cyan-500/20' },
  ready: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/20' },
};

const VARIANT_TYPE_COLORS = {
  direct_adapt: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/20', label: 'Direct Adapt' },
  pain_pivot: { bg: 'bg-orange-500/10', text: 'text-orange-300', border: 'border-orange-500/20', label: 'Pain Pivot' },
  creative_swing: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/20', label: 'Creative Swing' },
};

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
            ? 'border-blue-500/60 bg-blue-500/5'
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
          className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-blue-500/50 focus:outline-none"
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
              ? 'bg-blue-600 text-white'
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
      {isActive && <Loader2 className="w-4 h-4 text-blue-400 animate-spin ml-auto" />}
    </div>
  );
}

function CopyBadge({ text }) {
  return (
    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">
      {text}
    </span>
  );
}

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.draft;
  const display = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
    <div className="flex bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-1 mb-6">
      <button
        type="button"
        onClick={() => onChange('standard')}
        className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
          active === 'standard'
            ? 'bg-blue-600 text-white'
            : 'text-slate-400 hover:text-white'
        }`}
      >
        <Layers className="w-4 h-4" />
        Standard Statics
      </button>
      <button
        type="button"
        onClick={() => onChange('advertorial')}
        className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
          active === 'advertorial'
            ? 'bg-blue-600 text-white'
            : 'text-slate-400 hover:text-white'
        }`}
      >
        <FileText className="w-4 h-4" />
        Advertorial Statics
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
              <span className="inline-block px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white">
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
                ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400/50 cursor-not-allowed'
                : 'bg-blue-500/10 border border-blue-500/20 text-blue-300 hover:bg-blue-500/20'
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 hover:bg-blue-500/20 transition-colors cursor-pointer"
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
                  className="w-full h-24 rounded-md object-cover border border-white/[0.06]"
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
// Main Component
// ---------------------------------------------------------------------------

export default function StaticsGeneration() {
  // Pipeline toggle
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
  const [marketingAngle, setMarketingAngle] = useState('');
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

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Creative review state (Standard pipeline)
  const [creatives, setCreatives] = useState([]);
  const [creativesLoading, setCreativesLoading] = useState(false);
  const [references, setReferences] = useState([]);

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

  const handleProductSelect = (product) => {
    if (!product) {
      setSelectedProductId(null);
      return;
    }
    setSelectedProductId(product.id);
    setProductName(product.name || '');
    setProductDescription(product.description || '');
    setProductPrice(product.price || '');
    if (product.product_images?.length > 0) {
      setProductImageUrl(product.product_images[0]);
      setProductPreview(product.product_images[0]);
    }
    setOneliner(product.oneliner || '');
    setCustomerAvatar(product.customer_avatar || '');
    setCustomerFrustration(product.customer_frustration || '');
    setCustomerDream(product.customer_dream || '');
    setBigPromise(product.big_promise || '');
    setMechanism(product.mechanism || '');
    setDifferentiator(product.differentiator || '');
    setVoice(product.voice || '');
    setGuarantee(product.guarantee || '');
    if (product.angles?.length > 0) {
      setMarketingAngle(product.angles[0].name || '');
    }
  };

  // Derived
  const hasReferenceImage = !!(referencePreview || referenceImageUrl);
  const hasProductImage = !!(productPreview || productImageUrl);
  const canGenerate = hasReferenceImage && productName.trim() && hasProductImage && !generating;

  const handleReferenceFile = useCallback((file) => {
    setReferenceFile(file);
    setReferencePreview(URL.createObjectURL(file));
    setReferenceImageUrl('');
  }, []);

  const clearReference = useCallback(() => {
    setReferenceFile(null);
    setReferencePreview('');
    setReferenceImageUrl('');
  }, []);

  const handleProductFile = useCallback((file) => {
    setProductFile(file);
    setProductPreview(URL.createObjectURL(file));
    setProductImageUrl('');
  }, []);

  const clearProduct = useCallback(() => {
    setProductFile(null);
    setProductPreview('');
    setProductImageUrl('');
  }, []);

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setGenerating(true);
    setGenerationStep(1);
    setResult(null);
    setError(null);

    try {
      let resolvedReferenceUrl = referenceImageUrl;
      if (referenceFile) {
        resolvedReferenceUrl = await fileToBase64(referenceFile);
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

      const stepTimer2 = setTimeout(() => setGenerationStep(2), 10000);
      const stepTimer3 = setTimeout(() => setGenerationStep(3), 30000);

      const response = await api.post('/statics-generation/generate', {
        reference_image_url: resolvedReferenceUrl,
        product: {
          name: productName,
          description: productDescription || undefined,
          price: productPrice || undefined,
          product_image_url: resolvedProductUrl,
          profile: Object.keys(profile).length > 0 ? profile : undefined,
        },
        angle: marketingAngle || undefined,
        ratio: aspectRatio,
      });

      clearTimeout(stepTimer2);
      clearTimeout(stepTimer3);

      setResult(response.data?.data || response.data);
      setGenerationStep(0);
    } catch (err) {
      const message =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        'An unexpected error occurred';
      setError(message);
      setGenerationStep(0);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateAnother = () => {
    setResult(null);
    setError(null);
    setGenerationStep(0);
  };

  // Fetch creatives for review
  const fetchCreatives = async () => {
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

  const handleApproveCreative = async (id) => {
    try {
      await api.patch(`/statics-generation/creatives/${id}/status`, { status: 'approved' });
      setCreatives((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'approved' } : c)));
    } catch {
      // silently fail
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

  // Fetch data on pipeline switch
  useEffect(() => {
    if (activePipeline === 'standard') {
      fetchCreatives();
    } else {
      fetchAdvCopies();
    }
  }, [activePipeline]);

  // --- Render helpers ---

  const inputClasses =
    'w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-blue-500/50 focus:outline-none';
  const labelClasses = 'text-xs text-slate-400 mb-1.5 block';

  const ratios = ['4:5', '9:16', '1:1'];

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-blue-500/20">
          <Layers className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Statics Generation</h1>
          <p className="text-sm text-slate-400">
            Generate new ad creatives from a reference image and product details
          </p>
        </div>
      </div>

      {/* Pipeline Toggle */}
      <PipelineToggle active={activePipeline} onChange={setActivePipeline} />

      {/* ================================================================= */}
      {/* STANDARD PIPELINE                                                  */}
      {/* ================================================================= */}
      {activePipeline === 'standard' && (
        <>
          {/* Product Selector */}
          <div className="mb-6">
            <label className="text-xs text-slate-400 mb-1.5 block">Load from Product Library</label>
            <ProductSelector
              selectedId={selectedProductId}
              onSelect={handleProductSelect}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* =========================================================== */}
            {/* LEFT PANEL -- Form                                           */}
            {/* =========================================================== */}
            <div className="lg:col-span-1 space-y-4">
              {/* Reference Ad Image */}
              <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
                <label className={labelClasses}>
                  Reference Ad Image <span className="text-blue-400">*</span>
                </label>
                <UploadZone
                  preview={referencePreview}
                  onFile={handleReferenceFile}
                  onUrlChange={(url) => {
                    setReferenceImageUrl(url);
                    setReferenceFile(null);
                    setReferencePreview('');
                  }}
                  urlValue={referenceImageUrl}
                  onClear={clearReference}
                  label="Reference ad"
                />
              </div>

              {/* Product Info -- hidden when product selected from library */}
              {!selectedProductId && (
                <>
                  <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
                    <h3 className="text-sm font-medium text-white mb-1">Product Info</h3>

                    <div>
                      <label className={labelClasses}>
                        Product Name <span className="text-blue-400">*</span>
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
                        Product Photo <span className="text-blue-400">*</span>
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
                    </div>
                  </div>

                  {/* Product Profile (collapsible) */}
                  <div className="bg-[#111] border border-white/[0.06] rounded-lg">
                    <button
                      type="button"
                      onClick={() => setProfileOpen(!profileOpen)}
                      className="w-full flex items-center justify-between p-5 cursor-pointer"
                    >
                      <span className="text-sm font-medium text-white">Product Profile</span>
                      {profileOpen ? (
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400" />
                      )}
                    </button>

                    {profileOpen && (
                      <div className="px-5 pb-5 space-y-3 border-t border-white/[0.04] pt-4">
                        <div>
                          <label className={labelClasses}>Oneliner</label>
                          <input
                            type="text"
                            value={oneliner}
                            onChange={(e) => setOneliner(e.target.value)}
                            placeholder="One-sentence product pitch"
                            className={inputClasses}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Customer Avatar</label>
                          <input
                            type="text"
                            value={customerAvatar}
                            onChange={(e) => setCustomerAvatar(e.target.value)}
                            placeholder="Who is your ideal customer?"
                            className={inputClasses}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Customer Frustration</label>
                          <textarea
                            value={customerFrustration}
                            onChange={(e) => setCustomerFrustration(e.target.value)}
                            placeholder="What frustrates them?"
                            rows={2}
                            className={inputClasses + ' resize-none'}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Customer Dream</label>
                          <textarea
                            value={customerDream}
                            onChange={(e) => setCustomerDream(e.target.value)}
                            placeholder="What do they aspire to?"
                            rows={2}
                            className={inputClasses + ' resize-none'}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Big Promise</label>
                          <textarea
                            value={bigPromise}
                            onChange={(e) => setBigPromise(e.target.value)}
                            placeholder="Your main value proposition"
                            rows={2}
                            className={inputClasses + ' resize-none'}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Mechanism</label>
                          <textarea
                            value={mechanism}
                            onChange={(e) => setMechanism(e.target.value)}
                            placeholder="How does it work?"
                            rows={2}
                            className={inputClasses + ' resize-none'}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Differentiator</label>
                          <textarea
                            value={differentiator}
                            onChange={(e) => setDifferentiator(e.target.value)}
                            placeholder="What makes it unique?"
                            rows={2}
                            className={inputClasses + ' resize-none'}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Voice / Tone</label>
                          <input
                            type="text"
                            value={voice}
                            onChange={(e) => setVoice(e.target.value)}
                            placeholder="e.g. Bold, friendly, clinical"
                            className={inputClasses}
                          />
                        </div>

                        <div>
                          <label className={labelClasses}>Guarantee</label>
                          <input
                            type="text"
                            value={guarantee}
                            onChange={(e) => setGuarantee(e.target.value)}
                            placeholder="e.g. 30-day money-back guarantee"
                            className={inputClasses}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Selected product summary */}
              {selectedProductId && (
                <div className="bg-[#111] border border-emerald-500/20 rounded-lg p-5 space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-emerald-400">Product Loaded</h3>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedProductId(null);
                        setProductName('');
                        setProductDescription('');
                        setProductPrice('');
                        setProductImageUrl('');
                        setProductPreview('');
                        setOneliner('');
                        setCustomerAvatar('');
                        setCustomerFrustration('');
                        setCustomerDream('');
                        setBigPromise('');
                        setMechanism('');
                        setDifferentiator('');
                        setVoice('');
                        setGuarantee('');
                        setMarketingAngle('');
                      }}
                      className="text-[10px] text-slate-500 hover:text-white transition-colors cursor-pointer"
                    >
                      Clear & enter manually
                    </button>
                  </div>
                  <p className="text-white text-sm font-medium">{productName}</p>
                  {productDescription && <p className="text-xs text-slate-400 line-clamp-2">{productDescription}</p>}
                  {productPreview && (
                    <img src={productPreview} alt="" className="w-16 h-16 rounded-md object-cover border border-white/[0.06] mt-1" />
                  )}
                </div>
              )}

              {/* Marketing Angle */}
              <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                <label className={labelClasses}>Marketing Angle</label>
                <input
                  type="text"
                  value={marketingAngle}
                  onChange={(e) => setMarketingAngle(e.target.value)}
                  placeholder="e.g. Social proof, urgency, before/after"
                  className={inputClasses}
                />
              </div>

              {/* Aspect Ratio */}
              <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                <label className={labelClasses}>Aspect Ratio</label>
                <div className="flex gap-2">
                  {ratios.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setAspectRatio(r)}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                        aspectRatio === r
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-transparent border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {/* Generate Button */}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate}
                className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  canGenerate
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-blue-600/30 text-white/40 cursor-not-allowed'
                }`}
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate Creative
                  </>
                )}
              </button>
            </div>

            {/* =========================================================== */}
            {/* RIGHT PANEL -- Results + Creative Review                      */}
            {/* =========================================================== */}
            <div className="lg:col-span-2 space-y-6">
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
                    <StepperIndicator
                      step={1}
                      currentStep={generationStep}
                      label="Analyzing reference ad with AI..."
                    />
                    <StepperIndicator
                      step={2}
                      currentStep={generationStep}
                      label="Generating new creative..."
                    />
                    <StepperIndicator
                      step={3}
                      currentStep={generationStep}
                      label="Finalizing image..."
                    />
                  </div>
                  <div className="mt-6 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                    <div
                      className="h-full bg-blue-600 rounded-full transition-all duration-1000 ease-out"
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

              {/* ---- Empty State ---- */}
              {!generating && !result && !error && creatives.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
                  <Layers className="w-12 h-12 text-slate-700 mb-4" />
                  <p className="text-sm text-slate-500 max-w-xs">
                    Upload a reference ad and fill in product details to generate a new creative
                  </p>
                </div>
              )}

              {/* ---- Results State ---- */}
              {!generating && result && (
                <div className="space-y-6">
                  {/* No image warning */}
                  {!result.generated_image_url && (
                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 flex items-start gap-3">
                      <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm text-yellow-300 font-medium">Image generation skipped</p>
                        <p className="text-xs text-yellow-400/70 mt-1">
                          {result._note || 'Provide a reference image via URL (not file upload) to enable image generation.'}
                        </p>
                      </div>
                    </div>
                  )}
                  {/* Generated Image */}
                  {result.generated_image_url && (
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                      <h3 className="text-sm font-medium text-white mb-3">Generated Creative</h3>
                      <img
                        src={result.generated_image_url}
                        alt="Generated creative"
                        className="w-full rounded-lg border border-white/[0.06]"
                      />
                      <div className="flex gap-3 mt-4">
                        <button
                          type="button"
                          onClick={() => downloadImage(result.generated_image_url)}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-500/30 text-sm text-blue-300 hover:bg-blue-500/10 transition-colors cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </button>
                        <button
                          type="button"
                          onClick={handleGenerateAnother}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm text-white transition-colors cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Generate Another
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Side-by-side Comparison */}
                  {result.generated_image_url && (referencePreview || referenceImageUrl) && (
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                      <h3 className="text-sm font-medium text-white mb-3">Comparison</h3>
                      <div className="flex gap-4">
                        <div className="flex-1">
                          <span className="text-xs text-slate-400 mb-1.5 block">Reference</span>
                          <img
                            src={referencePreview || referenceImageUrl}
                            alt="Reference"
                            className="w-full rounded-lg border border-white/[0.06] object-cover"
                          />
                        </div>
                        <div className="flex-1">
                          <span className="text-xs text-slate-400 mb-1.5 block">Generated</span>
                          <img
                            src={result.generated_image_url}
                            alt="Generated"
                            className="w-full rounded-lg border border-white/[0.06] object-cover"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Adapted Copy Card */}
                  {result.adapted_text && (
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                      <h3 className="text-sm font-medium text-white mb-4">Adapted Copy</h3>
                      <div className="space-y-4">
                        {result.adapted_text.headline && (
                          <div>
                            <span className={labelClasses}>Headline</span>
                            <p className="text-sm text-white">{result.adapted_text.headline}</p>
                          </div>
                        )}
                        {result.adapted_text.subheadline && (
                          <div>
                            <span className={labelClasses}>Subheadline</span>
                            <p className="text-sm text-slate-300">{result.adapted_text.subheadline}</p>
                          </div>
                        )}
                        {result.adapted_text.body && (
                          <div>
                            <span className={labelClasses}>Body</span>
                            <p className="text-sm text-slate-300 whitespace-pre-line">
                              {result.adapted_text.body}
                            </p>
                          </div>
                        )}
                        {result.adapted_text.cta && (
                          <div>
                            <span className={labelClasses}>CTA</span>
                            <span className="inline-block px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white">
                              {result.adapted_text.cta}
                            </span>
                          </div>
                        )}
                        {result.adapted_text.badges && result.adapted_text.badges.length > 0 && (
                          <div>
                            <span className={labelClasses}>Badges</span>
                            <div className="flex flex-wrap gap-1.5">
                              {result.adapted_text.badges.map((badge, i) => (
                                <CopyBadge key={i} text={badge} />
                              ))}
                            </div>
                          </div>
                        )}
                        {result.adapted_text.bullets && result.adapted_text.bullets.length > 0 && (
                          <div>
                            <span className={labelClasses}>Bullets</span>
                            <div className="flex flex-wrap gap-1.5">
                              {result.adapted_text.bullets.map((bullet, i) => (
                                <CopyBadge key={i} text={bullet} />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Text Swaps Table */}
                  {result.swap_pairs && result.swap_pairs.length > 0 && (
                    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                      <h3 className="text-sm font-medium text-white mb-3">Text Swaps</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-white/[0.06]">
                              <th className="text-left py-2 pr-4 text-xs font-medium text-slate-400">
                                Original
                              </th>
                              <th className="w-8" />
                              <th className="text-left py-2 pl-4 text-xs font-medium text-slate-400">
                                Adapted
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.swap_pairs.map((swap, i) => (
                              <tr key={i} className="border-b border-white/[0.03] last:border-0">
                                <td className="py-2.5 pr-4 text-slate-400">{swap.original}</td>
                                <td className="py-2.5 text-center">
                                  <ArrowRight className="w-3.5 h-3.5 text-slate-600 inline-block" />
                                </td>
                                <td className="py-2.5 pl-4 text-white">{swap.adapted}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ---- Reference Images Grid ---- */}
              {references.length > 0 && !generating && !result && (
                <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                  <h3 className="text-sm font-medium text-white mb-3">Saved References</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {references.map((ref, i) => (
                      <button
                        key={ref.id || i}
                        type="button"
                        onClick={() => {
                          setReferenceImageUrl(ref.url || ref.image_url);
                          setReferencePreview(ref.url || ref.image_url);
                          setReferenceFile(null);
                        }}
                        className="group relative rounded-lg overflow-hidden border border-white/[0.06] hover:border-blue-500/40 transition-colors cursor-pointer"
                      >
                        <img
                          src={ref.url || ref.image_url}
                          alt={ref.name || 'Reference'}
                          className="w-full h-24 object-cover"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                          <span className="text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                            Use
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ---- Creative Review Cards ---- */}
              {creatives.length > 0 && !generating && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-white">Creative Review</h3>
                    <button
                      type="button"
                      onClick={fetchCreatives}
                      disabled={creativesLoading}
                      className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
                    >
                      <RefreshCw className={`w-3 h-3 ${creativesLoading ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {creatives.map((creative) => (
                      <CreativeReviewCard
                        key={creative.id}
                        creative={creative}
                        onApprove={handleApproveCreative}
                        onReject={handleRejectCreative}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ================================================================= */}
      {/* ADVERTORIAL PIPELINE                                               */}
      {/* ================================================================= */}
      {activePipeline === 'advertorial' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ============================================================= */}
          {/* LEFT PANEL -- Advertorial Form                                  */}
          {/* ============================================================= */}
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
                    Product Name <span className="text-blue-400">*</span>
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
                  Source Copy <span className="text-blue-400">*</span>
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
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-blue-600/30 text-white/40 cursor-not-allowed'
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

          {/* ============================================================= */}
          {/* RIGHT PANEL -- Advertorial Copies                               */}
          {/* ============================================================= */}
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
                  <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                  <div>
                    <h3 className="text-sm font-medium text-white">Generating copy variants...</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Creating direct adapt, pain pivot, and creative swing variants
                    </p>
                  </div>
                </div>
                <div className="mt-6 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full bg-blue-600 rounded-full animate-pulse" style={{ width: '60%' }} />
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
    </div>
  );
}
