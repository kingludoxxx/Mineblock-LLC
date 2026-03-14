import { useState } from 'react';
import { Plus, Edit2, Trash2, X, UserCircle } from 'lucide-react';

const INITIAL_AVATARS = [
  {
    id: 1,
    name: 'Burned-Out Entrepreneur',
    age: '30-45',
    gender: 'Male',
    income: '$50k-$100k',
    location: 'Urban, USA',
    painPoints: ['Working 80+ hours a week', 'No time for family', 'Revenue plateau', 'Overwhelmed by decisions'],
    desires: ['Passive income streams', 'Time freedom', 'Scale without burnout', 'Be a present parent'],
  },
  {
    id: 2,
    name: 'Aspiring Creator',
    age: '22-35',
    gender: 'Any',
    income: '$30k-$60k',
    location: 'Global, English-speaking',
    painPoints: ['No audience', 'Imposter syndrome', 'Inconsistent income', 'Don\'t know where to start'],
    desires: ['Build loyal following', 'Monetize expertise', 'Quit 9-5', 'Creative freedom'],
  },
];

const emptyAvatar = {
  name: '', age: '', gender: '', income: '', location: '',
  painPoints: [''], desires: [''],
};

export default function Avatars() {
  const [avatars, setAvatars] = useState(INITIAL_AVATARS);
  const [modal, setModal] = useState(null); // null | 'create' | 'edit'
  const [form, setForm] = useState(emptyAvatar);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const openCreate = () => { setForm({ ...emptyAvatar, painPoints: [''], desires: [''] }); setEditId(null); setModal('create'); };
  const openEdit = (avatar) => {
    setForm({ ...avatar, painPoints: [...avatar.painPoints], desires: [...avatar.desires] });
    setEditId(avatar.id);
    setModal('edit');
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const cleaned = {
      ...form,
      painPoints: form.painPoints.filter((p) => p.trim()),
      desires: form.desires.filter((d) => d.trim()),
    };
    if (modal === 'create') {
      setAvatars([...avatars, { ...cleaned, id: Date.now() }]);
    } else {
      setAvatars(avatars.map((a) => (a.id === editId ? { ...cleaned, id: editId } : a)));
    }
    setModal(null);
  };

  const handleDelete = (id) => {
    setAvatars(avatars.filter((a) => a.id !== id));
    setDeleteConfirm(null);
  };

  const updateList = (key, index, value) => {
    const list = [...form[key]];
    list[index] = value;
    setForm({ ...form, [key]: list });
  };

  const addListItem = (key) => setForm({ ...form, [key]: [...form[key], ''] });
  const removeListItem = (key, index) => {
    const list = form[key].filter((_, i) => i !== index);
    setForm({ ...form, [key]: list.length ? list : [''] });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Customer Avatars</h1>
          <p className="text-sm text-slate-400 mt-1">Define your ideal customer profiles</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 transition-colors cursor-pointer">
          <Plus className="w-4 h-4" /> Create New
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {avatars.map((avatar) => (
          <div key={avatar.id} className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/20">
                  <UserCircle className="w-5 h-5 text-purple-400" />
                </div>
                <h3 className="font-semibold text-white">{avatar.name}</h3>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(avatar)} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setDeleteConfirm(avatar.id)} className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 mb-4">
              <span>Age: {avatar.age}</span>
              <span>Gender: {avatar.gender}</span>
              <span>Income: {avatar.income}</span>
              <span>Location: {avatar.location}</span>
            </div>
            <div className="mb-3">
              <h4 className="text-xs font-medium text-red-400 mb-1.5">Pain Points</h4>
              <ul className="space-y-1">
                {avatar.painPoints.map((p, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                    <span className="text-red-400/60 mt-0.5">-</span> {p}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-medium text-green-400 mb-1.5">Desires</h4>
              <ul className="space-y-1">
                {avatar.desires.map((d, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                    <span className="text-green-400/60 mt-0.5">+</span> {d}
                  </li>
                ))}
              </ul>
            </div>

            {/* Delete confirmation */}
            {deleteConfirm === avatar.id && (
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-red-400">Delete this avatar?</span>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
                  <button onClick={() => handleDelete(avatar.id)} className="px-2 py-1 text-xs bg-red-600 text-white rounded cursor-pointer">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-white/[0.06] rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 mx-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">{modal === 'create' ? 'Create Avatar' : 'Edit Avatar'}</h2>
              <button onClick={() => setModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              {[
                { key: 'name', label: 'Avatar Name', placeholder: 'e.g. Burned-Out Entrepreneur' },
                { key: 'age', label: 'Age Range', placeholder: 'e.g. 30-45' },
                { key: 'gender', label: 'Gender', placeholder: 'e.g. Male, Female, Any' },
                { key: 'income', label: 'Income Range', placeholder: 'e.g. $50k-$100k' },
                { key: 'location', label: 'Location', placeholder: 'e.g. Urban, USA' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-xs text-slate-400 mb-1 block">{label}</label>
                  <input
                    type="text" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder}
                    className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50"
                  />
                </div>
              ))}
              {/* Pain Points */}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Pain Points</label>
                {form.painPoints.map((p, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input type="text" value={p} onChange={(e) => updateList('painPoints', i, e.target.value)}
                      placeholder="Pain point..." className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    <button onClick={() => removeListItem('painPoints', i)} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button onClick={() => addListItem('painPoints')} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add pain point</button>
              </div>
              {/* Desires */}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Desires</label>
                {form.desires.map((d, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input type="text" value={d} onChange={(e) => updateList('desires', i, e.target.value)}
                      placeholder="Desire..." className="flex-1 bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    <button onClick={() => removeListItem('desires', i)} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button onClick={() => addListItem('desires')} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add desire</button>
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
