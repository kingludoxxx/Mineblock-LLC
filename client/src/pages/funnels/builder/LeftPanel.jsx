// PAGE BUILDER — left panel: Elements palette | Outline.
import { useState } from 'react';
import { GripVertical, Trash2, Sparkles, Bot } from 'lucide-react';
import { BLOCK_DEFS, CATEGORIES, PALETTE_ORDER, blockLabel } from './blockRegistry';

export const DRAG_MIME = 'application/x-puure-block';

function PaletteItem({ type, onAdd }) {
  const def = BLOCK_DEFS[type];
  if (!def) return null;
  const Icon = def.icon;
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

      {/* AI stubs — visible, disabled, coming soon. Do not wire. */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <button
          disabled
          title="Coming soon"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border-default bg-bg-elevated text-text-faint opacity-50 cursor-not-allowed text-xs"
        >
          <Sparkles className="w-3.5 h-3.5" /> AI: generate a block
          <span className="ml-auto text-[9px] uppercase tracking-wider">soon</span>
        </button>
        <button
          disabled
          title="Coming soon"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border-default bg-bg-elevated text-text-faint opacity-50 cursor-not-allowed text-xs"
        >
          <Bot className="w-3.5 h-3.5" /> AI Developer
          <span className="ml-auto text-[9px] uppercase tracking-wider">soon</span>
        </button>
      </div>
    </div>
  );
}

function OutlineTab({ blocks, selectedId, onSelect, onReorder, onDelete }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  return (
    <div className="p-2 overflow-y-auto">
      {!blocks.length && (
        <div className="p-4 text-xs text-text-faint text-center">No blocks yet — drag elements onto the canvas.</div>
      )}
      {blocks.map((b, i) => {
        const def = BLOCK_DEFS[b.type];
        const Icon = def?.icon;
        return (
          <div
            key={b.id}
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = 'move';
              // also allow dropping outline rows onto the canvas
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'move', id: b.id }));
            }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            onDragOver={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              setOverIdx(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onClick={() => onSelect(b.id)}
            className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs mb-0.5
              ${selectedId === b.id ? 'bg-accent/10 text-text-primary border border-accent/40' : 'text-text-muted hover:bg-bg-hover border border-transparent'}
              ${overIdx === i && dragIdx !== null && dragIdx !== i ? 'border-t-2 border-t-accent' : ''}`}
          >
            <GripVertical className="w-3 h-3 text-text-faint shrink-0 cursor-grab" />
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate flex-1">{blockLabel(b)}</span>
            <span className="text-[9px] text-text-faint font-mono shrink-0">{b.type}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(b.id); }}
              className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-danger cursor-pointer shrink-0"
              title="Delete block"
            >
              <Trash2 className="w-3 h-3" />
            </button>
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
