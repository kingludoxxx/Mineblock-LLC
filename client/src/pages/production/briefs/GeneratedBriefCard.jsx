import { Check, X, ExternalLink } from 'lucide-react';

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
        {/* Top row: parent label + rank */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium bg-blue-500/15 text-blue-300 px-1.5 py-0.5 rounded">
            IT of {brief.parent_creative_id}
          </span>
          {brief.rank != null && (
            <span className="text-[11px] font-semibold bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
              #{brief.rank}
            </span>
          )}
        </div>

        {/* Hook preview */}
        {hookPreview && (
          <p className="text-xs text-gray-300 leading-relaxed line-clamp-2">
            &ldquo;{hookPreview}&rdquo;
          </p>
        )}


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
