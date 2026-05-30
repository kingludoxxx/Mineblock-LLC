import React from 'react';
import { Globe } from 'lucide-react';

/**
 * FROM LEAGUE column — Phase A SHELL.
 *
 * Renders the column header + a "Coming soon" empty state. Phase B will
 * fill in the data fetch (followed brands → brand_spy.ads), multi-select
 * brand filter chips (persisted in localStorage), and "Use as Reference"
 * actions on each card.
 *
 * Placing this between ReferenceColumn and the standard kanban columns
 * gives the operator a discovery surface for competitor statics without
 * cluttering their own pipeline.
 */
export function FromLeagueColumn() {
  return (
    <div className="flex flex-col min-w-[240px] max-w-[340px] flex-1 relative h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-violet-400 drop-shadow-[0_0_6px_rgba(139,92,246,0.4)]" />
          <span className="text-xs font-mono font-semibold text-white uppercase tracking-[0.15em]">
            From League
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-violet-500/10 text-violet-300 border border-violet-500/25 rounded">
            0
          </span>
        </div>
      </div>

      {/* Body — Phase A empty shell */}
      <div className="flex-1 flex items-center justify-center px-3">
        <div className="text-center space-y-2">
          <Globe className="w-8 h-8 text-zinc-700 mx-auto" />
          <div className="text-xs text-zinc-500 font-mono">
            Coming soon
          </div>
          <div className="text-[10px] text-zinc-600 leading-relaxed max-w-[200px]">
            Statics from brands you follow will appear here, with a brand filter and a one-click "Use as Reference" action.
          </div>
        </div>
      </div>
    </div>
  );
}

export default FromLeagueColumn;
