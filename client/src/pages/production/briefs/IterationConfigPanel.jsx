import { useState } from 'react';
import { X, Settings, Zap, Shield } from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITERATION_MODES = [
  { value: 'hook_only', label: 'Hook Only', desc: 'New hooks, same body' },
  { value: 'hook_body', label: 'Hook + Body', desc: 'New hooks + modified body' },
  {
    value: 'full_reinterpretation',
    label: 'Full Rewrite',
    desc: 'Complete rewrite, same angle',
  },
  {
    value: 'angle_expansion',
    label: 'Angle Expansion',
    desc: 'Same mechanism, different angle',
  },
  {
    value: 'competitor_reframing',
    label: 'Competitor Reframe',
    desc: 'Same structure, different enemy',
  },
];

const AGGRESSIVENESS_OPTIONS = [
  { value: 'conservative', label: 'Conservative', color: 'bg-green-600' },
  { value: 'medium', label: 'Medium', color: 'bg-yellow-500' },
  { value: 'aggressive', label: 'Aggressive', color: 'bg-orange-500' },
  { value: 'extreme', label: 'Extreme', color: 'bg-red-600' },
];

const VARIATION_COUNTS = [3, 5, 10];

const FIXED_ELEMENTS = [
  { key: 'hook_mechanism', label: 'Keep hook mechanism' },
  { key: 'proof_type', label: 'Keep proof type' },
  { key: 'cta_structure', label: 'Keep CTA structure' },
  { key: 'villain_enemy', label: 'Keep villain/enemy' },
  { key: 'emotional_driver', label: 'Keep emotional driver' },
];

const EDITORS = ['Antoni', 'Faiz', 'Ludovico', 'Uly'];

// ---------------------------------------------------------------------------
// IterationConfigPanel
// ---------------------------------------------------------------------------

export default function IterationConfigPanel({ winner, isOpen, onClose, onSubmit }) {
  const [mode, setMode] = useState('hook_body');
  const [aggressiveness, setAggressiveness] = useState('medium');
  const [numVariations, setNumVariations] = useState(5);
  const [fixedElements, setFixedElements] = useState(['proof_type', 'cta_structure']);
  const [editor, setEditor] = useState('Antoni');

  if (!isOpen || !winner) return null;

  const toggleFixed = (key) => {
    setFixedElements((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleSubmit = () => {
    onSubmit({
      iteration_mode: mode,
      aggressiveness,
      num_variations: numVariations,
      fixed_elements: fixedElements,
      editor,
    });
  };

  const fmt = (v) => (v != null ? `$${Number(v).toLocaleString()}` : '—');

  return (
    <aside className="fixed right-0 top-0 h-full w-[360px] bg-[#0a0a0a] border-l border-white/[0.08] z-40 flex flex-col overflow-y-auto">
      {/* ---- Header ---- */}
      <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-white">Configure Iteration</h2>
          {winner?.creative_id && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono text-slate-400">
              {winner.creative_id}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-5 py-5 space-y-6 flex-1">
        {/* ---- Winner summary ---- */}
        {winner && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Winner
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-500">Angle</span>
              <span className="text-slate-300 truncate">{winner.angle || '—'}</span>
              <span className="text-slate-500">Format</span>
              <span className="text-slate-300 truncate">{winner.format || '—'}</span>
              <span className="text-slate-500">ROAS</span>
              <span className="text-emerald-400 font-medium">
                {winner.roas != null ? `${Number(winner.roas).toFixed(2)}x` : '—'}
              </span>
              <span className="text-slate-500">Spend</span>
              <span className="text-slate-300">{fmt(winner.spend)}</span>
            </div>
          </div>
        )}

        {/* ---- Iteration Mode ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">Iteration Mode</label>
          <div className="space-y-1.5">
            {ITERATION_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                  mode === m.value
                    ? 'bg-white/[0.06] border border-emerald-500/40'
                    : 'bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                {/* custom radio circle */}
                <span
                  className={`mt-0.5 shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                    mode === m.value
                      ? 'border-emerald-500'
                      : 'border-white/20'
                  }`}
                >
                  {mode === m.value && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  )}
                </span>
                <div>
                  <p className="text-xs font-medium text-white leading-tight">{m.label}</p>
                  <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{m.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ---- Aggressiveness ---- */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-slate-500" />
            <label className="text-sm font-medium text-slate-300">Aggressiveness</label>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {AGGRESSIVENESS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAggressiveness(opt.value)}
                className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-colors cursor-pointer ${
                  aggressiveness === opt.value
                    ? `${opt.color} text-white`
                    : 'bg-white/[0.04] text-slate-400 border border-white/[0.06] hover:border-white/[0.12] hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Number of Variations ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">Number of Variations</label>
          <div className="flex gap-1.5">
            {VARIATION_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNumVariations(n)}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  numVariations === n
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white/[0.04] text-slate-400 border border-white/[0.06] hover:border-white/[0.12] hover:text-white'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Fixed Elements ---- */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-slate-500" />
            <label className="text-sm font-medium text-slate-300">Fixed Elements</label>
          </div>
          <div className="space-y-1.5">
            {FIXED_ELEMENTS.map((el) => {
              const checked = fixedElements.includes(el.key);
              return (
                <button
                  key={el.key}
                  type="button"
                  onClick={() => toggleFixed(el.key)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.12] transition-colors cursor-pointer text-left"
                >
                  <span
                    className={`shrink-0 w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                      checked
                        ? 'bg-emerald-600 border-emerald-600'
                        : 'border-white/20 bg-transparent'
                    }`}
                  >
                    {checked && (
                      <svg
                        className="w-2.5 h-2.5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="text-xs text-slate-300">{el.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- Editor ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">Editor</label>
          <select
            value={editor}
            onChange={(e) => setEditor(e.target.value)}
            className="w-full bg-[#111] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none appearance-none cursor-pointer"
          >
            {EDITORS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Submit ---- */}
      <div className="px-5 py-4 border-t border-white/[0.06]">
        <button
          type="button"
          onClick={handleSubmit}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer"
        >
          <Zap className="w-4 h-4" />
          Select &amp; Queue
        </button>
      </div>
    </aside>
  );
}
