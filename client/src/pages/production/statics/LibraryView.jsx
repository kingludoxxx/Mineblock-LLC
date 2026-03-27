import { useState, useMemo } from 'react';
import { Plus, ScanSearch, MousePointerSquareDashed, EyeOff, AlertCircle } from 'lucide-react';

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

function TemplateCard({ template, onClick }) {
  return (
    <button
      onClick={() => onClick(template)}
      className="group flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden transition-all hover:border-white/[0.12] hover:bg-white/[0.04] cursor-pointer text-left"
    >
      {/* Thumbnail */}
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-black/30">
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
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-xs font-medium text-white bg-white/[0.15] backdrop-blur-sm px-3 py-1.5 rounded-full">
            View Reference
          </span>
        </div>
      </div>

      {/* Label */}
      <div className="px-3 py-2.5">
        <p className="text-xs text-slate-400 truncate">
          Reference Ad{template.category ? ` \u00b7 ${template.category}` : ''}
        </p>
      </div>
    </button>
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
}) {
  const [selectMode, setSelectMode] = useState(false);

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
                  ? 'bg-blue-600 text-white'
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

            <button
              onClick={onAddReference}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Reference
            </button>
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
                  onClick={onSelectTemplate}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
