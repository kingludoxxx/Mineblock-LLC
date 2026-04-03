import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Package, Plus, Pencil, Trash2, X, Image,
  Target, ChevronRight, ChevronDown, Loader2,
  Sparkles, Upload, ArrowLeft, Link, Globe, Zap,
  AlertTriangle, MessageSquare, Tag, Check, Star,
} from 'lucide-react';
import api from '../../services/api';

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

/* ------------------------------------------------------------------ */
/*  Collapsible Section                                               */
/* ------------------------------------------------------------------ */

function CollapsibleSection({ icon: Icon, title, subtitle, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left cursor-pointer hover:bg-white/[0.02] transition-colors"
      >
        <div className="w-9 h-9 rounded-lg bg-white/[0.04] flex items-center justify-center shrink-0">
          <Icon className="w-[18px] h-[18px] text-slate-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        {open ? (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-500" />
        )}
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-4 border-t border-white/[0.06]">
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Auto-Save Field                                                   */
/* ------------------------------------------------------------------ */

function AutoSaveField({ label, value, onChange, onSave, placeholder, rows }) {
  // Fully local state — only syncs to parent + API on blur
  const [local, setLocal] = useState(value || '');
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);

  // Sync from parent when value changes externally (e.g. AI fill, page load)
  useEffect(() => {
    setLocal(value || '');
    dirtyRef.current = false;
  }, [value]);

  const handleChange = (v) => {
    setLocal(v);
    onChange?.(v);
    dirtyRef.current = true;
    setSaved(false);
  };

  const handleBlur = () => {
    if (!dirtyRef.current) return; // skip save if nothing changed
    dirtyRef.current = false;
    onSave(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const isTextarea = rows && rows > 1;
  const Component = isTextarea ? 'textarea' : 'input';

  return (
    <div>
      {label && (
        <div className="flex items-center justify-between mb-2">
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
            {label}
          </label>
          {saved && (
            <span className="text-[10px] text-emerald-400 animate-pulse">Saved</span>
          )}
        </div>
      )}
      <Component
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        className="w-full bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-white/[0.15] transition-colors resize-none leading-relaxed"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quick Info Bar                                                     */
/* ------------------------------------------------------------------ */

function QuickInfoBar({ product, onSave, onChange }) {
  const boxes = [
    { key: 'short_name', label: 'Short Name', placeholder: 'e.g. EstroGuard+' },
    { key: 'product_type', label: 'Type', placeholder: 'e.g. Capsules' },
    { key: 'product_group', label: 'Group', placeholder: 'e.g. Supplements' },
    { key: 'unit_details', label: 'Unit Details', placeholder: 'e.g. 1 Jar / 24 Capsules' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {boxes.map((box) => (
        <QuickInfoBox key={box.key} box={box} initialValue={product[box.key] || ''} onSave={onSave} onChange={onChange} />
      ))}
    </div>
  );
}

function QuickInfoBox({ box, initialValue, onSave, onChange }) {
  const [val, setVal] = useState(initialValue);
  const latestRef = useRef(initialValue);
  const dirtyRef = useRef(false);

  useEffect(() => {
    setVal(initialValue);
    latestRef.current = initialValue;
    dirtyRef.current = false;
  }, [initialValue]);

  return (
    <div className="bg-[#111] border border-white/[0.06] rounded-lg px-4 py-3">
      <label className="block text-[11px] text-slate-500 uppercase tracking-wider font-semibold mb-1.5">
        {box.label}
      </label>
      <input
        value={val}
        onChange={(e) => {
          setVal(e.target.value);
          latestRef.current = e.target.value;
          dirtyRef.current = true;
          onChange?.(box.key, e.target.value);
        }}
        onBlur={() => {
          if (dirtyRef.current) {
            onSave(box.key, latestRef.current);
            dirtyRef.current = false;
          }
        }}
        placeholder={box.placeholder}
        className="w-full bg-transparent text-sm text-white font-medium placeholder-slate-600 focus:outline-none"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Product Card (List View)                                          */
/* ------------------------------------------------------------------ */

function ProductCard({ product, onClick, onDelete }) {
  const images = Array.isArray(product.product_images) ? product.product_images : [];
  const validImages = images.filter((v) => v);
  // List endpoint returns first_image instead of full product_images array (for performance)
  const firstImg = validImages[0] || (product.first_image ? (typeof product.first_image === 'string' ? product.first_image.replace(/^"|"$/g, '') : product.first_image) : null);
  const imgCount = validImages.length;

  return (
    <div
      onClick={onClick}
      className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden flex flex-col justify-between hover:border-white/[0.12] transition-colors group cursor-pointer"
    >
      {/* Hero image */}
      {firstImg ? (
        <div className="relative overflow-hidden bg-[#0a0a0a]" style={{ height: 140 }}>
          <img src={firstImg} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.parentElement.style.display = 'none'; }} />
          {imgCount > 1 && (
            <span className="absolute bottom-2 right-2 bg-black/60 text-white/80 text-[10px] font-medium px-1.5 py-0.5 rounded backdrop-blur-sm">
              +{imgCount - 1}
            </span>
          )}
        </div>
      ) : (
        <div className="h-20 bg-[#0a0a0a] flex items-center justify-center">
          <Image className="w-7 h-7 text-white/10" />
        </div>
      )}

      <div className="p-5 flex flex-col gap-3 flex-1">
        <div>
          <div className="flex items-start justify-between mb-1">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-white truncate">{product.name}</h3>
            </div>
            {product.price && (
              <span className="text-sm font-semibold text-emerald-400 ml-3 shrink-0">
                {product.price}
              </span>
            )}
          </div>

          {(product.oneliner || product.description) && (
            <p className="text-sm text-slate-400 line-clamp-2 leading-relaxed">
              {product.oneliner || product.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          {imgCount > 0 && (
            <span className="flex items-center gap-1">
              <Image className="w-3 h-3" />
              {imgCount} image{imgCount !== 1 && 's'}
            </span>
          )}
          {product.big_promise && (
            <span className="flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> Promise set
            </span>
          )}
          {product.customer_avatar && (
            <span className="flex items-center gap-1">
              <Target className="w-3 h-3" /> Avatar set
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06]">
          <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2.5 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(product); }}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 px-2.5 py-1.5 rounded-md hover:bg-red-500/[0.05] transition-colors"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </div>
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
      <p className="text-sm text-slate-400 mb-6 max-w-xs">
        Add your first product to get started. All production tools pull from these profiles.
      </p>
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
          Are you sure you want to delete{' '}
          <span className="text-white font-medium">{product.name}</span>?
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
/*  Product Detail View                                               */
/* ------------------------------------------------------------------ */

function ProductDetailView({ product, onBack, onFieldSave, onAiFill, onProductChange, onDelete }) {
  const [aiUrl, setAiUrl] = useState(product.product_url || '');
  const [aiFilling, setAiFilling] = useState(false);
  const [imageUrlInput, setImageUrlInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [benefitInput, setBenefitInput] = useState('');
  const fileInputRef = useRef(null);
  // Use ref to get latest product for image operations (avoids stale closure)
  const productRef = useRef(product);
  productRef.current = product;

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await onFieldSave('__all__', productRef.current);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      alert(`Save failed: ${err?.response?.data?.error?.message || err?.message || 'Unknown error'}. Please try again.`);
    } finally {
      setSaving(false);
    }
  };

  const handleAiFillClick = async () => {
    if (!aiUrl.trim()) return;
    setAiFilling(true);
    try {
      await onAiFill(aiUrl);
    } finally {
      setAiFilling(false);
    }
  };

  const updateField = (key, value) => {
    onProductChange({ ...productRef.current, [key]: value });
  };

  // Save with latest value passed directly (fixes stale-state bug)
  const saveFieldDirect = (key, latestValue) => {
    onFieldSave(key, latestValue);
  };

  /* Compress an image file to JPEG at max 1200px, quality 0.82 — keeps files small enough to persist reliably */
  const compressImage = (file) =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new window.Image();
        img.onload = () => {
          const MAX = 1200;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            if (width > height) { height = Math.round((height * MAX) / width); width = MAX; }
            else { width = Math.round((width * MAX) / height); height = MAX; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });

  /* Image handlers — use productRef to avoid stale closure */
  const handleImageUpload = async (files) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    // Compress all images first, then batch update
    const results = await Promise.all(imageFiles.map(compressImage));

    const current = Array.isArray(productRef.current.product_images) ? productRef.current.product_images : [];
    const updated = [...current.filter((img) => img), ...results];
    onProductChange({ ...productRef.current, product_images: updated });
    try {
      await onFieldSave('product_images', updated);
    } catch (err) {
      alert(`Failed to save images: ${err?.response?.data?.error?.message || err?.message || 'Unknown error'}. Try fewer images at once.`);
    }
  };

  const addImageUrl = () => {
    if (!imageUrlInput.trim()) return;
    const current = Array.isArray(productRef.current.product_images) ? productRef.current.product_images : [];
    const updated = [...current.filter((img) => img), imageUrlInput.trim()];
    onProductChange({ ...productRef.current, product_images: updated });
    onFieldSave('product_images', updated);
    setImageUrlInput('');
  };

  const removeImage = (i) => {
    const current = Array.isArray(productRef.current.product_images) ? productRef.current.product_images : [];
    const updated = current.filter((_, idx) => idx !== i);
    onProductChange({ ...productRef.current, product_images: updated });
    onFieldSave('product_images', updated);
  };

  const firstImage = (Array.isArray(product.product_images) ? product.product_images : []).find(
    (img) => img
  );

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors shrink-0 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-slate-400" />
        </button>
        {firstImage && (
          <div className="w-10 h-10 rounded-lg overflow-hidden border border-white/[0.06] bg-[#0a0a0a] shrink-0">
            <img src={firstImage} alt="" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <AutoSaveField
            value={product.name}
            onChange={(v) => updateField('name', v)}
            onSave={(v) => saveFieldDirect('name', v)}
            placeholder="Product name..."
          />
        </div>
        <button
          onClick={handleSaveAll}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-colors cursor-pointer disabled:opacity-50 disabled:pointer-events-none text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/[0.08]"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : savedFlash ? <Check className="w-3.5 h-3.5" /> : null}
          {saving ? 'Saving...' : savedFlash ? 'Saved!' : 'Save'}
        </button>
        <button
          onClick={() => onDelete(product)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 px-3 py-2 rounded-lg hover:bg-red-500/[0.05] border border-white/[0.06] transition-colors cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </button>
      </div>

      {/* AI Auto-fill Card */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-[18px] h-[18px] text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Auto-fill with AI</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Paste the product URL &mdash; Claude scrapes the page and fills every field automatically
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Link className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              value={aiUrl}
              onChange={(e) => setAiUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAiFillClick()}
              placeholder="https://example.com/product-page"
              className="w-full bg-[#0a0a0a] border border-white/[0.06] rounded-lg pl-10 pr-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-white/[0.15] transition-colors"
            />
          </div>
          <button
            onClick={handleAiFillClick}
            disabled={aiFilling || !aiUrl.trim()}
            className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:pointer-events-none text-white text-sm font-medium px-5 py-3 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {aiFilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {aiFilling ? 'Filling...' : 'Fill with AI'}
          </button>
        </div>
      </div>

      {/* Quick Info Bar */}
      <QuickInfoBar
        product={product}
        onSave={(key, val) => saveFieldDirect(key, val)}
        onChange={(key, val) => updateField(key, val)}
      />

      {/* Sections */}
      <div className="space-y-3">
        {/* AI Brand Intelligence */}
        <CollapsibleSection
          icon={Globe}
          title="AI Brand Intelligence"
          subtitle="Everything the AI needs to generate perfect static ads, scripts, and copy"
          defaultOpen
        >
          <AutoSaveField
            label="Product Description & Mechanism"
            value={product.description}
            onChange={(v) => updateField('description', v)}
            onSave={(v) => saveFieldDirect('description', v)}
            placeholder="Describe the product, how it works, and what makes it effective..."
            rows={6}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AutoSaveField
              label="Big Promise / Core Transformation"
              value={product.big_promise}
              onChange={(v) => updateField('big_promise', v)}
              onSave={(v) => saveFieldDirect('big_promise', v)}
              placeholder="The #1 result your product delivers"
              rows={3}
            />
            <AutoSaveField
              label="Unique Mechanism / Differentiator"
              value={product.mechanism}
              onChange={(v) => updateField('mechanism', v)}
              onSave={(v) => saveFieldDirect('mechanism', v)}
              placeholder="How does it work? What's the unique approach?"
              rows={3}
            />
          </div>
        </CollapsibleSection>

        {/* Key Benefits */}
        <CollapsibleSection
          icon={Star}
          title="Key Benefits"
          subtitle="Product benefits the AI weaves into hooks, body copy, and CTAs"
        >
          <div className="space-y-2">
            {(Array.isArray(product.benefits) ? product.benefits : []).map((b, i) => (
              <div key={i} className="flex items-center gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-3 py-2.5">
                <Star className="w-3.5 h-3.5 text-amber-400/60 shrink-0" />
                <span className="flex-1 text-sm text-slate-200">{typeof b === 'object' ? (b.text || b.name || JSON.stringify(b)) : b}</span>
                <button
                  onClick={() => {
                    const updated = (product.benefits || []).filter((_, idx) => idx !== i);
                    onProductChange({ ...product, benefits: updated });
                    onFieldSave('benefits', updated);
                  }}
                  className="w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-red-400 transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                value={benefitInput}
                onChange={(e) => setBenefitInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && benefitInput.trim()) {
                    const updated = [...(product.benefits || []), benefitInput.trim()];
                    onProductChange({ ...product, benefits: updated });
                    onFieldSave('benefits', updated);
                    setBenefitInput('');
                  }
                }}
                placeholder="Add a benefit... (press Enter)"
                className="flex-1 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-white/[0.15] transition-colors"
              />
              <button
                onClick={() => {
                  if (!benefitInput.trim()) return;
                  const updated = [...(product.benefits || []), benefitInput.trim()];
                  onProductChange({ ...product, benefits: updated });
                  onFieldSave('benefits', updated);
                  setBenefitInput('');
                }}
                disabled={!benefitInput.trim()}
                className="text-xs text-emerald-400 hover:text-emerald-300 disabled:text-slate-600 disabled:cursor-not-allowed px-4 py-3 rounded-lg border border-white/[0.06] hover:border-emerald-500/30 transition-colors cursor-pointer"
              >
                Add
              </button>
            </div>
          </div>
        </CollapsibleSection>

        {/* Target Audience & Avatar */}
        <CollapsibleSection
          icon={Target}
          title="Target Audience & Avatar"
          subtitle="Who we're speaking to — shapes tone, angles, and hooks"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AutoSaveField
              label="Primary Customer Avatar"
              value={product.customer_avatar}
              onChange={(v) => updateField('customer_avatar', v)}
              onSave={(v) => saveFieldDirect('customer_avatar', v)}
              placeholder="Who is this for? Age, gender, lifestyle, mindset..."
              rows={4}
            />
            <AutoSaveField
              label="Pain Points & Emotional Triggers"
              value={product.pain_points}
              onChange={(v) => updateField('pain_points', v)}
              onSave={(v) => saveFieldDirect('pain_points', v)}
              placeholder="What keeps them up at night? What are they frustrated by?"
              rows={4}
            />
          </div>
          <AutoSaveField
            label="Common Objections & How to Handle Them"
            value={product.common_objections}
            onChange={(v) => updateField('common_objections', v)}
            onSave={(v) => saveFieldDirect('common_objections', v)}
            placeholder="List the top objections and how your product or copy addresses each..."
            rows={4}
          />
          <AutoSaveField
            label="Target Demographics"
            value={product.target_demographics}
            onChange={(v) => updateField('target_demographics', v)}
            onSave={(v) => saveFieldDirect('target_demographics', v)}
            placeholder="e.g. Men 25-45, USA/UK, middle income, health-conscious, active on social media..."
            rows={3}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AutoSaveField
              label="Customer Frustration"
              value={product.customer_frustration}
              onChange={(v) => updateField('customer_frustration', v)}
              onSave={(v) => saveFieldDirect('customer_frustration', v)}
              placeholder="What have they tried that didn't work? Why are they fed up?"
              rows={3}
            />
            <AutoSaveField
              label="Customer Dream Outcome"
              value={product.customer_dream}
              onChange={(v) => updateField('customer_dream', v)}
              onSave={(v) => saveFieldDirect('customer_dream', v)}
              placeholder="What does their ideal result look like? How do they feel after?"
              rows={3}
            />
          </div>
        </CollapsibleSection>

        {/* Brand Voice & Copy Style */}
        <CollapsibleSection
          icon={MessageSquare}
          title="Brand Voice & Copy Style"
          subtitle="Tone, style, and personality the AI should write in"
        >
          <AutoSaveField
            label="Brand Voice & Tone"
            value={product.voice}
            onChange={(v) => updateField('voice', v)}
            onSave={(v) => saveFieldDirect('voice', v)}
            placeholder="e.g. Direct, authoritative, slightly edgy. Speaks like a knowledgeable friend..."
            rows={4}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AutoSaveField
              label="Winning Angles (What's Working Right Now)"
              value={product.winning_angles}
              onChange={(v) => updateField('winning_angles', v)}
              onSave={(v) => saveFieldDirect('winning_angles', v)}
              placeholder="List proven angles, hooks, and themes that convert..."
              rows={4}
            />
            <AutoSaveField
              label="Custom Angles to Test"
              value={product.custom_angles_text}
              onChange={(v) => updateField('custom_angles_text', v)}
              onSave={(v) => saveFieldDirect('custom_angles_text', v)}
              placeholder="New angles you want the AI to try..."
              rows={4}
            />
          </div>
        </CollapsibleSection>

        {/* Competitive Edge & Offer */}
        <CollapsibleSection
          icon={Zap}
          title="Competitive Edge & Offer"
          subtitle="What makes us better and why buy now"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AutoSaveField
              label="Competitive Edge"
              value={product.competitive_edge}
              onChange={(v) => updateField('competitive_edge', v)}
              onSave={(v) => saveFieldDirect('competitive_edge', v)}
              placeholder="Why choose this over competitors? What do they miss?"
              rows={4}
            />
            <AutoSaveField
              label="Guarantee / Risk Reversal"
              value={product.guarantee}
              onChange={(v) => updateField('guarantee', v)}
              onSave={(v) => saveFieldDirect('guarantee', v)}
              placeholder="e.g. 60-day money-back guarantee, no questions asked"
              rows={4}
            />
          </div>
        </CollapsibleSection>

        {/* Offers & Promotions */}
        <CollapsibleSection
          icon={Tag}
          title="Offers & Promotions"
          subtitle="Discounts, codes, bundles — what the AI can reference in ads"
        >
          <AutoSaveField
            label="Max Discount Allowed in Ads"
            value={product.max_discount}
            onChange={(v) => updateField('max_discount', v)}
            onSave={(v) => saveFieldDirect('max_discount', v)}
            placeholder="e.g. Up to 40% off — never exceed this in any generated copy"
          />
          <AutoSaveField
            label="Active Discount Codes"
            value={product.discount_codes}
            onChange={(v) => updateField('discount_codes', v)}
            onSave={(v) => saveFieldDirect('discount_codes', v)}
            placeholder="e.g. SAVE20 = 20% off first order, BUNDLE30 = 30% off 3+ bottles, FLASH50 = 50% off (flash sale only)"
            rows={3}
          />
          <AutoSaveField
            label="Bundle Variants & Pricing"
            value={product.bundle_variants}
            onChange={(v) => updateField('bundle_variants', v)}
            onSave={(v) => saveFieldDirect('bundle_variants', v)}
            placeholder="e.g. 1 bottle = $49, 3 bottles = $117 (save $30), 6 bottles = $198 (save $96 + free shipping)"
            rows={3}
          />
          <AutoSaveField
            label="Offer Rules & Notes"
            value={product.offer_details}
            onChange={(v) => updateField('offer_details', v)}
            onSave={(v) => saveFieldDirect('offer_details', v)}
            placeholder="Any rules for the AI — e.g. always push 3-bottle bundle as best value, never mention free shipping on single bottles..."
            rows={3}
          />
        </CollapsibleSection>

        {/* Compliance & Restrictions */}
        <CollapsibleSection
          icon={AlertTriangle}
          title="Compliance & Restrictions"
          subtitle="What the AI must NEVER claim or say"
        >
          <AutoSaveField
            label="Compliance Restrictions"
            value={product.compliance_restrictions}
            onChange={(v) => updateField('compliance_restrictions', v)}
            onSave={(v) => saveFieldDirect('compliance_restrictions', v)}
            placeholder="List any claims, words, or phrases that are off-limits. Include regulatory notes..."
            rows={4}
          />
        </CollapsibleSection>

        {/* Product Gallery */}
        <CollapsibleSection
          icon={Image}
          title="Product Gallery"
          subtitle="Product images, logos, and visual assets"
        >
          {/* Upload zone */}
          <div
            className="border-2 border-dashed border-white/[0.08] rounded-lg p-6 text-center hover:border-emerald-500/30 transition-colors cursor-pointer"
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-emerald-500/40'); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove('border-emerald-500/40'); }}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-emerald-500/40'); handleImageUpload(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
            <p className="text-xs text-slate-400">
              Drop product images here or <span className="text-emerald-400">browse</span>
            </p>
            <p className="text-[10px] text-slate-600 mt-1">PNG, JPG, WebP — multiple files supported</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { handleImageUpload(e.target.files); e.target.value = ''; }}
            />
          </div>

          {/* URL paste */}
          <div className="flex items-center gap-2">
            <input
              value={imageUrlInput}
              onChange={(e) => setImageUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addImageUrl()}
              placeholder="Or paste image URL..."
              className="flex-1 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-white/[0.15] transition-colors"
            />
            <button
              onClick={addImageUrl}
              disabled={!imageUrlInput.trim()}
              className="text-xs text-emerald-400 hover:text-emerald-300 disabled:text-slate-600 disabled:cursor-not-allowed px-4 py-3 rounded-lg border border-white/[0.06] hover:border-emerald-500/30 transition-colors cursor-pointer"
            >
              Add
            </button>
          </div>

          {/* Image grid */}
          {(Array.isArray(product.product_images) ? product.product_images : []).filter((img) => img).length > 0 && (
            <div className="flex flex-wrap gap-3">
              {(product.product_images || []).map((url, i) =>
                url ? (
                  <div key={i} className="relative group w-24 h-24 rounded-lg overflow-hidden border border-white/[0.06] bg-[#0a0a0a]">
                    <img src={url} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : null
              )}
            </div>
          )}
        </CollapsibleSection>
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
  const [viewMode, setViewMode] = useState('list');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [creating, setCreating] = useState(false);

  // Normalize a product so JSONB fields are always arrays/objects, never strings
  const normalizeProduct = (p) => {
    if (!p) return p;
    const jsonbFields = ['product_images', 'logos', 'fonts', 'benefits', 'angles', 'scripts', 'offers'];
    const out = { ...p };
    for (const f of jsonbFields) {
      if (typeof out[f] === 'string') {
        try { out[f] = JSON.parse(out[f]); } catch { out[f] = []; }
      }
    }
    return out;
  };

  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/product-profiles');
      const list = (Array.isArray(data) ? data : data.data ?? []).map(normalizeProduct);
      setProducts(list);
      return list;
    } catch (err) {
      console.error('Failed to load products:', err);
      setProducts([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const openDetail = async (product) => {
    // Show cached data immediately, then refresh from DB in background
    setSelectedProduct(normalizeProduct({ ...product }));
    setViewMode('detail');
    try {
      const { data } = await api.get(`/product-profiles/${product.id}`);
      const fresh = normalizeProduct(data?.data || data);
      if (fresh?.id) setSelectedProduct(fresh);
    } catch {
      // keep cached data if fetch fails
    }
  };

  const goBackToList = () => {
    setViewMode('list');
    setSelectedProduct(null);
  };

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const resp = await api.post('/product-profiles', { name: 'Untitled Product' });
      const created = resp.data?.data || resp.data;
      openDetail(created);
    } catch (err) {
      console.error('Create failed:', err);
    } finally {
      setCreating(false);
    }
  };

  // Save field — value passed directly from AutoSaveField's ref (never stale)
  // Pass key='__all__' and value=fullProductObject to save everything at once
  const handleFieldSave = async (key, value) => {
    if (!selectedProduct?.id) return;
    const payload = key === '__all__' ? value : { [key]: value };
    const { data } = await api.put(`/product-profiles/${selectedProduct.id}`, payload);
    const updated = normalizeProduct(data?.data || data);
    if (updated?.id) {
      setSelectedProduct(prev => ({ ...prev, ...updated }));
      setProducts(prev => prev.map(p => p.id === selectedProduct.id ? { ...p, ...updated } : p));
    }
  };

  const handleAiFill = async (url) => {
    if (!selectedProduct?.id) return;
    try {
      const resp = await api.post(`/product-profiles/${selectedProduct.id}/ai-fill`, { url });
      const updated = resp.data?.data || resp.data;
      setSelectedProduct(prev => ({ ...prev, ...updated }));
    } catch (err) {
      console.error('AI fill failed:', err);
      alert(`AI fill failed: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/product-profiles/${deleteTarget.id ?? deleteTarget._id}`);
      if (viewMode === 'detail' && selectedProduct?.id === deleteTarget.id) {
        goBackToList();
      }
      await fetchProducts();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleteTarget(null);
    }
  };

  if (viewMode === 'detail' && selectedProduct) {
    return (
      <div>
        <ProductDetailView
          product={selectedProduct}
          onBack={goBackToList}
          onFieldSave={handleFieldSave}
          onAiFill={handleAiFill}
          onProductChange={(updated) => setSelectedProduct(updated)}
          onDelete={(p) => setDeleteTarget(p)}
        />
        {deleteTarget && (
          <DeleteDialog product={deleteTarget} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
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
          onClick={handleCreate}
          disabled={creating}
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors cursor-pointer"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add Product
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : products.length === 0 ? (
        <EmptyState onCreate={handleCreate} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {products.map((p) => (
            <ProductCard
              key={p.id ?? p._id}
              product={p}
              onClick={() => openDetail(p)}
              onDelete={(prod) => setDeleteTarget(prod)}
            />
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteDialog product={deleteTarget} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}
