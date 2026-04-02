import { useState } from 'react';
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
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_CONFIG = {
  novelty:    { label: 'Novelty',    icon: Zap,    color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  aggression: { label: 'Aggression', icon: Target, color: 'bg-red-500/20 text-red-300 border-red-500/30' },
  coherence:  { label: 'Coherence',  icon: Brain,  color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  conversion: { label: 'Conversion', icon: Shield, color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
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
  winAnalysis,
}) {
  const [winAnalysisOpen, setWinAnalysisOpen] = useState(false);

  if (!isOpen || !brief) return null;

  const status = brief.status || 'generated';
  const scores = {
    novelty: brief.novelty_score,
    aggression: brief.aggression_score,
    coherence: brief.coherence_score,
    conversion: brief.overall_score,
  };
  const hasScores = Object.values(scores).some((v) => v != null);
  const hooks = (() => {
    if (Array.isArray(brief.hooks)) return brief.hooks;
    if (typeof brief.hooks === 'string') { try { return JSON.parse(brief.hooks); } catch { return []; } }
    return [];
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
                {['novelty', 'aggression', 'coherence', 'conversion'].map((key) => (
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

          {/* Hooks */}
          {hooks.length > 0 && (
            <div>
              <SectionLabel>Hooks</SectionLabel>
              <div className="space-y-2">
                {hooks.map((hook, i) => (
                  <HookCard key={hook.id || i} hook={hook} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Body */}
          {brief.body && (
            <div>
              <SectionLabel>Body</SectionLabel>
              <div className="max-h-80 overflow-y-auto p-4 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                  {brief.body}
                </p>
              </div>
            </div>
          )}

          {/* Win Analysis */}
          {winAnalysis && (
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
                  {winAnalysis.winning_elements_ranked?.length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Winning Elements
                      </span>
                      <ol className="space-y-1 text-sm text-slate-300 list-decimal list-inside">
                        {winAnalysis.winning_elements_ranked.map((el, i) => (
                          <li key={i} className="leading-relaxed">{el}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Emotional driver */}
                  {winAnalysis.emotional_driver?.primary && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Emotional Driver
                      </span>
                      <span className="inline-block px-2.5 py-1 text-xs font-medium rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/25">
                        {winAnalysis.emotional_driver.primary}
                      </span>
                    </div>
                  )}

                  {/* Enemy structure */}
                  {winAnalysis.enemy_structure?.villain && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Enemy / Villain
                      </span>
                      <p className="text-sm text-slate-300">{winAnalysis.enemy_structure.villain}</p>
                    </div>
                  )}

                  {/* Iteration opportunities */}
                  {winAnalysis.iteration_opportunities?.length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                        Iteration Opportunities
                      </span>
                      <ul className="space-y-1 text-sm text-slate-300 list-disc list-inside">
                        {winAnalysis.iteration_opportunities.map((opp, i) => (
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
