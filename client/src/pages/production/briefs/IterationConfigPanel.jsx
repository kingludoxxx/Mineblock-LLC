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

const EDITORS = ['Uly', 'Dimaranan', 'Fazlul', 'Ludovico'];

// ---------------------------------------------------------------------------
// IterationConfigPanel
// ---------------------------------------------------------------------------

export default function IterationConfigPanel({ winner, isOpen, onClose, onSubmit }) {
  const [mode, setMode] = useState('hook_body');
  const [aggressiveness, setAggressiveness] = useState('medium');
  const [numVariations, setNumVariations] = useState(5);
  const [fixedElements, setFixedElements] = useState(['proof_type', 'cta_structure']);
  const [editor, setEditor] = useState('Uly');

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
    <aside className="fixed right-0 top-0 h-full w-[360px] bg-bg-card border-l border-border-default z-40 flex flex-col overflow-y-auto">
      {/* ---- Header ---- */}
      <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-border-default">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-text-faint" />
          <h2 className="text-sm font-semibold text-text-primary">Configure Iteration</h2>
          {winner?.creative_id && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-bg-elevated text-[10px] font-mono text-text-muted">
              {winner.creative_id}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-text-faint hover:text-text-primary hover:bg-bg-hover hover:bg-bg-elevated transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-5 py-5 space-y-6 flex-1">
        {/* ---- Winner summary ---- */}
        {winner && (
          <div className="rounded-lg border border-border-default bg-bg-main p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
              Winner
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-text-faint">Angle</span>
              <span className="text-text-muted truncate">{winner.angle || '—'}</span>
              <span className="text-text-faint">Format</span>
              <span className="text-text-muted truncate">{winner.format || '—'}</span>
              <span className="text-text-faint">ROAS</span>
              <span className="text-emerald-400 font-medium">
                {winner.roas != null ? `${Number(winner.roas).toFixed(2)}x` : '—'}
              </span>
              <span className="text-text-faint">Spend</span>
              <span className="text-text-muted">{fmt(winner.spend)}</span>
            </div>
          </div>
        )}

        {/* ---- Iteration Mode ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-muted">Iteration Mode</label>
          <div className="space-y-1.5">
            {ITERATION_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                  mode === m.value
                    ? 'bg-bg-elevated border border-accent/40'
                    : 'bg-bg-main border border-border-default hover:border-border-strong'
                }`}
              >
                {/* custom radio circle */}
                <span
                  className={`mt-0.5 shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                    mode === m.value
                      ? 'border-accent'
                      : 'border-border-default'
                  }`}
                >
                  {mode === m.value && (
                    <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  )}
                </span>
                <div>
                  <p className="text-xs font-medium text-text-primary leading-tight">{m.label}</p>
                  <p className="text-[10px] text-text-faint leading-tight mt-0.5">{m.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ---- Aggressiveness ---- */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-text-faint" />
            <label className="text-sm font-medium text-text-muted">Aggressiveness</label>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {AGGRESSIVENESS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAggressiveness(opt.value)}
                className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-colors cursor-pointer ${
                  aggressiveness === opt.value
                    ? `${opt.color} text-text-primary`
                    : 'bg-bg-elevated text-text-muted border border-border-default hover:border-border-strong hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Number of Variations ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-muted">Number of Variations</label>
          <div className="flex gap-1.5">
            {VARIATION_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNumVariations(n)}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  numVariations === n
                    ? 'bg-accent text-bg-main'
                    : 'bg-bg-elevated text-text-muted border border-border-default hover:border-border-strong hover:text-text-primary hover:bg-bg-hover'
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
            <Shield className="w-3.5 h-3.5 text-text-faint" />
            <label className="text-sm font-medium text-text-muted">Fixed Elements</label>
          </div>
          <div className="space-y-1.5">
            {FIXED_ELEMENTS.map((el) => {
              const checked = fixedElements.includes(el.key);
              return (
                <button
                  key={el.key}
                  type="button"
                  onClick={() => toggleFixed(el.key)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-bg-main border border-border-default hover:border-border-strong transition-colors cursor-pointer text-left"
                >
                  <span
                    className={`shrink-0 w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                      checked
                        ? 'bg-accent border-accent'
                        : 'border-border-default bg-transparent'
                    }`}
                  >
                    {checked && (
                      <svg
                        className="w-2.5 h-2.5 text-text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="text-xs text-text-muted">{el.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- Editor ---- */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-muted">Editor</label>
          <select
            value={editor}
            onChange={(e) => setEditor(e.target.value)}
            className="w-full bg-bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary focus:border-accent/50 focus:outline-none appearance-none cursor-pointer"
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
      <div className="px-5 py-4 border-t border-border-default">
        <button
          type="button"
          onClick={handleSubmit}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-hover text-bg-main shadow-[0_1px_12px_rgba(201,162,39,0.25)] transition-colors cursor-pointer"
        >
          <Zap className="w-4 h-4" />
          Select &amp; Queue
        </button>
      </div>
    </aside>
  );
}
