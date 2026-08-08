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
  Smartphone, Tablet, Monitor, UploadCloud, Eye, EyeOff, AlertCircle, X,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../../components/ui/Button';
import { typeMeta } from '../../../components/funnels/pageTypes';
import useHistory from './useHistory';
import { createBlock, withIds, newBlockId, BLOCKS_MAX_COUNT } from './blockRegistry';
import LeftPanel from './LeftPanel';
import RightPanel from './RightPanel';
import CanvasArea from './CanvasArea';
import CodeTab from './CodeTab';

const DEVICES = [
  { id: 'mobile', width: 375, icon: Smartphone, label: 'Mobile (375px)' },
  { id: 'tablet', width: 768, icon: Tablet, label: 'Tablet (768px)' },
  { id: 'desktop', width: 1100, icon: Monitor, label: 'Desktop (1100px)' },
];

const SAVE_DEBOUNCE_MS = 800;

export default function PageBuilderPage() {
  const { id, pageId } = useParams();
  const navigate = useNavigate();

  const [funnel, setFunnel] = useState(null);
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [meta, setMeta] = useState({ title: '', slug: '/', status: 'draft' });
  const [code, setCode] = useState({ custom_css: '', custom_js: '' });
  const { present: blocks, commit, undo, redo, reset, canUndo, canRedo } = useHistory([]);

  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('builder');
  const [device, setDevice] = useState('desktop');
  const [showOutlines, setShowOutlines] = useState(true);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null);
  const [publishing, setPublishing] = useState(false);

  // ---- refs so the debounced flush always sends the LATEST state -----------
  const blocksRef = useRef(blocks);
  const metaRef = useRef(meta);
  const codeRef = useRef(code);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { codeRef.current = code; }, [code]);

  const dirtyRef = useRef(new Set());
  const timerRef = useRef(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);

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
        setCode({ custom_css: p.custom_css || '', custom_js: p.custom_js || '' });
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
  const flush = useCallback(async () => {
    if (inFlightRef.current) { queuedRef.current = true; return; }
    const keys = Array.from(dirtyRef.current);
    if (!keys.length) return;
    dirtyRef.current = new Set();

    const payload = {};
    for (const k of keys) {
      if (k === 'blocks') payload.blocks = blocksRef.current;
      else if (k === 'custom_css') payload.custom_css = codeRef.current.custom_css;
      else if (k === 'custom_js') payload.custom_js = codeRef.current.custom_js;
      else payload[k] = metaRef.current[k];
    }

    inFlightRef.current = true;
    setSaveState('saving');
    try {
      const res = await api.patch(`/funnels/${id}/pages/${pageId}`, payload);
      setPage(res.data?.data || null);
      setSaveState('saved');
      setSaveError(null);
    } catch (err) {
      // Re-mark the failed fields dirty so the next edit (or Retry) resends
      // them — a rejected save must never silently drop edits or wedge.
      for (const k of keys) dirtyRef.current.add(k);
      setSaveState('error');
      setSaveError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        // Another edit landed while saving — persist the newest state.
        setTimeout(() => { flush(); }, 0);
      }
    }
  }, [id, pageId]);

  const scheduleSave = useCallback((...fields) => {
    for (const f of fields) dirtyRef.current.add(f);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // ---- block operations -----------------------------------------------------
  const atLimit = blocks.length >= BLOCKS_MAX_COUNT;

  const insertAt = useCallback((index, type) => {
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

  const onCode = useCallback((patch) => {
    setCode((c) => ({ ...c, ...patch }));
    scheduleSave(...Object.keys(patch));
  }, [scheduleSave]);

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

  const saveChip = useMemo(() => {
    if (saveState === 'saving') return { icon: Loader2, text: 'Saving…', spin: true, cls: 'text-text-muted' };
    if (saveState === 'error') return { icon: AlertCircle, text: 'Save failed', spin: false, cls: 'text-danger' };
    if (saveState === 'saved') return { icon: Check, text: 'Saved', spin: false, cls: 'text-success' };
    return { icon: null, text: '', spin: false, cls: 'text-text-faint' };
  }, [saveState]);

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
                onClick={() => setDevice(d.id)}
                title={d.label}
                className={`px-2 py-1.5 cursor-pointer transition-colors ${device === d.id ? 'bg-bg-hover text-text-primary' : 'text-text-faint hover:text-text-primary'}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>

        {/* Outlines toggle */}
        <button
          onClick={() => setShowOutlines((o) => !o)}
          title={showOutlines ? 'Hide block outlines' : 'Show block outlines'}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
        >
          {showOutlines ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
        </button>

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

        {/* Save state */}
        <span className={`flex items-center gap-1 text-xs w-20 justify-end ${saveChip.cls}`}>
          {saveChip.icon && <saveChip.icon className={`w-3.5 h-3.5 ${saveChip.spin ? 'animate-spin' : ''}`} />}
          {saveChip.text}
        </span>

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
              showOutlines={showOutlines}
              deviceWidth={deviceWidth}
              atLimit={atLimit}
              pageCss={code.custom_css}
            />
            <RightPanel
              block={selectedBlock}
              meta={meta}
              funnel={funnel}
              onMeta={onMeta}
              onProp={(key, value) => selectedBlock && updateProp(selectedBlock.id, key, value)}
              onDelete={() => selectedBlock && deleteBlock(selectedBlock.id)}
              onDuplicate={() => selectedBlock && duplicateBlock(selectedBlock.id)}
            />
          </>
        ) : (
          <CodeTab css={code.custom_css} js={code.custom_js} blocks={blocks} onChange={onCode} />
        )}
      </div>
    </div>
  );
}
