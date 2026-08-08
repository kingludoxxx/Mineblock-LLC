// PAGE BUILDER — right panel.
// Nothing selected  → PAGE settings (title / slug / status / blurb).
// Block selected    → schema-driven PROPS editor for that block type, with a
//                     clearly-separated WIRING section for money blocks and
//                     delete / duplicate actions.
import { useEffect, useRef, useState } from 'react';
import { Trash2, Copy, ShieldAlert, AlertTriangle } from 'lucide-react';
import { BLOCK_DEFS } from './blockRegistry';

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
          onChange={(e) => onChange(field.coerce === 'int' ? parseInt(e.target.value, 10) : e.target.value)}
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

function FieldList({ fields, props, onProp }) {
  return fields.map((f) => (
    <div key={f.key}>
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

function BlockProps({ block, onProp, onDelete, onDuplicate }) {
  const def = BLOCK_DEFS[block.type];
  const props = block.props && typeof block.props === 'object' ? block.props : {};
  return (
    <div className="p-3 space-y-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">{def?.label || block.type}</div>
          <div className="text-[10px] text-text-faint font-mono">{block.type}</div>
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

      <div>
        <label className={labelCls}>Block name (outline label)</label>
        <input value={props.block_name ?? ''} onChange={(e) => onProp('block_name', e.target.value)} className={inputCls} placeholder={def?.label} />
      </div>

      {def?.fields?.length ? (
        <FieldList fields={def.fields} props={props} onProp={onProp} />
      ) : (
        !def?.wiringFields?.length && <p className="text-xs text-text-faint">This block has no editable settings.</p>
      )}

      {def?.money && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
          <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold uppercase tracking-wider">
            <ShieldAlert className="w-3.5 h-3.5" /> Wiring — money block
          </div>
          <p className="text-[11px] text-text-faint leading-relaxed">{def.wiringNote}</p>
          {def.wiringFields?.length ? (
            <FieldList fields={def.wiringFields} props={props} onProp={onProp} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function PageSettings({ meta, onMeta, funnel }) {
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
          Blocks are rendered top-to-bottom by the server on the public page. This canvas is a structural
          approximation — use Preview for the exact buyer-facing output. Select a block to edit its
          settings; drag from Elements to add more.
        </p>
      </div>
    </div>
  );
}

export default function RightPanel({ block, meta, funnel, onMeta, onProp, onDelete, onDuplicate }) {
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
        <PageSettings meta={meta} onMeta={onMeta} funnel={funnel} />
      )}
    </aside>
  );
}
