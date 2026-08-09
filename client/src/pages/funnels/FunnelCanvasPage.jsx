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
  Shuffle,
  SlidersHorizontal,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { StatusPill } from './FunnelsPage';
import PageNode from '../../components/funnels/PageNode';
import { PALETTE, DEVICE_WIDTHS } from '../../components/funnels/pageTypes';
import FunnelSettingsModal from '../../components/funnels/settings/FunnelSettingsModal';
import SplitGroupNode from '../../components/funnels/split/SplitGroupNode';
import SplitSetupModal from '../../components/funnels/split/SplitSetupModal';
import ClonePageModal from '../../components/funnels/ClonePageModal';
import SplitResultsModal from '../../components/funnels/split/SplitResultsModal';
import SplitQuickCreateModal from '../../components/funnels/split/SplitQuickCreateModal';
import {
  fetchFunnelSplitTests, fetchSplitMetrics, fetchLifetimeResults,
  armLetter, fmtInt, fmtPct, utcDay,
} from '../../components/funnels/split/splitApi';

const nodeTypes = { page: PageNode, splitGroup: SplitGroupNode };

// Canvas-only node id for a split group. It is NEVER persisted: the funnel's
// flow_layout is validated server-side against this funnel's PAGE ids, so a
// split id in the payload would 400 the autosave and take the whole layout
// with it. buildPayload/snapshot both filter on this prefix.
const SPLIT_NODE_PREFIX = 'split:';
const isSplitNode = (n) => String(n?.id || '').startsWith(SPLIT_NODE_PREFIX);

const randSuffix = () => Math.random().toString(16).slice(2, 6);

// App-model edge {source,target,kind} -> React Flow edge (styled by kind).
// Reference look: dashed green connector arrows on the main path; the
// fallback (decline) path stays red-dashed so a downsell reads at a glance.
function toRfEdge(e, idx) {
  const kind = e.kind === 'fallback' ? 'fallback' : 'main';
  const color = kind === 'fallback' ? '#ef4444' : '#22c55e';
  return {
    id: e.id || `edge_${kind}_${e.source}_${e.target}_${idx}`,
    source: e.source,
    target: e.target,
    sourceHandle: kind === 'fallback' ? 'fallback' : 'main',
    data: { kind },
    animated: kind === 'main',
    style: { stroke: color, strokeWidth: 2, strokeDasharray: '6 4' },
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
  // FUNNEL-SETTINGS lane (additive): ?view=pages|redirects deep-links straight
  // to a tab — used by the settings modal's "Manage on the canvas" links.
  const [view, setView] = useState(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    return v === 'pages' || v === 'redirects' ? v : 'canvas';
  }); // 'canvas' | 'pages' | 'redirects'
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [deviceSize, setDeviceSize] = useState('M');
  const [zoomPct, setZoomPct] = useState(100);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [publishing, setPublishing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [funnelSettingsOpen, setFunnelSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  // ---- Split tests (A/B groups on this funnel) ----
  const [splits, setSplits] = useState([]);
  const [splitTiles, setSplitTiles] = useState({}); // testId -> { armKey: {visitors, orders, cvr} }
  const [splitSetupId, setSplitSetupId] = useState(null);
  const [splitResultsId, setSplitResultsId] = useState(null);
  const [splitQuickPage, setSplitQuickPage] = useState(null); // page = variant A of a quick A/B create

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

  // ---- Split tests + their canvas tiles -----------------------------------
  // Visitors / Orders / CVR, preferring the analytics overlay (windowed) and
  // falling back to the split ledger's lifetime figures.
  //
  // The third tile is NOT CTR. Neither source can measure one — the ledger has
  // never seen a click, and the overlay's `submit_rate` is a constant 1 by
  // construction, which would render as a permanent "100.0%". Orders is a real
  // number in both sources, so the tile says something true in both modes.
  const loadSplits = useCallback(async () => {
    let tests = [];
    try {
      tests = await fetchFunnelSplitTests(id);
    } catch {
      // Splits are additive to the canvas. If the endpoint is unreachable the
      // canvas must still render every page — so this swallows and stops.
      setSplits([]);
      return;
    }
    setSplits(tests);
    const entries = await Promise.all(
      tests.map(async (t) => {
        // Windowed from the day the test was created (the server would default
        // to the last 30 days, silently clipping older tests) — the canvas
        // caption says "since created" and this is what makes that true. UTC
        // day on purpose: the server truncates in UTC, and the local day of a
        // 23:50Z creation would start the window a day late.
        const from = t.created_at ? utcDay(t.created_at) : undefined;
        const overlay = await fetchSplitMetrics(t.id, from ? { from } : {});
        if (overlay.available) {
          // normalizeMetrics has already converted `cvr` from a fraction to a
          // percent exactly once — it must NOT be scaled again here.
          return [t.id, Object.fromEntries((overlay.data.arms || []).map((a) => [a.arm_key, {
            visitors: a.visitors === undefined ? undefined : fmtInt(a.visitors),
            orders: a.orders === undefined ? undefined : fmtInt(a.orders),
            cvr: a.cvr === undefined ? undefined : fmtPct(a.cvr, { digits: 1 }),
          }]))];
        }
        try {
          const life = await fetchLifetimeResults(t.id);
          return [t.id, Object.fromEntries((life?.arms || []).map((a) => {
            const exp = Number(a.exposures) || 0;
            const conv = Number(a.conversions) || 0;
            return [a.arm_key, {
              visitors: fmtInt(exp),
              orders: fmtInt(conv),
              cvr: exp > 0 ? fmtPct((conv / exp) * 100, { digits: 1 }) : undefined,
            }];
          }))];
        } catch {
          return [t.id, {}];
        }
      })
    );
    setSplitTiles(Object.fromEntries(entries));
  }, [id]);

  useEffect(() => { loadSplits(); }, [loadSplits]);

  // ---- Per-page metrics overlay + live counter ----------------------------
  // The canvas overlay feed: GET /funnel-analytics/funnel/:id/overview with
  // the DEFAULT window (the server defaults to the last 30 days). Each node
  // gets { visitors, ctr, cvr } keyed by page_id; null renders "—", never 0
  // (null = could not measure). Refreshed every 60s. Additive: if the
  // endpoint is unreachable the canvas still renders every page.
  const [pageMetrics, setPageMetrics] = useState({}); // page_id -> {visitors, ctr, cvr}
  const [liveStats, setLiveStats] = useState(null); // {live, unique_today} | null

  // STALE-RESPONSE GUARD: navigating funnel A → funnel B can leave A's fetch
  // in flight; without a check its late response would overwrite B's numbers
  // with A's. Capture the funnel id at request time and drop any response
  // whose id no longer matches the mounted one.
  const metricsIdRef = useRef(id);
  useEffect(() => {
    metricsIdRef.current = id;
  }, [id]);

  const loadMetrics = useCallback(async () => {
    const fid = id;
    try {
      const res = await api.get(`/funnel-analytics/funnel/${fid}/overview`);
      if (metricsIdRef.current !== fid) return; // stale — a different funnel is mounted now
      const rows = res.data?.pages || [];
      setPageMetrics(
        Object.fromEntries(
          rows.map((p) => [p.page_id, { visitors: p.visitors, ctr: p.ctr, cvr: p.cvr }])
        )
      );
    } catch {
      // Metrics are an overlay — a failed read leaves the last known values.
    }
  }, [id]);

  const loadLive = useCallback(async () => {
    const fid = id;
    try {
      const res = await api.get(`/funnel-analytics/funnel/${fid}/live`);
      if (metricsIdRef.current !== fid) return; // stale — a different funnel is mounted now
      const d = res.data || {};
      setLiveStats(
        typeof d.live === 'number' || typeof d.unique_today === 'number'
          ? { live: d.live, unique_today: d.unique_today }
          : null
      );
    } catch {
      if (metricsIdRef.current === fid) setLiveStats(null);
    }
  }, [id]);

  useEffect(() => {
    // Reset before the first load for this funnel so the previous funnel's
    // numbers never render against the new funnel's pages.
    setPageMetrics({});
    setLiveStats(null);
    loadMetrics();
    loadLive();
    const mTimer = setInterval(loadMetrics, 60_000);
    const lTimer = setInterval(loadLive, 30_000);
    return () => { clearInterval(mTimer); clearInterval(lTimer); };
  }, [loadMetrics, loadLive]);

  // Thread the metric rows into page node data (same pattern as the split
  // tiles: data flows in via setNodes, the node component only renders).
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) =>
        isSplitNode(n) ? n : { ...n, data: { ...n.data, metrics: pageMetrics[n.id] || null } }
      )
    );
  }, [pageMetrics, setNodes]);

  // Keep deviceSize live on every node (cosmetic width toggle).
  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, deviceSize } })));
  }, [deviceSize, setNodes]);

  // ---- Compose the A/B group nodes ----------------------------------------
  // A page that is a live arm is HIDDEN rather than removed: React Flow keeps
  // hidden nodes in getNodes(), so their saved positions still round-trip
  // through the layout autosave and their edges are preserved untouched. The
  // group node itself is anchored on the entry arm's page position, so it
  // lands where the operator already put that page.
  useEffect(() => {
    const pageById = new Map(pages.map((p) => [p.id, p]));
    setNodes((nds) => {
      const posById = new Map(nds.filter((n) => !isSplitNode(n)).map((n) => [n.id, n.position]));
      const armPageIds = new Set();
      const splitNodes = [];

      for (const t of splits) {
        if (t.archived) continue;
        const live = (t.arms || []).filter((a) => !a.archived);
        if (!live.length) continue;
        const anchorArm = live.find((a) => a.is_entry) || live[0];
        for (const a of live) if (a.page_id) armPageIds.add(a.page_id);
        const tiles = splitTiles[t.id] || {};
        // Anchor on the entry arm's page. A test whose arms have no page yet
        // has nothing to anchor on, so it falls back to a staircase keyed by
        // its index — two page-less splits must not land on the same pixel and
        // hide each other.
        const anchorPos = (anchorArm.page_id && posById.get(anchorArm.page_id))
          || { x: 80 + splitNodes.length * 60, y: 80 + splitNodes.length * 60 };
        splitNodes.push({
          id: `${SPLIT_NODE_PREFIX}${t.id}`,
          type: 'splitGroup',
          position: anchorPos,
          // Never selectable as a delete target: Backspace on the canvas must
          // not appear to "delete" a split (it would only remove the node from
          // the view while the test kept running).
          deletable: false,
          data: {
            testId: t.id,
            handle: t.handle,
            arms: live.map((a, i) => {
              const p = a.page_id ? pageById.get(a.page_id) : null;
              const m = tiles[a.arm_key] || {};
              return {
                id: a.id,
                letter: armLetter(i),
                is_entry: Boolean(a.is_entry),
                title: p?.title,
                slug: p?.slug,
                // Thumbnail identity: the shared loader keys on
                // funnel_id/page_id/updated_at (an edit bumps the key → refetch).
                page_id: a.page_id || null,
                funnel_id: p ? id : null,
                page_updated_at: p?.updated_at,
                visitors: m.visitors,
                orders: m.orders,
                cvr: m.cvr,
              };
            }),
            onResults: () => setSplitResultsId(t.id),
            onSetup: () => setSplitSetupId(t.id),
            onWeights: () => setSplitSetupId(t.id),
          },
        });
      }

      const pageNodes = nds
        .filter((n) => !isSplitNode(n))
        .map((n) => (armPageIds.has(n.id) === Boolean(n.hidden) ? n : { ...n, hidden: armPageIds.has(n.id) }));
      return [...pageNodes, ...splitNodes];
    });
  }, [splits, splitTiles, pages, setNodes, id]);

  // ---- Persist flow (debounced) ----
  const buildPayload = useCallback(() => {
    // Split group nodes are canvas-only — see SPLIT_NODE_PREFIX. Hidden arm
    // page nodes ARE included: getNodes() returns them and their positions
    // must survive, otherwise unhiding an arm would drop it at the origin.
    const ns = rf.getNodes()
      .filter((n) => !isSplitNode(n))
      .map((n) => ({
        id: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      }));
    const es = rf.getEdges().filter((e) => !isSplitNode({ id: e.source }) && !isSplitNode({ id: e.target })).map(toAppEdge);
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
      nodes: rf.getNodes().filter((n) => !isSplitNode(n)).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      edges: rf.getEdges().filter((e) => !isSplitNode({ id: e.source }) && !isSplitNode({ id: e.target })).map(toAppEdge),
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
    const base = rect
      ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 200, y: 200 };
    // Offset so consecutive "add page" clicks don't stack on the exact same spot
    const n = rf.getNodes().length;
    return { x: base.x + (n % 5) * 36, y: base.y + (n % 5) * 36 };
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

  // Clone-a-page: the modal already created the page server-side — drop it
  // onto the canvas exactly the way addPage does after its POST.
  const onClonedPage = useCallback(
    (page) => {
      if (!page) return;
      const pos = centerPosition();
      setPages((prev) => [...prev, page]);
      setNodes((nds) => [
        ...nds,
        { id: page.id, type: 'page', position: pos, data: { page, deviceSize, ...actionsRef.current } },
      ]);
      pushHistory();
      persistFlow(true);
    },
    [centerPosition, deviceSize, setNodes, pushHistory, persistFlow]
  );

  const duplicatePage = useCallback(
    async (page) => {
      setError(null);
      try {
        // Atomic server-side copy: page row + blocks + escape-hatch fields in
        // one transaction (the old 2-call composite could silently land an
        // empty copy when the blocks PATCH failed).
        const res = await api.post(`/funnels/${id}/pages/${page.id}/duplicate`);
        const np = res.data?.data;
        if (!np?.id) {
          // A 2xx without the page row is a shape we do not understand —
          // pushing it into the canvas would render a ghost node.
          setError('Duplicate did not return the new page — reload and check the pages list');
          return;
        }
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
    funnelSlug: funnel?.slug, // F7: node cards show the page's public URL
    onEdit: editPage,
    onCode: editPage,
    onSettings: editPage,
    onAnalytics: () => {},
    onPreview: previewPage,
    onDuplicate: duplicatePage,
    onDelete: deletePage,
    onSplitTest: (page) => setSplitQuickPage(page),
  };
  useEffect(() => {
    // Page actions belong to page nodes only — a split group node carries its
    // OWN handlers (onSetup/onResults) and must not have them shadowed.
    setNodes((nds) =>
      nds.map((n) => (isSplitNode(n) ? n : { ...n, data: { ...n.data, ...actionsRef.current } }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editPage, previewPage, duplicatePage, deletePage, setNodes, funnel?.slug]);

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

        {/* Funnel settings (operator control center) */}
        <button
          onClick={() => setFunnelSettingsOpen(true)}
          className="flex items-center gap-1.5 text-text-muted hover:text-text-primary cursor-pointer text-sm"
          title="Funnel settings"
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span className="hidden lg:inline">Settings</span>
        </button>

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

          {/* Live chip — distinct visitors last 5 min · distinct today (UTC),
              polled every 30s from /funnel-analytics/funnel/:id/live. Null
              (endpoint down / tracking degraded) renders "—", never 0. */}
          <span
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-elevated text-xs text-text-muted"
            title="Distinct visitors: last 5 minutes · today (UTC)"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${liveStats && liveStats.live > 0 ? 'bg-success animate-pulse' : 'bg-text-faint'}`}
            />
            {typeof liveStats?.live === 'number' ? liveStats.live : '—'} live ·{' '}
            {typeof liveStats?.unique_today === 'number' ? liveStats.unique_today : '—'} unique today
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
        <button
          onClick={() => setView('redirects')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs cursor-pointer transition-colors ${
            view === 'redirects' ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <Shuffle className="w-3.5 h-3.5" /> Redirects
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
                <button
                  onClick={() => setCloneOpen(true)}
                  disabled={creating}
                  className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-bg-hover border border-transparent hover:border-border-default transition-colors cursor-pointer disabled:opacity-50"
                >
                  <CopyIcon className="w-4 h-4 mt-0.5 text-text-muted shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-text-primary leading-tight">Clone a page</span>
                    <span className="block text-[11px] text-text-faint leading-tight">Paste code · HTML · file upload</span>
                  </span>
                </button>
                {[
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
      ) : view === 'pages' ? (
        <PagesListTab
          pages={pages}
          onEdit={editPage}
          onPreview={previewPage}
          onDuplicate={duplicatePage}
          onDelete={deletePage}
        />
      ) : (
        <RedirectsTab funnelId={id} />
      )}

      <FunnelSettingsModal
        open={funnelSettingsOpen}
        onClose={() => setFunnelSettingsOpen(false)}
        funnel={funnel}
        initialSection="payments"
        onFunnelUpdated={(f) => { if (f) setFunnel((prev) => ({ ...prev, ...f })); }}
      />

      <SplitSetupModal
        open={Boolean(splitSetupId)}
        onClose={() => setSplitSetupId(null)}
        funnel={funnel}
        testId={splitSetupId}
        onTestChanged={loadSplits}
      />

      <SplitResultsModal
        open={Boolean(splitResultsId)}
        onClose={() => setSplitResultsId(null)}
        test={splits.find((t) => t.id === splitResultsId) || null}
        // Promoting a winner pauses the test and moves the entry arm; without
        // this the canvas kept rendering the pre-promote state until a reload.
        onPromoted={loadSplits}
      />

      <SplitQuickCreateModal
        open={Boolean(splitQuickPage)}
        onClose={() => setSplitQuickPage(null)}
        funnel={funnel}
        pageA={splitQuickPage}
        onCreated={async (newTestId) => {
          setSplitQuickPage(null);
          await loadSplits();
          setSplitSetupId(newTestId); // straight into the full setup modal
        }}
      />

      <ClonePageModal
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        funnelId={id}
        onCreated={onClonedPage}
      />
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

// ── Redirects tab ──────────────────────────────────────────────────────────
// Simple CRUD over /api/v1/funnels/:id/redirects. Exact match beats
// longest-prefix at serve time; the query string is preserved through the hop.
function RedirectsTab({ funnelId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({ from_path: '', to_path: '', match: 'exact', code: 301 });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get(`/funnels/${funnelId}/redirects`);
      setRows(res.data?.data?.redirects || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load redirects');
    } finally {
      setLoading(false);
    }
  }, [funnelId]);

  useEffect(() => {
    load();
  }, [load]);

  const addRow = useCallback(async () => {
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await api.post(`/funnels/${funnelId}/redirects`, {
        from_path: draft.from_path.trim(),
        to_path: draft.to_path.trim(),
        match: draft.match,
        code: Number(draft.code),
      });
      setRows((prev) => [...prev, res.data?.data]);
      setDraft({ from_path: '', to_path: '', match: 'exact', code: 301 });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add redirect');
    } finally {
      setAdding(false);
    }
  }, [adding, draft, funnelId]);

  const patchRow = useCallback(
    async (rid, patch) => {
      setError(null);
      // optimistic
      setRows((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
      try {
        const res = await api.patch(`/funnels/${funnelId}/redirects/${rid}`, patch);
        setRows((prev) => prev.map((r) => (r.id === rid ? res.data?.data : r)));
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to update redirect');
        load(); // reconcile from server
      }
    },
    [funnelId, load]
  );

  const deleteRow = useCallback(
    async (rid) => {
      setError(null);
      try {
        await api.delete(`/funnels/${funnelId}/redirects/${rid}`);
        setRows((prev) => prev.filter((r) => r.id !== rid));
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to delete redirect');
      }
    },
    [funnelId]
  );

  const inputCls =
    'w-full px-2 py-1 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary font-mono focus:outline-none focus:border-border-strong';
  const selectCls =
    'px-2 py-1 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary focus:outline-none focus:border-border-strong cursor-pointer';

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Redirects</h2>
        <p className="text-xs text-text-faint mt-0.5">
          Funnel-relative paths. Exact match beats longest prefix; the query string is preserved through the redirect.
        </p>
      </div>
      {error && <div className="mb-3 text-xs text-danger">{error}</div>}
      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
              <th className="text-left font-medium px-4 py-3">From</th>
              <th className="text-left font-medium px-4 py-3">To</th>
              <th className="text-left font-medium px-4 py-3">Match</th>
              <th className="text-left font-medium px-4 py-3">Code</th>
              <th className="text-left font-medium px-4 py-3">Enabled</th>
              <th className="text-right font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-text-muted">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                  No redirects yet. Add one below.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2">
                    <input
                      className={inputCls}
                      defaultValue={r.from_path}
                      key={`from-${r.id}-${r.from_path}`}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== r.from_path) patchRow(r.id, { from_path: v });
                      }}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      className={inputCls}
                      defaultValue={r.to_path}
                      key={`to-${r.id}-${r.to_path}`}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== r.to_path) patchRow(r.id, { to_path: v });
                      }}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className={selectCls}
                      value={r.match}
                      onChange={(e) => patchRow(r.id, { match: e.target.value })}
                    >
                      <option value="exact">exact</option>
                      <option value="prefix">prefix</option>
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className={selectCls}
                      value={r.code}
                      onChange={(e) => patchRow(r.id, { code: Number(e.target.value) })}
                    >
                      <option value={301}>301</option>
                      <option value={302}>302</option>
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => patchRow(r.id, { enabled: !r.enabled })}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${
                        r.enabled ? 'bg-success' : 'bg-bg-elevated border border-border-default'
                      }`}
                      title={r.enabled ? 'Enabled' : 'Disabled'}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          r.enabled ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => deleteRow(r.id)}
                        className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer"
                        title="Delete redirect"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
            {/* Add-row */}
            <tr className="bg-bg-elevated/40">
              <td className="px-4 py-2">
                <input
                  className={inputCls}
                  placeholder="/old"
                  value={draft.from_path}
                  onChange={(e) => setDraft((d) => ({ ...d, from_path: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && addRow()}
                />
              </td>
              <td className="px-4 py-2">
                <input
                  className={inputCls}
                  placeholder="/new"
                  value={draft.to_path}
                  onChange={(e) => setDraft((d) => ({ ...d, to_path: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && addRow()}
                />
              </td>
              <td className="px-4 py-2">
                <select
                  className={selectCls}
                  value={draft.match}
                  onChange={(e) => setDraft((d) => ({ ...d, match: e.target.value }))}
                >
                  <option value="exact">exact</option>
                  <option value="prefix">prefix</option>
                </select>
              </td>
              <td className="px-4 py-2">
                <select
                  className={selectCls}
                  value={draft.code}
                  onChange={(e) => setDraft((d) => ({ ...d, code: Number(e.target.value) }))}
                >
                  <option value={301}>301</option>
                  <option value={302}>302</option>
                </select>
              </td>
              <td className="px-4 py-2 text-text-faint text-xs">—</td>
              <td className="px-4 py-2">
                <span className="flex items-center justify-end">
                  <Button
                    size="sm"
                    onClick={addRow}
                    loading={adding}
                    disabled={!draft.from_path.trim() || !draft.to_path.trim()}
                  >
                    <Plus className="w-4 h-4" /> Add
                  </Button>
                </span>
              </td>
            </tr>
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
