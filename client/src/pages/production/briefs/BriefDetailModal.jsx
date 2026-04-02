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
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_CONFIG = {
  novelty:    { label: 'Novelty',    icon: Zap,    color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  aggression: { label: 'Aggression', icon: Target, color: 'bg-red-500/20 text-red-300 border-red-500/30' },
  coherence:  { label: 'Coherence',  icon: Brain,  color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  overall:    { label: 'Overall',    icon: Shield, color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
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
      <span className="text-[10px] opacity-70">{config.label}</span>
    </div>
  );
}

function HookCard({ hook, index }) {
  const label = `H${index + 1}`;
  return (
    <div className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
          {label}
        </span>
        {hook.mechanism && (
          <span className="text-[10px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
            {hook.mechanism}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-300 leading-relaxed">{hook.text}</p>
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
  winAnalysis,
}) {
  const [winAnalysisOpen, setWinAnalysisOpen] = useState(false);
  const [editableHooks, setEditableHooks] = useState([]);
  const [editableBody, setEditableBody] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Initialize editable state (must be before early return to satisfy rules of hooks)
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
  const hooks = (() => {
    if (Array.isArray(brief.hooks)) return brief.hooks;
    if (typeof brief.hooks === 'string') { try { return JSON.parse(brief.hooks); } catch { return []; } }
    return [];
  })();

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

  // Safely parse winAnalysis if it's a JSON string
  const parsedWinAnalysis = (() => {
    if (!winAnalysis) return null;
    if (typeof winAnalysis === 'object') return winAnalysis;
    try { return JSON.parse(winAnalysis); } catch { return null; }
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        className="relative w-[560px] h-full bg-[#0a0a0a] border-l border-white/[0.08] flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* --------------------------------------------------------------- */}
        {/* Header */}
        {/* --------------------------------------------------------------- */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <h2 className="text-sm font-semibold text-white tracking-wide">Brief Detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Scrollable content */}
        {/* --------------------------------------------------------------- */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Naming convention */}
          {brief.naming_convention && (
            <div>
              <SectionLabel>Naming Convention</SectionLabel>
              <p className="text-xs font-mono text-slate-400 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 break-all">
                {brief.naming_convention}
              </p>
            </div>
          )}

          {/* Scores */}
          {hasScores && (
            <div>
              <SectionLabel>Scores</SectionLabel>
              <div className="flex gap-2">
                {['novelty', 'aggression', 'coherence', 'overall'].map((key) => (
                  <ScoreCard key={key} scoreKey={key} value={scores[key]} />
                ))}
              </div>
            </div>
          )}

          {/* Iteration direction */}
          {brief.iteration_direction && (
            <div>
              <SectionLabel>Direction</SectionLabel>
              <p className="text-sm text-slate-300 italic leading-relaxed">
                {brief.iteration_direction}
              </p>
            </div>
          )}

          {/* Original Script (collapsible) */}
          {(originalHooks.length > 0 || originalBody) && (
            <div>
              <SectionLabel>Original Script</SectionLabel>
              <div className="p-3 bg-white/[0.02] border border-white/[0.06] border-l-2 border-l-slate-600 rounded-lg space-y-2 opacity-70">
                {originalHooks.map((hook, i) => (
                  <div key={i} className="text-xs text-slate-500 leading-relaxed">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 mr-1.5">H{i + 1}</span>
                    {typeof hook === 'string' ? hook : hook.text}
                  </div>
                ))}
                {originalBody && (
                  <p className="text-xs text-slate-500 leading-relaxed whitespace-pre-line mt-1">{originalBody}</p>
                )}
              </div>
            </div>
          )}

          {/* Hooks (editable) */}
          {editableHooks.length > 0 && (
            <div>
              <SectionLabel>Hooks</SectionLabel>
              <div className="space-y-2">
                {editableHooks.map((hook, i) => (
                  <div key={hook.id || i} className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                        H{i + 1}
                      </span>
                      {hook.mechanism && (
                        <span className="text-[10px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
                          {hook.mechanism}
                        </span>
                      )}
                    </div>
                    <textarea
                      value={hook.text || ''}
                      onChange={(e) => {
                        const updated = [...editableHooks];
                        updated[i] = { ...updated[i], text: e.target.value };
                        setEditableHooks(updated);
                        setHasChanges(true);
                      }}
                      className="w-full bg-transparent text-sm text-slate-300 leading-relaxed resize-none focus:outline-none border-0 p-0"
                      rows={3}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Body (editable) */}
          {(editableBody || brief.body) && (
            <div>
              <SectionLabel>Body</SectionLabel>
              <div className="p-4 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                <textarea
                  value={editableBody}
                  onChange={(e) => { setEditableBody(e.target.value); setHasChanges(true); }}
                  className="w-full bg-transparent text-sm text-slate-300 leading-relaxed resize-none focus:outline-none"
                  rows={10}
                />
              </div>
            </div>
          )}

          {/* Enhance with AI */}
          <div className="space-y-2">
            <SectionLabel>Enhance with AI</SectionLabel>
            <div className="flex gap-2">
              <input
                type="text"
                value={enhancePrompt}
                onChange={(e) => setEnhancePrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !enhancing && enhancePrompt.trim() && handleEnhance()}
                placeholder="e.g. 'add a hook about scarcity' or 'make hook 1 more aggressive'"
                className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-slate-300 placeholder-slate-600 focus:border-purple-500/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleEnhance}
                disabled={enhancing || !enhancePrompt.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-600 text-sm font-medium text-white hover:bg-purple-500 transition-colors disabled:opacity-40 cursor-pointer shrink-0"
              >
                {enhancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Enhance
              </button>
            </div>
          </div>

          {/* Win Analysis */}
          {parsedWinAnalysis && (
            <div>
              <button
                type="button"
                onClick={() => setWinAnalysisOpen(!winAnalysisOpen)}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold hover:text-slate-300 transition-colors cursor-pointer"
              >
                {winAnalysisOpen ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                Why the Original Won
              </button>

              {winAnalysisOpen && (
                <div className="mt-3 p-4 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-4">
                  {/* Winning elements ranked */}
                  {parsedWinAnalysis.winning_elements_ranked?.length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Winning Elements
                      </span>
                      <ol className="space-y-1 text-sm text-slate-300 list-decimal list-inside">
                        {parsedWinAnalysis.winning_elements_ranked.map((el, i) => (
                          <li key={i} className="leading-relaxed">{el}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Emotional driver */}
                  {parsedWinAnalysis.emotional_driver?.primary && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Emotional Driver
                      </span>
                      <span className="inline-block px-2.5 py-1 text-xs font-medium rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/25">
                        {parsedWinAnalysis.emotional_driver.primary}
                      </span>
                    </div>
                  )}

                  {/* Enemy structure */}
                  {parsedWinAnalysis.enemy_structure?.villain && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Enemy / Villain
                      </span>
                      <p className="text-sm text-slate-300">{parsedWinAnalysis.enemy_structure.villain}</p>
                    </div>
                  )}

                  {/* Iteration opportunities */}
                  {parsedWinAnalysis.iteration_opportunities?.length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Iteration Opportunities
                      </span>
                      <ul className="space-y-1 text-sm text-slate-300 list-disc list-inside">
                        {parsedWinAnalysis.iteration_opportunities.map((opp, i) => (
                          <li key={i} className="leading-relaxed">{opp}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Action buttons — pinned to bottom */}
        {/* --------------------------------------------------------------- */}
        <div className="px-6 py-4 border-t border-white/[0.06] space-y-2 shrink-0">
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
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 transition-colors cursor-pointer disabled:opacity-40"
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
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer"
              >
                <Check className="w-4 h-4" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => onReject?.(brief.id)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/15 border border-red-500/25 text-sm text-red-300 hover:bg-red-500/25 transition-colors cursor-pointer"
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
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 transition-colors cursor-pointer"
            >
              <ExternalLink className="w-4 h-4" />
              Push to ClickUp
            </button>
          )}

          {status === 'pushed' && brief.clickup_task_url && (
            <a
              href={brief.clickup_task_url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-300 hover:bg-white/[0.08] transition-colors"
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
