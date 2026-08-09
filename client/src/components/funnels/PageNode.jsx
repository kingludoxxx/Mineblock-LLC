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
  Shuffle,
  Library,
} from 'lucide-react';
import { typeMeta, DEVICE_WIDTHS } from './pageTypes';
import usePageThumbnail from './usePageThumbnail';

// A single page on the canvas, styled after the operator's reference tool:
// small-caps type label ABOVE the card, a live page thumbnail inside it, and
// one compact dark metric chip under the card (`3v · 33% · 0%`). Two source
// handles: the bottom one draws a `main` edge, the right (red) one a
// `fallback` (decline) edge — this is how the operator marks a downsell path.

// null and 0 are DIFFERENT facts (see pages/analytics/format.js): null means
// "could not measure" and renders as an em dash, never as 0.
const isNil = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
const chipVisitors = (v) => (isNil(v) ? '—' : `${new Intl.NumberFormat('en-US').format(Math.round(Number(v)))}v`);
const chipRate = (v) => (isNil(v) ? '—' : `${Math.round(Number(v) * 100)}%`);

// Thumbnail loading lives in ./usePageThumbnail.js — a shared refcounted
// blob-URL cache (extracted from here so the split surfaces reuse it).

function PageNodeInner({ data, selected }) {
  const page = data.page;
  const meta = typeMeta(page.type);
  const width = DEVICE_WIDTHS[data.deviceSize || 'M'];
  const Icon = meta.icon;
  const thumbUrl = usePageThumbnail(page);

  const toolbarBtn =
    'p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer';

  return (
    <div style={{ width }}>
      {/* Floating toolbar (on select) */}
      {selected && (
        <div className="absolute -top-6 left-0 right-0 flex items-center justify-center">
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
            {/* Save this page into the cross-funnel page library as a reusable
                snapshot. Sits next to Duplicate because it is the same verb at
                a different scope: duplicate copies here, this copies out. */}
            <button className={toolbarBtn} title="Save to page library" onClick={() => data.onSaveToLibrary?.(page)}>
              <Library className="w-3.5 h-3.5" />
            </button>
            <button className={toolbarBtn} title="Create A/B test" onClick={() => data.onSplitTest?.(page)}>
              <Shuffle className="w-3.5 h-3.5" />
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

      {/* Type label ABOVE the card (reference look: LISTICLE / CHECKOUT / …) */}
      <div className="mb-1 flex items-center gap-1.5 px-0.5">
        <Icon className="w-3 h-3 shrink-0" style={{ color: meta.color }} />
        <span
          className="text-[9px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: meta.color }}
        >
          {String(page.type || 'generic').toUpperCase()}
        </span>
        {page.is_home && (
          <span className="ml-auto inline-flex items-center gap-1 text-[9px] text-text-faint">
            <Home className="w-3 h-3" /> home
          </span>
        )}
      </div>

      {/* Card */}
      <div
        className="rounded-xl bg-bg-card border shadow-lg"
        style={{
          borderColor: selected ? meta.color : 'rgba(255,255,255,0.08)',
          boxShadow: selected ? `0 0 0 1px ${meta.color}55, 0 8px 24px rgba(0,0,0,0.4)` : undefined,
        }}
      >
        {/* Target handle (incoming) */}
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: '#52525b', width: 9, height: 9, border: '2px solid #18181b' }}
        />

        {/* Live thumbnail (falls back to the gradient placeholder) + title */}
        <div className="px-2.5 pt-2.5 pb-2">
          <div
            className="mb-2 rounded-md border border-border-subtle overflow-hidden flex items-center justify-center"
            style={{
              aspectRatio: '2 / 3',
              maxHeight: 220,
              width: '100%',
              background: `linear-gradient(135deg, ${meta.color}14, transparent)`,
            }}
          >
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                draggable={false}
                className="w-full h-full object-cover object-top"
              />
            ) : (
              <Icon className="w-5 h-5 opacity-40" style={{ color: meta.color }} />
            )}
          </div>
          <div className="text-sm font-medium text-text-primary truncate">{page.title || 'Untitled'}</div>
          <div className="text-[11px] text-text-faint font-mono truncate">{page.slug}</div>
          {/* F7: the page's public URL */}
          {data.funnelSlug && (
            <div className="text-[10px] text-text-faint/70 font-mono truncate" title={`/f/${data.funnelSlug}${page.slug === '/' ? '' : page.slug}`}>
              /f/{data.funnelSlug}{page.slug === '/' ? '' : page.slug}
            </div>
          )}
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

      {/* Compact metric chip UNDER the node (reference zoomed-out format:
          `3v · 33% · 0%` = visitors · CTR · CVR). An absent/null value
          renders "—" (unmeasured), never 0. CTR is a labelled proxy — the
          title says so. */}
      <div className="mt-1.5 flex justify-center">
        <span
          className="px-2 py-0.5 rounded-md bg-black/70 border border-white/10 text-[10px] font-mono text-text-muted whitespace-nowrap"
          title="Visitors (30d) · CTR (proxy — lower bound: step-through / checkout-submit) · CVR (orders ÷ visitors)"
        >
          {chipVisitors(data.metrics?.visitors)} · {chipRate(data.metrics?.ctr)} · {chipRate(data.metrics?.cvr)}
        </span>
      </div>
    </div>
  );
}

export default memo(PageNodeInner);
