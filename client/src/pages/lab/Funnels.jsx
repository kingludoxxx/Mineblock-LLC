import { useState } from 'react';
import { Plus, Edit2, Trash2, X, GripVertical, ArrowDown, Route, Globe, CreditCard, TrendingUp, CheckCircle } from 'lucide-react';

const STEP_TYPES = [
  { value: 'landing', label: 'Landing Page', icon: Globe, color: 'text-accent-text' },
  { value: 'checkout', label: 'Checkout', icon: CreditCard, color: 'text-emerald-400' },
  { value: 'upsell', label: 'Upsell', icon: TrendingUp, color: 'text-yellow-400' },
  { value: 'thankyou', label: 'Thank You', icon: CheckCircle, color: 'text-purple-400' },
];

const INITIAL_FUNNELS = [
  {
    id: 1,
    name: 'Webinar Funnel',
    steps: [
      { id: 101, name: 'Registration Page', type: 'landing', url: 'https://example.com/webinar' },
      { id: 102, name: 'Thank You / Calendar', type: 'thankyou', url: 'https://example.com/webinar/thanks' },
      { id: 103, name: 'Replay Page', type: 'landing', url: 'https://example.com/webinar/replay' },
      { id: 104, name: 'Checkout', type: 'checkout', url: 'https://example.com/checkout' },
      { id: 105, name: 'Order Bump Upsell', type: 'upsell', url: 'https://example.com/upsell-1' },
      { id: 106, name: 'Confirmation', type: 'thankyou', url: 'https://example.com/confirmation' },
    ],
  },
  {
    id: 2,
    name: 'Simple Sales Funnel',
    steps: [
      { id: 201, name: 'Sales Page', type: 'landing', url: 'https://example.com/sales' },
      { id: 202, name: 'Checkout', type: 'checkout', url: 'https://example.com/buy' },
      { id: 203, name: 'Thank You', type: 'thankyou', url: 'https://example.com/thanks' },
    ],
  },
];

const emptyStep = { name: '', type: 'landing', url: '' };

export default function Funnels() {
  const [funnels, setFunnels] = useState(INITIAL_FUNNELS);
  const [modal, setModal] = useState(null);
  const [funnelName, setFunnelName] = useState('');
  const [steps, setSteps] = useState([]);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);

  const openCreate = () => {
    setFunnelName('');
    setSteps([{ ...emptyStep, id: Date.now() }]);
    setEditId(null);
    setModal('create');
  };

  const openEdit = (funnel) => {
    setFunnelName(funnel.name);
    setSteps(funnel.steps.map((s) => ({ ...s })));
    setEditId(funnel.id);
    setModal('edit');
  };

  const handleSave = () => {
    if (!funnelName.trim() || steps.length === 0) return;
    const validSteps = steps.filter((s) => s.name.trim());
    if (validSteps.length === 0) return;

    if (modal === 'create') {
      setFunnels([...funnels, { id: Date.now(), name: funnelName, steps: validSteps }]);
    } else {
      setFunnels(funnels.map((f) => (f.id === editId ? { ...f, name: funnelName, steps: validSteps } : f)));
    }
    setModal(null);
  };

  const handleDelete = (id) => { setFunnels(funnels.filter((f) => f.id !== id)); setDeleteConfirm(null); };

  const updateStep = (index, key, value) => {
    const updated = [...steps];
    updated[index] = { ...updated[index], [key]: value };
    setSteps(updated);
  };

  const addStep = () => setSteps([...steps, { ...emptyStep, id: Date.now() }]);
  const removeStep = (index) => { const l = steps.filter((_, i) => i !== index); setSteps(l.length ? l : [{ ...emptyStep, id: Date.now() }]); };

  const moveStep = (from, to) => {
    if (to < 0 || to >= steps.length) return;
    const updated = [...steps];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    setSteps(updated);
  };

  const getStepType = (type) => STEP_TYPES.find((t) => t.value === type) || STEP_TYPES[0];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Funnel Builder</h1>
          <p className="text-sm text-slate-400 mt-1">Design and manage your marketing funnels</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 transition-colors cursor-pointer">
          <Plus className="w-4 h-4" /> Create New
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {funnels.map((funnel) => (
          <div key={funnel.id} className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/20"><Route className="w-5 h-5 text-indigo-400" /></div>
                <div>
                  <h3 className="font-semibold text-white">{funnel.name}</h3>
                  <span className="text-xs text-slate-500">{funnel.steps.length} steps</span>
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(funnel)} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => setDeleteConfirm(funnel.id)} className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-white/[0.06] cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>

            {/* Visual funnel steps */}
            <div className="space-y-0">
              {funnel.steps.map((step, i) => {
                const st = getStepType(step.type);
                const StepIcon = st.icon;
                return (
                  <div key={step.id}>
                    <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                      <span className="text-xs font-mono text-slate-600 w-5">{i + 1}</span>
                      <StepIcon className={`w-4 h-4 ${st.color} shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-white block truncate">{step.name}</span>
                        <span className="text-xs text-slate-500 truncate block">{step.url}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full bg-white/[0.04] ${st.color}`}>{st.label}</span>
                    </div>
                    {i < funnel.steps.length - 1 && (
                      <div className="flex justify-center py-1">
                        <ArrowDown className="w-3.5 h-3.5 text-slate-600" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {deleteConfirm === funnel.id && (
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-red-400">Delete this funnel?</span>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
                  <button onClick={() => handleDelete(funnel.id)} className="px-2 py-1 text-xs bg-red-600 text-white rounded cursor-pointer">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-white/[0.06] rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 mx-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">{modal === 'create' ? 'Create Funnel' : 'Edit Funnel'}</h2>
              <button onClick={() => setModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="mb-4">
              <label className="text-xs text-slate-400 mb-1 block">Funnel Name</label>
              <input type="text" value={funnelName} onChange={(e) => setFunnelName(e.target.value)}
                placeholder="e.g. Webinar Funnel" className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
            </div>
            <div className="mb-4">
              <label className="text-xs text-slate-400 mb-2 block">Funnel Steps</label>
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={step.id || i} className="flex items-start gap-2 p-3 bg-[#111] border border-white/[0.06] rounded-lg">
                    <div className="flex flex-col gap-1 pt-1">
                      <button onClick={() => moveStep(i, i - 1)} disabled={i === 0} className="p-0.5 text-slate-500 hover:text-white disabled:opacity-20 cursor-pointer"><GripVertical className="w-3.5 h-3.5" /></button>
                    </div>
                    <span className="text-xs font-mono text-slate-600 pt-2.5 w-5">{i + 1}</span>
                    <div className="flex-1 grid grid-cols-3 gap-2">
                      <input type="text" value={step.name} onChange={(e) => updateStep(i, 'name', e.target.value)}
                        placeholder="Step name" className="bg-transparent border border-white/[0.06] rounded-lg p-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                      <select value={step.type} onChange={(e) => updateStep(i, 'type', e.target.value)}
                        className="bg-transparent border border-white/[0.06] rounded-lg p-2 text-sm text-white focus:outline-none focus:border-purple-500/50 cursor-pointer">
                        {STEP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <input type="url" value={step.url} onChange={(e) => updateStep(i, 'url', e.target.value)}
                        placeholder="https://..." className="bg-transparent border border-white/[0.06] rounded-lg p-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50" />
                    </div>
                    <button onClick={() => removeStep(i)} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer mt-0.5"><X className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <button onClick={addStep} className="mt-2 text-xs text-purple-400 hover:text-purple-300 cursor-pointer">+ Add step</button>
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.06]">
              <button onClick={() => setModal(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white cursor-pointer">Cancel</button>
              <button onClick={handleSave} disabled={!funnelName.trim()} className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                {modal === 'create' ? 'Create' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
