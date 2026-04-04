import { useRef, useCallback, useState } from 'react';
import {
  Layers,
  Upload,
  X,
  Loader2,
  Sparkles,
  ListPlus,
} from 'lucide-react';
import ProductSelector from '../../../components/ProductSelector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AD_ANGLES = [
  'Social Proof',
  'Problem/Solution',
  'Before & After',
  'Urgency',
  'Curiosity',
  'Authority',
];

const ASPECT_RATIOS = ['1:1', '9:10', '4:5', '16:9', '2:3'];

// ---------------------------------------------------------------------------
// ConfigSidebar
// ---------------------------------------------------------------------------

export function ConfigSidebar({
  selectedProduct,
  selectedProductObj,
  onProductChange,
  angle,
  onAngleChange,
  customAngle,
  onCustomAngleChange,
  references,
  onOpenLibrary,
  onUploadReference,
  onRemoveReference,
  onGenerate,
  onAddToQueue,
  generating,
  onProductsLoaded,
}) {
  const fileInputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const canGenerate = selectedProduct && references.length > 0 && !generating;

  // -- Drag & drop handlers --------------------------------------------------

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) onUploadReference(file);
    },
    [onUploadReference],
  );

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onUploadReference(file);
    e.target.value = '';
  };

  return (
    <aside className="w-full shrink-0 bg-[#131315]/80 backdrop-blur-xl flex flex-col overflow-y-auto relative">
      <div className="absolute right-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-[#c9a84c]/15 via-transparent to-transparent" />

      {/* ---- CONFIGURATION header ---- */}
      <div className="px-5 pt-5 pb-4">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Configuration
        </div>
      </div>

      <div className="px-5 space-y-6">
        {/* ---- Target Product ---- */}
        <div className="space-y-2">
          <label className="text-xs text-zinc-400 font-medium">
            Target Product
          </label>

          <ProductSelector
            selectedId={selectedProduct}
            selectedProduct={selectedProductObj}
            onSelect={(product) => onProductChange(product)}
            onLoad={onProductsLoaded}
          />
        </div>

        {/* ---- Ad Angle ---- */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-400 font-mono">
              Ad_Angle <span className="text-zinc-600 opacity-70">[OPTIONAL]</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {AD_ANGLES.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => onAngleChange(angle === a ? null : a)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-all duration-300 cursor-pointer ${
                  angle === a
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
            value={customAngle || ''}
            onChange={(e) => onCustomAngleChange(e.target.value)}
            placeholder="Custom angle... (or leave blank)"
            className="w-full bg-white/[0.02] border border-white/[0.05] rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
          />
        </div>

        {/* ---- REFERENCE IMAGES header ---- */}
        <div className="pt-2 space-y-3">
          <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
            <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
            Reference Images
          </div>

          {/* Select from Library */}
          <button
            type="button"
            onClick={onOpenLibrary}
            className="w-full flex items-center justify-center gap-2 bg-white/[0.02] border border-white/[0.05] rounded-lg p-2.5 text-sm text-zinc-300 hover:bg-white/[0.04] transition-all cursor-pointer"
          >
            <Layers className="w-4 h-4" />
            Select from Library
          </button>

          {/* Upload / drag & drop */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 border border-dashed rounded-lg py-6 cursor-pointer transition-colors ${
              dragging
                ? 'border-[#c9a84c]/50 bg-[#c9a84c]/5'
                : 'border-white/[0.08] hover:bg-white/[0.01]'
            }`}
          >
            <Upload className="w-5 h-5 text-zinc-500" />
            <span className="text-xs text-zinc-500">
              or upload image / drag &amp; drop
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Reference count indicator */}
          {references.length === 0 ? (
            <div className="text-center pt-2">
              <p className="text-xs text-zinc-600">
                No reference images yet.
                <br />
                <button
                  type="button"
                  onClick={onOpenLibrary}
                  className="text-[#c9a84c] hover:underline cursor-pointer"
                >
                  Browse Library
                </button>
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
              <Layers className="w-3.5 h-3.5 text-[#c9a84c]/60" />
              <span className="text-xs text-zinc-400">
                {references.length} template{references.length !== 1 ? 's' : ''} selected
              </span>
              <button
                type="button"
                onClick={() => references.forEach(r => onRemoveReference(r.id))}
                className="ml-auto text-[10px] text-zinc-600 hover:text-red-400 transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Generate & Queue buttons ---- */}
      <div className="px-5 py-4 border-t border-white/[0.04] mt-6 space-y-3">
        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: !canGenerate ? '#1a1710' : 'linear-gradient(135deg, #c9a84c, #d4b55a)',
            color: !canGenerate ? '#c9a84c' : '#111113',
            border: !canGenerate ? '1px solid rgba(201,168,76,0.2)' : 'none',
            boxShadow: !canGenerate ? 'none' : '0 0 20px rgba(201,168,76,0.25), 0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.2)',
          }}
        >
          {generating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Generate Static
            </>
          )}
        </button>
        {onAddToQueue && (
          <button
            type="button"
            onClick={onAddToQueue}
            disabled={!canGenerate}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-medium uppercase tracking-wide bg-transparent border border-white/[0.05] text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ListPlus className="w-4 h-4" />
            Add to Queue
          </button>
        )}
      </div>

    </aside>
  );
}
