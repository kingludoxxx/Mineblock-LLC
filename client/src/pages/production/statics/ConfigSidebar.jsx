import { useRef, useCallback, useState } from 'react';
import {
  Layers,
  Upload,
  X,
  Loader2,
  Sparkles,
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
    <aside className="w-full shrink-0 bg-[#0a0a0a] flex flex-col overflow-y-auto">
      {/* ---- CONFIGURATION header ---- */}
      <div className="px-5 pt-5 pb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Configuration
        </h2>
      </div>

      <div className="px-5 space-y-6">
        {/* ---- Target Product ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">
            Target Product
          </label>

          <ProductSelector
            selectedId={selectedProduct}
            onSelect={(product) => onProductChange(product)}
            onLoad={onProductsLoaded}
          />
        </div>

        {/* ---- Ad Angle ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">
            Ad Angle{' '}
            <span className="text-slate-600 font-normal">(optional)</span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {AD_ANGLES.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => onAngleChange(angle === a ? null : a)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                  angle === a
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/[0.04] text-slate-400 border border-white/[0.06] hover:border-white/[0.12] hover:text-white'
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
            placeholder="Custom angle... (or leave blank for AI to decide)"
            className="w-full bg-[#111] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-blue-500/50 focus:outline-none"
          />
        </div>

        {/* ---- REFERENCE IMAGES header ---- */}
        <div className="pt-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            Reference Images
          </h2>

          {/* Select from Library */}
          <button
            type="button"
            onClick={onOpenLibrary}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-slate-300 hover:border-white/[0.12] hover:text-white transition-colors cursor-pointer"
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
            className={`mt-3 flex flex-col items-center justify-center gap-2 border border-dashed rounded-lg py-5 cursor-pointer transition-colors ${
              dragging
                ? 'border-blue-500/60 bg-blue-500/5'
                : 'border-white/[0.1] hover:border-white/[0.2] bg-transparent'
            }`}
          >
            <Upload className="w-5 h-5 text-slate-600" />
            <span className="text-xs text-slate-500">
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
          <div className="mt-3 space-y-2">
            {references.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-3">
                No reference images yet.{' '}
                <button
                  type="button"
                  onClick={onOpenLibrary}
                  className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
                >
                  Browse Library
                </button>
              </p>
            ) : (
              references.map((ref) => (
                <div key={ref.id} className="relative group rounded-lg overflow-hidden border border-white/[0.06] bg-[#0a0a0a]">
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
                    <div className="px-2 py-1.5 bg-[#0a0a0a]">
                      <p className="text-[10px] text-slate-500 truncate">{ref.name}</p>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ---- Generate button ---- */}
      <div className="px-5 py-4 border-t border-white/[0.06] mt-6">
        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
            canGenerate
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-white/[0.04] text-slate-600 border border-white/[0.06] cursor-not-allowed'
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
              Generate Static
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
