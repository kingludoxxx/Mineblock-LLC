import { useState } from 'react';
import { Plus, Edit2, Trash2, X, Gift, DollarSign, Shield, Clock } from 'lucide-react';

const INITIAL = [
  {
    id: 1,
    name: 'Founder\'s Launch Bundle',
    price: '$497',
    bonuses: ['Private community access ($297 value)', '1-on-1 strategy call ($500 value)', 'Template vault ($197 value)'],
    guarantee: '60-day money-back guarantee, no questions asked',
    urgency: 'Only 100 spots available at this price. Timer resets at midnight.',
  },
  {
    id: 2,
    name: 'Enterprise Growth Package',
    price: '$2,997/mo',
    bonuses: ['Dedicated account manager', 'Custom integration setup', 'Priority support SLA'],
    guarantee: '30-day free trial, cancel anytime',
    urgency: 'Q1 pricing ends March 31st.',
  },
];

const emptyForm = { name: '', price: '', bonuses: [''], guarantee: '', urgency: '' };

export default function Offers() {
  const [items, setItems] = useState(INITIAL);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const openCreate = () => { setForm({ ...emptyForm, bonuses: [''] }); setEditId(null); setModal('create'); };
  const openEdit = (item) => { setForm({ ...item, bonuses: [...item.bonuses] }); setEditId(item.id); setModal('edit'); };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const cleaned = { ...form, bonuses: form.bonuses.filter((b) => b.trim()) };
    if (modal === 'create') setItems([...items, { ...cleaned, id: Date.now() }]);
    else setItems(items.map((i) => (i.id === editId ? { ...cleaned, id: editId } : i)));
    setModal(null);
  };

  const handleDelete = (id) => { setItems(items.filter((i) => i.id !== id)); setDeleteConfirm(null); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Offer Templates</h1>
          <p className="text-sm text-slate-400 mt-1">Build irresistible offers with bonuses, guarantees, and urgency</p>
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
                <div className="p-2 rounded-lg bg-emerald-500/20"><Gift className="w-5 h-5 text-emerald-400" /></div>
                <div>
                  <h3 className="font-semibold text-white">{item.name}</h3>
                  <span className="text-sm font-mono text-emerald-400">{item.price}</span>
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(item)} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => setDeleteConfirm(item.id)} className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-white/[0.06] cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="mb-3">
              <h4 className="text-xs font-medium text-yellow-400 mb-1.5 flex items-center gap-1"><Gift className="w-3 h-3" /> Bonuses</h4>
              <ul className="space-y-1">
                {item.bonuses.map((b, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5"><span className="text-yellow-400/60 mt-0.5">+</span> {b}</li>
                ))}
              </ul>
            </div>
            <div className="mb-3 flex items-start gap-2">
              <Shield className="w-3.5 h-3.5 text-accent-text mt-0.5 shrink-0" />
              <p className="text-xs text-slate-400">{item.guarantee}</p>
            </div>
            <div className="flex items-start gap-2">
              <Clock className="w-3.5 h-3.5 text-orange-400 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-400">{item.urgency}</p>
            </div>
            {deleteConfirm === item.id && (
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-red-400">Delete this offer?</span>
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
              <h2 className="text-lg font-bold text-white">{modal === 'create' ? 'Create Offer' : 'Edit Offer'}</h2>
              <button onClick={() => setModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Offer Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Founder's Launch Bundle" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Price</label>
                <input type="text" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="e.g. $497" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Bonuses</label>
                {form.bonuses.map((b, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input type="text" value={b} onChange={(e) => { const l = [...form.bonuses]; l[i] = e.target.value; setForm({ ...form, bonuses: l }); }}
                      placeholder="Bonus..." className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    <button onClick={() => { const l = form.bonuses.filter((_, idx) => idx !== i); setForm({ ...form, bonuses: l.length ? l : [''] }); }} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button onClick={() => setForm({ ...form, bonuses: [...form.bonuses, ''] })} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add bonus</button>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Guarantee</label>
                <input type="text" value={form.guarantee} onChange={(e) => setForm({ ...form, guarantee: e.target.value })}
                  placeholder="e.g. 60-day money-back guarantee" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Urgency Element</label>
                <input type="text" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}
                  placeholder="e.g. Only 100 spots available" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
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
