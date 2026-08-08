import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  Pencil,
  Eye,
  Copy,
  Settings,
  Code,
  Trash2,
  BarChart3,
  Home,
} from 'lucide-react';
import { typeMeta, DEVICE_WIDTHS } from './pageTypes';

// A single page on the canvas. Type-colored header, title, type label, two
// placeholder stat chips, and a floating toolbar shown when selected. Two
// source handles: the bottom one draws a `main` edge, the right (red) one a
// `fallback` (decline) edge — this is how the operator marks a downsell path.
function PageNodeInner({ data, selected }) {
  const page = data.page;
  const meta = typeMeta(page.type);
  const width = DEVICE_WIDTHS[data.deviceSize || 'M'];
  const Icon = meta.icon;

  const toolbarBtn =
    'p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer';

  return (
    <div
      className="rounded-xl bg-bg-card border shadow-lg"
      style={{
        width,
        borderColor: selected ? meta.color : 'rgba(255,255,255,0.08)',
        boxShadow: selected ? `0 0 0 1px ${meta.color}55, 0 8px 24px rgba(0,0,0,0.4)` : undefined,
      }}
    >
      {/* Floating toolbar (on select) */}
      {selected && (
        <div className="absolute -top-9 left-0 right-0 flex items-center justify-center">
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-bg-elevated border border-border-default shadow-xl nodrag">
            <button className={toolbarBtn} title="Settings" onClick={() => data.onSettings?.(page)}>
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Analytics (soon)" onClick={() => data.onAnalytics?.(page)}>
              <BarChart3 className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Edit page" onClick={() => data.onEdit?.(page)}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Preview" onClick={() => data.onPreview?.(page)}>
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Duplicate" onClick={() => data.onDuplicate?.(page)}>
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Edit blocks (JSON)" onClick={() => data.onCode?.(page)}>
              <Code className="w-3.5 h-3.5" />
            </button>
            <button
              className="p-1 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover transition-colors cursor-pointer"
              title="Archive page"
              onClick={() => data.onDelete?.(page)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Target handle (incoming) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: '#52525b', width: 9, height: 9, border: '2px solid #18181b' }}
      />

      {/* Type-colored header */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-t-xl"
        style={{ background: `${meta.color}1f`, borderBottom: `1px solid ${meta.color}33` }}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: meta.color }} />
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {page.is_home && (
          <span className="ml-auto inline-flex items-center gap-1 text-[9px] text-text-faint">
            <Home className="w-3 h-3" /> home
          </span>
        )}
      </div>

      {/* Thumbnail placeholder + title */}
      <div className="px-3 py-2.5">
        <div
          className="mb-2 h-14 rounded-md border border-border-subtle flex items-center justify-center"
          style={{ background: `linear-gradient(135deg, ${meta.color}14, transparent)` }}
        >
          <Icon className="w-5 h-5 opacity-40" style={{ color: meta.color }} />
        </div>
        <div className="text-sm font-medium text-text-primary truncate">{page.title || 'Untitled'}</div>
        <div className="text-[11px] text-text-faint font-mono truncate">{page.slug}</div>
        {/* F7: the page's public URL */}
        {data.funnelSlug && (
          <div className="text-[10px] text-text-faint/70 font-mono truncate" title={`/f/${data.funnelSlug}${page.slug === '/' ? '' : page.slug}`}>
            /f/{data.funnelSlug}{page.slug === '/' ? '' : page.slug}
          </div>
        )}

        {/* Placeholder stat chips */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-bg-elevated text-[10px] text-text-faint">— visitors</span>
          <span className="px-1.5 py-0.5 rounded bg-bg-elevated text-[10px] text-text-faint">— CVR</span>
        </div>
      </div>

      {/* Main source handle (bottom, accent) */}
      <Handle
        id="main"
        type="source"
        position={Position.Bottom}
        style={{ background: meta.color, width: 10, height: 10, border: '2px solid #18181b' }}
      />
      {/* Fallback source handle (right, red — the decline / downsell path) */}
      <Handle
        id="fallback"
        type="source"
        position={Position.Right}
        style={{ background: '#ef4444', width: 10, height: 10, border: '2px solid #18181b' }}
        title="Fallback (decline) path"
      />
    </div>
  );
}

export default memo(PageNodeInner);
