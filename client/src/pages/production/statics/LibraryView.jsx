import { useState, useMemo, useEffect } from 'react';
import { ScanSearch, MousePointerSquareDashed, EyeOff, AlertCircle, X, Check, Trash2, Zap, Calendar, RefreshCw, Pencil, Save, XCircle, Plus } from 'lucide-react';

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
// Reference Lightbox (with Edit Mode)
// ---------------------------------------------------------------------------

// Parse tags — handles string (double-stringified JSON) or array
// Sanitizes: filters empty strings, non-strings, trims, and deduplicates
function parseTags(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); arr = Array.isArray(parsed) ? parsed : []; } catch { arr = []; }
  }
  // Sanitize: only strings, trimmed, non-empty, unique
  const seen = new Set();
  return arr
    .filter(t => typeof t === 'string')
    .map(t => t.trim())
    .filter(t => t && !seen.has(t) && seen.add(t));
}

function ReferenceLightbox({ template, onClose, onSelect, onAnalyze, onHide, onDelete, onUpdate }) {
  // ⚠️ ALL hooks MUST be declared above the `if (!template) return null` guard,
  // or the component hits React error #310 (rendered fewer hooks than previous
  // render) the moment `template` flips from truthy to null and back.
  const [reanalyzing, setReanalyzing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [saveError, setSaveError] = useState('');

  // Reset edit mode + tag input whenever we switch templates. useEffect runs
  // after commit, so the hook call happens unconditionally on every render.
  useEffect(() => {
    setEditing(false);
    setTagInput('');
    setSaveError('');
  }, [template?.id]);

  if (!template) return null;
  // deep_analysis may come as a JSON string from the API — parse it safely
  let da = template.deep_analysis;
  if (typeof da === 'string') {
    try { da = JSON.parse(da); } catch { da = null; }
  }
  const templateTags = parseTags(template.tags);

  const startEdit = () => {
    setEditName(template.name || '');
    setEditCategory(template.category || '');
    setEditTags([...templateTags]);
    setTagInput('');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setTagInput('');
  };

  const handleSave = async () => {
    if (!onUpdate) return;
    const trimmedName = editName.trim();
    if (!trimmedName) {
      setSaveError('Name cannot be empty');
      return;
    }
    if (trimmedName.length > 255) {
      setSaveError('Name must be under 255 characters');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await onUpdate(template.id, {
        name: trimmedName,
        category: editCategory,
        tags: editTags.filter(t => t.trim()),
      });
      setEditing(false);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveError('Failed to save changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase().slice(0, 50); // max 50 chars per tag
    if (tag && !editTags.includes(tag) && editTags.length < 20) { // max 20 tags
      setEditTags([...editTags, tag]);
    }
    setTagInput('');
  };

  const removeTag = (tag) => {
    setEditTags(editTags.filter(t => t !== tag));
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    if (e.key === 'Backspace' && tagInput === '' && editTags.length > 0) {
      setEditTags(editTags.slice(0, -1));
    }
  };

  const handleReanalyze = async () => {
    if (!onAnalyze) return;
    setReanalyzing(true);
    await onAnalyze(template);
    setReanalyzing(false);
  };

  // Category badge color
  const categoryColors = {
    'Negative Hook': 'bg-purple-600/20 text-purple-300 border-purple-500/30',
    'Offer & Promotion': 'bg-amber-600/20 text-amber-300 border-amber-500/30',
    'Offer/Sale': 'bg-amber-600/20 text-amber-300 border-amber-500/30',
    'Benefits & Features': 'bg-blue-600/20 text-blue-300 border-blue-500/30',
    'Feature/Benefit': 'bg-blue-600/20 text-blue-300 border-blue-500/30',
    'Social Proof & Testimonials': 'bg-green-600/20 text-green-300 border-green-500/30',
    'Testimonial': 'bg-green-600/20 text-green-300 border-green-500/30',
    'UGC & Reviews': 'bg-green-600/20 text-green-300 border-green-500/30',
    'Problem + Solution': 'bg-rose-600/20 text-rose-300 border-rose-500/30',
    'Us vs Them': 'bg-orange-600/20 text-orange-300 border-orange-500/30',
    'Bold Claim': 'bg-red-600/20 text-red-300 border-red-500/30',
    'Before & After': 'bg-cyan-600/20 text-cyan-300 border-cyan-500/30',
    'Lifestyle & Brand': 'bg-pink-600/20 text-pink-300 border-pink-500/30',
    'Statistics': 'bg-indigo-600/20 text-indigo-300 border-indigo-500/30',
    'AirDrop': 'bg-sky-600/20 text-sky-300 border-sky-500/30',
    'Apple Notes': 'bg-yellow-600/20 text-yellow-300 border-yellow-500/30',
    'Article/News': 'bg-slate-600/20 text-slate-300 border-slate-500/30',
    'Google Search': 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30',
    'Headline': 'bg-violet-600/20 text-violet-300 border-violet-500/30',
    'Meme': 'bg-lime-600/20 text-lime-300 border-lime-500/30',
    'Native': 'bg-teal-600/20 text-teal-300 border-teal-500/30',
    "What's Inside": 'bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-500/30',
  };
  const displayCategory = editing ? editCategory : template.category;
  const badgeClass = categoryColors[displayCategory] || 'bg-zinc-600/20 text-zinc-300 border-zinc-500/30';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex bg-[#141416] rounded-2xl border border-white/[0.06] shadow-2xl max-w-[900px] w-[90vw] max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left — Image */}
        <div className="flex-shrink-0 w-[45%] bg-black/40 flex items-center justify-center p-4 relative">
          {template.image_url ? (
            <img
              src={template.image_url}
              alt={template.name || 'Reference Ad'}
              className="max-w-full max-h-[75vh] rounded-lg object-contain"
            />
          ) : (
            <div className="w-full aspect-[4/5] rounded-lg bg-[#1a1a1a] flex items-center justify-center text-slate-600">
              <AlertCircle className="w-12 h-12" />
            </div>
          )}
        </div>

        {/* Right — Details Panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
          {/* Header */}
          <div className="flex items-start justify-between px-6 pt-5 pb-4">
            <div className="flex-1 min-w-0 pr-4">
              {editing ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => { setEditName(e.target.value); setSaveError(''); }}
                  maxLength={255}
                  className="w-full text-base font-semibold text-white bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-1.5 outline-none focus:border-accent/50 transition-colors"
                  placeholder="Template name"
                  autoFocus
                />
              ) : (
                <h3 className="text-base font-semibold text-white truncate">
                  {template.name || 'Reference Ad'}
                </h3>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!editing && onUpdate && (
                <button
                  onClick={startEdit}
                  className="p-1.5 text-zinc-500 hover:text-accent transition-colors cursor-pointer"
                  title="Edit template"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => { cancelEdit(); onClose(); }} className="p-1 text-zinc-500 hover:text-white transition-colors cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="px-6 pb-6 space-y-5 flex-1">
            {/* Category */}
            <div>
              <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-2">Category</p>
              {editing ? (
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="w-full text-sm text-white bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2 outline-none focus:border-accent/50 transition-colors cursor-pointer appearance-none"
                >
                  <option value="" className="bg-[#1a1a1a]">Uncategorized</option>
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat} className="bg-[#1a1a1a]">{cat}</option>
                  ))}
                </select>
              ) : (
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border ${badgeClass}`}>
                  {template.category || 'Uncategorized'}
                </span>
              )}
            </div>

            {/* Tags (edit mode) or Date Added (view mode) */}
            {editing ? (
              <div>
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-2">Tags</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {editTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-accent/10 text-accent border border-accent/20"
                    >
                      {tag}
                      <button onClick={() => removeTag(tag)} className="hover:text-red-400 cursor-pointer">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    className="flex-1 text-sm text-white bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-1.5 outline-none focus:border-accent/50 transition-colors"
                    placeholder="Add a tag and press Enter"
                  />
                  <button
                    onClick={addTag}
                    disabled={!tagInput.trim()}
                    className="px-3 py-1.5 text-xs font-medium bg-white/[0.06] text-zinc-400 hover:text-white hover:bg-white/[0.1] rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Tags (view mode) */}
                {templateTags.length > 0 && (
                  <div>
                    <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-2">Tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {templateTags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-white/[0.06] text-zinc-400 border border-white/[0.04]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Date Added */}
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-1">Date Added</p>
                  <p className="text-sm text-zinc-300 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                    {template.created_at
                      ? new Date(template.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                      : 'Unknown'}
                  </p>
                </div>
              </>
            )}

            {/* AI Analysis (always shown) */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">AI Analysis</p>
                {!editing && (
                  <button
                    onClick={handleReanalyze}
                    disabled={reanalyzing}
                    className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${reanalyzing ? 'animate-spin' : ''}`} />
                    {reanalyzing ? 'Analyzing...' : 'Re-analyze'}
                  </button>
                )}
              </div>

              {da ? (
                <div className="space-y-3">
                  {/* Summary paragraph */}
                  <p className="text-sm text-zinc-300 leading-relaxed">
                    {da.summary || da.ad_effectiveness_notes || 'Analysis completed — no summary available.'}
                  </p>

                  {/* Quick stats row */}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {da.template_type && (
                      <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-400 border border-white/[0.04]">
                        {da.template_type}
                      </span>
                    )}
                    {da.emotional_tone && (
                      <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-400 border border-white/[0.04]">
                        {da.emotional_tone}
                      </span>
                    )}
                    {da.layout?.grid_structure && (
                      <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-400 border border-white/[0.04]">
                        {da.layout.grid_structure}
                      </span>
                    )}
                    {da.adaptation_instructions?.product_replacement_difficulty && (
                      <span className={`px-2 py-0.5 text-[10px] font-medium rounded border ${
                        da.adaptation_instructions.product_replacement_difficulty === 'easy'
                          ? 'bg-green-900/20 text-green-400 border-green-500/20'
                          : da.adaptation_instructions.product_replacement_difficulty === 'hard'
                            ? 'bg-red-900/20 text-red-400 border-red-500/20'
                            : 'bg-yellow-900/20 text-yellow-400 border-yellow-500/20'
                      }`}>
                        {da.adaptation_instructions.product_replacement_difficulty} adaptation
                      </span>
                    )}
                  </div>

                  {/* Colors */}
                  {da.color_palette && (
                    <div className="flex items-center gap-1.5 pt-1">
                      {[da.color_palette.dominant, da.color_palette.accent, da.color_palette.text_primary, da.color_palette.text_secondary].filter(Boolean).map((c, i) => (
                        <div key={i} className="w-5 h-5 rounded-md border border-white/10 shadow-sm" style={{ backgroundColor: c }} title={c} />
                      ))}
                      {da.color_palette.overall_mood && (
                        <span className="text-[10px] text-zinc-500 ml-1">{da.color_palette.overall_mood}</span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-4 text-center">
                  <p className="text-sm text-zinc-500 mb-3">Not analyzed yet</p>
                  <button
                    onClick={handleReanalyze}
                    disabled={reanalyzing}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {reanalyzing ? 'Analyzing...' : 'Analyze Template'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-between">
            {editing ? (
              /* Edit mode footer */
              <>
                <div className="flex items-center gap-3">
                  <button
                    onClick={cancelEdit}
                    className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                  {saveError && (
                    <span className="text-xs text-red-400">{saveError}</span>
                  )}
                </div>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </>
            ) : (
              /* View mode footer */
              <>
                <div className="flex items-center gap-3">
                  {onHide && (
                    <button
                      onClick={() => { onHide(template); onClose(); }}
                      className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                      Hide
                    </button>
                  )}
                  {onDelete && (
                    <button
                      onClick={() => { onDelete(template); onClose(); }}
                      className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-zinc-600">ID #{template.id?.slice(-4) || '—'}</span>
                  <button
                    onClick={() => { onSelect(template); onClose(); }}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Use as Reference
                  </button>
                </div>
              </>
            )}
          </div>
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
  onUpdateTemplate,
}) {
  const [selectMode, setSelectMode] = useState(false);
  const [viewingTemplateId, setViewingTemplateId] = useState(null);

  // Derive viewingTemplate from templates array so it stays in sync after edits
  const viewingTemplate = useMemo(
    () => (viewingTemplateId ? templates.find(t => t.id === viewingTemplateId) || null : null),
    [viewingTemplateId, templates],
  );

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
                  onView={(tpl) => setViewingTemplateId(tpl.id)}
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
        onClose={() => setViewingTemplateId(null)}
        onSelect={onSelectTemplate}
        onAnalyze={onAnalyzeTemplate}
        onDelete={onDeleteTemplate}
        onUpdate={onUpdateTemplate}
      />
    </div>
  );
}
