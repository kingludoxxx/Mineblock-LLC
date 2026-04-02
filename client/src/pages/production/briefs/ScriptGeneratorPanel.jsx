import { useState } from 'react';
import { FileText, Link, Wand2, Loader2, Sparkles } from 'lucide-react';
import ProductSelector from '../../../components/ProductSelector';

const ANGLES = ['Pain Point', 'Social Proof', 'Before/After', 'Curiosity Hook', 'Direct Offer', 'Authority'];

export default function ScriptGeneratorPanel({ onGenerated, generating, generatingStep }) {
  const [inputMode, setInputMode] = useState('text');
  const [scriptText, setScriptText] = useState('');
  const [scriptUrl, setScriptUrl] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedAngle, setSelectedAngle] = useState(null);
  const [customAngle, setCustomAngle] = useState('');
  const [outputMode, setOutputMode] = useState('variants');
  const [variantCount, setVariantCount] = useState(3);
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState(null);

  const hasInput = inputMode === 'text' ? scriptText.trim().length > 20 : scriptUrl.trim().length > 5;

  const handleGenerate = async () => {
    if (!hasInput) return;
    setError(null);
    try {
      await onGenerated({
        script: inputMode === 'text' ? scriptText : null,
        url: inputMode === 'url' ? scriptUrl : null,
        productId: selectedProduct?.id || null,
        productCode: selectedProduct?.product_code || selectedProduct?.short_name || null,
        angle: selectedAngle || customAngle || null,
        mode: outputMode,
        numVariations: variantCount,
      });
    } catch (err) {
      setError(err.message || 'Generation failed');
    }
  };

  const handleEnhance = async () => {
    if (!scriptText.trim()) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/v1/magic-writer/enhance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
        },
        body: JSON.stringify({ text: scriptText, type: 'script' }),
      });
      const data = await res.json();
      if (data.enhanced) setScriptText(data.enhanced);
    } catch {} finally {
      setEnhancing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Input mode toggle */}
      <div>
        <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Reference Content</div>
        <div className="flex bg-[#111] rounded-lg border border-white/[0.06] p-0.5 mb-2">
          <button
            type="button"
            onClick={() => setInputMode('text')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
              inputMode === 'text' ? 'bg-[#C6A85C]/15 text-[#C6A85C]' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileText className="w-3 h-3" />
            Paste Text
          </button>
          <button
            type="button"
            onClick={() => setInputMode('url')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
              inputMode === 'url' ? 'bg-[#C6A85C]/15 text-[#C6A85C]' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Link className="w-3 h-3" />
            URL
          </button>
        </div>

        {inputMode === 'text' ? (
          <div className="relative">
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="Paste competitor copy, landing page text, article, ad, email..."
              className="w-full h-32 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-xs text-white placeholder-gray-600 resize-y focus:outline-none focus:border-[#C6A85C]/30 transition-colors"
            />
            {scriptText.trim().length > 20 && (
              <button
                type="button"
                onClick={handleEnhance}
                disabled={enhancing}
                className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-[#C6A85C] bg-[#C6A85C]/10 rounded border border-[#C6A85C]/20 hover:bg-[#C6A85C]/20 transition-colors cursor-pointer disabled:opacity-40"
              >
                {enhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                Enhance
              </button>
            )}
          </div>
        ) : (
          <input
            type="url"
            value={scriptUrl}
            onChange={(e) => setScriptUrl(e.target.value)}
            placeholder="https://example.com/ad-page"
            className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[#C6A85C]/30 transition-colors"
          />
        )}
      </div>

      {/* Configuration */}
      <div>
        <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Configuration</div>

        <div className="mb-2">
          <div className="text-[11px] font-medium text-gray-300 mb-1">Target Product</div>
          <ProductSelector
            selectedId={selectedProduct?.id}
            onSelect={(p) => setSelectedProduct(p)}
            className="w-full"
          />
        </div>

        <div className="mb-2">
          <div className="text-[11px] font-medium text-gray-300 mb-1">Ad Angle <span className="text-gray-600">(optional)</span></div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {ANGLES.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setSelectedAngle(selectedAngle === a ? null : a)}
                className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors cursor-pointer ${
                  selectedAngle === a
                    ? 'bg-[#C6A85C]/15 border-[#C6A85C]/30 text-[#C6A85C]'
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
            className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2 text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-[#C6A85C]/30 transition-colors"
          />
        </div>
      </div>

      {/* Output mode */}
      <div>
        <div className="text-[9px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">Output Mode</div>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setOutputMode('variants')}
            className={`w-full flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors cursor-pointer ${
              outputMode === 'variants'
                ? 'bg-[#C6A85C]/8 border-[#C6A85C]/25'
                : 'bg-transparent border-white/[0.06] hover:border-white/[0.12]'
            }`}
          >
            <div className={`w-3 h-3 rounded-full mt-0.5 border-2 flex-shrink-0 ${
              outputMode === 'variants' ? 'border-[#C6A85C] bg-[#C6A85C]' : 'border-gray-600'
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
                ? 'bg-[#C6A85C]/8 border-[#C6A85C]/25'
                : 'bg-transparent border-white/[0.06] hover:border-white/[0.12]'
            }`}
          >
            <div className={`w-3 h-3 rounded-full mt-0.5 border-2 flex-shrink-0 ${
              outputMode === 'clone' ? 'border-[#C6A85C] bg-[#C6A85C]' : 'border-gray-600'
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
                    ? 'bg-[#C6A85C]/15 text-[#C6A85C] border border-[#C6A85C]/30'
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
          {error}
        </div>
      )}

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!hasInput || generating}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: generating ? '#1a1710' : 'linear-gradient(135deg, #C6A85C, #BFA14A)',
          color: generating ? '#C6A85C' : '#000',
          border: generating ? '1px solid #C6A85C33' : 'none',
        }}
      >
        {generating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">{generatingStep || 'Generating...'}</span>
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4" />
            Generate {outputMode === 'clone' ? 'Clone' : `${variantCount} Variants`}
          </>
        )}
      </button>
    </div>
  );
}
