import { useState } from 'react';
import { TrendingUp, DollarSign, Target, BarChart3, Layers, Play, Film } from 'lucide-react';

// ---------------------------------------------------------------------------
// Readiness badge config
// ---------------------------------------------------------------------------

const READINESS = {
  ready: { label: 'Ready', bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
  over_iterated: { label: 'Over-iterated', bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
  not_enough_data: { label: 'Not enough data', bg: 'bg-white/[0.04]', text: 'text-zinc-500', border: 'border-white/[0.06]' },
};

const REASON_LABELS = {
  high_roas: 'High ROAS',
  volume_winner: 'Volume Winner',
  rising_star: 'Rising Star',
  efficiency_winner: 'Efficiency Winner',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v) {
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtRoas(v) {
  return `${Number(v).toFixed(2)}x`;
}

function fmtPct(v) {
  return `${Number(v).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// WinnerCard
// ---------------------------------------------------------------------------

function WinnerCard({ winner, onSelect, onGenerate, showGenerate = false }) {
  const [imgError, setImgError] = useState(false);
  const readiness = READINESS[winner.iteration_readiness] || READINESS.not_enough_data;
  const reasonLabel = REASON_LABELS[winner.winner_reason] || winner.winner_reason;

  const roasColor =
    winner.roas >= 2 ? 'text-emerald-400' : winner.roas >= 1.5 ? 'text-amber-400' : 'text-zinc-400';

  return (
    <div className="animated-border-gradient rounded-xl">
      <div
        onClick={() => onSelect?.(winner)}
        className="glass-card border border-white/[0.05] rounded-xl overflow-hidden cursor-pointer
                   shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:border-white/[0.08] transition-all duration-300 group"
      >
        {/* Thumbnail / Video preview */}
        {winner.thumbnail_url && !imgError ? (
          <div className="relative">
            <img
              src={winner.thumbnail_url}
              alt={winner.creative_id}
              className="w-full aspect-video object-cover"
              onError={() => setImgError(true)}
            />
            {winner.video_url && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-black/60 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="relative">
            <div className="w-full aspect-video bg-white/[0.02] flex items-center justify-center">
              <Film className="w-8 h-8 text-zinc-700" />
            </div>
            {winner.video_url && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-black/60 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="p-3.5 space-y-3">
          {/* Header: creative_id + readiness badge */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-white">{winner.creative_id}</span>
            <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase tracking-wider border ${readiness.bg} ${readiness.text} ${readiness.border}`}>
              {readiness.label}
            </span>
          </div>

          {/* Full naming convention */}
          {winner.ad_name && (
            <p className="text-[10px] text-zinc-600 leading-snug break-all font-mono">
              {winner.ad_name}
            </p>
          )}

          {/* Angle + Format pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {winner.angle && (
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-medium uppercase tracking-wider bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20">
                {winner.angle}
              </span>
            )}
            {winner.format && (
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-medium uppercase tracking-wider bg-white/[0.04] text-zinc-400 border border-white/[0.06]">
                {winner.format}
              </span>
            )}
          </div>

          {/* Metrics grid 2x2 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-1.5 bg-white/[0.02] border border-white/[0.04] rounded-md px-2 py-1.5">
              <TrendingUp className="w-3 h-3 text-zinc-600 shrink-0" />
              <div>
                <p className="text-[9px] text-zinc-600 font-mono uppercase tracking-wide">ROAS</p>
                <p className={`text-xs font-semibold font-mono ${roasColor}`}>{fmtRoas(winner.roas)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 bg-white/[0.02] border border-white/[0.04] rounded-md px-2 py-1.5">
              <DollarSign className="w-3 h-3 text-zinc-600 shrink-0" />
              <div>
                <p className="text-[9px] text-zinc-600 font-mono uppercase tracking-wide">Spend</p>
                <p className="text-xs font-semibold text-zinc-300 font-mono">{fmt$(winner.spend)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 bg-white/[0.02] border border-white/[0.04] rounded-md px-2 py-1.5">
              <Target className="w-3 h-3 text-zinc-600 shrink-0" />
              <div>
                <p className="text-[9px] text-zinc-600 font-mono uppercase tracking-wide">CPA</p>
                <p className="text-xs font-semibold text-zinc-300 font-mono">{fmt$(winner.cpa)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 bg-white/[0.02] border border-white/[0.04] rounded-md px-2 py-1.5">
              <BarChart3 className="w-3 h-3 text-zinc-600 shrink-0" />
              <div>
                <p className="text-[9px] text-zinc-600 font-mono uppercase tracking-wide">CTR</p>
                <p className="text-xs font-semibold text-zinc-300 font-mono">{fmtPct(winner.ctr)}</p>
              </div>
            </div>
          </div>

          {/* Iterations row */}
          <div className="flex items-center gap-1.5 pt-1 border-t border-white/[0.04]">
            <Layers className="w-3 h-3 text-zinc-600 shrink-0" />
            <span className="text-[11px] text-zinc-500 font-mono">
              {winner.existing_iterations} iteration{winner.existing_iterations !== 1 ? 's' : ''}
            </span>
            {(() => {
              const codes = typeof winner.iteration_codes === 'string'
                ? (() => { try { return JSON.parse(winner.iteration_codes); } catch { return []; } })()
                : winner.iteration_codes;
              return codes?.length > 0 ? (
                <span className="text-[10px] text-zinc-600 truncate font-mono">
                  {codes.join(', ')}
                </span>
              ) : null;
            })()}
          </div>

          {/* Winner reason tag */}
          <div>
            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase tracking-wider bg-white/[0.04] text-zinc-500 border border-white/[0.06]">
              {reasonLabel}
            </span>
          </div>

          {/* Generate button */}
          {showGenerate && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onGenerate?.(winner.id);
              }}
              className="w-full text-xs font-mono font-semibold uppercase tracking-wide py-2 rounded-lg transition-all cursor-pointer
                         bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40
                         shadow-[0_0_10px_rgba(16,185,129,0.08)] hover:shadow-[0_0_15px_rgba(16,185,129,0.15)]"
            >
              Generate Iterations
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default WinnerCard;
