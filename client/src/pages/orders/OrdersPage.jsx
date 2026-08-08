import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Columns3,
  Download,
  Search,
  ShoppingCart,
  ChevronLeft,
  ChevronRight,
  ShoppingBag,
  X,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';

// ── formatting helpers ──────────────────────────────────────────────

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

const AVATAR_COLORS = [
  'bg-rose-500/20 text-rose-400',
  'bg-amber-500/20 text-amber-400',
  'bg-emerald-500/20 text-emerald-400',
  'bg-sky-500/20 text-sky-400',
  'bg-violet-500/20 text-violet-400',
  'bg-pink-500/20 text-pink-400',
];

export function customerName(o) {
  const name = [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ');
  return name || o.customer_email || '—';
}

export function CustomerAvatar({ order }) {
  const label = customerName(order);
  const initials = label
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  const color =
    AVATAR_COLORS[
      (label.charCodeAt(0) + (label.charCodeAt(1) || 0)) % AVATAR_COLORS.length
    ];
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold shrink-0 ${color}`}
    >
      {initials || '?'}
    </span>
  );
}

export function StatusPill({ kind, value }) {
  if (!value && kind === 'fulfillment') value = 'unfulfilled';
  if (!value) return <span className="text-text-faint">—</span>;
  const v = String(value).toLowerCase();
  let cls = 'bg-bg-elevated text-text-muted border-border-default';
  if (['paid', 'fulfilled', 'delivered'].includes(v))
    cls = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  else if (['unfulfilled', 'pending', 'partially_paid', 'in_transit'].includes(v))
    cls = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  else if (['refunded', 'partially_refunded', 'voided', 'cancelled'].includes(v))
    cls = 'bg-red-500/10 text-red-400 border-red-500/20';
  const label = v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${cls}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

function funnelLabel(o) {
  if (!o.funnel_name && !o.funnel_source) return null;
  return [o.funnel_name, o.funnel_source].filter(Boolean).join(' · ');
}

// ── KPI strip ───────────────────────────────────────────────────────

function KpiStrip({ stats }) {
  const cells = [
    { label: 'Orders', value: stats ? String(stats.orders_today || '—') : '—' },
    { label: 'Items ordered', value: stats ? String(stats.items_today || '—') : '—' },
    { label: 'Returns', value: money(stats?.returns_today ?? 0) },
    { label: 'Revenue today', value: money(stats?.revenue_today ?? 0) },
    {
      label: 'Shopify orders',
      value: stats && stats.shopify_orders_today ? String(stats.shopify_orders_today) : '—',
    },
    {
      label: 'Avg fulfillment',
      value:
        stats?.avg_fulfillment_hours != null
          ? `${Number(stats.avg_fulfillment_hours).toFixed(1)}h`
          : '—',
    },
  ];
  return (
    <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-5 border-r border-border-subtle shrink-0">
        <ShoppingCart className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">Today</span>
      </div>
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={`flex-1 px-5 py-3.5 min-w-0 ${i > 0 ? 'border-l border-border-subtle' : ''}`}
        >
          <div className="text-[11px] uppercase tracking-wider text-text-faint truncate">
            {c.label}
          </div>
          <div className="mt-1 text-xl font-semibold text-text-primary truncate">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────

const FILTER_DEFS = [
  {
    key: 'payment',
    label: 'Payment',
    options: ['paid', 'pending', 'partially_paid', 'refunded', 'partially_refunded', 'voided'],
  },
  { key: 'fulfillment', label: 'Fulfillment', options: ['unfulfilled', 'fulfilled', 'partial'] },
  { key: 'gateway', label: 'Gateway', options: ['Whop', 'Stripe', 'PayPal', 'shopify_payments'] },
];

export default function OrdersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [filters, setFilters] = useState({});
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const debounceRef = useRef(null);
  const filterMenuRef = useRef(null);

  const queryParams = useMemo(() => {
    const p = { page, limit: 25 };
    if (q) p.q = q;
    if (showArchived) p.archived = 'true';
    for (const [k, v] of Object.entries(filters)) if (v) p[k] = v;
    return p;
  }, [page, q, showArchived, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/orders', { params: queryParams });
      const d = res.data?.data || {};
      setOrders(d.orders || []);
      setTotal(d.total || 0);
      setPages(d.pages || 1);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load orders');
      setOrders([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [queryParams]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get('/orders/stats/today')
      .then((res) => setStats(res.data?.data || null))
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    const close = (e) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target))
        setFilterMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const onSearch = (value) => {
    setQ(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set('q', value);
      else next.delete('q');
      next.set('page', '1');
      setSearchParams(next, { replace: true });
    }, 300);
  };

  const goToPage = (p) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(p));
    setSearchParams(next);
  };

  const exportCsv = async () => {
    try {
      const res = await api.get('/orders/export', {
        params: queryParams,
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'orders.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Export failed');
    }
  };

  const activeFilters = Object.entries(filters).filter(([, v]) => v);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Orders</h1>
          <p className="mt-1 text-sm text-text-muted">
            Every order placed through your funnels, across all gateways.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="primary"
            size="md"
            title="Manual order creation arrives with the checkout phase"
            onClick={() => {}}
          >
            <Plus className="w-4 h-4" /> Create order
          </Button>
          <Button variant="secondary" size="md" title="Column settings coming soon">
            <Columns3 className="w-4 h-4" /> Columns
          </Button>
          <Button variant="secondary" size="md" onClick={exportCsv}>
            <Download className="w-4 h-4" /> Export
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {[
          { value: 'orders', label: 'Orders' },
          { value: 'subscriptions', label: 'Subscriptions' },
        ].map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer ${
              tab === t.value
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'subscriptions' ? (
        <div className="bg-bg-card border border-border-default rounded-xl p-12 text-center text-text-muted text-sm">
          No subscriptions yet. Recurring plans will appear here once subscription checkout is
          live.
        </div>
      ) : (
        <>
          <KpiStrip stats={stats} />

          {/* Search + filter bar */}
          <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3">
            <span className="px-2.5 py-1 text-sm font-medium text-text-primary border-b-2 border-accent">
              All
            </span>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Search className="w-4 h-4 text-text-faint shrink-0" />
              <input
                value={q}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search and filter..."
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
              />
            </div>
            {activeFilters.map(([k, v]) => (
              <button
                key={k}
                onClick={() => setFilters((f) => ({ ...f, [k]: '' }))}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-accent-muted text-accent-text border border-accent/20 cursor-pointer"
              >
                {k}: {v.replace(/_/g, ' ')} <X className="w-3 h-3" />
              </button>
            ))}
            <div className="relative shrink-0" ref={filterMenuRef}>
              <button
                onClick={() => setFilterMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-text-muted hover:text-text-primary border border-dashed border-border-strong rounded-lg cursor-pointer transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add filter
              </button>
              {filterMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-bg-elevated border border-border-default rounded-lg shadow-xl z-20 p-3 space-y-3">
                  {FILTER_DEFS.map((def) => (
                    <div key={def.key}>
                      <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">
                        {def.label}
                      </div>
                      <select
                        value={filters[def.key] || ''}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, [def.key]: e.target.value }))
                        }
                        className="w-full px-2 py-1.5 text-sm bg-bg-card border border-border-default rounded-md text-text-primary focus:outline-none cursor-pointer"
                      >
                        <option value="">Any</option>
                        {def.options.map((o) => (
                          <option key={o} value={o}>
                            {o.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setShowArchived((s) => !s)}
              className={`text-sm shrink-0 cursor-pointer transition-colors ${
                showArchived ? 'text-accent-text' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          </div>

          {/* Table */}
          <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                    <th className="text-left font-medium px-4 py-3">Order</th>
                    <th className="text-left font-medium px-4 py-3">Date</th>
                    <th className="text-left font-medium px-4 py-3">Customer</th>
                    <th className="text-left font-medium px-4 py-3">Funnel</th>
                    <th className="text-right font-medium px-4 py-3">Total</th>
                    <th className="text-left font-medium px-4 py-3">Payment</th>
                    <th className="text-left font-medium px-4 py-3">Fulfillment</th>
                    <th className="text-left font-medium px-4 py-3">Delivery</th>
                    <th className="text-right font-medium px-4 py-3">Items</th>
                    <th className="text-left font-medium px-4 py-3">Destination</th>
                    <th className="text-left font-medium px-4 py-3">Gateway</th>
                    <th className="text-left font-medium px-4 py-3">Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-16 text-center text-text-muted">
                        Loading orders...
                      </td>
                    </tr>
                  ) : error ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-16 text-center text-danger">
                        {error}
                      </td>
                    </tr>
                  ) : orders.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-16 text-center text-text-muted">
                        No orders yet. Connect your Shopify store and orders will appear here.
                      </td>
                    </tr>
                  ) : (
                    orders.map((o) => (
                      <tr
                        key={o.order_id}
                        onClick={() => navigate(`/app/orders/${o.order_id}`)}
                        className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-3 font-medium text-text-primary whitespace-nowrap">
                          {o.order_number || o.order_id}
                        </td>
                        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                          {fmtDate(o.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-2 min-w-0">
                            <CustomerAvatar order={o} />
                            <span className="text-text-primary truncate max-w-[180px]">
                              {customerName(o)}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {funnelLabel(o) ? (
                            <span className="inline-flex items-center gap-1.5 text-text-primary">
                              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                              {funnelLabel(o)}
                            </span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-text-primary whitespace-nowrap">
                          {money(o.total_price)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill kind="payment" value={o.financial_status} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill kind="fulfillment" value={o.fulfillment_status} />
                        </td>
                        <td className="px-4 py-3">
                          {o.delivery_status ? (
                            <StatusPill kind="delivery" value={o.delivery_status} />
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-text-muted">{o.item_count}</td>
                        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                          {[o.destination_city, o.destination_state, o.destination_country]
                            .filter(Boolean)
                            .join(', ') || '—'}
                        </td>
                        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                          {o.gateway || '—'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {o.shopify_order_id ? (
                            <span className="inline-flex items-center gap-1.5 text-emerald-400">
                              <ShoppingBag className="w-3.5 h-3.5" />
                              <span className="text-xs">
                                {String(o.shopify_order_id).slice(-6)}
                              </span>
                            </span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
              <span className="text-sm text-text-muted">
                {total} order{total === 1 ? '' : 's'}
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" /> Previous
                </button>
                <button
                  disabled={page >= pages}
                  onClick={() => goToPage(page + 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
