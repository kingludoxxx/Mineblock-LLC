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

// Session storage removed — each visit starts fresh

function authHeaders() {
  const t = localStorage.getItem('accessToken');
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

// SSE stream consumer: reads items as they arrive and calls onItem for each
async function consumeSSEStream(url, body, { onItem, onError, onDone, signal }) {
  const t = localStorage.getItem('accessToken');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Session expired — please log in again.');
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  // Verify response is actually SSE
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    throw new Error('Unexpected response from server');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedItems = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { onDone?.(); return; }
      try {
        const item = JSON.parse(payload);
        if (item.error) { onError?.(item.error); return; }
        receivedItems = true;
        onItem(item);
      } catch {}
    }
  }
  if (!receivedItems) onError?.('No data received from server');
  onDone?.();
}

// ── Animated status ───────────────────────────────────────────────
const SCRIPT_STEPS = ['Analyzing winning pattern...', 'Generating iterations...', 'Optimizing persuasion structure...', 'Finalizing variations...'];
const HOOK_STEPS = ['Synthesizing scroll-stopping openings...', 'Aligning hooks with body...', 'Scoring hook strength...', 'Finalizing hooks...'];

function AnimatedStatus({ steps }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => { const t = setInterval(() => setIdx((i) => (i + 1) % steps.length), 2200); return () => clearInterval(t); }, [steps]);
  return (
    <div className="flex items-center gap-3 mt-3">
      <div className="w-2 h-2 rounded-full ik-pulse-dot" />
      <span className="text-sm font-mono ik-glow-text">{steps[idx]}</span>
    </div>
  );
}

// ── Power Meter ───────────────────────────────────────────────────
function PowerMeter({ label, value, onChange, icon: Icon, color = '#00FF88' }) {
  const segments = 10;
  const levelLabel =
    label === 'Script Aggressiveness'
      ? value <= 3 ? 'Soft persuasion' : value <= 6 ? 'Balanced DR' : value <= 8 ? 'Strong persuasion' : 'Highly aggressive'
      : value <= 3 ? 'Creative exploration' : value <= 6 ? 'Moderate iteration' : 'Close to original';

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color }} />
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>{label}</span>
        </div>
        <span className="text-lg font-mono font-bold tracking-tight" style={{ color, textShadow: `0 0 12px ${color}66` }}>{value}</span>
      </div>
      {/* Segmented power bar */}
      <div className="flex gap-[3px]">
        {Array.from({ length: segments }, (_, i) => {
          const active = i < value;
          const segColor = i >= 7 && label === 'Script Aggressiveness' ? '#FF6B00' : color;
          return (
            <button key={i} onClick={() => onChange(i + 1)}
              className="flex-1 h-4 rounded-sm transition-all duration-200 cursor-pointer"
              style={{
                background: active ? segColor : '#1E1E1E',
                boxShadow: active ? `0 0 8px ${segColor}44` : 'none',
                opacity: active ? (0.5 + (i / segments) * 0.5) : 0.3,
              }} />
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono" style={{ color: '#555' }}>{levelLabel}</span>
        <input type="range" min={1} max={10} value={value} onChange={(e) => onChange(Number(e.target.value))}
          className="w-0 h-0 opacity-0 absolute" />
      </div>
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
    <div onClick={onSelect}
      className={`relative rounded-xl p-5 cursor-pointer transition-all duration-300 group ik-card-enter ${selected ? 'ik-selected-glow' : ''}`}
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        animationDelay: `${index * 60}ms`,
      }}>
      {selected && (
        <div className="absolute -top-2.5 -right-2.5 w-7 h-7 rounded-full flex items-center justify-center ik-check-badge">
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono font-semibold" style={{ color: selected ? '#00FF88' : '#666' }}>SCRIPT #{index + 1}</span>
        <div className="flex items-center gap-2">
          <ToneBadge tone={script.toneLabel || 'Direct Response'} />
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ color: aggLevel >= 7 ? '#FF6B00' : '#9CA3AF', border: `1px solid ${aggLevel >= 7 ? '#FF6B0044' : '#1E1E1E'}`, background: aggLevel >= 7 ? '#FF6B0011' : 'transparent' }}>
            AGG {aggLevel}
          </span>
        </div>
      </div>
      <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed" style={{ color: '#E5E5E5' }}>{preview}</pre>
      {text.length > 220 && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-3 text-xs font-medium hover:underline" style={{ color: '#00FF88' }}>
          {expanded ? 'Show less' : 'Expand full script'}
        </button>
      )}
      {/* Hover glow */}
      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{ boxShadow: '0 0 24px #00FF8818, inset 0 0 24px #00FF8808' }} />
    </div>
  );
}

// ── Hook Card ─────────────────────────────────────────────────────
function HookCard({ hook, selected, onToggle, index }) {
  const strength = typeof hook.strength === 'number' ? hook.strength : parseFloat(hook.strength) || 5;
  const strengthColor = strength >= 8 ? '#00FF88' : strength >= 5 ? '#FBBF24' : '#EF4444';
  return (
    <div onClick={onToggle}
      className={`relative rounded-xl p-5 cursor-pointer transition-all duration-300 group ik-card-enter ${selected ? 'ik-selected-glow' : ''}`}
      style={{
        background: '#111111',
        border: selected ? '1px solid #00FF88' : '1px solid #1E1E1E',
        animationDelay: `${index * 60}ms`,
      }}>
      {selected && (
        <div className="absolute -top-2.5 -right-2.5 w-7 h-7 rounded-full flex items-center justify-center ik-check-badge">
          <CheckCircle2 className="w-4 h-4 text-black" />
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono font-semibold" style={{ color: selected ? '#00FF88' : '#666' }}>HOOK #{index + 1}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase font-mono" style={{ color: '#555' }}>Strength</span>
          <span className="text-sm font-mono font-bold px-2 py-0.5 rounded"
            style={{ color: strengthColor, border: `1px solid ${strengthColor}44`, background: `${strengthColor}11`, textShadow: `0 0 8px ${strengthColor}44` }}>
            {strength.toFixed(1)}
          </span>
        </div>
      </div>
      <p className="text-sm leading-relaxed mb-4" style={{ color: '#E5E5E5' }}>{hook.text || ''}</p>
      {/* Hook analysis grid */}
      <div className="grid grid-cols-3 gap-3 pt-3" style={{ borderTop: '1px solid #1E1E1E' }}>
        {[
          { label: 'Curiosity', value: hook.curiosityTrigger || 'Medium', highColor: '#00FF88' },
          { label: 'Clarity', value: hook.clarity || 'Medium', highColor: '#3B82F6' },
          { label: 'Scroll Stop', value: hook.scrollStopProbability || 'Moderate', highColor: '#00FF88', highValue: 'Strong' },
        ].map((m) => {
          const isHigh = m.value === 'High' || m.value === (m.highValue || 'High');
          return (
            <div key={m.label} className="text-center">
              <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: '#444' }}>{m.label}</div>
              <div className="text-[11px] font-semibold" style={{ color: isHigh ? m.highColor : '#9CA3AF', textShadow: isHigh ? `0 0 6px ${m.highColor}44` : 'none' }}>
                {m.value}
              </div>
            </div>
          );
        })}
      </div>
      {/* Hover glow */}
      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{ boxShadow: '0 0 24px #A78BFA18, inset 0 0 24px #A78BFA08' }} />
    </div>
  );
}

// ── AI Insight Panel ──────────────────────────────────────────────
function AIInsightPanel({ analysis, scripts, selectedScriptIdx }) {
  if (!analysis) return null;
  const selectedScript = selectedScriptIdx !== null ? scripts[selectedScriptIdx] : null;
  return (
    <div className="rounded-xl p-4 ik-card-enter" style={{ background: '#111111', border: '1px solid #1E1E1E' }}>
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-3.5 h-3.5" style={{ color: '#3B82F6' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>AI Analysis</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[9px] uppercase" style={{ color: '#444' }}>Hook Strength</div>
          <div className="text-sm font-mono font-bold" style={{ color: '#00FF88', textShadow: '0 0 8px #00FF8844' }}>{analysis.overallStrength || '—'}/10</div>
        </div>
        <div>
          <div className="text-[9px] uppercase" style={{ color: '#444' }}>Curiosity Score</div>
          <div className="text-sm font-semibold" style={{ color: '#FBBF24' }}>
            {analysis.hookMechanism?.toLowerCase().includes('curiosity') ? 'High' : 'Medium'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase" style={{ color: '#444' }}>Scroll Stop</div>
          <div className="text-sm font-semibold" style={{ color: (analysis.overallStrength || 0) >= 7 ? '#00FF88' : '#9CA3AF' }}>
            {(analysis.overallStrength || 0) >= 7 ? 'Strong' : 'Moderate'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase" style={{ color: '#444' }}>Ad Style</div>
          <div className="text-sm font-semibold" style={{ color: '#A78BFA' }}>
            {selectedScript?.toneLabel || 'Direct Response'}
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
  const navigate = useNavigate();

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
  const [generationMode, setGenerationMode] = useState('quick-hooks');
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const searchTimer = useRef(null);
  const scriptAbortRef = useRef(null);
  const hookAbortRef = useRef(null);

  const isFullMode = generationMode === 'full';

  // Cleanup timers and abort controllers on unmount
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (scriptAbortRef.current) scriptAbortRef.current.abort();
      if (hookAbortRef.current) hookAbortRef.current.abort();
    };
  }, []);

  // Keyboard shortcuts (use ref to avoid re-registering every render)
  const shortcutRef = useRef();
  shortcutRef.current = (e) => {
    // Skip when focused on input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (originalScript && !scriptsLoading && !hooksLoading) { generationMode === 'quick-hooks' ? handleGenerateQuickHooks() : handleGenerateScripts(); } }
    if ((e.metaKey || e.ctrlKey) && e.key === 'h') { e.preventDefault(); if (selectedScriptIdx !== null && !hooksLoading && generationMode === 'iterate') handleGenerateHooks(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); handleMoveToBriefAgent(); }
  };
  useEffect(() => {
    const handler = (e) => shortcutRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const getEffectiveFinalText = useCallback(() => {
    if (finalScript) return finalScript;
    if (generationMode === 'full' && selectedScriptIdx !== null) return scripts[selectedScriptIdx]?.text || '';
    return '';
  }, [finalScript, generationMode, selectedScriptIdx, scripts]);

  // Search
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
      } catch {} finally { setSearchLoading(false); }
    }, 400);
  }, []);

  // Extract only the brief content (hooks + body), stripping URLs and attachment junk
  const cleanBriefScript = (text) => {
    // Try to find where the actual brief starts (HOOKS: or Hook or BODY:)
    const briefStart = text.match(/\b(HOOKS?:|Body:|BODY:)/i);
    const content = briefStart ? text.slice(briefStart.index) : text;
    // Strip any remaining URLs and clean up blank lines
    return content.replace(/https?:\/\/[^\s)]+/g, '').replace(/\S*\.mp4\S*/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  };

  // Select brief
  const handleSelectBrief = async (briefSummary) => {
    setSearchResults([]); setSearchQuery(briefSummary.name); setScripts([]); setSelectedScriptIdx(null);
    setHooks([]); setSelectedHookIdxs(new Set()); setFinalScript(''); setMoveSuccess(false); setError(null); setAnalysis(null);
    setBriefLoading(true);
    try {
      const res = await fetch(`${API}/brief/${briefSummary.id}`, { headers: authHeaders() });
      const data = await res.json();
      if (data.success) {
        const cleanScript = cleanBriefScript(data.brief.description || '');
        setSelectedBrief(data.brief); setOriginalScript(cleanScript);
        if (cleanScript.length > 10) {
          setAnalysisLoading(true);
          try {
            const a = await fetch(`${API}/analyze`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ script: cleanScript }) });
            const ad = await a.json();
            if (ad.success) setAnalysis(ad.analysis);
          } catch {} finally { setAnalysisLoading(false); }
        }
      } else setError(data.error || 'Failed to load brief');
    } catch { setError('Failed to fetch brief details'); } finally { setBriefLoading(false); }
  };

  // Generate scripts (streaming)
  const handleGenerateScripts = async () => {
    if (!originalScript) return;
    if (scriptAbortRef.current) scriptAbortRef.current.abort();
    const controller = new AbortController();
    scriptAbortRef.current = controller;
    setScriptsLoading(true); setScripts([]); setSelectedScriptIdx(null); setHooks([]); setSelectedHookIdxs(new Set()); setFinalScript(''); setError(null);
    try {
      const ep = generationMode === 'full' ? '/generate-full-scripts' : '/generate-scripts';
      await consumeSSEStream(`${API}${ep}`, { script: originalScript, aggressiveness, similarity, analysis }, {
        onItem: (item) => setScripts((prev) => [...prev, item]),
        onError: (err) => setError(err),
        onDone: () => setScriptsLoading(false),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Failed to generate scripts');
    } finally {
      if (scriptAbortRef.current === controller) setScriptsLoading(false);
    }
  };

  // Generate hooks (streaming)
  const handleGenerateHooks = async () => {
    if (selectedScriptIdx === null || !scripts[selectedScriptIdx]) return;
    if (hookAbortRef.current) hookAbortRef.current.abort();
    const controller = new AbortController();
    hookAbortRef.current = controller;
    setHooksLoading(true); setHooks([]); setSelectedHookIdxs(new Set()); setFinalScript(''); setError(null);
    try {
      await consumeSSEStream(`${API}/generate-hooks`, { body: scripts[selectedScriptIdx].text, aggressiveness }, {
        onItem: (item) => {
          // Normalize hook fields on the fly
          const h = {
            id: item.id || 0,
            text: item.text || '',
            strength: typeof item.strength === 'number' ? item.strength : parseFloat(item.strength) || 5,
            curiosityTrigger: ['Low', 'Medium', 'High'].includes(item.curiosityTrigger) ? item.curiosityTrigger : 'Medium',
            clarity: ['Low', 'Medium', 'High'].includes(item.clarity) ? item.clarity : 'Medium',
            scrollStopProbability: ['Weak', 'Moderate', 'Strong'].includes(item.scrollStopProbability) ? item.scrollStopProbability : 'Moderate',
          };
          setHooks((prev) => [...prev, h]);
        },
        onError: (err) => setError(err),
        onDone: () => setHooksLoading(false),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Failed to generate hooks');
    } finally {
      if (hookAbortRef.current === controller) setHooksLoading(false);
    }
  };

  // Generate quick hooks directly from source brief (5 hooks, 5 angles)
  const handleGenerateQuickHooks = async () => {
    if (!originalScript) return;
    if (hookAbortRef.current) hookAbortRef.current.abort();
    const controller = new AbortController();
    hookAbortRef.current = controller;
    setHooksLoading(true); setHooks([]); setSelectedHookIdxs(new Set()); setFinalScript(''); setError(null);
    try {
      await consumeSSEStream(`${API}/generate-brief-hooks`, { script: originalScript, aggressiveness, analysis }, {
        onItem: (item) => {
          const h = {
            id: item.id || 0,
            text: item.text || '',
            angle: item.angle || 'Unknown',
            strength: typeof item.strength === 'number' ? item.strength : parseFloat(item.strength) || 5,
            rationale: item.rationale || '',
            scrollStopProbability: ['Weak', 'Moderate', 'Strong'].includes(item.scrollStopProbability) ? item.scrollStopProbability : 'Moderate',
          };
          setHooks((prev) => [...prev, h]);
        },
        onError: (err) => setError(err),
        onDone: () => setHooksLoading(false),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Failed to generate hooks');
    } finally {
      if (hookAbortRef.current === controller) setHooksLoading(false);
    }
  };

  const toggleHook = (idx) => { setSelectedHookIdxs((prev) => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; }); };

  // Build final script
  useEffect(() => {
    if (generationMode === 'full') return;
    if (generationMode === 'quick-hooks') {
      if (!originalScript || selectedHookIdxs.size === 0) { setFinalScript(''); return; }
      const selectedHooks = [...selectedHookIdxs].sort().map((i) => hooks[i]).filter(Boolean);
      // Extract body from original script
      const bodyMatch = originalScript.match(/\bBODY:\s*/i);
      const hooksMatch = originalScript.match(/\bHOOKS?:\s*/i);
      let body = originalScript;
      if (bodyMatch) body = originalScript.slice(bodyMatch.index + bodyMatch[0].length).trim();
      else if (hooksMatch) {
        const lines = originalScript.slice(hooksMatch.index).split('\n');
        const bodyStart = lines.findIndex((l, i) => i > 0 && !l.trim().startsWith('-') && !l.trim().startsWith('•') && l.trim().length > 30);
        if (bodyStart > 0) body = lines.slice(bodyStart).join('\n').trim();
      }
      setFinalScript([
        '--- Hooks ---', '',
        ...selectedHooks.map((h, i) => `Hook ${i + 1} [${h.angle}]:\n${h.text}`),
        '', '--- Body ---', '', body
      ].join('\n'));
      return;
    }
    if (selectedHookIdxs.size === 0 || selectedScriptIdx === null) { setFinalScript(''); return; }
    const h = [...selectedHookIdxs].sort().map((i) => hooks[i]?.text).filter(Boolean);
    const body = scripts[selectedScriptIdx]?.text || '';
    setFinalScript(['--- Hooks ---', '', ...h.map((t, i) => `Hook ${i + 1}:\n${t}`), '', '--- Body ---', '', body].join('\n'));
  }, [selectedHookIdxs, selectedScriptIdx, hooks, scripts, generationMode, originalScript]);

  useEffect(() => {
    if (generationMode === 'full' && selectedScriptIdx !== null) setFinalScript(scripts[selectedScriptIdx]?.text || '');
  }, [generationMode, selectedScriptIdx, scripts]);

  // Auto-collapse analysis once scripts are generated
  useEffect(() => {
    if (scripts.length > 0 && analysis) setAnalysisCollapsed(true);
  }, [scripts.length, analysis]);

  // Arrow key navigation for script selection
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowDown' && scripts.length > 0) {
        e.preventDefault();
        setSelectedScriptIdx((prev) => prev === null ? 0 : Math.min(prev + 1, scripts.length - 1));
      }
      if (e.key === 'ArrowUp' && scripts.length > 0) {
        e.preventDefault();
        setSelectedScriptIdx((prev) => prev === null ? 0 : Math.max(prev - 1, 0));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [scripts.length]);

  // Auto-scroll to hook generator when a script is selected
  useEffect(() => {
    if (selectedScriptIdx !== null && !isFullMode) {
      const timer = setTimeout(() => {
        const el = document.getElementById('hook-generator-section');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [selectedScriptIdx, isFullMode]);

  const handleMoveToBriefAgent = () => { const t = getEffectiveFinalText(); if (!t) return; localStorage.setItem('iterationKing_briefText', t); setMoveSuccess(true); setTimeout(() => navigate('/app/brief-agent'), 1000); };
  const handleCopy = () => { const t = getEffectiveFinalText(); if (!t) return; navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const handleReset = () => {
    if (scriptAbortRef.current) scriptAbortRef.current.abort();
    if (hookAbortRef.current) hookAbortRef.current.abort();
    setSearchQuery(''); setSearchResults([]); setSelectedBrief(null); setOriginalScript(''); setAnalysis(null);
    setScripts([]); setSelectedScriptIdx(null); setHooks([]); setSelectedHookIdxs(new Set());
    setFinalScript(''); setMoveSuccess(false); setError(null); setCopied(false);
    setAggressiveness(5); setSimilarity(5); setGenerationMode('quick-hooks'); setAnalysisCollapsed(false);
    setBriefLoading(false); setAnalysisLoading(false); setScriptsLoading(false); setHooksLoading(false);
    // Session cleared on reset
  };

  const isQuickHooks = generationMode === 'quick-hooks';

  const pipelineSteps = isQuickHooks
    ? ['Source Brief', 'Controls', '5 Hook Variations', 'Final Assembly']
    : isFullMode
      ? ['Source Brief', 'Controls', 'Full Scripts', 'Final Assembly']
      : ['Source Brief', 'Controls', 'Script Variations', 'Hook Generator', 'Final Assembly'];

  const getStepState = (step) => {
    switch (step) {
      case 'Source Brief': return { active: !selectedBrief, done: !!selectedBrief };
      case 'Controls': return { active: !!selectedBrief && scripts.length === 0 && hooks.length === 0, done: isQuickHooks ? hooks.length > 0 : scripts.length > 0 };
      case '5 Hook Variations': return { active: hooks.length > 0 && selectedHookIdxs.size === 0, done: selectedHookIdxs.size > 0 };
      case 'Script Variations': case 'Full Scripts': return { active: scripts.length > 0 && selectedScriptIdx === null, done: selectedScriptIdx !== null };
      case 'Hook Generator': return { active: selectedScriptIdx !== null && selectedHookIdxs.size === 0 && hooks.length === 0, done: selectedHookIdxs.size > 0 };
      case 'Final Assembly': {
        const o = isQuickHooks ? selectedHookIdxs.size > 0 : isFullMode ? selectedScriptIdx !== null : selectedHookIdxs.size > 0;
        return { active: o && !moveSuccess, done: moveSuccess };
      }
      default: return { active: false, done: false };
    }
  };

  const showFinalAssembly = isQuickHooks ? (finalScript && selectedHookIdxs.size > 0) : isFullMode ? selectedScriptIdx !== null : (finalScript && selectedHookIdxs.size > 0);

  return (
    <div className="p-6 pb-24 space-y-0" style={{ background: '#0A0A0A' }}>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center ik-logo-glow">
            <Crown className="w-6 h-6" style={{ color: '#00FF88' }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Iteration King</h1>
            <p className="text-xs mt-0.5" style={{ color: '#666' }}>AI-powered ad script iteration engine</p>
          </div>
        </div>
        <button onClick={handleReset} className="ik-btn-ghost">
          <RotateCcw className="w-3.5 h-3.5" /> Reset
        </button>
      </div>

      {/* ── PIPELINE ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {pipelineSteps.map((step, i) => {
          const { active, done } = getStepState(step);
          return (
            <div key={step} className="flex items-center gap-2 shrink-0">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5" style={{ color: '#222' }} />}
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono uppercase tracking-wider transition-all duration-300 ${active ? 'ik-pipeline-active' : ''}`}
                style={{
                  color: active || done ? '#00FF88' : '#444',
                  background: active ? '#00FF8810' : done ? '#00FF8808' : 'transparent',
                  border: active ? '1px solid #00FF8833' : '1px solid transparent',
                }}>
                {done && !active && <CheckCircle2 className="w-3 h-3" />}
                {active && <div className="w-1.5 h-1.5 rounded-full ik-pulse-dot" />}
                <span>{step}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 rounded-xl flex items-center gap-3" style={{ background: '#EF444411', border: '1px solid #EF444433' }}>
          <AlertCircle className="w-4 h-4 shrink-0" style={{ color: '#EF4444' }} />
          <span className="text-sm flex-1" style={{ color: '#f87171' }}>{typeof error === 'string' ? error : 'An error occurred'}</span>
          <button onClick={() => setError(null)} className="text-xs font-mono px-2 py-1 rounded hover:bg-[#EF444422]" style={{ color: '#EF4444' }}>dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* ═══════════════════════════════════════════════════════ */}
        {/* LEFT PANEL                                            */}
        {/* ═══════════════════════════════════════════════════════ */}
        <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto ik-sidebar-scroll">

          {/* Source Brief */}
          <div className="ik-panel">
            <div className="ik-panel-header">
              <Search className="w-4 h-4" style={{ color: '#00FF88' }} />
              <span>Source Brief</span>
            </div>
            <div className="relative">
              <input type="text" value={searchQuery} onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search ClickUp brief by name or code..."
                className="ik-input" />
              {searchLoading && <Loader2 className="absolute right-3 top-3 w-4 h-4 animate-spin" style={{ color: '#00FF88' }} />}
            </div>

            {searchResults.length > 0 && (
              <div className="mt-2 rounded-lg max-h-60 overflow-y-auto" style={{ background: '#0A0A0A', border: '1px solid #1E1E1E' }}>
                {searchResults.map((r) => (
                  <button key={r.id} onClick={() => handleSelectBrief(r)}
                    className="w-full text-left px-3 py-3 text-sm hover:bg-[#1A1A1A] transition-all"
                    style={{ color: '#E5E5E5', borderBottom: '1px solid #151515' }}>
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-[10px] mt-0.5 font-mono" style={{ color: '#555' }}>{r.status}</div>
                  </button>
                ))}
              </div>
            )}

            {briefLoading && (
              <div className="mt-4 flex items-center gap-2" style={{ color: '#00FF88' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm font-mono">Loading brief...</span>
              </div>
            )}

            {selectedBrief && !briefLoading && (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Lock className="w-3 h-3" style={{ color: '#666' }} />
                  <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: '#666' }}>Source: ClickUp</span>
                  {selectedBrief.url && (
                    <a href={selectedBrief.url} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
                      <ExternalLink className="w-3 h-3" style={{ color: '#555' }} />
                    </a>
                  )}
                  <button onClick={() => { setSelectedBrief(null); setOriginalScript(''); setSearchQuery(''); setAnalysis(null); setScripts([]); setSelectedScriptIdx(null); setHooks([]); setSelectedHookIdxs(new Set()); setFinalScript(''); }}
                    className="ml-auto text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded hover:bg-[#1E1E1E] transition-colors cursor-pointer"
                    style={{ color: '#EF4444', border: '1px solid #EF444433' }}>
                    Clear
                  </button>
                </div>
                <div className="ik-script-box">{originalScript || '(No script content in this brief)'}</div>
              </div>
            )}
          </div>

          {/* Winner Analysis */}
          {(analysisLoading || analysis) && (
            <div className="ik-panel ik-card-enter">
              <div className="ik-panel-header cursor-pointer select-none" onClick={() => analysis && setAnalysisCollapsed(!analysisCollapsed)}>
                <Brain className="w-4 h-4" style={{ color: '#3B82F6' }} />
                <span>Winner Analysis</span>
                {analysis && (
                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-sm font-mono font-bold" style={{ color: (analysis.overallStrength || 0) >= 7 ? '#00FF88' : '#FBBF24', textShadow: `0 0 10px ${(analysis.overallStrength || 0) >= 7 ? '#00FF88' : '#FBBF24'}44` }}>
                      {analysis.overallStrength}/10
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 transition-transform duration-200" style={{ color: '#555', transform: analysisCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} />
                  </div>
                )}
              </div>
              {analysisLoading ? (
                <div className="flex items-center gap-2" style={{ color: '#3B82F6' }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm font-mono">Analyzing winning pattern...</span>
                </div>
              ) : analysis && !analysisCollapsed ? (
                <div className="space-y-3 text-sm">
                  {[
                    { l: 'Hook Mechanism', v: analysis.hookMechanism, c: '#00FF88', b: true },
                    { l: 'Core Angle', v: analysis.coreAngle },
                    { l: 'Emotional Trigger', v: analysis.emotionalTrigger },
                    { l: 'Structure', v: analysis.narrativeStructure, mono: true },
                  ].map((item) => (
                    <div key={item.l}>
                      <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: '#444' }}>{item.l}</div>
                      <p className={item.mono ? 'font-mono text-xs' : 'text-[13px]'} style={{ color: item.c || (item.dim ? '#888' : '#fff'), fontWeight: item.b ? 600 : 400 }}>
                        {item.v}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* Controls */}
          {selectedBrief && (
            <div className="ik-panel">
              <div className="ik-panel-header">
                <SlidersHorizontal className="w-4 h-4" style={{ color: '#9CA3AF' }} />
                <span>Controls</span>
              </div>
              <div className="space-y-6">
                <PowerMeter label="Script Aggressiveness" value={aggressiveness} onChange={setAggressiveness}
                  icon={Flame} color={aggressiveness >= 7 ? '#FF6B00' : '#00FF88'} />
                <PowerMeter label="Similarity to Original" value={similarity} onChange={setSimilarity}
                  icon={Target} color="#3B82F6" />

                <div className="pt-4" style={{ borderTop: '1px solid #1E1E1E' }}>
                  <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: '#444' }}>Generation Mode</span>
                  <div className="flex gap-1 mt-2.5">
                    {[{ key: 'quick-hooks', label: '5 Hooks' }, { key: 'iterate', label: 'Script Body' }, { key: 'full', label: 'Full Script' }].map((m) => (
                      <button key={m.key} onClick={() => { setGenerationMode(m.key); setScripts([]); setHooks([]); setSelectedScriptIdx(null); setSelectedHookIdxs(new Set()); setFinalScript(''); }}
                        className={`flex-1 px-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${generationMode === m.key ? 'ik-mode-active' : 'ik-mode-inactive'}`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={isQuickHooks ? handleGenerateQuickHooks : handleGenerateScripts}
                  disabled={!originalScript || scriptsLoading || hooksLoading}
                  className={`ik-btn-primary w-full ${(scriptsLoading || hooksLoading) ? 'ik-generating' : ''}`}>
                  {(scriptsLoading || hooksLoading) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {isQuickHooks ? 'Generate 5 Hook Variations' : isFullMode ? 'Generate Full Ad Scripts' : 'Generate Script Variations'}
                </button>
                {(scriptsLoading || (isQuickHooks && hooksLoading)) && <AnimatedStatus steps={isQuickHooks ? ['Analyzing winning body...', 'Crafting 5 unique angles...', 'Optimizing hooks...'] : SCRIPT_STEPS} />}
              </div>
            </div>
          )}

          {/* AI Insight Panel */}
          {analysis && scripts.length > 0 && (
            <AIInsightPanel analysis={analysis} scripts={scripts} selectedScriptIdx={selectedScriptIdx} />
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════ */}
        {/* RIGHT PANEL                                           */}
        {/* ═══════════════════════════════════════════════════════ */}
        <div className="lg:col-span-8 space-y-8">

          {/* ── QUICK HOOKS RESULTS ────────────────────────────── */}
          {isQuickHooks && hooksLoading && hooks.length === 0 && (
            <div>
              <div className="flex items-center gap-2 mb-5">
                <Zap className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>Generating 5 Hook Variations...</span>
              </div>
              <div className="grid grid-cols-1 gap-4">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="rounded-xl p-5 ik-skeleton-card" style={{ background: '#111111', border: '1px solid #1E1E1E', animationDelay: `${i * 100}ms` }}>
                    <div className="h-3 w-24 rounded ik-skeleton-line mb-3" />
                    <div className="h-3 w-full rounded ik-skeleton-line mb-2" />
                    <div className="h-3 w-3/4 rounded ik-skeleton-line" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {isQuickHooks && hooks.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4" style={{ color: '#00FF88' }} />
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                    Hook Variations ({hooks.length})
                  </span>
                </div>
                {selectedHookIdxs.size > 0 && (
                  <span className="text-xs font-semibold" style={{ color: '#00FF88' }}>{selectedHookIdxs.size} hook{selectedHookIdxs.size > 1 ? 's' : ''} selected</span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-4">
                {hooks.map((hook, idx) => {
                  const isSelected = selectedHookIdxs.has(idx);
                  const angleColors = { 'Shock': '#EF4444', 'Curiosity': '#00FF88', 'Authority': '#3B82F6', 'Contrarian': '#FBBF24', 'Social Proof': '#10B981' };
                  const color = angleColors[hook.angle] || '#6B7280';
                  const sspColor = hook.scrollStopProbability === 'Strong' ? '#00FF88' : hook.scrollStopProbability === 'Moderate' ? '#FBBF24' : '#EF4444';
                  return (
                    <div
                      key={idx}
                      onClick={() => toggleHook(idx)}
                      className="rounded-xl p-5 cursor-pointer transition-all"
                      style={{
                        background: isSelected ? '#111' : '#0F0F0F',
                        border: isSelected ? `1px solid ${color}55` : '1px solid #1E1E1E',
                        boxShadow: isSelected ? `0 0 20px ${color}15` : 'none',
                        animation: `slideUp 0.4s ease-out ${idx * 80}ms both`,
                      }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded"
                            style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
                            {hook.angle}
                          </span>
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ background: `${sspColor}15`, color: sspColor }}>
                            {hook.scrollStopProbability}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px]" style={{ color: '#666' }}>Strength</span>
                          <span className="text-sm font-bold" style={{ color: hook.strength >= 7 ? '#00FF88' : hook.strength >= 5 ? '#FBBF24' : '#EF4444' }}>
                            {hook.strength}/10
                          </span>
                          {isSelected && <div className="w-2 h-2 rounded-full" style={{ background: '#00FF88' }} />}
                        </div>
                      </div>
                      <p className="text-sm text-white leading-relaxed mb-2">{hook.text}</p>
                      {hook.rationale && (
                        <p className="text-[11px] italic" style={{ color: '#666' }}>{hook.rationale}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Script Skeleton Loaders */}
          {scriptsLoading && scripts.length === 0 && (
            <div>
              <div className="flex items-center gap-2 mb-5">
                <Zap className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                  {isFullMode ? 'Generating Full Ad Scripts...' : 'Generating Script Variations...'}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="rounded-xl p-5 ik-skeleton-card" style={{ background: '#111111', border: '1px solid #1E1E1E', animationDelay: `${i * 100}ms` }}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-3 w-20 rounded ik-skeleton-line" />
                      <div className="h-4 w-24 rounded ik-skeleton-line" />
                    </div>
                    <div className="space-y-2.5">
                      <div className="h-3 w-full rounded ik-skeleton-line" />
                      <div className="h-3 w-full rounded ik-skeleton-line" style={{ animationDelay: '0.1s' }} />
                      <div className="h-3 w-4/5 rounded ik-skeleton-line" style={{ animationDelay: '0.2s' }} />
                      <div className="h-3 w-full rounded ik-skeleton-line" style={{ animationDelay: '0.3s' }} />
                      <div className="h-3 w-3/5 rounded ik-skeleton-line" style={{ animationDelay: '0.4s' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scripts */}
          {scripts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-5">
                <Zap className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                  {isFullMode ? 'Full Ad Scripts' : 'Script Variations'} ({scripts.length})
                </span>
                {selectedScriptIdx !== null && (
                  <span className="text-[10px] font-mono ml-auto ik-glow-text">Script #{selectedScriptIdx + 1} selected</span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {scripts.map((s, i) => (
                  <ScriptCard key={s.id || i} script={s} index={i} selected={selectedScriptIdx === i} onSelect={() => setSelectedScriptIdx(i)} />
                ))}
              </div>
            </div>
          )}

          {/* Hook Generator */}
          {selectedScriptIdx !== null && !isFullMode && (
            <div id="hook-generator-section" className="ik-panel ik-card-enter">
              <div className="ik-panel-header">
                <Sparkles className="w-4 h-4" style={{ color: '#A78BFA' }} />
                <span>Hook Generator</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: '#333' }}>⌘H to generate</span>
              </div>
              <button onClick={handleGenerateHooks} disabled={hooksLoading}
                className={`ik-btn-secondary w-full ${hooksLoading ? 'ik-generating' : ''}`}>
                {hooksLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Generate Hooks
              </button>
              {hooksLoading && <AnimatedStatus steps={HOOK_STEPS} />}
            </div>
          )}

          {/* Hooks */}
          {hooks.length > 0 && !isFullMode && (
            <div>
              <div className="flex items-center gap-2 mb-5">
                <Sparkles className="w-4 h-4" style={{ color: '#A78BFA' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#9CA3AF' }}>
                  Generated Hooks ({hooks.length})
                </span>
                {selectedHookIdxs.size > 0 && (
                  <span className="text-[10px] font-mono ml-auto ik-glow-text">{selectedHookIdxs.size} hook{selectedHookIdxs.size > 1 ? 's' : ''} selected</span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {hooks.map((h, i) => (
                  <HookCard key={h.id || i} hook={h} index={i} selected={selectedHookIdxs.has(i)} onToggle={() => toggleHook(i)} />
                ))}
              </div>
            </div>
          )}

          {/* Final Assembly */}
          {showFinalAssembly && (
            <div className="ik-panel ik-card-enter" style={{ border: '1px solid #00FF8833', boxShadow: '0 0 40px #00FF8811' }}>
              <div className="ik-panel-header">
                <Target className="w-4 h-4" style={{ color: '#00FF88' }} />
                <span>Final Script Assembly</span>
              </div>
              <textarea value={getEffectiveFinalText()} onChange={(e) => setFinalScript(e.target.value)} rows={12}
                className="ik-input resize-y leading-relaxed" style={{ minHeight: '200px' }} />
              <div className="flex items-center gap-3 mt-5">
                <button onClick={handleMoveToBriefAgent} className={`ik-btn-move ${moveSuccess ? 'ik-btn-move-done' : ''}`}>
                  {moveSuccess ? <><CheckCircle2 className="w-4 h-4" /> Script sent to Brief Agent!</> : <><Rocket className="w-4 h-4" /> Move to Brief Agent</>}
                </button>
                <button onClick={handleCopy} className="ik-btn-ghost" style={{ border: '1px solid #1E1E1E', color: copied ? '#00FF88' : '#9CA3AF' }}>
                  {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {scripts.length === 0 && !scriptsLoading && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6 ik-empty-icon">
                <Crown className="w-10 h-10" style={{ color: '#222' }} />
              </div>
              <h3 className="text-base font-medium" style={{ color: '#444' }}>No scripts generated yet</h3>
              <p className="text-sm mt-1" style={{ color: '#333' }}>
                {selectedBrief ? 'Adjust controls and hit generate' : 'Search and select a winning brief to begin'}
              </p>
              <div className="flex gap-6 mt-8 text-[11px] font-mono" style={{ color: '#2A2A2A' }}>
                <span className="px-2 py-1 rounded" style={{ border: '1px solid #1A1A1A' }}>Cmd+Enter</span>
                <span className="px-2 py-1 rounded" style={{ border: '1px solid #1A1A1A' }}>Cmd+H</span>
                <span className="px-2 py-1 rounded" style={{ border: '1px solid #1A1A1A' }}>Cmd+B</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── STYLES ─────────────────────────────────────────────── */}
      <style>{`
        /* Animations */
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseGlow { 0%, 100% { box-shadow: 0 0 20px #00FF8833, 0 0 40px #00FF8811; } 50% { box-shadow: 0 0 30px #00FF8855, 0 0 60px #00FF8822; } }
        @keyframes pulseDot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.7); } }
        @keyframes borderPulse { 0%, 100% { border-color: #00FF8844; } 50% { border-color: #00FF8888; } }
        @keyframes checkPop { from { transform: scale(0); } to { transform: scale(1); } }
        @keyframes skeletonPulse { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.3; } }

        .ik-card-enter { animation: slideUp 0.4s ease-out both; }
        .ik-selected-glow { animation: pulseGlow 2s ease-in-out infinite; }
        .ik-pulse-dot { background: #00FF88; animation: pulseDot 1.5s ease-in-out infinite; }
        .ik-glow-text { color: #00FF88; text-shadow: 0 0 8px #00FF8844; }
        .ik-check-badge { background: #00FF88; animation: checkPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .ik-generating { animation: borderPulse 1.5s ease-in-out infinite !important; }
        .ik-pipeline-active { animation: borderPulse 2s ease-in-out infinite; }
        .ik-logo-glow { background: #00FF8815; box-shadow: 0 0 24px #00FF8822, 0 0 48px #00FF8811; }

        /* Skeleton */
        .ik-skeleton-card { animation: slideUp 0.4s ease-out both; }
        .ik-skeleton-line { background: #1E1E1E; animation: skeletonPulse 1.5s ease-in-out infinite; }

        /* Panels */
        .ik-panel { background: #111111; border: 1px solid #1E1E1E; border-radius: 16px; padding: 24px; }
        .ik-panel-header { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #9CA3AF; }

        /* Inputs */
        .ik-input { width: 100%; padding: 10px 14px; font-size: 14px; border-radius: 10px; color: #fff; background: #0A0A0A; border: 1px solid #1E1E1E; outline: none; transition: all 0.2s; }
        .ik-input:focus { border-color: #00FF8844; box-shadow: 0 0 0 3px #00FF8815; }
        .ik-input::placeholder { color: #444; }

        /* Script box */
        .ik-script-box { background: #0A0A0A; border: 1px solid #1E1E1E; border-radius: 10px; padding: 14px; max-height: 260px; overflow-y: auto; font-size: 13px; white-space: pre-wrap; line-height: 1.6; color: #E5E5E5; }

        /* Buttons */
        .ik-btn-primary { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 20px; border-radius: 12px; font-size: 14px; font-weight: 700; color: #00FF88; background: linear-gradient(135deg, #00FF8818, #00FF8808); border: 1px solid #00FF8844; box-shadow: 0 0 24px #00FF8822; transition: all 0.3s; cursor: pointer; }
        .ik-btn-primary:hover:not(:disabled) { box-shadow: 0 0 36px #00FF8833; background: linear-gradient(135deg, #00FF8825, #00FF8812); }
        .ik-btn-primary:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; }

        .ik-btn-secondary { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 20px; border-radius: 12px; font-size: 14px; font-weight: 700; color: #A78BFA; background: linear-gradient(135deg, #A78BFA18, #A78BFA08); border: 1px solid #A78BFA44; box-shadow: 0 0 24px #A78BFA22; transition: all 0.3s; cursor: pointer; }
        .ik-btn-secondary:hover:not(:disabled) { box-shadow: 0 0 36px #A78BFA33; }
        .ik-btn-secondary:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; }

        .ik-btn-ghost { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 12px; color: #9CA3AF; background: transparent; border: none; cursor: pointer; transition: all 0.2s; }
        .ik-btn-ghost:hover { color: #fff; background: #1E1E1E; }

        .ik-btn-move { display: flex; align-items: center; gap: 8px; padding: 14px 28px; border-radius: 12px; font-size: 14px; font-weight: 800; color: #0A0A0A; background: linear-gradient(135deg, #00FF88, #00CC6A); border: none; box-shadow: 0 0 36px #00FF8844; cursor: pointer; transition: all 0.3s; }
        .ik-btn-move:hover { box-shadow: 0 0 48px #00FF8866; transform: translateY(-1px); }
        .ik-btn-move-done { background: #16a34a; box-shadow: 0 0 24px #16a34a44; }

        .ik-mode-active { background: #00FF8818; border: 1px solid #00FF8844; color: #00FF88; }
        .ik-mode-inactive { background: #0A0A0A; border: 1px solid #1E1E1E; color: #666; }
        .ik-mode-active:hover, .ik-mode-inactive:hover { opacity: 0.9; }

        .ik-empty-icon { background: #111111; border: 1px solid #1A1A1A; }

        /* Scrollbar */
        .ik-script-box::-webkit-scrollbar, .ik-sidebar-scroll::-webkit-scrollbar { width: 4px; }
        .ik-script-box::-webkit-scrollbar-track, .ik-sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
        .ik-script-box::-webkit-scrollbar-thumb, .ik-sidebar-scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
      `}</style>
    </div>
  );
}
