// PAGE BUILDER — center canvas.
// Light buyer-theme surface rendering BlockPreview per block, with:
//   click-to-select · drag-to-reorder · drop-from-palette · hover quick-insert
//   between blocks · double-click inline text editing (heading/text/button).
import { useEffect, useRef, useState } from 'react';
import { Plus, GripVertical, Eye, EyeOff, Copy, Trash2 } from 'lucide-react';
import BlockPreview from './BlockPreview';
import { BLOCK_DEFS, blockLabel } from './blockRegistry';
import { styleToCanvas, hiddenOnDevice } from './styleUtils';
import { blockNameAttr } from './builderModel';
import { DRAG_MIME } from './LeftPanel';

const QUICK_TYPES = ['heading', 'text', 'button', 'image', 'divider', 'spacer', 'section', 'custom_html'];

// F6. Every click in here STOPS PROPAGATING. The strip sits inside the block
// list, whose own onClick deselects — so without this, opening the menu blanked
// the inspector and a freshly inserted block was deselected the instant it
// appeared (insertAt had just selected it).
// `alwaysVisible` drops the hover-reveal. Used on an EMPTY page, where there is
// no block to hover near and this control is the only way to add one.
function QuickInsert({ index, onInsert, disabled, alwaysVisible = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`relative group/qi flex items-center justify-center z-10 ${alwaysVisible ? 'h-8 mt-2' : 'h-2 -my-1'}`}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-transparent group-hover/qi:bg-sky-400/60" />
      <button
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((o) => !o); }}
        title={disabled ? 'Block limit reached' : 'Insert block here'}
        className={`relative transition-opacity w-5 h-5 rounded-full
          ${alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover/qi:opacity-100'}
          bg-sky-500 text-white flex items-center justify-center shadow ${disabled ? 'cursor-not-allowed bg-gray-400' : 'cursor-pointer hover:bg-sky-600'}`}
      >
        <Plus className="w-3 h-3" />
      </button>
      {open && !disabled && (
        <div className="absolute top-4 z-30 bg-bg-card border border-border-default rounded-lg shadow-xl p-1 flex flex-wrap gap-0.5 w-64">
          {QUICK_TYPES.map((t) => {
            const def = BLOCK_DEFS[t];
            const Icon = def.icon;
            return (
              <button
                key={t}
                onClick={(e) => { e.stopPropagation(); onInsert(index, t); setOpen(false); }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <Icon className="w-3 h-3" /> {def.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Inline editor for simple text props — swaps the preview for a textarea on
// double-click; commits on blur / Enter, cancels on Escape.
function InlineEditor({ value, onCommit, onCancel, multiline }) {
  const ref = useRef(null);
  const [text, setText] = useState(value ?? '');
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => onCommit(text);
  return (
    <textarea
      ref={ref}
      value={text}
      rows={multiline ? 3 : 1}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      className="w-full text-sm p-2 rounded-md resize-y focus:outline-none"
      style={{ background: '#fff', color: '#111827', border: '2px solid #38bdf8', fontFamily: 'inherit' }}
    />
  );
}

export default function CanvasArea({
  blocks,
  selectedId,
  onSelect,
  onInsertAt,
  onMove,
  onProp,
  onDuplicate,
  onDelete,
  showOutlines,
  onToggleOutlines,
  device,
  deviceWidth,
  atLimit,
  pageCss,
  paletteAvailable = true,
}) {
  const [dragId, setDragId] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const listRef = useRef(null);

  // Compute insertion index from pointer Y over the block wrappers.
  const indexFromEvent = (e) => {
    const nodes = Array.from(listRef.current?.querySelectorAll('[data-blk-idx]') || []);
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return i;
    }
    return nodes.length;
  };

  const handleDragOver = (e) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragId ? 'move' : 'copy';
    setDropIndex(indexFromEvent(e));
  };

  const handleDrop = (e) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData(DRAG_MIME)); } catch { payload = null; }
    const idx = indexFromEvent(e);
    if (payload?.kind === 'new' && payload.type) {
      if (!atLimit) onInsertAt(idx, payload.type);
    } else if (payload?.kind === 'move' && payload.id) {
      const from = blocks.findIndex((b) => b.id === payload.id);
      if (from !== -1) onMove(from, idx > from ? idx - 1 : idx);
    }
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-bg-main relative" onDragOver={handleDragOver} onDrop={handleDrop} onDragLeave={() => setDropIndex(null)}>
      <div className="py-4 px-4 flex flex-col items-center min-h-full">
        {/* Canvas chips — outlines toggle + block/device counter */}
        <div className="flex items-center gap-2 mb-3 self-center">
          <button
            onClick={onToggleOutlines}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium cursor-pointer transition-colors
              ${showOutlines
                ? 'border-sky-400/60 text-sky-500 bg-sky-400/10'
                : 'border-border-default text-text-faint hover:text-text-primary'}`}
            title="Toggle dashed block outlines on the canvas"
          >
            {showOutlines ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            Outlines: {showOutlines ? 'On' : 'Off'}
          </button>
          <span className="px-2.5 py-1 rounded-full border border-border-default text-[11px] text-text-faint font-medium">
            {blocks.length} block{blocks.length === 1 ? '' : 's'} · {device}
          </span>
        </div>
        {/* Light buyer-theme page surface */}
        <div
          className="transition-all duration-200 shadow-2xl rounded-lg overflow-visible self-center"
          style={{ width: deviceWidth, maxWidth: '100%', background: '#ffffff', minHeight: 480 }}
        >
          <div ref={listRef} className="p-5" onClick={() => onSelect(null)}>
            {!blocks.length && (
              <div
                className="border-2 border-dashed rounded-xl p-12 text-center text-sm"
                style={{ borderColor: '#d1d5db', color: '#9ca3af' }}
              >
                {/* The drag half of this sentence is only TRUE when the
                    Elements rail is on screen — it is replaced by the AI
                    Developer panel, and the prose used to point at a palette
                    that was not there. */}
                {paletteAvailable
                  ? 'Empty page — drag an element here, or use the + below to insert one.'
                  : 'Empty page — use the + below to insert your first block.'}
              </div>
            )}
            {blocks.map((b, i) => {
              const def = BLOCK_DEFS[b.type];
              const selected = selectedId === b.id;
              const inlineProp = def?.inlineEditProp;
              // Style-inspector values mirrored on the canvas. At the mobile
              // device preview this is base ← props.mobile_styles, the same
              // cascade a max-width media query produces on the public page.
              const blkStyle = styleToCanvas(b.props, device);
              const hiddenHere = hiddenOnDevice(b.props, device);
              return (
                <div key={b.id}>
                  <QuickInsert index={i} onInsert={onInsertAt} disabled={atLimit} />
                  {dropIndex === i && <div className="h-0.5 bg-sky-400 rounded-full my-0.5" />}
                  <div
                    data-blk-idx={i}
                    // CSS hook, mirrored from the block-name field. `undefined`
                    // omits the attribute entirely so an unnamed block adds no
                    // selector surface. The PUBLISHED page emits the same
                    // attribute from funnelRender.js blockStyleWrap(), so a
                    // [data-blk-name='…'] rule matches in both places.
                    data-blk-name={blockNameAttr(b.props) || undefined}
                    draggable={editingId !== b.id}
                    onDragStart={(e) => {
                      setDragId(b.id);
                      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'move', id: b.id }));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => { setDragId(null); setDropIndex(null); }}
                    onClick={(e) => { e.stopPropagation(); onSelect(b.id); }}
                    onDoubleClick={(e) => {
                      if (inlineProp) { e.stopPropagation(); onSelect(b.id); setEditingId(b.id); }
                    }}
                    className={`relative group/blk rounded-md transition-shadow ${dragId === b.id ? 'opacity-40' : ''}`}
                    style={{
                      outline: selected
                        ? '2px solid #38bdf8'
                        : showOutlines
                          ? '1px dashed #d1d5db'
                          : '1px solid transparent',
                      outlineOffset: 2,
                      margin: '6px 0',
                      cursor: 'pointer',
                      ...(hiddenHere ? { opacity: 0.35 } : null),
                      ...(blkStyle || null),
                    }}
                  >
                    {/* Hover/selected block toolbar: label + drag handle +
                        duplicate + delete. All three reuse the page's existing
                        block ops — this is chrome, not a second implementation. */}
                    <div
                      className={`absolute -top-2.5 left-1 z-20 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider
                        ${selected ? 'opacity-100' : 'opacity-0 group-hover/blk:opacity-100'}`}
                      style={{ background: '#38bdf8', color: '#fff' }}
                    >
                      <GripVertical className="w-2.5 h-2.5 cursor-grab" />
                      {blockLabel(b)}
                      {hiddenHere && <span className="normal-case tracking-normal">· hidden on {device}</span>}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDuplicate(b.id); }}
                        title="Duplicate block"
                        className="ml-1 p-0.5 rounded hover:bg-white/25 cursor-pointer"
                      >
                        <Copy className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(b.id); }}
                        title="Delete block"
                        className="p-0.5 rounded hover:bg-white/25 cursor-pointer"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    {editingId === b.id && inlineProp ? (
                      <InlineEditor
                        value={b.props?.[inlineProp]}
                        multiline={b.type === 'text'}
                        onCommit={(v) => { onProp(b.id, inlineProp, v); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      // The preview is a PICTURE of the block, never a working
                      // copy of it: pointer-events:none makes the whole subtree
                      // inert so the click always lands on the wrapper above and
                      // selects. Without it, a preview's own controls swallowed
                      // the click — the order bump's card is one big <label>, and
                      // clicking it re-dispatched onto the checkbox instead of
                      // opening the inspector. Nothing in here is interactive by
                      // design (the sandboxed <iframe>s are already inert), so
                      // there is no affordance to lose.
                      <div style={{ pointerEvents: 'none' }}>
                        <BlockPreview block={b} pageCss={pageCss} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* UNGATED. This used to be `blocks.length > 0`, so an EMPTY page
                had no insert control at all — every other QuickInsert renders
                per block. That was survivable while the Elements rail was
                always there to drag from; once the AI panel takes the rail's
                place, an empty page became a dead end with prose telling the
                operator to drag from a palette that is not on screen. */}
            {dropIndex === blocks.length && <div className="h-0.5 bg-sky-400 rounded-full my-0.5" />}
            <QuickInsert
              index={blocks.length}
              onInsert={onInsertAt}
              disabled={atLimit}
              alwaysVisible={!blocks.length}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
