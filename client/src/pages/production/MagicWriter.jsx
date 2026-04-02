import { useState, useCallback, useRef } from 'react';
import {
  Sparkles,
  Copy,
  RefreshCw,
  Wand2,
  Link,
  FileText,
  Zap,
  Eye,
  Globe,
  Loader2,
  BookOpen,
} from 'lucide-react';
import api from '../../services/api';
import ProductSelector from '../../components/ProductSelector';

const ANGLES = ['Pain Point', 'Social Proof', 'Before/After', 'Curiosity Hook', 'Direct Offer', 'Authority'];

export default function MagicWriter() {
  // Input state
  const [inputMode, setInputMode] = useState('text'); // 'spy' | 'text' | 'url'
  const [referenceText, setReferenceText] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedAngle, setSelectedAngle] = useState(null);
  const [customAngle, setCustomAngle] = useState('');
  const [outputMode, setOutputMode] = useState('variants');
  const [variantCount, setVariantCount] = useState(3);

  // Generation state
  const [variants, setVariants] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generatingStep, setGeneratingStep] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [error, setError] = useState(null);

  const referenceContent = inputMode === 'text' ? referenceText : referenceUrl;
  const hasInput = inputMode === 'text' ? referenceText.trim().length > 20 : referenceUrl.trim().length > 5;

  const handleGenerate = useCallback(async () => {
    if (!hasInput) return;
    setGenerating(true);
    setVariants([]);
    setError(null);

    const stepMessages = ['Analyzing reference...', 'Running deep analysis...', 'Generating variants...', 'Scoring output...', 'Finalizing...'];
    let stepIdx = 0;
    setGeneratingStep(stepMessages[0]);
    const stepInterval = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, stepMessages.length - 1);
      setGeneratingStep(stepMessages[stepIdx]);
    }, 3000);

    try {
      const full = selectedProduct;
      const res = await api.post('/magic-writer/generate', {
        referenceText: inputMode === 'text' ? referenceText : referenceUrl,
        productName: full?.name || '',
        targetAudience: full?.customer_avatar || '',
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
        angle: selectedAngle || customAngle || null,
        aggressiveness: 7,
      });
      setVariants(res.data.variants || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Generation failed');
    } finally {
      clearInterval(stepInterval);
      setGenerating(false);
      setGeneratingStep('');
    }
  }, [hasInput, inputMode, referenceText, referenceUrl, selectedProduct, outputMode, variantCount, selectedAngle, customAngle]);

  const handleEnhance = async () => {
    if (!referenceText.trim()) return;
    setEnhancing(true);
    try {
      const res = await api.post('/magic-writer/enhance', { text: referenceText, type: 'script' });
      if (res.data.enhanced) setReferenceText(res.data.enhanced);
    } catch {} finally {
      setEnhancing(false);
    }
  };

  const handleCopy = useCallback((text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }, []);

  return (
    <div className="flex h-full bg-[#0a0a0a]">
      {/* Left Panel — Input */}
      <div className="w-[340px] min-w-[300px] max-w-[380px] overflow-y-auto border-r border-white/[0.06]">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/[0.06]">
          <div className="p-2 rounded-lg" style={{ background: 'rgba(0,255,136,0.1)' }}>
            <BookOpen className="w-5 h-5" style={{ color: '#00FF88' }} />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">AD SCRIPTS</h1>
            <p className="text-[11px] text-gray-500">Rewrite & variant generator</p>
          </div>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* Reference Content */}
          <div>
            <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Reference Content</div>
            <div className="flex bg-[#111] rounded-lg border border-white/[0.06] p-0.5 mb-2">
              {[
                { key: 'spy', icon: Eye, label: 'Spy Ad' },
                { key: 'text', icon: FileText, label: 'Paste Text' },
                { key: 'url', icon: Globe, label: 'URL' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setInputMode(m.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    inputMode === m.key ? 'bg-[#00FF88]/15 text-[#00FF88]' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <m.icon className="w-3 h-3" />
                  {m.label}
                </button>
              ))}
            </div>

            {inputMode === 'text' || inputMode === 'spy' ? (
              <div className="relative">
                <textarea
                  value={referenceText}
                  onChange={(e) => setReferenceText(e.target.value)}
                  placeholder="Paste competitor copy, landing page text, article, ad, email..."
                  className="w-full h-36 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-xs text-white placeholder-gray-600 resize-y focus:outline-none focus:border-[#00FF88]/30 transition-colors"
                />
                {referenceText.trim().length > 20 && (
                  <button
                    type="button"
                    onClick={handleEnhance}
                    disabled={enhancing}
                    className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-[#00FF88] bg-[#00FF88]/10 rounded border border-[#00FF88]/20 hover:bg-[#00FF88]/20 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    {enhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                    Enhance
                  </button>
                )}
              </div>
            ) : (
              <input
                type="url"
                value={referenceUrl}
                onChange={(e) => setReferenceUrl(e.target.value)}
                placeholder="https://example.com/ad-page"
                className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[#00FF88]/30 transition-colors"
              />
            )}
          </div>

          {/* Configuration */}
          <div>
            <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Configuration</div>

            <div className="mb-2.5">
              <div className="text-[11px] font-medium text-gray-300 mb-1">Target Product</div>
              <ProductSelector
                selectedId={selectedProduct?.id}
                onSelect={(p) => setSelectedProduct(p)}
                className="w-full"
              />
            </div>

            <div className="mb-2.5">
              <div className="text-[11px] font-medium text-gray-300 mb-1">Ad Angle <span className="text-gray-600">(optional)</span></div>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {ANGLES.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setSelectedAngle(selectedAngle === a ? null : a)}
                    className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors cursor-pointer ${
                      selectedAngle === a
                        ? 'bg-[#00FF88]/15 border-[#00FF88]/30 text-[#00FF88]'
                        : 'bg-transparent border-white/[0.08] text-gray-500 hover:border-white/[0.15] hover:text-gray-300'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={customAngle}
                onChange={(e) => { setCustomAngle(e.target.value); setSelectedAngle(null); }}
                placeholder="Custom angle... (or leave blank for AI to decide)"
                className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2 text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-[#00FF88]/30 transition-colors"
              />
            </div>
          </div>

          {/* Output Mode */}
          <div>
            <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Output Mode</div>
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setOutputMode('variants')}
                className={`w-full flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors cursor-pointer ${
                  outputMode === 'variants'
                    ? 'bg-[#00FF88]/8 border-[#00FF88]/25'
                    : 'bg-transparent border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                <div className={`w-3 h-3 rounded-full mt-0.5 border-2 flex-shrink-0 ${
                  outputMode === 'variants' ? 'border-[#00FF88] bg-[#00FF88]' : 'border-gray-600'
                }`} />
                <div className="text-left">
                  <div className="text-[11px] font-semibold text-gray-100">Generate Variants</div>
                  <div className="text-[10px] text-gray-500">Multiple versions across different conversion angles</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setOutputMode('clone')}
                className={`w-full flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors cursor-pointer ${
                  outputMode === 'clone'
                    ? 'bg-[#00FF88]/8 border-[#00FF88]/25'
                    : 'bg-transparent border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                <div className={`w-3 h-3 rounded-full mt-0.5 border-2 flex-shrink-0 ${
                  outputMode === 'clone' ? 'border-[#00FF88] bg-[#00FF88]' : 'border-gray-600'
                }`} />
                <div className="text-left">
                  <div className="text-[11px] font-semibold text-gray-100">1:1 Script Clone</div>
                  <div className="text-[10px] text-gray-500">Keeps structure word-for-word, swaps product & avatar</div>
                </div>
              </button>
            </div>

            {outputMode === 'variants' && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] text-gray-400">Variants:</span>
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setVariantCount(n)}
                    className={`w-7 h-7 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                      variantCount === n
                        ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                        : 'bg-transparent text-gray-500 border border-white/[0.06] hover:border-white/[0.12]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
              {typeof error === 'string' ? error : error.message || 'Generation failed'}
            </div>
          )}

          {/* Generate button */}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!hasInput || generating}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: generating ? '#0a1a10' : 'linear-gradient(135deg, #00FF88, #00CC6A)',
              color: generating ? '#00FF88' : '#000',
              border: generating ? '1px solid #00FF8833' : 'none',
            }}
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-xs">{generatingStep || 'Generating...'}</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Generate {outputMode === 'clone' ? 'Clone' : `${variantCount} Variants`}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Right Panel — Output */}
      <div className="flex-1 overflow-y-auto p-6">
        {variants.length === 0 && !generating ? (
          <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6" style={{ background: 'rgba(0,255,136,0.08)' }}>
              <FileText className="w-10 h-10" style={{ color: '#00FF88' }} />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Ready to Create</h2>
            <p className="text-gray-500 text-sm text-center">
              Paste reference content, select your product, and hit Generate.
            </p>
          </div>
        ) : generating ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 animate-pulse" style={{ background: 'rgba(0,255,136,0.1)' }}>
              <Wand2 className="w-8 h-8" style={{ color: '#00FF88' }} />
            </div>
            <h2 className="text-lg font-semibold text-white mb-1">Crafting your scripts...</h2>
            <p className="text-sm text-gray-400">{generatingStep}</p>
            <div className="mt-6 flex gap-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-2 h-2 rounded-full animate-bounce" style={{ background: '#00FF88', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">
                Generated Scripts
                <span className="text-sm font-normal text-gray-400 ml-2">
                  {variants.length} variant{variants.length !== 1 ? 's' : ''}
                </span>
              </h2>
              <button
                onClick={handleGenerate}
                className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer"
                style={{ color: '#00FF88', background: 'rgba(0,255,136,0.08)' }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerate All
              </button>
            </div>
            <div className="space-y-4">
              {variants.map((variant, index) => (
                <div key={variant.id || index} className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                    <span className="text-xs font-medium text-gray-400">
                      Variant {index + 1} of {variants.length}
                    </span>
                    <button
                      onClick={() => handleCopy(variant.text, index)}
                      className="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="p-4">
                    {copiedIndex === index && (
                      <div className="text-xs mb-2" style={{ color: '#00FF88' }}>Copied to clipboard!</div>
                    )}
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
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
