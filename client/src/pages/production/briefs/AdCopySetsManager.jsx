import { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Edit2,
  Download,
  Upload,
  FileText,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CTA_OPTIONS = [
  'SHOP_NOW',
  'LEARN_MORE',
  'SIGN_UP',
  'SUBSCRIBE',
  'GET_OFFER',
  'BOOK_NOW',
  'CONTACT_US',
  'DOWNLOAD',
  'ORDER_NOW',
  'APPLY_NOW',
];

const MAX_ITEMS = 20;

const EMPTY_COPY_SET = {
  angle: '',
  primary_texts: [''],
  headlines: [''],
  descriptions: [''],
  cta_button: 'SHOP_NOW',
  landing_page_url: '',
  utm_parameters: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str, len = 60) {
  if (!str) return '—';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function countLabel(arr) {
  const filtered = ensureArray(arr).filter((s) => s && s.trim());
  return filtered.length;
}

// ---------------------------------------------------------------------------
// EditCopySetModal (sub-modal)
// ---------------------------------------------------------------------------

function EditCopySetModal({ copySet, onSave, onClose, saving }) {
  const [form, setForm] = useState(() => {
    const pt = ensureArray(copySet.primary_texts);
    const hl = ensureArray(copySet.headlines);
    const desc = ensureArray(copySet.descriptions);
    return {
      primary_texts: pt.length ? [...pt] : [''],
      headlines: hl.length ? [...hl] : [''],
      descriptions: desc.length ? [...desc] : [''],
      cta_button: copySet.cta_button || 'SHOP_NOW',
      landing_page_url: copySet.landing_page_url || '',
      utm_parameters: copySet.utm_parameters || '',
    };
  });

  const updateList = (key, idx, value) => {
    setForm((prev) => {
      const copy = [...prev[key]];
      copy[idx] = value;
      return { ...prev, [key]: copy };
    });
  };

  const addToList = (key) => {
    if (form[key].length >= MAX_ITEMS) return;
    setForm((prev) => ({ ...prev, [key]: [...prev[key], ''] }));
  };

  const removeFromList = (key, idx) => {
    if (form[key].length <= 1) return;
    setForm((prev) => ({
      ...prev,
      [key]: prev[key].filter((_, i) => i !== idx),
    }));
  };

  const handleSave = () => {
    onSave({
      ...form,
      angle: copySet.angle,
      primary_texts: form.primary_texts.filter((s) => s.trim()),
      headlines: form.headlines.filter((s) => s.trim()),
      descriptions: form.descriptions.filter((s) => s.trim()),
    });
  };

  const inputClass =
    'w-full bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 placeholder-white/20';

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl animate-in slide-in-from-bottom-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            Edit Copy Set — <span className="text-[#c9a84c]">{copySet.angle}</span>
          </h3>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Primary Texts */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              Primary Texts ({form.primary_texts.length}/{MAX_ITEMS})
            </label>
            <div className="space-y-2">
              {form.primary_texts.map((text, i) => (
                <div key={i} className="flex gap-2">
                  <textarea
                    rows={4}
                    className={inputClass + ' flex-1'}
                    value={text}
                    onChange={(e) => updateList('primary_texts', i, e.target.value)}
                    placeholder={`Primary text ${i + 1}...`}
                  />
                  {form.primary_texts.length > 1 && (
                    <button
                      onClick={() => removeFromList('primary_texts', i)}
                      className="text-white/20 hover:text-red-400 transition-colors mt-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {form.primary_texts.length < MAX_ITEMS && (
              <button
                onClick={() => addToList('primary_texts')}
                className="mt-2 flex items-center gap-1.5 text-xs text-[#c9a84c]/70 hover:text-[#c9a84c] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Primary Text
              </button>
            )}
          </div>

          {/* Headlines */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              Headlines ({form.headlines.length}/{MAX_ITEMS})
            </label>
            <div className="space-y-2">
              {form.headlines.map((text, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    className={inputClass + ' flex-1'}
                    value={text}
                    onChange={(e) => updateList('headlines', i, e.target.value)}
                    placeholder={`Headline ${i + 1}...`}
                  />
                  {form.headlines.length > 1 && (
                    <button
                      onClick={() => removeFromList('headlines', i)}
                      className="text-white/20 hover:text-red-400 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {form.headlines.length < MAX_ITEMS && (
              <button
                onClick={() => addToList('headlines')}
                className="mt-2 flex items-center gap-1.5 text-xs text-[#c9a84c]/70 hover:text-[#c9a84c] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Headline
              </button>
            )}
          </div>

          {/* Descriptions */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              Descriptions ({form.descriptions.length}/{MAX_ITEMS})
            </label>
            <div className="space-y-2">
              {form.descriptions.map((text, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    className={inputClass + ' flex-1'}
                    value={text}
                    onChange={(e) => updateList('descriptions', i, e.target.value)}
                    placeholder={`Description ${i + 1}...`}
                  />
                  {form.descriptions.length > 1 && (
                    <button
                      onClick={() => removeFromList('descriptions', i)}
                      className="text-white/20 hover:text-red-400 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {form.descriptions.length < MAX_ITEMS && (
              <button
                onClick={() => addToList('descriptions')}
                className="mt-2 flex items-center gap-1.5 text-xs text-[#c9a84c]/70 hover:text-[#c9a84c] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Description
              </button>
            )}
          </div>

          {/* CTA Button */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              CTA Button
            </label>
            <select
              className={inputClass + ' cursor-pointer'}
              value={form.cta_button}
              onChange={(e) => setForm((prev) => ({ ...prev, cta_button: e.target.value }))}
            >
              {CTA_OPTIONS.map((opt) => (
                <option key={opt} value={opt} className="bg-[#111113] text-white">
                  {opt.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          {/* Landing Page URL */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              Landing Page URL
            </label>
            <input
              className={inputClass}
              value={form.landing_page_url}
              onChange={(e) => setForm((prev) => ({ ...prev, landing_page_url: e.target.value }))}
              placeholder="https://..."
            />
          </div>

          {/* UTM Parameters */}
          <div>
            <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-2">
              UTM Parameters
            </label>
            <input
              className={inputClass}
              value={form.utm_parameters}
              onChange={(e) => setForm((prev) => ({ ...prev, utm_parameters: e.target.value }))}
              placeholder="utm_source=facebook&utm_medium=cpc&..."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.06]">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#c9a84c] hover:bg-[#d4b55a] text-[#111113] font-semibold text-sm transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdCopySetsManager (main modal)
// ---------------------------------------------------------------------------

export default function AdCopySetsManager({ open, onClose, productId, productName }) {
  const [copySets, setCopySets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingSet, setEditingSet] = useState(null);
  const [addingAngle, setAddingAngle] = useState(false);
  const [newAngleName, setNewAngleName] = useState('');

  // ── Fetch copy sets ────────────────────────────────────────────────────
  const fetchCopySets = async () => {
    setLoading(true);
    try {
      const params = {};
      if (productId) params.product_id = productId;
      const { data } = await api.get('/brief-pipeline/copy-sets', { params });
      setCopySets(data.data || data || []);
    } catch (err) {
      console.error('Failed to fetch copy sets:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) fetchCopySets();
  }, [open, productId]);

  // ── Create ─────────────────────────────────────────────────────────────
  const handleCreateAngle = async () => {
    const name = newAngleName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const { data } = await api.post('/brief-pipeline/copy-sets', {
        ...EMPTY_COPY_SET,
        product_id: productId,
        angle: name,
      });
      const created = data.data || data;
      setCopySets((prev) => [...prev, created]);
      setNewAngleName('');
      setAddingAngle(false);
      setEditingSet(created);
    } catch (err) {
      console.error('Failed to create copy set:', err);
    } finally {
      setSaving(false);
    }
  };

  // ── Update ─────────────────────────────────────────────────────────────
  const handleSave = async (formData) => {
    if (!editingSet) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/brief-pipeline/copy-sets/${editingSet.id}`, formData);
      const updated = data.data || data;
      setCopySets((prev) => prev.map((cs) => (cs.id === editingSet.id ? { ...cs, ...updated } : cs)));
      setEditingSet(null);
    } catch (err) {
      console.error('Failed to update copy set:', err);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      await api.delete(`/brief-pipeline/copy-sets/${id}`);
      setCopySets((prev) => prev.filter((cs) => cs.id !== id));
    } catch (err) {
      console.error('Failed to delete copy set:', err);
    }
  };

  // ── Download template ──────────────────────────────────────────────────
  const handleDownloadTemplate = () => {
    const headers = ['Angle', 'Primary Text', 'Headline', 'Description', 'CTA', 'Landing Page URL', 'UTM Parameters'];
    const csv = headers.join(',') + '\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ad-copy-template-${productName || 'product'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Upload CSV ─────────────────────────────────────────────────────────
  const handleUploadCSV = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length < 2) return;

      // Group by angle
      const angleMap = {};
      lines.slice(1).forEach((line) => {
        // Parse CSV respecting quoted fields (handles commas inside quotes)
        const cols = (line.match(/(".*?"|[^,]+|(?<=,)(?=,))/g) || []).map((c) => c.trim().replace(/^"|"$/g, ''));
        const [angle, primaryText, headline, description, cta, url, utm] = cols;
        if (!angle) return;
        if (!angleMap[angle]) {
          angleMap[angle] = {
            primary_texts: [],
            headlines: [],
            descriptions: [],
            cta_button: cta || 'SHOP_NOW',
            landing_page_url: url || '',
            utm_parameters: utm || '',
          };
        }
        if (primaryText) angleMap[angle].primary_texts.push(primaryText);
        if (headline) angleMap[angle].headlines.push(headline);
        if (description) angleMap[angle].descriptions.push(description);
      });

      // Create copy sets for each angle
      for (const [angle, data] of Object.entries(angleMap)) {
        try {
          await api.post('/brief-pipeline/copy-sets', {
            product_id: productId,
            angle,
            ...data,
          });
        } catch (err) {
          console.error(`Failed to create copy set for angle "${angle}":`, err);
        }
      }
      fetchCopySets();
    };
    input.click();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="w-5 h-5 text-[#c9a84c] shrink-0" />
            <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide truncate">
              Ad Copy Sets {productName && <>— <span className="text-[#c9a84c]">{productName}</span></>}
            </h2>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleDownloadTemplate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-medium text-zinc-400 uppercase tracking-wide border border-white/[0.05] hover:border-white/[0.1] hover:text-zinc-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Template
            </button>
            <button
              onClick={handleUploadCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-medium text-zinc-400 uppercase tracking-wide border border-white/[0.05] hover:border-white/[0.1] hover:text-zinc-200 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" /> CSV
            </button>
            <button
              onClick={() => { setAddingAngle(true); setNewAngleName(''); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-semibold uppercase tracking-wide bg-[#c9a84c] hover:bg-[#d4b55a] text-[#111113] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add Angle
            </button>
            <button onClick={onClose} className="ml-1 text-white/40 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {/* Add Angle Inline Input */}
          {addingAngle && (
            <div className="glass-card border border-white/[0.05] rounded-xl p-4 flex items-center gap-3">
              <input
                autoFocus
                className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 placeholder-white/20"
                value={newAngleName}
                onChange={(e) => setNewAngleName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateAngle()}
                placeholder="Enter angle name..."
              />
              <button
                onClick={handleCreateAngle}
                disabled={!newAngleName.trim() || saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#c9a84c] hover:bg-[#d4b55a] text-[#111113] transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Create
              </button>
              <button
                onClick={() => setAddingAngle(false)}
                className="text-white/30 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-16 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading copy sets...
            </div>
          )}

          {/* Empty State */}
          {!loading && copySets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-white/30">
              <FileText className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No ad copy sets yet</p>
              <p className="text-xs mt-1 text-white/20">Click "+ Add Angle" to create your first copy set</p>
            </div>
          )}

          {/* Copy Set Cards */}
          {copySets.map((cs) => (
            <div
              key={cs.id}
              className="glass-card border border-white/[0.05] rounded-xl p-4 hover:border-white/[0.1] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Angle badge + counts */}
                  <div className="flex items-center gap-3 mb-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border border-[#c9a84c]/40 text-[#c9a84c] bg-[#c9a84c]/5">
                      {cs.angle}
                    </span>
                    <span className="text-[11px] text-white/30 font-mono">
                      {countLabel(cs.primary_texts)} texts · {countLabel(cs.headlines)} headlines · {countLabel(cs.descriptions)} descriptions
                    </span>
                  </div>

                  {/* Preview row */}
                  <div className="grid grid-cols-3 gap-3 text-xs text-white/50 mb-2">
                    <div className="min-w-0">
                      <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-0.5">
                        Body Copy
                      </span>
                      <p className="truncate">{truncate(ensureArray(cs.primary_texts)[0], 50)}</p>
                    </div>
                    <div className="min-w-0">
                      <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-0.5">
                        Headline
                      </span>
                      <p className="truncate">{truncate(ensureArray(cs.headlines)[0], 40)}</p>
                    </div>
                    <div className="min-w-0">
                      <span className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-0.5">
                        Description
                      </span>
                      <p className="truncate">{truncate(ensureArray(cs.descriptions)[0], 40)}</p>
                    </div>
                  </div>

                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setEditingSet(cs)}
                    className="p-1.5 rounded-lg text-white/30 hover:text-[#c9a84c] hover:bg-white/[0.04] transition-colors"
                    title="Edit"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(cs.id)}
                    className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.04] transition-colors"
                    title="Delete"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit Sub-Modal */}
      {editingSet && (
        <EditCopySetModal
          copySet={editingSet}
          onSave={handleSave}
          onClose={() => setEditingSet(null)}
          saving={saving}
        />
      )}
    </div>
  );
}
