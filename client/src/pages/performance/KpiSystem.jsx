import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  Package,
  Truck,
  AlertTriangle,
  RefreshCw,
  Download,
  BarChart3,
} from 'lucide-react';
import DatePicker from '../../components/ui/DatePicker';
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPct = (n) => Number(n || 0).toFixed(1) + '%';

const fmtInt = (n) => Number(n || 0).toLocaleString();

const todayStr = () => new Date().toISOString().slice(0, 10);

const cardStyle = 'bg-[#111] border border-white/[0.06] rounded-xl p-5';

const btnBase =
  'px-3 py-2 text-sm rounded-lg border transition-colors focus:outline-none cursor-pointer';

const btnActive = 'bg-blue-600 border-blue-500 text-white';
const btnInactive =
  'bg-white/[0.04] border-white/[0.08] text-[#888] hover:text-white hover:border-white/20';

// ── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, subtitle, change, changeLabel, accentColor }) {
  const isPositive = (change ?? 0) >= 0;
  const Arrow = isPositive ? TrendingUp : TrendingDown;
  const changeColor = isPositive ? 'text-green-500' : 'text-red-500';

  return (
    <div className={cardStyle}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accentColor || 'bg-blue-500/10'}`}>
          <Icon size={16} className={accentColor ? accentColor.replace('bg-', 'text-').replace('/10', '') : 'text-blue-400'} />
        </div>
        <span className="text-[#888] text-sm">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-white mb-1">{value}</div>
      {subtitle && <div className="text-xs text-[#888] mb-2">{subtitle}</div>}
      {change !== undefined && change !== null && (
        <div className={`flex items-center gap-1 text-xs ${changeColor}`}>
          <Arrow size={12} />
          <span>{isPositive ? '+' : ''}{fmtPct(change)}</span>
          {changeLabel && <span className="text-[#555]">vs prev</span>}
        </div>
      )}
    </div>
  );
}

// ── Margin Badge ─────────────────────────────────────────────────────────────

function MarginBadge({ margin }) {
  const m = Number(margin || 0);
  let color = 'bg-red-500/15 text-red-400';
  if (m >= 50) color = 'bg-green-500/15 text-green-400';
  else if (m >= 40) color = 'bg-orange-500/15 text-orange-400';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {fmtPct(m)}
    </span>
  );
}

// ── Alert Severity Badge ─────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const map = {
    critical: 'bg-red-500/15 text-red-400 border-red-500/20',
    high: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
    medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
    low: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  };
  const style = map[(severity || '').toLowerCase()] || map.medium;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      {(severity || 'Medium').charAt(0).toUpperCase() + (severity || 'medium').slice(1)}
    </span>
  );
}

// ── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg p-3 text-xs shadow-xl">
      <div className="text-[#888] mb-2">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-[#888] capitalize">{p.dataKey}:</span>
          <span className="text-white font-medium">{fmtMoney(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Sortable Header ──────────────────────────────────────────────────────────

function SortHeader({ label, field, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th
      className="text-left text-xs text-[#888] font-medium px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sortDir === 'asc' ? <TrendingUp size={10} /> : <TrendingDown size={10} />)}
      </span>
    </th>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function KpiSystem() {
  // State
  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayStr());
  const [dashboard, setDashboard] = useState(null);
  const [trends, setTrends] = useState([]);
  const [skuBreakdown, setSkuBreakdown] = useState([]);
  const [costSheet, setCostSheet] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [skuSort, setSkuSort] = useState({ field: 'revenue', dir: 'desc' });

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endDate = date;
      // Calculate startDate based on period
      const d = new Date(date + 'T00:00:00');
      let startDate = date;
      if (period === 'weekly') {
        const s = new Date(d);
        s.setDate(s.getDate() - 6);
        startDate = s.toISOString().slice(0, 10);
      } else if (period === 'monthly') {
        const s = new Date(d);
        s.setDate(s.getDate() - 29);
        startDate = s.toISOString().slice(0, 10);
      }

      const safeGet = (url, opts) => api.get(url, opts).catch(e => ({ data: {} }));
      const [dashRes, trendRes, skuRes, costRes, alertRes] = await Promise.all([
        api.get('/kpi-system/dashboard', { params: { period, date } }),
        safeGet('/kpi-system/trends', { params: { days: 30 } }),
        safeGet('/kpi-system/sku-breakdown', { params: { startDate, endDate } }),
        safeGet('/kpi-system/cost-sheet', { params: { period, date } }),
        safeGet('/kpi-system/alerts'),
      ]);

      setDashboard(dashRes.data?.data || dashRes.data || {});
      // trends API returns { days: N, dataPoints: [...], comparison }
      const trendData = trendRes.data?.data || trendRes.data || {};
      setTrends(trendData.dataPoints || trendData.days || trendData.data || (Array.isArray(trendData) ? trendData : []));
      // sku-breakdown API returns { breakdown: [...] }
      const skuData = skuRes.data?.data || skuRes.data || {};
      setSkuBreakdown(skuData.breakdown || skuData.skus || (Array.isArray(skuData) ? skuData : []));
      // cost-sheet API returns { summary: {...}, orders: [...] }
      setCostSheet(costRes.data?.data || costRes.data || {});
      // alerts API returns { alerts: [...] }
      const alertData = alertRes.data?.data || alertRes.data || {};
      setAlerts(alertData.alerts || (Array.isArray(alertData) ? alertData : []));
    } catch (err) {
      console.error('KPI fetch error:', err);
      setError(err.response?.data?.message || err.message || 'Failed to load KPI data');
    } finally {
      setLoading(false);
    }
  }, [period, date]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.post('/kpi-system/sync');
      await fetchAll();
    } catch (err) {
      console.error('Sync error:', err);
      setError(err.response?.data?.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/kpi-system/export', {
        responseType: 'blob',
        params: { period, date },
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `kpi-export-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      setError(err.response?.data?.message || 'Export failed');
    }
  };

  // ── SKU Sort ───────────────────────────────────────────────────────────────

  const handleSkuSort = (field) => {
    setSkuSort((prev) => ({
      field,
      dir: prev.field === field && prev.dir === 'desc' ? 'asc' : 'desc',
    }));
  };

  const sortedSkus = [...skuBreakdown].sort((a, b) => {
    const dir = skuSort.dir === 'asc' ? 1 : -1;
    const av = a[skuSort.field] ?? 0;
    const bv = b[skuSort.field] ?? 0;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });

  // ── Metrics from dashboard ─────────────────────────────────────────────────

  const m = dashboard || {};
  const raw = m.metrics || m;
  // Normalize field names from API (totalRevenue → revenue, totalOrders → orders, etc.)
  const metrics = {
    ...raw,
    revenue: raw.revenue ?? raw.totalRevenue ?? raw.netRevenue ?? 0,
    netRevenue: raw.netRevenue ?? raw.totalRevenue ?? raw.revenue ?? 0,
    grossRevenue: raw.grossRevenue ?? raw.totalRevenue ?? 0,
    orders: raw.orders ?? raw.totalOrders ?? raw.orderCount ?? 0,
    unitsSold: raw.unitsSold ?? (Number(raw.totalMinersSold || 0) + Number(raw.totalRigsSold || 0)),
    aov: raw.aov ?? raw.avgOrderValue ?? 0,
    cogs: raw.cogs ?? raw.totalCogs ?? 0,
    shippingCost: raw.shippingCost ?? raw.totalShipping ?? 0,
    grossProfit: raw.grossProfit ?? raw.totalGrossProfit ?? 0,
    margin: raw.margin ?? raw.avgProfitMargin ?? raw.grossMargin ?? 0,
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  // Loading state
  if (loading && !dashboard) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw size={24} className="text-blue-500 animate-spin" />
          <span className="text-[#888] text-sm">Loading KPI data...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !dashboard) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className={`${cardStyle} max-w-md text-center`}>
          <AlertTriangle size={32} className="text-red-500 mx-auto mb-3" />
          <div className="text-white font-medium mb-2">Failed to load KPI data</div>
          <div className="text-[#888] text-sm mb-4">{error}</div>
          <button
            onClick={fetchAll}
            className={`${btnBase} ${btnActive}`}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const costSheetRows = costSheet?.orders || costSheet?.rows || costSheet?.dailyBreakdown || [];
  const costSummary = costSheet?.summary || {};
  const supplierOwed = Number(costSummary?.totalCogs || 0) + Number(costSummary?.totalShipping || 0) || (Number(metrics.totalCogs || 0) + Number(metrics.totalShipping || 0));
  const alertList = Array.isArray(alerts) ? alerts : [];

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">

        {/* ── Header Bar ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 mr-auto">
            <div className="w-9 h-9 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <DollarSign size={18} className="text-blue-400" />
            </div>
            <h1 className="text-xl font-semibold text-white">KPI System</h1>
          </div>

          {/* Period toggle */}
          <div className="flex gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
            {['daily', 'weekly', 'monthly'].map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors cursor-pointer ${
                  period === p ? 'bg-blue-600 text-white' : 'text-[#888] hover:text-white'
                }`}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>

          {/* Date picker */}
          <DatePicker value={date} onChange={setDate} period={period} />

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className={`${btnBase} ${syncing ? 'opacity-50 cursor-not-allowed' : ''} bg-white/[0.04] border-white/[0.08] text-white hover:border-white/20 flex items-center gap-2`}
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Shopify'}
          </button>

          {/* Export button */}
          <button
            onClick={handleExport}
            className={`${btnBase} bg-white/[0.04] border-white/[0.08] text-white hover:border-white/20 flex items-center gap-2`}
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>

        {/* Inline error banner */}
        {error && dashboard && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {/* ── KPI Metric Cards ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <MetricCard
            icon={DollarSign}
            label="Revenue"
            value={fmtMoney(metrics.netRevenue ?? metrics.revenue)}
            subtitle={metrics.grossRevenue ? `Gross: ${fmtMoney(metrics.grossRevenue)}` : undefined}
            change={metrics.revenueChange}
            changeLabel
            accentColor="bg-green-500/10"
          />
          <MetricCard
            icon={ShoppingCart}
            label="Orders"
            value={fmtInt(metrics.orders ?? metrics.orderCount)}
            subtitle={metrics.unitsSold ? `${fmtInt(metrics.unitsSold)} units sold` : undefined}
            change={metrics.ordersChange}
            changeLabel
            accentColor="bg-blue-500/10"
          />
          <MetricCard
            icon={BarChart3}
            label="AOV"
            value={fmtMoney(metrics.aov)}
            change={metrics.aovChange}
            changeLabel
            accentColor="bg-purple-500/10"
          />
          <MetricCard
            icon={Package}
            label="COGS"
            value={fmtMoney(metrics.cogs ?? metrics.totalCogs)}
            subtitle="Supplier owed"
            accentColor="bg-red-500/10"
          />
          <MetricCard
            icon={Truck}
            label="Shipping"
            value={fmtMoney(metrics.shippingCost ?? metrics.shipping ?? metrics.totalShipping)}
            accentColor="bg-orange-500/10"
          />
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-green-500/10">
                <TrendingUp size={16} className="text-green-400" />
              </div>
              <span className="text-[#888] text-sm">Profit</span>
            </div>
            <div className="text-2xl font-semibold text-white mb-1">
              {fmtMoney(metrics.profit ?? metrics.grossProfit)}
            </div>
            <div className="mt-2">
              <MarginBadge margin={metrics.margin ?? metrics.profitMargin} />
            </div>
            {metrics.profitChange !== undefined && metrics.profitChange !== null && (
              <div className={`flex items-center gap-1 text-xs mt-2 ${(metrics.profitChange ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {(metrics.profitChange ?? 0) >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                <span>{(metrics.profitChange ?? 0) >= 0 ? '+' : ''}{fmtPct(metrics.profitChange)}</span>
                <span className="text-[#555]">vs prev</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Profit Trend Chart ──────────────────────────────────────────── */}
        {trends.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 size={16} className="text-blue-400" />
              <h2 className="text-sm font-medium text-white">Profit Trend (Last 30 Days)</h2>
            </div>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trends} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="gRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gProfit" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#16a34a" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#888', fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickFormatter={(v) => {
                      if (!v) return '';
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis
                    tick={{ fill: '#888', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, color: '#888' }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#2563eb"
                    strokeWidth={2}
                    fill="url(#gRevenue)"
                    name="Revenue"
                  />
                  <Area
                    type="monotone"
                    dataKey="grossProfit"
                    stroke="#16a34a"
                    strokeWidth={2}
                    fill="url(#gProfit)"
                    name="Profit"
                  />
                  <Line
                    type="monotone"
                    dataKey="cogs"
                    stroke="#dc2626"
                    strokeWidth={2}
                    dot={false}
                    name="COGS"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── SKU Breakdown Table ─────────────────────────────────────────── */}
        {sortedSkus.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <Package size={16} className="text-blue-400" />
              <h2 className="text-sm font-medium text-white">SKU Breakdown</h2>
              <span className="text-xs text-[#555] ml-auto">{sortedSkus.length} products</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <SortHeader label="SKU" field="sku" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="Product" field="product" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="Units" field="unitsSold" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="Revenue" field="revenue" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="COGS" field="cogs" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="Profit" field="profit" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                    <SortHeader label="Margin" field="margin" sortField={skuSort.field} sortDir={skuSort.dir} onSort={handleSkuSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedSkus.map((row, i) => {
                    const negativeMargin = (row.margin ?? 0) < 0;
                    return (
                      <tr
                        key={row.sku || i}
                        className={`border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${
                          negativeMargin ? 'bg-red-500/[0.05]' : ''
                        }`}
                      >
                        <td className="px-3 py-3 text-white font-mono text-xs">{row.sku || '-'}</td>
                        <td className="px-3 py-3 text-white">{row.title || row.product || row.productName || '-'}</td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.unitsSold ?? row.units)}</td>
                        <td className="px-3 py-3 text-white">{fmtMoney(row.revenue)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(row.cogs)}</td>
                        <td className={`px-3 py-3 font-medium ${(row.profit ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {fmtMoney(row.profit)}
                        </td>
                        <td className="px-3 py-3">
                          <MarginBadge margin={row.margin} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Supplier Cost Sheet ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Amount owed card */}
          <div className={`${cardStyle} lg:col-span-1 flex flex-col items-center justify-center text-center`}>
            <div className="text-[#888] text-sm mb-2">Amount Owed to Supplier</div>
            <div className="text-3xl font-bold text-white mb-1">{fmtMoney(supplierOwed)}</div>
            <div className="text-xs text-[#555]">
              {period.charAt(0).toUpperCase() + period.slice(1)} &middot; {date}
            </div>
          </div>

          {/* Cost sheet table */}
          <div className={`${cardStyle} lg:col-span-3`}>
            <div className="flex items-center gap-2 mb-4">
              <Truck size={16} className="text-orange-400" />
              <h2 className="text-sm font-medium text-white">Supplier Cost Sheet</h2>
            </div>
            {costSheetRows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Order #</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Date</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Country</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Miners</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Rigs</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">COGS</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Shipping</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Total Cost</th>
                      <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costSheetRows.map((row, i) => (
                      <tr key={row.orderNumber || i} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                        <td className="px-3 py-3 text-white text-xs">#{row.orderNumber}</td>
                        <td className="px-3 py-3 text-white text-xs">{row.date ? new Date(row.date).toLocaleDateString() : '-'}</td>
                        <td className="px-3 py-3 text-[#888] text-xs">{row.country || '-'}</td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.miners)}</td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.rigs)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(row.cogs)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(row.shipping)}</td>
                        <td className="px-3 py-3 text-white font-medium">{fmtMoney(Number(row.cogs || 0) + Number(row.shipping || 0))}</td>
                        <td className="px-3 py-3"><MarginBadge margin={row.margin} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-[#555] text-sm">No cost sheet data for this period</div>
            )}
          </div>
        </div>

        {/* ── Alerts ──────────────────────────────────────────────────────── */}
        {alertList.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={16} className="text-orange-400" />
              <h2 className="text-sm font-medium text-white">Alerts</h2>
              <span className="text-xs text-[#555] ml-auto">{alertList.length} active</span>
            </div>
            <div className="space-y-3">
              {alertList.map((alert, i) => (
                <div
                  key={alert.id || i}
                  className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
                >
                  <SeverityBadge severity={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white">{alert.message || alert.title}</div>
                    {alert.description && (
                      <div className="text-xs text-[#888] mt-1">{alert.description}</div>
                    )}
                  </div>
                  {(alert.timestamp || alert.createdAt) && (
                    <div className="text-xs text-[#555] whitespace-nowrap">
                      {new Date(alert.timestamp || alert.createdAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
