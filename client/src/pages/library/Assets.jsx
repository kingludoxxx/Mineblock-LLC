import { useState, useEffect, useCallback } from 'react';
import {
  Package,
  Plus,
  Pencil,
  Trash2,
  X,
  Save,
  Image,
  FileText,
  Target,
  Megaphone,
  ChevronRight,
  Loader2,
  Users,
  Sparkles,
  Shield,
  Upload,
} from 'lucide-react';
import api from '../../services/api';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const CATEGORIES = [
  { value: 'supplement', label: 'Supplement' },
  { value: 'saas', label: 'SaaS' },
  { value: 'physical', label: 'Physical' },
  { value: 'digital', label: 'Digital' },
  { value: 'service', label: 'Service' },
  { value: 'other', label: 'Other' },
];

const SCRIPT_TYPES = [
  { value: 'vsl', label: 'VSL' },
  { value: 'email', label: 'Email' },
  { value: 'ad', label: 'Ad' },
  { value: 'other', label: 'Other' },
];

const TABS = [
  { key: 'basic', label: 'Basic Info', icon: Package },
  { key: 'audience', label: 'Audience & Marketing', icon: Users },
  { key: 'details', label: 'Product Details', icon: Sparkles },
  { key: 'angles', label: 'Marketing Angles', icon: Megaphone },
  { key: 'images', label: 'Images & Logos', icon: Image },
  { key: 'fonts', label: 'Brand Fonts', icon: FileText },
  { key: 'scripts', label: 'Scripts', icon: FileText },
];

const emptyProduct = {
  name: '',
  productCode: '',
  category: 'supplement',
  price: '',
  description: '',
  oneLiner: '',
  tagline: '',
  targetCustomer: '',
  customerFrustration: '',
  customerDream: '',
  targetDemographics: '',
  voiceTone: '',
  bigPromise: '',
  uniqueMechanism: '',
  differentiator: '',
  guarantee: '',
  benefits: [''],
  angles: [{ name: '', description: '' }],
  images: [''],
  logos: [''],
  fonts: [{ name: '', url: '', usage: 'headline' }],
  scripts: [{ title: '', type: 'vsl', content: '' }],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const categoryColor = (cat) => {
  const map = {
    supplement: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    saas: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    physical: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    digital: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    service: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    other: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  };
  return map[cat] || map.other;
};

const statCount = (arr) => (Array.isArray(arr) ? arr.filter((v) => (typeof v === 'string' ? v.trim() : v?.name?.trim() || v?.title?.trim())).length : 0);

/* ------------------------------------------------------------------ */
/*  Reusable tiny components                                          */
/* ------------------------------------------------------------------ */

function Input({ label, value, onChange, placeholder, type = 'text', required }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">
        {label}{required && <span className="text-emerald-400 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition-colors"
      />
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 3 }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition-colors resize-none"
      />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Product Card                                                      */
/* ------------------------------------------------------------------ */

function ProductCard({ product, onEdit, onDelete }) {
  const imgCount = statCount(product.images);
  const scriptCount = statCount(product.scripts);
  const angleCount = statCount(product.angles);
  const benefitCount = statCount(product.benefits);

  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 flex flex-col justify-between hover:border-white/[0.12] transition-colors group">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-white truncate">{product.name}</h3>
            {product.category && (
              <span className={`inline-block mt-1.5 text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border ${categoryColor(product.category)}`}>
                {product.category}
              </span>
            )}
          </div>
          {product.price && (
            <span className="text-sm font-semibold text-emerald-400 ml-3 shrink-0">{product.price}</span>
          )}
        </div>

        {/* Description */}
        {(product.oneLiner || product.description) && (
          <p className="text-sm text-slate-400 line-clamp-2 mb-4 leading-relaxed">
            {product.oneLiner || product.description}
          </p>
        )}

        {/* Stats */}
        <div className="flex items-center gap-4 text-[11px] text-slate-500 mb-4">
          {imgCount > 0 && (
            <span className="flex items-center gap-1"><Image className="w-3 h-3" />{imgCount} image{imgCount !== 1 && 's'}</span>
          )}
          {scriptCount > 0 && (
            <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{scriptCount} script{scriptCount !== 1 && 's'}</span>
          )}
          {angleCount > 0 && (
            <span className="flex items-center gap-1"><Target className="w-3 h-3" />{angleCount} angle{angleCount !== 1 && 's'}</span>
          )}
          {benefitCount > 0 && (
            <span className="flex items-center gap-1"><Sparkles className="w-3 h-3" />{benefitCount} benefit{benefitCount !== 1 && 's'}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06]">
        <button
          onClick={() => onEdit(product)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2.5 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
        >
          <Pencil className="w-3 h-3" /> Edit
        </button>
        <button
          onClick={() => onDelete(product)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 px-2.5 py-1.5 rounded-md hover:bg-red-500/[0.05] transition-colors"
        >
          <Trash2 className="w-3 h-3" /> Delete
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty State                                                       */
/* ------------------------------------------------------------------ */

function EmptyState({ onCreate }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mb-5">
        <Package className="w-7 h-7 text-emerald-400" />
      </div>
      <h3 className="text-lg font-semibold text-white mb-1.5">No products yet</h3>
      <p className="text-sm text-slate-400 mb-6 max-w-xs">Add your first product to get started. All production tools pull from these profiles.</p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
      >
        <Plus className="w-4 h-4" /> Add Product
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Delete Confirmation                                               */
/* ------------------------------------------------------------------ */

function DeleteDialog({ product, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#151515] border border-white/[0.08] rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
            <Trash2 className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Delete product</h3>
            <p className="text-xs text-slate-400 mt-0.5">This action cannot be undone.</p>
          </div>
        </div>
        <p className="text-sm text-slate-300 mb-6">
          Are you sure you want to delete <span className="text-white font-medium">{product.name}</span>?
        </p>
        <div className="flex items-center justify-end gap-2">
          <button onClick={onCancel} className="text-sm text-slate-400 hover:text-white px-4 py-2 rounded-lg hover:bg-white/[0.05] transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} className="text-sm font-medium text-white bg-red-600 hover:bg-red-500 px-4 py-2 rounded-lg transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editor Modal                                                      */
/* ------------------------------------------------------------------ */

function EditorModal({ isCreating, form, setForm, activeTab, setActiveTab, saving, onSave, onCancel }) {
  /* ---- list helpers ---- */
  const updateBenefit = (i, val) => {
    const list = [...form.benefits];
    list[i] = val;
    setForm({ ...form, benefits: list });
  };
  const addBenefit = () => setForm({ ...form, benefits: [...form.benefits, ''] });
  const removeBenefit = (i) => {
    const list = form.benefits.filter((_, idx) => idx !== i);
    setForm({ ...form, benefits: list.length ? list : [''] });
  };

  const updateAngle = (i, key, val) => {
    const list = [...form.angles];
    list[i] = { ...list[i], [key]: val };
    setForm({ ...form, angles: list });
  };
  const addAngle = () => setForm({ ...form, angles: [...form.angles, { name: '', description: '' }] });
  const removeAngle = (i) => {
    const list = form.angles.filter((_, idx) => idx !== i);
    setForm({ ...form, angles: list.length ? list : [{ name: '', description: '' }] });
  };

  const removeImage = (i) => {
    const list = form.images.filter((_, idx) => idx !== i);
    setForm({ ...form, images: list.length ? list : [] });
  };
  const handleImageUpload = (files) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        setForm((prev) => ({
          ...prev,
          images: [...prev.images.filter((img) => img), reader.result],
        }));
      };
      reader.readAsDataURL(file);
    });
  };
  const [imageUrlInput, setImageUrlInput] = useState('');
  const addImageUrl = () => {
    if (!imageUrlInput.trim()) return;
    setForm((prev) => ({
      ...prev,
      images: [...prev.images.filter((img) => img), imageUrlInput.trim()],
    }));
    setImageUrlInput('');
  };

  const removeLogo = (i) => {
    const list = form.logos.filter((_, idx) => idx !== i);
    setForm({ ...form, logos: list.length ? list : [] });
  };
  const handleLogoUpload = (files) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        setForm((prev) => ({
          ...prev,
          logos: [...prev.logos.filter((l) => l), reader.result],
        }));
      };
      reader.readAsDataURL(file);
    });
  };

  const updateFont = (i, key, val) => {
    const list = [...form.fonts];
    list[i] = { ...list[i], [key]: val };
    setForm({ ...form, fonts: list });
  };
  const addFont = () => setForm({ ...form, fonts: [...form.fonts, { name: '', url: '', usage: 'headline' }] });
  const removeFont = (i) => {
    const list = form.fonts.filter((_, idx) => idx !== i);
    setForm({ ...form, fonts: list.length ? list : [{ name: '', url: '', usage: 'headline' }] });
  };
  const handleFontUpload = (i, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const list = [...form.fonts];
      list[i] = { ...list[i], url: reader.result, name: list[i].name || file.name.replace(/\.[^.]+$/, '') };
      setForm({ ...form, fonts: list });
    };
    reader.readAsDataURL(file);
  };

  const updateScript = (i, key, val) => {
    const list = [...form.scripts];
    list[i] = { ...list[i], [key]: val };
    setForm({ ...form, scripts: list });
  };
  const addScript = () => setForm({ ...form, scripts: [...form.scripts, { title: '', type: 'vsl', content: '' }] });
  const removeScript = (i) => {
    const list = form.scripts.filter((_, idx) => idx !== i);
    setForm({ ...form, scripts: list.length ? list : [{ title: '', type: 'vsl', content: '' }] });
  };

  const field = (key, val) => setForm({ ...form, [key]: val });

  /* ---- tab renderers ---- */
  const renderBasic = () => (
    <div className="space-y-4">
      <Input label="Product Name" value={form.name} onChange={(v) => field('name', v)} placeholder="e.g. SuperGreens Pro" required />
      <Input label="Product Code" value={form.productCode} onChange={(v) => field('productCode', v)} placeholder="e.g. SGP-001" />
      <Select label="Category" value={form.category} onChange={(v) => field('category', v)} options={CATEGORIES} />
      <Input label="Price" value={form.price} onChange={(v) => field('price', v)} placeholder="e.g. $49.99" />
      <TextArea label="Description" value={form.description} onChange={(v) => field('description', v)} placeholder="Describe the product..." rows={4} />
      <Input label="One-liner" value={form.oneLiner} onChange={(v) => field('oneLiner', v)} placeholder="A single punchy line about the product" />
      <Input label="Tagline" value={form.tagline} onChange={(v) => field('tagline', v)} placeholder="Short tagline for ads / headers" />
    </div>
  );

  const renderAudience = () => (
    <div className="space-y-4">
      <TextArea label="Target Customer / Avatar" value={form.targetCustomer} onChange={(v) => field('targetCustomer', v)} placeholder="Who is this for?" rows={2} />
      <TextArea label="Customer Frustration" value={form.customerFrustration} onChange={(v) => field('customerFrustration', v)} placeholder="What keeps them up at night?" rows={2} />
      <TextArea label="Customer Dream" value={form.customerDream} onChange={(v) => field('customerDream', v)} placeholder="What does their ideal outcome look like?" rows={2} />
      <Input label="Target Demographics" value={form.targetDemographics} onChange={(v) => field('targetDemographics', v)} placeholder="e.g. Males 25-45, USA" />
      <Input label="Voice / Tone" value={form.voiceTone} onChange={(v) => field('voiceTone', v)} placeholder="e.g. Direct, authoritative, slightly edgy" />
    </div>
  );

  const renderDetails = () => (
    <div className="space-y-4">
      <TextArea label="Big Promise" value={form.bigPromise} onChange={(v) => field('bigPromise', v)} placeholder="The #1 result your product delivers" rows={2} />
      <TextArea label="Unique Mechanism" value={form.uniqueMechanism} onChange={(v) => field('uniqueMechanism', v)} placeholder="What makes it work differently?" rows={3} />
      <TextArea label="Differentiator" value={form.differentiator} onChange={(v) => field('differentiator', v)} placeholder="Why choose this over competitors?" rows={2} />
      <Input label="Guarantee" value={form.guarantee} onChange={(v) => field('guarantee', v)} placeholder="e.g. 60-day money-back guarantee" />

      {/* Benefits */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Benefits</label>
        <div className="space-y-2">
          {form.benefits.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={b}
                onChange={(e) => updateBenefit(i, e.target.value)}
                placeholder={`Benefit ${i + 1}`}
                className="flex-1 bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
              />
              <button onClick={() => removeBenefit(i)} className="text-slate-500 hover:text-red-400 p-1 transition-colors" title="Remove">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button onClick={addBenefit} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
          <Plus className="w-3 h-3" /> Add benefit
        </button>
      </div>
    </div>
  );

  const renderAngles = () => (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-3">Marketing Angles</label>
      <div className="space-y-3">
        {form.angles.map((a, i) => (
          <div key={i} className="bg-[#0a0a0a] border border-white/[0.08] rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={a.name}
                onChange={(e) => updateAngle(i, 'name', e.target.value)}
                placeholder="Angle name"
                className="flex-1 bg-transparent border-b border-white/[0.06] pb-1 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
              />
              <button onClick={() => removeAngle(i)} className="text-slate-500 hover:text-red-400 p-1 transition-colors" title="Remove">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              value={a.description}
              onChange={(e) => updateAngle(i, 'description', e.target.value)}
              placeholder="Describe this angle..."
              rows={2}
              className="w-full bg-transparent border border-white/[0.06] rounded-md px-2.5 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors resize-none"
            />
          </div>
        ))}
      </div>
      <button onClick={addAngle} className="mt-3 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
        <Plus className="w-3 h-3" /> Add angle
      </button>
    </div>
  );

  const renderImages = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Product Images</label>
        {/* Upload zone */}
        <div
          className="border-2 border-dashed border-white/[0.08] rounded-lg p-6 text-center hover:border-emerald-500/30 transition-colors cursor-pointer mb-3"
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-emerald-500/40'); }}
          onDragLeave={(e) => { e.currentTarget.classList.remove('border-emerald-500/40'); }}
          onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-emerald-500/40'); handleImageUpload(e.dataTransfer.files); }}
          onClick={() => document.getElementById('product-image-upload-input').click()}
        >
          <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
          <p className="text-xs text-slate-400">Drop product images here or <span className="text-emerald-400">browse</span></p>
          <p className="text-[10px] text-slate-600 mt-1">PNG, JPG, WebP — multiple files supported</p>
          <input
            id="product-image-upload-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { handleImageUpload(e.target.files); e.target.value = ''; }}
          />
        </div>
        {/* URL paste fallback */}
        <div className="flex items-center gap-2 mb-3">
          <input
            value={imageUrlInput}
            onChange={(e) => setImageUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addImageUrl()}
            placeholder="Or paste image URL..."
            className="flex-1 bg-[#0a0a0a] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
          <button
            onClick={addImageUrl}
            disabled={!imageUrlInput.trim()}
            className="text-xs text-emerald-400 hover:text-emerald-300 disabled:text-slate-600 disabled:cursor-not-allowed px-3 py-2 rounded-lg border border-white/[0.08] hover:border-emerald-500/30 transition-colors"
          >
            Add
          </button>
        </div>
        {/* Image previews grid */}
        {form.images.filter((img) => img).length > 0 && (
          <div className="flex flex-wrap gap-3">
            {form.images.map((url, i) =>
              url ? (
                <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-white/[0.06] bg-[#0a0a0a]">
                  <img src={url} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : null
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Logos</label>
        {/* Upload zone */}
        <div
          className="border-2 border-dashed border-white/[0.08] rounded-lg p-6 text-center hover:border-emerald-500/30 transition-colors cursor-pointer mb-3"
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-emerald-500/40'); }}
          onDragLeave={(e) => { e.currentTarget.classList.remove('border-emerald-500/40'); }}
          onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-emerald-500/40'); handleLogoUpload(e.dataTransfer.files); }}
          onClick={() => document.getElementById('logo-upload-input').click()}
        >
          <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
          <p className="text-xs text-slate-400">Drop logos here or <span className="text-emerald-400">browse</span></p>
          <p className="text-[10px] text-slate-600 mt-1">PNG, SVG, JPG — multiple files supported</p>
          <input
            id="logo-upload-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { handleLogoUpload(e.target.files); e.target.value = ''; }}
          />
        </div>
        {/* Logo previews */}
        {form.logos.filter((l) => l).length > 0 && (
          <div className="flex flex-wrap gap-3">
            {form.logos.map((url, i) =>
              url ? (
                <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-white/[0.06] bg-[#0a0a0a] flex items-center justify-center">
                  <img src={url} alt="" className="max-w-full max-h-full object-contain p-1" />
                  <button
                    onClick={() => removeLogo(i)}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  );

  const renderScripts = () => (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-3">Scripts</label>
      <div className="space-y-4">
        {form.scripts.map((s, i) => (
          <div key={i} className="bg-[#0a0a0a] border border-white/[0.08] rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-3">
                <input
                  value={s.title}
                  onChange={(e) => updateScript(i, 'title', e.target.value)}
                  placeholder="Script title"
                  className="w-full bg-transparent border-b border-white/[0.06] pb-1 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
                />
                <select
                  value={s.type}
                  onChange={(e) => updateScript(i, 'type', e.target.value)}
                  className="bg-[#111] border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500/40 transition-colors"
                >
                  {SCRIPT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <button onClick={() => removeScript(i)} className="text-slate-500 hover:text-red-400 p-1 transition-colors mt-0.5" title="Remove">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              value={s.content}
              onChange={(e) => updateScript(i, 'content', e.target.value)}
              placeholder="Paste or write the script content..."
              rows={5}
              className="w-full bg-transparent border border-white/[0.06] rounded-md px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors resize-none font-mono text-xs leading-relaxed"
            />
          </div>
        ))}
      </div>
      <button onClick={addScript} className="mt-3 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
        <Plus className="w-3 h-3" /> Add script
      </button>
    </div>
  );

  const FONT_USAGES = [
    { value: 'headline', label: 'Headline' },
    { value: 'subheadline', label: 'Subheadline' },
    { value: 'body', label: 'Body' },
    { value: 'cta', label: 'CTA / Button' },
    { value: 'accent', label: 'Accent' },
    { value: 'other', label: 'Other' },
  ];

  const renderFonts = () => (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1">Brand Fonts</label>
      <p className="text-[11px] text-slate-500 mb-4">Upload your brand fonts (.ttf, .otf, .woff, .woff2) — these will be used in Statics Generation.</p>
      <div className="space-y-3">
        {form.fonts.map((f, i) => (
          <div key={i} className="bg-[#0a0a0a] border border-white/[0.08] rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-3">
                <input
                  value={f.name}
                  onChange={(e) => updateFont(i, 'name', e.target.value)}
                  placeholder="Font name (e.g. Montserrat Bold)"
                  className="w-full bg-transparent border-b border-white/[0.06] pb-1 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
                />
                <div className="flex items-center gap-3">
                  <select
                    value={f.usage}
                    onChange={(e) => updateFont(i, 'usage', e.target.value)}
                    className="bg-[#111] border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500/40 transition-colors"
                  >
                    {FONT_USAGES.map((u) => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                  {f.url ? (
                    <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                      <Shield className="w-3 h-3" /> Font uploaded
                    </span>
                  ) : (
                    <label className="text-xs text-emerald-400 hover:text-emerald-300 cursor-pointer flex items-center gap-1 transition-colors">
                      <Upload className="w-3 h-3" /> Upload font file
                      <input
                        type="file"
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => { handleFontUpload(i, e.target.files[0]); e.target.value = ''; }}
                      />
                    </label>
                  )}
                </div>
              </div>
              <button onClick={() => removeFont(i)} className="text-slate-500 hover:text-red-400 p-1 transition-colors mt-0.5" title="Remove">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {f.url && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500 truncate max-w-[200px]">{f.name || 'Unnamed font'} — {f.usage}</p>
                <button
                  onClick={() => updateFont(i, 'url', '')}
                  className="text-[10px] text-slate-500 hover:text-red-400 transition-colors"
                >
                  Remove file
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={addFont} className="mt-3 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
        <Plus className="w-3 h-3" /> Add font
      </button>
    </div>
  );

  const tabContent = {
    basic: renderBasic,
    audience: renderAudience,
    details: renderDetails,
    angles: renderAngles,
    images: renderImages,
    fonts: renderFonts,
    scripts: renderScripts,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-8">
      <div className="bg-[#151515] border border-white/[0.08] rounded-xl w-full max-w-2xl mx-4 shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Package className="w-4 h-4 text-emerald-400" />
            </div>
            <h2 className="text-base font-semibold text-white">
              {isCreating ? 'New Product' : 'Edit Product'}
            </h2>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/[0.05] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 pt-3 border-b border-white/[0.06] overflow-x-auto shrink-0">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2.5 rounded-t-md border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'text-emerald-400 border-emerald-400 bg-emerald-500/[0.05]'
                    : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-white/[0.1]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tabContent[activeTab]()}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/[0.06] shrink-0">
          <button
            onClick={onCancel}
            className="text-sm text-slate-400 hover:text-white px-4 py-2 rounded-lg hover:bg-white/[0.05] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving || !form.name.trim()}
            className="inline-flex items-center gap-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:pointer-events-none px-5 py-2 rounded-lg transition-colors"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function Assets() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingProduct, setEditingProduct] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [form, setForm] = useState({ ...emptyProduct });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  /* ---- Fetch ---- */
  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/product-profiles');
      setProducts(Array.isArray(data) ? data : data.data ?? []);
    } catch (err) {
      console.error('Failed to load products:', err);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  /* ---- Helpers to normalise form arrays ---- */
  const normaliseForm = (p) => ({
    name: p.name ?? '',
    productCode: p.productCode ?? p.product_code ?? '',
    category: p.category ?? 'supplement',
    price: p.price ?? '',
    description: p.description ?? '',
    oneLiner: p.oneLiner ?? p.one_liner ?? '',
    tagline: p.tagline ?? '',
    targetCustomer: p.targetCustomer ?? p.target_customer ?? '',
    customerFrustration: p.customerFrustration ?? p.customer_frustration ?? '',
    customerDream: p.customerDream ?? p.customer_dream ?? '',
    targetDemographics: p.targetDemographics ?? p.target_demographics ?? '',
    voiceTone: p.voiceTone ?? p.voice_tone ?? '',
    bigPromise: p.bigPromise ?? p.big_promise ?? '',
    uniqueMechanism: p.uniqueMechanism ?? p.unique_mechanism ?? '',
    differentiator: p.differentiator ?? '',
    guarantee: p.guarantee ?? '',
    benefits: Array.isArray(p.benefits) && p.benefits.length ? [...p.benefits] : [''],
    angles: Array.isArray(p.angles) && p.angles.length ? p.angles.map((a) => ({ name: a.name ?? '', description: a.description ?? '' })) : [{ name: '', description: '' }],
    images: Array.isArray(p.images) && p.images.length ? p.images.filter((img) => img) : [],
    logos: Array.isArray(p.logos) && p.logos.length ? [...p.logos] : (p.logoUrl || p.logo_url ? [p.logoUrl ?? p.logo_url] : []),
    fonts: Array.isArray(p.fonts) && p.fonts.length ? p.fonts.map((f) => ({ name: f.name ?? '', url: f.url ?? '', usage: f.usage ?? 'headline' })) : [{ name: '', url: '', usage: 'headline' }],
    scripts: Array.isArray(p.scripts) && p.scripts.length ? p.scripts.map((s) => ({ title: s.title ?? '', type: s.type ?? 'vsl', content: s.content ?? '' })) : [{ title: '', type: 'vsl', content: '' }],
  });

  /* ---- CRUD actions ---- */
  const openCreate = () => {
    setForm({ ...emptyProduct, benefits: [''], angles: [{ name: '', description: '' }], images: [], logos: [], fonts: [{ name: '', url: '', usage: 'headline' }], scripts: [{ title: '', type: 'vsl', content: '' }] });
    setEditingProduct(null);
    setIsCreating(true);
    setActiveTab('basic');
  };

  const openEdit = (product) => {
    setForm(normaliseForm(product));
    setEditingProduct(product);
    setIsCreating(false);
    setActiveTab('basic');
  };

  const closeEditor = () => {
    setEditingProduct(null);
    setIsCreating(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    try {
      setSaving(true);
      const payload = {
        ...form,
        benefits: form.benefits.filter((b) => b.trim()),
        angles: form.angles.filter((a) => a.name.trim() || a.description.trim()),
        images: form.images.filter((u) => u),
        logos: form.logos.filter((u) => u),
        fonts: form.fonts.filter((f) => f.name.trim() || f.url),
        scripts: form.scripts.filter((s) => s.title.trim() || s.content.trim()),
      };

      if (editingProduct) {
        await api.put(`/product-profiles/${editingProduct.id ?? editingProduct._id}`, payload);
      } else {
        await api.post('/product-profiles', payload);
      }

      await fetchProducts();
      closeEditor();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/product-profiles/${deleteTarget.id ?? deleteTarget._id}`);
      await fetchProducts();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleteTarget(null);
    }
  };

  /* ---- Render ---- */
  const showEditor = isCreating || editingProduct;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <Package className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">Product Library</h1>
            <p className="text-sm text-slate-400 mt-0.5">Central hub for all your product data</p>
          </div>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Product
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : products.length === 0 ? (
        <EmptyState onCreate={openCreate} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {products.map((p) => (
            <ProductCard
              key={p.id ?? p._id}
              product={p}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {/* Editor Modal */}
      {showEditor && (
        <EditorModal
          isCreating={!editingProduct}
          form={form}
          setForm={setForm}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          saving={saving}
          onSave={handleSave}
          onCancel={closeEditor}
        />
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <DeleteDialog
          product={deleteTarget}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
