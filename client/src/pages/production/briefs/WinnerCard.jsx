import { useState } from 'react';
import { TrendingUp, DollarSign, Target, BarChart3, Layers, Play, Film } from 'lucide-react';

// ---------------------------------------------------------------------------
// Readiness badge config
// ---------------------------------------------------------------------------

const READINESS = {
  ready: { label: 'Ready', bg: 'bg-emerald-500/20', text: 'text-emerald-300' },
  over_iterated: { label: 'Over-iterated', bg: 'bg-amber-500/20', text: 'text-amber-300' },
  not_enough_data: { label: 'Not enough data', bg: 'bg-zinc-500/20', text: 'text-text-faint' },
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
    winner.roas >= 2 ? 'text-emerald-400' : winner.roas >= 1.5 ? 'text-amber-400' : 'text-text-muted';

  return (
    <div
      onClick={() => onSelect?.(winner)}
      className="bg-bg-main border border-border-default rounded-lg p-3.5 space-y-3
                 hover:border-accent/20 hover:shadow-[0_2px_12px_rgba(201,162,39,0.06)]
                 transition-all duration-150 cursor-pointer"
    >
      {/* Thumbnail / Video preview */}
      {winner.thumbnail_url && !imgError && (
        <div className="relative -mx-3.5 -mt-3.5 mb-1">
          <img
            src={winner.thumbnail_url}
            alt={winner.creative_id}
            className="w-full aspect-video object-cover rounded-t-lg"
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
      )}
      {(imgError || !winner.thumbnail_url) && (
        <div className="relative -mx-3.5 -mt-3.5 mb-1">
          <div className="w-full aspect-video rounded-t-lg bg-bg-elevated flex items-center justify-center">
            <Film className="w-8 h-8 text-text-faint" />
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

      {/* Header: creative_id + readiness badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-text-primary">{winner.creative_id}</span>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium ${readiness.bg} ${readiness.text}`}
        >
          {readiness.label}
        </span>
      </div>

      {/* Full naming convention */}
      {winner.ad_name && (
        <p className="text-[10px] text-text-faint leading-snug break-all font-mono">
          {winner.ad_name}
        </p>
      )}

      {/* Angle + Format pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {winner.angle && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/20 text-purple-300">
            {winner.angle}
          </span>
        )}
        {winner.format && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent-muted text-accent-text">
            {winner.format}
          </span>
        )}
      </div>

      {/* Metrics grid 2x2 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1.5 bg-bg-elevated rounded-md px-2 py-1.5">
          <TrendingUp className="w-3 h-3 text-text-faint shrink-0" />
          <div>
            <p className="text-[9px] text-text-faint uppercase tracking-wide">ROAS</p>
            <p className={`text-xs font-semibold ${roasColor}`}>{fmtRoas(winner.roas)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-bg-elevated rounded-md px-2 py-1.5">
          <DollarSign className="w-3 h-3 text-text-faint shrink-0" />
          <div>
            <p className="text-[9px] text-text-faint uppercase tracking-wide">Spend</p>
            <p className="text-xs font-semibold text-text-primary">{fmt$(winner.spend)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-bg-elevated rounded-md px-2 py-1.5">
          <Target className="w-3 h-3 text-text-faint shrink-0" />
          <div>
            <p className="text-[9px] text-text-faint uppercase tracking-wide">CPA</p>
            <p className="text-xs font-semibold text-text-primary">{fmt$(winner.cpa)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-bg-elevated rounded-md px-2 py-1.5">
          <BarChart3 className="w-3 h-3 text-text-faint shrink-0" />
          <div>
            <p className="text-[9px] text-text-faint uppercase tracking-wide">CTR</p>
            <p className="text-xs font-semibold text-text-primary">{fmtPct(winner.ctr)}</p>
          </div>
        </div>
      </div>

      {/* Iterations row */}
      <div className="flex items-center gap-1.5">
        <Layers className="w-3 h-3 text-text-faint shrink-0" />
        <span className="text-[11px] text-text-muted">
          {winner.existing_iterations} iteration{winner.existing_iterations !== 1 ? 's' : ''}
        </span>
        {(() => {
          const codes = typeof winner.iteration_codes === 'string'
            ? (() => { try { return JSON.parse(winner.iteration_codes); } catch { return []; } })()
            : winner.iteration_codes;
          return codes?.length > 0 ? (
            <span className="text-[10px] text-text-faint truncate">
              {codes.join(', ')}
            </span>
          ) : null;
        })()}
      </div>

      {/* Winner reason tag */}
      <div>
        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-bg-elevated text-text-faint">
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
          className="w-full text-xs font-medium py-1.5 rounded-md transition-colors
                     bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
        >
          Generate Iterations
        </button>
      )}
    </div>
  );
}

export default WinnerCard;
