import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../services/api';
import {
  Package,
  DollarSign,
  Truck,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Download,
  Link2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import DatePicker from '../../components/ui/DatePicker';

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

// ── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, change, accentColor }) {
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
      {change !== undefined && change !== null && (
        <div className={`flex items-center gap-1 text-xs ${changeColor}`}>
          <Arrow size={12} />
          <span>{isPositive ? '+' : ''}{fmtPct(change)}</span>
          <span className="text-[#555]">vs prev period</span>
        </div>
      )}
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

export default function SupplierCostSheet() {
  // State
  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayStr());
  const [costSheet, setCostSheet] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [expandedDays, setExpandedDays] = useState({});
  const [orderSort, setOrderSort] = useState({ field: 'date', dir: 'desc' });

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [costRes, dashRes] = await Promise.all([
        api.get('/kpi-system/cost-sheet', { params: { period, date } }),
        api.get('/kpi-system/dashboard', { params: { period, date } }),
      ]);

      setCostSheet(costRes.data?.data || costRes.data || {});
      setDashboard(dashRes.data?.data || dashRes.data || {});
    } catch (err) {
      console.error('Supplier cost sheet fetch error:', err);
      setError(err.response?.data?.message || err.message || 'Failed to load cost sheet data');
    } finally {
      setLoading(false);
    }
  }, [period, date]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Export CSV ─────────────────────────────────────────────────────────────

  const handleExport = async () => {
    try {
      const res = await api.get('/kpi-system/export', {
        responseType: 'blob',
        params: { period, date },
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `supplier-cost-sheet-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      setError(err.response?.data?.message || 'Export failed');
    }
  };

  // ── Share Link ─────────────────────────────────────────────────────────────

  const handleShareLink = () => {
    const shareUrl = `${window.location.origin}/supplier/cost-sheet?token=SUPPLIER_SHARE_TOKEN`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Expand / Collapse Days ─────────────────────────────────────────────────

  const toggleDay = (dayKey) => {
    setExpandedDays((prev) => ({ ...prev, [dayKey]: !prev[dayKey] }));
  };

  // ── Order Sort ─────────────────────────────────────────────────────────────

  const handleOrderSort = (field) => {
    setOrderSort((prev) => ({
      field,
      dir: prev.field === field && prev.dir === 'desc' ? 'asc' : 'desc',
    }));
  };

  // ── Derived Data ───────────────────────────────────────────────────────────

  const raw = dashboard?.metrics || dashboard || {};
  const costData = costSheet || {};
  const costSummary = costData.summary || {};
  const orders = costData.orders || costData.rows || [];
  const dailyBreakdown = costData.dailyBreakdown || costData.daily || [];

  const totalCogs =
    Number(costSummary.totalCogs || 0) ||
    Number(raw.cogs || raw.totalCogs || 0);
  const totalShipping =
    Number(costSummary.totalShipping || 0) ||
    Number(raw.shippingCost || raw.totalShipping || 0);
  const grandTotal = totalCogs + totalShipping;

  const cogsChange = costSummary.cogsChange ?? raw.cogsChange ?? null;
  const shippingChange = costSummary.shippingChange ?? raw.shippingChange ?? null;
  const totalChange = costSummary.totalChange ?? null;

  // Sort orders
  const sortedOrders = useMemo(() => {
    return [...orders].sort((a, b) => {
      const dir = orderSort.dir === 'asc' ? 1 : -1;
      const av = a[orderSort.field] ?? '';
      const bv = b[orderSort.field] ?? '';
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
  }, [orders, orderSort]);

  // Compute daily breakdown totals
  const dailyTotals = useMemo(() => {
    if (dailyBreakdown.length === 0) return null;
    return dailyBreakdown.reduce(
      (acc, row) => ({
        orders: acc.orders + Number(row.orders || row.orderCount || 0),
        mrUnits: acc.mrUnits + Number(row.mrUnits || row.miners || 0),
        rigUnits: acc.rigUnits + Number(row.rigUnits || row.rigs || 0),
        productCost: acc.productCost + Number(row.productCost || row.cogs || 0),
        shippingCost: acc.shippingCost + Number(row.shippingCost || row.shipping || 0),
        total: acc.total + Number(row.total || (Number(row.productCost || row.cogs || 0) + Number(row.shippingCost || row.shipping || 0))),
      }),
      { orders: 0, mrUnits: 0, rigUnits: 0, productCost: 0, shippingCost: 0, total: 0 }
    );
  }, [dailyBreakdown]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && !costSheet) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw size={24} className="text-blue-500 animate-spin" />
          <span className="text-[#888] text-sm">Loading supplier cost sheet...</span>
        </div>
      </div>
    );
  }

  if (error && !costSheet) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className={`${cardStyle} max-w-md text-center`}>
          <AlertTriangle size={32} className="text-red-500 mx-auto mb-3" />
          <div className="text-white font-medium mb-2">Failed to load cost sheet</div>
          <div className="text-[#888] text-sm mb-4">{error}</div>
          <button onClick={fetchData} className={`${btnBase} ${btnActive}`}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">

        {/* ── Header Bar ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 mr-auto">
            <div className="w-9 h-9 bg-orange-500/10 rounded-lg flex items-center justify-center">
              <Package size={18} className="text-orange-400" />
            </div>
            <h1 className="text-xl font-semibold text-white">Supplier Cost Sheet</h1>
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

          {/* Export button */}
          <button
            onClick={handleExport}
            className={`${btnBase} bg-white/[0.04] border-white/[0.08] text-white hover:border-white/20 flex items-center gap-2`}
          >
            <Download size={14} />
            Export CSV
          </button>

          {/* Share Link button */}
          <button
            onClick={handleShareLink}
            className={`${btnBase} ${copied ? 'bg-green-600 border-green-500 text-white' : 'bg-white/[0.04] border-white/[0.08] text-white hover:border-white/20'} flex items-center gap-2`}
          >
            <Link2 size={14} />
            {copied ? 'Copied!' : 'Share Link'}
          </button>
        </div>

        {/* Inline error banner */}
        {error && costSheet && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {/* ── Summary Cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SummaryCard
            icon={Package}
            label="Total COGS"
            value={fmtMoney(totalCogs)}
            change={cogsChange}
            accentColor="bg-red-500/10"
          />
          <SummaryCard
            icon={Truck}
            label="Total Shipping"
            value={fmtMoney(totalShipping)}
            change={shippingChange}
            accentColor="bg-orange-500/10"
          />
          <SummaryCard
            icon={DollarSign}
            label="Grand Total"
            value={fmtMoney(grandTotal)}
            change={totalChange}
            accentColor="bg-blue-500/10"
          />
        </div>

        {/* ── Daily Breakdown Table ────────────────────────────────────────── */}
        {dailyBreakdown.length > 0 && (
          <div className={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
              <Package size={16} className="text-blue-400" />
              <h2 className="text-sm font-medium text-white">Daily Breakdown</h2>
              <span className="text-xs text-[#555] ml-auto">{dailyBreakdown.length} days</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Date</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Orders</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">MR Units</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">RIG Units</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Product Cost</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Shipping Cost</th>
                    <th className="text-left text-xs text-[#888] font-medium px-3 py-3">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyBreakdown.map((row, i) => {
                    const rowDate = row.date || row.day || '';
                    const rowProductCost = Number(row.productCost || row.cogs || 0);
                    const rowShippingCost = Number(row.shippingCost || row.shipping || 0);
                    const rowTotal = Number(row.total || 0) || rowProductCost + rowShippingCost;
                    return (
                      <tr
                        key={rowDate || i}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors cursor-pointer"
                        onClick={() => toggleDay(rowDate)}
                      >
                        <td className="px-3 py-3 text-white text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            {expandedDays[rowDate] ? <ChevronDown size={12} className="text-[#555]" /> : <ChevronRight size={12} className="text-[#555]" />}
                            {rowDate ? new Date(rowDate + 'T00:00:00').toLocaleDateString() : '-'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.orders || row.orderCount)}</td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.mrUnits || row.miners)}</td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.rigUnits || row.rigs)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(rowProductCost)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(rowShippingCost)}</td>
                        <td className="px-3 py-3 text-white font-medium">{fmtMoney(rowTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {dailyTotals && (
                  <tfoot>
                    <tr className="border-t border-white/[0.08] bg-white/[0.02]">
                      <td className="px-3 py-3 text-white text-xs font-semibold">Total</td>
                      <td className="px-3 py-3 text-white font-semibold">{fmtInt(dailyTotals.orders)}</td>
                      <td className="px-3 py-3 text-white font-semibold">{fmtInt(dailyTotals.mrUnits)}</td>
                      <td className="px-3 py-3 text-white font-semibold">{fmtInt(dailyTotals.rigUnits)}</td>
                      <td className="px-3 py-3 text-white font-semibold">{fmtMoney(dailyTotals.productCost)}</td>
                      <td className="px-3 py-3 text-white font-semibold">{fmtMoney(dailyTotals.shippingCost)}</td>
                      <td className="px-3 py-3 text-white font-bold">{fmtMoney(dailyTotals.total)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}

        {/* ── Order Detail Table ───────────────────────────────────────────── */}
        <div className={cardStyle}>
          <div className="flex items-center gap-2 mb-4">
            <Truck size={16} className="text-orange-400" />
            <h2 className="text-sm font-medium text-white">Order Details</h2>
            <span className="text-xs text-[#555] ml-auto">{sortedOrders.length} orders</span>
          </div>
          {sortedOrders.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <SortHeader label="Order #" field="orderNumber" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Date" field="date" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Item" field="item" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Qty" field="quantity" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Country" field="country" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Product Cost" field="cogs" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Shipping Cost" field="shipping" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                    <SortHeader label="Total Cost" field="totalCost" sortField={orderSort.field} sortDir={orderSort.dir} onSort={handleOrderSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedOrders.map((row, i) => {
                    const rowCogs = Number(row.cogs || row.productCost || 0);
                    const rowShip = Number(row.shipping || row.shippingCost || 0);
                    const rowTotal = Number(row.totalCost || 0) || rowCogs + rowShip;
                    return (
                      <tr
                        key={row.orderNumber || row.orderId || i}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-3 py-3 text-white text-xs font-mono">#{row.orderNumber || row.orderId || '-'}</td>
                        <td className="px-3 py-3 text-white text-xs">
                          {row.date ? new Date(row.date).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-3 py-3 text-white text-xs">
                          {row.item || row.productName || row.title || row.sku || '-'}
                        </td>
                        <td className="px-3 py-3 text-white">{fmtInt(row.quantity || row.qty || (Number(row.miners || 0) + Number(row.rigs || 0)))}</td>
                        <td className="px-3 py-3 text-[#888] text-xs">{row.country || '-'}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(rowCogs)}</td>
                        <td className="px-3 py-3 text-[#888]">{fmtMoney(rowShip)}</td>
                        <td className="px-3 py-3 text-white font-medium">{fmtMoney(rowTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-white/[0.08] bg-white/[0.02]">
                    <td colSpan={5} className="px-3 py-3 text-white text-xs font-semibold">Total</td>
                    <td className="px-3 py-3 text-white font-semibold">
                      {fmtMoney(sortedOrders.reduce((s, r) => s + Number(r.cogs || r.productCost || 0), 0))}
                    </td>
                    <td className="px-3 py-3 text-white font-semibold">
                      {fmtMoney(sortedOrders.reduce((s, r) => s + Number(r.shipping || r.shippingCost || 0), 0))}
                    </td>
                    <td className="px-3 py-3 text-white font-bold">
                      {fmtMoney(
                        sortedOrders.reduce((s, r) => {
                          const c = Number(r.cogs || r.productCost || 0);
                          const sh = Number(r.shipping || r.shippingCost || 0);
                          return s + (Number(r.totalCost || 0) || c + sh);
                        }, 0)
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-[#555] text-sm">No order data for this period</div>
          )}
        </div>

      </div>
    </div>
  );
}
