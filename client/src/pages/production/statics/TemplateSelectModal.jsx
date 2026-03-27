import { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, LayoutGrid } from 'lucide-react';

// ---------------------------------------------------------------------------
// Categories — mirrors LibraryView groupings
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'Headline', label: 'Headline' },
  { key: 'Feature/Benefit', label: 'Feature/Benefit' },
  { key: 'Offer/Sale', label: 'Offer/Sale' },
  { key: 'Testimonial', label: 'Testimonial' },
  { key: 'Before & After', label: 'Before & After' },
  { key: 'Us vs Them', label: 'Us vs Them' },
  { key: 'Article/News', label: 'Article/News' },
  { key: 'Native', label: 'Native' },
  { key: 'Bold Claim', label: 'Bold Claim' },
  { key: 'Statistics', label: 'Statistics' },
  { key: 'Problem + Solution', label: 'Problem + Solution' },
  { key: 'Google Search', label: 'Google Search' },
  { key: 'Apple Notes', label: 'Apple Notes' },
  { key: 'AirDrop', label: 'AirDrop' },
  { key: 'Meme', label: 'Meme' },
  { key: 'Negative Hook', label: 'Negative Hook' },
  { key: "What's Inside", label: "What's Inside" },
  { key: 'Uncategorized', label: 'Uncategorized' },
];

// ---------------------------------------------------------------------------
// TemplateSelectModal
// ---------------------------------------------------------------------------

export function TemplateSelectModal({ isOpen, onClose, onSelect, templates = [] }) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setActiveCategory('all');
    }
  }, [isOpen]);

  // Lock body scroll while open
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts = { all: templates.length };
    for (const t of templates) {
      const cat = t.category || 'other';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [templates]);

  // Filtered templates
  const filtered = useMemo(() => {
    let list = templates;
    if (activeCategory !== 'all') {
      list = list.filter((t) => (t.category || 'other') === activeCategory);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          (t.name || '').toLowerCase().includes(q) ||
          (t.title || '').toLowerCase().includes(q) ||
          (t.category || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [templates, activeCategory, search]);

  const handleSelect = useCallback(
    (template) => {
      onSelect(template);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative flex flex-col bg-[#0d0d0d] border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
        style={{ width: '80vw', height: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <LayoutGrid className="w-5 h-5 text-slate-400" />
            <h2 className="text-lg font-semibold text-white">Select from Library</h2>
            <span className="text-xs font-medium text-slate-400 bg-white/[0.06] px-2 py-0.5 rounded-full">
              {templates.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-52 shrink-0 border-r border-white/[0.06] py-3 px-3 overflow-y-auto">
            {CATEGORIES.map((cat) => {
              const count = categoryCounts[cat.key] || 0;
              if (cat.key !== 'all' && count === 0) return null;
              const isActive = activeCategory === cat.key;
              return (
                <button
                  key={cat.key}
                  onClick={() => setActiveCategory(cat.key)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  <span className={isActive ? 'font-medium' : ''}>{cat.label}</span>
                  <span
                    className={`text-xs tabular-nums ${
                      isActive ? 'text-blue-400' : 'text-slate-600'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Search */}
            <div className="px-5 pt-4 pb-3 shrink-0">
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates..."
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-600 focus:border-blue-500/50 focus:outline-none transition-colors"
                />
              </div>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto px-5 pb-5">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2">
                  <LayoutGrid className="w-10 h-10 text-slate-700" />
                  <span className="text-sm">No templates found</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filtered.map((template) => (
                    <button
                      key={template.id || template.name}
                      onClick={() => handleSelect(template)}
                      className="group relative rounded-xl overflow-hidden border border-white/[0.06] bg-white/[0.02] hover:border-blue-500/40 hover:bg-white/[0.04] transition-all cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                    >
                      <div className="aspect-[4/5] w-full bg-white/[0.03]">
                        {template.image_url || template.thumbnail_url ? (
                          <img
                            src={template.image_url || template.thumbnail_url}
                            alt={template.name || template.title || 'Template'}
                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                            loading="lazy"
                            onError={(e) => {
                              e.target.style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-700">
                            <LayoutGrid className="w-8 h-8" />
                          </div>
                        )}
                      </div>
                      {(template.name || template.title) && (
                        <div className="px-2.5 py-2 border-t border-white/[0.04]">
                          <span className="text-xs text-slate-400 truncate block">
                            {template.name || template.title}
                          </span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
