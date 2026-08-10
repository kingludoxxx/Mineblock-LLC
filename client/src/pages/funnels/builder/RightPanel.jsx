// PAGE BUILDER — right panel.
// Nothing selected  → PAGE settings (title / slug / status / about card).
// Block selected    → STYLE INSPECTOR: breadcrumb chip row (BLOCK > SUB-EL +
//                     block id) and three tabs:
//                       Content  — the block's schema-driven prop editors
//                                  (+ the WIRING section for money blocks)
//                       Style    — breakpoint switch, alignment, size /
//                                  z-index / background / typography
//                       Advanced — margin/padding, custom CSS class,
//                                  desktop/mobile visibility toggles
//
// BREAKPOINTS: the Style and Advanced tabs share ONE Desktop/Mobile switch.
// Desktop writes props.style (the base); Mobile writes props.mobile_styles,
// an override bag with the SAME keys, read second at <= MOBILE_MAX_PX. A key
// absent from mobile_styles inherits — so every mobile field displays what it
// is inheriting instead of an empty box.
//
// props.style is applied on the public page by the server's blockStyleWrap()
// (sanitized) and mirrored on the canvas via styleUtils.styleToCanvas().
// props.mobile_styles is honored in BOTH places: the canvas applies it at the
// mobile device preview, and funnelRender.js emits it as a
// `@media (max-width:767px)` rule from the same sanitizer.
import { useState, useEffect } from 'react';
import { Trash2, Copy, ShieldAlert, AlertTriangle, Info, Plus, ArrowUp, ArrowDown } from 'lucide-react';
import { BLOCK_DEFS } from './blockRegistry';
import {
  FONT_FAMILIES, FONT_WEIGHTS, MOBILE_MAX_PX,
  bagForBreakpoint, styleBag, effectiveStyle, hasMobileOverrides,
} from './styleUtils';
import { BreakpointSwitch, MobileScopeNote, AlignmentControls } from './BreakpointControls';
import VariantPicker from './VariantPicker';
import {
  isSlugCollision,
  listRows, addListRow, removeListRow, moveListRow, setListCell,
  comparisonColumns, addComparisonColumn, renameComparisonColumn,
  removeComparisonColumn, comparisonDefaultRow, moveWouldChangeColumns,
  removeWouldChangeColumns, hiddenColumnKeys, rowsWithHiddenKeys, legacyRowCount,
  unrecognisedProps,
  isoFromLocalInput, localInputFromIso, localInputAnomaly, countdownPreview,
} from './builderModel';
import { AiMediaDialog } from '../../../components/media';

const inputCls =
  'w-full px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';
const labelCls = 'block text-[10px] uppercase tracking-wider text-text-faint mb-1';

// JSON sub-structure editor: local text state so half-typed JSON never
// clobbers the block.
//
// F13. Commits on BLUR, not on every parseable keystroke. Committing per
// keystroke meant every intermediate state that happened to parse was a real
// edit — a history entry AND an autosave — so trimming a `line_items` array
// PATCHed the half-deleted version to the server before the operator had
// finished retyping it, and undo had to be pressed once per character.
//
// The outside re-sync (undo/redo, reorder, restore) is adjusted DURING RENDER
// rather than in an effect — the same pattern PageSettings uses for the slug.
// An effect would render once with the stale text and then immediately
// re-render, which is the cascading render react-hooks/set-state-in-effect
// exists to catch. `edited` is "the operator has uncommitted text", so a
// resync never overwrites work in progress.
function JsonField({ value, onCommit }) {
  const serialized = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(serialized);
  const [lastSeen, setLastSeen] = useState(serialized);
  const [edited, setEdited] = useState(false);
  const [err, setErr] = useState(null);

  if (serialized !== lastSeen) {
    setLastSeen(serialized);
    if (!edited) { setText(serialized); setErr(null); }
  }

  // Invalid JSON is NOT discarded on blur — the operator keeps every character
  // and the message says the block was left alone. Reverting would throw away
  // work whose only sin is being mid-edit.
  const commit = () => {
    if (!edited) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErr(`Invalid JSON — the block was not changed: ${e.message}`);
      return;
    }
    setErr(null);
    setEdited(false);
    const canonical = JSON.stringify(parsed ?? null, null, 2);
    setText(canonical);
    if (canonical !== serialized) onCommit(parsed);
  };

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setEdited(true); setErr(null); }}
        onBlur={commit}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter commits without leaving the field.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
        }}
        spellCheck={false}
        rows={5}
        className={`${inputCls} font-mono text-xs leading-relaxed resize-y`}
      />
      {edited && !err && (
        <div className="mt-1 text-[11px] text-amber-400/90">Click away or press ⌘↵ to apply</div>
      )}
      {err && <div className="mt-1 text-xs text-danger">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repeating OBJECT lists — FAQ / Ranking / Product grid / Comparison rows.
//
// These replace what used to be a raw `json` textarea. The JSON editor is
// still the right tool for a free-shaped bag (row columns, checkout line
// items); it is the wrong tool for a fixed row schema, where it made the
// operator hand-write braces to add one FAQ entry and silently refused the
// whole block on a missing comma.
//
// EVERY MUTATION GOES THROUGH builderModel.js. Those helpers are pure, total
// and node-testable, and they are where the two non-obvious rules live: an
// out-of-range move returns the SAME array (so ↑ on row 1 writes nothing at
// all, rather than recording an empty undo step), and a cleared text cell
// keeps its key (so emptying a comparison cell cannot delete a column).
// ---------------------------------------------------------------------------
function RowCard({ index, count, label, onMove, onRemove, children }) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated/60 p-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">
          {label} {index + 1}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Disabled at the ends rather than hidden: a control that vanishes
              reads as a bug, one that greys out reads as a boundary. */}
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default cursor-pointer"
          >
            <ArrowUp className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="Move down"
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default cursor-pointer"
          >
            <ArrowDown className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            title="Remove"
            className="p-1 rounded text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

function AddRowButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-dashed border-border-default text-xs text-text-muted hover:text-text-primary hover:border-border-strong cursor-pointer"
    >
      <Plus className="w-3 h-3" /> {label}
    </button>
  );
}

function EmptyRows({ what }) {
  return (
    <p className="px-2 py-3 rounded-md border border-dashed border-border-default text-center text-[11px] text-text-faint">
      No {what} yet — this block renders empty on the page until you add one.
    </p>
  );
}

// Amber, not red: everything it reports is survivable and already true of the
// stored data — the point is that it stops being INVISIBLE.
function SeamNote({ children }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// M14. Stored entries this editor cannot represent (nulls, strings, tuple
// arrays from an older format). The RENDERER already drops them, so the page
// loses nothing — but the editor used to drop them from STORED data on the
// first keystroke with no warning at all. Rendered before any write, so the
// operator learns it while the data still exists.
function LegacyRowsNote({ value }) {
  const n = legacyRowCount(value);
  if (!n) return null;
  return (
    <SeamNote>
      {n} stored {n === 1 ? 'entry is' : 'entries are'} in an old format this editor cannot show.
      {' '}The published page already ignores {n === 1 ? 'it' : 'them'}, and {n === 1 ? 'it' : 'they'} will be
      discarded when you edit this block.
    </SeamNote>
  );
}

function RowsField({ field, value, onChange }) {
  const rows = listRows(value);
  const itemFields = Array.isArray(field.itemFields) ? field.itemFields : [];
  const rowLabel = field.rowLabel || 'Item';
  // A helper that returns the SAME array means nothing moved — writing it
  // anyway would push an identical props value through commit() and land an
  // undo step that undoes nothing.
  const write = (next) => { if (next !== rows) onChange(next); };

  return (
    <div className="space-y-2">
      <LegacyRowsNote value={value} />
      {rows.length === 0 && (
        <>
          <EmptyRows what={rowLabel.toLowerCase() + 's'} />
          {/* The per-field notes (which link is sanitized, which is only
              escaped) live on the first row's fields — so with no rows they
              vanished exactly when an operator is deciding what to type. */}
          {itemFields.some((f) => f.help) && (
            <div className="px-2 space-y-1">
              {itemFields.filter((f) => f.help).map((f) => (
                <p key={f.key} className="text-[11px] text-text-faint leading-relaxed">
                  <span className="text-text-muted">{f.label}:</span> {f.help}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {rows.map((row, i) => (
        <RowCard
          key={i}
          index={i}
          count={rows.length}
          label={rowLabel}
          onMove={(d) => write(moveListRow(rows, i, d))}
          onRemove={() => write(removeListRow(rows, i))}
        >
          {itemFields.map((f) => (
            <div key={f.key}>
              <label className={labelCls}>{f.label}</label>
              {/* No onRequestMedia inside a row: the AI Media dialog writes to
                  a TOP-LEVEL prop key, so offering it on a row's image field
                  would drop the URL on the block instead of the row. */}
              <Field
                field={f}
                value={row[f.key]}
                onChange={(v) => write(setListCell(rows, i, f.key, v))}
              />
              {/* Per-field help, shown on the FIRST row only: repeating it on
                  every card would bury the fields it is explaining. */}
              {f.help && i === 0 && <p className="mt-1 text-[11px] text-text-faint">{f.help}</p>}
            </div>
          ))}
        </RowCard>
      ))}
      <AddRowButton
        label={`Add ${rowLabel.toLowerCase()}`}
        onClick={() => onChange(addListRow(rows, field.defaultItem))}
      />
    </div>
  );
}

// Comparison table: the COLUMNS are data. funnelRender.js reads the header set
// off `Object.keys(rows[0])`, so a column is created/renamed/dropped by
// rewriting that key across every row — which is why this editor manages
// columns explicitly instead of leaving the operator to keep N row objects in
// agreement by hand.
function CompareRowsField({ value, onChange }) {
  const rows = listRows(value);
  const cols = comparisonColumns(rows);
  // PER-COLUMN nonce. Bumped when THAT column's rename is refused, and it
  // rides only in that column's key. A single shared counter remounted every
  // column input at once, so refusing a rename in one box destroyed the focus
  // and the uncommitted text in whichever sibling the operator had just
  // clicked into.
  const [refusalNonces, setRefusalNonces] = useState({});
  const bumpRefusal = (col) => setRefusalNonces((m) => ({ ...m, [col]: (m[col] || 0) + 1 }));

  // Prose for a reorder that was BLOCKED because it would have rewritten the
  // published headers.
  //
  // CLEARED WHENEVER THE DATA MOVES, not just on the next successful move.
  // The message names a specific before/after column set, so it stops being
  // true the moment anything is edited — and the edit it most invites (Add
  // column, the remedy the message itself prescribes) used to leave it on
  // screen asserting a column change that no longer applied. Adjusted DURING
  // RENDER, the same pattern PageSettings uses for the slug; an effect would
  // render once with the stale message and then immediately re-render.
  const [moveBlocked, setMoveBlocked] = useState(null);
  const [lastSeenValue, setLastSeenValue] = useState(value);
  if (value !== lastSeenValue) {
    setLastSeenValue(value);
    if (moveBlocked) setMoveBlocked(null);
  }

  const write = (next) => { if (next !== rows) onChange(next); };

  const renameColumn = (from, typed) => {
    const next = renameComparisonColumn(rows, from, typed);
    if (next === rows) {
      // Refused (blank / duplicate / `feature`) or a no-change edit. Either
      // way the STORED name is what must be on screen — so the test is
      // "does the box still hold something other than the stored name?",
      // compared RAW. Comparing trimmed let ' Us ' through: the rename is
      // refused as a duplicate, the trimmed text equals the stored name, no
      // remount fired, and the box kept the padded text it had rejected.
      if (String(typed) !== from) bumpRefusal(from);
      return;
    }
    onChange(next);
  };

  const addColumn = () => {
    // Name it around the CURRENT count and keep going until it is free, so a
    // table that already has a "Column 2" gets "Column 3" rather than silently
    // refusing the click (addComparisonColumn rejects duplicates).
    let n = cols.length + 1;
    while (cols.includes(`Column ${n}`)) n += 1;
    write(addComparisonColumn(rows, `Column ${n}`));
  };

  // Shared prose for both column-changing edits, so a reorder and a delete
  // that do the same damage cannot describe it two different ways.
  const columnChangeMsg = (verb, after) =>
    `That ${verb} would change the published columns from ${cols.join(' / ') || '(none)'} to ` +
    `${comparisonColumns(after).join(' / ') || '(none)'}, because the first row decides the headers. ` +
    `Give the rows matching columns first.`;

  const moveRow = (i, d) => {
    // A reorder is only cosmetic when every row carries the same keys. Row 0
    // IS the header source, so on a heterogeneous table a move can silently
    // change what the published table's columns are. Blocked rather than
    // confirmed: the operator asked to reorder, not to redefine the table.
    if (moveWouldChangeColumns(rows, i, d)) {
      setMoveBlocked(columnChangeMsg('move', moveListRow(rows, i, d)));
      return;
    }
    setMoveBlocked(null);
    write(moveListRow(rows, i, d));
  };

  // M12. The SAME hazard, through the other door. Reordering row 0 was blocked
  // with prose while one trash click on it rewrote every published header
  // silently — two doors to one outcome, guarded unequally. Deleting the LAST
  // row is deliberately NOT blocked: that empties the table, which is a
  // different act and one the empty state already explains.
  const removeRow = (i) => {
    if (removeWouldChangeColumns(rows, i)) {
      setMoveBlocked(columnChangeMsg('delete', removeListRow(rows, i)));
      return;
    }
    setMoveBlocked(null);
    write(removeListRow(rows, i));
  };

  // M13. Keys living on some row that the published table has no header for.
  // The editor drew NOTHING for them, so a legacy row's real content was
  // invisible here and invisible on the page — and the next edit was liable to
  // destroy it. Naming the keys makes "Add column" a usable remedy: adding one
  // by that exact name now PROMOTES the stored values instead of blanking them.
  const hidden = hiddenColumnKeys(rows);
  const hiddenRows = rowsWithHiddenKeys(rows);

  return (
    <div className="space-y-2.5">
      <LegacyRowsNote value={value} />
      {hidden.length > 0 && (
        <SeamNote>
          {hiddenRows} {hiddenRows === 1 ? 'row carries a key' : 'rows carry keys'} the published table does
          not print: <code className="font-mono">{hidden.join(', ')}</code>. Only the first row decides the
          headers. Add a column with the same name to bring {hidden.length === 1 ? 'it' : 'them'} into the
          table — the stored values are kept.
        </SeamNote>
      )}
      <div className="rounded-lg border border-border-default bg-bg-elevated/60 p-2.5 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">
          Columns
        </div>
        {rows.length === 0 ? (
          <p className="text-[11px] text-text-faint leading-relaxed">
            Columns live inside the rows, so there is nowhere to put one yet — add a row first.
            {' '}A table with no rows renders nothing at all on the page.
          </p>
        ) : cols.length === 0 ? (
          <p className="text-[11px] text-text-faint">
            No columns — the table renders with the Feature column alone.
          </p>
        ) : (
          cols.map((c) => (
            // key includes THIS column's nonce so a REJECTED rename remounts
            // only this box and restores the stored name; the name alone would
            // not change on a refusal, so the typed text would survive.
            <div key={`${c}:${refusalNonces[c] || 0}`} className="flex items-center gap-1.5">
              <input
                defaultValue={c}
                onBlur={(e) => renameColumn(c, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                spellCheck={false}
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => write(removeComparisonColumn(rows, c))}
                title={`Remove the ${c} column from every row`}
                className="shrink-0 p-1.5 rounded text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))
        )}
        {rows.length > 0 && <AddRowButton label="Add column" onClick={addColumn} />}
        {/* The snap-back footnote describes renaming a column box. With no
            rows there are no boxes, so it would be explaining a control that
            is not on screen. */}
        {rows.length > 0 && (
          <p className="text-[11px] text-text-faint leading-relaxed">
            A blank name, a duplicate, or the reserved word <code className="font-mono">feature</code> is
            refused and the name snaps back — the published headers can never collide.
          </p>
        )}
      </div>

      {moveBlocked && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{moveBlocked}</span>
        </p>
      )}

      {rows.length === 0 && <EmptyRows what="rows" />}
      {rows.map((row, i) => (
        <RowCard
          key={i}
          index={i}
          count={rows.length}
          label="Row"
          onMove={(d) => moveRow(i, d)}
          onRemove={() => removeRow(i)}
        >
          <div>
            <label className={labelCls}>
              Feature
              {i === 0 && (
                <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">
                  this row sets the headers
                </span>
              )}
            </label>
            <input
              value={row.feature ?? ''}
              onChange={(e) => write(setListCell(rows, i, 'feature', e.target.value))}
              className={inputCls}
            />
          </div>
          {cols.map((c) => (
            <div key={c}>
              <label className={labelCls}>{c}</label>
              <input
                value={row[c] ?? ''}
                onChange={(e) => write(setListCell(rows, i, c, e.target.value))}
                className={inputCls}
              />
            </div>
          ))}
        </RowCard>
      ))}
      <AddRowButton
        label="Add row"
        onClick={() => onChange(addListRow(rows, comparisonDefaultRow(rows)))}
      />
    </div>
  );
}

// Countdown deadline. The picker is LOCAL (that is how an operator thinks
// about "ends Friday at midnight"); the stored prop is a UTC ISO instant,
// which is what funnelRender's emitted runtime feeds to Date.parse. An
// unparseable existing value is NOT rewritten — it is shown verbatim with a
// warning, because silently replacing a deadline is a change to what the page
// promises the buyer.
function DateTimeField({ value, onChange }) {
  // `now` is STATE fed by an interval, not a Date.now() read during render.
  // Reading the clock while rendering is impure — it makes the output depend
  // on when React happened to re-render — and it is also what would let this
  // readout sit on "2h left" long after the deadline passed while the panel
  // stayed open. Ticking it keeps the inspector and the canvas agreeing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Set when the picked wall-clock time is not the one that got stored — the
  // DST gap / ambiguous hour. Detectable only at the moment of the pick,
  // because once stored the instant round-trips cleanly.
  const [dst, setDst] = useState(null);
  const raw = value == null ? '' : String(value);
  const local = localInputFromIso(raw);
  // The PAGE cannot read it only when Date.parse says NaN on the TRIMMED
  // value — the renderer trims at emission, so surrounding whitespace is no
  // longer a failure mode and must not be reported as one.
  const { state, text } = countdownPreview(raw, now);
  const unreadable = state === 'invalid';

  const pick = (typed) => {
    setDst(localInputAnomaly(typed));
    onChange(isoFromLocalInput(typed) || undefined);
  };

  return (
    <div className="space-y-1.5">
      {/* step=60 pins the control to MINUTE resolution, which is what
          localInputAnomaly compares against. Without it a browser may offer a
          seconds spinner, and every value carrying seconds would round-trip
          one component shorter and raise a false DST warning. */}
      <input
        type="datetime-local"
        step={60}
        value={local}
        onChange={(e) => pick(e.target.value)}
        className={inputCls}
      />
      {unreadable ? (
        <p className="flex items-start gap-1.5 text-[11px] text-danger leading-snug">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            The saved deadline <code className="font-mono">{raw}</code> is not a date the page can
            read, so the clock stays blank there. Pick one above to replace it.
          </span>
        </p>
      ) : (
        <p className="text-[11px] text-text-faint font-mono truncate">
          {state === 'unset' && 'No deadline — the clock stays blank on the page.'}
          {state === 'expired' && 'Already passed — the page shows “Offer expired”.'}
          {state === 'live' && `${text} left · stored as ${raw}`}
        </p>
      )}
      {dst && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {/* Says ONLY what the check can actually see. The ambiguous
              fall-back hour round-trips cleanly, so it never reaches here —
              claiming "or happens twice" would advertise a detection that
              does not exist. */}
          <span>
            The clocks change that day and that local time does not exist — it was stored
            as <code className="font-mono">{dst.stored.replace('T', ' ')}</code> instead.
            On the repeated hour after a clock change, the earlier of the two is used.
          </span>
        </p>
      )}
    </div>
  );
}

function Field({ field, value, onChange, onPick, onRequestMedia }) {
  switch (field.kind) {
    case 'rows':
      return <RowsField field={field} value={value} onChange={onChange} />;
    case 'compare_rows':
      return <CompareRowsField value={value} onChange={onChange} />;
    case 'datetime':
      return <DateTimeField value={value} onChange={onChange} />;
    case 'textarea':
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={field.mono ? 5 : 3}
          spellCheck={!field.mono}
          className={`${inputCls} resize-y ${field.mono ? 'font-mono text-xs leading-relaxed' : ''}`}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={value ?? ''}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => {
            // An EMPTIED box clears the prop, in BOTH coerce modes. Without the
            // explicit blank test the float path ran `Number('')`, which is 0
            // and finite — so a cleared score snapped to 0 and could never be
            // emptied again, while the int path (parseInt('') → NaN) cleared
            // correctly. Same control, two behaviours.
            if (e.target.value === '') return onChange(undefined);
            const n = field.coerce === 'int' ? parseInt(e.target.value, 10) : Number(e.target.value);
            onChange(Number.isFinite(n) ? n : undefined);
          }}
          className={inputCls}
        />
      );
    case 'select':
      return (
        <select
          value={value ?? ''}
          onChange={(e) => {
            if (field.coerce === 'int') onChange(parseInt(e.target.value, 10));
            else if (field.coerce === 'bool') onChange(e.target.value === 'true' ? true : undefined);
            else onChange(e.target.value);
          }}
          className={inputCls}
        >
          {(field.options || []).map((o) => (
            <option key={String(o.value)} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'items': {
      const text = Array.isArray(value) ? value.join('\n') : '';
      return (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          onBlur={(e) => onChange(e.target.value.split('\n').filter((s) => s.trim() !== ''))}
          rows={4}
          className={`${inputCls} resize-y`}
        />
      );
    }
    case 'json':
      return <JsonField value={value} onCommit={onChange} />;
    case 'url': {
      const input = (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || 'https://…'}
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
      );
      // Image-bearing url fields (registry `media: 'image'`) get a way to fill
      // themselves that is not "go find a URL somewhere else and paste it".
      // Typing a URL by hand still works and is untouched — this is an extra
      // door, not a replacement.
      if (field.media !== 'image') return input;
      return (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{input}</div>
          <button
            type="button"
            onClick={() => onRequestMedia?.(field)}
            title="Generate an image or pick one from your media library"
            className="shrink-0 px-2 py-1.5 rounded-md border border-border-default bg-bg-elevated text-[11px] text-text-muted hover:text-text-primary hover:border-border-strong cursor-pointer"
          >
            <span aria-hidden="true">✦</span> AI Media
          </button>
        </div>
      );
    }
    case 'checkbox':
      // Unchecked writes `undefined`, which deletes the prop — an unticked
      // block stays byte-identical to one that never had the field, the same
      // posture the style bags take.
      return (
        <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : undefined)}
            className="accent-sky-500"
          />
          {field.checkboxLabel || 'Enabled'}
        </label>
      );
    case 'color':
      return (
        <ColorField label={field.label} value={value} onChange={onChange} hideLabel />
      );
    case 'variant':
      // onPick also fills the DISPLAY price and offer name from the picked
      // variant so the auto-headline has real numbers to work with. Both are
      // labels — the charge is re-priced server-side either way.
      return <VariantPicker value={value} onChange={onChange} onPick={onPick} />;
    default:
      return (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={inputCls}
        />
      );
  }
}

function FieldList({ fields, props, onProp, onFieldFocus, onRequestMedia }) {
  // Picking a variant fills companion DISPLAY props — but only ones the
  // operator has not already written. Overwriting a hand-typed offer name with
  // Shopify's product title would silently undo their copy.
  const onPick = (v) => {
    if (!v) return;
    if (v.price != null && String(v.price).trim() && !String(props.price ?? '').trim()) {
      onProp('price', `$${String(v.price).trim()}`);
    }
    if (v.product_title && !String(props.offer_name ?? '').trim()) {
      onProp('offer_name', String(v.product_title));
    }
  };

  return fields.map((f) => (
    <div key={f.key} onFocusCapture={() => onFieldFocus?.(f.label)}>
      <label className={labelCls}>
        {f.label}
        {f.htmlSink && (
          <span className="ml-1.5 normal-case tracking-normal text-amber-400/90" title="Renders VERBATIM on the public page — scripts included. Previewed sandboxed here.">
            renders verbatim
          </span>
        )}
      </label>
      <Field
        field={f}
        value={props[f.key]}
        onChange={(v) => onProp(f.key, v)}
        onPick={onPick}
        onRequestMedia={onRequestMedia}
      />
      {f.help && <p className="mt-1 text-[11px] text-text-faint">{f.help}</p>}
    </div>
  ));
}

// ---------------------------------------------------------------------------
// Style tab — writes into props.style (merged; empty values delete the key,
// an emptied style object deletes props.style entirely so unstyled blocks
// stay byte-identical on the server).
// ---------------------------------------------------------------------------

// `unsetLabel` is what an unwritten field reads as. On the base bag that is
// 'default'; on mobile it is 'inherit' — a mobile field with no value is NOT
// unstyled, it is taking the desktop value, and saying 'default' there sends
// operators hunting for a value that is already correct.
function StyleSlider({ label, value, min, max, step, unit, defaultValue, onChange, unsetLabel = 'default' }) {
  const set = value != null && value !== '';
  const num = set ? Number(value) : defaultValue;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={`${labelCls} mb-0`}>{label}</label>
        <span className={`text-[11px] font-mono ${set ? 'text-text-primary' : 'text-text-faint'}`}>
          {set ? `${num}${unit || ''}` : unsetLabel}
          {set && (
            <button
              onClick={() => onChange(undefined)}
              className="ml-1.5 text-text-faint hover:text-danger cursor-pointer"
              title="Reset to default"
            >
              ×
            </button>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={num}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500 cursor-pointer"
      />
    </div>
  );
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function ColorField({ label, value, onChange, inherited, hideLabel }) {
  const v = value ?? '';
  // The swatch falls back to the INHERITED colour, not to white — a mobile
  // picker that opens on white when the block is actually navy invites the
  // operator to write an override they did not want.
  const shown = v || (inherited ?? '');
  const swatch = HEX_RE.test(String(shown)) ? String(shown) : '#ffffff';
  return (
    <div>
      {/* Suppressed when a FieldList has already rendered the label above —
          two identical labels read as two different controls. */}
      {!hideLabel && (
        <label className={labelCls}>
          {label}
          {!v && inherited && (
            <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">inheriting {String(inherited)}</span>
          )}
        </label>
      )}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          title={`Pick ${label.toLowerCase()}`}
          className="w-8 h-8 p-0.5 rounded-md border border-border-default bg-bg-elevated cursor-pointer shrink-0"
        />
        <input
          value={v}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={inherited ? `inherit: ${inherited}` : '#ffffff / transparent'}
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
      </div>
    </div>
  );
}

function SizeInput({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={placeholder || 'auto'}
        spellCheck={false}
        className={`${inputCls} font-mono text-xs`}
      />
    </div>
  );
}

function StyleTab({ bp, setBp, props, onStyle }) {
  const isMobile = bp === 'mobile';
  const s = styleBag(props, bp);               // RAW bag for this breakpoint
  const inh = effectiveStyle(props, 'desktop'); // what a blank mobile field inherits
  const set = (key) => (v) => onStyle(key, v);
  // On mobile a field shows its OWN value; the inherited value becomes the
  // placeholder / slider origin so the control starts where the page is.
  const ph = (key, fallback) => (isMobile && inh[key] != null && inh[key] !== '' ? `inherit: ${inh[key]}` : fallback);
  const slideDefault = (key, fallback) => {
    const n = Number(inh[key]);
    return Number.isFinite(n) ? n : fallback;
  };
  const unset = isMobile ? 'inherit' : 'default';
  const overrideCount = Object.keys(styleBag(props, 'mobile')).length;

  return (
    <div className="space-y-3.5">
      <BreakpointSwitch value={bp} onChange={setBp} hasMobile={hasMobileOverrides(props)} />
      {isMobile && (
        <MobileScopeNote overrideCount={overrideCount} onReset={() => onStyle('__clear_bag__')} />
      )}

      <AlignmentControls style={s} inherit={inh} onStyle={onStyle} isMobile={isMobile} />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Size</div>
      <div className="grid grid-cols-2 gap-2">
        <SizeInput label="Width" value={s.width} onChange={set('width')} placeholder={ph('width', 'auto / 100%')} />
        <SizeInput label="Height" value={s.height} onChange={set('height')} placeholder={ph('height', 'auto')} />
        <SizeInput label="Min W" value={s.min_width} onChange={set('min_width')} placeholder={ph('min_width', 'auto')} />
        <SizeInput label="Min H" value={s.min_height} onChange={set('min_height')} placeholder={ph('min_height', 'auto')} />
        <SizeInput label="Max W" value={s.max_width} onChange={set('max_width')} placeholder={ph('max_width', 'auto')} />
        <SizeInput label="Max H" value={s.max_height} onChange={set('max_height')} placeholder={ph('max_height', 'auto')} />
      </div>
      <div>
        <label className={labelCls}>Z-index</label>
        <input
          type="number"
          value={s.z_index ?? ''}
          placeholder={ph('z_index', '')}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            set('z_index')(Number.isFinite(n) ? n : undefined);
          }}
          className={inputCls}
        />
      </div>

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Background</div>
      <ColorField label="Background color" value={s.bg} inherited={isMobile ? inh.bg : undefined} onChange={set('bg')} />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Typography</div>
      <div>
        <label className={labelCls}>
          Font family
          {isMobile && s.font_family == null && inh.font_family && (
            <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">inheriting</span>
          )}
        </label>
        <select value={s.font_family ?? ''} onChange={(e) => set('font_family')(e.target.value || undefined)} className={inputCls}>
          {FONT_FAMILIES.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>
          Weight
          {isMobile && s.font_weight == null && inh.font_weight && (
            <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">inheriting</span>
          )}
        </label>
        <select value={s.font_weight ?? ''} onChange={(e) => set('font_weight')(e.target.value || undefined)} className={inputCls}>
          {FONT_WEIGHTS.map((w) => <option key={w.label} value={w.value}>{w.label}</option>)}
        </select>
      </div>
      <StyleSlider label="Font size" value={s.font_size} min={8} max={96} step={1} unit="px" defaultValue={slideDefault('font_size', 16)} unsetLabel={unset} onChange={set('font_size')} />
      <StyleSlider label="Line height" value={s.line_height} min={0.5} max={3} step={0.05} unit="" defaultValue={slideDefault('line_height', 1.6)} unsetLabel={unset} onChange={set('line_height')} />
      <StyleSlider label="Letter spacing" value={s.letter_spacing} min={-5} max={20} step={0.5} unit="px" defaultValue={slideDefault('letter_spacing', 0)} unsetLabel={unset} onChange={set('letter_spacing')} />
      <ColorField label="Text color" value={s.text_color} inherited={isMobile ? inh.text_color : undefined} onChange={set('text_color')} />
    </div>
  );
}

function AdvancedTab({ bp, setBp, props, onStyle, onBaseStyle }) {
  const isMobile = bp === 'mobile';
  const s = styleBag(props, bp);                // spacing follows the breakpoint
  const base = styleBag(props, 'desktop');      // css_class + visibility are base-only
  const inh = effectiveStyle(props, 'desktop');
  const set = (key) => (v) => onStyle(key, v);
  const setBase = (key) => (v) => onBaseStyle(key, v);
  const ph = (key, fallback) => (isMobile && inh[key] != null && inh[key] !== '' ? `inherit: ${inh[key]}` : fallback);

  return (
    <div className="space-y-3.5">
      <BreakpointSwitch value={bp} onChange={setBp} hasMobile={hasMobileOverrides(props)} />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Spacing</div>
      <SizeInput label="Margin (CSS shorthand)" value={s.margin} onChange={set('margin')} placeholder={ph('margin', '16px 0')} />
      <SizeInput label="Padding (CSS shorthand)" value={s.padding} onChange={set('padding')} placeholder={ph('padding', '24px')} />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">CSS</div>
      <div>
        <label className={labelCls}>Custom CSS class</label>
        <input
          value={base.css_class ?? ''}
          onChange={(e) => setBase('css_class')(e.target.value || undefined)}
          placeholder="my-class"
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
        <p className="mt-1 text-[11px] text-text-faint">
          Added to the block wrapper — style it from the page CSS (Code tab).
          One class for the block, not per breakpoint: write the media query in your CSS.
        </p>
      </div>

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Visibility</div>
      {/* Base-only on purpose: "hide on mobile" is ALREADY a breakpoint
          statement. A per-breakpoint copy would be a second switch on the
          same wire, and the two could disagree. */}
      {[['hide_desktop', `Hide on desktop (≥${MOBILE_MAX_PX + 1}px)`], ['hide_mobile', `Hide on mobile (≤${MOBILE_MAX_PX}px)`]].map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={base[key] === true}
            onChange={(e) => setBase(key)(e.target.checked ? true : undefined)}
            className="accent-sky-500"
          />
          {label}
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block inspector
// ---------------------------------------------------------------------------

const INSPECTOR_TABS = [['content', 'Content'], ['style', 'Style'], ['advanced', 'Advanced']];

function BlockProps({ block, onProp, onDelete, onDuplicate }) {
  const def = BLOCK_DEFS[block.type];
  const props = block.props && typeof block.props === 'object' ? block.props : {};
  const [tab, setTab] = useState('content');
  const [subEl, setSubEl] = useState(null);
  // ONE breakpoint for the whole inspector: switching it on the Style tab and
  // then editing spacing on Advanced must not silently write to the other bag.
  const [bp, setBp] = useState('desktop');

  // Merge-write into ONE style bag (props.style or props.mobile_styles).
  // An emptied bag removes its prop entirely, so a block that carries no
  // overrides stays byte-identical on the server — the same posture the base
  // bag already had, extended to the mobile bag. That is what makes "clear
  // the last mobile override" leave no residue for the renderer to walk.
  const writeBag = (bagKey, key, value) => {
    const cur = props[bagKey] && typeof props[bagKey] === 'object' && !Array.isArray(props[bagKey]) ? props[bagKey] : {};
    // Sentinel from the mobile scope note's Clear button.
    if (key === '__clear_bag__') return onProp(bagKey, undefined);
    const next = { ...cur };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onProp(bagKey, Object.keys(next).length ? next : undefined);
  };

  // Breakpoint-routed write (Style tab fields, Advanced spacing).
  const onStyle = (key, value) => writeBag(bagForBreakpoint(bp), key, value);
  // Always-base write (css_class, visibility toggles).
  const onBaseStyle = (key, value) => writeBag('style', key, value);

  // ── AI Media / library picker ────────────────────────────────────────────
  // ONE dialog instance for the whole inspector, holding the field it was
  // opened for. `mediaField` is the registry field descriptor, so the write
  // target and its companion alt key travel together and the handler needs no
  // knowledge of which block type it is serving.
  const [mediaField, setMediaField] = useState(null);

  // Every key an editor on this block owns — content fields AND wiring fields.
  // The registry is the only source of truth for that, so it is computed here
  // and injected; builderModel stays dependency-free and adds the shared
  // inspector keys (block_name / style / mobile_styles) itself.
  // `legacyProps` are keys with NO editor that the renderer nonetheless READS
  // as a fallback (order_bump.label, product.title — both verified in
  // funnelRender.js). They must not be listed as unrecognised: the notice says
  // the published page ignores what it names, and for these that is false.
  const unrecognised = unrecognisedProps(props, [
    ...(def?.fields || []).map((f) => f.key),
    ...(def?.wiringFields || []).map((f) => f.key),
    ...(def?.legacyProps || []),
  ]);

  const applyMediaAsset = (asset) => {
    if (!mediaField || !asset?.url) return;
    onProp(mediaField.key, asset.url);
    // The alt text describes the IMAGE. Swapping the image makes the old alt
    // wrong, which is worse for a screen reader than no alt at all — so a new
    // asset's alt wins. An asset with NO alt does not blank the operator's own
    // wording; there is nothing better to put there.
    if (mediaField.altKey && asset.alt) onProp(mediaField.altKey, asset.alt);
    setMediaField(null);
  };

  return (
    <div className="p-3 space-y-3.5">
      {/* Breadcrumb chip row — BLOCK > SUB-ELEMENT + block id */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px] font-bold uppercase tracking-wider">
              {block.type}
            </span>
            {tab === 'content' && subEl && (
              <>
                <span className="text-text-faint text-[10px]">›</span>
                <span className="px-1.5 py-0.5 rounded bg-bg-hover text-text-muted text-[10px] font-semibold uppercase tracking-wider">
                  {subEl}
                </span>
              </>
            )}
          </div>
          <div className="text-[10px] text-text-faint font-mono truncate mt-1">{block.id}</div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={onDuplicate} title="Duplicate block" className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer">
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} title="Delete block" className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content | Style | Advanced */}
      <div className="flex rounded-lg border border-border-default overflow-hidden">
        {INSPECTOR_TABS.map(([v, l]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`flex-1 px-2 py-1.5 text-xs font-medium cursor-pointer transition-colors
              ${tab === v ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'content' && (
        <div className="space-y-3.5">
          {/* Shared across EVERY block type — renames the outline entry and
              adds the canvas CSS hook. */}
          <div onFocusCapture={() => setSubEl('label')}>
            <label className={labelCls}>Block name (CSS hook / label)</label>
            <input
              value={props.block_name ?? ''}
              onChange={(e) => onProp('block_name', e.target.value)}
              className={inputCls}
              placeholder="e.g. order_summary"
            />
            <p className="mt-1 text-[11px] text-text-faint leading-relaxed">
              Renames this block in the outline and adds a <code className="font-mono">data-blk-name</code> hook —
              target it in CSS with <code className="font-mono">[data-blk-name=&apos;…&apos;]</code>.
              {' '}The published page emits the same attribute, so the selector matches here and there.
            </p>
          </div>

          {def?.fields?.length ? (
            <FieldList fields={def.fields} props={props} onProp={onProp} onFieldFocus={setSubEl} onRequestMedia={setMediaField} />
          ) : (
            !def?.wiringFields?.length && <p className="text-xs text-text-faint">This block has no editable settings.</p>
          )}

          {/* Props no field owns — almost always an older tool's key names
              (FAQ question/answer, ranking title/desc, grid image_url/link,
              sticky label/url, testimonial text/name, embed code/src). The
              renderer reads none of them, so the block renders empty AND every
              box above opens blank: content in the database, nothing on the
              page, no explanation. Read-only on purpose — guessing that
              `question` means `q` is a data rewrite this panel has no mandate
              to perform. It states the fact; the operator decides. */}
          {unrecognised.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <p className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  Unrecognised props: <code className="font-mono">{unrecognised.join(', ')}</code>.
                  {' '}Nothing on this block reads {unrecognised.length === 1 ? 'it' : 'them'} and the
                  published page ignores {unrecognised.length === 1 ? 'it' : 'them'} — most likely key
                  names from an older builder. Copy the values into the fields above; they are left
                  untouched until you do.
                </span>
              </p>
            </div>
          )}

          {def?.help && (
            <p className="flex items-start gap-1.5 text-[11px] text-text-faint leading-relaxed">
              <Info className="w-3 h-3 mt-0.5 shrink-0" /> {def.help}
            </p>
          )}

          {def?.money && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
              <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold uppercase tracking-wider">
                <ShieldAlert className="w-3.5 h-3.5" /> Wiring — money block
              </div>
              <p className="text-[11px] text-text-faint leading-relaxed">{def.wiringNote}</p>
              {def.wiringFields?.length ? (
                <FieldList fields={def.wiringFields} props={props} onProp={onProp} onFieldFocus={setSubEl} />
              ) : null}
            </div>
          )}
        </div>
      )}

      {tab === 'style' && <StyleTab bp={bp} setBp={setBp} props={props} onStyle={onStyle} />}
      {tab === 'advanced' && (
        <AdvancedTab bp={bp} setBp={setBp} props={props} onStyle={onStyle} onBaseStyle={onBaseStyle} />
      )}

      {/* Generate a new image OR pick an existing one — both hand back the
          same asset object, so this single call site covers both. The dialog
          never closes itself; applyMediaAsset / onClose own that. */}
      <AiMediaDialog
        open={Boolean(mediaField)}
        onClose={() => setMediaField(null)}
        onSelect={applyMediaAsset}
        title={mediaField ? `AI Media — ${mediaField.label}` : 'AI Media'}
      />
    </div>
  );
}

// F7. The slug is the LIVE URL. Autosaving it per keystroke walked a published
// page through /c, /ch, /che… — each one a real PATCH, each one a moment where
// the public URL 404s. It is committed on blur or Enter instead, and a
// published page additionally confirms the old→new move.
//
// F6. The Status dropdown could unpublish a live page in one click with no
// confirmation. Draft→Published stays one click; Published→Draft is the
// destructive direction and asks first, naming the URL that goes dark.
function PageSettings({ meta, onMeta, funnel, blocksCount, saveError, slugRefusal }) {
  // Two sources, deliberately. `saveError` is the live banner — it flags the
  // box the moment the PATCH comes back. `slugRefusal` is the STICKY record
  // the page keeps per field: the refused slug is held out of the dirty set,
  // so once an unrelated save succeeds and clears the banner, this is the only
  // thing left saying the value the operator typed never reached the server.
  const slugTaken = isSlugCollision(saveError) || !!slugRefusal;
  const [slugDraft, setSlugDraft] = useState(meta.slug);
  const [lastSeenSlug, setLastSeenSlug] = useState(meta.slug);

  // Re-sync when the slug changes from OUTSIDE (load, restore, undo).
  //
  // Adjusted DURING RENDER, not in an effect: this is React's own "adjust
  // state when a prop changes" pattern. An effect would render once with the
  // stale draft and then immediately re-render — the cascading render the
  // lint rule exists to catch.
  //
  // The guard is `slugDraft === lastSeenSlug` — "there is no uncommitted
  // edit" — rather than a focus ref. It is pure state (refs may not be read
  // during render), and it is the better question anyway: a half-typed slug
  // must survive an incoming change whether or not the field still has focus.
  if (meta.slug !== lastSeenSlug) {
    setLastSeenSlug(meta.slug);
    if (slugDraft === lastSeenSlug) setSlugDraft(meta.slug);
  }

  const publicUrl = `/f/${funnel?.slug || ''}${meta.slug === '/' ? '' : meta.slug}`;

  const commitSlug = () => {
    const next = slugDraft;
    if (next === meta.slug) return;
    if (meta.status === 'published') {
      const okToMove = window.confirm(
        `This page is PUBLISHED and live.\n\n` +
        `Its URL changes from:\n  ${publicUrl}\nto:\n  /f/${funnel?.slug || ''}${next === '/' ? '' : next}\n\n` +
        `The old URL stops working immediately — any ad or link pointing at it will 404.\n\nChange the slug?`
      );
      if (!okToMove) {
        setSlugDraft(meta.slug); // put the field back
        return;
      }
    }
    // Record it as seen so the render-phase sync does not immediately treat
    // our own write as an outside change and bounce the field back.
    setLastSeenSlug(next);
    onMeta({ slug: next });
  };

  const onStatus = (next) => {
    if (next === meta.status) return;
    if (meta.status === 'published' && next === 'draft') {
      const typed = window.prompt(
        `UNPUBLISH this page?\n\n` +
        `${publicUrl}\n\n` +
        `It goes dark immediately for every visitor, including live ad traffic.\n\n` +
        `Type UNPUBLISH to confirm.`
      );
      if (String(typed || '').trim().toUpperCase() !== 'UNPUBLISH') return;
    }
    onMeta({ status: next });
  };

  return (
    <div className="p-3 space-y-4">
      <div>
        <div className="text-sm font-semibold text-text-primary">Page</div>
        <p className="mt-0.5 text-[11px] text-text-faint">Select a block on the canvas to edit it.</p>
      </div>

      <div className="space-y-3.5">
        <div className="text-[10px] uppercase tracking-widest text-text-faint font-semibold">General</div>
        <div>
          <label className={labelCls}>Page title</label>
          <input value={meta.title} onChange={(e) => onMeta({ title: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Slug</label>
          <input
            value={slugDraft}
            onChange={(e) => setSlugDraft(e.target.value)}
            onBlur={commitSlug}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { e.preventDefault(); setSlugDraft(meta.slug); e.currentTarget.blur(); }
            }}
            spellCheck={false}
            className={`${inputCls} font-mono text-xs ${slugTaken ? 'border-danger' : ''}`}
          />
          <p className="mt-1 text-[11px] text-text-faint font-mono truncate">
            /f/{funnel?.slug}{slugDraft === '/' ? '' : slugDraft}
          </p>
          {slugDraft !== meta.slug && (
            <p className="mt-1 text-[11px] text-amber-400/90">
              Press Enter or click away to apply · Esc to cancel
            </p>
          )}
          {slugTaken ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-danger leading-snug">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                {/* Names BOTH values when we have them. "The server refused the change" alone
                    left the operator to work out which slug is live — and the box above now
                    shows the SERVER's, not the one they typed. */}
                {/* Between the 409 and the next successful save, meta.slug still holds the
                    refused value — naming it as "still at" would call the refused URL live.
                    Only name both values once they actually differ (post-resync). */}
                {slugRefusal?.value && String(slugRefusal.value) !== String(meta.slug)
                  ? <>Another page in this funnel already uses <code className="font-mono">{String(slugRefusal.value)}</code>, so it was refused and this page is still at <code className="font-mono">{meta.slug}</code>. </>
                  : <>Another page in this funnel already uses this slug, so the server refused the change and your previous slug is still live. </>}
                Pick a different one and press Enter — the refused slug is NOT retried on its own,
                which is what keeps your other edits saving normally.
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-text-faint leading-snug">
              Must be unique inside this funnel. If it collides the server refuses the save and keeps the
              old slug — nothing is silently renamed, and the rest of your edits still save.
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select value={meta.status} onChange={(e) => onStatus(e.target.value)} className={inputCls}>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          {meta.status === 'published' && funnel?.status !== 'published' && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              The funnel itself is still {funnel?.status || 'draft'} — the public URL stays dark until the funnel is published from the canvas.
            </p>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-border-subtle">
        <div className="text-[10px] uppercase tracking-wider text-text-faint font-semibold mb-1.5">About this page</div>
        <p className="text-[11px] text-text-faint leading-relaxed">
          {blocksCount} block{blocksCount === 1 ? '' : 's'}. Every block generates its own HTML &amp; CSS — open
          Code to edit it as text, or click any block here. Double-click text on the canvas to edit it in
          place; hover between blocks for the + quick-insert.
        </p>
      </div>
    </div>
  );
}

export default function RightPanel({
  block, meta, funnel, blocksCount, saveError, slugRefusal, propsEpoch = 0,
  onMeta, onProp, onDelete, onDuplicate,
}) {
  return (
    <aside className="w-72 shrink-0 border-l border-border-subtle bg-bg-card overflow-y-auto min-h-0">
      {block ? (
        // `propsEpoch` in the key is how an AI batch that rewrote THIS block
        // discards half-typed prop editors (F13-edge). JsonField commits on
        // blur, so a surviving draft would write the pre-batch value back.
        <BlockProps
          key={`${block.id}:${propsEpoch}`}
          block={block}
          onProp={onProp}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
        />
      ) : (
        <PageSettings
          meta={meta}
          onMeta={onMeta}
          funnel={funnel}
          blocksCount={blocksCount}
          saveError={saveError}
          slugRefusal={slugRefusal}
        />
      )}
    </aside>
  );
}
