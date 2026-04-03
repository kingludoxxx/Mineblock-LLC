import { useState } from 'react';
import { Plus, Edit2, Trash2, X, Cog } from 'lucide-react';

const INITIAL = [
  {
    id: 1,
    name: 'Neuro-Sync Optimization',
    description: 'A proprietary neural pathway recalibration technique that retrains the brain\'s reward system to eliminate cravings at the source.',
    proofPoints: ['Published in Journal of Behavioral Science', '87% success rate in clinical trials', 'Endorsed by Dr. Sarah Mitchell'],
  },
  {
    id: 2,
    name: 'Compound Revenue Engine',
    description: 'A 3-layer automated marketing system that compounds leads through self-reinforcing referral loops.',
    proofPoints: ['Used by 200+ 7-figure brands', 'Average 340% ROI in 90 days', 'Patent-pending algorithm'],
  },
];

const emptyForm = { name: '', description: '', proofPoints: [''] };

export default function Mechanisms() {
  const [items, setItems] = useState(INITIAL);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const openCreate = () => { setForm({ ...emptyForm, proofPoints: [''] }); setEditId(null); setModal('create'); };
  const openEdit = (item) => { setForm({ ...item, proofPoints: [...item.proofPoints] }); setEditId(item.id); setModal('edit'); };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const cleaned = { ...form, proofPoints: form.proofPoints.filter((p) => p.trim()) };
    if (modal === 'create') {
      setItems([...items, { ...cleaned, id: Date.now() }]);
    } else {
      setItems(items.map((i) => (i.id === editId ? { ...cleaned, id: editId } : i)));
    }
    setModal(null);
  };

  const handleDelete = (id) => { setItems(items.filter((i) => i.id !== id)); setDeleteConfirm(null); };

  const updateProof = (index, value) => {
    const list = [...form.proofPoints]; list[index] = value;
    setForm({ ...form, proofPoints: list });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Unique Mechanisms</h1>
          <p className="text-sm text-slate-400 mt-1">Define the proprietary methods that differentiate your offers</p>
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
                <div className="p-2 rounded-lg bg-accent-muted"><Cog className="w-5 h-5 text-accent-text" /></div>
                <h3 className="font-semibold text-white">{item.name}</h3>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(item)} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => setDeleteConfirm(item.id)} className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <p className="text-sm text-slate-400 mb-4 leading-relaxed">{item.description}</p>
            <div>
              <h4 className="text-xs font-medium text-accent-text mb-1.5">Proof Points</h4>
              <ul className="space-y-1">
                {item.proofPoints.map((p, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                    <span className="text-accent/60 mt-0.5">*</span> {p}
                  </li>
                ))}
              </ul>
            </div>
            {deleteConfirm === item.id && (
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-red-400">Delete this mechanism?</span>
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
              <h2 className="text-lg font-bold text-white">{modal === 'create' ? 'Create Mechanism' : 'Edit Mechanism'}</h2>
              <button onClick={() => setModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Neuro-Sync Optimization" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Describe how this mechanism works..." rows={4}
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Proof Points</label>
                {form.proofPoints.map((p, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input type="text" value={p} onChange={(e) => updateProof(i, e.target.value)}
                      placeholder="Proof point..." className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    <button onClick={() => {
                      const list = form.proofPoints.filter((_, idx) => idx !== i);
                      setForm({ ...form, proofPoints: list.length ? list : [''] });
                    }} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button onClick={() => setForm({ ...form, proofPoints: [...form.proofPoints, ''] })} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add proof point</button>
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
