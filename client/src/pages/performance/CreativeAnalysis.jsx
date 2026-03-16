import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart3,
  Video,
  Image,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trophy,
  ShoppingCart,
  Zap,
  Crown,
} from 'lucide-react';
import api from '../../services/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentWeek() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - jan1) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `WK${String(week).padStart(2, '0')}_${now.getFullYear()}`;
}

function generateWeekOptions() {
  const now = new Date();
  const year = now.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const days = Math.floor((now - jan1) / 86400000);
  const currentWeek = Math.ceil((days + jan1.getDay() + 1) / 7);
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

const STATUS_STYLES = {
  Active: 'bg-green-500/20 text-green-400 border border-green-500/30',
  Paused: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  Disabled: 'bg-red-500/20 text-red-400 border border-red-500/30',
};

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
    key: 'topCpa',
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
  { key: 'launch_date', label: 'Launch Date', align: 'left' },
  { key: 'ad_name', label: 'Ad Name', align: 'left' },
  { key: 'creative_link', label: 'Link', align: 'center', noSort: true },
  { key: 'avatar', label: 'Avatar', align: 'left' },
  { key: 'angle', label: 'Angle', align: 'left' },
  { key: 'format', label: 'Format', align: 'left' },
  { key: 'editor', label: 'Editor', align: 'left' },
  { key: 'spend', label: 'Spend', align: 'right', format: fmtMoney },
  { key: 'roas', label: 'ROAS', align: 'right', format: fmtRoas },
  { key: 'purchases', label: 'Purch', align: 'right', format: fmtInt },
  { key: 'cpa', label: 'CPA', align: 'right', format: fmtMoney },
  { key: 'cpm', label: 'CPM', align: 'right', format: fmtMoney },
  { key: 'aov', label: 'AOV', align: 'right', format: fmtMoney },
  { key: 'revenue', label: 'Conv Value', align: 'right', format: fmtMoney },
  { key: 'cpc', label: 'CPC', align: 'right', format: fmtMoney },
  { key: 'ctr', label: 'CTR', align: 'right', format: fmtPct },
  { key: 'status', label: 'Status', align: 'center', noSort: true },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function CreativeAnalysis() {
  const weekOptions = useMemo(() => generateWeekOptions(), []);

  const [week, setWeek] = useState(getCurrentWeek);
  const [data, setData] = useState([]);
  const [leaderboard, setLeaderboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [filters, setFilters] = useState({
    creativeType: '',
    avatar: '',
    angle: '',
    format: '',
    editor: '',
    status: '',
  });

  const [expandedCreatives, setExpandedCreatives] = useState(new Set());
  const [sortConfig, setSortConfig] = useState({ key: 'spend', direction: 'desc' });

  // ── Fetch ──

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dataRes, lbRes] = await Promise.all([
        api.get('/creative-analysis/data', { params: { week } }),
        api.get('/creative-analysis/leaderboard', { params: { week } }),
      ]);
      const respData = dataRes.data?.data || dataRes.data || {};
      setData(respData.creatives || respData || []);
      setLeaderboard(lbRes.data?.data || lbRes.data || null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, [week]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.post('/creative-analysis/sync', { week });
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  // ── Filtering ──

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({ creativeType: '', avatar: '', angle: '', format: '', editor: '', status: '' });
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
    if (filters.status) {
      rows = rows.filter(
        (r) => (r.status || '').toLowerCase() === filters.status.toLowerCase()
      );
    }

    // Data from backend is already grouped by creative_id with hooks array
    // Each item: { creative_id, type, avatar, angle, format, editor, total_spend, total_revenue, roas, cpa, cpm, aov, cpc, ctr, hooks: [...] }
    const result = rows.map((creative) => ({
      ...creative,
      spend: creative.total_spend || creative.spend || 0,
      revenue: creative.total_revenue || creative.revenue || 0,
      purchases: creative.total_purchases || creative.purchases || 0,
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

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
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

    if (col.key === 'creative_link') {
      if (!val) return <span className="text-gray-600">-</span>;
      return (
        <a
          href={val}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      );
    }

    if (col.key === 'status') {
      const badge =
        STATUS_STYLES[val] || 'bg-white/[0.04] text-gray-500 border border-white/[0.06]';
      return (
        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${badge}`}>
          {val || '-'}
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
              Run an initial sync to pull creative performance data from your ad accounts.
            </p>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
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

        <div className="flex items-center gap-3">
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

          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
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
                            {item.ad_name || item.creative_name || item.name || '-'}
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

          <select
            value={filters.status}
            onChange={(e) => updateFilter('status', e.target.value)}
            className={selectStyle}
          >
            <option value="" className="bg-[#111]">All Statuses</option>
            <option value="Active" className="bg-[#111]">Active</option>
            <option value="Paused" className="bg-[#111]">Paused</option>
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
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Data'}
          </button>
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
                  {/* Expand column */}
                  <th className="w-8 px-2 py-2" />
                  {TABLE_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`px-3 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold whitespace-nowrap ${
                        col.align === 'right'
                          ? 'text-right'
                          : col.align === 'center'
                          ? 'text-center'
                          : 'text-left'
                      } ${!col.noSort ? 'cursor-pointer hover:text-gray-300 select-none' : ''}`}
                      onClick={!col.noSort ? () => handleSort(col.key) : undefined}
                    >
                      {col.label}
                      {!col.noSort && <SortIcon colKey={col.key} />}
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
                        <td className="w-8 px-2 py-2.5 text-center">
                          {hasHooks && (
                            <ChevronRight
                              className={`w-3.5 h-3.5 text-gray-500 transition-transform inline-block ${
                                isExpanded ? 'rotate-90' : ''
                              }`}
                            />
                          )}
                        </td>
                        {TABLE_COLUMNS.map((col) => (
                          <td
                            key={col.key}
                            className={`px-3 py-2.5 whitespace-nowrap ${
                              col.align === 'right'
                                ? 'text-right'
                                : col.align === 'center'
                                ? 'text-center'
                                : 'text-left'
                            } ${
                              ['spend', 'roas', 'purchases', 'revenue'].includes(col.key)
                                ? 'text-white font-medium'
                                : 'text-gray-400'
                            }`}
                          >
                            {renderCellValue(row, col)}
                          </td>
                        ))}
                      </tr>

                      {/* Hook rows (expanded) */}
                      {isExpanded &&
                        hooks.map((hook, idx) => (
                          <tr
                            key={`${cid}-hook-${idx}`}
                            className="border-b border-white/[0.02] bg-white/[0.01]"
                          >
                            <td className="w-8 px-2 py-2" />
                            {TABLE_COLUMNS.map((col) => (
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
