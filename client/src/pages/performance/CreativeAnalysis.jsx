import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart3,
  Video,
  Image,
  RefreshCw,
  X,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Trophy,
  ShoppingCart,
  Zap,
  TrendingUp,
  Flame,
  ChevronDown,
  ChevronLeft,
  Calendar,
  Play,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart as RBarChart,
  Bar,
  Cell,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import api from '../../services/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** ISO week number — uses UTC to match the backend algorithm exactly */
function getISOWeek(date) {
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const diff = Math.floor(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - mondayW1.getTime()) /
      (7 * 24 * 60 * 60 * 1000),
  );
  const weekNum = diff + 1;
  if (weekNum < 1) {
    const prevJan4 = new Date(Date.UTC(year - 1, 0, 4));
    const prevDow = prevJan4.getUTCDay() || 7;
    const prevMondayW1 = new Date(prevJan4);
    prevMondayW1.setUTCDate(prevJan4.getUTCDate() - prevDow + 1);
    const prevDiff = Math.floor(
      (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - prevMondayW1.getTime()) /
        (7 * 24 * 60 * 60 * 1000),
    );
    return { week: prevDiff + 1, year: year - 1 };
  }
  return { week: weekNum, year };
}

function getCurrentWeek() {
  const now = new Date();
  const { week, year } = getISOWeek(now);
  return `WK${String(week).padStart(2, '0')}_${year}`;
}


/** Convert WKxx_YYYY to a readable date (Monday of that ISO week) */
function weekToDate(weekStr) {
  if (!weekStr) return '-';
  const match = weekStr.match(/WK(\d+)_(\d{4})/i);
  if (!match) return weekStr;
  const weekNum = parseInt(match[1], 10);
  const year = parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const start = new Date(mondayW1);
  start.setUTCDate(mondayW1.getUTCDate() + (weekNum - 1) * 7);
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtRoas = (n) => Number(n || 0).toFixed(2) + 'x';

const fmtPct = (n) => Number(n || 0).toFixed(2) + '%';

const fmtInt = (n) => Number(n || 0).toLocaleString();

const cardStyle = 'bg-[#111] border border-white/[0.06] rounded-xl p-5';
const selectStyle =
  'bg-white/[0.04] border border-white/[0.08] rounded-lg text-white px-3 py-2 text-sm focus:outline-none focus:border-white/20 appearance-none cursor-pointer';

const LEADERBOARD_CONFIG = [
  {
    title: 'Top by ROAS',
    key: 'topRoas',
    metricKey: 'roas',
    metricLabel: 'ROAS',
    format: fmtRoas,
    accent: 'text-yellow-400',
    accentBg: 'bg-yellow-500/10',
    accentBorder: 'border-yellow-500/20',
    icon: Trophy,
  },
  {
    title: 'Top by Purchases',
    key: 'topPurchases',
    metricKey: 'purchases',
    metricLabel: 'Purchases',
    format: fmtInt,
    accent: 'text-green-400',
    accentBg: 'bg-green-500/10',
    accentBorder: 'border-green-500/20',
    icon: ShoppingCart,
  },
  {
    title: 'Top by Efficiency',
    key: 'topEfficiency',
    metricKey: 'cpa',
    metricLabel: 'CPA',
    format: fmtMoney,
    accent: 'text-blue-400',
    accentBg: 'bg-blue-500/10',
    accentBorder: 'border-blue-500/20',
    icon: Zap,
  },
];

// Stable color assignments for tag badges
const TAG_COLORS = [
  { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  { bg: 'bg-purple-500/20', text: 'text-purple-400' },
  { bg: 'bg-rose-500/20', text: 'text-rose-400' },
  { bg: 'bg-sky-500/20', text: 'text-sky-400' },
  { bg: 'bg-lime-500/20', text: 'text-lime-400' },
  { bg: 'bg-orange-500/20', text: 'text-orange-400' },
  { bg: 'bg-teal-500/20', text: 'text-teal-400' },
  { bg: 'bg-pink-500/20', text: 'text-pink-400' },
  { bg: 'bg-indigo-500/20', text: 'text-indigo-400' },
  { bg: 'bg-cyan-500/20', text: 'text-cyan-400' },
];
const tagColorMap = {};
let tagColorIdx = 0;
const getTagColor = (val) => {
  if (!val) return null;
  if (!tagColorMap[val]) {
    tagColorMap[val] = TAG_COLORS[tagColorIdx % TAG_COLORS.length];
    tagColorIdx++;
  }
  return tagColorMap[val];
};

const TABLE_COLUMNS = [
  { key: 'type', label: 'Type', align: 'left' },
  { key: 'ad_name', label: 'Ad Name', align: 'left' },
  { key: 'avatar', label: 'Avatar', align: 'left' },
  { key: 'angle', label: 'Angle', align: 'left', tag: true },
  { key: 'format', label: 'Format', align: 'left', tag: true },
  { key: 'editor', label: 'Editor', align: 'left' },
  { key: 'launched', label: 'Date', align: 'left', format: weekToDate },
  { key: 'spend', label: 'Spend', align: 'right', format: fmtMoney },
  { key: 'revenue', label: 'Revenue', align: 'right', format: fmtMoney },
  { key: 'roas', label: 'ROAS', align: 'right', format: fmtRoas },
  { key: 'purchases', label: 'Purchases', align: 'right', format: fmtInt },
  { key: 'cpa', label: 'CPA', align: 'right', format: fmtMoney },
  { key: 'cpm', label: 'CPM', align: 'right', format: fmtMoney },
  { key: 'cpc', label: 'CPC', align: 'right', format: fmtMoney },
  { key: 'ctr', label: 'CTR', align: 'right', format: fmtPct },
  { key: 'impressions', label: 'Impr', align: 'right', format: fmtInt },
  { key: 'clicks', label: 'Clicks', align: 'right', format: fmtInt },
  { key: 'aov', label: 'AOV', align: 'right', format: fmtMoney },
];

// ── Date Presets ─────────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { label: 'Today', key: 'today' },
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'This week', key: 'this_week' },
  { label: 'This month', key: 'this_month' },
  { label: 'Last week', key: 'last_week' },
  { label: 'Last month', key: 'last_month' },
  { label: 'Last 7 days', key: 'last_7' },
  { label: 'Last 14 days', key: 'last_14' },
  { label: 'Last 30 days', key: 'last_30' },
  { label: 'Last 365 days', key: 'last_365' },
];

function presetToRange(key) {
  const today = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sub = (days) => { const d = new Date(today); d.setDate(d.getDate() - days); return d; };

  switch (key) {
    case 'today': return { startDate: fmt(today), endDate: fmt(today) };
    case 'yesterday': { const y = sub(1); return { startDate: fmt(y), endDate: fmt(y) }; }
    case 'this_week': {
      const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return { startDate: fmt(d), endDate: fmt(today) };
    }
    case 'this_month': {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      return { startDate: fmt(d), endDate: fmt(today) };
    }
    case 'last_week': {
      const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
      const end = new Date(d); end.setDate(d.getDate() + 6);
      return { startDate: fmt(d), endDate: fmt(end) };
    }
    case 'last_month': {
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { startDate: fmt(start), endDate: fmt(end) };
    }
    case 'last_7': return { startDate: fmt(sub(6)), endDate: fmt(today) };
    case 'last_14': return { startDate: fmt(sub(13)), endDate: fmt(today) };
    case 'last_30': return { startDate: fmt(sub(29)), endDate: fmt(today) };
    case 'last_365': return { startDate: fmt(sub(364)), endDate: fmt(today) };
    default: return { startDate: fmt(sub(13)), endDate: fmt(today) };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CreativeAnalysis() {
  const [datePreset, setDatePreset] = useState('last_7');
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [startDate, setStartDate] = useState(() => presetToRange('last_7').startDate);
  const [endDate, setEndDate] = useState(() => presetToRange('last_7').endDate);
  const [data, setData] = useState([]);
  const [leaderboard, setLeaderboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [latestWeek, setLatestWeek] = useState(null);
  const [filters, setFilters] = useState({
    creativeType: '',
    avatar: '',
    angle: '',
    format: '',
    editor: '',
  });

  const [expandedCreatives, setExpandedCreatives] = useState(new Set());
  const [sortConfig, setSortConfig] = useState({ key: 'spend', direction: 'desc' });
  const [chartCreative, setChartCreative] = useState(null); // creative_id showing chart
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);

  // ── Calendar widget state ──
  const [calViewYear, setCalViewYear] = useState(() => new Date().getFullYear());
  const [calViewMonth, setCalViewMonth] = useState(() => new Date().getMonth());
  const [calSelStart, setCalSelStart] = useState(null);
  const [calSelEnd, setCalSelEnd] = useState(null);
  const [calPicking, setCalPicking] = useState(null); // null | 'start' | 'end'

  // Sync calendar state when picker opens
  useEffect(() => {
    if (datePickerOpen) {
      const ed = new Date((endDate || new Date()) + (typeof endDate === 'string' ? 'T00:00' : ''));
      setCalViewYear(ed.getFullYear());
      setCalViewMonth(ed.getMonth());
      setCalSelStart(startDate);
      setCalSelEnd(endDate);
      setCalPicking(null);
    }
  }, [datePickerOpen]);

  // ── Column order (persisted to localStorage) ──
  const COLUMN_ORDER_KEY = 'ca_column_order';

  const [columnOrder, setColumnOrder] = useState(() => {
    try {
      const saved = localStorage.getItem(COLUMN_ORDER_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Validate: must contain exactly the same keys as TABLE_COLUMNS
        const defaultKeys = TABLE_COLUMNS.map((c) => c.key);
        if (
          Array.isArray(parsed) &&
          parsed.length === defaultKeys.length &&
          defaultKeys.every((k) => parsed.includes(k))
        ) {
          return parsed;
        }
      }
    } catch {}
    return TABLE_COLUMNS.map((c) => c.key);
  });

  const orderedColumns = useMemo(
    () => columnOrder.map((key) => TABLE_COLUMNS.find((c) => c.key === key)).filter(Boolean),
    [columnOrder],
  );

  const [dragCol, setDragCol] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);

  const handleDragStart = (key) => setDragCol(key);
  const handleDragOver = (e, key) => {
    e.preventDefault();
    if (key !== dragOverCol) setDragOverCol(key);
  };
  const handleDrop = (targetKey) => {
    if (!dragCol || dragCol === targetKey) {
      setDragCol(null);
      setDragOverCol(null);
      return;
    }
    setColumnOrder((prev) => {
      const next = [...prev];
      const fromIdx = next.indexOf(dragCol);
      const toIdx = next.indexOf(targetKey);
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, dragCol);
      localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(next));
      return next;
    });
    setDragCol(null);
    setDragOverCol(null);
  };
  const handleDragEnd = () => {
    setDragCol(null);
    setDragOverCol(null);
  };

  // ── Fetch ──

  const abortRef = useRef(null);
  const datePickerRef = useRef(null);

  // Click-outside handler for date picker
  useEffect(() => {
    if (!datePickerOpen) return;
    const handleClickOutside = (e) => {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target)) {
        setDatePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [datePickerOpen]);

  const fetchData = useCallback(async () => {
    // Cancel any in-flight request from a previous call
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setLoading(true);
    setError(null);
    try {
      let dataRes;
      let lbWeek = null;
      if (activeOnly) {
        dataRes = await api.get('/creative-analysis/active', { signal });
        const activeData = dataRes.data?.data || dataRes.data || {};
        if (activeData.latest_week) {
          lbWeek = activeData.latest_week;
          setLatestWeek(activeData.latest_week);
        }
      } else {
        dataRes = await api.get('/creative-analysis/data-by-date', { params: { startDate, endDate }, signal });
      }
      if (signal.aborted) return;
      const respData = dataRes.data?.data || dataRes.data || {};
      const creatives = respData.creatives || respData;
      setData(Array.isArray(creatives) ? creatives : []);

      // Leaderboard only in active mode (it's week-based)
      if (activeOnly && lbWeek) {
        const lbRes = await api.get('/creative-analysis/leaderboard', { params: { week: lbWeek }, signal });
        if (signal.aborted) return;
        setLeaderboard(lbRes.data?.data || lbRes.data || null);
      } else {
        setLeaderboard(null);
      }
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError' || signal.aborted) return;
      setError(err.response?.data?.error?.message || err.message || 'Failed to load data.');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [startDate, endDate, activeOnly]);

  const handleSync = async () => {
    setSyncing(true);
    const syncController = new AbortController();
    try {
      const syncWeek = latestWeek || getCurrentWeek();
      await api.post('/creative-analysis/sync', { week: syncWeek }, { signal: syncController.signal });
      // Also sync Meta thumbnails
      try { await api.post('/creative-analysis/sync-meta-thumbnails', {}, { signal: syncController.signal }); } catch {}
      await fetchData();
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      setError(err.response?.data?.error?.message || err.message || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => {
      clearInterval(interval);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchData]);

  // ── Filtering ──

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({ creativeType: '', avatar: '', angle: '', format: '', editor: '' });
  };

  const hasActiveFilters = Object.values(filters).some(Boolean);

  // Extract unique values for filter dropdowns
  const filterOptions = useMemo(() => {
    const opts = { avatar: new Set(), angle: new Set(), format: new Set(), editor: new Set() };
    (Array.isArray(data) ? data : []).forEach((row) => {
      if (row.avatar) opts.avatar.add(row.avatar);
      if (row.angle) opts.angle.add(row.angle);
      if (row.format) opts.format.add(row.format);
      if (row.editor) opts.editor.add(row.editor);
    });
    return {
      avatar: [...opts.avatar].sort(),
      angle: [...opts.angle].sort(),
      format: [...opts.format].sort(),
      editor: [...opts.editor].sort(),
    };
  }, [data]);

  // ── Grouping, sorting, filtering ──

  const processedData = useMemo(() => {
    let rows = Array.isArray(data) ? data : [];

    // Apply filters
    if (filters.creativeType) {
      rows = rows.filter(
        (r) => (r.type || '').toLowerCase() === filters.creativeType.toLowerCase()
      );
    }
    if (filters.avatar) rows = rows.filter((r) => r.avatar === filters.avatar);
    if (filters.angle) rows = rows.filter((r) => r.angle === filters.angle);
    if (filters.format) rows = rows.filter((r) => r.format === filters.format);
    if (filters.editor) rows = rows.filter((r) => r.editor === filters.editor);

    // Data from backend is already grouped by creative_id with hooks array
    // Each item: { creative_id, type, avatar, angle, format, editor, total_spend, total_revenue, roas, cpa, cpm, aov, cpc, ctr, hooks: [...] }
    const result = rows.map((creative) => ({
      ...creative,
      spend: creative.total_spend ?? creative.spend ?? 0,
      revenue: creative.total_revenue ?? creative.revenue ?? 0,
      purchases: creative.total_purchases ?? creative.purchases ?? 0,
      impressions: creative.total_impressions ?? creative.impressions ?? 0,
      clicks: creative.total_clicks ?? creative.clicks ?? 0,
      ad_name: creative.hooks?.reduce((best, h) => (h.spend > (best?.spend ?? -1) ? h : best), null)?.ad_name || creative.ad_name || creative.creative_id,
      launched: creative.first_seen || creative.week || null,
      _hooks: creative.hooks || [],
      _creativeId: creative.creative_id,
    }));

    // Sort
    const { key, direction } = sortConfig;
    result.sort((a, b) => {
      let aVal = a[key];
      let bVal = b[key];
      const isStringCol = typeof aVal === 'string' || typeof bVal === 'string';
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal == null) aVal = isStringCol ? (direction === 'asc' ? '\uffff' : '') : (direction === 'asc' ? Infinity : -Infinity);
      if (bVal == null) bVal = isStringCol ? (direction === 'asc' ? '\uffff' : '') : (direction === 'asc' ? Infinity : -Infinity);
      if (aVal < bVal) return direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [data, filters, sortConfig]);

  // ── Analytics: Angle/Format Breakdown, Rising Stars, Heatmap ──

  const [analyticsOpen, setAnalyticsOpen] = useState(true);
  const [videoModal, setVideoModal] = useState(null); // { thumbnail_url, video_url, ad_name }

  const angleStats = useMemo(() => {
    const map = {};
    processedData.forEach((r) => {
      const a = r.angle || 'Unknown';
      if (!map[a]) map[a] = { angle: a, spend: 0, revenue: 0, count: 0 };
      map[a].spend += r.spend || 0;
      map[a].revenue += r.revenue || 0;
      map[a].count++;
    });
    return Object.values(map)
      .map((a) => ({ ...a, roas: a.spend > 0 ? a.revenue / a.spend : 0 }))
      .sort((a, b) => b.spend - a.spend);
  }, [processedData]);

  const formatStats = useMemo(() => {
    const map = {};
    processedData.forEach((r) => {
      const f = r.format || 'Unknown';
      if (!map[f]) map[f] = { format: f, spend: 0, revenue: 0, count: 0 };
      map[f].spend += r.spend || 0;
      map[f].revenue += r.revenue || 0;
      map[f].count++;
    });
    return Object.values(map)
      .map((f) => ({ ...f, roas: f.spend > 0 ? f.revenue / f.spend : 0 }))
      .sort((a, b) => b.spend - a.spend);
  }, [processedData]);

  const risingStars = useMemo(() => {
    return processedData
      .filter((r) => (r.spend ?? 0) >= 50 && (r.spend ?? 0) < 500 && (r.roas ?? 0) >= 1.0)
      .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))
      .slice(0, 10);
  }, [processedData]);

  // ── Interactions ──

  const toggleExpand = (creativeId) => {
    setExpandedCreatives((prev) => {
      const next = new Set(prev);
      if (next.has(creativeId)) next.delete(creativeId);
      else next.add(creativeId);
      return next;
    });
  };

  const NUMERIC_COLS = new Set(['spend', 'revenue', 'roas', 'cpm', 'cpc', 'ctr', 'impressions', 'clicks', 'purchases', 'cpa', 'aov']);

  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
      }
      // Default: descending for numeric, ascending for text
      return { key, direction: NUMERIC_COLS.has(key) ? 'desc' : 'asc' };
    });
  };

  const chartAbortRef = useRef(null);
  const toggleChart = async (creativeId) => {
    if (chartAbortRef.current) chartAbortRef.current.abort();
    if (chartCreative === creativeId) {
      setChartCreative(null);
      setChartData(null);
      return;
    }
    const controller = new AbortController();
    chartAbortRef.current = controller;
    setChartCreative(creativeId);
    setChartLoading(true);
    try {
      const res = await api.get('/creative-analysis/lifetime', { params: { creative_id: creativeId }, signal: controller.signal });
      if (controller.signal.aborted) return;
      const lifetime = res.data?.data || {};
      const breakdown = lifetime.weekly_breakdown || [];
      setChartData({
        ...lifetime,
        chartPoints: breakdown.map((w) => ({
          week: w.week.replace('WK', 'W').replace('_', ' '),
          spend: w.spend,
          roas: w.roas,
          revenue: w.revenue,
        })),
      });
    } catch (err) {
      if (err?.name === 'CanceledError' || controller.signal.aborted) return;
      setChartData(null);
    } finally {
      if (!controller.signal.aborted) setChartLoading(false);
    }
  };

  const SortIcon = ({ colKey }) => {
    if (sortConfig.key !== colKey)
      return <ArrowUpDown className="w-3 h-3 text-gray-600 ml-1 inline" />;
    return sortConfig.direction === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-emerald-400 ml-1 inline" />
    ) : (
      <ArrowDown className="w-3 h-3 text-emerald-400 ml-1 inline" />
    );
  };

  // ── Render helpers ──

  /** Color intensity for metric cells (Motion-style green gradient) */
  const metricCellClass = (col, val) => {
    if (col.key === 'roas') {
      if (val >= 2.0) return 'bg-emerald-500/20 text-emerald-300 font-semibold';
      if (val >= 1.5) return 'bg-emerald-500/10 text-emerald-400 font-medium';
      if (val >= 1.0) return 'bg-yellow-500/10 text-yellow-300 font-medium';
      return 'text-red-400';
    }
    if (col.key === 'revenue') {
      if (val >= 1000) return 'bg-emerald-500/10 text-emerald-300 font-medium';
      if (val >= 500) return 'bg-emerald-500/[0.05] text-white font-medium';
      return 'text-gray-400';
    }
    if (col.key === 'spend') return 'text-white font-medium';
    if (col.key === 'cpa') {
      if (val == null || val === 0) return 'text-gray-500';
      if (val <= 15) return 'bg-emerald-500/10 text-emerald-400';
      if (val <= 30) return 'text-yellow-400';
      return 'text-red-400';
    }
    return '';
  };

  const renderCellValue = (row, col) => {
    const val = row[col.key];

    if (col.key === 'type') {
      const isVideo = (val || '').toLowerCase() === 'video';
      return (
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isVideo ? 'bg-blue-500/15' : 'bg-cyan-500/15'}`}>
            {isVideo ? (
              <Video className="w-4 h-4 text-blue-400" />
            ) : (
              <Image className="w-4 h-4 text-cyan-400" />
            )}
          </div>
          <span className="capitalize text-gray-300">{val || '-'}</span>
        </div>
      );
    }

    // Render colored tag badges for angle/format (Motion-style)
    if (col.tag && val) {
      const color = getTagColor(val);
      return color ? (
        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}>
          {val}
        </span>
      ) : val;
    }

    if (col.format) return col.format(val);
    return val != null && val !== '' ? val : '-';
  };

  // ── Loading state ──

  if (loading && data.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-6 h-6 text-gray-500 animate-spin" />
          <p className="text-gray-500 text-sm">Loading creative analysis...</p>
        </div>
      </div>
    );
  }

  // ── Empty state ──

  if (!loading && !error && data.length === 0 && !leaderboard) {
    return (
      <div className="p-6 pl-10">
        <div className="flex items-center gap-3 mb-2 mt-8">
          <BarChart3 className="w-7 h-7 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Creative Analysis</h1>
            <p className="text-gray-500 text-sm">Weekly ad performance report</p>
          </div>
        </div>

        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="flex flex-col items-center gap-4 max-w-md text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <BarChart3 className="w-8 h-8 text-emerald-400" />
            </div>
            <p className="text-white font-medium text-lg">No data yet</p>
            <p className="text-gray-500 text-sm">
              Data auto-syncs every 5 minutes. First sync in progress...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ──

  return (
    <div className="p-6 pl-10">
      {/* Header */}
      <div className="flex items-center justify-between mt-8 mb-8">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-7 h-7 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Creative Analysis</h1>
            <p className="text-gray-500 text-sm">Ad performance report</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Date range picker */}
          <div className="relative" ref={datePickerRef}>
            <button
              onClick={() => setDatePickerOpen((v) => !v)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-sm hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Calendar className="w-3.5 h-3.5 text-gray-400" />
              {DATE_PRESETS.find((p) => p.key === datePreset)?.label || `${startDate} – ${endDate}`}
              <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
            </button>

            {datePickerOpen && (() => {
              const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
              const firstDow = new Date(calViewYear, calViewMonth, 1).getDay();
              const monthName = new Date(calViewYear, calViewMonth).toLocaleString('en-US', { month: 'long' });
              const today = new Date();
              const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

              const fmtDay = (d) => `${calViewYear}-${String(calViewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isInRange = (ds) => calSelStart && calSelEnd && ds >= calSelStart && ds <= calSelEnd;
              const isStart = (ds) => ds === calSelStart;
              const isEnd = (ds) => ds === calSelEnd;
              const isToday = (ds) => ds === todayStr;
              const isFuture = (ds) => ds > todayStr;

              const prevMonth = () => { if (calViewMonth === 0) { setCalViewYear(calViewYear - 1); setCalViewMonth(11); } else setCalViewMonth(calViewMonth - 1); };
              const nextMonth = () => { if (calViewMonth === 11) { setCalViewYear(calViewYear + 1); setCalViewMonth(0); } else setCalViewMonth(calViewMonth + 1); };

              const handleDayClick = (ds) => {
                if (isFuture(ds)) return;
                if (!calPicking || calPicking === 'start') {
                  setCalSelStart(ds);
                  setCalSelEnd(null);
                  setCalPicking('end');
                } else {
                  if (ds < calSelStart) { setCalSelStart(ds); setCalSelEnd(calSelStart); }
                  else setCalSelEnd(ds);
                  setCalPicking(null);
                }
                setDatePreset('custom');
              };

              const handleApply = () => {
                if (calSelStart && calSelEnd) {
                  setStartDate(calSelStart);
                  setEndDate(calSelEnd);
                  setActiveOnly(false);
                  setDatePickerOpen(false);
                }
              };

              const cells = [];
              for (let i = 0; i < firstDow; i++) cells.push(null);
              for (let d = 1; d <= daysInMonth; d++) cells.push(d);

              return (
              <div className="absolute right-0 top-full mt-2 z-50 bg-[#1a1a2e] border border-white/[0.1] rounded-xl shadow-2xl flex min-w-[560px]">
                {/* Presets */}
                <div className="w-44 border-r border-white/[0.06] py-2 overflow-y-auto max-h-[400px]">
                  <p className="px-3 py-1.5 text-gray-500 text-[10px] uppercase tracking-wider font-semibold">Presets</p>
                  {DATE_PRESETS.map((preset) => (
                    <button
                      key={preset.key}
                      onClick={() => {
                        const range = presetToRange(preset.key);
                        setDatePreset(preset.key);
                        setStartDate(range.startDate);
                        setEndDate(range.endDate);
                        setCalSelStart(range.startDate);
                        setCalSelEnd(range.endDate);
                        setActiveOnly(false);
                        setCalPicking(null);
                        const ed = new Date(range.endDate);
                        setCalViewYear(ed.getFullYear());
                        setCalViewMonth(ed.getMonth());
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-white/[0.04] transition-colors cursor-pointer ${
                        datePreset === preset.key ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-300'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {/* Calendar */}
                <div className="flex-1 p-4 flex flex-col">
                  {/* Month nav */}
                  <div className="flex items-center justify-between mb-3">
                    <button onClick={prevMonth} className="p-1 rounded hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors cursor-pointer">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-emerald-400 font-semibold text-sm">{monthName} {calViewYear}</span>
                    <button onClick={nextMonth} className="p-1 rounded hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors cursor-pointer">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  {/* Day headers */}
                  <div className="grid grid-cols-7 mb-1">
                    {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
                      <div key={d} className="text-center text-[11px] text-gray-500 font-medium py-1">{d}</div>
                    ))}
                  </div>
                  {/* Day grid */}
                  <div className="grid grid-cols-7 gap-y-0.5">
                    {cells.map((day, i) => {
                      if (!day) return <div key={`e${i}`} />;
                      const ds = fmtDay(day);
                      const inRange = isInRange(ds);
                      const start = isStart(ds);
                      const end = isEnd(ds);
                      const tod = isToday(ds);
                      const fut = isFuture(ds);
                      return (
                        <button
                          key={ds}
                          onClick={() => handleDayClick(ds)}
                          disabled={fut}
                          className={`relative h-8 text-xs font-medium rounded transition-colors cursor-pointer
                            ${fut ? 'text-gray-700 cursor-not-allowed' : ''}
                            ${start || end ? 'bg-emerald-500 text-white' : ''}
                            ${inRange && !start && !end ? 'bg-emerald-500/20 text-emerald-300' : ''}
                            ${!inRange && !start && !end && !fut ? 'text-gray-300 hover:bg-white/[0.06]' : ''}
                            ${tod && !start && !end ? 'ring-1 ring-emerald-500/50' : ''}
                          `}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                  {/* Selection display + actions */}
                  <div className="mt-auto pt-3 border-t border-white/[0.06] flex items-center justify-between">
                    <div className="text-[11px] text-gray-500">
                      {calSelStart && calSelEnd ? (
                        <span>{new Date(calSelStart + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(calSelEnd + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      ) : calPicking === 'end' ? (
                        <span className="text-emerald-400">Select end date</span>
                      ) : (
                        <span>Click a day to start</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setDatePickerOpen(false)}
                        className="px-3 py-1.5 rounded-lg text-gray-400 text-sm hover:text-white transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleApply}
                        disabled={!calSelStart || !calSelEnd}
                        className="px-4 py-1.5 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              );
            })()}
          </div>

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-sm font-medium transition-colors cursor-pointer border border-emerald-500/20"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Data'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Leaderboard */}
      {leaderboard && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
          {LEADERBOARD_CONFIG.map((lb) => {
            const items = leaderboard[lb.key] || [];
            const Icon = lb.icon;
            return (
              <div key={lb.key} className={`${cardStyle} ${lb.accentBorder}`}>
                <div className="flex items-center gap-2 mb-4">
                  <div className={`w-8 h-8 rounded-lg ${lb.accentBg} flex items-center justify-center`}>
                    <Icon className={`w-4 h-4 ${lb.accent}`} />
                  </div>
                  <h3 className="text-white font-semibold text-sm">{lb.title}</h3>
                </div>

                {items.length === 0 ? (
                  <p className="text-gray-500 text-xs">No data for this week</p>
                ) : (
                  <div className="space-y-2.5">
                    {items.slice(0, 5).map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-sm"
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <span
                            className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                              idx === 0
                                ? `${lb.accentBg} ${lb.accent}`
                                : 'bg-white/[0.04] text-gray-500'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <span className="text-gray-300 truncate text-xs">
                            {item.ad_name || item.creative_id || item.creative_name || item.name || '-'}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-2">
                          <span className={`font-medium text-xs ${lb.accent}`}>
                            {lb.format(item[lb.metricKey])}
                          </span>
                          <span className="text-gray-600 text-xs">{fmtMoney(item.spend)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Top Creatives Visual Cards (Motion-style) */}
      {processedData.length > 0 && (
        <div className="mb-8">
          <h2 className="text-white font-semibold text-lg mb-4">Top Creatives</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {processedData.slice(0, 15).map((creative) => {
              const isVideo = (creative.type || '').toLowerCase() === 'video';
              const angleColor = getTagColor(creative.angle);
              const formatColor = getTagColor(creative.format);
              return (
                <div
                  key={creative._creativeId}
                  className="shrink-0 w-64 bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden hover:border-white/[0.12] transition-colors"
                >
                  {/* Visual header */}
                  <div
                    className={`h-64 flex items-center justify-center relative cursor-pointer group ${creative.thumbnail_url ? 'bg-black' : isVideo ? 'bg-gradient-to-br from-blue-900/40 to-purple-900/30' : 'bg-gradient-to-br from-cyan-900/30 to-emerald-900/20'}`}
                    onClick={() => (creative.thumbnail_url || creative.video_url) && setVideoModal({ thumbnail_url: creative.thumbnail_url, video_url: creative.video_url, ad_name: creative.ad_name })}
                  >
                    {creative.thumbnail_url ? (
                      <>
                        <img src={creative.thumbnail_url} alt="" className="w-full h-full object-cover" />
                        {creative.video_url && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                              <Play className="w-5 h-5 text-black ml-0.5" />
                            </div>
                          </div>
                        )}
                      </>
                    ) : isVideo ? (
                      <Video className="w-10 h-10 text-blue-400/40" />
                    ) : (
                      <Image className="w-10 h-10 text-cyan-400/40" />
                    )}
                    <span className={`absolute bottom-2 left-2 text-[10px] font-bold px-1.5 py-0.5 rounded ${isVideo ? 'bg-blue-500 text-white' : 'bg-cyan-500 text-white'}`}>
                      {creative.type || '?'}
                    </span>
                    {creative.is_winner && (
                      <span className="absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-500/30 text-yellow-400">Winner</span>
                    )}
                  </div>
                  {/* Info */}
                  <div className="p-3">
                    <p className="text-white text-xs font-medium truncate mb-2" title={creative.ad_name}>
                      {creative.ad_name}
                    </p>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-gray-500">Spend</span>
                        <span className="text-white font-medium">{fmtMoney(creative.spend)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">ROAS</span>
                        <span className={creative.roas >= 1.5 ? 'text-emerald-400 font-semibold' : creative.roas >= 1.0 ? 'text-yellow-400' : 'text-red-400'}>{fmtRoas(creative.roas)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">CPA</span>
                        <span className="text-gray-300">{fmtMoney(creative.cpa)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">CTR</span>
                        <span className="text-gray-300">{fmtPct(creative.ctr)}</span>
                      </div>
                    </div>
                    {/* Tags */}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {creative.format && formatColor && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${formatColor.bg} ${formatColor.text}`}>{creative.format}</span>
                      )}
                      {creative.angle && angleColor && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${angleColor.bg} ${angleColor.text}`}>{creative.angle}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Analytics Section */}
      <div className="mb-8">
        <button
          onClick={() => setAnalyticsOpen((v) => !v)}
          className="flex items-center gap-2 mb-4 text-white font-semibold text-lg hover:text-emerald-400 transition-colors cursor-pointer"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${analyticsOpen ? '' : '-rotate-90'}`} />
          Performance Analytics
        </button>

        {analyticsOpen && (
          <div className="space-y-6">
            {/* Angle & Format Breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Angle Breakdown */}
              <div className={cardStyle}>
                <div className="flex items-center gap-2 mb-4">
                  <BarChart3 className="w-4 h-4 text-purple-400" />
                  <h3 className="text-white font-semibold text-sm">Performance by Angle</h3>
                </div>
                {angleStats.length > 0 ? (
                  <ResponsiveContainer width="100%" height={Math.max(220, angleStats.length * 44)}>
                    <RBarChart data={angleStats} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 0 }} barCategoryGap="20%">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickFormatter={(v) => `${Number(v || 0).toFixed(1)}x`} />
                      <YAxis type="category" dataKey="angle" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false} width={160} interval={0} />
                      <Tooltip
                        contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
                        formatter={(v, name) => [name === 'roas' ? `${Number(v || 0).toFixed(2)}x` : `$${Number(v || 0).toLocaleString()}`, name === 'roas' ? 'ROAS' : name === 'spend' ? 'Spend' : 'Revenue']}
                      />
                      <Bar dataKey="roas" radius={[0, 4, 4, 0]}>
                        {angleStats.map((entry, i) => (
                          <Cell key={i} fill={entry.roas >= 1.5 ? '#10b981' : entry.roas >= 1.0 ? '#eab308' : '#ef4444'} fillOpacity={0.7} />
                        ))}
                      </Bar>
                    </RBarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-gray-500 text-xs">No angle data available</p>
                )}
                {angleStats.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {angleStats.map((a) => (
                      <div key={a.angle} className="flex items-center justify-between text-xs">
                        <span className="text-gray-400">{a.angle} <span className="text-gray-600">({a.count})</span></span>
                        <div className="flex gap-3">
                          <span className="text-gray-500">{fmtMoney(a.spend)}</span>
                          <span className={a.roas >= 1.5 ? 'text-emerald-400' : a.roas >= 1.0 ? 'text-yellow-400' : 'text-red-400'}>{fmtRoas(a.roas)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Format Breakdown */}
              <div className={cardStyle}>
                <div className="flex items-center gap-2 mb-4">
                  <BarChart3 className="w-4 h-4 text-blue-400" />
                  <h3 className="text-white font-semibold text-sm">Performance by Format</h3>
                </div>
                {formatStats.length > 0 ? (
                  <ResponsiveContainer width="100%" height={Math.max(220, formatStats.length * 44)}>
                    <RBarChart data={formatStats} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 0 }} barCategoryGap="20%">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickFormatter={(v) => `${Number(v || 0).toFixed(1)}x`} />
                      <YAxis type="category" dataKey="format" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false} width={120} interval={0} />
                      <Tooltip
                        contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
                        formatter={(v, name) => [name === 'roas' ? `${Number(v || 0).toFixed(2)}x` : `$${Number(v || 0).toLocaleString()}`, name === 'roas' ? 'ROAS' : name === 'spend' ? 'Spend' : 'Revenue']}
                      />
                      <Bar dataKey="roas" radius={[0, 4, 4, 0]}>
                        {formatStats.map((entry, i) => (
                          <Cell key={i} fill={entry.roas >= 1.5 ? '#3b82f6' : entry.roas >= 1.0 ? '#eab308' : '#ef4444'} fillOpacity={0.7} />
                        ))}
                      </Bar>
                    </RBarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-gray-500 text-xs">No format data available</p>
                )}
                {formatStats.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {formatStats.map((f) => (
                      <div key={f.format} className="flex items-center justify-between text-xs">
                        <span className="text-gray-400">{f.format} <span className="text-gray-600">({f.count})</span></span>
                        <div className="flex gap-3">
                          <span className="text-gray-500">{fmtMoney(f.spend)}</span>
                          <span className={f.roas >= 1.5 ? 'text-blue-400' : f.roas >= 1.0 ? 'text-yellow-400' : 'text-red-400'}>{fmtRoas(f.roas)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Rising Stars */}
            {risingStars.length > 0 && (
              <div className={cardStyle}>
                <div className="flex items-center gap-2 mb-4">
                  <Flame className="w-4 h-4 text-orange-400" />
                  <h3 className="text-white font-semibold text-sm">Rising Stars</h3>
                  <span className="text-gray-500 text-xs ml-1">Profitable creatives not yet scaled (spend $50–$500, ROAS {'>'}1.0x)</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                  {risingStars.map((star) => (
                    <div
                      key={star._creativeId}
                      className="bg-white/[0.03] border border-orange-500/10 rounded-lg p-3 hover:border-orange-500/30 transition-colors min-w-0 overflow-hidden"
                    >
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          (star.type || '').toLowerCase() === 'video'
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-cyan-500/20 text-cyan-400'
                        }`}>
                          {star.type || '?'}
                        </span>
                        {star.angle && <span className="text-gray-500 text-[10px]">{star.angle}</span>}
                      </div>
                      <p className="text-white text-xs font-medium truncate mb-2" title={star.ad_name}>
                        {star.ad_name}
                      </p>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">{fmtMoney(star.spend)}</span>
                        <span className="text-orange-400 font-semibold">{fmtRoas(star.roas)}</span>
                      </div>
                      <div className="mt-1.5 w-full bg-white/[0.04] rounded-full h-1">
                        <div
                          className="bg-orange-500/60 h-1 rounded-full"
                          style={{ width: `${Math.min(100, ((star.spend || 0) / 500) * 100)}%` }}
                        />
                      </div>
                      <p className="text-gray-600 text-[10px] mt-1 text-right">{Math.round(((star.spend || 0) / 500) * 100)}% to scale threshold</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className={`${cardStyle} mb-6`}>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filters.creativeType}
            onChange={(e) => updateFilter('creativeType', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Types</option>
            <option value="video" className="bg-[#111]">Video</option>
            <option value="image" className="bg-[#111]">Image</option>
          </select>

          <select
            value={filters.avatar}
            onChange={(e) => updateFilter('avatar', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Avatars</option>
            {filterOptions.avatar.map((v) => (
              <option key={v} value={v} className="bg-[#111]">{v}</option>
            ))}
          </select>

          <select
            value={filters.angle}
            onChange={(e) => updateFilter('angle', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Angles</option>
            {filterOptions.angle.map((v) => (
              <option key={v} value={v} className="bg-[#111]">{v}</option>
            ))}
          </select>

          <select
            value={filters.format}
            onChange={(e) => updateFilter('format', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Formats</option>
            {filterOptions.format.map((v) => (
              <option key={v} value={v} className="bg-[#111]">{v}</option>
            ))}
          </select>

          <select
            value={filters.editor}
            onChange={(e) => updateFilter('editor', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Editors</option>
            {filterOptions.editor.map((v) => (
              <option key={v} value={v} className="bg-[#111]">{v}</option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Data Table */}
      <div className={`${cardStyle} mb-8`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Performance Data</h2>
            <p className="text-gray-500 text-sm">
              {processedData.length} creative{processedData.length !== 1 ? 's' : ''}
            </p>
          </div>
          <span className="text-gray-600 text-xs">Auto-syncs every 5 min</span>
        </div>

        {processedData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            No creatives match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {/* Chart button column */}
                  <th className="w-10 px-1 py-3" />
                  {/* Expand column */}
                  <th className="w-8 px-2 py-3" />
                  {orderedColumns.map((col) => (
                    <th
                      key={col.key}
                      draggable
                      onDragStart={() => handleDragStart(col.key)}
                      onDragOver={(e) => handleDragOver(e, col.key)}
                      onDrop={() => handleDrop(col.key)}
                      onDragEnd={handleDragEnd}
                      className={`px-3 py-3 text-gray-400 text-xs uppercase tracking-wider font-semibold whitespace-nowrap transition-all ${
                        col.align === 'right'
                          ? 'text-right'
                          : col.align === 'center'
                          ? 'text-center'
                          : 'text-left'
                      } ${!col.noSort ? 'cursor-grab hover:text-gray-300 select-none' : ''} ${
                        dragCol === col.key ? 'opacity-40' : ''
                      } ${dragOverCol === col.key && dragCol !== col.key ? 'border-l-2 border-emerald-400' : ''}`}
                      onClick={!col.noSort ? () => handleSort(col.key) : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        <GripVertical className="w-3 h-3 text-gray-600 shrink-0" />
                        {col.label}
                        {!col.noSort && <SortIcon colKey={col.key} />}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              {processedData.map((row) => {
                  const cid = row._creativeId;
                  const hooks = row._hooks || [];
                  const isExpanded = expandedCreatives.has(cid);
                  const hasHooks = hooks.length > 0;

                  return (
                    <tbody key={cid}>
                      {/* Parent row */}
                      <tr
                        className={`border-b border-white/[0.06] hover:bg-white/[0.03] transition-colors ${
                          hasHooks ? 'cursor-pointer' : ''
                        }`}
                        onClick={hasHooks ? () => toggleExpand(cid) : undefined}
                      >
                        <td className="w-10 px-1 py-3 text-center">
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleChart(cid); }}
                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                              chartCreative === cid
                                ? 'bg-blue-500 text-white'
                                : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'
                            }`}
                            title="View performance chart"
                          >
                            <TrendingUp className="w-3.5 h-3.5" />
                          </button>
                        </td>
                        <td className="w-8 px-2 py-3 text-center">
                          {hasHooks && (
                            <ChevronRight
                              className={`w-3.5 h-3.5 text-gray-500 transition-transform inline-block ${
                                isExpanded ? 'rotate-90' : ''
                              }`}
                            />
                          )}
                        </td>
                        {orderedColumns.map((col) => (
                          <td
                            key={col.key}
                            className={`px-3 py-3 whitespace-nowrap ${
                              col.align === 'right'
                                ? 'text-right'
                                : col.align === 'center'
                                ? 'text-center'
                                : 'text-left'
                            } ${metricCellClass(col, row[col.key]) || (
                              ['spend', 'roas', 'revenue'].includes(col.key)
                                ? 'text-white font-medium'
                                : 'text-gray-400'
                            )}`}
                          >
                            {col.key === 'ad_name' ? (
                              <div className="flex flex-col">
                                <span className="flex items-center gap-2">
                                  {renderCellValue(row, col)}
                                  {row.is_winner && (
                                    <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-bold uppercase tracking-wide shrink-0">Winner</span>
                                  )}
                                </span>
                                {hooks.length > 0 && (
                                  <span className="text-gray-600 text-[10px] mt-0.5">{hooks.length} ad{hooks.length !== 1 ? 's' : ''}</span>
                                )}
                              </div>
                            ) : (
                              renderCellValue(row, col)
                            )}
                          </td>
                        ))}
                      </tr>

                      {/* Chart panel */}
                      {chartCreative === cid && (
                        <tr className="border-b border-white/[0.04]">
                          <td colSpan={orderedColumns.length + 2} className="p-0">
                            <div className="bg-[#0a0f1a] border-t border-b border-blue-500/20 p-5">
                              {chartLoading ? (
                                <div className="flex items-center justify-center h-48">
                                  <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" />
                                </div>
                              ) : chartData?.chartPoints?.length > 0 ? (
                                <div>
                                  <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                      <h3 className="text-white font-semibold text-sm">{cid} — Lifetime Performance</h3>
                                      {chartData.is_winner && (
                                        <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold">WINNER</span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-4 text-xs">
                                      <span className="text-gray-400">Lifetime Spend: <span className="text-white font-medium">{fmtMoney(chartData.lifetime_spend)}</span></span>
                                      <span className="text-gray-400">Lifetime ROAS: <span className="text-white font-medium">{fmtRoas(chartData.lifetime_roas)}</span></span>
                                      <span className="text-gray-400">Weeks Active: <span className="text-white font-medium">{chartData.weeks_active}</span></span>
                                    </div>
                                  </div>
                                  <ResponsiveContainer width="100%" height={240}>
                                    <ComposedChart data={chartData.chartPoints} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                                      <XAxis dataKey="week" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                                      <YAxis yAxisId="spend" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickFormatter={(v) => `$${v}`} />
                                      <YAxis yAxisId="roas" orientation="right" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickFormatter={(v) => `${v}x`} />
                                      <Tooltip
                                        contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
                                        formatter={(value, name) => [name === 'roas' ? `${Number(value || 0).toFixed(2)}x` : `$${Number(value || 0).toLocaleString()}`, name === 'roas' ? 'ROAS' : name === 'spend' ? 'Ad Spend' : 'Revenue']}
                                      />
                                      <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                                      <Area yAxisId="spend" type="monotone" dataKey="spend" name="Ad Spend" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" strokeWidth={2} />
                                      <Line yAxisId="roas" type="monotone" dataKey="roas" name="ROAS" stroke="#a78bfa" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                                    </ComposedChart>
                                  </ResponsiveContainer>
                                </div>
                              ) : (
                                <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
                                  No lifetime data available for this creative.
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* Hook rows (expanded) */}
                      {isExpanded &&
                        hooks.map((hook, idx) => (
                          <tr
                            key={`${cid}-hook-${idx}`}
                            className="border-b border-white/[0.02] bg-white/[0.01]"
                          >
                            <td className="w-10 px-1 py-2" />
                            <td className="w-8 px-2 py-2" />
                            {orderedColumns.map((col) => (
                              <td
                                key={col.key}
                                className={`px-3 py-2 whitespace-nowrap text-xs ${
                                  col.align === 'right'
                                    ? 'text-right'
                                    : col.align === 'center'
                                    ? 'text-center'
                                    : 'text-left'
                                } ${
                                  col.key === 'ad_name'
                                    ? 'text-gray-500 pl-8'
                                    : 'text-gray-500'
                                }`}
                              >
                                {col.key === 'ad_name' ? (
                                  <span className="flex items-center gap-1.5">
                                    <span className="text-gray-600">&mdash;</span>
                                    {hook.hook_label || hook.ad_name || `H${idx + 1}`}
                                  </span>
                                ) : (
                                  renderCellValue(hook, col)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  );
                })}
            </table>
          </div>
        )}
      </div>

      {/* Video Player Modal */}
      {videoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setVideoModal(null)}>
          <div className="relative max-w-3xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setVideoModal(null)} className="absolute -top-10 right-0 text-white/70 hover:text-white">
              <X className="w-6 h-6" />
            </button>
            <div className="bg-[#111] rounded-xl overflow-hidden">
              {videoModal.video_url ? (
                <iframe
                  src={videoModal.video_url}
                  className="w-full border-0"
                  style={{ height: '80vh' }}
                  allow="autoplay; fullscreen"
                  allowFullScreen
                />
              ) : videoModal.thumbnail_url ? (
                <img src={videoModal.thumbnail_url} alt="" className="w-full max-h-[80vh] object-contain" />
              ) : null}
              {videoModal.ad_name && (
                <div className="p-3 border-t border-white/10">
                  <p className="text-white text-sm truncate">{videoModal.ad_name}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
