import { useState, useCallback, useRef } from 'react';
import {
  Sparkles,
  Copy,
  Save,
  RefreshCw,
  Wand2,
  Link,
  Type,
  FileText,
  Zap,
  Target,
  ArrowRight,
} from 'lucide-react';
import api from '../../services/api';
import ProductSelector from '../../components/ProductSelector';

const EXAMPLE_PROMPTS = [
  {
    title: 'High-Converting VSL Script',
    description: 'Generate a video sales letter script from a competitor ad',
    reference: 'Paste your competitor\'s ad copy here and we\'ll generate a high-converting VSL script tailored to your product.',
    product: 'Digital Course',
    audience: 'Entrepreneurs 25-45',
  },
  {
    title: 'Email Sequence',
    description: 'Create a 5-email nurture sequence from a sales page',
    reference: 'Paste the sales page copy to generate a warming email sequence that builds desire and urgency.',
    product: 'SaaS Platform',
    audience: 'Small Business Owners',
  },
  {
    title: 'Ad Creative Variants',
    description: 'Generate multiple ad angles from winning copy',
    reference: 'Drop in your best-performing ad and get fresh angles that maintain the same persuasion framework.',
    product: 'Supplement Brand',
    audience: 'Health-conscious adults 30-55',
  },
];

export default function MagicWriter() {
  const [referenceMode, setReferenceMode] = useState('text');
  const [referenceText, setReferenceText] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [productName, setProductName] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [outputMode, setOutputMode] = useState('variants');
  const [variantCount, setVariantCount] = useState(3);
  const [aggressiveness, setAggressiveness] = useState(5);
  const [variants, setVariants] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [enhancingField, setEnhancingField] = useState(null);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [aiSource, setAiSource] = useState(null);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const selectedProductRef = useRef(null);

  const handleProductSelect = (product) => {
    if (!product) {
      setSelectedProductId(null);
      selectedProductRef.current = null;
      return;
    }
    setSelectedProductId(product.id);
    selectedProductRef.current = product;
    setProductName(product.name || '');
    setTargetAudience(product.customer_avatar || '');
  };

  const referenceContent = referenceMode === 'text' ? referenceText : referenceUrl;
  const canGenerate = referenceContent.trim() && productName.trim() && targetAudience.trim();

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setVariants([]);
    try {
      const full = selectedProductRef.current;
      const res = await api.post('/magic-writer/generate', {
        referenceText: referenceMode === 'text' ? referenceText : referenceUrl,
        productName,
        targetAudience,
        productProfile: full ? {
          big_promise: full.big_promise,
          mechanism: full.mechanism,
          benefits: full.benefits,
          differentiator: full.differentiator,
          guarantee: full.guarantee,
          customer_frustration: full.customer_frustration,
          customer_dream: full.customer_dream,
          voice: full.voice,
          angles: full.angles,
          pain_points: full.pain_points,
          common_objections: full.common_objections,
          competitive_edge: full.competitive_edge,
          compliance_restrictions: full.compliance_restrictions,
        } : undefined,
        mode: outputMode,
        variantCount: outputMode === 'variants' ? variantCount : 1,
        aggressiveness,
      });
      setVariants(res.data.variants || []);
      setAiSource(res.data.source || 'unknown');
    } catch {
      // Fallback mock response
      await new Promise((r) => setTimeout(r, 2000));
      const count = outputMode === 'variants' ? variantCount : 1;
      const mockVariants = Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        text: `[Variant ${i + 1}] Attention ${targetAudience}!\n\nAre you tired of [pain point]? Introducing ${productName} - the breakthrough solution that finally delivers real results.\n\nHere's what makes ${productName} different:\n\n- Unique mechanism that addresses the root cause\n- Proven results backed by real testimonials\n- Risk-free guarantee so you have nothing to lose\n\nDon't wait. The longer you delay, the longer you suffer. Click below to claim your exclusive offer before it expires.\n\n[CTA: Get ${productName} Now - Limited Time Offer]`,
      }));
      setVariants(mockVariants);
    } finally {
      setGenerating(false);
    }
  }, [canGenerate, referenceMode, referenceText, referenceUrl, productName, targetAudience, outputMode, variantCount, aggressiveness]);

  const handleEnhance = useCallback(async (field) => {
    const value = field === 'productName' ? productName : targetAudience;
    if (!value.trim()) return;
    setEnhancingField(field);
    try {
      const res = await api.post('/magic-writer/enhance', { field, value });
      if (field === 'productName') setProductName(res.data.enhanced);
      else setTargetAudience(res.data.enhanced);
    } catch {
      // Mock enhancement
      await new Promise((r) => setTimeout(r, 1000));
      if (field === 'productName') {
        setProductName((v) => `${v} - Premium Edition`);
      } else {
        setTargetAudience((v) => `${v} who are frustrated with existing solutions and ready to invest in real change`);
      }
    } finally {
      setEnhancingField(null);
    }
  }, [productName, targetAudience]);

  const handleCopy = useCallback((text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }, []);

  const handleRegenerate = useCallback(async (index) => {
    const updated = [...variants];
    updated[index] = { ...updated[index], regenerating: true };
    setVariants(updated);
    await new Promise((r) => setTimeout(r, 1500));
    updated[index] = {
      ...updated[index],
      regenerating: false,
      text: updated[index].text.replace('[Variant', '[Regenerated Variant'),
    };
    setVariants([...updated]);
  }, [variants]);

  const handlePromptClick = useCallback((prompt) => {
    setReferenceMode('text');
    setReferenceText(prompt.reference);
    setProductName(prompt.product);
    setTargetAudience(prompt.audience);
  }, []);

  const aggressivenessColor = () => {
    if (aggressiveness <= 3) return 'from-green-500 to-green-400';
    if (aggressiveness <= 6) return 'from-yellow-500 to-orange-400';
    return 'from-orange-500 to-red-500';
  };

  return (
    <div className="flex h-full">
      {/* Left Panel - Input */}
      <div className="w-[60%] min-w-[380px] overflow-y-auto p-6 border-r border-white/[0.06]">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-purple-500/20">
            <Wand2 className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Magic Writer</h1>
            <p className="text-sm text-slate-400">AI-powered copy generation</p>
          </div>
        </div>

        {/* Reference Content */}
        <section className="mb-6">
          <label className="text-sm font-medium text-slate-300 mb-2 block">Reference Content</label>
          <div className="flex bg-[#111] rounded-lg border border-white/[0.06] p-0.5 mb-3">
            <button
              onClick={() => setReferenceMode('text')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                referenceMode === 'text'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Type className="w-4 h-4" />
              Paste Text
            </button>
            <button
              onClick={() => setReferenceMode('url')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                referenceMode === 'url'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Link className="w-4 h-4" />
              URL
            </button>
          </div>
          {referenceMode === 'text' ? (
            <textarea
              value={referenceText}
              onChange={(e) => setReferenceText(e.target.value)}
              placeholder="Paste competitor ad copy, sales page text, or any reference content..."
              className="w-full h-40 bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50 transition-colors"
            />
          ) : (
            <input
              type="url"
              value={referenceUrl}
              onChange={(e) => setReferenceUrl(e.target.value)}
              placeholder="https://example.com/ad-page"
              className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
            />
          )}
        </section>

        {/* Your Product */}
        <section className="mb-6">
          <label className="text-sm font-medium text-slate-300 mb-3 block">Your Product</label>
          <div className="mb-3">
            <ProductSelector
              selectedId={selectedProductId}
              onSelect={handleProductSelect}
            />
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Product Name</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="e.g. FitPro Max Supplement"
                  className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
                <button
                  onClick={() => handleEnhance('productName')}
                  disabled={enhancingField === 'productName' || !productName.trim()}
                  className="px-3 bg-[#111] border border-white/[0.06] rounded-lg text-purple-400 hover:text-purple-300 hover:border-purple-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Enhance with AI"
                >
                  <Sparkles className={`w-4 h-4 ${enhancingField === 'productName' ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Target Audience</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  placeholder="e.g. Men 30-50 who want to lose weight"
                  className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
                <button
                  onClick={() => handleEnhance('targetAudience')}
                  disabled={enhancingField === 'targetAudience' || !targetAudience.trim()}
                  className="px-3 bg-[#111] border border-white/[0.06] rounded-lg text-purple-400 hover:text-purple-300 hover:border-purple-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Enhance with AI"
                >
                  <Sparkles className={`w-4 h-4 ${enhancingField === 'targetAudience' ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Output Mode */}
        <section className="mb-6">
          <label className="text-sm font-medium text-slate-300 mb-3 block">Output Mode</label>
          <div className="flex bg-[#111] rounded-lg border border-white/[0.06] p-0.5">
            <button
              onClick={() => setOutputMode('variants')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                outputMode === 'variants'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Generate Variants
            </button>
            <button
              onClick={() => setOutputMode('clone')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                outputMode === 'clone'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              1:1 Script Clone
            </button>
          </div>
        </section>

        {/* Variant Count */}
        {outputMode === 'variants' && (
          <section className="mb-6">
            <label className="text-sm font-medium text-slate-300 mb-3 block">Number of Variants</label>
            <div className="flex gap-2">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setVariantCount(n)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
                    variantCount === n
                      ? 'bg-purple-600 border-purple-500 text-white'
                      : 'bg-[#111] border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Aggressiveness Slider */}
        <section className="mb-8">
          <div className="flex justify-between items-center mb-3">
            <label className="text-sm font-medium text-slate-300">Conversion Aggressiveness</label>
            <span className="text-sm font-mono text-slate-400">{aggressiveness}/10</span>
          </div>
          <div className="relative">
            <input
              type="range"
              min="1"
              max="10"
              value={aggressiveness}
              onChange={(e) => setAggressiveness(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #22c55e 0%, #eab308 50%, #ef4444 100%)`,
              }}
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-green-400">Subtle</span>
              <span className="text-xs text-red-400">Aggressive</span>
            </div>
          </div>
        </section>

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={!canGenerate || generating}
          className={`w-full py-3.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
            canGenerate && !generating
              ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500 shadow-lg shadow-purple-500/25'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }`}
        >
          {generating ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              Generate Copy
            </>
          )}
        </button>
      </div>

      {/* Right Panel - Output */}
      <div className="flex-1 overflow-y-auto p-6">
        {variants.length === 0 && !generating ? (
          /* Empty State */
          <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center mb-6">
              <FileText className="w-10 h-10 text-purple-400" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Ready to Create</h2>
            <p className="text-slate-400 text-sm text-center mb-8">
              Fill in the details on the left and hit Generate, or try one of these examples to get started.
            </p>
            <div className="w-full space-y-3">
              {EXAMPLE_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handlePromptClick(prompt)}
                  className="w-full text-left p-4 bg-[#111] border border-white/[0.06] rounded-lg hover:border-purple-500/30 transition-colors group cursor-pointer"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-sm font-medium text-white group-hover:text-purple-300 transition-colors">
                        {prompt.title}
                      </h3>
                      <p className="text-xs text-slate-500 mt-1">{prompt.description}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-purple-400 transition-colors mt-0.5" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : generating ? (
          /* Loading State */
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center mb-4 animate-pulse">
              <Wand2 className="w-8 h-8 text-purple-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-1">Crafting your copy...</h2>
            <p className="text-sm text-slate-400">AI is analyzing your reference and generating variants</p>
            <div className="mt-6 flex gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-purple-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        ) : (
          /* Results */
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">
                Generated Copy
                <span className="text-sm font-normal text-slate-400 ml-2">
                  {variants.length} variant{variants.length !== 1 ? 's' : ''}
                </span>
                {aiSource && (
                  <span className={`ml-3 text-xs font-medium px-2 py-0.5 rounded-full ${
                    aiSource === 'mock'
                      ? 'bg-yellow-500/20 text-yellow-400'
                      : 'bg-green-500/20 text-green-400'
                  }`}>
                    {aiSource === 'mock' ? 'Mock Data' : `Powered by ${aiSource}`}
                  </span>
                )}
              </h2>
              <button
                onClick={handleGenerate}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-purple-400 hover:text-purple-300 bg-purple-500/10 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerate All
              </button>
            </div>
            <div className="space-y-4">
              {variants.map((variant, index) => (
                <div
                  key={variant.id}
                  className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden"
                >
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                    <span className="text-xs font-medium text-slate-400">
                      Variant {index + 1} of {variants.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleCopy(variant.text, index)}
                        className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"
                        title="Copy to clipboard"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"
                        title="Save to library"
                      >
                        <Save className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleRegenerate(index)}
                        disabled={variant.regenerating}
                        className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors disabled:opacity-40 cursor-pointer"
                        title="Regenerate this variant"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${variant.regenerating ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>
                  <div className="p-4">
                    {copiedIndex === index && (
                      <div className="text-xs text-green-400 mb-2">Copied to clipboard!</div>
                    )}
                    <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                      {variant.text}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
