import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { CustomerAvatar } from './OrdersPage';

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

export default function AbandonedCheckoutsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [valueAtStake, setValueAtStake] = useState(0);
  const [withEmail, setWithEmail] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const debounceRef = useRef(null);

  const queryParams = useMemo(() => {
    const p = { page, limit: 25 };
    if (q) p.q = q;
    return p;
  }, [page, q]);

  const load = useCallback(
    async (nosync = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get('/abandoned', {
          params: nosync ? { ...queryParams, nosync: '1' } : queryParams,
        });
        const d = res.data?.data || {};
        setRows(d.checkouts || []);
        setTotal(d.total || 0);
        setValueAtStake(d.value_at_stake || 0);
        setWithEmail(d.with_email || 0);
        setPages(d.pages || 1);
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to load abandoned checkouts');
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [queryParams]
  );

  useEffect(() => {
    load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await api.post('/abandoned/sync');
      await load(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
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
          <h1 className="text-2xl font-semibold text-text-primary">Abandoned checkouts</h1>
          <p className="mt-1 text-sm text-text-muted">
            Started checkout but never paid — recoverable revenue.
          </p>
        </div>
        <Button variant="secondary" size="md" loading={syncing} onClick={syncNow}>
          <RefreshCw className="w-4 h-4" /> Sync now
        </Button>
      </div>

      {/* KPI strip */}
      <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-5 border-r border-border-subtle shrink-0">
          <ShoppingCart className="w-4 h-4 text-text-muted" />
          <span className="text-sm font-medium text-text-primary">Open</span>
        </div>
        {[
          { label: 'Abandoned checkouts', value: String(total) },
          { label: 'Value at stake', value: money(valueAtStake) },
          { label: 'Reachable by email', value: String(withEmail) },
        ].map((c, i) => (
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

      {/* Search */}
      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3">
        <Search className="w-4 h-4 text-text-faint shrink-0" />
        <input
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
        />
      </div>

      {/* Table */}
      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                <th className="text-left font-medium px-4 py-3">Customer</th>
                <th className="text-left font-medium px-4 py-3">Email</th>
                <th className="text-left font-medium px-4 py-3">Started</th>
                <th className="text-left font-medium px-4 py-3">Items</th>
                <th className="text-right font-medium px-4 py-3">Value</th>
                <th className="text-left font-medium px-4 py-3">Location</th>
                <th className="text-left font-medium px-4 py-3">Recovery</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-text-muted">
                    Loading abandoned checkouts...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-danger">
                    {error}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-text-muted">
                    No abandoned checkouts — everyone who started buying finished. 🎉
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <tr
                    key={c.checkout_id}
                    className="border-b border-border-subtle last:border-0 hover:bg-bg-hover transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 min-w-0">
                        <CustomerAvatar
                          order={{
                            customer_first_name: c.customer_first_name,
                            customer_last_name: c.customer_last_name,
                            customer_email: c.email,
                          }}
                        />
                        <span className="text-text-primary truncate max-w-[160px]">
                          {[c.customer_first_name, c.customer_last_name]
                            .filter(Boolean)
                            .join(' ') || '—'}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted truncate max-w-[220px]">
                      {c.email || <span className="text-text-faint">no email captured</span>}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {fmtDate(c.created_at)}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {(Array.isArray(c.line_items) ? c.line_items : [])
                        .map((li) => li.title)
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(', ') || c.item_count}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-text-primary whitespace-nowrap">
                      {money(c.total_price)}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {[c.destination_city, c.destination_state].filter(Boolean).join(', ') ||
                        '—'}
                    </td>
                    <td className="px-4 py-3">
                      {c.recovery_url ? (
                        <a
                          href={c.recovery_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-accent-text hover:underline text-xs"
                        >
                          Recovery link <ExternalLink className="w-3 h-3" />
                        </a>
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

        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-sm text-text-muted">
            {total} abandoned checkout{total === 1 ? '' : 's'}
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
