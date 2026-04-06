import { useState, useEffect } from 'react';
import {
  X,
  Check,
  ThumbsDown,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Brain,
  Zap,
  Target,
  Shield,
  Loader2,
  Sparkles,
  Save,
  Rocket,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_CONFIG = {
  novelty:    { label: 'Novelty',    icon: Zap,    color: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
  aggression: { label: 'Aggression', icon: Target, color: 'bg-red-500/10 text-red-300 border-red-500/20' },
  coherence:  { label: 'Coherence',  icon: Brain,  color: 'bg-[#c9a84c]/10 text-[#e8d5a3] border-[#c9a84c]/20' },
  overall:    { label: 'Overall',    icon: Shield, color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold mb-3">
      {children}
    </h4>
  );
}

function ScoreCard({ scoreKey, value }) {
  const config = SCORE_CONFIG[scoreKey];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <div className={`flex-1 flex flex-col items-center gap-1 py-3 px-2 rounded-lg border ${config.color}`}>
      <Icon className="w-3.5 h-3.5" />
      <span className="text-lg font-bold leading-none">{value ?? '—'}</span>
      <span className="text-[10px] opacity-70 font-mono uppercase tracking-wider">{config.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BriefDetailModal
// ---------------------------------------------------------------------------

export default function BriefDetailModal({
  brief,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onPush,
  onSave,
  originalScript,
  originalRawScript,
  winAnalysis,
}) {
  const [winAnalysisOpen, setWinAnalysisOpen] = useState(false);
  const [editableHooks, setEditableHooks] = useState([]);
  const [editableBody, setEditableBody] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!brief) return;
    const parsedHooks = (() => {
      if (Array.isArray(brief.hooks)) return brief.hooks;
      if (typeof brief.hooks === 'string') { try { return JSON.parse(brief.hooks); } catch { return []; } }
      return [];
    })();
    setEditableHooks(parsedHooks);
    setEditableBody(brief.body || '');
    setHasChanges(false);
  }, [brief?.id]);

  if (!isOpen || !brief) return null;

  const status = brief.status || 'generated';
  const scores = {
    novelty: brief.novelty_score,
    aggression: brief.aggression_score,
    coherence: brief.coherence_score,
    overall: brief.overall_score,
  };
  const hasScores = Object.values(scores).some((v) => v != null);

  // Parse original script
  const originalHooks = (() => {
    if (!originalScript) return [];
    let obj = originalScript;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return []; } }
    if (Array.isArray(obj.hooks)) return obj.hooks;
    if (Array.isArray(obj)) return obj;
    return [];
  })();

  const originalBody = (() => {
    if (!originalScript) return null;
    let obj = originalScript;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
    return obj.body || obj.script || obj.text || null;
  })();

  const handleEnhance = async () => {
    setEnhancing(true);
    try {
      const { data } = await api.post(`/brief-pipeline/generated/${brief.id}/enhance`, {
        instruction: enhancePrompt,
        currentHooks: editableHooks,
        currentBody: editableBody,
      });
      if (data.hooks) setEditableHooks(data.hooks);
      if (data.body) setEditableBody(data.body);
      setHasChanges(true);
      setEnhancePrompt('');
    } catch (err) {
      console.error('Enhance failed:', err);
    } finally {
      setEnhancing(false);
    }
  };

  const parsedWinAnalysis = (() => {
    if (!winAnalysis) return null;
    if (typeof winAnalysis === 'object') return winAnalysis;
    try { return JSON.parse(winAnalysis); } catch { return null; }
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        className="relative w-[500px] h-full bg-[#111113] border-l border-white/[0.06] shadow-2xl flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Brief Detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Naming convention */}
          {brief.naming_convention && (
            <section>
              <SectionLabel>Naming Convention</SectionLabel>
              <div className="glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02]">
                <p className="font-mono text-xs text-zinc-300 leading-relaxed">
                  {brief.naming_convention}
                </p>
              </div>
            </section>
          )}

          {/* Scores */}
          {hasScores && (
            <section>
              <SectionLabel>Scores</SectionLabel>
              <div className="flex gap-2">
                {Object.entries(scores).map(([key, val]) => (
                  <ScoreCard key={key} scoreKey={key} value={val} />
                ))}
              </div>
            </section>
          )}

          {/* Original Script — show raw transcript if available, otherwise parsed hooks/body */}
          {(originalRawScript || originalHooks.length > 0 || originalBody) && (
            <section>
              <SectionLabel>Original Script</SectionLabel>
              <div className="glass-card border border-white/[0.04] rounded-lg p-5 bg-white/[0.02] space-y-4">
                {originalRawScript ? (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{originalRawScript}</p>
                ) : (
                  <>
                    {originalHooks.map((hook, i) => (
                      <div key={i}>
                        <span className="font-mono text-xs text-zinc-500 mr-2">H{i + 1}</span>
                        <span className={`text-sm ${i === 0 ? 'font-medium text-zinc-200' : 'text-zinc-400'} leading-relaxed`}>
                          {typeof hook === 'string' ? hook : hook.text}
                        </span>
                      </div>
                    ))}
                    {originalBody && (
                      <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line">{originalBody}</p>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {/* Hooks (editable) */}
          {editableHooks.length > 0 && (
            <section>
              <SectionLabel>Hooks</SectionLabel>
              <div className="space-y-3">
                {editableHooks.map((hook, i) => {
                  const wordCount = (hook.text || '').trim().split(/\s+/).filter(Boolean).length;
                  const isLong = wordCount > 25;
                  return (
                  <div key={hook.id || i} className={`glass-card border rounded-lg p-4 bg-white/[0.02] ${isLong ? 'border-amber-500/30' : 'border-white/[0.04]'}`}>
                    <div className="flex gap-2 mb-3 items-center">
                      <span className="text-[10px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20">
                        H{i + 1}
                      </span>
                      {hook.mechanism && (
                        <span className="text-[10px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.06]">
                          {hook.mechanism}
                        </span>
                      )}
                      <span className={`ml-auto text-[10px] font-mono ${isLong ? 'text-amber-400' : 'text-zinc-600'}`}>
                        {wordCount}w{isLong ? ' ⚠' : ''}
                      </span>
                    </div>
                    <textarea
                      value={hook.text || ''}
                      onChange={(e) => {
                        const updated = [...editableHooks];
                        updated[i] = { ...updated[i], text: e.target.value };
                        setEditableHooks(updated);
                        setHasChanges(true);
                      }}
                      className="w-full bg-transparent text-sm text-zinc-300 leading-relaxed resize-none focus:outline-none border-0 p-0"
                      rows={3}
                    />
                  </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Body (editable) */}
          {(editableBody || brief.body) && (
            <section>
              <SectionLabel>Body</SectionLabel>
              <textarea
                value={editableBody}
                onChange={(e) => { setEditableBody(e.target.value); setHasChanges(true); }}
                className="w-full h-32 glass-card border border-white/[0.04] rounded-lg p-4 bg-white/[0.02] text-sm text-zinc-300 leading-relaxed resize-none focus:outline-none focus:border-[#c9a84c]/50 focus:ring-1 focus:ring-[#c9a84c]/50 transition-all"
              />
            </section>
          )}

          {/* Enhance with AI */}
          <section className="space-y-2">
            <SectionLabel>Enhance with AI</SectionLabel>
            <div className="flex gap-2">
              <input
                type="text"
                value={enhancePrompt}
                onChange={(e) => setEnhancePrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !enhancing && enhancePrompt.trim() && handleEnhance()}
                placeholder="e.g. 'make hook 1 more aggressive'"
                className="flex-1 bg-white/[0.02] border border-white/[0.05] rounded-lg px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all"
              />
              <button
                type="button"
                onClick={handleEnhance}
                disabled={enhancing || !enhancePrompt.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 cursor-pointer shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #c9a84c, #d4b55a)',
                  color: '#111113',
                }}
              >
                {enhancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Enhance
              </button>
            </div>
          </section>

          {/* Win Analysis */}
          {parsedWinAnalysis && (
            <section>
              <button
                type="button"
                onClick={() => setWinAnalysisOpen(!winAnalysisOpen)}
                className="flex items-center gap-2 font-mono text-xs tracking-[0.15em] uppercase text-[#c9a84c] font-semibold hover:text-[#e8d5a3] transition-colors cursor-pointer"
              >
                {winAnalysisOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Why the Original Won
              </button>

              {winAnalysisOpen && (
                <div className="mt-3 glass-card border border-white/[0.04] rounded-lg p-5 bg-white/[0.02] space-y-4">
                  {/* New 3-agent analysis format */}
                  {parsedWinAnalysis.scriptDna && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-2">
                        Script DNA
                      </span>
                      <div className="space-y-1.5 text-sm text-zinc-400">
                        {parsedWinAnalysis.scriptDna.core_angle && <p><span className="text-zinc-500 font-mono text-xs">Angle:</span> {parsedWinAnalysis.scriptDna.core_angle}</p>}
                        {parsedWinAnalysis.scriptDna.mechanism && <p><span className="text-zinc-500 font-mono text-xs">Mechanism:</span> {parsedWinAnalysis.scriptDna.mechanism}</p>}
                        {parsedWinAnalysis.scriptDna.belief_shift && <p><span className="text-zinc-500 font-mono text-xs">Belief Shift:</span> {parsedWinAnalysis.scriptDna.belief_shift}</p>}
                        {parsedWinAnalysis.scriptDna.why_it_works && <p><span className="text-zinc-500 font-mono text-xs">Why It Works:</span> {parsedWinAnalysis.scriptDna.why_it_works}</p>}
                        {parsedWinAnalysis.scriptDna.what_would_break_it && <p><span className="text-zinc-500 font-mono text-xs">Would Break It:</span> {parsedWinAnalysis.scriptDna.what_would_break_it}</p>}
                      </div>
                    </div>
                  )}

                  {parsedWinAnalysis.psychology?.emotional_arc && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-2">
                        Emotional Arc
                      </span>
                      <div className="flex flex-wrap gap-1 text-xs">
                        {Object.entries(parsedWinAnalysis.psychology.emotional_arc).map(([key, val]) => (
                          <span key={key} className="px-2 py-1 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20">
                            {val}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {parsedWinAnalysis.psychology?.hooks?.length > 0 && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-2">
                        Hook Analysis
                      </span>
                      <div className="space-y-2 text-sm text-zinc-400">
                        {parsedWinAnalysis.psychology.hooks.map((h, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-[10px] font-mono bg-white/[0.04] px-1.5 py-0.5 rounded text-zinc-500 shrink-0 mt-0.5">{h.hook_type || h.type}</span>
                            <span className="text-xs">{h.why_it_works}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {parsedWinAnalysis.iterationRules && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-2">
                        Iteration Rules
                      </span>
                      <div className="space-y-2 text-xs text-zinc-400">
                        {parsedWinAnalysis.iterationRules.must_stay_fixed?.length > 0 && (
                          <div>
                            <span className="text-emerald-400 font-mono">FIXED:</span>{' '}
                            {parsedWinAnalysis.iterationRules.must_stay_fixed.join(' · ')}
                          </div>
                        )}
                        {parsedWinAnalysis.iterationRules.safe_iteration_directions?.length > 0 && (
                          <div>
                            <span className="text-blue-400 font-mono">SAFE DIRS:</span>{' '}
                            {parsedWinAnalysis.iterationRules.safe_iteration_directions.join(' · ')}
                          </div>
                        )}
                        {parsedWinAnalysis.iterationRules.high_risk_changes?.length > 0 && (
                          <div>
                            <span className="text-red-400 font-mono">HIGH RISK:</span>{' '}
                            {parsedWinAnalysis.iterationRules.high_risk_changes.join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Legacy format fallback */}
                  {!parsedWinAnalysis.scriptDna && parsedWinAnalysis.winning_elements_ranked?.length > 0 && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-1.5">
                        Winning Elements
                      </span>
                      <ol className="space-y-1 text-sm text-zinc-400 list-decimal list-inside">
                        {parsedWinAnalysis.winning_elements_ranked.map((el, i) => (
                          <li key={i} className="leading-relaxed">{el}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {!parsedWinAnalysis.scriptDna && parsedWinAnalysis.emotional_driver?.primary && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[#c9a84c] font-semibold block mb-1.5">
                        Emotional Driver
                      </span>
                      <span className="inline-block px-2.5 py-1 text-xs font-medium rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20">
                        {parsedWinAnalysis.emotional_driver.primary}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* Action buttons — pinned to bottom */}
        <div className="p-6 border-t border-white/[0.06] bg-[#111113] space-y-3">
          {hasChanges && (
            <button
              type="button"
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave?.(brief.id, { hooks: editableHooks, body: editableBody });
                  setHasChanges(false);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-40"
              style={{
                background: 'linear-gradient(135deg, #c9a84c, #d4b55a)',
                color: '#111113',
              }}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          )}

          {status === 'generated' && (
            <>
              <button
                type="button"
                onClick={() => onApprove?.(brief.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                           bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40
                           shadow-[0_0_15px_rgba(16,185,129,0.1)] hover:shadow-[0_0_20px_rgba(16,185,129,0.2)]
                           text-sm font-medium transition-all cursor-pointer"
              >
                <Check className="w-4 h-4" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => onReject?.(brief.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                           bg-red-500/5 text-red-400/80 hover:bg-red-500/10 border border-red-500/10 hover:border-red-500/20
                           text-sm font-medium transition-all cursor-pointer"
              >
                <ThumbsDown className="w-4 h-4" />
                Reject
              </button>
            </>
          )}

          {status === 'approved' && (
            <button
              type="button"
              onClick={() => onPush?.(brief.id)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                         bg-white/[0.05] text-white hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/[0.15]
                         text-sm font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer"
            >
              <Rocket className="w-4 h-4" />
              Push to ClickUp
            </button>
          )}

          {status === 'pushed' && brief.clickup_task_url && (
            <a
              href={brief.clickup_task_url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                         bg-white/[0.03] border border-white/[0.06] text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-all"
            >
              <ExternalLink className="w-4 h-4" />
              View in ClickUp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
