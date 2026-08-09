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
// props.mobile_styles is honored on the CANVAS today; the public renderer
// needs the media-query emitter documented in the delivery report (only the
// integrator edits funnelRender.js).
import { useEffect, useRef, useState } from 'react';
import { Trash2, Copy, ShieldAlert, AlertTriangle, Info } from 'lucide-react';
import { BLOCK_DEFS } from './blockRegistry';
import {
  FONT_FAMILIES, FONT_WEIGHTS, MOBILE_MAX_PX,
  bagForBreakpoint, styleBag, effectiveStyle, hasMobileOverrides,
} from './styleUtils';
import { BreakpointSwitch, MobileScopeNote, AlignmentControls } from './BreakpointControls';
import VariantPicker from './VariantPicker';
import { isSlugCollision } from './builderModel';
import { AiMediaDialog } from '../../../components/media';

const inputCls =
  'w-full px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';
const labelCls = 'block text-[10px] uppercase tracking-wider text-text-faint mb-1';

// JSON sub-structure editor: local text state so half-typed JSON never
// clobbers the block; commits only when the text parses. Resyncs from the
// outside value (undo/redo, reorder) whenever the field is not focused.
function JsonField({ value, onCommit }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(JSON.stringify(value ?? null, null, 2));
      setErr(null);
    }
  }, [value]);

  const onChange = (t) => {
    setText(t);
    try {
      const parsed = JSON.parse(t);
      setErr(null);
      onCommit(parsed);
    } catch (e) {
      setErr(`Invalid JSON: ${e.message}`);
    }
  };

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => {
          focusedRef.current = false;
          if (err) { setText(JSON.stringify(value ?? null, null, 2)); setErr(null); }
        }}
        spellCheck={false}
        rows={5}
        className={`${inputCls} font-mono text-xs leading-relaxed resize-y`}
      />
      {err && <div className="mt-1 text-xs text-danger">{err}</div>}
    </div>
  );
}

function Field({ field, value, onChange, onPick, onRequestMedia }) {
  switch (field.kind) {
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
          onChange={(e) => {
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
              {' '}On the canvas today; the published page needs the matching one-liner in the renderer.
            </p>
          </div>

          {def?.fields?.length ? (
            <FieldList fields={def.fields} props={props} onProp={onProp} onFieldFocus={setSubEl} onRequestMedia={setMediaField} />
          ) : (
            !def?.wiringFields?.length && <p className="text-xs text-text-faint">This block has no editable settings.</p>
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
function PageSettings({ meta, onMeta, funnel, blocksCount, saveError }) {
  const slugTaken = isSlugCollision(saveError);
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
              Another page in this funnel already uses this slug, so the server refused the change and your
              previous slug is still live. Pick a different one — the save retries by itself.
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-text-faint leading-snug">
              Must be unique inside this funnel. If it collides the server refuses the save and keeps the
              old slug — nothing is silently renamed.
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

export default function RightPanel({ block, meta, funnel, blocksCount, saveError, onMeta, onProp, onDelete, onDuplicate }) {
  return (
    <aside className="w-72 shrink-0 border-l border-border-subtle bg-bg-card overflow-y-auto min-h-0">
      {block ? (
        <BlockProps
          key={block.id}
          block={block}
          onProp={onProp}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
        />
      ) : (
        <PageSettings meta={meta} onMeta={onMeta} funnel={funnel} blocksCount={blocksCount} saveError={saveError} />
      )}
    </aside>
  );
}
