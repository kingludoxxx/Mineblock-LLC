// PAGE BUILDER — left panel: Elements palette | Outline.
import { useState } from 'react';
import { GripVertical, Trash2, Sparkles, CornerDownRight } from 'lucide-react';
import { BLOCK_DEFS, CATEGORIES, PALETTE_ORDER, blockLabel } from './blockRegistry';
import { buildOutline } from './builderModel';

export const DRAG_MIME = 'application/x-puure-block';

function PaletteItem({ type, onAdd }) {
  const def = BLOCK_DEFS[type];
  if (!def) return null;
  const Icon = def.icon;
  if (def.soon) {
    // Visible-disabled: unwired gateway checkouts (Whop-only platform).
    return (
      <button
        disabled
        title="Coming soon — Whop is the only wired gateway"
        className="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border border-border-default bg-bg-elevated
          text-text-faint opacity-50 cursor-not-allowed text-center"
      >
        <Icon className="w-4 h-4" />
        <span className="text-[11px] leading-tight">{def.label}</span>
        <span className="text-[9px] uppercase tracking-wider font-semibold">soon</span>
      </button>
    );
  }
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'new', type }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(type)}
      title={`${def.label} — drag onto the canvas or click to append`}
      className="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border border-border-default bg-bg-elevated
        text-text-muted hover:text-text-primary hover:border-border-strong cursor-grab active:cursor-grabbing
        transition-colors text-center"
    >
      <Icon className="w-4 h-4" />
      <span className="text-[11px] leading-tight">{def.label}</span>
      {def.money && (
        <span className="text-[9px] uppercase tracking-wider text-amber-400/80 font-semibold">money</span>
      )}
    </button>
  );
}

function ElementsTab({ onAdd }) {
  const [aiNote, setAiNote] = useState(false);
  return (
    <div className="p-3 space-y-4 overflow-y-auto">
      {CATEGORIES.map((cat) => (
        <div key={cat.id}>
          <div className="text-[10px] uppercase tracking-widest text-text-faint font-semibold mb-2">{cat.label}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(PALETTE_ORDER[cat.id] || []).map((t) => (
              <PaletteItem key={t} type={t} onAdd={onAdd} />
            ))}
          </div>
        </div>
      ))}

      {/* AI stub — full-width at the palette bottom, per the reference layout.
          It is a STUB and says so: clicking states what is missing rather than
          pretending to generate. The AI Developer panel in the top bar is the
          working surface today. */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <button
          onClick={() => setAiNote((n) => !n)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border-default bg-bg-elevated text-text-muted hover:text-text-primary cursor-pointer text-xs"
        >
          <Sparkles className="w-3.5 h-3.5" /> AI: generate a block
          <span className="ml-auto text-[9px] uppercase tracking-wider text-text-faint">soon</span>
        </button>
        {aiNote && (
          <p className="text-[11px] text-text-faint leading-relaxed px-1">
            Coming with the AI media rollout. Until then, use <strong className="text-text-muted">AI Developer</strong> in
            the top bar — it edits the blocks you already have.
          </p>
        )}
      </div>
    </div>
  );
}

// OUTLINE — the block tree. Rows come from the pure buildOutline() helper
// (builderModel.js), which is what the node harness exercises; this component
// only renders and wires drag/click onto them.
//
// Reordering REUSES THE CANVAS MECHANISM: the same onReorder(from, to) the
// canvas drop handler calls, and the same DRAG_MIME payload, so a row can be
// dragged out of the outline and dropped straight onto the canvas. Nothing
// here is a second implementation of move.
function OutlineTab({ blocks, selectedId, onSelect, onReorder, onDelete }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const rows = buildOutline(blocks, blockLabel);

  return (
    <div className="p-2 overflow-y-auto">
      {!rows.length && (
        <div className="p-4 text-xs text-text-faint text-center">No blocks yet — drag elements onto the canvas.</div>
      )}
      {rows.map((r) => {
        const def = BLOCK_DEFS[r.type];
        const Icon = def?.icon;
        // Child rows (a row block's columns) are labels, not handles: they
        // select the parent and never carry an independent move.
        const draggable = r.movable && !!r.id;
        return (
          <div
            key={r.key}
            draggable={draggable}
            onDragStart={draggable ? (e) => {
              setDragIdx(r.index);
              e.dataTransfer.effectAllowed = 'move';
              // also allow dropping outline rows onto the canvas
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'move', id: r.id }));
            } : undefined}
            onDragEnd={() => { setDragIdx(null); setOverKey(null); }}
            onDragOver={(e) => {
              if (dragIdx === null || !r.movable) return;
              e.preventDefault();
              setOverKey(r.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && r.movable && dragIdx !== r.index) onReorder(dragIdx, r.index);
              setDragIdx(null);
              setOverKey(null);
            }}
            onClick={() => r.id && onSelect(r.id)}
            style={{ paddingLeft: 8 + r.depth * 14 }}
            className={`group flex items-center gap-2 pr-2 py-1.5 rounded-md text-xs mb-0.5
              ${r.id ? 'cursor-pointer' : 'cursor-default'}
              ${selectedId && selectedId === r.id
                ? 'bg-accent/10 text-text-primary border border-accent/40'
                : 'text-text-muted hover:bg-bg-hover border border-transparent'}
              ${overKey === r.key && dragIdx !== null && dragIdx !== r.index
                // F9. moveBlock(from,to) removes THEN inserts, so a block
                // dragged DOWN onto row i lands BELOW that row's occupant
                // (which shifts up), and dragged UP it lands above. A fixed
                // top border claimed "inserts above" in both directions and
                // disagreed with the result half the time.
                ? (dragIdx < r.index ? 'border-b-2 border-b-accent' : 'border-t-2 border-t-accent')
                : ''}`}
          >
            {r.movable
              ? <GripVertical className="w-3 h-3 text-text-faint shrink-0 cursor-grab" />
              : <CornerDownRight className="w-3 h-3 text-text-faint shrink-0" />}
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate flex-1">{r.label}</span>
            <span className="text-[9px] text-text-faint font-mono shrink-0">{r.type}</span>
            {r.movable && r.id && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}
                className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-danger cursor-pointer shrink-0"
                title="Delete block"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function LeftPanel({ blocks, selectedId, onSelect, onAdd, onReorder, onDelete }) {
  const [tab, setTab] = useState('elements');
  return (
    <aside className="w-60 shrink-0 border-r border-border-subtle bg-bg-card flex flex-col min-h-0">
      <div className="flex border-b border-border-subtle shrink-0">
        {[['elements', 'Elements'], ['outline', 'Outline']].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`flex-1 px-3 py-2 text-xs font-medium border-b-2 -mb-px cursor-pointer transition-colors
              ${tab === v ? 'border-accent text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'elements'
          ? <ElementsTab onAdd={onAdd} />
          : <OutlineTab blocks={blocks} selectedId={selectedId} onSelect={onSelect} onReorder={onReorder} onDelete={onDelete} />}
      </div>
    </aside>
  );
}
