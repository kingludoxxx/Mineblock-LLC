import { useState, useEffect, useCallback, useId } from 'react';
import api from '../services/api';
import DateRangePicker from '../components/ui/DateRangePicker';
import {
  DollarSign,
  TrendingUp,
  ShoppingCart,
  Receipt,
  Wallet,
  Gem,
  Percent,
  Target,
  Megaphone,
  RotateCcw,
  ArrowUpRight,
  ArrowDownRight,
  ChevronDown,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const todayStr = () => {
  // Use local date components — toISOString() returns UTC, which can be a day
  // behind the user's local date (e.g. early-morning Europe/Berlin).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmtMoneyFull = (n) =>
  '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n) => Number(n || 0).toFixed(1) + '%';
const fmtRoas = (n) => Number(n || 0).toFixed(2) + 'x';
const fmtInt = (n) => Number(n || 0).toLocaleString();

// ── Metric Definitions ──────────────────────────────────────────────────────

const METRICS = [
  { key: 'revenue',        label: 'Total Sales',      icon: DollarSign,   color: '#10b981', format: 'moneyFull' },
  { key: 'adSpend',        label: 'Ad Spend',         icon: Megaphone,    color: '#f59e0b', format: 'moneyFull' },
  { key: 'roas',           label: 'ROAS',             icon: TrendingUp,   color: '#3b82f6', format: 'roas' },
  { key: 'orders',         label: 'Purchases',        icon: ShoppingCart,  color: '#8b5cf6', format: 'int' },
  { key: 'aov',            label: 'AOV',              icon: Receipt,       color: '#06b6d4', format: 'moneyFull' },
  { key: 'costs',          label: 'Total Costs',      icon: Wallet,        color: '#ef4444', format: 'moneyFull', invertColor: true },
  { key: 'profit',         label: 'Profit',           icon: Gem,           color: '#10b981', format: 'moneyFull' },
  { key: 'netMargin',      label: 'Net Margin',       icon: Percent,       color: '#a855f7', format: 'pct' },
  { key: 'conversionRate', label: 'Conversion Rate',  icon: Target,        color: '#ec4899', format: 'pct' },
  { key: 'refunds',        label: 'Refunds',           icon: RotateCcw,     color: '#ef4444', format: 'int', invertColor: true },
];

const formatValue = (val, format) => {
  if (val === null || val === undefined) return '--';
  switch (format) {
    case 'moneyFull': return fmtMoneyFull(val);
    case 'pct': return fmtPct(val);
    case 'roas': return fmtRoas(val);
    case 'int': return fmtInt(val);
    default: return String(val);
  }
};

// ── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, format, icon: Icon, color, sparkData, sparkKey, change, invertColor, loading, index }) {
  const gradientId = useId().replace(/:/g, '_');

  if (loading) {
    return (
      <div className="animated-border-gradient rounded-xl h-full">
        <div className="glass-card border border-white/[0.05] rounded-xl p-5 relative z-10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] min-h-[180px]">
          <div className="animate-pulse space-y-3">
            <div className="h-3 w-20 bg-white/[0.06] rounded" />
            <div className="h-8 w-28 bg-white/[0.06] rounded" />
            <div className="h-3 w-16 bg-white/[0.06] rounded" />
            <div className="h-[60px] w-full bg-white/[0.06] rounded mt-2" />
          </div>
        </div>
      </div>
    );
  }

  const isPositive = change > 0;
  const isNegative = change < 0;
  const isNeutral = change === 0 || change === null || change === undefined || isNaN(change);

  const isGood = invertColor ? !isPositive : isPositive;
  const ChangeIcon = isPositive ? ArrowUpRight : ArrowDownRight;

  let changeBadge = 'bg-white/[0.04] text-white/30 border-white/[0.05]';
  if (!isNeutral) {
    changeBadge = isGood
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : 'bg-red-500/10 text-red-400 border-red-500/20';
  }

  return (
    <div className="animated-border-gradient rounded-xl h-full" style={{ animationDelay: `${(index || 0) * 50}ms` }}>
      <div className="glass-card border border-white/[0.05] rounded-xl p-5 relative z-10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:border-white/[0.08] transition-all flex flex-col h-full">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-6 h-6 rounded-md bg-white/[0.03] border border-white/[0.05] flex items-center justify-center">
            <Icon className="w-3.5 h-3.5" style={{ color }} />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
            {label}
          </span>
        </div>

        <div className="mb-2">
          <div className="text-2xl font-semibold text-white tracking-tight">
            {formatValue(value, format)}
          </div>
        </div>

        <div className="flex items-center gap-1.5 mb-6">
          <div className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border ${changeBadge}`}>
            {!isNeutral && <ChangeIcon className="w-3 h-3" />}
            {isNeutral ? 'No change' : `${Math.abs(change).toFixed(1)}%`}
          </div>
          <span className="text-[10px] text-zinc-600 font-mono">vs yesterday</span>
        </div>

        <div className="h-[60px] w-full mt-auto -mx-1">
          {sparkData && sparkData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sparkData}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey={sparkKey}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full bg-white/[0.02] rounded" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Revenue Chart Tooltip ───────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="glass-card border border-white/[0.08] p-3 rounded-lg shadow-xl backdrop-blur-xl bg-[#111113]/90">
      <p className="text-xs text-zinc-400 font-mono mb-2">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-3 text-sm mb-1 last:mb-0">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-zinc-300">{entry.name}:</span>
          </div>
          <span className="font-mono font-medium text-white">
            {entry.name === 'ROAS' ? `${entry.value}x` : `$${Number(entry.value).toLocaleString()}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Revenue Chart ───────────────────────────────────────────────────────────

function RevenueChart({ sparklines, dateRange, onDateRangeChange }) {
  // Transform sparklines into chart data with date, revenue, adSpend, roas
  const chartData = (sparklines || []).map((d) => ({
    date: d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
    revenue: d.revenue || 0,
    adSpend: d.adSpend || 0,
    roas: d.adSpend > 0 ? parseFloat((d.revenue / d.adSpend).toFixed(2)) : 0,
  }));

  if (chartData.length === 0) return null;

  return (
    <div className="glass-card border border-white/[0.05] rounded-xl p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-white mb-0.5">Revenue Overview</h3>
          <p className="text-xs text-zinc-500">Daily revenue, ad spend & ROAS — last 30 days</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-sm text-zinc-300 hover:bg-white/[0.05] transition-colors cursor-pointer">
          Last 30 days <ChevronDown className="w-4 h-4 text-zinc-500" />
        </button>
      </div>

      <div className="h-[280px] w-full overflow-visible">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 20, right: 15, left: -20, bottom: 0 }} style={{ overflow: 'visible' }}>
            <defs>
              <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c9a84c" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#c9a84c" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="colorAdSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e8d5a3" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#e8d5a3" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorRoas" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5b9a6f" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#5b9a6f" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              dy={10}
              minTickGap={30}
            />
            <YAxis
              yAxisId="left"
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${v / 1000}k`}
              domain={[0, (dataMax) => Math.ceil(dataMax * 1.15)]}
              dx={-10}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}x`}
              domain={[0, (dataMax) => Math.ceil(dataMax * 1.3)]}
              dx={10}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1, strokeDasharray: '4 4' }}
            />
            <Legend
              verticalAlign="bottom"
              height={36}
              iconType="circle"
              wrapperStyle={{ fontSize: '12px', color: '#a1a1aa', paddingTop: '20px' }}
            />
            <Area yAxisId="left" type="monotone" dataKey="adSpend" name="Ad Spend" stroke="rgba(232,213,163,0.4)" strokeWidth={1} fillOpacity={1} fill="url(#colorAdSpend)" dot={false} isAnimationActive={false} />
            <Area yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke="#5b9a6f" strokeWidth={1.5} fillOpacity={1} fill="url(#colorRoas)" dot={false} isAnimationActive={false} />
            <Area yAxisId="left" type="monotone" dataKey="revenue" name="Revenue" stroke="#c9a84c" strokeWidth={1.5} fillOpacity={1} fill="url(#colorRevenue)" dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Daily Breakdown ─────────────────────────────────────────────────────────

function DailyBreakdown({ current, date }) {
  if (!current || current.revenue === undefined) return null;
  return (
    <div className="glass-card border border-white/[0.05] rounded-xl p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#c9a84c] shadow-[0_0_8px_rgba(201,168,76,0.8)]" />
          <h3 className="text-sm font-medium text-white">Daily Breakdown</h3>
        </div>
        <span className="font-mono text-xs text-zinc-500">{date}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 lg:gap-0">
        <div className="lg:border-r border-white/[0.04] lg:pr-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Revenue</div>
          <div className="text-lg font-semibold text-white">{fmtMoneyFull(current.revenue)}</div>
        </div>
        <div className="lg:border-r border-white/[0.04] lg:px-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">COGS</div>
          <div className="text-lg font-semibold text-white">{fmtMoneyFull(current.cogs)}</div>
        </div>
        <div className="lg:border-r border-white/[0.04] lg:px-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Shipping</div>
          <div className="text-lg font-semibold text-white">{fmtMoneyFull(current.shipping)}</div>
        </div>
        <div className="lg:border-r border-white/[0.04] lg:px-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Fees</div>
          <div className="text-lg font-semibold text-white">{fmtMoneyFull(current.fees)}</div>
        </div>
        <div className="lg:border-r border-white/[0.04] lg:px-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Gross Profit</div>
          <div className="text-lg font-semibold text-emerald-400">{fmtMoneyFull(current.profit)}</div>
        </div>
        <div className="lg:pl-6">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Margin</div>
          <div className="text-lg font-semibold text-emerald-400">{fmtPct(current.netMargin)}</div>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function Dashboard() {
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const handleDateChange = useCallback(({ startDate: sd, endDate: ed }) => {
    setStartDate(sd);
    setEndDate(ed);
  }, []);

  const fetchDashboard = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await api.get('/kpi-system/home-dashboard', { params: { startDate, endDate } });
      setData(res.data?.data || null);
    } catch (err) {
      console.error('[Dashboard] fetch error:', err);
      setError(err.response?.data?.error?.message || err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { fetchDashboard(true); }, [fetchDashboard]);
  useEffect(() => {
    const interval = setInterval(() => fetchDashboard(false), 60000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const current = data?.current || {};
  const previous = data?.previous || {};
  const sparklines = data?.sparklines || [];
  const chartData = data?.chartData || [];

  const getChange = (key) => {
    const cur = current[key];
    const prev = previous[key];
    if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  };

  return (
    <div className="flex-1 overflow-y-auto bg-transparent custom-scrollbar">
      <div className="max-w-[1600px] mx-auto p-6 md:p-8 space-y-8 pb-20">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white mb-1">Dashboard</h1>
            <p className="text-sm text-zinc-500">Real-time business overview</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-medium text-emerald-400">Live</span>
            </div>
            <DateRangePicker startDate={startDate} endDate={endDate} onChange={handleDateChange} />
          </div>
        </div>

        {/* Error state */}
        {error && !loading && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center justify-between">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={() => fetchDashboard(true)} className="text-sm text-red-400 hover:text-red-300 font-medium cursor-pointer">
              Retry
            </button>
          </div>
        )}

        {/* KPI Grid — Top row: 5 cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {METRICS.slice(0, 5).map((m, i) => (
            <KpiCard
              key={m.key}
              label={m.label}
              value={loading ? null : current[m.key]}
              format={m.format}
              icon={m.icon}
              color={m.color}
              sparkData={sparklines}
              sparkKey={m.key}
              change={loading ? null : getChange(m.key)}
              invertColor={m.invertColor}
              loading={loading}
              index={i}
            />
          ))}
        </div>

        {/* KPI Grid — Bottom row: 4 cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {METRICS.slice(5).map((m, i) => (
            <KpiCard
              key={m.key}
              label={m.label}
              value={loading ? null : current[m.key]}
              format={m.format}
              icon={m.icon}
              color={m.color}
              sparkData={sparklines}
              sparkKey={m.key}
              change={loading ? null : getChange(m.key)}
              invertColor={m.invertColor}
              loading={loading}
              index={i + 5}
            />
          ))}
        </div>

        {/* Daily Breakdown */}
        {!loading && <DailyBreakdown current={current} date={startDate === endDate ? endDate : `${startDate} – ${endDate}`} />}

        {/* Revenue Overview Chart */}
        {!loading && chartData.length > 0 && (
          <RevenueChart sparklines={chartData} />
        )}
      </div>
    </div>
  );
}
