import { CheckCircle2, RefreshCw, Rocket, ExternalLink, MoreHorizontal, MessageSquare, Play, Send, Zap, AlertTriangle, Check, Trash2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// GeneratedBriefCard — glass-card style matching Magic Patterns design
// ---------------------------------------------------------------------------

function GeneratedBriefCard({ brief, onApprove, onReject, onPush, onMoveToReady, onDelete, onClick, showActions = 'generated', launchFailed, launchError, onSelectForLaunch, isSelectedForLaunch, metaAdIds }) {
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

  // Derive product and angle labels
  const productLabel = brief.product_code || brief.product_name || brief.parent_creative_id || 'Brief';
  const angleLabel = brief.angle || brief.direction || null;

  return (
    <div className="animated-border-gradient rounded-xl">
      <div
        onClick={() => onClick?.(brief)}
        className="glass-card border border-white/[0.05] rounded-xl p-4 transition-all duration-300 group cursor-pointer flex flex-col gap-3 relative z-10
                   shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:border-white/[0.08]"
      >
        {/* Tag pills */}
        <div className="flex justify-between items-start">
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[9px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.03]">
              {productLabel}
            </span>
            {angleLabel && (
              <span className={`text-[9px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${
                showActions === 'generated'
                  ? 'bg-[#c9a84c]/10 text-[#e8d5a3] border-[#c9a84c]/20'
                  : showActions === 'approved'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : showActions === 'ready_to_launch'
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      : showActions === 'launched'
                        ? 'bg-violet-500/10 text-violet-400 border-violet-500/20'
                        : 'bg-white/[0.06] text-white border-white/[0.08]'
              }`}>
                {angleLabel}
              </span>
            )}
            {brief.rank != null && (
              <span className="text-[9px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                #{brief.rank}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(brief); }}
                className="text-zinc-600 hover:text-red-400 transition-colors cursor-pointer"
                title="Delete brief"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button className="text-zinc-600 hover:text-zinc-300 transition-colors">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Title / Hook preview */}
        <h4 className="text-sm font-medium text-zinc-200 leading-snug">
          {brief.naming_convention || hookPreview || 'Brief'}
        </h4>

        {/* Bottom bar */}
        <div className="flex items-center justify-between mt-1 pt-3 border-t border-white/[0.04]">
          <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
            {brief.duration && (
              <span className="flex items-center gap-1.5">
                <Play className="w-3 h-3" /> {brief.duration}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3" /> {hooks.length}
            </span>
          </div>

          {/* Actions */}
          {showActions === 'pushed' && brief.roas != null ? (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-emerald-400 font-medium">ROAS {Number(brief.roas).toFixed(1)}x</span>
              {brief.spend != null && <span className="text-zinc-500">${Number(brief.spend).toLocaleString()}</span>}
            </div>
          ) : showActions === 'pushed' && brief.clickup_task_url ? (
            <a
              href={brief.clickup_task_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors font-mono uppercase tracking-wide"
            >
              <ExternalLink className="w-3 h-3" />
              ClickUp
            </a>
          ) : (
            <div className="flex items-center gap-1.5">
              {showActions === 'generated' && (
                <>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onReject?.(brief); }}
                    className="w-7 h-7 rounded-md bg-white/[0.03] border border-white/[0.05] flex items-center justify-center text-zinc-400 hover:text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/25 transition-all duration-200 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onApprove?.(brief); }}
                    className="w-7 h-7 rounded-md bg-white/[0.03] border border-white/[0.05] flex items-center justify-center text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/25 transition-all duration-200 cursor-pointer"
                  >
                    <CheckCircle2 className="w-3 h-3" />
                  </button>
                </>
              )}
              {showActions === 'approved' && (
                <>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPush?.(brief); }}
                    className="px-2.5 py-1 rounded-md bg-white/[0.05] text-white text-[10px] font-mono font-semibold hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/[0.15] transition-all duration-200 flex items-center gap-1.5 uppercase tracking-wide cursor-pointer"
                  >
                    <Rocket className="w-3 h-3" /> Push
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onMoveToReady?.(brief); }}
                    className="px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-400 text-[10px] font-mono font-semibold hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/30 transition-all duration-200 flex items-center gap-1.5 uppercase tracking-wide cursor-pointer"
                  >
                    <Send className="w-3 h-3" /> Launch
                  </button>
                </>
              )}
              {showActions === 'ready_to_launch' && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSelectForLaunch?.(); }}
                  className={`w-7 h-7 rounded-md border flex items-center justify-center transition-all duration-200 cursor-pointer ${
                    isSelectedForLaunch
                      ? 'bg-blue-500 border-blue-400 text-white'
                      : 'bg-white/[0.03] border-white/[0.05] text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 hover:border-blue-500/25'
                  }`}
                >
                  <Check className="w-3 h-3" />
                </button>
              )}
              {showActions === 'launched' && metaAdIds?.length > 0 && (
                <span className="text-[10px] font-mono text-violet-400">
                  {metaAdIds.length} ad{metaAdIds.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Pushed date */}
        {showActions === 'pushed' && brief.pushed_at && (
          <p className="text-[10px] text-zinc-600 font-mono">
            Pushed {new Date(brief.pushed_at).toLocaleDateString()}
          </p>
        )}

        {/* Launch failure indicator */}
        {launchFailed && (
          <div className="flex items-center gap-1.5 mt-1 px-2 py-1 rounded bg-red-500/10 border border-red-500/20">
            <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
            <p className="text-[10px] text-red-300 font-mono truncate">{launchError || 'Launch failed'}</p>
          </div>
        )}

        {/* Launched date */}
        {showActions === 'launched' && brief.launched_at && (
          <p className="text-[10px] text-zinc-600 font-mono">
            Launched {new Date(brief.launched_at).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}

export default GeneratedBriefCard;
