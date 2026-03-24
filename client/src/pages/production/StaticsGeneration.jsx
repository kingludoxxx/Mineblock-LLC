import { useState, useRef, useCallback } from 'react';
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
            ? 'border-violet-500/60 bg-violet-500/5'
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
          className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-violet-500/50 focus:outline-none"
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
              ? 'bg-violet-600 text-white'
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
      {isActive && <Loader2 className="w-4 h-4 text-violet-400 animate-spin ml-auto" />}
    </div>
  );
}

function CopyBadge({ text }) {
  return (
    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20">
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function StaticsGeneration() {
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

  const handleProductSelect = (product) => {
    if (!product) {
      setSelectedProductId(null);
      return;
    }
    setSelectedProductId(product.id);
    setProductName(product.name || '');
    setProductDescription(product.description || '');
    setProductPrice(product.price || '');
    // Set product image from first product_images entry
    if (product.product_images?.length > 0) {
      setProductImageUrl(product.product_images[0]);
      setProductPreview(product.product_images[0]);
    }
    // Profile fields
    setOneliner(product.oneliner || '');
    setCustomerAvatar(product.customer_avatar || '');
    setCustomerFrustration(product.customer_frustration || '');
    setCustomerDream(product.customer_dream || '');
    setBigPromise(product.big_promise || '');
    setMechanism(product.mechanism || '');
    setDifferentiator(product.differentiator || '');
    setVoice(product.voice || '');
    setGuarantee(product.guarantee || '');
    // Set first angle if available
    if (product.angles?.length > 0) {
      setMarketingAngle(product.angles[0].name || '');
    }
  };

  // Derived
  const hasReferenceImage = !!(referencePreview || referenceImageUrl);
  const hasProductImage = !!(productPreview || productImageUrl);
  const canGenerate = hasReferenceImage && productName.trim() && hasProductImage && !generating;

  // --- File handlers ---

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

  // --- Generate ---

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setGenerating(true);
    setGenerationStep(1);
    setResult(null);
    setError(null);

    try {
      // Resolve reference image
      let resolvedReferenceUrl = referenceImageUrl;
      if (referenceFile) {
        resolvedReferenceUrl = await fileToBase64(referenceFile);
      }

      // Resolve product image
      let resolvedProductUrl = productImageUrl;
      if (productFile) {
        resolvedProductUrl = await fileToBase64(productFile);
      }

      // Build profile (omit empty values)
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

      // Step progression timers (UI-only since backend handles polling)
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

  // --- Render helpers ---

  const inputClasses =
    'w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-violet-500/50 focus:outline-none';
  const labelClasses = 'text-xs text-slate-400 mb-1.5 block';

  const ratios = ['4:5', '9:16', '1:1'];

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-violet-500/20">
          <Layers className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Statics Generation</h1>
          <p className="text-sm text-slate-400">
            Generate new ad creatives from a reference image and product details
          </p>
        </div>
      </div>

      {/* Product Selector */}
      <div className="mb-6">
        <label className="text-xs text-slate-400 mb-1.5 block">Load from Product Library</label>
        <ProductSelector
          selectedId={selectedProductId}
          onSelect={handleProductSelect}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ============================================================= */}
        {/* LEFT PANEL — Form                                              */}
        {/* ============================================================= */}
        <div className="lg:col-span-1 space-y-4">
          {/* Reference Ad Image */}
          <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
            <label className={labelClasses}>
              Reference Ad Image <span className="text-violet-400">*</span>
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

          {/* Product Info — hidden when product selected from library */}
          {!selectedProductId && (
            <>
              <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-3">
                <h3 className="text-sm font-medium text-white mb-1">Product Info</h3>

                <div>
                  <label className={labelClasses}>
                    Product Name <span className="text-violet-400">*</span>
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
                    Product Photo <span className="text-violet-400">*</span>
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
                      ? 'bg-violet-600 border-violet-500 text-white'
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
                ? 'bg-violet-600 hover:bg-violet-700 text-white'
                : 'bg-violet-600/30 text-white/40 cursor-not-allowed'
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

        {/* ============================================================= */}
        {/* RIGHT PANEL — Results                                          */}
        {/* ============================================================= */}
        <div className="lg:col-span-2">
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
                  className="h-full bg-violet-600 rounded-full transition-all duration-1000 ease-out"
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
          {!generating && !result && !error && (
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
                      className="flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-500/30 text-sm text-violet-300 hover:bg-violet-500/10 transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateAnother}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-sm text-white transition-colors cursor-pointer"
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
                        <span className="inline-block px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white">
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
        </div>
      </div>
    </div>
  );
}
