// PAGE BUILDER — version history drawer.
//
// Lists lb_page_versions for this page (newest first), previews one read-only,
// and restores it behind a typed confirm.
//
// THE PREVIEW IS THE BUILDER'S OWN CANVAS RENDERER (BlockPreview), not the
// public renderer and not a screenshot. That is a deliberate, stated limit:
// there is no server route that renders an arbitrary VERSION's blocks, and
// inventing a "preview" that quietly rendered the LIVE page instead would be
// worse than no preview — the operator would be deciding a restore against
// the very content they are trying to replace. The header says which renderer
// they are looking at. BlockPreview keeps operator HTML inside sandbox=""
// iframes, so previewing a hostile old version cannot execute anything here.
//
// RESTORE is typed-confirm, not one-click. The server snapshots the current
// state first regardless, so a restore is reversible — but "reversible" is a
// property of the ledger, not of the operator's afternoon: a mis-click that
// replaces a page mid-campaign still costs a re-publish.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, History, RotateCcw, Eye, Loader2, AlertCircle, Camera, ChevronLeft,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../../components/ui/Button';
import BlockPreview from './BlockPreview';
import { styleToCanvas } from './styleUtils';
import { relativeTime, formatBytes } from './versionFormat';

const CONFIRM_WORD = 'RESTORE';

// A label is operator text — it renders as a React text node (auto-escaped),
// never as markup.
function LabelChip({ label }) {
  if (!label) return <span className="text-[10px] text-text-faint italic">no label</span>;
  const tone =
    label === 'before restore'
      ? 'text-amber-400 border-amber-400/40 bg-amber-400/10'
      : label === 'before AI edit'
        ? 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10'
        : 'text-text-muted border-border-default bg-bg-hover';
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${tone}`}>
      {label}
    </span>
  );
}

export default function VersionsDrawer({ funnelId, pageId, onClose, onRestored }) {
  const [versions, setVersions] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [retention, setRetention] = useState(null);

  const [snapping, setSnapping] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const [preview, setPreview] = useState(null); // full version row
  const [previewErr, setPreviewErr] = useState(null);

  const [armedId, setArmedId] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoringId, setRestoringId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get(`/page-versions/${funnelId}/${pageId}`);
      const d = res.data?.data || {};
      setVersions(Array.isArray(d.versions) ? d.versions : []);
      setRetention(d.retention ?? null);
    } catch (err) {
      setVersions([]);
      setError(err.response?.data?.error || err.message || 'Failed to load versions');
    }
  }, [funnelId, pageId]);

  useEffect(() => { load(); }, [load]);

  const takeSnapshot = useCallback(async () => {
    setSnapping(true);
    setError(null);
    try {
      await api.post(`/page-versions/${funnelId}/${pageId}/snapshot`, { label: 'manual' });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Snapshot failed');
    } finally {
      setSnapping(false);
    }
  }, [funnelId, pageId, load]);

  const openPreview = useCallback(async (id) => {
    setPreviewId(id);
    setPreview(null);
    setPreviewErr(null);
    try {
      const res = await api.get(`/page-versions/${funnelId}/${pageId}/${id}`);
      setPreview(res.data?.data || null);
    } catch (err) {
      setPreviewErr(err.response?.data?.error || err.message || 'Failed to load that version');
    }
  }, [funnelId, pageId]);

  const doRestore = useCallback(async (id) => {
    setRestoringId(id);
    setError(null);
    try {
      const res = await api.post(`/page-versions/${funnelId}/${pageId}/${id}/restore`, { confirm: true });
      // Hand the editor the restore THE MOMENT the POST resolves — before the
      // list refetch. load() is another round-trip, and every millisecond of
      // it is a window in which the builder's debounced autosave can fire and
      // PATCH the pre-restore blocks straight back over the restore.
      //
      // Called even when the body carried no page: the editor's handler
      // cancels the pending write either way, and a missing page is its
      // problem to surface, not a reason to leave a stale save armed.
      onRestored?.(res.data?.data?.page || null);
      setArmedId(null);
      setConfirmText('');
      setPreviewId(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Restore failed');
    } finally {
      setRestoringId(null);
    }
  }, [funnelId, pageId, load, onRestored]);

  const previewBlocks = useMemo(
    () => (Array.isArray(preview?.blocks) ? preview.blocks : []),
    [preview]
  );

  // ---- preview sub-view (full-drawer overlay) -------------------------------
  if (previewId != null) {
    return (
      <aside className="w-96 shrink-0 border-l border-border-subtle bg-bg-card flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
          <button
            onClick={() => { setPreviewId(null); setPreview(null); setPreviewErr(null); }}
            title="Back to the version list"
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary truncate">
              Version #{previewId}
            </div>
            <div className="text-[10px] text-text-faint truncate">
              {preview ? `${previewBlocks.length} blocks · ${relativeTime(preview.created_at)}` : 'Loading…'}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 py-1.5 border-b border-border-subtle text-[10px] text-text-faint leading-snug shrink-0">
          Read-only builder preview (canvas renderer), not the public page. Custom HTML renders sandboxed.
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-3">
          {previewErr && (
            <div className="flex items-start gap-2 text-xs text-danger">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {previewErr}
            </div>
          )}
          {!previewErr && !preview && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading version…
            </div>
          )}
          {preview && (
            <>
              {preview.title != null && (
                <div className="mb-2 text-[11px] text-text-faint">
                  Page title in this version:{' '}
                  <span className="text-text-muted font-medium">{preview.title || '(empty)'}</span>
                </div>
              )}
              {!previewBlocks.length ? (
                <div className="rounded-lg border border-dashed border-border-default p-6 text-center text-xs text-text-faint">
                  This version has no blocks.
                </div>
              ) : (
                <div
                  className="rounded-lg overflow-hidden select-none"
                  style={{ background: '#ffffff', pointerEvents: 'none' }}
                >
                  <div className="p-3">
                    {previewBlocks.map((b, i) => (
                      <div key={b.id || i} style={{ margin: '6px 0', ...(styleToCanvas(b.props) || null) }}>
                        <BlockPreview block={b} pageCss={preview.custom_css || ''} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {preview && (
          <div className="border-t border-border-subtle p-3 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => { setPreviewId(null); setArmedId(preview.id); setConfirmText(''); }}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Restore this version…
            </Button>
          </div>
        )}
      </aside>
    );
  }

  // ---- list ----------------------------------------------------------------
  return (
    <aside className="w-96 shrink-0 border-l border-border-subtle bg-bg-card flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
        <History className="w-4 h-4 text-text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">Versions</div>
          <div className="text-[10px] text-text-faint">
            {retention ? `Newest ${retention} kept per page` : 'Page snapshots'}
          </div>
        </div>
        <button
          onClick={takeSnapshot}
          disabled={snapping}
          title="Snapshot the page as it is saved right now"
          className="flex items-center gap-1 px-2 py-1 rounded-md border border-border-default text-[11px] text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
        >
          {snapping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
          Snapshot
        </button>
        <button onClick={onClose} className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-danger/10 border-b border-danger/30 text-xs text-danger shrink-0">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="px-3 py-1.5 border-b border-border-subtle text-[10px] text-text-faint leading-snug shrink-0">
        A snapshot is taken automatically before each AI Developer batch, and before any restore.
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {versions === null && (
          <div className="flex items-center gap-2 p-3 text-xs text-text-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading versions…
          </div>
        )}
        {versions?.length === 0 && (
          <div className="p-4 text-center text-xs text-text-faint leading-relaxed">
            No versions yet. Take a snapshot before a risky edit — or let the AI Developer take one for you.
          </div>
        )}
        {versions?.map((v) => {
          const armed = armedId === v.id;
          const busy = restoringId === v.id;
          return (
            <div key={v.id} className="border-b border-border-subtle px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-primary font-medium">{relativeTime(v.created_at)}</span>
                <LabelChip label={v.label} />
                <span className="ml-auto text-[10px] text-text-faint font-mono">#{v.id}</span>
              </div>
              <div className="text-[10px] text-text-faint font-mono">
                {v.block_count} block{Number(v.block_count) === 1 ? '' : 's'} · {formatBytes(v.bytes)}
                {v.created_by ? ` · ${v.created_by}` : ''}
              </div>

              {!armed ? (
                <div className="flex gap-1.5 pt-0.5">
                  <button
                    onClick={() => openPreview(v.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-border-default text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                  >
                    <Eye className="w-3 h-3" /> Preview
                  </button>
                  <button
                    onClick={() => { setArmedId(v.id); setConfirmText(''); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-border-default text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" /> Restore
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 space-y-2">
                  <p className="text-[11px] text-amber-300/90 leading-snug">
                    This replaces the page's blocks, CSS, JS, SEO and title with version #{v.id}.
                    Your current state is snapshotted first as <strong>before restore</strong>, so this is undoable.
                    Slug, status and home stay as they are.
                  </p>
                  <input
                    autoFocus
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={`Type ${CONFIRM_WORD} to confirm`}
                    spellCheck={false}
                    className="w-full px-2 py-1 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:border-border-strong"
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy}
                      disabled={confirmText.trim().toUpperCase() !== CONFIRM_WORD}
                      onClick={() => doRestore(v.id)}
                    >
                      <RotateCcw className="w-3 h-3" /> Restore #{v.id}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setArmedId(null); setConfirmText(''); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
