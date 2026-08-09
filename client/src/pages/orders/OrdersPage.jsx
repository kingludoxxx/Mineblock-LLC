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
  ArrowUp,
  ArrowDown,
  X,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import SavedViewsBar from './SavedViewsBar';
import CreateOrderModal from './CreateOrderModal';
import NeedsReviewPanel from './NeedsReviewPanel';

// ── formatting helpers ──────────────────────────────────────────────

// Intl THROWS on a currency code it does not recognize, which would take the
// whole table down over one bad row. Fall back to a plain "<CODE> <amount>"
// rather than rendering nothing.
const money = (v, cur = 'USD') => {
  if (v == null) return '—';
  try {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: cur || 'USD' });
  } catch {
    return `${cur || ''} ${Number(v).toFixed(2)}`.trim();
  }
};

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

// ── sortable header ─────────────────────────────────────────────────
// The entry point for the `sort` a saved view stores. Without it the sort was
// reachable only by hand-editing a URL, so a view could carry a sort the
// operator had no way to have chosen. Only the server's whitelisted columns
// get a header — an unlisted one would silently fall back to the default.
function SortableTh({ col, sort, onSort, align = 'left', children }) {
  const [activeCol, activeDir] = String(sort || '').split(':');
  const active = activeCol === col;
  const Icon = active && activeDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`text-${align} font-medium px-4 py-3`}>
      <button
        onClick={() => onSort(col)}
        title={`Sort by ${col.replace(/_/g, ' ')}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider cursor-pointer transition-colors ${
          active ? 'text-text-primary' : 'hover:text-text-primary'
        }`}
      >
        {children}
        <Icon className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}`} />
      </button>
    </th>
  );
}

// ── KPI strip ───────────────────────────────────────────────────────

function KpiStrip({ stats }) {
  const cells = [
    { label: 'Orders', value: stats ? String(stats.orders_today || '—') : '—' },
    { label: 'Items ordered', value: stats ? String(stats.items_today || '—') : '—' },
    { label: 'Returns', value: money(stats?.returns_today ?? 0) },
    // Gateway revenue. Manual orders get their own cell, only when there are
    // any — an always-on "Manual $0.00" would be noise, but silently folding
    // them into revenue would be a lie.
    { label: 'Revenue today', value: money(stats?.revenue_today ?? 0) },
    ...(Number(stats?.manual_revenue_today) > 0
      ? [
          {
            label: `Manual (${stats.manual_orders_today})`,
            value: money(stats.manual_revenue_today),
          },
        ]
      : []),
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
  { key: 'source', label: 'Source', options: ['shopify', 'manual'] },
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
  const [sort, setSort] = useState('created_at:desc');
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [flash, setFlash] = useState(null);
  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const debounceRef = useRef(null);
  const filterMenuRef = useRef(null);

  const queryParams = useMemo(() => {
    const p = { page, limit: 25, sort };
    if (q) p.q = q;
    if (showArchived) p.archived = 'true';
    for (const [k, v] of Object.entries(filters)) if (v) p[k] = v;
    return p;
  }, [page, q, showArchived, filters, sort]);

  // The filter set a saved view stores. It is deliberately NOT queryParams:
  // page and limit are pagination, not a preset, and baking page:3 into a
  // saved view would strand the operator on a page that may not exist tomorrow.
  const viewFilters = useMemo(() => {
    const f = {};
    if (q) f.q = q;
    if (showArchived) f.archived = 'true';
    for (const [k, v] of Object.entries(filters)) if (v) f[k] = v;
    return f;
  }, [q, showArchived, filters]);

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

  // ── saved views ───────────────────────────────────────────────────
  const loadViews = useCallback(async () => {
    try {
      const res = await api.get('/orders/views');
      setViews(res.data?.data?.views || []);
    } catch {
      // Views are a convenience layer; the list works without them. Failing
      // loudly here would block a working orders page over a missing preset.
      setViews([]);
    }
  }, []);

  useEffect(() => {
    loadViews();
  }, [loadViews]);

  // Applying a view REPLACES the filter state wholesale rather than merging.
  // A merge would leave filters from the previous view silently active, so the
  // rows on screen would not be the rows the view actually names.
  const applyView = (view) => {
    const f = view?.filters || {};
    setActiveViewId(view?.id ?? null);
    setSort(view?.sort || 'created_at:desc');
    setShowArchived(f.archived === 'true');
    setFilters({
      payment: f.payment || '',
      fulfillment: f.fulfillment || '',
      gateway: f.gateway || '',
      source: f.source || '',
    });
    setQ(f.q || '');
    const next = new URLSearchParams(searchParams);
    if (f.q) next.set('q', f.q);
    else next.delete('q');
    next.set('page', '1');
    setSearchParams(next, { replace: true });
  };

  const createView = async (name) => {
    setViewBusy(true);
    try {
      const res = await api.post('/orders/views', { name, filters: viewFilters, sort });
      const view = res.data?.data?.view;
      await loadViews();
      if (view) setActiveViewId(view.id);
    } finally {
      setViewBusy(false);
    }
  };

  const updateView = async (view) => {
    setViewBusy(true);
    try {
      await api.put(`/orders/views/${view.id}`, { filters: viewFilters, sort });
      await loadViews();
      setFlash(`Saved “${view.name}”`);
    } catch (err) {
      setFlash(err.response?.data?.error || 'Could not update this view');
    } finally {
      setViewBusy(false);
    }
  };

  const deleteView = async (view) => {
    setViewBusy(true);
    try {
      await api.delete(`/orders/views/${view.id}`);
      await loadViews();
      if (activeViewId === view.id) applyView(null);
    } catch (err) {
      setFlash(err.response?.data?.error || 'Could not delete this view');
    } finally {
      setViewBusy(false);
    }
  };

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

  // Click a header: sort by it descending; click the same header again to flip
  // to ascending. Always resets to page 1 — staying on page 4 of a re-sorted
  // list shows rows that have nothing to do with what was just clicked.
  const toggleSort = (col) => {
    const [activeCol, activeDir] = sort.split(':');
    setSort(activeCol === col && activeDir === 'desc' ? `${col}:asc` : `${col}:desc`);
    const next = new URLSearchParams(searchParams);
    next.set('page', '1');
    setSearchParams(next, { replace: true });
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
    <div className="p-6 space-y-5">
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
            title="Record an order taken outside a funnel checkout — no payment is charged"
            onClick={() => setCreateOpen(true)}
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
          { value: 'needs-review', label: 'Needs review' },
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

      {tab === 'needs-review' ? (
        <NeedsReviewPanel />
      ) : tab === 'subscriptions' ? (
        <>
          <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
            {['Active subscriptions', 'MRR', 'Churn (30d)', 'Next 7 days charges'].map((label, i) => (
              <div key={label} className={`flex-1 px-5 py-3.5 min-w-0 ${i > 0 ? 'border-l border-border-subtle' : ''}`}>
                <div className="text-[11px] uppercase tracking-wider text-text-faint truncate">{label}</div>
                <div className="mt-1 text-xl font-semibold text-text-primary">—</div>
              </div>
            ))}
          </div>
          <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                  <th className="text-left font-medium px-4 py-3">Subscription</th>
                  <th className="text-left font-medium px-4 py-3">Customer</th>
                  <th className="text-left font-medium px-4 py-3">Plan</th>
                  <th className="text-right font-medium px-4 py-3">Amount</th>
                  <th className="text-left font-medium px-4 py-3">Status</th>
                  <th className="text-left font-medium px-4 py-3">Next charge</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-text-muted">
                    No subscriptions yet. Recurring plans will appear here once subscription
                    checkout is live.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <KpiStrip stats={stats} />

          {/* Saved views */}
          <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2">
            <SavedViewsBar
              views={views}
              activeViewId={activeViewId}
              filters={viewFilters}
              sort={sort}
              onApply={applyView}
              onCreate={createView}
              onUpdate={updateView}
              onDelete={deleteView}
              busy={viewBusy}
            />
          </div>

          {flash && (
            <div className="flex items-center justify-between px-4 py-2 text-sm text-text-muted bg-bg-elevated border border-border-default rounded-lg">
              <span>{flash}</span>
              <button
                onClick={() => setFlash(null)}
                className="p-0.5 rounded text-text-faint hover:text-text-primary cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Search + filter bar */}
          <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3">
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
                    <SortableTh col="order_number" sort={sort} onSort={toggleSort}>Order</SortableTh>
                    <SortableTh col="created_at" sort={sort} onSort={toggleSort}>Date</SortableTh>
                    <th className="text-left font-medium px-4 py-3">Customer</th>
                    <th className="text-left font-medium px-4 py-3">Funnel</th>
                    <SortableTh col="total_price" sort={sort} onSort={toggleSort} align="right">Total</SortableTh>
                    <SortableTh col="financial_status" sort={sort} onSort={toggleSort}>Payment</SortableTh>
                    <SortableTh col="fulfillment_status" sort={sort} onSort={toggleSort}>Fulfillment</SortableTh>
                    <th className="text-left font-medium px-4 py-3">Delivery</th>
                    <SortableTh col="item_count" sort={sort} onSort={toggleSort} align="right">Items</SortableTh>
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
                          {o.source === 'manual' && (
                            <span
                              title="Recorded by an operator — no payment was taken through a gateway"
                              className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-bg-elevated border border-border-default text-text-muted align-middle"
                            >
                              Manual
                            </span>
                          )}
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

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(order) => {
          // Quote the SERVER's stored total, not the modal's preview. The
          // server is what rounds, applies caps and recomputes from validated
          // line items — confirming the client's arithmetic would tell the
          // operator what they typed, not what was recorded.
          setFlash(
            order
              ? `Recorded ${order.order_number} for ${money(order.total_price, order.currency)} — bookkeeping only, no payment was taken.`
              : 'Order recorded.'
          );
          load();
        }}
      />
    </div>
  );
}
