import { Check, X, ExternalLink, Star, Zap, Brain, Target } from 'lucide-react';

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------

function scoreColor(value) {
  if (value >= 7) return 'bg-emerald-500';
  if (value >= 5) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreTextColor(value) {
  if (value >= 7) return 'text-emerald-400';
  if (value >= 5) return 'text-amber-400';
  return 'text-red-400';
}

const SCORE_BARS = [
  { key: 'novelty_score', label: 'NOV', icon: Star },
  { key: 'aggression_score', label: 'AGG', icon: Zap },
  { key: 'coherence_score', label: 'COH', icon: Brain },
  { key: 'overall_score', label: 'OVR', icon: Target },
];

// ---------------------------------------------------------------------------
// GeneratedBriefCard
// ---------------------------------------------------------------------------

function GeneratedBriefCard({ brief, onApprove, onReject, onPush, onClick, showActions = 'generated' }) {
  const hooks = (() => {
    if (Array.isArray(brief.hooks)) return brief.hooks;
    if (typeof brief.hooks === 'string') { try { return JSON.parse(brief.hooks); } catch { return []; } }
    return [];
  })();
  const hookPreview = hooks[0]?.text
    ? hooks[0].text.length > 80
      ? hooks[0].text.slice(0, 80) + '...'
      : hooks[0].text
    : null;

  return (
    <div
      onClick={() => onClick?.(brief)}
      className="bg-[#0d0d0d] border border-white/[0.06] rounded-lg overflow-hidden cursor-pointer
                 hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/20 transition-all duration-150"
    >
      <div className="p-3 space-y-2">
        {/* Top row: parent label + rank + overall score */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium bg-blue-500/15 text-blue-300 px-1.5 py-0.5 rounded">
            IT of {brief.parent_creative_id}
          </span>
          {brief.rank != null && (
            <span className="text-[11px] font-semibold bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
              #{brief.rank}
            </span>
          )}
          <span className={`ml-auto text-sm font-bold ${scoreTextColor(brief.overall_score)}`}>
            {brief.overall_score?.toFixed(1)}
          </span>
        </div>

        {/* Direction */}
        {brief.iteration_direction && (
          <p className="text-[11px] italic text-gray-500 leading-snug truncate">
            {brief.iteration_direction}
          </p>
        )}

        {/* Hook preview */}
        {hookPreview && (
          <p className="text-xs text-gray-300 leading-relaxed line-clamp-2">
            &ldquo;{hookPreview}&rdquo;
          </p>
        )}

        {/* Score bars */}
        <div className="space-y-1 pt-1">
          {SCORE_BARS.map(({ key, label, icon: Icon }) => {
            const value = brief[key] ?? 0;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <Icon className="w-3 h-3 text-gray-600 shrink-0" />
                <span className="text-[9px] text-gray-500 w-6 shrink-0">{label}</span>
                <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${scoreColor(value)}`}
                    style={{ width: `${(value / 10) * 100}%` }}
                  />
                </div>
                <span className="text-[9px] text-gray-500 w-5 text-right shrink-0">
                  {value.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="pt-1">
          {showActions === 'generated' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onApprove?.(brief); }}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md
                           bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onReject?.(brief); }}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md
                           bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Reject
              </button>
            </div>
          )}

          {showActions === 'approved' && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPush?.(brief); }}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md
                         bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Push to ClickUp
            </button>
          )}

          {showActions === 'pushed' && brief.clickup_task_url && (
            <a
              href={brief.clickup_task_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors py-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View in ClickUp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default GeneratedBriefCard;
