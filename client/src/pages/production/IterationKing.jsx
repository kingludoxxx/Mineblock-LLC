import { useState, useEffect, useCallback, useRef } from 'react';
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
  ArrowRight,
  Rocket,
  RotateCcw,
  Lock,
  Brain,
  Target,
  Flame,
  Gauge,
  SlidersHorizontal,
} from 'lucide-react';

const API = '/api/v1/iteration-king';
const BRIEF_AGENT_API = '/api/v1/brief-agent';

// ── Animated status text ──────────────────────────────────────────
const SCRIPT_LOADING_STEPS = [
  'Analyzing winning pattern...',
  'Generating iterations...',
  'Optimizing persuasion structure...',
  'Finalizing variations...',
];

const HOOK_LOADING_STEPS = [
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
    <div className="flex items-center gap-3 text-[#00FF88]">
      <div className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
      <span className="text-sm font-mono">{steps[idx]}</span>
    </div>
  );
}

// ── Power Meter Slider ────────────────────────────────────────────
function PowerSlider({ label, value, onChange, icon: Icon, color = '#00FF88' }) {
  const pct = ((value - 1) / 9) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color }} />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
            {label}
          </span>
        </div>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-[#1E1E1E] overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}33, ${color})`,
            boxShadow: `0 0 12px ${color}66`,
          }}
        />
        <input
          type="range"
          min={1}
          max={10}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
        />
      </div>
      <div className="flex justify-between text-[10px] text-[#555]">
        {value <= 3 ? (
          <span>{label === 'Script Aggressiveness' ? 'Soft' : 'Exploration'}</span>
        ) : value <= 6 ? (
          <span>{label === 'Script Aggressiveness' ? 'Balanced' : 'Moderate'}</span>
        ) : (
          <span>{label === 'Script Aggressiveness' ? 'Aggressive' : 'Close to original'}</span>
        )}
        <span />
      </div>
    </div>
  );
}

// ── Tone Badge ────────────────────────────────────────────────────
const TONE_COLORS = {
  Curiosity: '#00FF88',
  Authority: '#3B82F6',
  'UGC Story': '#A78BFA',
  Emotional: '#F472B6',
  'Direct Response': '#FF6B00',
  Minimalist: '#6B7280',
  Shock: '#EF4444',
  Contrarian: '#FBBF24',
  Urgency: '#FF6B00',
  'Social Proof': '#10B981',
};

function ToneBadge({ tone }) {
  const c = TONE_COLORS[tone] || '#9CA3AF';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: c, border: `1px solid ${c}44`, background: `${c}11` }}
    >
      {tone}
    </span>
  );
}

// ── Script Card ───────────────────────────────────────────────────
function ScriptCard({ script, selected, onSelect, index }) {
  const [expanded, setExpanded] = useState(false);
  const preview = script.text.length > 200 && !expanded ? script.text.slice(0, 200) + '...' : script.text;

  return (
    <div
      onClick={onSelect}
      className="relative rounded-xl p-4 cursor-pointer transition-all duration-300 group"
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        boxShadow: selected ? '0 0 20px #00FF8833, 0 0 40px #00FF8811' : 'none',
      }}
    >
      {selected && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[#00FF88] flex items-center justify-center">
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-[#9CA3AF]">SCRIPT #{index + 1}</span>
        <div className="flex items-center gap-2">
          <ToneBadge tone={script.toneLabel} />
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{
              color: script.aggressionLevel >= 7 ? '#FF6B00' : '#9CA3AF',
              border: `1px solid ${script.aggressionLevel >= 7 ? '#FF6B0044' : '#1E1E1E'}`,
            }}
          >
            AGG {script.aggressionLevel}
          </span>
        </div>
      </div>
      <pre className="text-sm text-[#E5E5E5] whitespace-pre-wrap font-sans leading-relaxed">
        {preview}
      </pre>
      {script.text.length > 200 && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-2 text-xs text-[#00FF88] hover:underline"
        >
          {expanded ? 'Show less' : 'Expand'}
        </button>
      )}
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: '0 0 15px #00FF8822' }}
      />
    </div>
  );
}

// ── Hook Card ─────────────────────────────────────────────────────
function HookCard({ hook, selected, onToggle, index }) {
  return (
    <div
      onClick={onToggle}
      className="relative rounded-xl p-4 cursor-pointer transition-all duration-300 group"
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        boxShadow: selected ? '0 0 20px #00FF8833' : 'none',
      }}
    >
      {selected && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[#00FF88] flex items-center justify-center">
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-[#9CA3AF]">HOOK #{index + 1}</span>
        <span
          className="text-xs font-mono font-bold px-2 py-0.5 rounded"
          style={{
            color: hook.strength >= 8 ? '#00FF88' : hook.strength >= 5 ? '#FBBF24' : '#9CA3AF',
            border: `1px solid ${hook.strength >= 8 ? '#00FF8844' : '#1E1E1E'}`,
          }}
        >
          {hook.strength.toFixed(1)}
        </span>
      </div>
      <p className="text-sm text-[#E5E5E5] leading-relaxed mb-3">{hook.text}</p>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div className="text-center">
          <div className="text-[#555] uppercase">Curiosity</div>
          <div className={hook.curiosityTrigger === 'High' ? 'text-[#00FF88] font-bold' : 'text-[#9CA3AF]'}>
            {hook.curiosityTrigger}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[#555] uppercase">Clarity</div>
          <div className={hook.clarity === 'High' ? 'text-[#3B82F6] font-bold' : 'text-[#9CA3AF]'}>
            {hook.clarity}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[#555] uppercase">Scroll Stop</div>
          <div className={hook.scrollStopProbability === 'Strong' ? 'text-[#00FF88] font-bold' : 'text-[#9CA3AF]'}>
            {hook.scrollStopProbability}
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════
export default function IterationKing() {
  // ── State ─────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedBrief, setSelectedBrief] = useState(null);
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
  const [error, setError] = useState(null);
  const [generationMode, setGenerationMode] = useState('iterate'); // 'iterate' | 'full'
  const searchTimer = useRef(null);

  // ── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (originalScript && !scriptsLoading) handleGenerateScripts();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault();
        if (selectedScriptIdx !== null && !hooksLoading) handleGenerateHooks();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (finalScript) handleMoveToBriefAgent();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // ── Search with debounce ──────────────────────────────────────
  const handleSearch = useCallback(
    (q) => {
      setSearchQuery(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (q.length < 2) {
        setSearchResults([]);
        return;
      }
      searchTimer.current = setTimeout(async () => {
        setSearchLoading(true);
        try {
          const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`);
          const data = await res.json();
          if (data.success) setSearchResults(data.results);
        } catch (err) {
          console.error('Search error:', err);
        } finally {
          setSearchLoading(false);
        }
      }, 400);
    },
    [],
  );

  // ── Select brief ──────────────────────────────────────────────
  const handleSelectBrief = async (brief) => {
    setSelectedBrief(brief);
    setSearchResults([]);
    setSearchQuery(brief.name);
    setOriginalScript(brief.description || '');
    setAnalysis(null);
    setScripts([]);
    setSelectedScriptIdx(null);
    setHooks([]);
    setSelectedHookIdxs(new Set());
    setFinalScript('');
    setMoveSuccess(false);
    setError(null);

    // Auto-analyze
    if (brief.description) {
      setAnalysisLoading(true);
      try {
        const res = await fetch(`${API}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: brief.description }),
        });
        const data = await res.json();
        if (data.success) setAnalysis(data.analysis);
      } catch (err) {
        console.error('Analysis error:', err);
      } finally {
        setAnalysisLoading(false);
      }
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: originalScript, aggressiveness, similarity, analysis }),
      });
      const data = await res.json();
      if (data.success) setScripts(data.scripts);
      else setError(data.error);
    } catch (err) {
      setError('Failed to generate scripts');
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: scripts[selectedScriptIdx].text, aggressiveness }),
      });
      const data = await res.json();
      if (data.success) setHooks(data.hooks);
      else setError(data.error);
    } catch (err) {
      setError('Failed to generate hooks');
    } finally {
      setHooksLoading(false);
    }
  };

  // ── Toggle hook selection ─────────────────────────────────────
  const toggleHook = (idx) => {
    setSelectedHookIdxs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // ── Build final script when hooks selected ────────────────────
  useEffect(() => {
    if (selectedHookIdxs.size === 0 || selectedScriptIdx === null) {
      setFinalScript('');
      return;
    }
    const selectedHooks = [...selectedHookIdxs]
      .sort()
      .map((i) => hooks[i]?.text)
      .filter(Boolean);
    const body = scripts[selectedScriptIdx]?.text || '';
    const parts = ['--- Hooks ---', '', ...selectedHooks.map((h, i) => `Hook ${i + 1}:\n${h}`), '', '--- Body ---', '', body];
    setFinalScript(parts.join('\n'));
  }, [selectedHookIdxs, selectedScriptIdx, hooks, scripts]);

  // ── Move to Brief Agent ───────────────────────────────────────
  const handleMoveToBriefAgent = () => {
    if (!finalScript) return;
    // Store in localStorage for Brief Agent to pick up
    localStorage.setItem('iterationKing_briefText', finalScript);
    setMoveSuccess(true);
    setTimeout(() => {
      window.location.href = '/app/brief-agent';
    }, 1200);
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
  };

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen" style={{ background: '#0A0A0A' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: '#00FF8822', boxShadow: '0 0 20px #00FF8833' }}
          >
            <Crown className="w-5 h-5" style={{ color: '#00FF88' }} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Iteration King</h1>
            <p className="text-xs text-[#9CA3AF]">AI-powered ad script iteration engine</p>
          </div>
        </div>
        <button
          onClick={handleReset}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-[#9CA3AF] hover:text-white hover:bg-[#1E1E1E] transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>

      {/* Pipeline indicator */}
      <div className="flex items-center gap-1 mb-8 overflow-x-auto pb-2">
        {['Source Brief', 'Controls', 'Script Variations', 'Hook Generator', 'Final Assembly'].map(
          (step, i) => {
            const active =
              (i === 0 && !selectedBrief) ||
              (i === 1 && selectedBrief && scripts.length === 0) ||
              (i === 2 && scripts.length > 0 && selectedScriptIdx === null) ||
              (i === 3 && selectedScriptIdx !== null && selectedHookIdxs.size === 0) ||
              (i === 4 && selectedHookIdxs.size > 0);
            const done =
              (i === 0 && selectedBrief) ||
              (i === 1 && scripts.length > 0) ||
              (i === 2 && selectedScriptIdx !== null) ||
              (i === 3 && selectedHookIdxs.size > 0) ||
              (i === 4 && moveSuccess);
            return (
              <div key={step} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="w-3 h-3 text-[#333]" />}
                <span
                  className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded"
                  style={{
                    color: active ? '#00FF88' : done ? '#00FF88' : '#555',
                    background: active ? '#00FF8811' : 'transparent',
                    border: active ? '1px solid #00FF8833' : '1px solid transparent',
                  }}
                >
                  {done && !active ? '\u2713 ' : ''}
                  {step}
                </span>
              </div>
            );
          },
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span className="text-sm text-red-400">{typeof error === 'string' ? error : error.message || 'An error occurred'}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ── LEFT PANEL: Source + Controls ── */}
        <div className="lg:col-span-4 space-y-6">
          {/* 1. Source Brief Search */}
          <div className="rounded-xl p-5" style={{ background: '#111111', border: '1px solid #1E1E1E' }}>
            <div className="flex items-center gap-2 mb-4">
              <Search className="w-4 h-4 text-[#00FF88]" />
              <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                Source Brief
              </span>
            </div>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search ClickUp brief by name or code..."
                className="w-full px-3 py-2.5 text-sm rounded-lg text-white placeholder:text-[#555] focus:outline-none focus:ring-2 focus:ring-[#00FF88]/30"
                style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}
              />
              {searchLoading && (
                <Loader2 className="absolute right-3 top-3 w-4 h-4 text-[#00FF88] animate-spin" />
              )}
            </div>

            {/* Search results dropdown */}
            {searchResults.length > 0 && (
              <div
                className="mt-2 rounded-lg max-h-60 overflow-y-auto"
                style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}
              >
                {searchResults.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => handleSelectBrief(r)}
                    className="w-full text-left px-3 py-2.5 text-sm text-[#E5E5E5] hover:bg-[#1E1E1E] transition-colors border-b border-[#1E1E1E] last:border-b-0"
                  >
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-[10px] text-[#555] mt-0.5">{r.status}</div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected brief — original script */}
            {selectedBrief && (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Lock className="w-3 h-3 text-[#9CA3AF]" />
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#9CA3AF]">
                    Source: ClickUp
                  </span>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#555]">
                    Status: Locked
                  </span>
                </div>
                <div
                  className="rounded-lg p-3 max-h-64 overflow-y-auto text-sm text-[#E5E5E5] whitespace-pre-wrap leading-relaxed"
                  style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}
                >
                  {originalScript || '(No script in this brief)'}
                </div>
              </div>
            )}
          </div>

          {/* 2. Winner Analysis Panel */}
          {(analysisLoading || analysis) && (
            <div
              className="rounded-xl p-5 transition-all duration-500"
              style={{
                background: '#111111',
                border: '1px solid #1E1E1E',
                animation: 'slideUp 0.3s ease-out',
              }}
            >
              <div className="flex items-center gap-2 mb-4">
                <Brain className="w-4 h-4 text-[#3B82F6]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Winner Analysis
                </span>
              </div>
              {analysisLoading ? (
                <div className="flex items-center gap-2 text-[#3B82F6]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm font-mono">Analyzing winning pattern...</span>
                </div>
              ) : analysis ? (
                <div className="space-y-3 text-sm">
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">Hook Mechanism</span>
                    <p className="text-[#00FF88] font-medium">{analysis.hookMechanism}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">Core Angle</span>
                    <p className="text-white">{analysis.coreAngle}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">Emotional Trigger</span>
                    <p className="text-white">{analysis.emotionalTrigger}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">Structure</span>
                    <p className="text-[#9CA3AF] font-mono text-xs">{analysis.narrativeStructure}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">Pacing</span>
                    <p className="text-[#9CA3AF]">{analysis.pacingPattern}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#555] uppercase">CTA</span>
                    <p className="text-[#9CA3AF]">{analysis.ctaStructure}</p>
                  </div>
                  <div className="pt-2 border-t border-[#1E1E1E]">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#555] uppercase">Strength</span>
                      <span
                        className="text-sm font-mono font-bold"
                        style={{ color: analysis.overallStrength >= 7 ? '#00FF88' : '#FBBF24' }}
                      >
                        {analysis.overallStrength}/10
                      </span>
                    </div>
                    <p className="text-xs text-[#9CA3AF] mt-1">{analysis.summary}</p>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* 3. Controls */}
          {selectedBrief && (
            <div
              className="rounded-xl p-5"
              style={{ background: '#111111', border: '1px solid #1E1E1E' }}
            >
              <div className="flex items-center gap-2 mb-4">
                <SlidersHorizontal className="w-4 h-4 text-[#9CA3AF]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Controls
                </span>
              </div>

              <div className="space-y-5">
                <PowerSlider
                  label="Script Aggressiveness"
                  value={aggressiveness}
                  onChange={setAggressiveness}
                  icon={Flame}
                  color={aggressiveness >= 7 ? '#FF6B00' : '#00FF88'}
                />
                <PowerSlider
                  label="Similarity to Original"
                  value={similarity}
                  onChange={setSimilarity}
                  icon={Target}
                  color="#3B82F6"
                />

                {/* Generation mode toggle */}
                <div className="pt-3 border-t border-[#1E1E1E]">
                  <span className="text-[10px] text-[#555] uppercase tracking-wider">
                    Generation Mode
                  </span>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setGenerationMode('iterate')}
                      className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: generationMode === 'iterate' ? '#00FF8822' : '#0A0A0A',
                        border:
                          generationMode === 'iterate'
                            ? '1px solid #00FF8844'
                            : '1px solid #1E1E1E',
                        color: generationMode === 'iterate' ? '#00FF88' : '#9CA3AF',
                      }}
                    >
                      Script Body
                    </button>
                    <button
                      onClick={() => setGenerationMode('full')}
                      className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: generationMode === 'full' ? '#00FF8822' : '#0A0A0A',
                        border:
                          generationMode === 'full' ? '1px solid #00FF8844' : '1px solid #1E1E1E',
                        color: generationMode === 'full' ? '#00FF88' : '#9CA3AF',
                      }}
                    >
                      Full Ad Script
                    </button>
                  </div>
                </div>

                {/* Generate button */}
                <button
                  onClick={handleGenerateScripts}
                  disabled={!originalScript || scriptsLoading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: 'linear-gradient(135deg, #00FF8822, #00FF8811)',
                    border: '1px solid #00FF8844',
                    color: '#00FF88',
                    boxShadow: scriptsLoading ? 'none' : '0 0 20px #00FF8822',
                  }}
                >
                  {scriptsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  {generationMode === 'full'
                    ? 'Generate Full Ad Scripts'
                    : 'Generate Script Variations'}
                </button>

                {scriptsLoading && <AnimatedStatus steps={SCRIPT_LOADING_STEPS} />}
              </div>
            </div>
          )}

          {/* Hook generate button (appears after script selected) */}
          {selectedScriptIdx !== null && generationMode === 'iterate' && (
            <div
              className="rounded-xl p-5"
              style={{ background: '#111111', border: '1px solid #1E1E1E' }}
            >
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4 text-[#A78BFA]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Hook Generator
                </span>
              </div>
              <button
                onClick={handleGenerateHooks}
                disabled={hooksLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
                style={{
                  background: 'linear-gradient(135deg, #A78BFA22, #A78BFA11)',
                  border: '1px solid #A78BFA44',
                  color: '#A78BFA',
                  boxShadow: hooksLoading ? 'none' : '0 0 20px #A78BFA22',
                }}
              >
                {hooksLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                Generate Hooks
              </button>
              {hooksLoading && <AnimatedStatus steps={HOOK_LOADING_STEPS} />}
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL: Generated Content ── */}
        <div className="lg:col-span-8 space-y-6">
          {/* Script variations */}
          {scripts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-[#00FF88]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  {generationMode === 'full' ? 'Full Ad Scripts' : 'Script Variations'} ({scripts.length})
                </span>
                {selectedScriptIdx !== null && (
                  <span className="text-[10px] text-[#00FF88] font-mono ml-auto">
                    Script #{selectedScriptIdx + 1} selected
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {scripts.map((s, i) => (
                  <ScriptCard
                    key={s.id || i}
                    script={s}
                    index={i}
                    selected={selectedScriptIdx === i}
                    onSelect={() => setSelectedScriptIdx(i)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Hooks */}
          {hooks.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4 text-[#A78BFA]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Generated Hooks ({hooks.length})
                </span>
                {selectedHookIdxs.size > 0 && (
                  <span className="text-[10px] text-[#00FF88] font-mono ml-auto">
                    {selectedHookIdxs.size} hook{selectedHookIdxs.size > 1 ? 's' : ''} selected
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {hooks.map((h, i) => (
                  <HookCard
                    key={h.id || i}
                    hook={h}
                    index={i}
                    selected={selectedHookIdxs.has(i)}
                    onToggle={() => toggleHook(i)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Final Assembly */}
          {(finalScript || (generationMode === 'full' && selectedScriptIdx !== null)) && (
            <div
              className="rounded-xl p-6"
              style={{
                background: '#111111',
                border: '1px solid #00FF8833',
                boxShadow: '0 0 30px #00FF8811',
              }}
            >
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-4 h-4 text-[#00FF88]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Final Script Assembly
                </span>
              </div>
              <textarea
                value={
                  generationMode === 'full' && !finalScript
                    ? scripts[selectedScriptIdx]?.text || ''
                    : finalScript
                }
                onChange={(e) => setFinalScript(e.target.value)}
                rows={12}
                className="w-full px-4 py-3 text-sm rounded-lg text-white placeholder:text-[#555] focus:outline-none focus:ring-2 focus:ring-[#00FF88]/30 resize-y leading-relaxed"
                style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}
              />

              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleMoveToBriefAgent}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-bold transition-all"
                  style={{
                    background: moveSuccess
                      ? '#16a34a'
                      : 'linear-gradient(135deg, #00FF88, #00CC6A)',
                    color: '#0A0A0A',
                    boxShadow: '0 0 30px #00FF8844',
                  }}
                >
                  {moveSuccess ? (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      Script sent to Brief Agent!
                    </>
                  ) : (
                    <>
                      <Rocket className="w-4 h-4" />
                      Move to Brief Agent
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    const text =
                      generationMode === 'full' && !finalScript
                        ? scripts[selectedScriptIdx]?.text || ''
                        : finalScript;
                    navigator.clipboard.writeText(text);
                  }}
                  className="flex items-center gap-2 px-4 py-3 rounded-lg text-xs text-[#9CA3AF] hover:text-white transition-colors"
                  style={{ border: '1px solid #1E1E1E' }}
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {scripts.length === 0 && !scriptsLoading && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: '#111111', border: '1px solid #1E1E1E' }}
              >
                <Crown className="w-8 h-8 text-[#333]" />
              </div>
              <h3 className="text-sm font-medium text-[#555]">No scripts generated yet</h3>
              <p className="text-xs text-[#333] mt-1">
                {selectedBrief
                  ? 'Adjust controls and generate script variations'
                  : 'Search and select a winning brief to begin'}
              </p>
              <div className="flex gap-4 mt-6 text-[10px] text-[#333] font-mono">
                <span>Cmd+Enter = Generate</span>
                <span>Cmd+H = Hooks</span>
                <span>Cmd+B = Brief Agent</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CSS animations */}
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
