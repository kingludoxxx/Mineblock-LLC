import { useState } from 'react';
import { FileText, Video, Wand2, Loader2, Sparkles, ChevronDown } from 'lucide-react';
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
    <div className="space-y-8">
      {/* Reference Content */}
      <div className="space-y-3">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Reference Content
        </div>

        <div className="flex p-1 bg-white/[0.02] rounded-lg border border-white/[0.05] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]">
          <button
            type="button"
            onClick={() => setInputMode('text')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
              inputMode === 'text'
                ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.04)] border border-white/[0.06]'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Paste Text
          </button>
          <button
            type="button"
            onClick={() => setInputMode('url')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
              inputMode === 'url'
                ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.04)] border border-white/[0.06]'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            <Video className="w-3.5 h-3.5" />
            Video URL
          </button>
        </div>

        {inputMode === 'text' ? (
          <div className="relative">
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="Paste competitor copy, landing page text, article, ad, email..."
              className="w-full h-32 bg-white/[0.02] border border-white/[0.05] rounded-lg p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 resize-none transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
            />
            {scriptText.trim().length > 20 && (
              <button
                type="button"
                onClick={handleEnhance}
                disabled={enhancing}
                className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-[#c9a84c] bg-[#c9a84c]/10 rounded border border-[#c9a84c]/20 hover:bg-[#c9a84c]/20 transition-colors cursor-pointer disabled:opacity-40"
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
            placeholder="FB Ad Library or direct video URL (.mp4, .webm)"
            className="w-full bg-white/[0.02] border border-white/[0.05] rounded-lg p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
          />
        )}
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Configuration
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400 font-mono">Target_Product</label>
          <ProductSelector
            selectedId={selectedProduct?.id}
            onSelect={(p) => setSelectedProduct(p)}
            className="w-full"
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-400 font-mono">
              Ad_Angle <span className="text-zinc-600 opacity-70">[OPTIONAL]</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {ANGLES.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setSelectedAngle(selectedAngle === a ? null : a)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-all duration-300 cursor-pointer ${
                  selectedAngle === a
                    ? 'bg-[#c9a84c]/10 border-[#c9a84c]/30 text-[#e8d5a3] shadow-[0_0_8px_rgba(201,168,76,0.1)]'
                    : 'bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200 hover:bg-white/[0.04]'
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
            placeholder="Custom angle... (or leave blank for AI)"
            className="w-full bg-white/[0.02] border border-white/[0.05] rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all mt-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
          />
        </div>
      </div>

      {/* Output Mode */}
      <div className="space-y-4">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Output Mode
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setOutputMode('variants')}
            className={`w-full text-left p-3 rounded-lg border transition-all duration-300 relative overflow-hidden cursor-pointer ${
              outputMode === 'variants'
                ? 'glass-card border-[#c9a84c]/20 shadow-[0_0_15px_rgba(201,168,76,0.04),inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'bg-white/[0.01] border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.02]'
            }`}
          >
            {outputMode === 'variants' && (
              <div className="absolute top-0 left-0 w-[2px] h-full bg-gradient-to-b from-[#c9a84c] to-[#e8d5a3] shadow-[0_0_8px_rgba(201,168,76,0.6)]" />
            )}
            <div className="flex items-center gap-3 mb-1">
              <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${
                outputMode === 'variants' ? 'border-[#c9a84c] bg-[#c9a84c]/10' : 'border-zinc-700 bg-black/20'
              }`}>
                {outputMode === 'variants' && (
                  <div className="w-1.5 h-1.5 rounded-sm bg-[#d4b55a] shadow-[0_0_4px_rgba(201,168,76,0.8)]" />
                )}
              </div>
              <span className={`text-sm font-medium tracking-wide ${outputMode === 'variants' ? 'text-[#e8d5a3]' : 'text-zinc-300'}`}>
                Generate Variants
              </span>
            </div>
            <p className="text-xs text-zinc-500 pl-[26px]">Multiple versions across different conversion angles</p>
          </button>

          <button
            type="button"
            onClick={() => setOutputMode('clone')}
            className={`w-full text-left p-3 rounded-lg border transition-all duration-300 relative overflow-hidden cursor-pointer ${
              outputMode === 'clone'
                ? 'glass-card border-[#c9a84c]/20 shadow-[0_0_15px_rgba(201,168,76,0.04),inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'bg-white/[0.01] border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.02]'
            }`}
          >
            {outputMode === 'clone' && (
              <div className="absolute top-0 left-0 w-[2px] h-full bg-gradient-to-b from-[#c9a84c] to-[#e8d5a3] shadow-[0_0_8px_rgba(201,168,76,0.6)]" />
            )}
            <div className="flex items-center gap-3 mb-1">
              <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${
                outputMode === 'clone' ? 'border-[#c9a84c] bg-[#c9a84c]/10' : 'border-zinc-700 bg-black/20'
              }`}>
                {outputMode === 'clone' && (
                  <div className="w-1.5 h-1.5 rounded-sm bg-[#d4b55a] shadow-[0_0_4px_rgba(201,168,76,0.8)]" />
                )}
              </div>
              <span className={`text-sm font-medium tracking-wide ${outputMode === 'clone' ? 'text-[#e8d5a3]' : 'text-zinc-300'}`}>
                1:1 Script Clone
              </span>
            </div>
            <p className="text-xs text-zinc-500 pl-[26px]">Keeps structure word-for-word, swaps product & avatar</p>
          </button>
        </div>

        {outputMode === 'variants' && (
          <div className="flex items-center gap-3 pt-2">
            <span className="text-xs text-zinc-500 font-mono">VARIANTS:</span>
            <div className="flex gap-1.5">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setVariantCount(n)}
                  className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-mono font-medium transition-all duration-300 cursor-pointer ${
                    variantCount === n
                      ? 'bg-[#c9a84c]/15 text-[#e8d5a3] border border-[#c9a84c]/35 shadow-[0_0_8px_rgba(201,168,76,0.12)]'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5 font-mono">
          {error}
        </div>
      )}

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!hasInput || generating}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-mono font-semibold tracking-wide uppercase transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: generating ? '#1a1710' : 'linear-gradient(135deg, #c9a84c, #d4b55a)',
          color: generating ? '#c9a84c' : '#111113',
          border: generating ? '1px solid rgba(201,168,76,0.2)' : 'none',
          boxShadow: generating ? 'none' : '0 0 20px rgba(201,168,76,0.25), 0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.2)',
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
