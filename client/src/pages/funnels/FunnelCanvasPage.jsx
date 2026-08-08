import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  MarkerType,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Settings,
  BarChart3,
  ExternalLink,
  Plus,
  Layout,
  Rows3,
  Undo2,
  Redo2,
  Smartphone,
  Tablet,
  Monitor,
  Check,
  Loader2,
  Globe,
  Pencil,
  Trash2,
  Home,
  Copy as CopyIcon,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { StatusPill } from './FunnelsPage';
import PageNode from '../../components/funnels/PageNode';
import { PALETTE, DEVICE_WIDTHS } from '../../components/funnels/pageTypes';

const nodeTypes = { page: PageNode };

const randSuffix = () => Math.random().toString(16).slice(2, 6);

// App-model edge {source,target,kind} -> React Flow edge (styled by kind).
function toRfEdge(e, idx) {
  const kind = e.kind === 'fallback' ? 'fallback' : 'main';
  const color = kind === 'fallback' ? '#ef4444' : '#c9a84c';
  return {
    id: e.id || `edge_${kind}_${e.source}_${e.target}_${idx}`,
    source: e.source,
    target: e.target,
    sourceHandle: kind === 'fallback' ? 'fallback' : 'main',
    data: { kind },
    animated: kind === 'main',
    style: { stroke: color, strokeWidth: 2, strokeDasharray: kind === 'fallback' ? '6 4' : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  };
}

// React Flow edge -> app-model edge for persistence.
function toAppEdge(e) {
  const kind = e.data?.kind || (e.sourceHandle === 'fallback' ? 'fallback' : 'main');
  return { id: e.id, source: e.source, target: e.target, kind };
}

function CanvasInner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const wrapperRef = useRef(null);
  const rf = useReactFlow();

  const [funnel, setFunnel] = useState(null);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('canvas'); // 'canvas' | 'pages'
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [deviceSize, setDeviceSize] = useState('M');
  const [zoomPct, setZoomPct] = useState(100);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [publishing, setPublishing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [creating, setCreating] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const saveTimer = useRef(null);
  const history = useRef({ stack: [], index: -1 });
  const [histVersion, setHistVersion] = useState(0);

  // ---- Node action handlers (stable via refs so node.data stays cheap) ----
  const actionsRef = useRef({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get(`/funnels/${id}`);
      const d = res.data?.data || {};
      const f = d.funnel || null;
      const pgs = d.pages || [];
      setFunnel(f);
      setPages(pgs);
      setNameDraft(f?.name || '');

      const layout = f?.flow_layout || { nodes: [], edges: [] };
      const posById = new Map((layout.nodes || []).map((n) => [n.id, n]));
      let autoX = 80;
      const rfNodes = pgs.map((p, i) => {
        const saved = posById.get(p.id);
        const position = saved
          ? { x: Number(saved.x) || 0, y: Number(saved.y) || 0 }
          : { x: 80 + (i % 4) * 300, y: 80 + Math.floor(i / 4) * 240 };
        return {
          id: p.id,
          type: 'page',
          position,
          data: { page: p, deviceSize, ...actionsRef.current },
        };
      });
      const validIds = new Set(pgs.map((p) => p.id));
      const rfEdges = (layout.edges || [])
        .filter((e) => validIds.has(e.source) && validIds.has(e.target))
        .map(toRfEdge);
      setNodes(rfNodes);
      setEdges(rfEdges);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load funnel');
    } finally {
      setLoading(false);
    }
  }, [id, deviceSize, setNodes, setEdges]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep deviceSize live on every node (cosmetic width toggle).
  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, deviceSize } })));
  }, [deviceSize, setNodes]);

  // ---- Persist flow (debounced) ----
  const buildPayload = useCallback(() => {
    const ns = rf.getNodes().map((n) => ({
      id: n.id,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
    }));
    const es = rf.getEdges().map(toAppEdge);
    return { nodes: ns, edges: es };
  }, [rf]);

  const persistFlow = useCallback(
    (immediate = false) => {
      clearTimeout(saveTimer.current);
      const doSave = async () => {
        setSaveState('saving');
        try {
          await api.patch(`/funnels/${id}/flow`, buildPayload());
          setSaveState('saved');
        } catch (err) {
          setSaveState('error');
          // Reconcile: pull authoritative state back from the server.
          load();
        }
      };
      if (immediate) doSave();
      else saveTimer.current = setTimeout(doSave, 500);
    },
    [id, buildPayload, load]
  );

  // ---- Undo / redo (snapshots of positions + edges) ----
  const snapshot = useCallback(
    () => ({
      nodes: rf.getNodes().map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      edges: rf.getEdges().map(toAppEdge),
    }),
    [rf]
  );

  const pushHistory = useCallback(() => {
    const h = history.current;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(snapshot());
    if (h.stack.length > 50) h.stack.shift();
    h.index = h.stack.length - 1;
    setHistVersion((v) => v + 1);
  }, [snapshot]);

  const applySnapshot = useCallback(
    (snap) => {
      const posById = new Map(snap.nodes.map((n) => [n.id, n]));
      setNodes((nds) =>
        nds.map((n) => {
          const p = posById.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        })
      );
      setEdges(snap.edges.map(toRfEdge));
    },
    [setNodes, setEdges]
  );

  const undo = useCallback(() => {
    const h = history.current;
    if (h.index <= 0) return;
    h.index -= 1;
    applySnapshot(h.stack[h.index]);
    setHistVersion((v) => v + 1);
    persistFlow(true);
  }, [applySnapshot, persistFlow]);

  const redo = useCallback(() => {
    const h = history.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    applySnapshot(h.stack[h.index]);
    setHistVersion((v) => v + 1);
    persistFlow(true);
  }, [applySnapshot, persistFlow]);

  // Seed the initial history entry once pages have loaded.
  useEffect(() => {
    if (!loading && funnel && history.current.stack.length === 0 && nodes.length >= 0) {
      history.current = { stack: [snapshot()], index: 0 };
      setHistVersion((v) => v + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, funnel]);

  // ---- Canvas events ----
  const onConnect = useCallback(
    (params) => {
      const kind = params.sourceHandle === 'fallback' ? 'fallback' : 'main';
      const appEdge = { source: params.source, target: params.target, kind };
      setEdges((eds) => addEdge(toRfEdge(appEdge, eds.length), eds));
      pushHistory();
      persistFlow();
    },
    [setEdges, pushHistory, persistFlow]
  );

  const onNodeDragStop = useCallback(() => {
    pushHistory();
    persistFlow();
  }, [pushHistory, persistFlow]);

  const onEdgesDelete = useCallback(() => {
    pushHistory();
    persistFlow();
  }, [pushHistory, persistFlow]);

  const onMove = useCallback((_e, viewport) => {
    setZoomPct(Math.round((viewport?.zoom || 1) * 100));
  }, []);

  // ---- Page CRUD from the canvas ----
  const centerPosition = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 200, y: 200 };
    return rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [rf]);

  const addPage = useCallback(
    async (item) => {
      if (creating) return;
      setCreating(true);
      setError(null);
      try {
        const count = pages.length + 1;
        const slug = pages.length === 0 ? '/' : `/${item.key}-${randSuffix()}`;
        const res = await api.post(`/funnels/${id}/pages`, {
          title: `${item.label} ${count}`,
          slug,
          type: item.type,
        });
        const page = res.data?.data;
        const pos = centerPosition();
        setPages((prev) => [...prev, page]);
        setNodes((nds) => [
          ...nds,
          { id: page.id, type: 'page', position: pos, data: { page, deviceSize, ...actionsRef.current } },
        ]);
        pushHistory();
        persistFlow(true);
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to add page');
      } finally {
        setCreating(false);
      }
    },
    [creating, pages, id, centerPosition, deviceSize, setNodes, pushHistory, persistFlow]
  );

  const duplicatePage = useCallback(
    async (page) => {
      setError(null);
      try {
        const res = await api.post(`/funnels/${id}/pages`, {
          title: `${page.title} copy`,
          slug: `/${(page.type || 'page')}-${randSuffix()}`,
          type: page.type,
        });
        const np = res.data?.data;
        // Carry blocks + escape-hatch content over.
        try {
          await api.patch(`/funnels/${id}/pages/${np.id}`, { blocks: page.blocks ?? [] });
        } catch { /* non-fatal */ }
        const src = rf.getNodes().find((n) => n.id === page.id);
        const pos = src ? { x: src.position.x + 40, y: src.position.y + 40 } : centerPosition();
        setPages((prev) => [...prev, np]);
        setNodes((nds) => [
          ...nds,
          { id: np.id, type: 'page', position: pos, data: { page: np, deviceSize, ...actionsRef.current } },
        ]);
        pushHistory();
        persistFlow(true);
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to duplicate page');
      }
    },
    [id, rf, centerPosition, deviceSize, setNodes, pushHistory, persistFlow]
  );

  const deletePage = useCallback(
    async (page) => {
      setError(null);
      try {
        await api.post(`/funnels/${id}/pages/${page.id}/archive`, { archived: true });
        setPages((prev) => prev.filter((p) => p.id !== page.id));
        setNodes((nds) => nds.filter((n) => n.id !== page.id));
        setEdges((eds) => eds.filter((e) => e.source !== page.id && e.target !== page.id));
        pushHistory();
        persistFlow(true);
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to archive page');
      }
    },
    [id, setNodes, setEdges, pushHistory, persistFlow]
  );

  const previewPage = useCallback(
    async (page) => {
      try {
        const res = await api.get(`/funnels/${id}/pages/${page.id}/preview-url`);
        const { path, preview } = res.data?.data || {};
        if (path) window.open(preview ? `${path}?preview=1` : path, '_blank', 'noopener');
      } catch {
        setError('Failed to build preview URL');
      }
    },
    [id]
  );

  const editPage = useCallback((page) => navigate(`/app/funnels/${id}/pages/${page.id}`), [navigate, id]);

  // Wire the stable action handlers into node.data once.
  actionsRef.current = {
    onEdit: editPage,
    onCode: editPage,
    onSettings: editPage,
    onAnalytics: () => {},
    onPreview: previewPage,
    onDuplicate: duplicatePage,
    onDelete: deletePage,
  };
  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, ...actionsRef.current } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editPage, previewPage, duplicatePage, deletePage, setNodes]);

  // ---- Publish + rename ----
  const publish = useCallback(async () => {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      const res = await api.post(`/funnels/${id}/publish`);
      setFunnel((f) => ({ ...f, ...res.data?.data }));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to publish funnel');
    } finally {
      setPublishing(false);
    }
  }, [id, publishing]);

  const saveName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name || name === funnel?.name) {
      setRenaming(false);
      return;
    }
    try {
      const res = await api.patch(`/funnels/${id}`, { name });
      setFunnel((f) => ({ ...f, ...res.data?.data }));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename funnel');
    } finally {
      setRenaming(false);
    }
  }, [id, nameDraft, funnel]);

  const published = funnel?.status === 'published' || funnel?.status === 'live';
  const publicPath = funnel ? `/f/${funnel.slug}` : '';
  const canUndo = history.current.index > 0;
  const canRedo = history.current.index < history.current.stack.length - 1;

  const saveHint = useMemo(() => {
    if (saveState === 'saving') return { icon: Loader2, text: 'Saving…', spin: true, cls: 'text-text-muted' };
    if (saveState === 'error') return { icon: null, text: 'Save failed', spin: false, cls: 'text-danger' };
    if (saveState === 'saved') return { icon: Check, text: 'Saved', spin: false, cls: 'text-success' };
    return { icon: Check, text: 'Saved', spin: false, cls: 'text-text-faint' };
  }, [saveState]);

  if (loading) return <div className="p-6 text-text-muted">Loading canvas…</div>;
  if (!funnel) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-danger">{error || 'Funnel not found'}</div>
        <Button variant="secondary" onClick={() => navigate('/app/funnels')}>
          <ArrowLeft className="w-4 h-4" /> Back to funnels
        </Button>
      </div>
    );
  }

  const SaveIcon = saveHint.icon;

  return (
    <div className="flex flex-col h-[calc(100vh-var(--topbar-h))]">
      {/* ── Header bar ─────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border-default bg-bg-card">
        <button
          onClick={() => navigate('/app/funnels')}
          className="text-text-muted hover:text-text-primary cursor-pointer"
          title="Back to funnels"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span
          className={`w-2 h-2 rounded-full ${published ? 'bg-success' : 'bg-text-faint'}`}
          title={published ? 'Published' : 'Draft'}
        />
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && saveName()}
            className="px-2 py-1 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary focus:outline-none focus:border-border-strong"
          />
        ) : (
          <button
            onClick={() => { setNameDraft(funnel.name); setRenaming(true); }}
            className="text-base font-semibold text-text-primary hover:text-accent-text cursor-pointer truncate max-w-[240px]"
            title="Rename"
          >
            {funnel.name}
          </button>
        )}
        <StatusPill status={published ? 'published' : 'draft'} />
        <span className="text-xs text-text-faint font-mono truncate hidden md:inline">{publicPath}</span>

        {/* Settings menu */}
        <div className="relative">
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex items-center gap-1 text-text-muted hover:text-text-primary cursor-pointer text-sm"
          >
            <Settings className="w-4 h-4" /> <ChevronDown className="w-3 h-3" />
          </button>
          {settingsOpen && (
            <div
              className="absolute z-20 mt-1 w-44 rounded-lg bg-bg-elevated border border-border-default shadow-xl py-1"
              onMouseLeave={() => setSettingsOpen(false)}
            >
              <button
                onClick={() => { setNameDraft(funnel.name); setRenaming(true); setSettingsOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer flex items-center gap-2"
              >
                <Pencil className="w-3.5 h-3.5" /> Rename funnel
              </button>
              <button
                onClick={() => { setView('pages'); setSettingsOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer flex items-center gap-2"
              >
                <Rows3 className="w-3.5 h-3.5" /> Pages list
              </button>
            </div>
          )}
        </div>

        {/* Autosave hint */}
        <span className={`flex items-center gap-1 text-xs ${saveHint.cls}`}>
          {SaveIcon && <SaveIcon className={`w-3.5 h-3.5 ${saveHint.spin ? 'animate-spin' : ''}`} />}
          {saveHint.text}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Domain slot (placeholder until slice 5) */}
          <span className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-md border border-border-default text-xs text-text-faint">
            <Globe className="w-3.5 h-3.5" />
            {funnel.custom_domain || 'No domain'}
            <span className="px-1 py-0.5 rounded bg-bg-elevated text-[9px] uppercase tracking-wide">not default</span>
          </span>

          {/* Live chip */}
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-elevated text-xs text-text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            — live · — today
          </span>

          <button className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer" title="Analytics (soon)">
            <BarChart3 className="w-4 h-4" />
          </button>
          <a
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            title="Live site"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
          <Button size="sm" onClick={publish} loading={publishing}>
            {published ? 'Published' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* ── View tabs ──────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-1.5 border-b border-border-subtle bg-bg-card">
        <button
          onClick={() => setView('canvas')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs cursor-pointer transition-colors ${
            view === 'canvas' ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <Layout className="w-3.5 h-3.5" /> Canvas
        </button>
        <button
          onClick={() => setView('pages')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs cursor-pointer transition-colors ${
            view === 'pages' ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <Rows3 className="w-3.5 h-3.5" /> Pages ({pages.length})
        </button>
        {error && <span className="ml-3 text-xs text-danger">{error}</span>}
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      {view === 'canvas' ? (
        <div className="flex-1 flex min-h-0">
          {/* Left ADD A PAGE panel */}
          <div
            className={`shrink-0 border-r border-border-default bg-bg-card overflow-y-auto transition-[width] ${
              paletteOpen ? 'w-60' : 'w-9'
            }`}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle sticky top-0 bg-bg-card">
              {paletteOpen && (
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">Add a page</span>
              )}
              <button
                onClick={() => setPaletteOpen((v) => !v)}
                className="text-text-muted hover:text-text-primary cursor-pointer"
                title={paletteOpen ? 'Collapse' : 'Expand'}
              >
                {paletteOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
            {paletteOpen && (
              <div className="p-2 space-y-1">
                {PALETTE.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      onClick={() => addPage(item)}
                      disabled={creating}
                      className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-bg-hover border border-transparent hover:border-border-default transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Icon className="w-4 h-4 mt-0.5 text-text-muted shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm text-text-primary leading-tight">{item.label}</span>
                        <span className="block text-[11px] text-text-faint leading-tight">{item.subtitle}</span>
                      </span>
                    </button>
                  );
                })}
                <div className="my-2 border-t border-border-subtle" />
                {[
                  { label: 'Clone a page', subtitle: 'Link · HTML · file upload' },
                  { label: 'Page library', subtitle: 'Drag to clone' },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left opacity-40 cursor-not-allowed"
                    title="Coming soon"
                  >
                    <Plus className="w-4 h-4 mt-0.5 text-text-faint shrink-0" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm text-text-muted leading-tight">
                        {item.label}
                        <span className="px-1 py-0.5 rounded bg-bg-elevated text-[9px] uppercase text-text-faint">soon</span>
                      </span>
                      <span className="block text-[11px] text-text-faint leading-tight">{item.subtitle}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Canvas */}
          <div ref={wrapperRef} className="flex-1 min-w-0 relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStop={onNodeDragStop}
              onEdgesDelete={onEdgesDelete}
              onMove={onMove}
              nodeTypes={nodeTypes}
              colorMode="dark"
              deleteKeyCode={['Backspace', 'Delete']}
              fitView
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#27272a" gap={20} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                style={{ background: '#111113', border: '1px solid rgba(255,255,255,0.08)' }}
                maskColor="rgba(0,0,0,0.6)"
                nodeColor="#27272a"
              />

              {/* Bottom-right toolbar */}
              <Panel position="bottom-right" className="!m-3">
                <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-bg-elevated border border-border-default shadow-xl">
                  <button onClick={undo} disabled={!canUndo} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" title="Undo">
                    <Undo2 className="w-4 h-4" />
                  </button>
                  <button onClick={redo} disabled={!canRedo} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" title="Redo">
                    <Redo2 className="w-4 h-4" />
                  </button>
                  <div className="w-px h-5 bg-border-default mx-0.5" />
                  <button onClick={() => rf.fitView({ padding: 0.2 })} className="px-2 py-1 rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer" title="Fit view">
                    Fit
                  </button>
                  <span className="px-1.5 text-xs text-text-faint tabular-nums w-11 text-center">{zoomPct}%</span>
                  <div className="w-px h-5 bg-border-default mx-0.5" />
                  {[
                    { k: 'S', icon: Smartphone },
                    { k: 'M', icon: Tablet },
                    { k: 'L', icon: Monitor },
                  ].map(({ k, icon: Icon }) => (
                    <button
                      key={k}
                      onClick={() => setDeviceSize(k)}
                      className={`p-1.5 rounded-md cursor-pointer transition-colors ${
                        deviceSize === k ? 'bg-bg-hover text-accent-text' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                      }`}
                      title={`${k} card size`}
                    >
                      <Icon className="w-4 h-4" />
                    </button>
                  ))}
                </div>
              </Panel>

              {nodes.length === 0 && (
                <Panel position="top-center" className="!mt-16">
                  <div className="text-center text-text-muted text-sm px-4 py-3 rounded-lg bg-bg-card/80 border border-border-subtle">
                    Empty canvas — pick a page type on the left to add your first page.
                  </div>
                </Panel>
              )}
            </ReactFlow>
          </div>
        </div>
      ) : (
        <PagesListTab
          pages={pages}
          onEdit={editPage}
          onPreview={previewPage}
          onDuplicate={duplicatePage}
          onDelete={deletePage}
        />
      )}
    </div>
  );
}

function PagesListTab({ pages, onEdit, onPreview, onDuplicate, onDelete }) {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
              <th className="text-left font-medium px-4 py-3">Title</th>
              <th className="text-left font-medium px-4 py-3">Slug</th>
              <th className="text-left font-medium px-4 py-3">Type</th>
              <th className="text-left font-medium px-4 py-3">Status</th>
              <th className="text-right font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-text-muted">
                  No pages yet. Switch to Canvas and add one.
                </td>
              </tr>
            ) : (
              pages.map((p) => (
                <tr key={p.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span className="text-text-primary font-medium">{p.title || '—'}</span>
                      {p.is_home && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-muted text-accent-text border border-accent/20">
                          <Home className="w-3 h-3" /> home
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-muted font-mono text-xs">{p.slug}</td>
                  <td className="px-4 py-3 text-text-muted">{p.type}</td>
                  <td className="px-4 py-3"><StatusPill status={p.status} /></td>
                  <td className="px-4 py-3">
                    <span className="flex items-center justify-end gap-1">
                      <button onClick={() => onPreview(p)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer" title="Preview">
                        <ExternalLink className="w-4 h-4" />
                      </button>
                      <button onClick={() => onDuplicate(p)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer" title="Duplicate">
                        <CopyIcon className="w-4 h-4" />
                      </button>
                      <button onClick={() => onEdit(p)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer" title="Edit page">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => onDelete(p)} className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer" title="Archive page">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FunnelCanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
