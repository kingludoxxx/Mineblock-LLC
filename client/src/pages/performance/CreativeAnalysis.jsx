import { useState, useEffect, useCallback, useMemo } from 'react';
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
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
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

function generateWeekOptions() {
  const now = new Date();
  const { week: currentWeek, year } = getISOWeek(now);
  const weeks = [];
  for (let w = currentWeek; w >= 1; w--) {
    weeks.push(`WK${String(w).padStart(2, '0')}_${year}`);
  }
  // Add last few weeks of previous year
  for (let w = 52; w >= 48; w--) {
    weeks.push(`WK${String(w).padStart(2, '0')}_${year - 1}`);
  }
  return weeks;
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

const TABLE_COLUMNS = [
  { key: 'type', label: 'Type', align: 'left' },
  { key: 'ad_name', label: 'Ad Name', align: 'left' },
  { key: 'avatar', label: 'Avatar', align: 'left' },
  { key: 'angle', label: 'Angle', align: 'left' },
  { key: 'format', label: 'Format', align: 'left' },
  { key: 'editor', label: 'Editor', align: 'left' },
  { key: 'spend', label: 'Spend', align: 'right', format: fmtMoney },
  { key: 'revenue', label: 'Revenue', align: 'right', format: fmtMoney },
  { key: 'roas', label: 'ROAS', align: 'right', format: fmtRoas },
  { key: 'cpm', label: 'CPM', align: 'right', format: fmtMoney },
  { key: 'cpc', label: 'CPC', align: 'right', format: fmtMoney },
  { key: 'ctr', label: 'CTR', align: 'right', format: fmtPct },
  { key: 'impressions', label: 'Impr', align: 'right', format: fmtInt },
  { key: 'clicks', label: 'Clicks', align: 'right', format: fmtInt },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function CreativeAnalysis() {
  const weekOptions = useMemo(() => generateWeekOptions(), []);

  const [week, setWeek] = useState(getCurrentWeek);
  const [dateMode, setDateMode] = useState('week'); // 'week' or 'custom'
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState([]);
  const [leaderboard, setLeaderboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [activeOnly, setActiveOnly] = useState(true);
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let dataRes;
      let lbWeek = week; // week to use for leaderboard
      if (dateMode === 'custom' && startDate && endDate) {
        dataRes = await api.get('/creative-analysis/data-by-date', { params: { startDate, endDate } });
      } else if (activeOnly) {
        dataRes = await api.get('/creative-analysis/active');
        // Use the latest_week from /active for the leaderboard
        const activeData = dataRes.data?.data || dataRes.data || {};
        if (activeData.latest_week) lbWeek = activeData.latest_week;
      } else {
        dataRes = await api.get('/creative-analysis/data', { params: { week } });
      }
      const respData = dataRes.data?.data || dataRes.data || {};
      setData(respData.creatives || respData || []);

      // Skip leaderboard in custom date mode (it's week-based and wouldn't match)
      if (dateMode !== 'custom') {
        const lbRes = await api.get('/creative-analysis/leaderboard', { params: { week: lbWeek } });
        setLeaderboard(lbRes.data?.data || lbRes.data || null);
      } else {
        setLeaderboard(null);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, [week, dateMode, startDate, endDate, activeOnly]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.post('/creative-analysis/sync', { week });
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
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
      spend: creative.total_spend || creative.spend || 0,
      revenue: creative.total_revenue || creative.revenue || 0,
      purchases: creative.total_purchases || creative.purchases || 0,
      impressions: creative.total_impressions || creative.impressions || 0,
      clicks: creative.total_clicks || creative.clicks || 0,
      ad_name: creative.hooks?.[0]?.ad_name || creative.ad_name || creative.creative_id,
      _hooks: creative.hooks || [],
      _creativeId: creative.creative_id,
    }));

    // Sort
    const { key, direction } = sortConfig;
    result.sort((a, b) => {
      let aVal = a[key];
      let bVal = b[key];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal == null) aVal = direction === 'asc' ? Infinity : -Infinity;
      if (bVal == null) bVal = direction === 'asc' ? Infinity : -Infinity;
      if (aVal < bVal) return direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [data, filters, sortConfig]);

  // ── Interactions ──

  const toggleExpand = (creativeId) => {
    setExpandedCreatives((prev) => {
      const next = new Set(prev);
      if (next.has(creativeId)) next.delete(creativeId);
      else next.add(creativeId);
      return next;
    });
  };

  const NUMERIC_COLS = new Set(['spend', 'revenue', 'roas', 'cpm', 'cpc', 'ctr', 'impressions', 'clicks']);

  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
      }
      // Default: descending for numeric, ascending for text
      return { key, direction: NUMERIC_COLS.has(key) ? 'desc' : 'asc' };
    });
  };

  const toggleChart = async (creativeId) => {
    if (chartCreative === creativeId) {
      setChartCreative(null);
      setChartData(null);
      return;
    }
    setChartCreative(creativeId);
    setChartLoading(true);
    try {
      const res = await api.get('/creative-analysis/lifetime', { params: { creative_id: creativeId } });
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
    } catch {
      setChartData(null);
    } finally {
      setChartLoading(false);
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

  const renderCellValue = (row, col) => {
    const val = row[col.key];

    if (col.key === 'type') {
      const isVideo = (val || '').toLowerCase() === 'video';
      return (
        <span className="flex items-center gap-1.5">
          {isVideo ? (
            <Video className="w-3.5 h-3.5 text-blue-400" />
          ) : (
            <Image className="w-3.5 h-3.5 text-cyan-400" />
          )}
          <span className="capitalize">{val || '-'}</span>
        </span>
      );
    }

    if (col.format) return col.format(val);
    return val || '-';
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
            <p className="text-gray-500 text-sm">Weekly ad performance report</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Date mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
            <button
              onClick={() => setDateMode('week')}
              className={`px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${dateMode === 'week' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/[0.04] text-gray-400 hover:text-white'}`}
            >
              Week
            </button>
            <button
              onClick={() => setDateMode('custom')}
              className={`px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${dateMode === 'custom' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/[0.04] text-gray-400 hover:text-white'}`}
            >
              Custom
            </button>
          </div>

          {dateMode === 'week' ? (
            <select
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              className={selectStyle}
            >
              {weekOptions.map((w) => (
                <option key={w} value={w} className="bg-[#111]">
                  {w.replace('_', ' ')}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${selectStyle} text-gray-300`}
              />
              <span className="text-gray-500 text-xs">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${selectStyle} text-gray-300`}
              />
              <button
                onClick={fetchData}
                disabled={!startDate || !endDate}
                className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 transition-colors cursor-pointer disabled:opacity-40"
              >
                Apply
              </button>
            </>
          )}

          {/* Active only toggle (disabled in custom date mode) */}
          {dateMode === 'week' && (
            <button
              onClick={() => setActiveOnly((v) => !v)}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${activeOnly ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-white/[0.04] text-gray-400 hover:text-white border border-white/[0.08]'}`}
            >
              Active Only
            </button>
          )}

          {/* Sync button (only in week mode — custom mode queries TW live) */}
          {dateMode === 'week' && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-sm font-medium transition-colors cursor-pointer border border-emerald-500/20"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Data'}
            </button>
          )}
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
                  <th className="w-10 px-1 py-2" />
                  {/* Expand column */}
                  <th className="w-8 px-2 py-2" />
                  {orderedColumns.map((col) => (
                    <th
                      key={col.key}
                      draggable
                      onDragStart={() => handleDragStart(col.key)}
                      onDragOver={(e) => handleDragOver(e, col.key)}
                      onDrop={() => handleDrop(col.key)}
                      onDragEnd={handleDragEnd}
                      className={`px-3 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold whitespace-nowrap transition-all ${
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
                        className={`border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${
                          hasHooks ? 'cursor-pointer' : ''
                        }`}
                        onClick={hasHooks ? () => toggleExpand(cid) : undefined}
                      >
                        <td className="w-10 px-1 py-2.5 text-center">
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleChart(cid); }}
                            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                              chartCreative === cid
                                ? 'bg-blue-500 text-white'
                                : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'
                            }`}
                            title="View performance chart"
                          >
                            <TrendingUp className="w-3.5 h-3.5" />
                          </button>
                        </td>
                        <td className="w-8 px-2 py-2.5 text-center">
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
                            className={`px-3 py-2.5 whitespace-nowrap ${
                              col.align === 'right'
                                ? 'text-right'
                                : col.align === 'center'
                                ? 'text-center'
                                : 'text-left'
                            } ${
                              ['spend', 'roas', 'revenue'].includes(col.key)
                                ? 'text-white font-medium'
                                : 'text-gray-400'
                            }`}
                          >
                            {col.key === 'ad_name' ? (
                              <span className="flex items-center gap-2">
                                {renderCellValue(row, col)}
                                {row.is_winner && (
                                  <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-bold uppercase tracking-wide shrink-0">Winner</span>
                                )}
                              </span>
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
                                        formatter={(value, name) => [name === 'roas' ? `${value}x` : `$${Number(value).toLocaleString()}`, name === 'roas' ? 'ROAS' : name === 'spend' ? 'Ad Spend' : 'Revenue']}
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
    </div>
  );
}
