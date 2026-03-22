import { useState, useEffect, useCallback, useId } from 'react';
import api from '../services/api';
import DatePicker from '../components/ui/DatePicker';
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
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

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

// ── Sparkline Card ──────────────────────────────────────────────────────────

function SparklineCard({ label, value, format, icon: Icon, color, sparkData, sparkKey, change, invertColor, loading }) {
  const gradientId = useId().replace(/:/g, '_');

  if (loading) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 min-h-[160px]">
        <div className="animate-pulse space-y-3">
          <div className="h-3 w-20 bg-white/[0.06] rounded" />
          <div className="h-8 w-28 bg-white/[0.06] rounded" />
          <div className="h-3 w-16 bg-white/[0.06] rounded" />
          <div className="h-10 w-full bg-white/[0.06] rounded mt-2" />
        </div>
      </div>
    );
  }

  const isPositive = change > 0;
  const isNegative = change < 0;
  const isNeutral = change === 0 || change === null || change === undefined || isNaN(change);

  // For costs, invert the color logic (decrease = good = green)
  const goodDirection = invertColor ? !isPositive : isPositive;
  const badDirection = invertColor ? isPositive : isNegative;

  let changeColor = 'text-white/30';
  let changeBg = 'bg-white/[0.04]';
  let ChangeArrow = null;

  if (!isNeutral) {
    if (goodDirection) {
      changeColor = 'text-emerald-400';
      changeBg = 'bg-emerald-500/10';
      ChangeArrow = ArrowUpRight;
    } else if (badDirection) {
      changeColor = 'text-red-400';
      changeBg = 'bg-red-500/10';
      ChangeArrow = ArrowDownRight;
    }
    // For costs with increase, arrow should be up (but red)
    if (invertColor) {
      ChangeArrow = isPositive ? ArrowUpRight : ArrowDownRight;
    }
  }

  return (
    <div
      className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5 min-h-[160px]
                 hover:border-white/[0.12] hover:bg-white/[0.03] transition-all duration-300"
      style={{ '--card-glow': color }}
    >
      {/* Subtle top accent line */}
      <div className="absolute top-0 left-0 right-0 h-[2px] opacity-40 group-hover:opacity-70 transition-opacity"
           style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} />

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
               style={{ background: color + '15' }}>
            <Icon size={14} style={{ color }} />
          </div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-white/40">{label}</span>
        </div>
      </div>

      {/* Value */}
      <div className="text-2xl font-bold text-white tracking-tight mb-1">
        {formatValue(value, format)}
      </div>

      {/* Change badge */}
      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${changeBg} ${changeColor}`}>
        {ChangeArrow && <ChangeArrow size={12} />}
        {isNeutral ? 'No change' : `${Math.abs(change).toFixed(1)}%`}
        <span className="text-white/20 ml-1">vs yesterday</span>
      </div>

      {/* Sparkline */}
      {sparkData && sparkData.length > 0 && (
        <div className="mt-3 -mx-2 -mb-2">
          <ResponsiveContainer width="100%" height={48}>
            <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
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
                strokeWidth={1.5}
                fill={`url(#${gradientId})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function Dashboard() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await api.get('/kpi-system/home-dashboard', { params: { date } });
      setData(res.data?.data || null);
    } catch (err) {
      console.error('[Dashboard] fetch error:', err);
      setError(err.response?.data?.error?.message || err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [date]);

  // Initial fetch + on date change
  useEffect(() => {
    fetchDashboard(true);
  }, [fetchDashboard]);

  // Auto-refresh every 60s (silent, no loading spinner)
  useEffect(() => {
    const interval = setInterval(() => fetchDashboard(false), 60000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const current = data?.current || {};
  const previous = data?.previous || {};
  const sparklines = data?.sparklines || [];

  // Calculate change %
  const getChange = (key) => {
    const cur = current[key];
    const prev = previous[key];
    if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  };

  return (
    <div className="p-6 space-y-6 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-white/40 mt-0.5">Real-time business overview</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Live indicator */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="relative">
              <div className="w-2 h-2 bg-emerald-400 rounded-full" />
              <div className="absolute inset-0 w-2 h-2 bg-emerald-400 rounded-full animate-ping opacity-75" />
            </div>
            <span className="text-xs font-medium text-emerald-400">Live</span>
          </div>

          <DatePicker value={date} onChange={setDate} period="daily" />
        </div>
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center justify-between">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => fetchDashboard(true)}
            className="text-sm text-red-400 hover:text-red-300 font-medium cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {METRICS.map((m) => (
          <SparklineCard
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
          />
        ))}
      </div>

      {/* Summary bar */}
      {!loading && current && current.revenue !== undefined && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span className="text-sm font-medium text-white/60">Daily Breakdown</span>
            <span className="text-xs text-white/30 ml-auto">{date}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
            <MiniStat label="Revenue" value={fmtMoneyFull(current.revenue)} />
            <MiniStat label="COGS" value={fmtMoneyFull(current.cogs)} />
            <MiniStat label="Shipping" value={fmtMoneyFull(current.shipping)} />
            <MiniStat label="Fees" value={fmtMoneyFull(current.fees)} />
            <MiniStat label="Gross Profit" value={fmtMoneyFull(current.profit)} highlight />
            <MiniStat label="Margin" value={fmtPct(current.netMargin)} highlight />
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, highlight }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1">{label}</p>
      <p className={`text-sm font-semibold ${highlight ? 'text-emerald-400' : 'text-white/80'}`}>
        {value}
      </p>
    </div>
  );
}
