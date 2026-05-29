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
  Scale,
  ShoppingBag,
  PieChart,
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
  { key: 'breakEvenRoas',  label: 'Break-Even ROAS',  icon: Scale,         color: '#c9a84c', format: 'roas', invertColor: true },
  { key: 'orders',         label: 'Purchases',        icon: ShoppingCart,  color: '#8b5cf6', format: 'int' },
  { key: 'aov',            label: 'AOV',              icon: Receipt,       color: '#06b6d4', format: 'moneyFull' },
  { key: 'costs',          label: 'Total Costs',      icon: Wallet,        color: '#ef4444', format: 'moneyFull', invertColor: true },
  { key: 'profit',         label: 'Profit',           icon: Gem,           color: '#10b981', format: 'moneyFull' },
  { key: 'netMargin',      label: 'Net Margin',       icon: Percent,       color: '#a855f7', format: 'pct' },
  { key: 'conversionRate', label: 'Conversion Rate',  icon: Target,        color: '#ec4899', format: 'pct' },
  { key: 'refunds',        label: 'Refunds',           icon: RotateCcw,     color: '#ef4444', format: 'int', invertColor: true },
];

// Amazon (Sellerboard) metric definitions — rendered as a separate row below
// the main grid only when Amazon data is present for the selected period.
// Backed by amazonRevenue / revenueWithAmazon / roasWithAmazon / pctAmazon
// fields added to /home-dashboard in kpiSystem.js (migration 055).
const AMAZON_METRICS = [
  { key: 'amazonRevenue',     label: 'Amazon Sales',      icon: ShoppingBag,  color: '#f97316', format: 'moneyFull' },
  { key: 'amazonPpc',         label: 'Amazon PPC',        icon: Megaphone,    color: '#eab308', format: 'moneyFull', invertColor: true },
  { key: 'revenueWithAmazon', label: 'Revenue w/ Amazon', icon: DollarSign,   color: '#10b981', format: 'moneyFull' },
  { key: 'roasWithAmazon',    label: 'ROAS w/ Amazon',    icon: TrendingUp,   color: '#3b82f6', format: 'roas' },
  { key: 'pctAmazon',         label: '% Amazon of Total', icon: PieChart,     color: '#a855f7', format: 'pct' },
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

// ── Break-Even ROAS Daily Trend ─────────────────────────────────────────────
//
// Plots daily break-even ROAS and actual ROAS together. Days where the actual
// line sits above break-even = profitable. Below = burning cash. The gap
// between the two lines is your safety margin.
//
// Why this matters: as AOV trends up, break-even drops, opening up cheaper
// audiences. As COGS/shipping/fees trend up, break-even climbs. Watching the
// trend reveals these shifts before they hit profit.

function BreakEvenChart({ sparklines }) {
  const chartData = (sparklines || [])
    .filter((d) => d.breakEvenRoas !== null && d.breakEvenRoas !== undefined)
    .map((d) => ({
      date: d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      breakEvenRoas: typeof d.breakEvenRoas === 'number' ? d.breakEvenRoas : null,
      roas: typeof d.roas === 'number' ? d.roas : 0,
      aov: d.aov || 0,
    }));

  if (chartData.length < 2) return null;

  // Average values for the summary line at top
  const avgBreakEven = chartData.reduce((s, d) => s + (d.breakEvenRoas || 0), 0) / chartData.length;
  const avgActual = chartData.reduce((s, d) => s + (d.roas || 0), 0) / chartData.length;
  const profitableDays = chartData.filter((d) => d.roas > (d.breakEvenRoas || 0)).length;

  return (
    <div className="glass-card border border-white/[0.05] rounded-xl p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white mb-0.5 flex items-center gap-2">
            <Scale className="w-4 h-4 text-[#c9a84c]" />
            Break-Even ROAS — Daily Trend
          </h3>
          <p className="text-xs text-zinc-500">
            Where Actual ROAS sits above Break-Even = profitable day
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-zinc-400">Profitable: <span className="text-white font-medium">{profitableDays}/{chartData.length} days</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400">Avg Break-Even: <span className="text-[#c9a84c] font-medium">{avgBreakEven.toFixed(2)}x</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400">Avg Actual: <span className={`font-medium ${avgActual >= avgBreakEven ? 'text-emerald-400' : 'text-red-400'}`}>{avgActual.toFixed(2)}x</span></span>
          </div>
        </div>
      </div>

      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 15, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorBreakEven" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c9a84c" stopOpacity={0.18} />
                <stop offset="100%" stopColor="#c9a84c" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="colorActualRoas" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.20} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.01} />
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
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}x`}
              domain={[0, (dataMax) => Math.ceil(dataMax * 1.2)]}
              dx={-10}
            />
            <Tooltip
              cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1, strokeDasharray: '4 4' }}
              contentStyle={{
                background: 'rgba(17, 17, 19, 0.95)',
                border: '1px solid rgba(201,168,76,0.3)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}
              itemStyle={{ color: '#e5e5e5' }}
              formatter={(value, name) => [`${Number(value).toFixed(2)}x`, name]}
            />
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="circle"
              wrapperStyle={{ fontSize: '12px', color: '#a1a1aa', paddingTop: '12px' }}
            />
            <Area
              type="monotone"
              dataKey="breakEvenRoas"
              name="Break-Even"
              stroke="#c9a84c"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              fillOpacity={1}
              fill="url(#colorBreakEven)"
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="roas"
              name="Actual ROAS"
              stroke="#10b981"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorActualRoas)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Profitability Health (Break-Even ROAS + AOV Sensitivity) ────────────────
//
// As AOV rises (with sub-linear COGS), break-even ROAS drops — meaning lower-
// ROAS campaigns become profitable. This panel makes that relationship visible
// and lets the user eyeball how much headroom they have.
//
// Math:
//   Break-even ROAS = Revenue / (Revenue − COGS − Shipping − Fees)
//   Equivalently per order: AOV / (AOV − variable cost per order)
//
// The sensitivity table holds the *current* per-order variable cost fixed and
// re-projects break-even ROAS at different AOV levels. Honest assumption: in
// reality COGS scales somewhat with AOV (bigger order = pricier mix), so this
// is a slight under-estimate of break-even at higher AOV.

function ProfitabilityPanel({ current, loading }) {
  if (loading || !current) return null;

  const aov = current.aov || 0;
  const orders = current.orders || 0;
  const varCostPerOrder = orders > 0 ? (current.cogs + current.shipping + current.fees) / orders : 0;
  const breakEven = current.breakEvenRoas || 0;
  const actualRoas = current.roas || 0;
  const margin = current.contributionMarginPct || 0;
  const headroomPct = breakEven > 0 ? ((actualRoas - breakEven) / breakEven) * 100 : 0;

  // Sensitivity: how break-even ROAS shifts at different AOVs (assuming
  // variable cost per order stays roughly constant).
  const aovScenarios = [
    Math.max(50, Math.round(aov * 0.7 / 25) * 25),
    Math.max(75, Math.round(aov * 0.85 / 25) * 25),
    Math.round(aov / 25) * 25 || aov,
    Math.round(aov * 1.15 / 25) * 25,
    Math.round(aov * 1.3 / 25) * 25,
  ];

  const isHealthy = actualRoas > breakEven && breakEven > 0;

  return (
    <div className="glass-card border border-white/[0.05] rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h3 className="text-sm font-medium text-white mb-0.5 flex items-center gap-2">
            <Scale className="w-4 h-4 text-[#c9a84c]" />
            Profitability Health
          </h3>
          <p className="text-xs text-zinc-500">
            How break-even ROAS shifts with AOV — your safety margin on ad campaigns
          </p>
        </div>
        <div className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
          isHealthy
            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border-red-500/20'
        }`}>
          {isHealthy ? `+${headroomPct.toFixed(0)}% headroom` : `${headroomPct.toFixed(0)}% below`}
        </div>
      </div>

      {/* Current state */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-white/[0.02] border border-white/[0.05] rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Current AOV</p>
          <p className="text-lg font-semibold text-white">{fmtMoneyFull(aov)}</p>
        </div>
        <div className="bg-white/[0.02] border border-white/[0.05] rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Var. Cost / Order</p>
          <p className="text-lg font-semibold text-white">{fmtMoneyFull(varCostPerOrder)}</p>
        </div>
        <div className="bg-[#c9a84c]/5 border border-[#c9a84c]/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-[#c9a84c] mb-1">Break-Even ROAS</p>
          <p className="text-lg font-semibold text-white">{fmtRoas(breakEven)}</p>
        </div>
        <div className={`rounded-lg p-3 border ${
          isHealthy ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
        }`}>
          <p className={`text-[10px] uppercase tracking-wider mb-1 ${
            isHealthy ? 'text-emerald-400' : 'text-red-400'
          }`}>Actual ROAS</p>
          <p className="text-lg font-semibold text-white">{fmtRoas(actualRoas)}</p>
        </div>
      </div>

      {/* Sensitivity table */}
      <div>
        <p className="text-xs text-zinc-500 mb-2">
          If AOV changes (variable cost ~${varCostPerOrder.toFixed(0)}/order, contribution margin {margin.toFixed(1)}%):
        </p>
        <div className="grid grid-cols-5 gap-2">
          {aovScenarios.map((aovVal) => {
            const contrib = aovVal - varCostPerOrder;
            const beRoas = contrib > 0 ? aovVal / contrib : null;
            const isCurrent = aovVal === aovScenarios[2];
            return (
              <div
                key={aovVal}
                className={`rounded-lg p-3 text-center border ${
                  isCurrent
                    ? 'bg-[#c9a84c]/10 border-[#c9a84c]/30'
                    : 'bg-white/[0.02] border-white/[0.05]'
                }`}
              >
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  {isCurrent ? 'Now' : `AOV $${aovVal}`}
                </p>
                <p className="text-base font-semibold text-white">
                  {beRoas ? `${beRoas.toFixed(2)}x` : '—'}
                </p>
                {isCurrent && (
                  <p className="text-[9px] text-[#c9a84c] mt-0.5">${aovVal} AOV</p>
                )}
              </div>
            );
          })}
        </div>
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
    // Retry transient network errors (deploy restarts, brief connectivity
    // hiccups). Auth errors / 4xx / 5xx fail-fast on the first attempt.
    const isTransient = (err) =>
      !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error' || err.code === 'ECONNABORTED');
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      try {
        const res = await api.get('/kpi-system/home-dashboard', { params: { startDate, endDate } });
        setData(res.data?.data || null);
        setLoading(false);
        return;
      } catch (err) {
        attempt++;
        if (isTransient(err) && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));  // 1s, 2s
          continue;
        }
        console.error('[Dashboard] fetch error:', err);
        setError(err.response?.data?.error?.message || err.message || 'Failed to load');
        setLoading(false);
        return;
      }
    }
  }, [startDate, endDate]);

  useEffect(() => { fetchDashboard(true); }, [fetchDashboard]);

  // Auto-correct when the browser's clock is ahead of the server's date.
  // Without this, "Today" silently shows zeros for a future date the user
  // doesn't realize they're requesting. Triggers once per response.
  useEffect(() => {
    if (!data?.serverDate) return;
    if (endDate > data.serverDate) {
      setStartDate(data.serverDate);
      setEndDate(data.serverDate);
    }
  }, [data?.serverDate, endDate]);
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

        {/* Future-date warning — shown when the user's local clock is ahead of
            the server's actual date, which causes "Today" to query a date with
            no data and display all zeros. */}
        {!loading && data?.serverDate && data?.latestSnapshotDate && endDate > data.serverDate && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <span className="text-amber-400 text-lg">⚠</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-200 mb-1">
                  Selected date is in the future — your computer's clock may be ahead.
                </p>
                <p className="text-xs text-amber-200/70 mb-2">
                  Server time is <span className="font-mono">{data.serverDate}</span> (Europe/Berlin).
                  Latest data available is <span className="font-mono">{data.latestSnapshotDate}</span>.
                  No orders/spend exist on <span className="font-mono">{endDate}</span> yet.
                </p>
                <button
                  onClick={() => { setStartDate(data.serverDate); setEndDate(data.serverDate); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-medium cursor-pointer transition-colors"
                >
                  Jump to {data.serverDate}
                </button>
              </div>
            </div>
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

        {/* KPI Grid — Bottom row: 6 cards (after adding Break-Even ROAS in top row) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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

        {/* Amazon (Sellerboard) row — appears only when Amazon data is present.
            PST day tagged to matching Berlin date (Option A timezone convention). */}
        {!loading && (current.amazonRevenue > 0 || current.amazonPpc > 0) && (
          <>
            <div className="flex items-center gap-2 pt-2 px-1">
              <ShoppingBag size={14} className="text-orange-400" />
              <h2 className="text-xs font-medium text-white uppercase tracking-[0.15em]">
                Amazon
              </h2>
              <span className="text-[10px] text-zinc-500">
                Pacific Time day · tagged to Berlin date
              </span>
              {current.amazonRevenue > 0 && !(current.amazonRevenue - current.amazonPpc > 0) && (
                <span className="ml-auto text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-0.5">
                  ⚠ COGS not configured in Sellerboard — profit hidden
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {AMAZON_METRICS.map((m, i) => (
                <KpiCard
                  key={m.key}
                  label={m.label}
                  value={current[m.key]}
                  format={m.format}
                  icon={m.icon}
                  color={m.color}
                  sparkData={sparklines}
                  sparkKey={m.key}
                  change={getChange(m.key)}
                  invertColor={m.invertColor}
                  loading={false}
                  index={i + 11}
                />
              ))}
            </div>
          </>
        )}

        {/* Profitability Health — Break-Even ROAS + AOV sensitivity */}
        <ProfitabilityPanel current={current} loading={loading} />

        {/* Break-Even ROAS Daily Trend — actual vs break-even, profitable days count */}
        {!loading && chartData.length > 1 && <BreakEvenChart sparklines={chartData} />}

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
