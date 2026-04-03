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

          {/* Reference thumbnails */}
          <div className="space-y-2">
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
              references.map((ref) => (
                <div key={ref.id} className="relative group rounded-lg overflow-hidden border border-white/[0.05] bg-white/[0.02]">
                  <img
                    src={ref.thumbnail || ref.image_url || ref.url}
                    alt="Reference"
                    className="w-full aspect-[4/5] object-cover"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveReference(ref.id);
                    }}
                    className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-black/90"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  {ref.name && (
                    <div className="px-2 py-1.5 bg-white/[0.02]">
                      <p className="text-[10px] text-zinc-500 truncate">{ref.name}</p>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
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
