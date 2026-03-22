import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../services/api';
import {
  FileText,
  DollarSign,
  Truck,
  Package,
  RefreshCw,
  Download,
  Link2,
  AlertTriangle,
  ShoppingCart,
} from 'lucide-react';
import DatePicker from '../../components/ui/DatePicker';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtInt = (n) => Number(n || 0).toLocaleString();

const todayStr = () => new Date().toISOString().slice(0, 10);

const cardStyle = 'bg-[#111] border border-white/[0.06] rounded-xl p-5';

const btnBase =
  'px-3 py-2 text-sm rounded-lg border transition-colors focus:outline-none cursor-pointer';

const btnActive = 'bg-blue-600 border-blue-500 text-white';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format a date string like "March 21, 2026" */
function fmtDayHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Format a date string like "03/21 22:55" */
function fmtDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

/**
 * Expand order-level data into individual line items.
 * Each order can produce 1-2 rows: one for miners, one for rigs.
 */
function expandOrderLines(order) {
  const lines = [];
  const miners = Number(order.miners || order.totalMiners || 0);
  const rigs = Number(order.rigs || order.totalRigs || 0);
  const totalCogs = Number(order.cogs || order.productCost || 0);
  const totalShipping = Number(order.shipping || order.shippingCost || 0);

  // Determine SKU based on miner count
  const minerSku = miners <= 1 ? 'MR-01' : miners === 2 ? 'MR-02' : miners === 4 ? 'MR-04' : miners === 5 ? 'MR-05' : miners === 8 ? 'MR-08' : miners === 16 ? 'MR-16' : `MR-${String(miners).padStart(2, '0')}`;
  const rigSku = rigs <= 1 ? 'RIG-1' : rigs === 2 ? 'RIG-2' : 'RIG-4';

  // Use known unit costs to split COGS properly (not ratio-based)
  const MINER_UNIT_COST = 10.92; // current quote
  const RIG_COSTS = { 1: 1.96, 2: 2.91, 4: 3.87 };
  const rigUnitCost = RIG_COSTS[rigs] || RIG_COSTS[4] || 3.87;

  if (miners > 0) {
    const minerCogs = miners * MINER_UNIT_COST;
    const minerShip = rigs > 0 ? totalShipping - (totalCogs - minerCogs > 0 ? totalShipping * (totalCogs - minerCogs) / totalCogs : 0) : totalShipping;
    // Simpler: use actual COGS minus rig cost for miner cost, and proportional shipping
    const actualMinerCogs = rigs > 0 ? totalCogs - rigUnitCost * (order.rigQty || 1) : totalCogs;
    const actualMinerShip = totalCogs > 0 && rigs > 0 ? totalShipping * (actualMinerCogs / totalCogs) : totalShipping;
    lines.push({
      orderNumber: order.orderNumber || order.orderId,
      date: order.date,
      item: `Miner Forge PRO 2.0 (${minerSku})`,
      itemName: 'Miner Forge PRO 2.0',
      sku: minerSku,
      qty: miners,
      country: order.country || '',
      cost: rigs > 0 ? Math.round(actualMinerCogs * 100) / 100 : totalCogs,
      shipping: rigs > 0 ? Math.round(actualMinerShip * 100) / 100 : totalShipping,
      total: rigs > 0 ? Math.round((actualMinerCogs + actualMinerShip) * 100) / 100 : totalCogs + totalShipping,
      isFirstLine: true,
    });
  }

  if (rigs > 0) {
    const actualRigCogs = miners > 0 ? totalCogs - (miners * MINER_UNIT_COST) : totalCogs;
    const actualRigShip = totalCogs > 0 && miners > 0 ? totalShipping * (Math.max(0, actualRigCogs) / totalCogs) : totalShipping;
    lines.push({
      orderNumber: order.orderNumber || order.orderId,
      date: order.date,
      item: `Mining Rig (${rigSku})`,
      itemName: 'Mining Rig',
      sku: rigSku,
      qty: rigs,
      country: miners > 0 ? '' : (order.country || ''),
      cost: miners > 0 ? Math.round(Math.max(0, actualRigCogs) * 100) / 100 : totalCogs,
      shipping: miners > 0 ? Math.round(Math.max(0, actualRigShip) * 100) / 100 : totalShipping,
      total: miners > 0 ? Math.round((Math.max(0, actualRigCogs) + Math.max(0, actualRigShip)) * 100) / 100 : totalCogs + totalShipping,
      isFirstLine: miners === 0,
    });
  }

  // Fallback: if neither miners nor rigs but has cost data, show as Miner Forge PRO
  if (lines.length === 0 && totalCogs > 0) {
    lines.push({
      orderNumber: order.orderNumber || order.orderId,
      date: order.date,
      item: 'Miner Forge PRO 2.0',
      itemName: 'Miner Forge PRO 2.0',
      sku: 'MR',
      qty: Math.round(totalCogs / MINER_UNIT_COST) || 1,
      country: order.country || '',
      cost: totalCogs,
      shipping: totalShipping,
      total: totalCogs + totalShipping,
      isFirstLine: true,
    });
  }

  return lines;
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function SupplierCostSheet() {
  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayStr());
  const [costSheet, setCostSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/kpi-system/cost-sheet', { params: { period, date } });
      setCostSheet(res.data?.data || res.data || {});
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

  const handleShareLink = async () => {
    // Fetch the share token from the API
    let token = '';
    try {
      const res = await api.get('/kpi-system/share-token');
      token = res.data?.token || res.data?.data?.token || '';
    } catch { token = ''; }
    if (!token) { alert('Share token not configured. Set SUPPLIER_SHARE_TOKEN in environment.'); return; }
    const shareUrl = `${window.location.origin}/supplier/cost-sheet?token=${token}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Derived Data ───────────────────────────────────────────────────────────

  const costData = costSheet || {};
  const costSummary = costData.summary || {};
  const orders = costData.orders || costData.rows || [];

  const totalCogs = Number(costSummary.totalCogs || 0) ||
    orders.reduce((s, o) => s + Number(o.cogs || o.productCost || 0), 0);
  const totalShipping = Number(costSummary.totalShipping || 0) ||
    orders.reduce((s, o) => s + Number(o.shipping || o.shippingCost || 0), 0);
  const grandTotal = totalCogs + totalShipping;
  const totalOrders = Number(costSummary.totalOrders || costSummary.orders || 0) || orders.length;

  // Group orders by day (descending)
  const dayGroups = useMemo(() => {
    const groups = {};
    for (const order of orders) {
      const dayKey = (order.date || '').slice(0, 10);
      if (!groups[dayKey]) groups[dayKey] = [];
      groups[dayKey].push(order);
    }
    // Sort days descending
    const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    return sortedKeys.map((dayKey) => {
      const dayOrders = groups[dayKey].sort((a, b) => {
        // Sort orders within day by date descending (newest first)
        return new Date(b.date) - new Date(a.date);
      });

      // Expand all orders into line items
      const lines = dayOrders.flatMap(expandOrderLines);

      // Daily totals
      const dailyCogs = dayOrders.reduce((s, o) => s + Number(o.cogs || o.productCost || 0), 0);
      const dailyShip = dayOrders.reduce((s, o) => s + Number(o.shipping || o.shippingCost || 0), 0);

      return {
        dayKey,
        label: dayKey ? fmtDayHeader(dayKey) : 'Unknown Date',
        orders: dayOrders,
        lines,
        orderCount: dayOrders.length,
        productCost: dailyCogs,
        shippingCost: dailyShip,
        total: dailyCogs + dailyShip,
      };
    });
  }, [orders]);

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
            <div className="w-9 h-9 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <FileText size={18} className="text-blue-400" />
            </div>
            <h1 className="text-xl font-semibold text-white">Supplier Cost Sheet</h1>
          </div>

          {/* Date picker (primary widget) */}
          <DatePicker value={date} onChange={setDate} period={period} />

          {/* Period toggle */}
          <div className="flex gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
            {[
              { key: 'daily', label: 'Day' },
              { key: 'weekly', label: 'Week' },
              { key: 'monthly', label: 'Month' },
            ].map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors cursor-pointer ${
                  period === p.key ? 'bg-blue-600 text-white' : 'text-[#888] hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

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

        {/* ── Grand Total Card ────────────────────────────────────────────── */}
        <div className={`${cardStyle} !p-6`}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-500/10">
              <DollarSign size={16} className="text-blue-400" />
            </div>
            <span className="text-[#888] text-sm">Total Owed to Supplier</span>
          </div>
          <div className="text-4xl font-bold text-white font-mono mb-4">
            {fmtMoney(grandTotal)}
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Package size={14} className="text-red-400" />
              <span className="text-[#888]">Product Cost:</span>
              <span className="text-white font-mono font-medium">{fmtMoney(totalCogs)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Truck size={14} className="text-orange-400" />
              <span className="text-[#888]">Shipping Cost:</span>
              <span className="text-white font-mono font-medium">{fmtMoney(totalShipping)}</span>
            </div>
            <div className="flex items-center gap-2">
              <ShoppingCart size={14} className="text-blue-400" />
              <span className="text-[#888]">Orders:</span>
              <span className="text-white font-mono font-medium">{fmtInt(totalOrders)}</span>
            </div>
          </div>
        </div>

        {/* ── Invoice Table ────────────────────────────────────────────────── */}
        <div className={`${cardStyle} !p-0 overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              {/* Column headers (sticky-ish) */}
              <thead>
                <tr className="bg-[#111] border-b border-white/[0.08]">
                  <th className="text-left text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[100px]">Order #</th>
                  <th className="text-left text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[120px]">Date/Time</th>
                  <th className="text-left text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap">Item</th>
                  <th className="text-left text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[80px]">SKU</th>
                  <th className="text-right text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[60px]">Qty</th>
                  <th className="text-left text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[140px]">Country</th>
                  <th className="text-right text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[110px]">Cost</th>
                  <th className="text-right text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[110px]">Shipping</th>
                  <th className="text-right text-xs text-[#888] font-medium px-4 py-3 whitespace-nowrap w-[110px]">Total</th>
                </tr>
              </thead>
              <tbody>
                {dayGroups.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-center py-12 text-[#555] text-sm">
                      No order data for this period
                    </td>
                  </tr>
                )}

                {dayGroups.map((group) => (
                  <DayGroup key={group.dayKey} group={group} />
                ))}

                {/* ── Grand Total Row ──────────────────────────────────────── */}
                {dayGroups.length > 0 && (
                  <tr className="bg-blue-500/10 border-t-2 border-blue-500/30">
                    <td colSpan={6} className="px-4 py-4 text-blue-400 font-bold text-sm">
                      Grand Total: {fmtInt(totalOrders)} orders
                    </td>
                    <td className="text-right px-4 py-4 text-blue-400 font-bold font-mono text-sm">
                      {fmtMoney(totalCogs)}
                    </td>
                    <td className="text-right px-4 py-4 text-blue-400 font-bold font-mono text-sm">
                      {fmtMoney(totalShipping)}
                    </td>
                    <td className="text-right px-4 py-4 text-blue-300 font-bold font-mono text-sm">
                      {fmtMoney(grandTotal)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Day Group Sub-component ──────────────────────────────────────────────────

function DayGroup({ group }) {
  return (
    <>
      {/* Day header row */}
      <tr className="bg-[#1a1a1a] border-t-2 border-white/[0.08] border-b border-white/[0.06]">
        <td colSpan={9} className="px-4 py-3">
          <span className="text-white font-bold text-sm">{group.label}</span>
        </td>
      </tr>

      {/* Order line items */}
      {group.lines.map((line, i) => (
        <tr
          key={`${group.dayKey}-${line.orderNumber}-${line.item}-${i}`}
          className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
        >
          {/* Order # — only show on first line of each order */}
          <td className="px-4 py-2.5 text-white font-mono text-xs">
            {line.isFirstLine ? `#${line.orderNumber || '-'}` : ''}
          </td>
          {/* Date/Time — only show on first line */}
          <td className="px-4 py-2.5 text-[#888] font-mono text-xs">
            {line.isFirstLine ? fmtDateTime(line.date) : ''}
          </td>
          {/* Item */}
          <td className="px-4 py-2.5 text-white text-xs">{line.itemName}</td>
          {/* SKU */}
          <td className="px-4 py-2.5 text-[#888] text-xs font-mono">{line.sku}</td>
          {/* Qty */}
          <td className="text-right px-4 py-2.5 text-white font-mono text-xs">{line.qty}</td>
          {/* Country */}
          <td className="px-4 py-2.5 text-[#888] text-xs">{line.country}</td>
          {/* Cost */}
          <td className="text-right px-4 py-2.5 text-[#888] font-mono text-xs">{fmtMoney(line.cost)}</td>
          {/* Shipping */}
          <td className="text-right px-4 py-2.5 text-[#888] font-mono text-xs">{fmtMoney(line.shipping)}</td>
          {/* Total */}
          <td className="text-right px-4 py-2.5 text-white font-mono font-medium text-xs">{fmtMoney(line.total)}</td>
        </tr>
      ))}

      {/* Daily total row */}
      <tr className="bg-[#0d1117] border-b border-white/[0.08]">
        <td colSpan={6} className="px-4 py-3 text-green-400 font-semibold text-xs">
          Daily Total: {fmtInt(group.orderCount)} orders
        </td>
        <td className="text-right px-4 py-3 text-green-400 font-semibold font-mono text-xs">
          {fmtMoney(group.productCost)}
        </td>
        <td className="text-right px-4 py-3 text-green-400 font-semibold font-mono text-xs">
          {fmtMoney(group.shippingCost)}
        </td>
        <td className="text-right px-4 py-3 text-green-300 font-bold font-mono text-xs">
          {fmtMoney(group.total)}
        </td>
      </tr>
    </>
  );
}
