import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, UsersRound, Download } from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { CustomerAvatar } from '../orders/OrdersPage';

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export function customerLabel(c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return name || c.customer_email || '—';
}

function KpiStrip({ stats }) {
  const cells = [
    { label: 'Customers', value: stats ? String(stats.total_customers) : '—' },
    { label: 'New today', value: stats ? String(stats.new_today) : '—' },
    { label: 'New (30d)', value: stats ? String(stats.new_30d) : '—' },
    { label: 'Repeat rate', value: stats ? `${stats.repeat_rate}%` : '—' },
    { label: 'Avg LTV', value: stats ? money(stats.avg_ltv) : '—' },
    { label: 'Lifetime revenue', value: stats ? money(stats.lifetime_revenue) : '—' },
  ];
  return (
    <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-5 border-r border-border-subtle shrink-0">
        <UsersRound className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">All time</span>
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

export default function CustomersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState(searchParams.get('q') || '');
  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const debounceRef = useRef(null);

  const queryParams = useMemo(() => {
    const p = { page, limit: 25, sort };
    if (q) p.q = q;
    return p;
  }, [page, q, sort]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/customers', { params: queryParams });
      const d = res.data?.data || {};
      setCustomers(d.customers || []);
      setTotal(d.total || 0);
      setPages(d.pages || 1);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load customers');
      setCustomers([]);
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
      .get('/customers/stats')
      .then((res) => setStats(res.data?.data || null))
      .catch(() => setStats(null));
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

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Customers</h1>
          <p className="mt-1 text-sm text-text-muted">
            Everyone who has bought from you, with lifetime value and history.
          </p>
        </div>
      </div>

      <KpiStrip stats={stats} />

      {/* Search + sort bar */}
      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Search className="w-4 h-4 text-text-faint shrink-0" />
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="px-2 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary focus:outline-none cursor-pointer shrink-0"
        >
          <option value="recent">Most recent order</option>
          <option value="total_spent">Highest spend</option>
          <option value="orders">Most orders</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                <th className="text-left font-medium px-4 py-3">Customer</th>
                <th className="text-left font-medium px-4 py-3">Email</th>
                <th className="text-left font-medium px-4 py-3">Location</th>
                <th className="text-right font-medium px-4 py-3">Orders</th>
                <th className="text-right font-medium px-4 py-3">Total spent</th>
                <th className="text-right font-medium px-4 py-3">Refunded</th>
                <th className="text-left font-medium px-4 py-3">First order</th>
                <th className="text-left font-medium px-4 py-3">Last order</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-text-muted">
                    Loading customers...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-danger">
                    {error}
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-text-muted">
                    No customers yet.
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr
                    key={c.customer_email}
                    onClick={() =>
                      navigate(`/app/customers/${encodeURIComponent(c.customer_email)}`)
                    }
                    className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 min-w-0">
                        <CustomerAvatar
                          order={{
                            customer_first_name: c.first_name,
                            customer_last_name: c.last_name,
                            customer_email: c.customer_email,
                          }}
                        />
                        <span className="text-text-primary font-medium truncate max-w-[180px]">
                          {customerLabel(c)}
                        </span>
                        {c.orders_count > 1 && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-accent-muted text-accent-text border border-accent/20 shrink-0">
                            repeat
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted truncate max-w-[220px]">
                      {c.customer_email}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {[c.city, c.state, c.country].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-text-primary">{c.orders_count}</td>
                    <td className="px-4 py-3 text-right font-medium text-text-primary whitespace-nowrap">
                      {money(c.total_spent)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {Number(c.total_refunded) > 0 ? (
                        <span className="text-red-400">{money(c.total_refunded)}</span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {fmtDate(c.first_order_at)}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {fmtDate(c.last_order_at)}
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
            {total} customer{total === 1 ? '' : 's'}
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
    </div>
  );
}
