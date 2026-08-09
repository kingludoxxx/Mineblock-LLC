// PAGE BUILDER — drag-and-drop block editor for funnel pages.
// Route: /app/funnels/:id/pages/:pageId/builder  (PageGate funnels:access)
//
// Client-heavy by design: the ONLY server surface used is the existing pages
// CRUD (GET /funnels/:id · PATCH /funnels/:id/pages/:pageId · GET preview-url)
// — no new endpoints. Autosave is debounced + serialized (one PATCH in flight,
// latest state always wins), API validation errors surface inline and never
// wedge the editor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ExternalLink, Check, Loader2, Undo2, Redo2,
  Smartphone, Tablet, Monitor, UploadCloud, AlertCircle, X, Bot, History, ScanLine,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../../components/ui/Button';
import { typeMeta } from '../../../components/funnels/pageTypes';
import useHistory from './useHistory';
import { createBlock, withIds, newBlockId, isInsertable, BLOCKS_MAX_COUNT } from './blockRegistry';
import LeftPanel from './LeftPanel';
import RightPanel from './RightPanel';
import CanvasArea from './CanvasArea';
import CodeTab from './CodeTab';
import VersionsDrawer from './VersionsDrawer';
import AIDeveloperPanel from '../../../components/funnels/ai/AIDeveloperPanel';
import ClonePageModal from '../../../components/funnels/ClonePageModal';

// Device toggles mirror the breakpoints the RENDERER actually emits — desktop
// (base) and mobile (max-width media query). Tablet is a VISIBLE-DISABLED stub:
// selecting it would show a width the published page has no CSS for, which
// would be a preview of a page that does not exist.
const DEVICES = [
  { id: 'mobile', width: 375, icon: Smartphone, label: 'Mobile (375px)' },
  { id: 'tablet', width: 768, icon: Tablet, label: 'coming with tablet breakpoints', disabled: true },
  { id: 'desktop', width: 1100, icon: Monitor, label: 'Desktop (1100px)' },
];

// Escape-hatch code columns the Code view round-trips. Same set the server's
// ESCAPE_HATCH_FIELDS accepts on the pages PATCH.
const CODE_FIELDS = ['custom_css', 'custom_js', 'custom_html', 'head_html', 'body_end_html'];
const emptyCode = () => Object.fromEntries(CODE_FIELDS.map((f) => [f, '']));
const codeFromPage = (p) => Object.fromEntries(CODE_FIELDS.map((f) => [f, p?.[f] || '']));

const SAVE_DEBOUNCE_MS = 800;

// Auto-snapshot rate limit. A burst of AI batches must cost ONE version, not
// one per batch — the retention window is 30 rows, and a chatty session would
// otherwise evict every hand-taken snapshot inside a minute.
const AUTO_SNAP_MIN_MS = 30_000;
// …and the editor must never wait on the network to apply an edit. If the
// snapshot has not answered by here, the batch applies anyway.
const AUTO_SNAP_MAX_WAIT_MS = 4_000;

export default function PageBuilderPage() {
  const { id, pageId } = useParams();
  const navigate = useNavigate();

  const [funnel, setFunnel] = useState(null);
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [meta, setMeta] = useState({ title: '', slug: '/', status: 'draft' });
  const [code, setCode] = useState(emptyCode);
  const { present: blocks, commit, undo, redo, reset, canUndo, canRedo } = useHistory([]);

  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('builder');
  const [device, setDevice] = useState('desktop');
  const [showOutlines, setShowOutlines] = useState(true);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  // Mirrors dirtyRef for RENDER. dirtyRef is a ref (deliberately — the write
  // path must read the newest value without waiting for a render), so the
  // "Save changes" chip needs its own reactive copy.
  const [hasPending, setHasPending] = useState(false);

  // ---- refs so the debounced flush always sends the LATEST state -----------
  const blocksRef = useRef(blocks);
  const metaRef = useRef(meta);
  const codeRef = useRef(code);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { codeRef.current = code; }, [code]);

  const dirtyRef = useRef(new Set());
  const timerRef = useRef(null);
  // Every flush() queues behind the previous one on this chain, so ONE PATCH
  // is in flight at a time AND every caller awaits the true settle — including
  // the follow-up write that used to be fired-and-forgotten via setTimeout.
  // That mattered because autoSnapshot() awaits flush() before snapshotting:
  // the old version returned immediately whenever a save was already in
  // flight, so the snapshot could describe the DB as it was BEFORE the
  // operator's last edit landed, and the deferred write then auto-persisted
  // the AI batch that was supposed to stay a draft.
  const flushChainRef = useRef(null);
  const abortRef = useRef(null);
  // Bumped by every restore. A PATCH whose epoch is stale must not apply its
  // response — the page it was describing has been replaced underneath it.
  const restoreEpochRef = useRef(0);
  // Last save failure, readable synchronously. The Code view awaits its apply
  // and must be told whether the PATCH was REFUSED (validateBlocks) — reading
  // the `saveError` state there would read the render before last.
  const lastSaveErrorRef = useRef(null);

  // ---- load -----------------------------------------------------------------
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get(`/funnels/${id}`);
      const d = res.data?.data || {};
      const p = (d.pages || []).find((x) => x.id === pageId);
      setFunnel(d.funnel || null);
      if (!p) {
        setLoadError('Page not found');
      } else {
        setPage(p);
        setMeta({ title: p.title || '', slug: p.slug || '/', status: p.status || 'draft' });
        setCode(codeFromPage(p));
        reset(withIds(p.blocks));
      }
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to load page');
    } finally {
      setLoading(false);
    }
  }, [id, pageId, reset]);

  useEffect(() => { load(); }, [load]);

  // ---- autosave engine ------------------------------------------------------
  const writeOnce = useCallback(async () => {
    const keys = Array.from(dirtyRef.current);
    if (!keys.length) return;
    dirtyRef.current = new Set();
    setHasPending(false);

    // Pinned BEFORE the request. If a restore lands while this PATCH is in
    // flight, the response describes a page state the operator has explicitly
    // thrown away — applying it would silently undo the restore.
    const epoch = restoreEpochRef.current;

    const payload = {};
    for (const k of keys) {
      if (k === 'blocks') payload.blocks = blocksRef.current;
      else if (CODE_FIELDS.includes(k)) payload[k] = codeRef.current[k];
      else payload[k] = metaRef.current[k];
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setSaveState('saving');
    try {
      const res = await api.patch(`/funnels/${id}/pages/${pageId}`, payload, {
        signal: controller.signal,
      });
      if (restoreEpochRef.current !== epoch) return; // superseded — drop it
      setPage(res.data?.data || null);
      setSaveState('saved');
      setSaveError(null);
      lastSaveErrorRef.current = null;
    } catch (err) {
      // A save abandoned by a restore is not a failure to report, and its
      // fields must NOT be re-dirtied: they describe the pre-restore page.
      if (restoreEpochRef.current !== epoch) return;
      // Re-mark the failed fields dirty so the next edit (or Retry) resends
      // them — a rejected save must never silently drop edits or wedge.
      for (const k of keys) dirtyRef.current.add(k);
      setHasPending(true);
      setSaveState('error');
      const msg = err.response?.data?.error || err.message || 'Save failed';
      lastSaveErrorRef.current = msg;
      setSaveError(msg);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [id, pageId]);

  // Serialized, and awaitable to the TRUE settle. A caller that awaits this
  // has its edits on disk (or has seen them fail), which is the contract
  // autoSnapshot depends on.
  const flush = useCallback(async () => {
    const run = (flushChainRef.current || Promise.resolve())
      .catch(() => {})
      .then(() => writeOnce());
    flushChainRef.current = run;
    await run;
  }, [writeOnce]);

  const scheduleSave = useCallback((...fields) => {
    for (const f of fields) dirtyRef.current.add(f);
    setHasPending(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // ---- block operations -----------------------------------------------------
  const atLimit = blocks.length >= BLOCKS_MAX_COUNT;

  const insertAt = useCallback((index, type) => {
    if (!isInsertable(type)) return; // soon-entries can never be inserted
    if (blocksRef.current.length >= BLOCKS_MAX_COUNT) return;
    const blk = createBlock(type);
    commit((prev) => {
      const next = prev.slice();
      next.splice(Math.max(0, Math.min(index, next.length)), 0, blk);
      return next;
    }, `insert_${blk.id}`);
    setSelectedId(blk.id);
    scheduleSave('blocks');
  }, [commit, scheduleSave]);

  const appendBlock = useCallback((type) => insertAt(blocksRef.current.length, type), [insertAt]);

  const moveBlock = useCallback((from, to) => {
    commit((prev) => {
      if (from === to || from < 0 || from >= prev.length) return prev;
      const next = prev.slice();
      const [b] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, b);
      return next;
    }, 'reorder');
    scheduleSave('blocks');
  }, [commit, scheduleSave]);

  const deleteBlock = useCallback((blockId) => {
    commit((prev) => prev.filter((b) => b.id !== blockId), `delete_${blockId}`);
    setSelectedId((s) => (s === blockId ? null : s));
    scheduleSave('blocks');
  }, [commit, scheduleSave]);

  const duplicateBlock = useCallback((blockId) => {
    if (blocksRef.current.length >= BLOCKS_MAX_COUNT) return;
    let newId = null;
    commit((prev) => {
      const i = prev.findIndex((b) => b.id === blockId);
      if (i === -1) return prev;
      const copy = JSON.parse(JSON.stringify(prev[i]));
      copy.id = newBlockId();
      newId = copy.id;
      const next = prev.slice();
      next.splice(i + 1, 0, copy);
      return next;
    }, `dup_${blockId}`);
    if (newId) setSelectedId(newId);
    scheduleSave('blocks');
  }, [commit, scheduleSave]);

  const updateProp = useCallback((blockId, key, value) => {
    commit((prev) => prev.map((b) => {
      if (b.id !== blockId) return b;
      const props = { ...(b.props || {}) };
      if (value === undefined || value === '') delete props[key];
      else props[key] = value;
      return { ...b, props };
    }), `prop_${blockId}_${key}`);
    scheduleSave('blocks');
  }, [commit, scheduleSave]);

  // ---- AI Developer ---------------------------------------------------------
  // Applies Claude's validated ops through the SAME history commit user edits
  // use (one undo step per batch). DRAFT SEMANTICS: we mark 'blocks' dirty but
  // do NOT start the autosave timer — the AI change persists only when the
  // operator publishes (flush) or makes a normal edit that autosaves.
  // Best-effort version snapshot. Never throws, never blocks an edit.
  //
  // The slot is CLAIMED BEFORE the await: two AI batches fired back to back
  // must not both pass the rate check while the first request is still in
  // flight (a plain "check the timestamp, then await" reads the same stale
  // value twice and takes two snapshots).
  //
  // flush() runs first because the server snapshots what is IN THE DATABASE.
  // Skipping it would label the operator's last unsaved paragraph 'before AI
  // edit' — a snapshot of a state that is not the one being replaced.
  const lastAutoSnapRef = useRef(0);
  const autoSnapshot = useCallback(async (label) => {
    const now = Date.now();
    if (now - lastAutoSnapRef.current < AUTO_SNAP_MIN_MS) return;
    const previousSlot = lastAutoSnapRef.current;
    lastAutoSnapRef.current = now;
    try {
      if (timerRef.current) clearTimeout(timerRef.current);
      await flush();
      await api.post(`/page-versions/${id}/${pageId}/snapshot`, { label });
    } catch {
      // Fail-open by design: a versioning hiccup must never stop the operator
      // from editing. The drawer's manual Snapshot button surfaces the real
      // error when they go looking.
      //
      // Give the slot BACK. Burning the 30s window on a snapshot that never
      // happened is the worst of both worlds: the operator gets no version
      // AND the next AI batch — the one most likely to need a rollback point —
      // is refused a snapshot too.
      lastAutoSnapRef.current = previousSlot;
    }
  }, [id, pageId, flush]);

  const applyOpsNow = useCallback((ops) => {
    commit((prev) => {
      let next = prev.map((b) => ({ ...b }));
      for (const op of ops) {
        const idx = next.findIndex((b) => b.id === op.block_id);
        if (op.op === 'replace_props') {
          if (idx !== -1) next[idx] = { ...next[idx], props: op.props };
        } else if (op.op === 'remove_block') {
          if (idx !== -1) next.splice(idx, 1);
        } else if (op.op === 'move_block') {
          if (idx !== -1) {
            const [b] = next.splice(idx, 1);
            next.splice(Math.max(0, Math.min(op.index, next.length)), 0, b);
          }
        } else if (op.op === 'insert_block' && op.block) {
          if (next.length < BLOCKS_MAX_COUNT) {
            next.splice(Math.max(0, Math.min(op.index ?? next.length, next.length)), 0, op.block);
          }
        }
      }
      return next;
    }, `ai_${Date.now()}`);
    dirtyRef.current.add('blocks'); // picked up by the next Save / Publish
  }, [commit]);

  // Declared AFTER applyOpsNow so the dependency is real rather than a
  // forward reference the linter has to be told to ignore.
  const applyAiOps = useCallback(async (ops) => {
    if (!Array.isArray(ops) || !ops.length) return;
    // Snapshot BEFORE the ops land, bounded so a slow or dead endpoint cannot
    // hold the batch hostage. `finally` guarantees the commit runs whatever
    // the snapshot did.
    try {
      await Promise.race([
        autoSnapshot('before AI edit'),
        new Promise((r) => { setTimeout(r, AUTO_SNAP_MAX_WAIT_MS); }),
      ]);
    } finally {
      applyOpsNow(ops);
    }
  }, [autoSnapshot, applyOpsNow]);

  // A restore replaces the SERVER's copy of this page. The editor must adopt
  // it wholesale — and, critically, DROP every pending dirty field and the
  // queued autosave first: a timer that fires after the restore would PATCH
  // the pre-restore blocks straight back over it and silently undo the whole
  // operation.
  const onVersionRestored = useCallback((p) => {
    // FIRST, unconditionally, before anything can await: stop the debounce
    // timer, drop every dirty field, abort any PATCH already on the wire and
    // bump the epoch so its response is ignored if it lands anyway. This runs
    // even when the response carried no page — a restore that succeeded
    // server-side but returned an unreadable body must still not leave a
    // pending write pointed at the content it replaced.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    dirtyRef.current = new Set();
    restoreEpochRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (!p) {
      setSaveState('error');
      setSaveError('Restored, but the updated page did not come back — reload to see it.');
      return;
    }
    setPage(p);
    setMeta({ title: p.title || '', slug: p.slug || '/', status: p.status || 'draft' });
    setCode(codeFromPage(p));
    reset(withIds(p.blocks));
    setSelectedId(null);
    setSaveState('saved');
    setSaveError(null);
  }, [reset]);

  // ---- undo / redo (buttons + keyboard) -------------------------------------
  const doUndo = useCallback(() => {
    const v = undo();
    if (v) scheduleSave('blocks');
  }, [undo, scheduleSave]);
  const doRedo = useCallback(() => {
    const v = redo();
    if (v) scheduleSave('blocks');
  }, [redo, scheduleSave]);

  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (editable) return; // native undo inside fields
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo]);

  // ---- meta / code changes --------------------------------------------------
  const onMeta = useCallback((patch) => {
    setMeta((m) => ({ ...m, ...patch }));
    scheduleSave(...Object.keys(patch));
  }, [scheduleSave]);

  // ---- Code view apply ------------------------------------------------------
  // The Code view hands back a whole page: the re-parsed blocks array plus the
  // escape-hatch columns. It rides the SAME history commit and the SAME
  // validateBlocks-guarded PATCH as every other edit — one undo step, one
  // write path, no code-specific endpoint.
  //
  // The refs are pushed forward BEFORE the flush because flush() reads refs,
  // not state: waiting for React to commit would send the PREVIOUS document.
  const applyCodeDoc = useCallback(async ({ blocks: nextBlocks, code: nextCode }) => {
    const withIdBlocks = withIds(nextBlocks);
    commit(() => withIdBlocks, `code_${Date.now()}`);
    blocksRef.current = withIdBlocks;
    dirtyRef.current.add('blocks');

    const patch = {};
    for (const f of CODE_FIELDS) {
      if (nextCode && Object.prototype.hasOwnProperty.call(nextCode, f)) patch[f] = nextCode[f];
    }
    if (Object.keys(patch).length) {
      setCode((c) => ({ ...c, ...patch }));
      codeRef.current = { ...codeRef.current, ...patch };
      for (const f of Object.keys(patch)) dirtyRef.current.add(f);
    }

    setHasPending(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    lastSaveErrorRef.current = null;
    await flush();
    // writeOnce swallows its error (the banner owns it) and re-dirties the
    // failed fields. A non-empty dirty set after the settle therefore means
    // the server REFUSED — rethrow so the Code view keeps the operator's text
    // and shows the refusal instead of reporting a save that did not happen.
    if (dirtyRef.current.size) {
      throw new Error(lastSaveErrorRef.current || 'The server refused this document');
    }
  }, [commit, flush]);

  // ---- preview / publish ----------------------------------------------------
  const openPreview = useCallback(async () => {
    try {
      const res = await api.get(`/funnels/${id}/pages/${pageId}/preview-url`);
      const { path, preview: isPreview } = res.data?.data || {};
      if (path) window.open(isPreview ? `${path}?preview=1` : path, '_blank', 'noopener');
    } catch {
      setSaveState('error');
      setSaveError('Failed to build preview URL');
    }
  }, [id, pageId]);

  const republish = useCallback(async () => {
    setPublishing(true);
    try {
      // Persist anything pending first so what publishes is what's on screen.
      if (timerRef.current) clearTimeout(timerRef.current);
      dirtyRef.current.add('status');
      metaRef.current = { ...metaRef.current, status: 'published' };
      setMeta((m) => ({ ...m, status: 'published' }));
      // Send everything that might be dirty in one PATCH.
      await flush();
    } finally {
      setPublishing(false);
    }
  }, [flush]);

  // ---- derived --------------------------------------------------------------
  const selectedBlock = useMemo(
    () => blocks.find((b) => b.id === selectedId) || null,
    [blocks, selectedId]
  );
  const tMeta = typeMeta(page?.type);
  const deviceWidth = DEVICES.find((d) => d.id === device)?.width || 1100;

  // "Saved / Save changes" — the chip states the TRUTH about the disk, so an
  // edit that is still only in the browser reads as "Save changes" (and is
  // clickable to flush now) rather than borrowing the last save's "Saved".
  const saveChip = useMemo(() => {
    if (saveState === 'saving') return { icon: Loader2, text: 'Saving…', spin: true, cls: 'text-text-muted' };
    if (saveState === 'error') return { icon: AlertCircle, text: 'Save failed', spin: false, cls: 'text-danger' };
    if (hasPending) return { icon: UploadCloud, text: 'Save changes', spin: false, cls: 'text-amber-400' };
    if (saveState === 'saved') return { icon: Check, text: 'Saved', spin: false, cls: 'text-success' };
    return { icon: null, text: '', spin: false, cls: 'text-text-faint' };
  }, [saveState, hasPending]);

  // ---- render ---------------------------------------------------------------
  if (loading) return <div className="p-6 text-text-muted">Loading builder…</div>;
  if (loadError || !page) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-danger">{loadError || 'Page not found'}</div>
        <Button variant="secondary" onClick={() => navigate(`/app/funnels/${id}`)}>
          <ArrowLeft className="w-4 h-4" /> Back to canvas
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-var(--topbar-h))] min-h-0">
      {/* ---------------- Top bar ---------------- */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle bg-bg-card shrink-0 flex-wrap">
        <button
          onClick={() => navigate(`/app/funnels/${id}`)}
          className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer shrink-0"
          title="Back to the flow canvas"
        >
          <ArrowLeft className="w-4 h-4" /> Flow
        </button>

        <div className="min-w-0 flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary truncate max-w-48">{meta.title || 'Untitled page'}</span>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0"
            style={{ color: tMeta.color, background: `${tMeta.color}1a`, border: `1px solid ${tMeta.color}55` }}
          >
            {tMeta.label}
          </span>
          <span className="text-[11px] text-text-faint font-mono truncate hidden md:block">
            /f/{funnel?.slug}{meta.slug === '/' ? '' : meta.slug}
          </span>
        </div>

        {/* Builder | Code tabs */}
        <div className="flex rounded-lg border border-border-default overflow-hidden ml-2">
          {[['builder', 'Builder'], ['code', 'Code']].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`px-3 py-1 text-xs font-medium cursor-pointer transition-colors
                ${tab === v ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Device toggles */}
        <div className="flex rounded-lg border border-border-default overflow-hidden">
          {DEVICES.map((d) => {
            const Icon = d.icon;
            return (
              <button
                key={d.id}
                onClick={() => !d.disabled && setDevice(d.id)}
                disabled={d.disabled}
                title={d.label}
                className={`px-2 py-1.5 transition-colors
                  ${d.disabled
                    ? 'text-text-faint opacity-40 cursor-not-allowed'
                    : device === d.id
                      ? 'bg-bg-hover text-text-primary cursor-pointer'
                      : 'text-text-faint hover:text-text-primary cursor-pointer'}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>

        {/* Undo / redo */}
        <div className="flex gap-0.5">
          <button
            onClick={doUndo}
            disabled={!canUndo}
            title="Undo (⌘Z)"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={doRedo}
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        {/* Block counter */}
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${atLimit ? 'text-danger border-danger/40' : 'text-text-faint border-border-subtle'}`}>
          {blocks.length}/{BLOCKS_MAX_COUNT}
        </span>

        {/* Save state — clickable whenever there is something to flush */}
        <button
          onClick={() => { if (hasPending || saveState === 'error') { if (timerRef.current) clearTimeout(timerRef.current); flush(); } }}
          disabled={!hasPending && saveState !== 'error'}
          title={hasPending || saveState === 'error' ? 'Save now' : 'Everything on this page is saved'}
          className={`flex items-center gap-1 text-xs w-28 justify-end ${saveChip.cls}
            ${hasPending || saveState === 'error' ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {saveChip.icon && <saveChip.icon className={`w-3.5 h-3.5 ${saveChip.spin ? 'animate-spin' : ''}`} />}
          {saveChip.text}
        </button>

        {/* Scan — reuses the existing clone-a-page modal (scan a URL / paste
            code / generate) rather than a second import surface. */}
        <button
          onClick={() => setScanOpen(true)}
          title="Scan a page — clone from a URL, paste code, or generate a new page"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors border border-border-default text-text-muted hover:text-text-primary"
        >
          <ScanLine className="w-3.5 h-3.5" /> Scan
        </button>

        {/* Version history */}
        <button
          onClick={() => setVersionsOpen((o) => !o)}
          title="Version history — snapshot, preview and restore this page"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors border
            ${versionsOpen
              ? 'border-sky-400/60 text-sky-400 bg-sky-400/10'
              : 'border-border-default text-text-muted hover:text-text-primary'}`}
        >
          <History className="w-3.5 h-3.5" /> Versions
        </button>

        {/* AI Developer — toggles the Claude chat panel */}
        <button
          onClick={() => setAiOpen((o) => !o)}
          title="AI Developer — describe a change, Claude writes the code"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors
            ${aiOpen ? 'bg-emerald-500 text-white' : 'bg-emerald-600/80 hover:bg-emerald-600 text-white'}`}
        >
          <Bot className="w-3.5 h-3.5" /> AI Developer
        </button>

        <Button variant="secondary" size="sm" onClick={openPreview}>
          <ExternalLink className="w-3.5 h-3.5" /> Preview
        </Button>
        <Button size="sm" onClick={republish} loading={publishing} title="Set this page's status to published and save everything pending">
          <UploadCloud className="w-3.5 h-3.5" /> {meta.status === 'published' ? 'Re-publish' : 'Publish'}
        </Button>
      </div>

      {/* Save error banner — inline, dismissible, never wedges the editor */}
      {saveState === 'error' && saveError && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-danger/10 border-b border-danger/30 text-xs text-danger shrink-0">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{saveError}</span>
          <button onClick={() => flush()} className="underline cursor-pointer shrink-0">Retry</button>
          <button onClick={() => { setSaveState('idle'); setSaveError(null); }} className="ml-auto cursor-pointer shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ---------------- Body ---------------- */}
      <div className="flex flex-1 min-h-0">
        {tab === 'builder' ? (
          <>
            <LeftPanel
              blocks={blocks}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={appendBlock}
              onReorder={moveBlock}
              onDelete={deleteBlock}
            />
            <CanvasArea
              blocks={blocks}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onInsertAt={insertAt}
              onMove={moveBlock}
              onProp={updateProp}
              onDuplicate={duplicateBlock}
              onDelete={deleteBlock}
              showOutlines={showOutlines}
              onToggleOutlines={() => setShowOutlines((o) => !o)}
              device={device}
              deviceWidth={deviceWidth}
              atLimit={atLimit}
              pageCss={code.custom_css}
            />
            <RightPanel
              block={selectedBlock}
              meta={meta}
              funnel={funnel}
              blocksCount={blocks.length}
              saveError={saveError}
              onMeta={onMeta}
              onProp={(key, value) => selectedBlock && updateProp(selectedBlock.id, key, value)}
              onDelete={() => selectedBlock && deleteBlock(selectedBlock.id)}
              onDuplicate={() => selectedBlock && duplicateBlock(selectedBlock.id)}
            />
          </>
        ) : (
          <CodeTab code={code} blocks={blocks} onApply={applyCodeDoc} />
        )}
        {scanOpen && (
          <ClonePageModal
            open={scanOpen}
            funnelId={id}
            onClose={() => setScanOpen(false)}
            onCreated={(p) => {
              // A scan creates a NEW page. Go to its builder rather than
              // silently leaving the operator on the old one.
              if (p?.id) navigate(`/app/funnels/${id}/pages/${p.id}/builder`);
            }}
          />
        )}
        {versionsOpen && (
          <VersionsDrawer
            funnelId={id}
            pageId={pageId}
            onClose={() => setVersionsOpen(false)}
            onRestored={onVersionRestored}
          />
        )}
        {aiOpen && (
          <AIDeveloperPanel
            funnelId={id}
            pageId={pageId}
            blocks={blocks}
            selectedBlock={selectedBlock}
            selectedIndex={blocks.findIndex((b) => b.id === selectedId)}
            onApplyOps={applyAiOps}
            onClose={() => setAiOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
