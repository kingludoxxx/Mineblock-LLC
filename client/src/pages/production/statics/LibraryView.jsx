import { useState, useMemo } from 'react';
import { ScanSearch, MousePointerSquareDashed, EyeOff, AlertCircle, X, Check, Trash2, Zap } from 'lucide-react';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORIES = [
  'AirDrop',
  'Apple Notes',
  'Article/News',
  'Before & After',
  'Benefits & Features',
  'Bold Claim',
  'Feature/Benefit',
  'Google Search',
  'Headline',
  'Lifestyle & Brand',
  'Meme',
  'Native',
  'Negative Hook',
  'Offer & Promotion',
  'Offer/Sale',
  'Problem + Solution',
  'Social Proof & Testimonials',
  'Statistics',
  'Testimonial',
  'UGC & Reviews',
  'Us vs Them',
  "What's Inside",
];

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({ templates, selectedCategory, onCategoryChange }) {
  const counts = useMemo(() => {
    const map = {};
    for (const t of templates) {
      const cat = t.category || '__uncategorized';
      map[cat] = (map[cat] || 0) + 1;
    }
    return map;
  }, [templates]);

  const total = templates.length;

  return (
    <aside className="w-56 shrink-0 border-r border-white/[0.06] overflow-y-auto pr-1">
      {/* All Templates */}
      <button
        onClick={() => onCategoryChange(null)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
          selectedCategory === null
            ? 'bg-white/[0.08] text-white font-medium'
            : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
        }`}
      >
        <span>All Templates</span>
        <span className="text-xs text-slate-500 tabular-nums">{total}</span>
      </button>

      <div className="h-px bg-white/[0.06] my-2" />

      <div className="space-y-0.5">
        {CATEGORIES.map((cat) => {
          const count = counts[cat] || 0;
          const isActive = selectedCategory === cat;
          return (
            <button
              key={cat}
              onClick={() => onCategoryChange(cat)}
              className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-white font-medium'
                  : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
              }`}
            >
              <span className="truncate">{cat}</span>
              {count > 0 && (
                <span
                  className={`text-xs tabular-nums ${
                    isActive ? 'text-slate-300' : 'text-slate-600'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Template Card
// ---------------------------------------------------------------------------

function TemplateCard({ template, onView, onAnalyze, onDelete }) {
  return (
    <div
      className="group flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden transition-all hover:border-white/[0.12] hover:bg-white/[0.04] cursor-pointer text-left"
    >
      {/* Thumbnail */}
      <button
        onClick={() => onView(template)}
        className="relative aspect-[4/5] w-full overflow-hidden bg-black/30 cursor-pointer"
      >
        {template.image_url ? (
          <img
            src={template.image_url}
            alt={template.name || 'Reference Ad'}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-700">
            <AlertCircle className="w-8 h-8" />
          </div>
        )}
        {/* Analysis indicator */}
        {template.deep_analysis && (
          <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-green-500" title="Analyzed" />
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-xs font-medium text-white bg-white/[0.15] backdrop-blur-sm px-3 py-1.5 rounded-full">
            View Reference
          </span>
        </div>
      </button>

      {/* Label + actions */}
      <div className="px-3 py-2.5 flex items-center justify-between gap-1">
        <p className="text-xs text-slate-400 truncate flex-1">
          Reference Ad{template.category ? ` \u00b7 ${template.category}` : ''}
        </p>
        <div className="flex items-center gap-0.5 shrink-0">
          {onAnalyze && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnalyze(template);
              }}
              className="p-1.5 text-gray-500 hover:text-purple-400 hover:bg-purple-900/20 rounded transition-colors cursor-pointer"
              title="Analyze template"
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(template);
              }}
              className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors cursor-pointer"
              title="Delete template"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference Lightbox
// ---------------------------------------------------------------------------

function ReferenceLightbox({ template, onClose, onSelect }) {
  if (!template) return null;
  const da = template.deep_analysis;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 z-10 p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex gap-4 items-start">
          {/* Image */}
          {template.image_url ? (
            <img
              src={template.image_url}
              alt={template.name || 'Reference Ad'}
              className="max-w-full max-h-[75vh] rounded-xl object-contain shadow-2xl"
              style={{ maxWidth: da ? '50vw' : '80vw' }}
            />
          ) : (
            <div className="w-80 h-96 rounded-xl bg-[#1a1a1a] flex items-center justify-center text-slate-600">
              <AlertCircle className="w-12 h-12" />
            </div>
          )}

          {/* AI Analysis Panel */}
          {da && (
            <div className="w-72 max-h-[75vh] overflow-y-auto bg-[#141414] rounded-xl border border-white/[0.06] p-4 text-xs text-slate-300 space-y-3">
              <div className="flex items-center gap-2 text-purple-400 font-semibold text-sm">
                <Zap className="w-4 h-4" />
                AI Analysis
              </div>

              {da.template_type && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Type</span>
                  <p className="text-white mt-0.5">{da.template_type}</p>
                </div>
              )}

              {da.emotional_tone && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Tone</span>
                  <p className="text-white mt-0.5">{da.emotional_tone}</p>
                </div>
              )}

              {da.layout?.grid_structure && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Layout</span>
                  <p className="text-white mt-0.5">{da.layout.grid_structure} ({da.layout.orientation})</p>
                </div>
              )}

              {da.typography?.headline?.text_content && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Headline</span>
                  <p className="text-white mt-0.5 italic">"{da.typography.headline.text_content}"</p>
                </div>
              )}

              {da.product_analysis && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Product</span>
                  <p className="text-white mt-0.5">
                    {da.product_analysis.product_visible ? `${da.product_analysis.product_count || 1} product(s)` : 'No product'}
                    {da.product_analysis.product_orientation && ` - ${da.product_analysis.product_orientation}`}
                  </p>
                </div>
              )}

              {da.color_palette && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Colors</span>
                  <div className="flex items-center gap-1 mt-1">
                    {[da.color_palette.dominant, da.color_palette.accent, da.color_palette.text_primary].filter(Boolean).map((c, i) => (
                      <div key={i} className="w-5 h-5 rounded border border-white/10" style={{ backgroundColor: c }} title={c} />
                    ))}
                    <span className="text-slate-500 ml-1">{da.color_palette.overall_mood}</span>
                  </div>
                </div>
              )}

              {da.adaptation_instructions?.product_replacement_difficulty && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Adaptation Difficulty</span>
                  <p className={`mt-0.5 font-medium ${da.adaptation_instructions.product_replacement_difficulty === 'easy' ? 'text-green-400' : da.adaptation_instructions.product_replacement_difficulty === 'hard' ? 'text-red-400' : 'text-yellow-400'}`}>
                    {da.adaptation_instructions.product_replacement_difficulty}
                  </p>
                </div>
              )}

              {da.ad_effectiveness_notes && (
                <div>
                  <span className="text-slate-500 uppercase text-[10px] tracking-wider">Notes</span>
                  <p className="text-slate-400 mt-0.5">{da.ad_effectiveness_notes}</p>
                </div>
              )}

              {template.analyzed_at && (
                <p className="text-slate-600 text-[10px] pt-2 border-t border-white/[0.06]">
                  Analyzed {new Date(template.analyzed_at).toLocaleDateString()}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-slate-400">
            {template.name || 'Reference Ad'}
            {template.category ? ` \u00b7 ${template.category}` : ''}
          </span>
          <button
            onClick={() => {
              onSelect(template);
              onClose();
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            Use as Reference
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LibraryView
// ---------------------------------------------------------------------------

export function LibraryView({
  templates = [],
  onSelectTemplate,
  onAddReference,
  selectedCategory,
  onCategoryChange,
  onAnalyzeTemplate,
  onAnalyzeAll,
  onDeleteTemplate,
}) {
  const [selectMode, setSelectMode] = useState(false);
  const [viewingTemplate, setViewingTemplate] = useState(null);

  const uncategorizedCount = useMemo(
    () => templates.filter((t) => !t.category).length,
    [templates],
  );

  const hiddenCount = useMemo(
    () => templates.filter((t) => t.is_hidden).length,
    [templates],
  );

  const filtered = useMemo(() => {
    if (!selectedCategory) return templates.filter((t) => !t.is_hidden);
    return templates.filter((t) => t.category === selectedCategory && !t.is_hidden);
  }, [templates, selectedCategory]);

  const heading = selectedCategory
    ? `${filtered.length} in ${selectedCategory}`
    : `${filtered.length} Templates`;

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar */}
      <Sidebar
        templates={templates}
        selectedCategory={selectedCategory}
        onCategoryChange={onCategoryChange}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 pl-5">
        {/* Top bar */}
        <div className="flex items-center justify-between pb-4 border-b border-white/[0.06] mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">{heading}</h2>

            {uncategorizedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">
                {uncategorizedCount} uncategorized
              </span>
            )}

            {hiddenCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <EyeOff className="w-3 h-3" />
                {hiddenCount} hidden
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectMode((p) => !p)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                selectMode
                  ? 'bg-accent text-white'
                  : 'bg-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              <MousePointerSquareDashed className="w-3.5 h-3.5" />
              Select
            </button>

            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer">
              <ScanSearch className="w-3.5 h-3.5" />
              AI Scan &amp; Sort
            </button>

            {onAnalyzeAll && (
              <button
                onClick={onAnalyzeAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-600 hover:bg-purple-500 text-white transition-colors cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5" />
                Analyze All
              </button>
            )}

            {/* Add Reference button removed — templates are pre-loaded in library */}
          </div>
        </div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-slate-600">No templates in this category.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
              {filtered.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  template={tpl}
                  onView={setViewingTemplate}
                  onAnalyze={onAnalyzeTemplate}
                  onDelete={onDeleteTemplate}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      <ReferenceLightbox
        template={viewingTemplate}
        onClose={() => setViewingTemplate(null)}
        onSelect={onSelectTemplate}
      />
    </div>
  );
}
