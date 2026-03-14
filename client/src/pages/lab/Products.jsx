import { useState } from 'react';
import { Plus, Edit2, Trash2, X, Package, Tag } from 'lucide-react';

const INITIAL = [
  {
    id: 1,
    name: 'FitPro Max',
    description: 'Premium all-in-one fitness supplement designed for busy professionals who want maximum results with minimal effort.',
    category: 'Supplement',
    price: '$69.99',
    features: ['30-day supply', 'All-natural ingredients', 'Clinically tested formula', 'No artificial sweeteners'],
  },
  {
    id: 2,
    name: 'ScaleOS Platform',
    description: 'All-in-one SaaS for scaling e-commerce brands from $1M to $10M ARR with AI-driven insights.',
    category: 'SaaS',
    price: '$299/mo',
    features: ['Real-time analytics dashboard', 'AI ad optimization', 'Inventory forecasting', 'Multi-channel sync'],
  },
];

const emptyForm = { name: '', description: '', category: '', price: '', features: [''] };

export default function Products() {
  const [items, setItems] = useState(INITIAL);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const openCreate = () => { setForm({ ...emptyForm, features: [''] }); setEditId(null); setModal('create'); };
  const openEdit = (item) => { setForm({ ...item, features: [...item.features] }); setEditId(item.id); setModal('edit'); };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const cleaned = { ...form, features: form.features.filter((f) => f.trim()) };
    if (modal === 'create') setItems([...items, { ...cleaned, id: Date.now() }]);
    else setItems(items.map((i) => (i.id === editId ? { ...cleaned, id: editId } : i)));
    setModal(null);
  };

  const handleDelete = (id) => { setItems(items.filter((i) => i.id !== id)); setDeleteConfirm(null); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Product Catalog</h1>
          <p className="text-sm text-slate-400 mt-1">Manage your products and their details for use in copy generation</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 transition-colors cursor-pointer">
          <Plus className="w-4 h-4" /> Create New
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {items.map((item) => (
          <div key={item.id} className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/20"><Package className="w-5 h-5 text-orange-400" /></div>
                <div>
                  <h3 className="font-semibold text-white">{item.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/[0.06] text-slate-400 flex items-center gap-1"><Tag className="w-3 h-3" />{item.category}</span>
                    <span className="text-xs font-mono text-emerald-400">{item.price}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(item)} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => setDeleteConfirm(item.id)} className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-white/[0.06] cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <p className="text-sm text-slate-400 mb-4 leading-relaxed">{item.description}</p>
            <div>
              <h4 className="text-xs font-medium text-orange-400 mb-1.5">Features</h4>
              <ul className="space-y-1">
                {item.features.map((f, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5"><span className="text-orange-400/60 mt-0.5">-</span> {f}</li>
                ))}
              </ul>
            </div>
            {deleteConfirm === item.id && (
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-red-400">Delete this product?</span>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
                  <button onClick={() => handleDelete(item.id)} className="px-2 py-1 text-xs bg-red-600 text-white rounded cursor-pointer">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-white/[0.06] rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 mx-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">{modal === 'create' ? 'Create Product' : 'Edit Product'}</h2>
              <button onClick={() => setModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              {[
                { key: 'name', label: 'Product Name', placeholder: 'e.g. FitPro Max' },
                { key: 'category', label: 'Category', placeholder: 'e.g. Supplement, SaaS, Course' },
                { key: 'price', label: 'Price', placeholder: 'e.g. $69.99' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-xs text-slate-400 mb-1 block">{label}</label>
                  <input type="text" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder} className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                </div>
              ))}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Describe the product..." rows={3}
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Features</label>
                {form.features.map((f, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input type="text" value={f} onChange={(e) => { const l = [...form.features]; l[i] = e.target.value; setForm({ ...form, features: l }); }}
                      placeholder="Feature..." className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    <button onClick={() => { const l = form.features.filter((_, idx) => idx !== i); setForm({ ...form, features: l.length ? l : [''] }); }} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button onClick={() => setForm({ ...form, features: [...form.features, ''] })} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add feature</button>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/[0.06]">
              <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white cursor-pointer">Cancel</button>
              <button onClick={handleSave} disabled={!form.name.trim()} className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                {modal === 'create' ? 'Create' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
