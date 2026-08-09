// MEDIA LIBRARY — the funnel builder's image store (reference tool's "image
// studio", v1). Self-contained: it owns its own data fetching and state and
// imports nothing from pages/builder, so it can be dropped into the builder
// (or anywhere else) with two props.
//
// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION CONTRACT — read this before wiring it into the builder.
// ═══════════════════════════════════════════════════════════════════════════
//
//   import MediaPicker from '../../components/media/MediaPicker';
//
//   <MediaPicker
//     open={pickerOpen}
//     onClose={() => setPickerOpen(false)}
//     onSelect={(asset) => { ...; setPickerOpen(false); }}
//   />
//
// onSelect receives ONE argument, an asset object:
//
//   {
//     url:    string,          // ALWAYS present, ALWAYS non-empty. The only
//                              // field a rendered page needs. Absolute https.
//     alt:    string,          // '' when the operator has not written one.
//     width:  number | null,   // px, parsed from the image header server-side.
//     height: number | null,   // null for formats we cannot parse — NOT an error.
//     id:     string,          // lb_media.id, for a future usage index.
//     mime:   string,
//     bytes:  number | null,
//     source: 'upload' | 'url',
//   }
//
// GUARANTEES the caller may rely on:
//   • onSelect fires at most once per interaction and only for a NON-archived
//     asset with a non-empty url.
//   • the component NEVER closes itself; the caller owns `open`. (So a caller
//     that wants "pick then close" calls onClose inside onSelect.)
//   • no builder/page state is read or written here. Mapping the asset onto a
//     block is 100% the caller's job.
//
// SUGGESTED builder mapping (blockRegistry.jsx:107 defines the image block as
// `{ src, alt }`, funnelRender.js:333 renders it):
//
//   onSelect={(a) => updateBlockProps(blockId, { src: a.url, alt: a.alt })}
//
// Other blocks that take an image URL and can reuse the same picker:
//   hero      -> props.image_url        (blockRegistry.jsx:191)
//   product   -> props.image            (blockRegistry.jsx:405)
//   storefront_grid items[].image       (blockRegistry.jsx:254)
//
// width/height are supplied so the caller can set explicit <img> dimensions
// later and stop the layout shift; v1 blocks do not use them yet.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Search, UploadCloud, Link2, ImageIcon, Archive, ArchiveRestore,
  Check, AlertCircle, RefreshCw, Pencil,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../ui/Button';

const PAGE_SIZE = 60;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
// Dropping a folder of 200 photos would fire 200 sequential uploads and hold
// each one in memory as base64. Take the first batch and say so, rather than
// starting work the operator cannot cancel.
const MAX_FILES_PER_BATCH = 10;
// Fallback only — the real number comes from GET /media/storage.
const FALLBACK_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

// Read a File as raw base64. Mirrors ClonePageModal.jsx's fileToBase64 — the
// upload route takes base64 JSON because the server has no multipart parser
// (see routes/media.js header for the tradeoff).
const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });

// The API answers with { success:false, error:{ code, message } }. Surface the
// message when there is one — the codes are operator-actionable (a missing
// Shopify scope must not read as "something went wrong").
const errText = (err, fallback) =>
  err?.response?.data?.error?.message
  || err?.response?.data?.error?.code
  || err?.message
  || fallback;

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {'manage'|'select'} [props.mode='manage']
 * @param {Function} [props.onSelect]  required in 'select' mode — see contract above
 * @param {string}   [props.title]
 */
export default function MediaLibraryModal({
  open,
  onClose,
  mode = 'manage',
  onSelect,
  title,
}) {
  const selectMode = mode === 'select';

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const [busy, setBusy] = useState('');        // '' | 'upload' | 'import'
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const [importUrl, setImportUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [editingAlt, setEditingAlt] = useState(null); // { id, value }
  const [picked, setPicked] = useState('');

  const [storage, setStorage] = useState(null); // { backend, uploads_enabled, ... }

  const fileRef = useRef(null);
  const dragDepth = useRef(0);
  // Guards a late list response from overwriting a newer one (search races).
  const reqSeq = useRef(0);

  // ── debounce the search box into `query` ─────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (offset = 0) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    if (offset === 0) setLoadError('');
    try {
      const { data } = await api.get('/media', {
        params: { limit: PAGE_SIZE, offset, archived: showArchived, ...(query ? { q: query } : {}) },
      });
      if (seq !== reqSeq.current) return; // a newer request already won
      setItems((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
      setTotal(data.total || 0);
      setHasMore(Boolean(data.has_more));
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setLoadError(errText(err, 'Could not load the media library.'));
      if (offset === 0) { setItems([]); setTotal(0); setHasMore(false); }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [query, showArchived]);

  useEffect(() => {
    if (!open) return;
    load(0);
  }, [open, load]);

  useEffect(() => {
    if (!open || storage) return;
    let alive = true;
    api.get('/media/storage')
      .then(({ data }) => { if (alive) setStorage(data); })
      .catch(() => { if (alive) setStorage({ backend: null, uploads_enabled: false }); });
    return () => { alive = false; };
  }, [open, storage]);

  // Reset the transient bits every time the modal opens, so a previous
  // session's error banner never greets the next one.
  useEffect(() => {
    if (open) return;
    setActionError(''); setNotice(''); setImportUrl('');
    setEditingAlt(null); setPicked(''); setDragging(false);
    dragDepth.current = 0;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const uploadsEnabled = storage ? storage.uploads_enabled !== false : true;

  // ── upload ───────────────────────────────────────────────────────────────
  const uploadFiles = useCallback(async (fileList) => {
    const all = Array.from(fileList || []);
    if (!all.length) return;

    const maxBytes = storage?.max_upload_bytes || FALLBACK_MAX_UPLOAD_BYTES;
    const notes = [];
    let files = all;
    if (files.length > MAX_FILES_PER_BATCH) {
      notes.push(`Only the first ${MAX_FILES_PER_BATCH} of ${files.length} files were uploaded.`);
      files = files.slice(0, MAX_FILES_PER_BATCH);
    }
    // Refuse oversize files HERE. FileReader would otherwise read the whole
    // file into memory and base64 it (+33%) just to be told 413 by the server.
    const tooBig = files.filter((f) => f.size > maxBytes);
    if (tooBig.length) {
      notes.push(
        `${tooBig.map((f) => f.name).join(', ')} exceeded the ${fmtBytes(maxBytes)} limit and ${tooBig.length === 1 ? 'was' : 'were'} skipped.`
      );
      files = files.filter((f) => f.size <= maxBytes);
    }

    setActionError(''); setNotice('');
    if (!files.length) { setActionError(notes.join(' ')); return; }

    setBusy('upload');
    let ok = 0;
    const failures = [...notes];
    try {
      for (const file of files) {
        try {
          const data = await fileToBase64(file);
          await api.post('/media/upload', { filename: file.name, mime: file.type, data });
          ok += 1;
        } catch (err) {
          failures.push(`${file.name}: ${errText(err, 'upload failed')}`);
        }
      }
    } finally {
      setBusy('');
    }
    if (failures.length) setActionError(failures.join(' · '));
    if (ok) {
      setNotice(`${ok} image${ok === 1 ? '' : 's'} added.`);
      await load(0);
    }
  }, [load, storage]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!uploadsEnabled) return;
    uploadFiles(e.dataTransfer?.files);
  }, [uploadFiles, uploadsEnabled]);

  // dragenter/dragleave fire for every child element; count depth instead of
  // toggling, or the highlight flickers as the pointer crosses a tile.
  const onDragEnter = useCallback((e) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  // ── import by URL ────────────────────────────────────────────────────────
  const doImport = useCallback(async () => {
    const url = importUrl.trim();
    if (!url) return;
    setActionError(''); setNotice(''); setBusy('import');
    try {
      const { data } = await api.post('/media/import-url', { url });
      setImportUrl('');
      setNotice(data.rehosted
        ? 'Imported and re-hosted on the CDN.'
        : 'Imported. NOT re-hosted — the original link can still break.');
      await load(0);
    } catch (err) {
      setActionError(errText(err, 'Could not import that URL.'));
    } finally {
      setBusy('');
    }
  }, [importUrl, load]);

  // ── patch (alt / archive) ────────────────────────────────────────────────
  const patchItem = useCallback(async (id, patch) => {
    setActionError('');
    try {
      const { data } = await api.patch(`/media/${id}`, patch);
      setItems((prev) => (
        // An archive toggle moves the row OUT of the current filter — drop it
        // rather than leave a tile that no longer belongs in this view.
        Object.prototype.hasOwnProperty.call(patch, 'archived')
          ? prev.filter((it) => it.id !== id)
          : prev.map((it) => (it.id === id ? data.item : it))
      ));
      if (Object.prototype.hasOwnProperty.call(patch, 'archived')) {
        setTotal((n) => Math.max(0, n - 1));
      }
    } catch (err) {
      setActionError(errText(err, 'Could not save that change.'));
    }
  }, []);

  const commitAlt = useCallback(async () => {
    const edit = editingAlt;
    setEditingAlt(null);
    if (!edit) return;
    const current = items.find((it) => it.id === edit.id);
    if (!current || current.alt === edit.value) return;
    await patchItem(edit.id, { alt: edit.value });
  }, [editingAlt, items, patchItem]);

  const choose = useCallback((item) => {
    // CHANGE-TOGETHER: AiMediaDialog.jsx's `toAsset` mirrors this mapping field
    // for field (its "From files" tab cannot mount this overlay inline). Any
    // edit here is an edit there, in the same commit.
    //
    // The two halves of the documented guarantee, asserted at the only place
    // onSelect is ever called: non-empty url, never archived.
    if (!selectMode || !item?.url || item.archived) return;
    setPicked(item.id);
    onSelect?.({
      url: item.url,
      alt: item.alt || '',
      width: item.width ?? null,
      height: item.height ?? null,
      id: item.id,
      mime: item.mime || '',
      bytes: item.bytes ?? null,
      source: item.source,
    });
  }, [selectMode, onSelect]);

  const heading = title || (selectMode ? 'Choose an image' : 'Media library');
  const countLabel = useMemo(
    () => (loading && !items.length ? '' : `${total} ${showArchived ? 'archived' : 'image'}${total === 1 ? '' : 's'}`),
    [loading, items.length, total, showArchived]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden"
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border-default shrink-0">
          <ImageIcon className="w-4 h-4 text-accent shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary truncate">{heading}</h2>
            {countLabel && <p className="text-[11px] text-text-muted">{countLabel}</p>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => load(0)}
              disabled={loading}
              title="Refresh"
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── toolbar ────────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-b border-border-default shrink-0 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 text-text-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search filename or alt text"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint focus:outline-none focus:border-accent/60"
            />
          </div>

          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
          />
          <Button
            size="sm"
            onClick={() => fileRef.current?.click()}
            loading={busy === 'upload'}
            disabled={!uploadsEnabled || Boolean(busy)}
            title={uploadsEnabled ? 'Upload images' : 'Uploads are disabled — no CDN backend is configured'}
          >
            {busy !== 'upload' && <UploadCloud className="w-3.5 h-3.5" />}
            Upload
          </Button>

          {/* Not in select mode. The picker's documented guarantee is that
              onSelect only ever fires for a NON-archived asset; showing the
              archived shelf inside a picker invites exactly the click that
              would break it. Enforce the guarantee by removing the door. */}
          {!selectMode && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition-colors ${
                showArchived
                  ? 'bg-accent/10 border-accent/40 text-accent'
                  : 'bg-bg-elevated border-border-default text-text-muted hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              Archived
            </button>
          )}
        </div>

        {/* ── import by URL ──────────────────────────────────────────────── */}
        <div className="px-5 py-2.5 border-b border-border-default shrink-0 flex items-center gap-2">
          <Link2 className="w-3.5 h-3.5 text-text-faint shrink-0" />
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) doImport(); }}
            placeholder="https://… paste an image URL to import"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint focus:outline-none focus:border-accent/60"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={doImport}
            loading={busy === 'import'}
            disabled={!importUrl.trim() || Boolean(busy)}
          >
            Import
          </Button>
        </div>

        {/* ── banners ────────────────────────────────────────────────────── */}
        {storage && storage.uploads_enabled === false && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              No CDN backend is configured, so uploads are off and imported URLs are
              indexed as-is (the original link can still break).
            </span>
          </div>
        )}
        {actionError && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{actionError}</span>
          </div>
        )}
        {notice && !actionError && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs">
            {notice}
          </div>
        )}

        {/* ── grid ───────────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 relative">
          {dragging && uploadsEnabled && (
            <div className="absolute inset-3 z-10 rounded-xl border-2 border-dashed border-accent/70 bg-bg-main/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
              <UploadCloud className="w-7 h-7 text-accent" />
              <p className="text-sm text-text-primary">Drop images to upload</p>
            </div>
          )}

          {loading && !items.length && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-lg bg-bg-elevated border border-border-default animate-pulse" />
              ))}
            </div>
          )}

          {!loading && loadError && (
            <div className="h-56 flex flex-col items-center justify-center gap-3 text-center">
              <AlertCircle className="w-7 h-7 text-danger" />
              <p className="text-sm text-text-primary">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={() => load(0)}>Try again</Button>
            </div>
          )}

          {!loading && !loadError && !items.length && (
            <div className="h-56 flex flex-col items-center justify-center gap-2 text-center">
              <ImageIcon className="w-8 h-8 text-text-faint" />
              <p className="text-sm text-text-primary">
                {query
                  ? `Nothing matches “${query}”.`
                  : showArchived ? 'Nothing archived yet.' : 'The library is empty.'}
              </p>
              {!query && !showArchived && (
                <p className="text-xs text-text-muted">
                  Drop an image anywhere in this window, or paste a URL above.
                </p>
              )}
            </div>
          )}

          {Boolean(items.length) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {items.map((item) => {
                const isPicked = picked === item.id;
                return (
                  <div
                    key={item.id}
                    className={`group relative flex flex-col rounded-lg border overflow-hidden transition-colors ${
                      isPicked ? 'border-accent' : 'border-border-default hover:border-border-strong'
                    } bg-bg-elevated`}
                  >
                    <div
                      className={`relative aspect-square bg-bg-main flex items-center justify-center overflow-hidden ${
                        selectMode ? 'cursor-pointer' : ''
                      }`}
                      onClick={() => choose(item)}
                      role={selectMode ? 'button' : undefined}
                      tabIndex={selectMode ? 0 : undefined}
                      onKeyDown={selectMode ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(item); } } : undefined}
                    >
                      <img
                        src={item.url}
                        alt={item.alt || item.filename || ''}
                        loading="lazy"
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                      {selectMode && (
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent text-bg-main text-xs font-semibold">
                            {isPicked ? <Check className="w-3.5 h-3.5" /> : null}
                            Use this
                          </span>
                        </div>
                      )}
                      {item.source === 'url' && !item.shopify_file_id && (
                        <span
                          title="Indexed from an external URL — not re-hosted, so the link can break"
                          className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px]"
                        >
                          external
                        </span>
                      )}
                    </div>

                    <div className="p-2 border-t border-border-default">
                      <p className="text-[11px] text-text-primary truncate" title={item.filename || item.url}>
                        {item.filename || item.url}
                      </p>
                      <p className="text-[10px] text-text-faint">
                        {[
                          item.width && item.height ? `${item.width}×${item.height}` : null,
                          fmtBytes(item.bytes),
                        ].filter(Boolean).join(' · ') || '—'}
                      </p>

                      {editingAlt?.id === item.id ? (
                        <input
                          autoFocus
                          value={editingAlt.value}
                          onChange={(e) => setEditingAlt({ id: item.id, value: e.target.value })}
                          onBlur={commitAlt}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitAlt(); }
                            if (e.key === 'Escape') { e.preventDefault(); setEditingAlt(null); }
                          }}
                          placeholder="Alt text"
                          className="mt-1.5 w-full px-1.5 py-1 rounded bg-bg-main border border-accent/60 text-text-primary text-[11px] focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditingAlt({ id: item.id, value: item.alt || '' })}
                          className="mt-1.5 w-full flex items-center gap-1 text-left text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                          title="Edit alt text"
                        >
                          <Pencil className="w-3 h-3 shrink-0" />
                          <span className="truncate">{item.alt || 'Add alt text'}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => patchItem(item.id, { archived: !item.archived })}
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-primary cursor-pointer"
                      >
                        {item.archived
                          ? (<><ArchiveRestore className="w-3 h-3" /> Restore</>)
                          : (<><Archive className="w-3 h-3" /> Archive</>)}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <Button size="sm" variant="secondary" onClick={() => load(items.length)} loading={loading}>
                Load more
              </Button>
            </div>
          )}
        </div>

        {/* ── footer ─────────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-t border-border-default shrink-0 flex items-center gap-2">
          <p className="text-[11px] text-text-faint truncate">
            {storage?.backend
              ? `CDN: ${storage.backend}`
              : 'CDN: not configured'}
            {' · PNG, JPEG, GIF, WebP · archive only, never deleted'}
          </p>
          <div className="ml-auto">
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
