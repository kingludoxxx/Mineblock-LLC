// PAGE LIBRARY — the flyout behind the canvas's "Page library" rail entry.
//
// TWO TABS, and the split is the whole design:
//
//   "This funnel"  — a faithful port of the reference tool's panel. funnel-os's
//                    PageLibraryPanel.jsx is NOT a saved library: it lists the
//                    CURRENT funnel's own pages, grouped by normalized type,
//                    as small real-preview thumbs. Click focuses the node,
//                    drag onto the canvas clones the page. Read-only otherwise
//                    — no delete, no edit, exactly as his docblock states.
//                    Its "45 pages · drag to clone" caption is just
//                    `pages.length` for the funnel on screen.
//
//   "Library"      — what his tool ADVERTISES but never built. His router
//                    docblock promises "save as template" and his lb_templates
//                    collection has no write endpoint at all, so it can only
//                    ever hold the 11 seeded system rows. This tab is the real
//                    thing: saved page SNAPSHOTS (server/src/routes/
//                    pageLibrary.js) that outlive their source funnel and clone
//                    into ANY funnel, with search, category/type facets,
//                    rename and delete.
//
// DRAG-AND-DROP is native HTML5, matching his mechanism (not dnd-kit, not
// React Flow's node dnd). Two MIME contracts, deliberately distinct so the
// canvas's drop handler can tell a same-funnel duplicate from a library
// instantiation without inspecting the payload:
//
//   application/x-puure-funnel-page   → page id   → duplicate inside THIS funnel
//   application/x-puure-library-entry → entry id  → clone the library entry here
//
// Every clone lands as a DRAFT (server-side, not a client courtesy). Money
// blocks inside a library page keep their props verbatim — pricing is
// re-resolved against Shopify at checkout, never read from the block.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Search, Loader2, Trash2, Pencil, Library, Check, RefreshCw,
} from 'lucide-react';
import api from '../../services/api';
import { typeMeta } from './pageTypes';
import usePageThumbnail from './usePageThumbnail';
// The band layout, the byte formatter and the count label are PURE and live in
// their own module so a node harness can pin them without a DOM
// (server/tests/page-library/library-model.mjs) — the same split
// codeFormat.js / versionFormat.js already use in this codebase.
import { groupPagesByBand, fmtBytes } from './pageLibraryModel';

export const DND_FUNNEL_PAGE = 'application/x-puure-funnel-page';
export const DND_LIBRARY_ENTRY = 'application/x-puure-library-entry';

const THUMB_W = 56;
const THUMB_H = 74;

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

// A funnel page's own miniature — the shared refcounted cache the canvas nodes
// already use, so opening the flyout costs no extra screenshots.
function PageThumb({ page }) {
  const url = usePageThumbnail(page);
  const meta = typeMeta(page?.type);
  const Icon = meta.icon;
  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{ background: `linear-gradient(135deg, ${meta.color}14, transparent)` }}
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="w-full h-full object-cover object-top" />
      ) : (
        <Icon className="w-4 h-4 opacity-40" style={{ color: meta.color }} />
      )}
    </div>
  );
}

// A LIBRARY ENTRY's miniature. The entry is a snapshot, not a page, so there is
// nothing to screenshot — but the entry records where it came from, and that
// pair is exactly what /page-thumbnails takes. When the source page is gone
// (archived, deleted, whole funnel removed) the endpoint 404s, the hook
// resolves null, and the placeholder stays. That dangling reference is expected
// and harmless: see the missing-FK note in services/pageLibrarySchema.js.
//
// The pseudo-page object is rebuilt on every render ON PURPOSE — no useMemo.
// usePageThumbnail keys its cache and its effect on a STRING (funnel/page/ms),
// not on object identity, so a fresh object costs nothing and memoizing it here
// would only add a dependency list to get wrong.
function EntryThumb({ entry }) {
  const hasSource = Boolean(entry?.source_page_id && entry?.source_funnel_id);
  return (
    <PageThumb
      page={
        hasSource
          ? {
              id: entry.source_page_id,
              funnel_id: entry.source_funnel_id,
              updated_at: entry.created_at,
              type: entry.type,
            }
          : { type: entry?.type }
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function GroupChip({ children }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded bg-bg-elevated border border-border-subtle text-[10px] font-semibold uppercase tracking-wider text-text-faint">
      {children}
    </span>
  );
}

function TypeBadge({ type }) {
  const meta = typeMeta(type);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
      style={{ color: meta.color, background: `${meta.color}1a`, border: `1px solid ${meta.color}33` }}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — this funnel's own pages (the faithful port)
// ---------------------------------------------------------------------------
function ThisFunnelTab({ pages, onFocusPage, canEdit }) {
  const groups = useMemo(() => groupPagesByBand(pages), [pages]);

  if (!pages?.length) {
    return <p className="text-xs text-text-faint">No pages in this funnel yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.label}>
          <GroupChip>{g.label}</GroupChip>
          <div className="mt-2 flex flex-wrap gap-2.5">
            {g.items.map((p) => (
              <div key={p.id} style={{ width: THUMB_W }}>
                <div
                  className="text-[8px] font-mono text-text-faint text-center truncate"
                  title={p.title || p.slug}
                >
                  {p.title || p.slug}
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  draggable={canEdit}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(DND_FUNNEL_PAGE, p.id);
                  }}
                  onClick={() => onFocusPage?.(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onFocusPage?.(p.id);
                    }
                  }}
                  title={canEdit ? 'Click to focus · drag onto the canvas to duplicate' : 'Click to focus'}
                  className={`mt-1 rounded-md border border-border-subtle overflow-hidden bg-bg-elevated hover:border-border-default transition-colors ${
                    canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                  }`}
                  style={{ height: THUMB_H }}
                >
                  <PageThumb page={p} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — the saved library
// ---------------------------------------------------------------------------
function LibraryTab({ funnelId, onCloned, onError, reloadToken }) {
  const [entries, setEntries] = useState([]);
  const [meta, setMeta] = useState({ total: 0, categories: [], types: [] });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [renaming, setRenaming] = useState(null); // entry id
  const [renameDraft, setRenameDraft] = useState('');

  // Debounced so typing in the search box does not fire a request per keypress.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedQ) params.set('q', debouncedQ);
      if (category) params.set('category', category);
      if (type) params.set('type', type);
      const res = await api.get(`/page-library${params.toString() ? `?${params}` : ''}`);
      const d = res.data?.data || {};
      setEntries(d.entries || []);
      setMeta({ total: d.total || 0, categories: d.categories || [], types: d.types || [] });
    } catch (err) {
      onError?.(err.response?.data?.error?.code || 'Failed to load the page library');
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, category, type, onError]);

  useEffect(() => { load(); }, [load, reloadToken]);

  const cloneEntry = useCallback(
    async (entry) => {
      if (busyId) return;
      setBusyId(entry.id);
      try {
        const res = await api.post(`/page-library/${entry.id}/clone`, { funnel_id: funnelId });
        onCloned?.(res.data?.data, res.data?.meta);
      } catch (err) {
        const e = err.response?.data?.error;
        onError?.(e?.detail || e?.code || 'Failed to clone that library page');
      } finally {
        setBusyId(null);
      }
    },
    [busyId, funnelId, onCloned, onError]
  );

  const removeEntry = useCallback(
    async (entry) => {
      // A library entry is a snapshot the operator built on purpose; deleting
      // one silently on a stray click would be indistinguishable from a bug.
      if (!window.confirm(`Remove "${entry.name}" from the page library?`)) return;
      setBusyId(entry.id);
      try {
        await api.delete(`/page-library/${entry.id}`);
        await load();
      } catch (err) {
        onError?.(err.response?.data?.error?.code || 'Failed to remove that entry');
      } finally {
        setBusyId(null);
      }
    },
    [load, onError]
  );

  const commitRename = useCallback(
    async (entry) => {
      const name = renameDraft.trim();
      setRenaming(null);
      if (!name || name === entry.name) return;
      try {
        await api.patch(`/page-library/${entry.id}`, { name });
        await load();
      } catch (err) {
        onError?.(err.response?.data?.error?.code || 'Failed to rename that entry');
      }
    },
    [renameDraft, load, onError]
  );

  const pill = (active) =>
    `px-2 py-0.5 rounded-full text-[10px] border transition-colors cursor-pointer ${
      active
        ? 'bg-accent-muted text-accent-text border-accent/30'
        : 'bg-bg-elevated text-text-muted border-border-subtle hover:text-text-primary'
    }`;

  return (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search saved pages"
          className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
        />
      </div>

      {/* Facets. Both rows come from the UNFILTERED live set, so a filter that
          empties the grid never also removes the pill that would undo it. */}
      {(meta.categories.length > 1 || meta.types.length > 1) && (
        <div className="flex flex-col gap-1.5">
          {meta.categories.length > 1 && (
            <div className="flex flex-wrap gap-1">
              <button type="button" className={pill(!category)} onClick={() => setCategory('')}>
                All categories
              </button>
              {meta.categories.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={pill(category === c.name)}
                  onClick={() => setCategory(category === c.name ? '' : c.name)}
                >
                  {c.name} <span className="opacity-60">{c.count}</span>
                </button>
              ))}
            </div>
          )}
          {meta.types.length > 1 && (
            <div className="flex flex-wrap gap-1">
              <button type="button" className={pill(!type)} onClick={() => setType('')}>
                All types
              </button>
              {meta.types.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={pill(type === t.name)}
                  onClick={() => setType(type === t.name ? '' : t.name)}
                >
                  {typeMeta(t.name).label} <span className="opacity-60">{t.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 justify-center text-xs text-text-faint">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the library…
        </div>
      ) : entries.length === 0 ? (
        <p className="py-4 text-xs text-text-faint">
          {q || category || type
            ? 'Nothing matches those filters.'
            : 'The library is empty. Select a page on the canvas and use “Save to library” to add one.'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <div
              key={e.id}
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.effectAllowed = 'copy';
                ev.dataTransfer.setData(DND_LIBRARY_ENTRY, e.id);
              }}
              className="group flex items-start gap-2.5 p-2 rounded-lg border border-transparent hover:border-border-default hover:bg-bg-hover transition-colors cursor-grab active:cursor-grabbing"
            >
              <div
                className="shrink-0 rounded-md border border-border-subtle overflow-hidden bg-bg-elevated"
                style={{ width: THUMB_W, height: THUMB_H }}
              >
                <EntryThumb entry={e} />
              </div>
              <div className="min-w-0 flex-1">
                {renaming === e.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(ev) => setRenameDraft(ev.target.value)}
                    onBlur={() => commitRename(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commitRename(e);
                      if (ev.key === 'Escape') setRenaming(null);
                    }}
                    className="w-full px-1.5 py-0.5 text-xs bg-bg-elevated border border-border-default rounded text-text-primary focus:outline-none focus:border-border-strong"
                  />
                ) : (
                  <div className="text-xs font-medium text-text-primary truncate" title={e.name}>
                    {e.name}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <TypeBadge type={e.type} />
                  <span className="text-[10px] text-text-faint">
                    {e.block_count} block{e.block_count === 1 ? '' : 's'} · {fmtBytes(e.bytes)}
                  </span>
                </div>
                {e.description && (
                  <div className="mt-0.5 text-[10px] text-text-faint line-clamp-2">{e.description}</div>
                )}
                <div className="mt-1 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => cloneEntry(e)}
                    disabled={busyId === e.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-bg-elevated border border-border-default text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50"
                    title="Add a copy of this page to the open funnel"
                  >
                    {busyId === e.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Check className="w-3 h-3" />
                    )}
                    Add to this funnel
                  </button>
                  <button
                    type="button"
                    onClick={() => { setRenaming(e.id); setRenameDraft(e.name); }}
                    className="p-1 rounded text-text-faint hover:text-text-primary cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Rename"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEntry(e)}
                    className="p-1 rounded text-text-faint hover:text-danger cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from the library"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* `total` is the count under the CURRENT filters and `entries` is one
          page of it — say so rather than letting a capped list read as the
          whole library (the trap funnel-os's uncounted to_list(200) walks into). */}
      {!loading && meta.total > entries.length && (
        <p className="text-[10px] text-text-faint">
          Showing {entries.length} of {meta.total} — narrow the search to see the rest.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The flyout
// ---------------------------------------------------------------------------
// MOUNTED ONLY WHILE OPEN. The caller renders this conditionally rather than
// passing an `open` prop, and that is what makes every piece of state here
// per-open for free: the active tab, the search box, and the error banner all
// start fresh on each open with no reset effect to keep in sync (a reset effect
// is also a setState-inside-useEffect, which this codebase's lint rules refuse).
export default function PageLibraryPanel({
  onClose,
  funnelId,
  pages = [],
  canEdit = true,
  onFocusPage,
  onCloned,
  reloadToken,
}) {
  const ref = useRef(null);
  const [tab, setTab] = useState('funnel'); // 'funnel' | 'library'
  const [error, setError] = useState(null);
  const [localReload, setLocalReload] = useState(0);

  // Dismiss on outside-click / Escape. The rail trigger carries
  // [data-page-library-trigger]; ignore clicks on it so the same button still
  // toggles the flyout closed instead of close-then-reopen fighting itself.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (e.target?.closest?.('[data-page-library-trigger]')) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const total = Array.isArray(pages) ? pages.length : 0;

  return (
    <div
      ref={ref}
      data-testid="funnel-page-library"
      className="absolute left-3 bottom-3 z-20 w-[340px] max-w-[calc(100%-24px)] max-h-[78%] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <Library className="w-3.5 h-3.5 text-text-muted shrink-0" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
            Page library
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLocalReload((v) => v + 1)}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close page library"
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 flex gap-1 px-3 pt-2 border-b border-border-subtle">
        {[
          { key: 'funnel', label: `This funnel (${total})` },
          { key: 'library', label: 'Library' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-2.5 py-1.5 text-xs font-medium border-b-2 -mb-px cursor-pointer transition-colors ${
              tab === t.key
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-danger border-b border-border-subtle">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="p-3 overflow-y-auto">
        {tab === 'funnel' ? (
          <ThisFunnelTab pages={pages} onFocusPage={onFocusPage} canEdit={canEdit} />
        ) : (
          <LibraryTab
            funnelId={funnelId}
            onCloned={onCloned}
            onError={setError}
            reloadToken={`${reloadToken ?? 0}:${localReload}`}
          />
        )}
      </div>

      {canEdit && (
        <div className="shrink-0 px-3 py-2 border-t border-border-subtle text-[10px] text-text-faint">
          {tab === 'funnel'
            ? 'Drag a page onto the canvas to duplicate it.'
            : 'Drag an entry onto the canvas to add it here as a draft.'}
        </div>
      )}
    </div>
  );
}
