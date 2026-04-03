import { useState, useEffect } from 'react';
import {
  X, FileSearch, Dna, Brain, Shield, Sparkles, BarChart3, Link, ArrowRight,
  Package, Layers, Save, RotateCcw, Loader2, Check, ChevronRight,
} from 'lucide-react';
import api from '../../../services/api';

const STEP_ICONS = { FileSearch, Dna, Brain, Shield, Sparkles, BarChart3, Link, Package, Layers };

const PIPELINE_STEPS = [
  { icon: 'FileSearch', title: 'Script Parser', desc: 'Extracts hooks, body, and CTA from raw script text', color: '#9CA3AF' },
  { icon: 'Package', title: 'Product Profile', desc: 'Fetches full product data from Product Library', color: '#3B82F6' },
  { icon: 'Dna', title: 'Script DNA Agent', desc: 'Core angle, mechanism, narrative structure, structural skeleton', color: '#C9A227' },
  { icon: 'Brain', title: 'Psychology Agent', desc: 'Emotional arc, hook analysis, audience profiling', color: '#A78BFA' },
  { icon: 'Shield', title: 'Iteration Rules Agent', desc: 'What stays fixed, what can vary, high-risk changes', color: '#F59E0B' },
  { icon: 'Layers', title: 'Direction Builder', desc: 'Creates iteration directions from safe variation paths', color: '#6B7280' },
  { icon: 'Sparkles', title: 'Brief Generator', desc: '1 body + 3 hooks per direction, section-by-section rephrasing', color: '#C9A227' },
  { icon: 'BarChart3', title: 'Scorer + Blend Check', desc: '5-dimension scoring + hook-body continuity validation', color: '#EF4444' },
];

export default function PipelineSettingsModal({ open, onClose }) {
  const [tab, setTab] = useState('overview'); // 'overview' | 'prompts'
  const [promptTypes, setPromptTypes] = useState([]);
  const [defaults, setDefaults] = useState({});
  const [custom, setCustom] = useState({});
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [editSystem, setEditSystem] = useState('');
  const [editUser, setEditUser] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadPrompts();
  }, [open]);

  const loadPrompts = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/brief-pipeline/settings/prompts');
      setPromptTypes(data.promptTypes || []);
      setDefaults(data.defaults || {});
      setCustom(data.custom || {});
      if (data.promptTypes?.length && !selectedPrompt) {
        selectPrompt(data.promptTypes[0].key, data.custom, data.defaults);
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const selectPrompt = (key, customOverride, defaultsOverride) => {
    const c = customOverride || custom;
    const d = defaultsOverride || defaults;
    setSelectedPrompt(key);
    setEditSystem(c[key]?.system || d[key]?.system || '');
    setEditUser(c[key]?.user || d[key]?.user || '');
    setHasChanges(false);
  };

  const handleSystemChange = (v) => { setEditSystem(v); setHasChanges(true); setSaved(false); };
  const handleUserChange = (v) => { setEditUser(v); setHasChanges(true); setSaved(false); };

  const handleSave = async () => {
    if (!selectedPrompt) return;
    setSaving(true);
    try {
      const updated = { ...custom, [selectedPrompt]: { system: editSystem, user: editUser } };
      await api.put('/brief-pipeline/settings/prompts', { prompts: updated });
      setCustom(updated);
      setHasChanges(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {} finally {
      setSaving(false);
    }
  };

  const handleResetOne = () => {
    if (!selectedPrompt || !defaults[selectedPrompt]) return;
    setEditSystem(defaults[selectedPrompt].system || '');
    setEditUser(defaults[selectedPrompt].user || '');
    setHasChanges(true);
    setSaved(false);
  };

  const handleResetAll = async () => {
    setSaving(true);
    try {
      await api.post('/brief-pipeline/settings/prompts/reset');
      setCustom({});
      if (selectedPrompt && defaults[selectedPrompt]) {
        setEditSystem(defaults[selectedPrompt].system || '');
        setEditUser(defaults[selectedPrompt].user || '');
      }
      setHasChanges(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {} finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const currentType = promptTypes.find(p => p.key === selectedPrompt);
  const isCustomized = custom[selectedPrompt]?.system || custom[selectedPrompt]?.user;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-full max-w-[900px] h-full bg-bg-card border-l border-border-default flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div>
            <h2 className="text-base font-bold text-text-primary">Pipeline Settings</h2>
            <p className="text-[11px] text-text-faint mt-0.5">Configure analysis agents and generation prompts</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border-default px-5">
          {[
            { key: 'overview', label: 'Pipeline Overview' },
            { key: 'prompts', label: 'Prompt Editor' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                tab === t.key
                  ? 'text-[#C9A227] border-[#C9A227]'
                  : 'text-text-faint border-transparent hover:text-text-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' ? (
            /* Pipeline Overview */
            <div className="p-5 space-y-1">
              <p className="text-[11px] text-text-faint mb-4">Each winning ad goes through this 8-step pipeline before briefs are generated.</p>
              {PIPELINE_STEPS.map((step, i) => {
                const Icon = STEP_ICONS[step.icon] || Sparkles;
                const isParallel = i >= 2 && i <= 4;
                return (
                  <div key={i}>
                    <div className="flex items-start gap-3 py-3 px-3 rounded-lg hover:bg-bg-hover transition-colors">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${step.color}15` }}>
                        <Icon className="w-4 h-4" style={{ color: step.color }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold" style={{ color: step.color }}>Step {i + 1}</span>
                          <span className="text-sm font-semibold text-text-primary">{step.title}</span>
                          {isParallel && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#C9A227]/10 text-[#C9A227] font-medium">parallel</span>
                          )}
                        </div>
                        <p className="text-[12px] text-text-faint mt-0.5">{step.desc}</p>
                      </div>
                    </div>
                    {i < PIPELINE_STEPS.length - 1 && (
                      <div className="flex justify-center py-0.5">
                        <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.06)' }} />
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="mt-4 p-3 rounded-lg bg-[#C9A227]/5 border border-[#C9A227]/10">
                <p className="text-[11px] text-[#C9A227]">
                  Steps 3-5 run in parallel on Sonnet for speed (~8s). Steps 7-8 run all variations in parallel. Total pipeline: ~20 seconds.
                </p>
              </div>
            </div>
          ) : (
            /* Prompt Editor */
            <div className="flex h-full">
              {/* Prompt list sidebar */}
              <div className="w-[200px] border-r border-border-default overflow-y-auto py-2">
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-4 h-4 animate-spin text-text-faint" />
                  </div>
                ) : (
                  promptTypes.map(pt => {
                    const Icon = STEP_ICONS[pt.icon] || Sparkles;
                    const isActive = selectedPrompt === pt.key;
                    const isCustom = !!custom[pt.key];
                    return (
                      <button
                        key={pt.key}
                        onClick={() => selectPrompt(pt.key)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer ${
                          isActive ? 'bg-bg-elevated' : 'hover:bg-bg-hover'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: isActive ? '#C9A227' : '#555' }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-medium truncate" style={{ color: isActive ? '#C9A227' : '#ccc' }}>{pt.label}</div>
                        </div>
                        {isCustom && <div className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] flex-shrink-0" title="Customized" />}
                        {isActive && <ChevronRight className="w-3 h-3 text-[#C9A227] flex-shrink-0" />}
                      </button>
                    );
                  })
                )}
                <div className="px-3 pt-3 mt-2 border-t border-border-default">
                  <button
                    onClick={handleResetAll}
                    disabled={saving || !Object.keys(custom).length}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-medium text-red-400 bg-red-500/10 rounded border border-red-500/20 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-30"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset All to Default
                  </button>
                </div>
              </div>

              {/* Editor panel */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {selectedPrompt && currentType ? (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-text-primary">{currentType.label}</h3>
                        <p className="text-[11px] text-text-faint mt-0.5">{currentType.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isCustomized && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">customized</span>
                        )}
                        <button
                          onClick={handleResetOne}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted bg-bg-elevated rounded border border-border-default hover:bg-bg-hover transition-colors cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reset
                        </button>
                      </div>
                    </div>

                    {/* System prompt */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[10px] uppercase tracking-wider font-semibold text-text-faint">System Prompt</label>
                        <span className="text-[10px] text-text-faint font-mono">{editSystem.length} chars</span>
                      </div>
                      <textarea
                        value={editSystem}
                        onChange={(e) => handleSystemChange(e.target.value)}
                        rows={4}
                        className="w-full bg-bg-elevated border border-border-default rounded-lg p-3 text-xs text-text-primary font-mono resize-y focus:outline-none focus:border-accent/50 transition-colors"
                        placeholder="System prompt..."
                      />
                    </div>

                    {/* User prompt */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[10px] uppercase tracking-wider font-semibold text-text-faint">User Prompt Template</label>
                        <span className="text-[10px] text-text-faint font-mono">{editUser.length} chars</span>
                      </div>
                      <textarea
                        value={editUser}
                        onChange={(e) => handleUserChange(e.target.value)}
                        rows={12}
                        className="w-full bg-bg-elevated border border-border-default rounded-lg p-3 text-xs text-text-primary font-mono resize-y focus:outline-none focus:border-accent/50 transition-colors"
                        placeholder="User prompt template... (use {{variable}} for dynamic values)"
                      />
                      <p className="text-[10px] text-text-faint mt-1">
                        Note: User prompts contain dynamic template variables (product context, script, analysis) that are injected at runtime.
                      </p>
                    </div>

                    {/* Save button */}
                    <div className="flex items-center gap-3 pt-2">
                      <button
                        onClick={handleSave}
                        disabled={!hasChanges || saving}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{
                          background: saved ? '#C9A227' : hasChanges ? 'linear-gradient(135deg, #C9A227, #B8922A)' : '#1a1a1a',
                          color: saved ? '#000' : hasChanges ? '#000' : '#555',
                        }}
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : saved ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        {saved ? 'Saved' : 'Save Prompt'}
                      </button>
                      {hasChanges && !saved && (
                        <span className="text-[11px] text-amber-400">Unsaved changes</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-text-faint text-sm">
                    Select a prompt from the sidebar
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
