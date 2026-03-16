import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Zap,
  Crown,
  ChevronRight,
  Loader2,
  Copy,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Rocket,
  RotateCcw,
  Lock,
  Brain,
  Target,
  Flame,
  SlidersHorizontal,
  ExternalLink,
} from 'lucide-react';

const API = '/api/v1/iteration-king';

// ── Session storage key ───────────────────────────────────────────
const SESSION_KEY = 'iterationKing_session';

function saveSession(state) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch { /* quota exceeded — ignore */ }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Auth header helper ────────────────────────────────────────────
function authHeaders() {
  const token = localStorage.getItem('accessToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Animated status text ──────────────────────────────────────────
const SCRIPT_STEPS = [
  'Analyzing winning pattern...',
  'Generating iterations...',
  'Optimizing persuasion structure...',
  'Finalizing variations...',
];
const HOOK_STEPS = [
  'Synthesizing scroll-stopping openings...',
  'Aligning hooks with body...',
  'Scoring hook strength...',
  'Finalizing hooks...',
];

function AnimatedStatus({ steps }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % steps.length), 2200);
    return () => clearInterval(t);
  }, [steps]);
  return (
    <div className="flex items-center gap-3 mt-3" style={{ color: '#00FF88' }}>
      <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#00FF88' }} />
      <span className="text-sm font-mono">{steps[idx]}</span>
    </div>
  );
}

// ── Power Meter Slider ────────────────────────────────────────────
function PowerSlider({ label, value, onChange, icon: Icon, color = '#00FF88' }) {
  const pct = ((value - 1) / 9) * 100;
  const levelLabel =
    label === 'Script Aggressiveness'
      ? value <= 3 ? 'Soft persuasion' : value <= 6 ? 'Balanced DR' : value <= 8 ? 'Strong persuasion' : 'Highly aggressive'
      : value <= 3 ? 'Creative exploration' : value <= 6 ? 'Moderate iteration' : 'Close to original';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>{label}</span>
        </div>
        <span className="text-sm font-mono font-bold" style={{ color }}>{value}</span>
      </div>
      <div className="relative h-3 rounded-full overflow-hidden" style={{ background: '#1E1E1E' }}>
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}33, ${color})`, boxShadow: `0 0 12px ${color}66` }}
        />
        <input type="range" min={1} max={10} value={value} onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer" />
      </div>
      <div className="text-[10px]" style={{ color: '#555' }}>{levelLabel}</div>
    </div>
  );
}

// ── Tone Badge ────────────────────────────────────────────────────
const TONE_COLORS = {
  Curiosity: '#00FF88', Authority: '#3B82F6', 'UGC Story': '#A78BFA', Emotional: '#F472B6',
  'Direct Response': '#FF6B00', Minimalist: '#6B7280', Shock: '#EF4444', Contrarian: '#FBBF24',
  Urgency: '#FF6B00', 'Social Proof': '#10B981',
};

function ToneBadge({ tone }) {
  const c = TONE_COLORS[tone] || '#9CA3AF';
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: c, border: `1px solid ${c}44`, background: `${c}11` }}>{tone}</span>
  );
}

// ── Script Card ───────────────────────────────────────────────────
function ScriptCard({ script, selected, onSelect, index }) {
  const [expanded, setExpanded] = useState(false);
  const text = script.text || '';
  const preview = text.length > 220 && !expanded ? text.slice(0, 220) + '...' : text;
  const aggLevel = typeof script.aggressionLevel === 'number' ? script.aggressionLevel : 5;

  return (
    <div onClick={onSelect} className="relative rounded-xl p-4 cursor-pointer transition-all duration-300 group"
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        boxShadow: selected ? '0 0 24px #00FF8833, 0 0 48px #00FF8811' : 'none',
        animation: 'slideUp 0.35s ease-out both',
        animationDelay: `${index * 50}ms`,
      }}>
      {selected && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: '#00FF88' }}>
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono" style={{ color: '#9CA3AF' }}>SCRIPT #{index + 1}</span>
        <div className="flex items-center gap-2">
          <ToneBadge tone={script.toneLabel || 'Direct Response'} />
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ color: aggLevel >= 7 ? '#FF6B00' : '#9CA3AF', border: `1px solid ${aggLevel >= 7 ? '#FF6B0044' : '#1E1E1E'}` }}>
            AGG {aggLevel}
          </span>
        </div>
      </div>
      <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed" style={{ color: '#E5E5E5' }}>{preview}</pre>
      {text.length > 220 && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-2 text-xs hover:underline" style={{ color: '#00FF88' }}>
          {expanded ? 'Show less' : 'Expand'}
        </button>
      )}
      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: '0 0 18px #00FF8822' }} />
    </div>
  );
}

// ── Hook Card ─────────────────────────────────────────────────────
function HookCard({ hook, selected, onToggle, index }) {
  const strength = typeof hook.strength === 'number' ? hook.strength : parseFloat(hook.strength) || 5;
  return (
    <div onClick={onToggle} className="relative rounded-xl p-4 cursor-pointer transition-all duration-300 group"
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        boxShadow: selected ? '0 0 24px #00FF8833' : 'none',
        animation: 'slideUp 0.35s ease-out both',
        animationDelay: `${index * 50}ms`,
      }}>
      {selected && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: '#00FF88' }}>
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono" style={{ color: '#9CA3AF' }}>HOOK #{index + 1}</span>
        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded"
          style={{ color: strength >= 8 ? '#00FF88' : strength >= 5 ? '#FBBF24' : '#9CA3AF', border: `1px solid ${strength >= 8 ? '#00FF8844' : '#1E1E1E'}` }}>
          {strength.toFixed(1)}
        </span>
      </div>
      <p className="text-sm leading-relaxed mb-3" style={{ color: '#E5E5E5' }}>{hook.text || ''}</p>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div className="text-center">
          <div style={{ color: '#555' }} className="uppercase">Curiosity</div>
          <div className={hook.curiosityTrigger === 'High' ? 'font-bold' : ''}
            style={{ color: hook.curiosityTrigger === 'High' ? '#00FF88' : '#9CA3AF' }}>{hook.curiosityTrigger || 'Medium'}</div>
        </div>
        <div className="text-center">
          <div style={{ color: '#555' }} className="uppercase">Clarity</div>
          <div className={hook.clarity === 'High' ? 'font-bold' : ''}
            style={{ color: hook.clarity === 'High' ? '#3B82F6' : '#9CA3AF' }}>{hook.clarity || 'Medium'}</div>
        </div>
        <div className="text-center">
          <div style={{ color: '#555' }} className="uppercase">Scroll Stop</div>
          <div className={hook.scrollStopProbability === 'Strong' ? 'font-bold' : ''}
            style={{ color: hook.scrollStopProbability === 'Strong' ? '#00FF88' : '#9CA3AF' }}>{hook.scrollStopProbability || 'Moderate'}</div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════
export default function IterationKing() {
  const navigate = useNavigate();

  // ── State ─────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedBrief, setSelectedBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [originalScript, setOriginalScript] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [aggressiveness, setAggressiveness] = useState(5);
  const [similarity, setSimilarity] = useState(5);
  const [scripts, setScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [selectedScriptIdx, setSelectedScriptIdx] = useState(null);
  const [hooks, setHooks] = useState([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [selectedHookIdxs, setSelectedHookIdxs] = useState(new Set());
  const [finalScript, setFinalScript] = useState('');
  const [moveSuccess, setMoveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [generationMode, setGenerationMode] = useState('iterate'); // 'iterate' | 'full'
  const searchTimer = useRef(null);
  const sessionLoaded = useRef(false);

  // ── Restore session on mount ──────────────────────────────────
  useEffect(() => {
    if (sessionLoaded.current) return;
    sessionLoaded.current = true;
    const saved = loadSession();
    if (!saved) return;
    if (saved.selectedBrief) setSelectedBrief(saved.selectedBrief);
    if (saved.searchQuery) setSearchQuery(saved.searchQuery);
    if (saved.originalScript) setOriginalScript(saved.originalScript);
    if (saved.analysis) setAnalysis(saved.analysis);
    if (saved.aggressiveness) setAggressiveness(saved.aggressiveness);
    if (saved.similarity) setSimilarity(saved.similarity);
    if (saved.scripts) setScripts(saved.scripts);
    if (saved.selectedScriptIdx != null) setSelectedScriptIdx(saved.selectedScriptIdx);
    if (saved.hooks) setHooks(saved.hooks);
    if (saved.selectedHookIdxs) setSelectedHookIdxs(new Set(saved.selectedHookIdxs));
    if (saved.finalScript) setFinalScript(saved.finalScript);
    if (saved.generationMode) setGenerationMode(saved.generationMode);
  }, []);

  // ── Persist session on meaningful state changes ───────────────
  useEffect(() => {
    if (!sessionLoaded.current) return;
    saveSession({
      selectedBrief, searchQuery, originalScript, analysis,
      aggressiveness, similarity, scripts, selectedScriptIdx,
      hooks, selectedHookIdxs: [...selectedHookIdxs],
      finalScript, generationMode,
    });
  }, [selectedBrief, searchQuery, originalScript, analysis, aggressiveness, similarity,
      scripts, selectedScriptIdx, hooks, selectedHookIdxs, finalScript, generationMode]);

  // ── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (originalScript && !scriptsLoading) handleGenerateScripts();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault();
        if (selectedScriptIdx !== null && !hooksLoading && generationMode === 'iterate') handleGenerateHooks();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        handleMoveToBriefAgent();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // ── Get the effective final text (works for both modes) ───────
  const getEffectiveFinalText = useCallback(() => {
    if (finalScript) return finalScript;
    if (generationMode === 'full' && selectedScriptIdx !== null) {
      return scripts[selectedScriptIdx]?.text || '';
    }
    return '';
  }, [finalScript, generationMode, selectedScriptIdx, scripts]);

  // ── Search with debounce ──────────────────────────────────────
  const handleSearch = useCallback((q) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
        const data = await res.json();
        if (data.success) setSearchResults(data.results);
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
  }, []);

  // ── Select brief (fetch full task, then auto-analyze) ─────────
  const handleSelectBrief = async (briefSummary) => {
    setSearchResults([]);
    setSearchQuery(briefSummary.name);
    setScripts([]);
    setSelectedScriptIdx(null);
    setHooks([]);
    setSelectedHookIdxs(new Set());
    setFinalScript('');
    setMoveSuccess(false);
    setError(null);
    setAnalysis(null);

    // Fetch full task details to get complete description
    setBriefLoading(true);
    try {
      const res = await fetch(`${API}/brief/${briefSummary.id}`, { headers: authHeaders() });
      const data = await res.json();
      if (data.success) {
        setSelectedBrief(data.brief);
        setOriginalScript(data.brief.description || '');

        // Auto-analyze if there's a script
        if (data.brief.description && data.brief.description.length > 10) {
          setAnalysisLoading(true);
          try {
            const aRes = await fetch(`${API}/analyze`, {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({ script: data.brief.description }),
            });
            const aData = await aRes.json();
            if (aData.success) setAnalysis(aData.analysis);
          } catch (err) {
            console.error('Analysis error:', err);
          } finally {
            setAnalysisLoading(false);
          }
        }
      } else {
        setError(data.error || 'Failed to load brief');
      }
    } catch (err) {
      setError('Failed to fetch brief details');
    } finally {
      setBriefLoading(false);
    }
  };

  // ── Generate scripts ──────────────────────────────────────────
  const handleGenerateScripts = async () => {
    if (!originalScript) return;
    setScriptsLoading(true);
    setScripts([]);
    setSelectedScriptIdx(null);
    setHooks([]);
    setSelectedHookIdxs(new Set());
    setFinalScript('');
    setError(null);
    try {
      const endpoint = generationMode === 'full' ? '/generate-full-scripts' : '/generate-scripts';
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ script: originalScript, aggressiveness, similarity, analysis }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.scripts)) setScripts(data.scripts);
      else setError(data.error || 'Failed to generate scripts');
    } catch (err) {
      setError('Failed to generate scripts — check your connection');
    } finally {
      setScriptsLoading(false);
    }
  };

  // ── Generate hooks ────────────────────────────────────────────
  const handleGenerateHooks = async () => {
    if (selectedScriptIdx === null) return;
    setHooksLoading(true);
    setHooks([]);
    setSelectedHookIdxs(new Set());
    setFinalScript('');
    setError(null);
    try {
      const res = await fetch(`${API}/generate-hooks`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ body: scripts[selectedScriptIdx].text, aggressiveness }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.hooks)) setHooks(data.hooks);
      else setError(data.error || 'Failed to generate hooks');
    } catch (err) {
      setError('Failed to generate hooks — check your connection');
    } finally {
      setHooksLoading(false);
    }
  };

  // ── Toggle hook selection (multi-select) ──────────────────────
  const toggleHook = (idx) => {
    setSelectedHookIdxs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  // ── Build final script when hooks change ──────────────────────
  useEffect(() => {
    if (generationMode === 'full') return; // Full mode uses script directly
    if (selectedHookIdxs.size === 0 || selectedScriptIdx === null) {
      setFinalScript('');
      return;
    }
    const selHooks = [...selectedHookIdxs].sort().map((i) => hooks[i]?.text).filter(Boolean);
    const body = scripts[selectedScriptIdx]?.text || '';
    const parts = [
      '--- Hooks ---', '',
      ...selHooks.map((h, i) => `Hook ${i + 1}:\n${h}`),
      '', '--- Body ---', '', body,
    ];
    setFinalScript(parts.join('\n'));
  }, [selectedHookIdxs, selectedScriptIdx, hooks, scripts, generationMode]);

  // ── In full mode, auto-set finalScript when script selected ───
  useEffect(() => {
    if (generationMode === 'full' && selectedScriptIdx !== null) {
      setFinalScript(scripts[selectedScriptIdx]?.text || '');
    }
  }, [generationMode, selectedScriptIdx, scripts]);

  // ── Move to Brief Agent ───────────────────────────────────────
  const handleMoveToBriefAgent = () => {
    const text = getEffectiveFinalText();
    if (!text) return;
    localStorage.setItem('iterationKing_briefText', text);
    setMoveSuccess(true);
    setTimeout(() => navigate('/app/brief-agent'), 1000);
  };

  // ── Copy to clipboard ────────────────────────────────────────
  const handleCopy = () => {
    const text = getEffectiveFinalText();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Reset ─────────────────────────────────────────────────────
  const handleReset = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSelectedBrief(null);
    setOriginalScript('');
    setAnalysis(null);
    setScripts([]);
    setSelectedScriptIdx(null);
    setHooks([]);
    setSelectedHookIdxs(new Set());
    setFinalScript('');
    setMoveSuccess(false);
    setError(null);
    sessionStorage.removeItem(SESSION_KEY);
  };

  // ── Pipeline steps ────────────────────────────────────────────
  const isFullMode = generationMode === 'full';
  const pipelineSteps = isFullMode
    ? ['Source Brief', 'Controls', 'Full Scripts', 'Final Assembly']
    : ['Source Brief', 'Controls', 'Script Variations', 'Hook Generator', 'Final Assembly'];

  const getStepState = (step) => {
    switch (step) {
      case 'Source Brief':
        return { active: !selectedBrief, done: !!selectedBrief };
      case 'Controls':
        return { active: !!selectedBrief && scripts.length === 0, done: scripts.length > 0 };
      case 'Script Variations':
      case 'Full Scripts':
        return { active: scripts.length > 0 && selectedScriptIdx === null, done: selectedScriptIdx !== null };
      case 'Hook Generator':
        return { active: selectedScriptIdx !== null && selectedHookIdxs.size === 0 && hooks.length === 0, done: selectedHookIdxs.size > 0 };
      case 'Final Assembly': {
        const hasOutput = isFullMode ? selectedScriptIdx !== null : selectedHookIdxs.size > 0;
        return { active: hasOutput && !moveSuccess, done: moveSuccess };
      }
      default:
        return { active: false, done: false };
    }
  };

  // Can we show final assembly?
  const showFinalAssembly = isFullMode
    ? selectedScriptIdx !== null
    : (finalScript && selectedHookIdxs.size > 0);

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen" style={{ background: '#0A0A0A' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: '#00FF8822', boxShadow: '0 0 20px #00FF8833' }}>
            <Crown className="w-5 h-5" style={{ color: '#00FF88' }} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Iteration King</h1>
            <p className="text-xs" style={{ color: '#9CA3AF' }}>AI-powered ad script iteration engine</p>
          </div>
        </div>
        <button onClick={handleReset}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[#1E1E1E]"
          style={{ color: '#9CA3AF' }}>
          <RotateCcw className="w-3.5 h-3.5" /> Reset
        </button>
      </div>

      {/* Pipeline indicator */}
      <div className="flex items-center gap-1 mb-8 overflow-x-auto pb-2">
        {pipelineSteps.map((step, i) => {
          const { active, done } = getStepState(step);
          return (
            <div key={step} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight className="w-3 h-3" style={{ color: '#333' }} />}
              <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded"
                style={{
                  color: active ? '#00FF88' : done ? '#00FF88' : '#555',
                  background: active ? '#00FF8811' : 'transparent',
                  border: active ? '1px solid #00FF8833' : '1px solid transparent',
                }}>
                {done && !active ? '\u2713 ' : ''}{step}
              </span>
            </div>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 p-3 rounded-lg flex items-center gap-2"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle className="w-4 h-4 shrink-0" style={{ color: '#f87171' }} />
          <span className="text-sm" style={{ color: '#f87171' }}>{typeof error === 'string' ? error : 'An error occurred'}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline" style={{ color: '#f87171' }}>dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ═══════════════════════════════════════════════════════ */}
        {/* LEFT PANEL — Source + Analysis + Controls              */}
        {/* ═══════════════════════════════════════════════════════ */}
        <div className="lg:col-span-4 space-y-6">

          {/* 1. Source Brief Search */}
          <div className="rounded-xl p-5" style={{ background: '#111111', border: '1px solid #1E1E1E' }}>
            <div className="flex items-center gap-2 mb-4">
              <Search className="w-4 h-4" style={{ color: '#00FF88' }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Source Brief</span>
            </div>
            <div className="relative">
              <input type="text" value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search ClickUp brief by name or code..."
                className="w-full px-3 py-2.5 text-sm rounded-lg text-white placeholder:text-[#555] focus:outline-none focus:ring-2 focus:ring-[#00FF88]/30"
                style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }} />
              {searchLoading && <Loader2 className="absolute right-3 top-3 w-4 h-4 animate-spin" style={{ color: '#00FF88' }} />}
            </div>

            {/* Search results dropdown */}
            {searchResults.length > 0 && (
              <div className="mt-2 rounded-lg max-h-60 overflow-y-auto" style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}>
                {searchResults.map((r) => (
                  <button key={r.id} onClick={() => handleSelectBrief(r)}
                    className="w-full text-left px-3 py-2.5 text-sm hover:bg-[#1E1E1E] transition-colors"
                    style={{ color: '#E5E5E5', borderBottom: '1px solid #1E1E1E' }}>
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#555' }}>{r.status}</div>
                  </button>
                ))}
              </div>
            )}

            {/* Brief loading state */}
            {briefLoading && (
              <div className="mt-4 flex items-center gap-2" style={{ color: '#00FF88' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm font-mono">Loading brief...</span>
              </div>
            )}

            {/* Selected brief — locked original script */}
            {selectedBrief && !briefLoading && (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Lock className="w-3 h-3" style={{ color: '#9CA3AF' }} />
                  <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Source: ClickUp</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: '#555' }}>Status: Locked</span>
                  {selectedBrief.url && (
                    <a href={selectedBrief.url} target="_blank" rel="noopener noreferrer" className="ml-auto">
                      <ExternalLink className="w-3 h-3" style={{ color: '#555' }} />
                    </a>
                  )}
                </div>
                <div className="rounded-lg p-3 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap leading-relaxed"
                  style={{ background: '#0A0A0A', border: '1px solid #1E1E1E', color: '#E5E5E5' }}>
                  {originalScript || '(No script content in this brief)'}
                </div>
              </div>
            )}
          </div>

          {/* 2. Winner Analysis Panel */}
          {(analysisLoading || analysis) && (
            <div className="rounded-xl p-5" style={{ background: '#111111', border: '1px solid #1E1E1E', animation: 'slideUp 0.3s ease-out' }}>
              <div className="flex items-center gap-2 mb-4">
                <Brain className="w-4 h-4" style={{ color: '#3B82F6' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Winner Analysis</span>
              </div>
              {analysisLoading ? (
                <div className="flex items-center gap-2" style={{ color: '#3B82F6' }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm font-mono">Analyzing winning pattern...</span>
                </div>
              ) : analysis ? (
                <div className="space-y-3 text-sm">
                  {[
                    { label: 'Hook Mechanism', value: analysis.hookMechanism, color: '#00FF88', bold: true },
                    { label: 'Core Angle', value: analysis.coreAngle },
                    { label: 'Emotional Trigger', value: analysis.emotionalTrigger },
                    { label: 'Structure', value: analysis.narrativeStructure, mono: true },
                    { label: 'Pacing', value: analysis.pacingPattern, muted: true },
                    { label: 'CTA', value: analysis.ctaStructure, muted: true },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="text-[10px] uppercase" style={{ color: '#555' }}>{item.label}</div>
                      <p className={item.mono ? 'font-mono text-xs' : ''} style={{ color: item.color || (item.muted ? '#9CA3AF' : '#fff'), fontWeight: item.bold ? 500 : 400 }}>
                        {item.value}
                      </p>
                    </div>
                  ))}
                  <div className="pt-2" style={{ borderTop: '1px solid #1E1E1E' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase" style={{ color: '#555' }}>Strength</span>
                      <span className="text-sm font-mono font-bold"
                        style={{ color: (analysis.overallStrength || 0) >= 7 ? '#00FF88' : '#FBBF24' }}>
                        {analysis.overallStrength}/10
                      </span>
                    </div>
                    <p className="text-xs mt-1" style={{ color: '#9CA3AF' }}>{analysis.summary}</p>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* 3. Controls */}
          {selectedBrief && (
            <div className="rounded-xl p-5" style={{ background: '#111111', border: '1px solid #1E1E1E' }}>
              <div className="flex items-center gap-2 mb-4">
                <SlidersHorizontal className="w-4 h-4" style={{ color: '#9CA3AF' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Controls</span>
              </div>
              <div className="space-y-5">
                <PowerSlider label="Script Aggressiveness" value={aggressiveness} onChange={setAggressiveness}
                  icon={Flame} color={aggressiveness >= 7 ? '#FF6B00' : '#00FF88'} />
                <PowerSlider label="Similarity to Original" value={similarity} onChange={setSimilarity}
                  icon={Target} color="#3B82F6" />

                {/* Generation mode toggle */}
                <div className="pt-3" style={{ borderTop: '1px solid #1E1E1E' }}>
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: '#555' }}>Generation Mode</span>
                  <div className="flex gap-2 mt-2">
                    {[
                      { key: 'iterate', label: 'Script Body' },
                      { key: 'full', label: 'Full Ad Script' },
                    ].map((m) => (
                      <button key={m.key} onClick={() => setGenerationMode(m.key)}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all"
                        style={{
                          background: generationMode === m.key ? '#00FF8822' : '#0A0A0A',
                          border: `1px solid ${generationMode === m.key ? '#00FF8844' : '#1E1E1E'}`,
                          color: generationMode === m.key ? '#00FF88' : '#9CA3AF',
                        }}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Generate button */}
                <button onClick={handleGenerateScripts} disabled={!originalScript || scriptsLoading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: 'linear-gradient(135deg, #00FF8822, #00FF8811)',
                    border: '1px solid #00FF8844',
                    color: '#00FF88',
                    boxShadow: scriptsLoading ? 'none' : '0 0 20px #00FF8822',
                  }}>
                  {scriptsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {isFullMode ? 'Generate Full Ad Scripts' : 'Generate Script Variations'}
                </button>
                {scriptsLoading && <AnimatedStatus steps={SCRIPT_STEPS} />}
              </div>
            </div>
          )}

          {/* Hook generate button (iterate mode only, after script selected) */}
          {selectedScriptIdx !== null && !isFullMode && (
            <div className="rounded-xl p-5" style={{ background: '#111111', border: '1px solid #1E1E1E', animation: 'slideUp 0.3s ease-out' }}>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4" style={{ color: '#A78BFA' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Hook Generator</span>
              </div>
              <button onClick={handleGenerateHooks} disabled={hooksLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
                style={{
                  background: 'linear-gradient(135deg, #A78BFA22, #A78BFA11)',
                  border: '1px solid #A78BFA44',
                  color: '#A78BFA',
                  boxShadow: hooksLoading ? 'none' : '0 0 20px #A78BFA22',
                }}>
                {hooksLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Generate Hooks
              </button>
              {hooksLoading && <AnimatedStatus steps={HOOK_STEPS} />}
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════ */}
        {/* RIGHT PANEL — Generated Content                       */}
        {/* ═══════════════════════════════════════════════════════ */}
        <div className="lg:col-span-8 space-y-6">

          {/* Script variations / full scripts */}
          {scripts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                  {isFullMode ? 'Full Ad Scripts' : 'Script Variations'} ({scripts.length})
                </span>
                {selectedScriptIdx !== null && (
                  <span className="text-[10px] font-mono ml-auto" style={{ color: '#00FF88' }}>Script #{selectedScriptIdx + 1} selected</span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {scripts.map((s, i) => (
                  <ScriptCard key={s.id || i} script={s} index={i}
                    selected={selectedScriptIdx === i} onSelect={() => setSelectedScriptIdx(i)} />
                ))}
              </div>
            </div>
          )}

          {/* Generated hooks (iterate mode) */}
          {hooks.length > 0 && !isFullMode && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4" style={{ color: '#A78BFA' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                  Generated Hooks ({hooks.length})
                </span>
                {selectedHookIdxs.size > 0 && (
                  <span className="text-[10px] font-mono ml-auto" style={{ color: '#00FF88' }}>
                    {selectedHookIdxs.size} hook{selectedHookIdxs.size > 1 ? 's' : ''} selected
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {hooks.map((h, i) => (
                  <HookCard key={h.id || i} hook={h} index={i}
                    selected={selectedHookIdxs.has(i)} onToggle={() => toggleHook(i)} />
                ))}
              </div>
            </div>
          )}

          {/* Final Assembly */}
          {showFinalAssembly && (
            <div className="rounded-xl p-6"
              style={{ background: '#111111', border: '1px solid #00FF8833', boxShadow: '0 0 30px #00FF8811', animation: 'slideUp 0.3s ease-out' }}>
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Final Script Assembly</span>
              </div>
              <textarea value={getEffectiveFinalText()} onChange={(e) => setFinalScript(e.target.value)}
                rows={12}
                className="w-full px-4 py-3 text-sm rounded-lg text-white placeholder:text-[#555] focus:outline-none focus:ring-2 focus:ring-[#00FF88]/30 resize-y leading-relaxed"
                style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }} />

              <div className="flex items-center gap-3 mt-4">
                <button onClick={handleMoveToBriefAgent}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-bold transition-all"
                  style={{
                    background: moveSuccess ? '#16a34a' : 'linear-gradient(135deg, #00FF88, #00CC6A)',
                    color: '#0A0A0A',
                    boxShadow: '0 0 30px #00FF8844',
                  }}>
                  {moveSuccess ? (
                    <><CheckCircle2 className="w-4 h-4" /> Script sent to Brief Agent!</>
                  ) : (
                    <><Rocket className="w-4 h-4" /> Move to Brief Agent</>
                  )}
                </button>
                <button onClick={handleCopy}
                  className="flex items-center gap-2 px-4 py-3 rounded-lg text-xs transition-colors hover:text-white"
                  style={{ color: copied ? '#00FF88' : '#9CA3AF', border: '1px solid #1E1E1E' }}>
                  {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {scripts.length === 0 && !scriptsLoading && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: '#111111', border: '1px solid #1E1E1E' }}>
                <Crown className="w-8 h-8" style={{ color: '#333' }} />
              </div>
              <h3 className="text-sm font-medium" style={{ color: '#555' }}>No scripts generated yet</h3>
              <p className="text-xs mt-1" style={{ color: '#333' }}>
                {selectedBrief ? 'Adjust controls and generate script variations' : 'Search and select a winning brief to begin'}
              </p>
              <div className="flex gap-4 mt-6 text-[10px] font-mono" style={{ color: '#333' }}>
                <span>Cmd+Enter = Generate</span>
                <span>Cmd+H = Hooks</span>
                <span>Cmd+B = Brief Agent</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
