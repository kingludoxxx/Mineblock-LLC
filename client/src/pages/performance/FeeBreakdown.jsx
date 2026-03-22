import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import {
  AlertTriangle,
  RefreshCw,
  DollarSign,
  CreditCard,
  Layers,
  Percent,
} from 'lucide-react';
import DatePicker from '../../components/ui/DatePicker';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPct = (n) => Number(n || 0).toFixed(2) + '%';

const fmtInt = (n) => Number(n || 0).toLocaleString();

const todayStr = () => new Date().toISOString().slice(0, 10);

const cardStyle = 'bg-[#111] border border-white/[0.06] rounded-xl p-5';

const btnBase =
  'px-3 py-2 text-sm rounded-lg border transition-colors focus:outline-none cursor-pointer';

const FEE_COLORS = {
  processing: '#3b82f6',
  whop: '#a855f7',
  lasso: '#f97316',
  other: '#6b7280',
};

// ── Chart Tooltip ────────────────────────────────────────────────────────────

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

function BarTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg p-3 text-xs shadow-xl">
      <div className="text-white font-medium mb-1">{d?.name || d?.feeType}</div>
      <div className="text-[#888]">{fmtMoney(d?.amount || d?.total)}</div>
    </div>
  );
}

// ── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, amount, pctOfVolume, badge, accentColor }) {
  return (
    <div className={cardStyle}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accentColor}`}>
          <Icon size={16} className={accentColor.replace('bg-', 'text-').replace('/10', '')} />
        </div>
        <span className="text-[#888] text-sm">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-white mb-1">{fmtMoney(amount)}</div>
      <div className="text-xs text-[#888]">{fmtPct(pctOfVolume)} of payment volume</div>
      {badge && (
        <div className="mt-2">
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400">
            Effective rate: {fmtPct(badge)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function FeeBreakdown() {
  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Data Fetching ────────────────────────────────────────────────────────

  const fetchFees = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/kpi-system/fees', {
        params: { period, date },
      });
      setData(res.data?.data || res.data || {});
    } catch (err) {
      console.error('Fee fetch error:', err);
      setError(err.response?.data?.message || err.message || 'Failed to load fee data');
    } finally {
      setLoading(false);
    }
  }, [period, date]);

  useEffect(() => {
    fetchFees();
    const interval = setInterval(fetchFees, 60_000);
    return () => clearInterval(interval);
  }, [fetchFees]);

  // ── Loading State ────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw size={24} className="text-blue-500 animate-spin" />
          <span className="text-[#888] text-sm">Loading fee data...</span>
        </div>
      </div>
    );
  }

  // ── Error State ──────────────────────────────────────────────────────────

  if (error && !data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className={`${cardStyle} max-w-md text-center`}>
          <AlertTriangle size={32} className="text-red-500 mx-auto mb-3" />
          <div className="text-white font-medium mb-2">Failed to load fee data</div>
          <div className="text-[#888] text-sm mb-4">{error}</div>
          <button onClick={fetchFees} className={`${btnBase} bg-blue-600 border-blue-500 text-white`}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Derived Data ─────────────────────────────────────────────────────────

  const summary = data?.summary || {};
  const dailyBreakdown = data?.dailyBreakdown || [];
  const feeTypeBreakdown = data?.feeTypeBreakdown || [];
  const recentPayments = (data?.recentPayments || []).slice(0, 50);

  // Compute lassoFees from feeTypeBreakdown since API doesn't include it in summary
  const lassoFees = lassoFees || feeTypeBreakdown.find(f => f.type === 'lasso_percentage_fee')?.total || 0;

  const totalVolume = Number(summary.totalPaymentAmount || 0);
  const pctOf = (v) => (totalVolume > 0 ? (Number(v || 0) / totalVolume) * 100 : 0);

  // Bar chart data from feeTypeBreakdown
  const barData = feeTypeBreakdown.map((f) => ({
    name: f.name || f.feeType || 'Unknown',
    amount: Number(f.total || f.amount || 0),
    type: (f.type || f.feeType || '').toLowerCase(),
  }));

  const getBarColor = (type) => {
    if (type.includes('process') || type.includes('stripe')) return FEE_COLORS.processing;
    if (type.includes('whop')) return FEE_COLORS.whop;
    if (type.includes('lasso')) return FEE_COLORS.lasso;
    return FEE_COLORS.other;
  };

  // Fee detail table sorted by total desc
  const feeDetails = [...feeTypeBreakdown].sort(
    (a, b) => Number(b.total || b.amount || 0) - Number(a.total || a.amount || 0)
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">

        {/* ── Header Bar ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 mr-auto">
            <div className="w-9 h-9 bg-orange-500/10 rounded-lg flex items-center justify-center">
              <AlertTriangle size={18} className="text-orange-400" />
            </div>
            <h1 className="text-xl font-semibold text-white">Fee Breakdown</h1>
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

          {/* Live indicator */}
          <span className="flex items-center gap-1.5 text-xs text-green-500">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            Live
          </span>
        </div>

        {/* Inline error banner */}
        {error && data && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {/* ── Summary Cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard
            icon={DollarSign}
            label="Total Fees"
            amount={summary.totalFees}
            pctOfVolume={pctOf(summary.totalFees)}
            badge={summary.effectiveRate}
            accentColor="bg-red-500/10"
          />
          <SummaryCard
            icon={CreditCard}
            label="Processing Fees"
            amount={summary.processingFees}
            pctOfVolume={pctOf(summary.processingFees)}
            accentColor="bg-blue-500/10"
          />
          <SummaryCard
            icon={Layers}
            label="Whop Fees"
            amount={summary.whopFees}
            pctOfVolume={pctOf(summary.whopFees)}
            accentColor="bg-purple-500/10"
          />
          <SummaryCard
            icon={Percent}
            label="Lasso Fees"
            amount={lassoFees}
            pctOfVolume={pctOf(lassoFees)}
            accentColor="bg-orange-500/10"
          />
        </div>

        {/* ── Fee Type Breakdown (Bar Chart) ────────────────────────────── */}
        {barData.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={16} className="text-orange-400" />
              <h2 className="text-sm font-medium text-white">Fee Type Breakdown</h2>
            </div>
            <div className="flex flex-wrap gap-3 mb-4">
              {Object.entries(FEE_COLORS).map(([key, color]) => (
                <div key={key} className="flex items-center gap-1.5 text-xs text-[#888]">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                  <span className="capitalize">{key}</span>
                </div>
              ))}
            </div>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: '#888', fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: '#888', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={140}
                  />
                  <Tooltip content={<BarTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="amount" radius={[0, 4, 4, 0]} barSize={20}>
                    {barData.map((entry, i) => (
                      <Cell key={i} fill={getBarColor(entry.type || entry.name)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── Daily Fee Trend (Area Chart) ──────────────────────────────── */}
        {dailyBreakdown.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <DollarSign size={16} className="text-blue-400" />
              <h2 className="text-sm font-medium text-white">Daily Fee Trend</h2>
            </div>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyBreakdown} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="gFees" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f97316" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
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
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="totalFees"
                    stroke="#f97316"
                    strokeWidth={2}
                    fill="url(#gFees)"
                    name="Total Fees"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── Fee Type Detail Table ─────────────────────────────────────── */}
        {feeDetails.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <Layers size={16} className="text-purple-400" />
              <h2 className="text-sm font-medium text-white">Fee Type Details</h2>
              <span className="text-xs text-[#555] ml-auto">{feeDetails.length} types</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Fee Type</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Name</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Total Amount</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Transaction Count</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Avg Per Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {feeDetails.map((row, i) => {
                    const total = Number(row.total || row.amount || 0);
                    const count = Number(row.transactionCount || row.count || 0);
                    const avg = count > 0 ? total / count : 0;
                    const type = (row.type || row.feeType || '').toLowerCase();
                    return (
                      <tr
                        key={row.feeType || row.name || i}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-sm"
                              style={{ background: getBarColor(type || row.name || '') }}
                            />
                            <span className="text-white capitalize">{row.type || row.feeType || '-'}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-white">{row.name || '-'}</td>
                        <td className="px-3 py-3 text-white font-medium">{fmtMoney(total)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtInt(count)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(avg)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Recent Payments Table ─────────────────────────────────────── */}
        {recentPayments.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <CreditCard size={16} className="text-blue-400" />
              <h2 className="text-sm font-medium text-white">Recent Payments</h2>
              <span className="text-xs text-[#555] ml-auto">{recentPayments.length} payments</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Payment ID</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Amount</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Currency</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Total Fees</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Fee %</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Paid At</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPayments.map((p, i) => {
                    const amount = Number(p.amount || 0);
                    const fees = Number(p.totalFees || p.fees || 0);
                    const feePct = amount > 0 ? (fees / amount) * 100 : 0;
                    const isHighFee = feePct > 5;
                    return (
                      <tr
                        key={p.paymentId || p.id || i}
                        className={`border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${
                          isHighFee ? 'bg-orange-500/[0.05]' : ''
                        }`}
                      >
                        <td className="px-3 py-3 text-white font-mono text-xs">
                          {p.paymentId || p.id || '-'}
                        </td>
                        <td className="px-3 py-3 text-white">{fmtMoney(amount)}</td>
                        <td className="px-3 py-3 text-[#888] uppercase text-xs">
                          {p.currency || 'USD'}
                        </td>
                        <td className={`px-3 py-3 font-medium ${isHighFee ? 'text-orange-400' : 'text-white'}`}>
                          {fmtMoney(fees)}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                              isHighFee
                                ? 'bg-orange-500/15 text-orange-400'
                                : 'bg-white/[0.06] text-[#888]'
                            }`}
                          >
                            {fmtPct(feePct)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-[#888] text-xs whitespace-nowrap">
                          {p.paidAt || p.createdAt
                            ? new Date(p.paidAt || p.createdAt).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })
                            : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
