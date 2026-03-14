import { useState, useEffect, useCallback } from 'react';
import {
  Brain,
  TrendingUp,
  Video,
  Image,
  Target,
  DollarSign,
  RefreshCw,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import api from '../../services/api';

const EDITOR_COLORS = [
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#f59e0b',
  '#f43f5e',
  '#10b981',
];

const STATUS_STYLES = {
  Winner: 'bg-green-500/20 text-green-400 border border-green-500/30',
  Promising: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  Tested: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
};

const fmt = (n) =>
  '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

const fmtDecimal = (n) =>
  '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n) => (Number(n || 0) * 100).toFixed(1) + '%';

const fmtRoas = (n) => Number(n || 0).toFixed(2) + 'x';

function getDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

const cardStyle = 'bg-[#111] border border-white/[0.06] rounded-xl p-5';
const inputStyle =
  'bg-white/[0.04] border border-white/[0.08] rounded-lg text-white px-3 py-2 text-sm focus:outline-none focus:border-white/20';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2 text-sm shadow-xl">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color }} className="text-xs">
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
}

function RoasTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2 text-sm shadow-xl">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color }} className="text-xs">
          ROAS: {fmtRoas(entry.value)}
        </p>
      ))}
    </div>
  );
}

export default function CreativeIntelligence() {
  const [dateRange, setDateRange] = useState(getDefaultDates);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/creative-intel/data', {
        params: { startDate: dateRange.startDate, endDate: dateRange.endDate },
      });
      if (res.data?.success) {
        setData(res.data.data);
      } else {
        setError('Unexpected response from server.');
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, [dateRange.startDate, dateRange.endDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Derive editor chart data
  const editorChartData = (() => {
    if (!data?.editorProductivity) return [];
    const weeks = [...new Set(data.editorProductivity.map((r) => r.week))].sort();
    return weeks.map((week) => {
      const row = { week };
      data.editorProductivity
        .filter((r) => r.week === week)
        .forEach((r) => {
          row[r.editor] = r.total;
        });
      return row;
    });
  })();

  const editorNames = data?.editorProductivity
    ? [...new Set(data.editorProductivity.map((r) => r.editor))]
    : [];

  const editorTotals = (() => {
    if (!data?.editorProductivity) return [];
    const map = {};
    data.editorProductivity.forEach((r) => {
      if (!map[r.editor]) map[r.editor] = { editor: r.editor, video: 0, image: 0, total: 0 };
      map[r.editor].video += r.video || 0;
      map[r.editor].image += r.image || 0;
      map[r.editor].total += r.total || 0;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  })();

  // Format performance chart data (horizontal)
  const formatChartData = (data?.formatPerformance || [])
    .slice()
    .sort((a, b) => (b.roas || 0) - (a.roas || 0));

  const angleChartData = (data?.anglePerformance || [])
    .slice()
    .sort((a, b) => (b.roas || 0) - (a.roas || 0));

  const sortedCreatives = (data?.creatives || [])
    .slice()
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));

  // Loading state
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-6 h-6 text-gray-500 animate-spin" />
          <p className="text-gray-500 text-sm">Loading creative intelligence...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !data) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3 max-w-md text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
            <Brain className="w-6 h-6 text-red-400" />
          </div>
          <p className="text-white font-medium">Failed to load data</p>
          <p className="text-gray-500 text-sm">{error}</p>
          <button
            onClick={fetchData}
            className="mt-2 px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const s = data?.summary || {};

  return (
    <div>
      {/* Header + Date Range */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Brain className="w-6 h-6 text-purple-400" />
            Creative Intelligence
          </h1>
          <p className="text-gray-400 mt-1 text-sm">
            Analyze creative performance, editor output, and winning patterns.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="date"
            value={dateRange.startDate}
            onChange={(e) =>
              setDateRange((prev) => ({ ...prev, startDate: e.target.value }))
            }
            className={inputStyle}
          />
          <span className="text-gray-500 text-sm">to</span>
          <input
            type="date"
            value={dateRange.endDate}
            onChange={(e) =>
              setDateRange((prev) => ({ ...prev, endDate: e.target.value }))
            }
            className={inputStyle}
          />
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm transition-colors disabled:opacity-50"
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

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-4 h-4 text-purple-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Total Creatives</span>
          </div>
          <p className="text-2xl font-bold text-white">{s.totalCreatives ?? 0}</p>
          <p className="text-xs text-gray-500 mt-1">
            {s.totalVideo ?? 0} video &middot; {s.totalImage ?? 0} image
          </p>
        </div>

        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Video className="w-4 h-4 text-blue-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Video Winners</span>
          </div>
          <p className="text-2xl font-bold text-white">{s.videoWinners ?? 0}</p>
          <p className="text-xs text-green-400 mt-1">
            {s.videoPromising ?? 0} promising
          </p>
        </div>

        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Image className="w-4 h-4 text-cyan-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Image Winners</span>
          </div>
          <p className="text-2xl font-bold text-white">{s.imageWinners ?? 0}</p>
          <p className="text-xs text-green-400 mt-1">
            {s.imagePromising ?? 0} promising
          </p>
        </div>

        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-amber-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Video Hit Rate</span>
          </div>
          <p className="text-2xl font-bold text-white">{fmtPct(s.videoHitRate)}</p>
          <p className="text-xs text-gray-500 mt-1">
            {s.videoWinners ?? 0} / {s.videoLaunched ?? 0} launched
          </p>
        </div>

        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-yellow-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Image Hit Rate</span>
          </div>
          <p className="text-2xl font-bold text-white">{fmtPct(s.imageHitRate)}</p>
          <p className="text-xs text-gray-500 mt-1">
            {s.imageWinners ?? 0} / {s.imageLaunched ?? 0} launched
          </p>
        </div>

        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <DollarSign className="w-4 h-4 text-green-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Total Spend</span>
          </div>
          <p className="text-2xl font-bold text-white">{fmt(s.totalSpend)}</p>
          <p className="text-xs text-gray-500 mt-1">
            Rev: {fmt(s.totalRevenue)}
          </p>
        </div>
      </div>

      {/* Editor Productivity */}
      <div className={`${cardStyle} mb-8`}>
        <h2 className="text-lg font-semibold text-white mb-1">Editor Productivity</h2>
        <p className="text-gray-500 text-sm mb-6">Creatives produced per editor per week</p>

        {editorChartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            No editor data available for this period.
          </div>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={editorChartData} barCategoryGap="20%">
                  <XAxis
                    dataKey="week"
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  {editorNames.map((name, i) => (
                    <Bar
                      key={name}
                      dataKey={name}
                      name={name}
                      fill={EDITOR_COLORS[i % EDITOR_COLORS.length]}
                      radius={[3, 3, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Editor summary table */}
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Editor</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Video</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Image</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {editorTotals.map((e, i) => (
                    <tr key={e.editor} className="border-b border-white/[0.04]">
                      <td className="px-4 py-2.5 text-white flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block"
                          style={{ backgroundColor: EDITOR_COLORS[i % EDITOR_COLORS.length] }}
                        />
                        {e.editor}
                      </td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{e.video}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{e.image}</td>
                      <td className="text-right px-4 py-2.5 text-white font-medium">{e.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Format Performance */}
      <div className={`${cardStyle} mb-8`}>
        <h2 className="text-lg font-semibold text-white mb-1">Format Performance</h2>
        <p className="text-gray-500 text-sm mb-6">ROAS by creative format</p>

        {formatChartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            No format data available for this period.
          </div>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={formatChartData} layout="vertical" barSize={20}>
                  <XAxis
                    type="number"
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="format"
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={120}
                  />
                  <Tooltip content={<RoasTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="roas" name="ROAS" radius={[0, 4, 4, 0]}>
                    {formatChartData.map((entry, i) => (
                      <Cell key={i} fill={EDITOR_COLORS[i % EDITOR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Format</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Count</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Spend</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Revenue</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">ROAS</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Hit Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {formatChartData.map((r) => (
                    <tr key={r.format} className="border-b border-white/[0.04]">
                      <td className="px-4 py-2.5 text-white">{r.format}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{r.count}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmt(r.spend)}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmt(r.revenue)}</td>
                      <td className="text-right px-4 py-2.5 text-white font-medium">{fmtRoas(r.roas)}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmtPct(r.hitRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Angle Performance */}
      <div className={`${cardStyle} mb-8`}>
        <h2 className="text-lg font-semibold text-white mb-1">Angle Performance</h2>
        <p className="text-gray-500 text-sm mb-6">ROAS by creative angle</p>

        {angleChartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            No angle data available for this period.
          </div>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={angleChartData} layout="vertical" barSize={20}>
                  <XAxis
                    type="number"
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="angle"
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={120}
                  />
                  <Tooltip content={<RoasTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="roas" name="ROAS" radius={[0, 4, 4, 0]}>
                    {angleChartData.map((entry, i) => (
                      <Cell key={i} fill={EDITOR_COLORS[i % EDITOR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Angle</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Count</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Spend</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Revenue</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">ROAS</th>
                    <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Hit Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {angleChartData.map((r) => (
                    <tr key={r.angle} className="border-b border-white/[0.04]">
                      <td className="px-4 py-2.5 text-white">{r.angle}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{r.count}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmt(r.spend)}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmt(r.revenue)}</td>
                      <td className="text-right px-4 py-2.5 text-white font-medium">{fmtRoas(r.roas)}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmtPct(r.hitRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* All Creatives Table */}
      <div className={`${cardStyle} mb-8`}>
        <h2 className="text-lg font-semibold text-white mb-1">All Creatives</h2>
        <p className="text-gray-500 text-sm mb-6">
          {sortedCreatives.length} creative{sortedCreatives.length !== 1 ? 's' : ''} sorted by spend
        </p>

        {sortedCreatives.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            No creatives found for this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Creative ID</th>
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Type</th>
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Editor</th>
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Format</th>
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Angle</th>
                  <th className="text-left px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Week</th>
                  <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Spend</th>
                  <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Revenue</th>
                  <th className="text-right px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">ROAS</th>
                  <th className="text-center px-4 py-2 text-gray-400 text-xs uppercase tracking-wider font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedCreatives.map((c) => {
                  const badge =
                    STATUS_STYLES[c.status] ||
                    'bg-white/[0.04] text-gray-500 border border-white/[0.06]';
                  return (
                    <tr key={c.creativeId || c.name} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2.5 text-white font-mono text-xs">{c.creativeId || c.name}</td>
                      <td className="px-4 py-2.5 text-gray-400 capitalize">{c.type}</td>
                      <td className="px-4 py-2.5 text-gray-400">{c.editor}</td>
                      <td className="px-4 py-2.5 text-gray-400">{c.format}</td>
                      <td className="px-4 py-2.5 text-gray-400">{c.angle}</td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">{c.week}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmtDecimal(c.spend)}</td>
                      <td className="text-right px-4 py-2.5 text-gray-400">{fmtDecimal(c.revenue)}</td>
                      <td className="text-right px-4 py-2.5 text-white font-medium">{fmtRoas(c.roas)}</td>
                      <td className="text-center px-4 py-2.5">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${badge}`}>
                          {c.status || 'Other'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
