// PAGE BUILDER — right panel.
// Nothing selected  → PAGE settings (title / slug / status / about card).
// Block selected    → STYLE INSPECTOR: breadcrumb chip row (BLOCK > SUB-EL +
//                     block id) and three tabs:
//                       Content  — the block's schema-driven prop editors
//                                  (+ the WIRING section for money blocks)
//                       Style    — size / z-index / background / typography,
//                                  persisted into props.style
//                       Advanced — margin/padding, custom CSS class,
//                                  desktop/mobile visibility toggles
// props.style is applied on the public page by the server's blockStyleWrap()
// (sanitized) and mirrored on the canvas via styleUtils.styleToCanvas().
import { useEffect, useRef, useState } from 'react';
import { Trash2, Copy, ShieldAlert, AlertTriangle, Info } from 'lucide-react';
import { BLOCK_DEFS } from './blockRegistry';
import { FONT_FAMILIES, FONT_WEIGHTS } from './styleUtils';

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

function Field({ field, value, onChange }) {
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
    case 'url':
      return (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || 'https://…'}
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
      );
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

function FieldList({ fields, props, onProp, onFieldFocus }) {
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
      <Field field={f} value={props[f.key]} onChange={(v) => onProp(f.key, v)} />
      {f.help && <p className="mt-1 text-[11px] text-text-faint">{f.help}</p>}
    </div>
  ));
}

// ---------------------------------------------------------------------------
// Style tab — writes into props.style (merged; empty values delete the key,
// an emptied style object deletes props.style entirely so unstyled blocks
// stay byte-identical on the server).
// ---------------------------------------------------------------------------

function StyleSlider({ label, value, min, max, step, unit, defaultValue, onChange }) {
  const set = value != null && value !== '';
  const num = set ? Number(value) : defaultValue;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={`${labelCls} mb-0`}>{label}</label>
        <span className={`text-[11px] font-mono ${set ? 'text-text-primary' : 'text-text-faint'}`}>
          {set ? `${num}${unit || ''}` : 'default'}
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

function ColorField({ label, value, onChange }) {
  const v = value ?? '';
  const swatch = HEX_RE.test(String(v)) ? String(v) : '#ffffff';
  return (
    <div>
      <label className={labelCls}>{label}</label>
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
          placeholder="#ffffff / transparent"
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

function StyleTab({ style, onStyle }) {
  const s = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  const set = (key) => (v) => onStyle(key, v);
  return (
    <div className="space-y-3.5">
      <div className="text-[10px] uppercase tracking-widest text-text-faint font-semibold">Size</div>
      <div className="grid grid-cols-2 gap-2">
        <SizeInput label="Width" value={s.width} onChange={set('width')} placeholder="auto / 100%" />
        <SizeInput label="Height" value={s.height} onChange={set('height')} />
        <SizeInput label="Min W" value={s.min_width} onChange={set('min_width')} />
        <SizeInput label="Min H" value={s.min_height} onChange={set('min_height')} />
        <SizeInput label="Max W" value={s.max_width} onChange={set('max_width')} />
        <SizeInput label="Max H" value={s.max_height} onChange={set('max_height')} />
      </div>
      <div>
        <label className={labelCls}>Z-index</label>
        <input
          type="number"
          value={s.z_index ?? ''}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            set('z_index')(Number.isFinite(n) ? n : undefined);
          }}
          className={inputCls}
        />
      </div>

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Background</div>
      <ColorField label="Background color" value={s.bg} onChange={set('bg')} />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Typography</div>
      <div>
        <label className={labelCls}>Font family</label>
        <select value={s.font_family ?? ''} onChange={(e) => set('font_family')(e.target.value || undefined)} className={inputCls}>
          {FONT_FAMILIES.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Weight</label>
        <select value={s.font_weight ?? ''} onChange={(e) => set('font_weight')(e.target.value || undefined)} className={inputCls}>
          {FONT_WEIGHTS.map((w) => <option key={w.label} value={w.value}>{w.label}</option>)}
        </select>
      </div>
      <StyleSlider label="Font size" value={s.font_size} min={8} max={96} step={1} unit="px" defaultValue={16} onChange={set('font_size')} />
      <StyleSlider label="Line height" value={s.line_height} min={0.5} max={3} step={0.05} unit="" defaultValue={1.6} onChange={set('line_height')} />
      <StyleSlider label="Letter spacing" value={s.letter_spacing} min={-5} max={20} step={0.5} unit="px" defaultValue={0} onChange={set('letter_spacing')} />
      <ColorField label="Text color" value={s.text_color} onChange={set('text_color')} />
    </div>
  );
}

function AdvancedTab({ style, onStyle }) {
  const s = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  const set = (key) => (v) => onStyle(key, v);
  return (
    <div className="space-y-3.5">
      <div className="text-[10px] uppercase tracking-widest text-text-faint font-semibold">Spacing</div>
      <SizeInput label="Margin (CSS shorthand)" value={s.margin} onChange={set('margin')} placeholder="16px 0" />
      <SizeInput label="Padding (CSS shorthand)" value={s.padding} onChange={set('padding')} placeholder="24px" />

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">CSS</div>
      <div>
        <label className={labelCls}>Custom CSS class</label>
        <input
          value={s.css_class ?? ''}
          onChange={(e) => set('css_class')(e.target.value || undefined)}
          placeholder="my-class"
          spellCheck={false}
          className={`${inputCls} font-mono text-xs`}
        />
        <p className="mt-1 text-[11px] text-text-faint">Added to the block wrapper — style it from the page CSS (Code tab).</p>
      </div>

      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">Visibility</div>
      {[['hide_desktop', 'Hide on desktop (≥768px)'], ['hide_mobile', 'Hide on mobile (<768px)']].map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={s[key] === true}
            onChange={(e) => set(key)(e.target.checked ? true : undefined)}
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

  // Merge-write into props.style; an emptied object removes props.style.
  const onStyle = (key, value) => {
    const cur = props.style && typeof props.style === 'object' && !Array.isArray(props.style) ? props.style : {};
    const next = { ...cur };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onProp('style', Object.keys(next).length ? next : undefined);
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
          <div onFocusCapture={() => setSubEl('block name')}>
            <label className={labelCls}>Block name (outline label)</label>
            <input value={props.block_name ?? ''} onChange={(e) => onProp('block_name', e.target.value)} className={inputCls} placeholder={def?.label} />
          </div>

          {def?.fields?.length ? (
            <FieldList fields={def.fields} props={props} onProp={onProp} onFieldFocus={setSubEl} />
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

      {tab === 'style' && <StyleTab style={props.style} onStyle={onStyle} />}
      {tab === 'advanced' && <AdvancedTab style={props.style} onStyle={onStyle} />}
    </div>
  );
}

function PageSettings({ meta, onMeta, funnel, blocksCount }) {
  return (
    <div className="p-3 space-y-3.5">
      <div className="text-sm font-semibold text-text-primary">Page settings</div>
      <div>
        <label className={labelCls}>Title</label>
        <input value={meta.title} onChange={(e) => onMeta({ title: e.target.value })} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Slug</label>
        <input value={meta.slug} onChange={(e) => onMeta({ slug: e.target.value })} spellCheck={false} className={`${inputCls} font-mono text-xs`} />
        <p className="mt-1 text-[11px] text-text-faint font-mono truncate">
          /f/{funnel?.slug}{meta.slug === '/' ? '' : meta.slug}
        </p>
      </div>
      <div>
        <label className={labelCls}>Status</label>
        <select value={meta.status} onChange={(e) => onMeta({ status: e.target.value })} className={inputCls}>
          <option value="draft">draft</option>
          <option value="published">published</option>
        </select>
        {meta.status === 'published' && funnel?.status !== 'published' && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            The funnel itself is still {funnel?.status || 'draft'} — the public URL stays dark until the funnel is published from the canvas.
          </p>
        )}
      </div>
      <div className="pt-2 border-t border-border-subtle">
        <div className="text-[10px] uppercase tracking-wider text-text-faint font-semibold mb-1.5">About this page</div>
        <p className="text-[11px] text-text-faint leading-relaxed">
          {blocksCount} block{blocksCount === 1 ? '' : 's'}. Every block generates its own HTML &amp; CSS — open
          Code to edit as text, or click any block. Double-click text to edit in place; hover between
          blocks for the + quick-insert.
        </p>
      </div>
    </div>
  );
}

export default function RightPanel({ block, meta, funnel, blocksCount, onMeta, onProp, onDelete, onDuplicate }) {
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
        <PageSettings meta={meta} onMeta={onMeta} funnel={funnel} blocksCount={blocksCount} />
      )}
    </aside>
  );
}
