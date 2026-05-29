import { useState, useEffect } from 'react';
import {
  X,
  FileText,
  Package,
  Dna,
  Brain,
  Shield,
  GitBranch,
  Sparkles,
  Trophy,
  ArrowDown,
  Save,
  RotateCcw,
  Loader2,
  Check,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Pipeline step definitions
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  {
    icon: FileText,
    title: 'Script Parser',
    desc: 'Extracts hooks, body, and CTA from raw script text',
    color: '#9CA3AF',
  },
  {
    icon: Package,
    title: 'Product Profile',
    desc: 'Fetches full product data from the Product Library',
    color: '#3B82F6',
  },
  {
    icon: Dna,
    title: 'Script DNA Agent',
    desc: 'Core angle, mechanism, narrative structure, structural skeleton',
    color: '#C9A84C',
    parallel: true,
  },
  {
    icon: Brain,
    title: 'Psychology Agent',
    desc: 'Emotional arc, hook analysis, audience profiling',
    color: '#A78BFA',
    parallel: true,
  },
  {
    icon: Shield,
    title: 'Iteration Rules Agent',
    desc: 'What stays fixed, what can vary, high-risk changes',
    color: '#F59E0B',
    parallel: true,
  },
  {
    icon: GitBranch,
    title: 'Direction Builder',
    desc: 'Creates iteration directions from safe variation paths',
    color: '#6B7280',
  },
  {
    icon: Sparkles,
    title: 'Brief Generator',
    desc: '1 body + 3 hooks per direction, section-by-section rephrasing',
    color: '#C9A84C',
  },
  {
    icon: Trophy,
    title: 'Scorer + Blend Check',
    desc: '5-dimension scoring + hook-body continuity validation',
    color: '#EF4444',
  },
];

// ---------------------------------------------------------------------------
// Prompt type display names for the sidebar
// ---------------------------------------------------------------------------

const PROMPT_TYPE_META = {
  scriptParser:    { label: 'Script Parser',      icon: FileText,  color: '#9CA3AF' },
  scriptDna:       { label: 'Script DNA',         icon: Dna,       color: '#C9A84C' },
  psychology:      { label: 'Psychology',          icon: Brain,     color: '#A78BFA' },
  iterationRules:  { label: 'Iteration Rules',    icon: Shield,    color: '#F59E0B' },
  generator:       { label: 'Generator',          icon: Sparkles,  color: '#C9A84C' },
  scorer:          { label: 'Scorer',             icon: Trophy,    color: '#EF4444' },
  blendValidator:  { label: 'Blend Validator',    icon: Check,     color: '#10B981' },
};

const PROMPT_KEYS = Object.keys(PROMPT_TYPE_META);

// ---------------------------------------------------------------------------
// PipelineSettingsModal
// ---------------------------------------------------------------------------

export default function PipelineSettingsModal({ open, onClose }) {
  const [tab, setTab] = useState('overview');

  // Prompt editor state
  const [defaults, setDefaults] = useState({});
  const [custom, setCustom] = useState({});
  const [promptTypes, setPromptTypes] = useState([]);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [editSystem, setEditSystem] = useState('');
  const [editUser, setEditUser] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState(null);

  // ── League Prompts state ─────────────────────────────────────────────
  // Stored under brief_pipeline_league_prompts in system_settings — 3 free-form
  // JSON slots: videoAnalysis, scriptAdaptation, scriptIteration.
  const [leagueTypes, setLeagueTypes] = useState([]);
  const [leaguePrompts, setLeaguePrompts] = useState({});
  const [leagueLoading, setLeagueLoading] = useState(false);
  const [leagueSaving, setLeagueSaving] = useState(false);
  const [leagueSavedFor, setLeagueSavedFor] = useState(null);
  const [leagueLoadedOnce, setLeagueLoadedOnce] = useState(false);

  // ── Fetch prompts on open ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    loadPrompts();
  }, [open]);

  const loadPrompts = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/brief-pipeline/settings/prompts');
      const types = data.promptTypes || [];
      setPromptTypes(types);
      setDefaults(data.defaults || {});
      setCustom(data.custom || {});
      if (types.length && !selectedPrompt) {
        selectPrompt(types[0].key, data.custom, data.defaults);
      }
    } catch (err) {
      console.error('Failed to load prompts:', err);
      setError('Failed to load prompts. Make sure the backend endpoints are available.');
    } finally {
      setLoading(false);
    }
  };

  // ── Select a prompt type ─────────────────────────────────────────────
  const selectPrompt = (key, customOverride, defaultsOverride) => {
    const c = customOverride || custom;
    const d = defaultsOverride || defaults;
    setSelectedPrompt(key);
    setEditSystem(c[key]?.system || d[key]?.system || '');
    setEditUser(c[key]?.user || d[key]?.user || '');
    setHasChanges(false);
    setSaved(false);
  };

  const handleSystemChange = (v) => {
    setEditSystem(v);
    setHasChanges(true);
    setSaved(false);
  };

  const handleUserChange = (v) => {
    setEditUser(v);
    setHasChanges(true);
    setSaved(false);
  };

  // ── Save current prompt ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedPrompt) return;
    setSaving(true);
    setError(null);
    try {
      const updated = { ...custom, [selectedPrompt]: { system: editSystem, user: editUser } };
      await api.put('/brief-pipeline/settings/prompts', { prompts: updated });
      setCustom(updated);
      setHasChanges(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save prompts:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Reset single prompt to default ───────────────────────────────────
  const handleResetOne = () => {
    if (!selectedPrompt || !defaults[selectedPrompt]) return;
    setEditSystem(defaults[selectedPrompt].system || '');
    setEditUser(defaults[selectedPrompt].user || '');
    setHasChanges(true);
    setSaved(false);
  };

  // ── League Prompts: fetch + save + reset ─────────────────────────────
  const loadLeaguePrompts = async () => {
    setLeagueLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/brief-pipeline/settings/league-prompts');
      setLeagueTypes(data.promptTypes || []);
      // Merge defaults with saved, so unsaved slots still have an editable shape.
      const base = {};
      for (const t of data.promptTypes || []) {
        base[t.key] = { json: '', notes: '' };
      }
      const saved = data.prompts || {};
      const merged = { ...base };
      for (const k of Object.keys(saved)) {
        merged[k] = {
          json:  typeof saved[k]?.json  === 'string' ? saved[k].json  : '',
          notes: typeof saved[k]?.notes === 'string' ? saved[k].notes : '',
        };
      }
      setLeaguePrompts(merged);
      setLeagueLoadedOnce(true);
    } catch (err) {
      console.error('Failed to load League prompts:', err);
      setError('Failed to load League Prompts. Make sure the backend is up to date.');
    } finally {
      setLeagueLoading(false);
    }
  };

  // Lazy-fetch when the user opens the tab for the first time.
  useEffect(() => {
    if (!open) return;
    if (tab === 'leaguePrompts' && !leagueLoadedOnce) loadLeaguePrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  const handleLeagueChange = (key, field, value) => {
    setLeaguePrompts(prev => ({
      ...prev,
      [key]: { ...(prev[key] || { json: '', notes: '' }), [field]: value },
    }));
  };

  const handleLeagueSave = async (key) => {
    setLeagueSaving(true);
    setError(null);
    try {
      const payload = { prompts: { [key]: leaguePrompts[key] } };
      const { data } = await api.put('/brief-pipeline/settings/league-prompts', payload);
      // Reflect the merged server state so subsequent saves work off truth
      setLeaguePrompts(prev => ({ ...prev, ...(data.prompts || {}) }));
      setLeagueSavedFor(key);
      setTimeout(() => setLeagueSavedFor(p => p === key ? null : p), 2000);
    } catch (err) {
      console.error('Failed to save League prompt:', err);
      const apiMsg = err.response?.data?.error?.message || err.message || 'unknown error';
      setError(`Failed to save: ${apiMsg}`);
    } finally {
      setLeagueSaving(false);
    }
  };

  const handleLeagueResetOne = (key) => {
    setLeaguePrompts(prev => ({ ...prev, [key]: { json: '', notes: '' } }));
  };

  const handleLeagueResetAll = async () => {
    if (!window.confirm('Clear all 3 League prompts on the server? This cannot be undone.')) return;
    setLeagueSaving(true);
    setError(null);
    try {
      await api.post('/brief-pipeline/settings/league-prompts/reset');
      const cleared = {};
      for (const t of leagueTypes) cleared[t.key] = { json: '', notes: '' };
      setLeaguePrompts(cleared);
    } catch (err) {
      console.error('Failed to reset League prompts:', err);
      setError('Failed to reset.');
    } finally {
      setLeagueSaving(false);
    }
  };

  // ── Reset all prompts to defaults ────────────────────────────────────
  const handleResetAll = async () => {
    setSaving(true);
    setError(null);
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
    } catch (err) {
      console.error('Failed to reset prompts:', err);
      setError('Failed to reset. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // Resolve display info for the selected prompt
  const currentMeta = selectedPrompt
    ? (promptTypes.find(p => p.key === selectedPrompt) || PROMPT_TYPE_META[selectedPrompt])
    : null;
  const isCustomized = !!(custom[selectedPrompt]?.system || custom[selectedPrompt]?.user);

  // Build sidebar list — prefer server-provided promptTypes, fall back to local
  const sidebarItems = promptTypes.length
    ? promptTypes.map(pt => ({
        key: pt.key,
        label: pt.label || PROMPT_TYPE_META[pt.key]?.label || pt.key,
        icon: PROMPT_TYPE_META[pt.key]?.icon || Sparkles,
        color: PROMPT_TYPE_META[pt.key]?.color || '#9CA3AF',
      }))
    : PROMPT_KEYS.map(key => ({
        key,
        label: PROMPT_TYPE_META[key].label,
        icon: PROMPT_TYPE_META[key].icon,
        color: PROMPT_TYPE_META[key].color,
      }));

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Slide-over panel from right */}
      <div
        className="relative ml-auto w-full max-w-[920px] h-full bg-[#111113] border-l border-white/[0.06] flex flex-col overflow-hidden shadow-2xl"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#c9a84c]/10 border border-[#c9a84c]/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-[#c9a84c]" />
            </div>
            <div>
              <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
                Pipeline Settings
              </h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Configure analysis agents and generation prompts
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.05] text-zinc-500 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <div className="flex border-b border-white/[0.06] px-6 shrink-0">
          {[
            { key: 'overview',       label: 'Pipeline Overview' },
            // 'prompts' tab (old 8-prompt store) removed 2026-05-29 —
            // the backend /settings/prompts routes were deleted and the
            // scriptParser / variantsGenerator / scorer prompts that lived
            // here are no longer reachable. League Prompts is the only
            // user-editable prompt namespace now.
            { key: 'leaguePrompts',  label: 'League Prompts' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-xs font-mono font-medium uppercase tracking-wide border-b-2 transition-colors cursor-pointer ${
                tab === t.key
                  ? 'text-[#d4b55a] border-[#c9a84c]'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Error toast ─────────────────────────────────────────────── */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200 font-mono uppercase tracking-wide text-[10px] cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ── Content ─────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden">
          {tab === 'overview' && <PipelineOverview />}
          {tab === 'prompts' && (
            <PromptEditor
              sidebarItems={sidebarItems}
              selectedPrompt={selectedPrompt}
              custom={custom}
              currentMeta={currentMeta}
              isCustomized={isCustomized}
              editSystem={editSystem}
              editUser={editUser}
              loading={loading}
              saving={saving}
              saved={saved}
              hasChanges={hasChanges}
              onSelect={(key) => selectPrompt(key)}
              onSystemChange={handleSystemChange}
              onUserChange={handleUserChange}
              onSave={handleSave}
              onResetOne={handleResetOne}
              onResetAll={handleResetAll}
            />
          )}
          {tab === 'leaguePrompts' && (
            <LeaguePromptsEditor
              types={leagueTypes}
              prompts={leaguePrompts}
              loading={leagueLoading}
              saving={leagueSaving}
              savedFor={leagueSavedFor}
              onChange={handleLeagueChange}
              onSaveOne={handleLeagueSave}
              onResetOne={handleLeagueResetOne}
              onResetAll={handleLeagueResetAll}
            />
          )}
        </div>
      </div>

      {/* Slide-in animation */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0.8; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Pipeline Overview
// ---------------------------------------------------------------------------

function PipelineOverview() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <p className="text-[11px] text-zinc-500 font-mono uppercase tracking-wide mb-6">
        Each script goes through this 8-step pipeline before briefs are generated
      </p>

      <div className="relative max-w-xl mx-auto">
        {PIPELINE_STEPS.map((step, i) => {
          const Icon = step.icon;
          const isParallel = step.parallel;

          return (
            <div key={i}>
              {/* Step card */}
              <div className="flex items-start gap-4 group">
                {/* Left: step number + icon */}
                <div className="flex flex-col items-center shrink-0">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center border transition-colors"
                    style={{
                      background: `${step.color}10`,
                      borderColor: `${step.color}25`,
                    }}
                  >
                    <Icon className="w-5 h-5" style={{ color: step.color }} />
                  </div>
                </div>

                {/* Right: title + description */}
                <div className="flex-1 pt-0.5 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="text-[10px] font-mono font-bold uppercase tracking-wider"
                      style={{ color: step.color }}
                    >
                      Step {i + 1}
                    </span>
                    <h3 className="text-sm font-semibold text-white">{step.title}</h3>
                    {isParallel && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20 font-mono font-medium uppercase tracking-wide">
                        parallel
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    {step.desc}
                  </p>
                </div>
              </div>

              {/* Connector line */}
              {i < PIPELINE_STEPS.length - 1 && (
                <div className="flex items-center gap-4 -mt-1 mb-1">
                  <div className="w-10 flex justify-center">
                    <div className="flex flex-col items-center">
                      <div className="w-px h-4 bg-white/[0.06]" />
                      <ArrowDown className="w-3 h-3 text-white/[0.12]" />
                    </div>
                  </div>
                  <div className="flex-1" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Info box */}
      <div className="max-w-xl mx-auto mt-6 p-3.5 rounded-lg bg-[#c9a84c]/5 border border-[#c9a84c]/10">
        <p className="text-[11px] text-[#c9a84c] leading-relaxed">
          Steps 3-5 run in parallel on Sonnet for speed (~8s). Steps 7-8 run all variations in parallel.
          Total pipeline: ~20 seconds per generation.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Prompt Editor
// ---------------------------------------------------------------------------

function PromptEditor({
  sidebarItems,
  selectedPrompt,
  custom,
  currentMeta,
  isCustomized,
  editSystem,
  editUser,
  loading,
  saving,
  saved,
  hasChanges,
  onSelect,
  onSystemChange,
  onUserChange,
  onSave,
  onResetOne,
  onResetAll,
}) {
  return (
    <div className="flex h-full">
      {/* ── Left sidebar: prompt type list ──────────────────────────── */}
      <div className="w-[210px] border-r border-white/[0.06] flex flex-col shrink-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
            </div>
          ) : (
            sidebarItems.map((item) => {
              const Icon = item.icon;
              const isActive = selectedPrompt === item.key;
              const isCustom = !!custom[item.key];
              return (
                <button
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all cursor-pointer ${
                    isActive
                      ? 'bg-white/[0.04] border-r-2 border-[#c9a84c]'
                      : 'hover:bg-white/[0.02] border-r-2 border-transparent'
                  }`}
                >
                  <Icon
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: isActive ? item.color : '#555' }}
                  />
                  <span
                    className={`text-[11px] font-medium truncate ${
                      isActive ? 'text-white' : 'text-zinc-400'
                    }`}
                  >
                    {item.label}
                  </span>
                  {isCustom && (
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 ml-auto"
                      title="Customized"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Reset all button */}
        <div className="px-3 py-3 border-t border-white/[0.06]">
          <button
            onClick={onResetAll}
            disabled={saving || !Object.keys(custom).length}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] font-mono font-medium uppercase tracking-wide
                       text-red-400 bg-red-500/5 rounded-lg border border-red-500/15
                       hover:bg-red-500/10 hover:border-red-500/25 transition-colors cursor-pointer
                       disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3 h-3" />
            Reset All to Default
          </button>
        </div>
      </div>

      {/* ── Right panel: editor ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {selectedPrompt && currentMeta ? (
          <>
            {/* Prompt header */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {currentMeta.label || selectedPrompt}
                </h3>
                {currentMeta.description && (
                  <p className="text-[11px] text-zinc-500 mt-0.5">{currentMeta.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isCustomized && (
                  <span className="text-[9px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono uppercase tracking-wide">
                    customized
                  </span>
                )}
                <button
                  onClick={onResetOne}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide
                             text-zinc-400 bg-white/[0.03] rounded-lg border border-white/[0.06]
                             hover:bg-white/[0.06] hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              </div>
            </div>

            {/* System prompt textarea */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] font-semibold">
                  System Prompt
                </label>
                <span className="text-[10px] text-zinc-600 font-mono">
                  {editSystem.length.toLocaleString()} chars
                </span>
              </div>
              <textarea
                value={editSystem}
                onChange={(e) => onSystemChange(e.target.value)}
                rows={5}
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 text-xs text-white font-mono
                           resize-y focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20
                           placeholder-white/20 transition-colors leading-relaxed"
                placeholder="System prompt..."
              />
            </div>

            {/* User prompt textarea */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] font-semibold">
                  User Prompt Template
                </label>
                <span className="text-[10px] text-zinc-600 font-mono">
                  {editUser.length.toLocaleString()} chars
                </span>
              </div>
              <textarea
                value={editUser}
                onChange={(e) => onUserChange(e.target.value)}
                rows={14}
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 text-xs text-white font-mono
                           resize-y focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20
                           placeholder-white/20 transition-colors leading-relaxed"
                placeholder="User prompt template... (use {{variable}} for dynamic values)"
              />
              <p className="text-[10px] text-zinc-600 mt-1.5 leading-relaxed">
                Dynamic template variables (product context, script, analysis) are injected at runtime.
                Use <code className="text-zinc-500">{'{{variable}}'}</code> syntax for placeholders.
              </p>
            </div>

            {/* Save button row */}
            <div className="flex items-center gap-3 pt-2 border-t border-white/[0.04]">
              <button
                onClick={onSave}
                disabled={!hasChanges || saving}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer
                  disabled:opacity-30 disabled:cursor-not-allowed ${
                    saved
                      ? 'bg-emerald-500 text-white'
                      : hasChanges
                        ? 'bg-[#c9a84c] hover:bg-[#d4b55a] text-[#111113]'
                        : 'bg-white/[0.04] text-zinc-500 border border-white/[0.06]'
                  }`}
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : saved ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {saved ? 'Saved' : 'Save Prompt'}
              </button>
              {hasChanges && !saved && (
                <span className="text-[11px] text-amber-400 font-mono">Unsaved changes</span>
              )}
            </div>
          </>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-600" />
            <p className="text-xs text-zinc-600 font-mono">Loading prompts...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <ChevronRight className="w-5 h-5 text-zinc-700" />
            <p className="text-xs text-zinc-600 font-mono">Select a prompt from the sidebar</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: League Prompts Editor — 3 free-form JSON slots
// ---------------------------------------------------------------------------

function validateJson(s) {
  if (!s || !s.trim()) return { ok: true, empty: true };
  try { JSON.parse(s); return { ok: true, empty: false }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function LeaguePromptsEditor({ types, prompts, loading, saving, savedFor, onChange, onSaveOne, onResetOne, onResetAll }) {
  if (loading && (!types || types.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-600" />
        <p className="text-xs text-zinc-600 font-mono">Loading League Prompts...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4">
        <div className="min-w-0">
          <p className="text-[11px] text-zinc-500 font-mono uppercase tracking-wide">
            League-driven flow · 3 prompt slots · free-form JSON
          </p>
          <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
            Paste the JSON for each slot. The server validates JSON on save and stores it under
            <code className="mx-1 text-zinc-400">brief_pipeline_league_prompts</code>
            in system_settings. The schema inside each JSON is yours to define.
          </p>
        </div>
        <button
          type="button"
          onClick={onResetAll}
          disabled={saving}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-md text-zinc-400 hover:text-red-300 border border-white/[0.06] hover:border-red-500/30 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-40"
          title="Clear all 3 slots on the server"
        >
          <RotateCcw className="w-3 h-3" />
          Reset All
        </button>
      </div>

      {/* Slots */}
      <div className="space-y-4">
        {types.map((t) => {
          const value = prompts[t.key] || { json: '', notes: '' };
          const validation = validateJson(value.json);
          const isSaved = savedFor === t.key;

          return (
            <div
              key={t.key}
              className="rounded-xl border border-white/[0.06] bg-white/[0.01] overflow-hidden"
            >
              {/* Slot header */}
              <div className="flex items-start justify-between px-4 py-3 border-b border-white/[0.04] bg-white/[0.01]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#d4b55a]">
                      {t.label}
                    </span>
                    {validation.empty && (
                      <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 px-1.5 py-0.5 rounded border border-white/[0.05]">
                        empty
                      </span>
                    )}
                    {!validation.empty && validation.ok && (
                      <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/25 bg-emerald-500/5">
                        valid JSON
                      </span>
                    )}
                    {!validation.ok && (
                      <span className="text-[9px] font-mono uppercase tracking-wider text-red-400 px-1.5 py-0.5 rounded border border-red-500/25 bg-red-500/5 inline-flex items-center gap-1">
                        <AlertCircle className="w-2.5 h-2.5" />
                        invalid
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1 leading-snug max-w-2xl">
                    {t.description}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onResetOne(t.key)}
                    disabled={saving}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md text-zinc-500 hover:text-zinc-300 border border-transparent hover:border-white/[0.06] hover:bg-white/[0.03] transition-colors cursor-pointer disabled:opacity-40"
                    title="Clear this slot in the editor (does not persist until you Save)"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveOne(t.key)}
                    disabled={saving || !validation.ok}
                    className="inline-flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    style={isSaved ? {
                      background: 'rgba(16,185,129,0.15)',
                      color: '#6ee7b7',
                      border: '1px solid rgba(16,185,129,0.4)',
                    } : {
                      background: 'rgba(201,168,76,0.12)',
                      color: '#e8d5a3',
                      border: '1px solid rgba(201,168,76,0.35)',
                    }}
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : isSaved ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
                    {isSaved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </div>

              {/* JSON editor */}
              <div className="p-4 space-y-3">
                <div>
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5 block">
                    JSON payload
                  </label>
                  <textarea
                    value={value.json}
                    onChange={(e) => onChange(t.key, 'json', e.target.value)}
                    spellCheck={false}
                    placeholder={`{\n  "system": "You are ...",\n  "user": "Given {{reference}} and {{product}} ...",\n  "outputSchema": { }\n}`}
                    className="w-full min-h-[260px] bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-[12px] text-zinc-200 font-mono leading-relaxed placeholder:text-zinc-700 focus:outline-none focus:border-[#c9a84c]/30 resize-y"
                  />
                  {!validation.ok && (
                    <p className="mt-1.5 text-[10px] font-mono text-red-400">
                      Parse error: {validation.error}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5 block">
                    Notes <span className="text-zinc-700 normal-case">(internal, optional)</span>
                  </label>
                  <textarea
                    value={value.notes}
                    onChange={(e) => onChange(t.key, 'notes', e.target.value)}
                    placeholder="Why this prompt is structured this way, what variables it expects, etc."
                    className="w-full min-h-[60px] bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-[12px] text-zinc-300 leading-relaxed placeholder:text-zinc-700 focus:outline-none focus:border-white/[0.15] resize-y"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
