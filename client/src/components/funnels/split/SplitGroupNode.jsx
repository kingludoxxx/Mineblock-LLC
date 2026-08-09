// CANVAS A/B GROUP NODE — one split test, its arms side by side.
//
// Renders as a single grouped card titled "<handle> A/B" containing every live
// arm: preview, letter, ENTRY badge, and the three tiles the operator scans on
// the canvas (Visitors / CTR / CVR).
//
// TWO DELIBERATE OMISSIONS, both load-bearing:
//
//  1. NO CONNECTION HANDLES. The funnel's flow layout is validated server-side
//     against the funnel's PAGE ids (funnels.js validateFlow rejects any node
//     or edge endpoint that is not one). A handle here would let the operator
//     draw an edge whose endpoint is a split id, and the very next autosave
//     would 400 and take the whole canvas layout with it. Removing the handles
//     makes that unreachable rather than merely unlikely.
//
//  2. THE CAPTION SAYS WHAT THE NUMBERS ARE NOT. "lifetime · not the verdict"
//     is there because a per-arm number on a canvas card is exactly the thing
//     an operator reads as a result. "lifetime" is literal: the canvas fetch
//     windows from the test's created_at, and no exposure can predate the test
//     that minted it, so that window IS the test's whole life — not a trailing
//     30 days. The tiles carry no significance test; the verdict lives in the
//     results modal, and the caption says so.
//
//  CTR % IS A DELIBERATE EM-DASH, NOT A MISSING FEATURE. The reference tool
//  feeds its CTR from page-level lifetime click counters. This platform has
//  none per arm: the split ledger has never recorded a click, and the analytics
//  service's per-arm `submit_rate` is literally `visitors > 0 ? 1 : null`
//  (funnelAnalytics.js) — a constant that would paint a permanent "100.0" on
//  every arm forever. The tile therefore renders DASH until a real per-arm
//  click source exists. A dash is a true statement; 100.0 is not.
import { memo } from 'react';
import { BarChart3, Settings, SlidersHorizontal, Shuffle, Eye } from 'lucide-react';
import { DASH } from './splitApi';
import { splitNodeTitle, armLettersChip, fmtCount, fmtRate1 } from './splitUiCopy';
import usePageThumbnail from '../usePageThumbnail';

const ACCENT = '#22c55e';

function SplitGroupNodeInner({ data, selected }) {
  const { handle, arms = [], onResults, onSetup, onWeights } = data || {};

  const toolbarBtn =
    'p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer';

  return (
    <div
      className="group rounded-xl bg-bg-card border shadow-lg"
      style={{
        borderColor: selected ? ACCENT : `${ACCENT}55`,
        boxShadow: selected ? `0 0 0 1px ${ACCENT}55, 0 8px 24px rgba(0,0,0,0.45)` : undefined,
      }}
    >
      {/* Toolbar — on hover OR select, so it is reachable without selecting.
          Below the group frame (reference look), never over the header. */}
      <div
        className={`absolute -bottom-9 left-0 right-0 flex items-center justify-center transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-bg-elevated border border-border-default shadow-xl nodrag">
          <button className={toolbarBtn} title="Results" onClick={() => onResults?.()}>
            <BarChart3 className="w-3.5 h-3.5" />
          </button>
          <button className={toolbarBtn} title="Split settings" onClick={() => onSetup?.()}>
            <Settings className="w-3.5 h-3.5" />
          </button>
          <button className={toolbarBtn} title="Weights & quick settings" onClick={() => onWeights?.()}>
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Group header */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-t-xl"
        style={{ background: `${ACCENT}1f`, borderBottom: `1px solid ${ACCENT}33` }}
      >
        <Shuffle className="w-3.5 h-3.5 shrink-0" style={{ color: ACCENT }} />
        <span
          className="text-[11px] font-semibold uppercase tracking-wide truncate"
          style={{ color: ACCENT }}
          title={handle ? `This split owns the route /${handle}` : 'This split has no handle yet'}
        >
          {splitNodeTitle(handle)}
        </span>
        <span className="ml-auto text-[10px] text-text-faint">{arms.length} arms</span>
      </div>

      {/* Arms */}
      <div className="flex gap-2 px-3 py-2.5">
        {arms.length === 0 && (
          <div className="w-40 py-6 text-center text-[11px] text-text-faint">No live arms</div>
        )}
        {arms.map((arm) => <ArmTile key={arm.id} arm={arm} />)}
      </div>

      {/* Caption — the honesty marker, verbatim */}
      <div className="px-3">
        <span
          className="text-[10px] font-mono text-text-faint"
          title="Every figure above covers the test's whole life — every day since it was created. No significance test is applied here; the verdict lives in the results modal."
        >
          lifetime · not the verdict
        </span>
      </div>

      {/* Bottom chips. Inside the card frame on purpose: the hover toolbar
          already occupies the strip BELOW the card (-bottom-9), where the
          reference puts these, and two things there would overlap. */}
      <div className="flex items-center justify-center gap-1 px-3 pt-1.5 pb-2">
        <span
          className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase tracking-widest border"
          style={{ background: `${ACCENT}1f`, color: ACCENT, borderColor: `${ACCENT}4d` }}
        >
          Split
        </span>
        <span
          className="px-1 py-0.5 rounded text-[8px] font-mono font-bold uppercase tracking-wide
            bg-bg-elevated border border-border-default text-text-muted whitespace-nowrap"
          title={`${arms.length} ${arms.length === 1 ? 'arm' : 'arms'}`}
        >
          {armLettersChip(arms)}
        </span>
      </div>
    </div>
  );
}

// One arm tile. A component (not inline JSX in the map) because the thumbnail
// hook must run per arm, and hooks cannot live inside a loop body.
function ArmTile({ arm }) {
  const thumbUrl = usePageThumbnail(
    arm.page_id && arm.funnel_id
      ? { id: arm.page_id, funnel_id: arm.funnel_id, updated_at: arm.page_updated_at }
      : null
  );
  return (
    <div
      className="w-40 shrink-0 rounded-lg border bg-bg-elevated/40 overflow-hidden"
      style={{ borderColor: arm.is_entry ? `${ACCENT}66` : 'rgba(255,255,255,0.08)' }}
    >
      {/* Live page thumbnail (placeholder gradient until it lands) + letter +
          entry marker — the badges stay overlaid on top of the image. */}
      <div className="relative h-16 flex items-center justify-center overflow-hidden bg-gradient-to-br from-white/[0.04] to-transparent">
        {thumbUrl && (
          <img src={thumbUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover object-top" />
        )}
        <span className="relative inline-flex items-center justify-center w-7 h-7 rounded-md bg-bg-card/90 border border-border-default text-xs font-bold text-text-primary">
          {arm.letter}
        </span>
        {arm.is_entry ? (
          <span
            className="absolute top-1 left-1 inline-flex items-center gap-1 px-1 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wide border"
            style={{ background: `${ACCENT}26`, color: ACCENT, borderColor: `${ACCENT}4d` }}
            title="Entry arm — served at the bare split route"
          >
            <Shuffle className="w-2.5 h-2.5" /> Entry
          </span>
        ) : (
          <Eye className="absolute top-1 left-1 w-3 h-3 text-text-faint" aria-label="Variant arm" />
        )}
      </div>

      {/* Page identity */}
      <div className="px-2 pt-1.5 min-w-0">
        <div className="text-[11px] text-text-primary truncate">{arm.title || 'No page'}</div>
        <div className="text-[10px] text-text-faint font-mono truncate">{arm.slug || DASH}</div>
      </div>

      {/* Footer metrics — the label carries the unit, so the VALUE never
          repeats it (reference formatting: "12.3" under "CTR %"). */}
      <div className="mt-1.5 grid grid-cols-3 border-t border-border-subtle divide-x divide-[rgba(255,255,255,0.06)]">
        <Tile
          label="Visitors"
          value={fmtCount(arm.visitors)}
          title="Exposures assigned to this arm over the test's lifetime. Bot-inclusive; blank means nothing was recorded, not zero."
        />
        <Tile
          label="CTR %"
          value={fmtRate1(arm.ctr)}
          title="No per-arm click is recorded anywhere on this platform — the split ledger has never seen one, and the analytics service's per-arm submit_rate is a constant. This stays blank rather than showing an invented rate."
        />
        <Tile
          label="CVR %"
          value={fmtRate1(arm.cvr)}
          // Orders is the numerator and a real measurement in both sources; it
          // lost its own tile to the reference's three-tile layout, so it is
          // kept here rather than dropped.
          title={`Conversions ÷ exposures over the test's lifetime. Orders: ${fmtCount(arm.orders)}. Blank means the source withheld it (too small a sample) or recorded nothing — never zero.`}
        />
      </div>
    </div>
  );
}

function Tile({ label, value, title }) {
  return (
    <div className="px-1 py-1 text-center" title={title}>
      <div className="text-[10px] tabular-nums text-text-primary truncate">{value ?? DASH}</div>
      <div className="text-[8px] uppercase tracking-wide text-text-faint">{label}</div>
    </div>
  );
}

export default memo(SplitGroupNodeInner);
