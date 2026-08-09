// Abandoned checkouts — ONE list over TWO populations (our funnel checkout
// sessions + Shopify's own abandoned checkouts), with the recovery pipeline
// attached: mint a signed recovery link, fire the Klaviyo nudge that carries
// it, and watch the row flip Not recovered → Sent → Recovered.
//
// The row's "Recovery" state lives in a sidecar table, never on the cart, so
// nothing on this page can touch money. The recovery LINK lands on a public
// resume endpoint the integrator owns (contract in server/src/routes/
// abandonedCheckouts.js) — until that ships, the link is mintable and mailable
// but 404s when clicked.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  RefreshCw,
  ExternalLink,
  Link2,
  Mail,
  Check,
  Zap,
  X,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import { CustomerAvatar } from './OrdersPage';

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

const DAY_OPTIONS = [1, 7, 14, 30, 90];
const SOURCE_TABS = [
  { key: '', label: 'All sources' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'shopify', label: 'Shopify' },
];
const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'Not recovered', label: 'Not recovered' },
  { key: 'Sent', label: 'Sent' },
  { key: 'Recovered', label: 'Recovered' },
];

// Recovery is its own vocabulary — deliberately NOT the Orders payment pill, so
// nobody reads "Recovered" as "paid". Recovered means: they were nudged and a
// payment followed inside the attribution window.
function RecoveryPill({ status, undeliverable }) {
  if (undeliverable) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border bg-bg-elevated text-text-faint border-border-default">
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
        No email
      </span>
    );
  }
  const v = String(status || 'Not recovered');
  let cls = 'bg-bg-elevated text-text-muted border-border-default';
  if (v === 'Recovered') cls = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  else if (v === 'Sent') cls = 'bg-sky-500/10 text-sky-400 border-sky-500/20';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      {v}
    </span>
  );
}

function SourceTag({ source }) {
  const funnel = source === 'funnel';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded border ${
        funnel
          ? 'bg-violet-500/10 text-violet-400 border-violet-500/20'
          : 'bg-bg-elevated text-text-muted border-border-default'
      }`}
    >
      {funnel ? 'Funnel' : 'Shopify'}
    </span>
  );
}

function FilterTabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 bg-bg-elevated border border-border-default rounded-lg p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key || 'all'}
          onClick={() => onChange(t.key)}
          className={`px-2.5 py-1 text-xs rounded-md cursor-pointer transition-colors ${
            value === t.key
              ? 'bg-bg-card text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── cart contents drawer ────────────────────────────────────────────────────
function CartDetailModal({ open, onClose, detail, loading }) {
  const c = detail?.checkout;
  return (
    <Modal open={open} onClose={onClose} size="xl" title={c ? `Cart · ${c.source === 'funnel' ? 'Funnel' : 'Shopify'} ${c.ref_id}` : 'Cart'}>
      {loading || !detail ? (
        <div className="py-10 text-center text-text-muted text-sm">Loading cart…</div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-faint">Customer</div>
              <div className="text-text-primary mt-0.5">
                {[c.customer_first_name, c.customer_last_name].filter(Boolean).join(' ') || '—'}
              </div>
              <div className="text-text-muted text-xs">{c.email || 'no email captured'}</div>
              {c.phone && <div className="text-text-muted text-xs">{c.phone}</div>}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-faint">Started</div>
              <div className="text-text-primary mt-0.5">{fmtDate(c.created_at)}</div>
              <div className="text-text-muted text-xs">
                {[c.destination_city, c.destination_state, c.destination_country].filter(Boolean).join(', ') || 'no address'}
              </div>
            </div>
          </div>

          <div className="border border-border-subtle rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                  <th className="text-left font-medium px-3 py-2">Item</th>
                  <th className="text-right font-medium px-3 py-2">Qty</th>
                  <th className="text-right font-medium px-3 py-2">Price</th>
                  <th className="text-right font-medium px-3 py-2">Line</th>
                </tr>
              </thead>
              <tbody>
                {(detail.cart?.items || []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                      No line items were captured on this cart.
                    </td>
                  </tr>
                ) : (
                  detail.cart.items.map((it, i) => (
                    <tr key={`${it.variant_id}-${i}`} className="border-b border-border-subtle last:border-0">
                      <td className="px-3 py-2 text-text-primary">
                        {it.title || '—'}
                        {it.variant_title && <span className="text-text-faint"> · {it.variant_title}</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-text-muted">{it.quantity}</td>
                      <td className="px-3 py-2 text-right text-text-muted">{money(it.price)}</td>
                      <td className="px-3 py-2 text-right text-text-primary">{money(it.line_total)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="flex items-center justify-between px-3 py-2 border-t border-border-subtle text-xs">
              <span className="text-text-muted">
                {detail.cart?.item_count ?? 0} item{detail.cart?.item_count === 1 ? '' : 's'}
                {detail.cart?.truncated ? ' (first 50 shown)' : ''}
              </span>
              <span className="text-text-primary font-medium">{money(c.total_price)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <RecoveryPill status={c.recovery_status} undeliverable={c.undeliverable} />
            {c.sent_at && <span className="text-xs text-text-muted">Nudged {fmtDate(c.sent_at)}</span>}
            {c.recovered_at && (
              <span className="text-xs text-emerald-400">
                Recovered {fmtDate(c.recovered_at)}
                {c.recovered_value != null ? ` · ${money(c.recovered_value)}` : ''}
              </span>
            )}
          </div>

          {c.recovery_url && (
            <div className="text-xs break-all">
              <span className="text-text-faint">Recovery link: </span>
              <a href={c.recovery_url} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
                {c.recovery_url}
              </a>
            </div>
          )}

          {(detail.events || []).length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">Session events</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {detail.events.map((e, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-text-primary">{e.kind}</span>
                    <span className="text-text-faint">{fmtDate(e.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function AbandonedCheckoutsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState({});
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const debounceRef = useRef(null);

  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const days = parseInt(searchParams.get('days'), 10) || 7;
  const source = searchParams.get('source') || '';
  const status = searchParams.get('status') || '';

  const queryParams = useMemo(() => {
    const p = { page, limit: 25, days };
    if (q) p.q = q;
    if (source) p.source = source;
    if (status) p.status = status;
    return p;
  }, [page, q, days, source, status]);

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
        setStats(d);
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

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, String(value));
    else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next, { replace: key !== 'page' });
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await api.post('/abandoned/sync');
      setNotice(`Shopify sync imported ${res.data?.data?.imported ?? 0} checkout(s).`);
      await load(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  // The sweep: every nudgeable cart in the lookback window gets ONE Klaviyo
  // event. Safe to press twice — the send claim arbitrates, not the button.
  const runDetector = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await api.post('/abandoned/detector/run', { days: 14 });
      const d = res.data?.data || {};
      setNotice(
        `Detector scanned ${d.scanned ?? 0} · sent ${d.sent ?? 0} · skipped ${d.skipped ?? 0}` +
          (d.undeliverable ? ` · ${d.undeliverable} with no usable email` : '') +
          (d.reconciled?.recovered ? ` · ${d.reconciled.recovered} newly recovered` : '')
      );
      await load(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Detector run failed');
    } finally {
      setRunning(false);
    }
  };

  const act = async (row, path, okMessage) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await api.post(`/abandoned/${row.source}/${encodeURIComponent(row.ref_id)}${path}`, {});
      setNotice(typeof okMessage === 'function' ? okMessage(res.data?.data || {}) : okMessage);
      await load(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (row) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await api.post(`/abandoned/${row.source}/${encodeURIComponent(row.ref_id)}/recovery-link`, {});
      const url = res.data?.data?.link_url || '';
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        copied = false;
      }
      setNotice(copied ? 'Recovery link copied to the clipboard.' : `Recovery link: ${url}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not mint a recovery link');
    } finally {
      setBusyId(null);
    }
  };

  const markStatus = async (row, next) => {
    setBusyId(row.id);
    setError(null);
    try {
      await api.post(`/abandoned/${row.source}/${encodeURIComponent(row.ref_id)}/recovery`, { status: next });
      setNotice(`Marked ${next.toLowerCase()}.`);
      await load(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update recovery status');
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (row) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get(`/abandoned/${row.source}/${encodeURIComponent(row.ref_id)}`);
      setDetail(res.data?.data || null);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const onSearch = (value) => {
    setQ(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setParam('q', value), 300);
  };

  const grace = stats?.window?.grace_minutes;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Abandoned checkouts</h1>
          <p className="mt-1 text-sm text-text-muted">
            Started buying but never paid — recoverable revenue.
            {grace ? ` A cart counts as abandoned after ${grace} min with no payment.` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="md" loading={running} onClick={runDetector}>
            <Zap className="w-4 h-4" /> Run recovery sweep
          </Button>
          <Button variant="secondary" size="md" loading={syncing} onClick={syncNow}>
            <RefreshCw className="w-4 h-4" /> Sync now
          </Button>
        </div>
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-3 bg-bg-card border border-border-default rounded-xl px-4 py-2.5">
          <span className="text-sm text-text-muted">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-text-faint hover:text-text-primary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI strip */}
      <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-5 border-r border-border-subtle shrink-0">
          <ShoppingCart className="w-4 h-4 text-text-muted" />
          <span className="text-sm font-medium text-text-primary">Open</span>
        </div>
        {[
          { label: 'Abandoned checkouts', value: String(stats.total ?? 0) },
          { label: 'Value at stake', value: money(stats.value_at_stake ?? 0) },
          { label: 'Reachable by email', value: String(stats.with_email ?? 0) },
          { label: 'Recovery emails sent', value: String(stats.emails_sent ?? 0) },
          {
            label: 'Recovered revenue',
            value: money(stats.recovered_revenue ?? 0),
            sub: `${stats.recovered ?? 0} recovered`,
          },
        ].map((c, i) => (
          <div
            key={c.label}
            className={`flex-1 px-5 py-3.5 min-w-0 ${i > 0 ? 'border-l border-border-subtle' : ''}`}
          >
            <div className="text-[11px] uppercase tracking-wider text-text-faint truncate">{c.label}</div>
            <div className="mt-1 text-xl font-semibold text-text-primary truncate">{c.value}</div>
            {c.sub && <div className="text-[11px] text-text-faint truncate">{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3 flex-wrap">
        <Search className="w-4 h-4 text-text-faint shrink-0" />
        <input
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="flex-1 min-w-[180px] bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
        />
        <FilterTabs tabs={SOURCE_TABS} value={source} onChange={(v) => setParam('source', v)} />
        <FilterTabs tabs={STATUS_TABS} value={status} onChange={(v) => setParam('status', v)} />
        <select
          value={days}
          onChange={(e) => setParam('days', e.target.value)}
          className="bg-bg-elevated border border-border-default rounded-lg text-xs text-text-primary px-2 py-1.5 cursor-pointer focus:outline-none"
        >
          {DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              Last {d} day{d === 1 ? '' : 's'}
            </option>
          ))}
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
                <th className="text-left font-medium px-4 py-3">Source</th>
                <th className="text-left font-medium px-4 py-3">Started</th>
                <th className="text-left font-medium px-4 py-3">Cart</th>
                <th className="text-right font-medium px-4 py-3">Value</th>
                <th className="text-left font-medium px-4 py-3">Location</th>
                <th className="text-left font-medium px-4 py-3">Recovery</th>
                <th className="text-right font-medium px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-text-muted">
                    Loading abandoned checkouts...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-danger">
                    {error}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-text-muted">
                    No abandoned checkouts in this window — everyone who started buying finished. 🎉
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <tr
                    key={c.id}
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
                        <span className="text-text-primary truncate max-w-[150px]">
                          {[c.customer_first_name, c.customer_last_name].filter(Boolean).join(' ') || '—'}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted truncate max-w-[200px]">
                      {c.email || <span className="text-text-faint">no email captured</span>}
                    </td>
                    <td className="px-4 py-3">
                      <SourceTag source={c.source} />
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">{fmtDate(c.created_at)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => openDetail(c)}
                        className="text-left text-text-muted hover:text-text-primary cursor-pointer transition-colors"
                        title="View cart contents"
                      >
                        <span className="block truncate max-w-[180px]">
                          {(c.items || []).map((li) => li.title).filter(Boolean).slice(0, 2).join(', ') ||
                            `${c.item_count} item${c.item_count === 1 ? '' : 's'}`}
                        </span>
                        {c.item_count > 0 && (
                          <span className="text-[11px] text-text-faint">
                            {c.item_count} item{c.item_count === 1 ? '' : 's'}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-text-primary whitespace-nowrap">
                      {money(c.total_price)}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {[c.destination_city, c.destination_state].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <RecoveryPill status={c.recovery_status} undeliverable={c.undeliverable} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        {c.recovery_status === 'Recovered' ? (
                          <span className="text-xs text-emerald-400">Recovered ✓</span>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId === c.id}
                              onClick={() => copyLink(c)}
                              title="Mint and copy the recovery link"
                            >
                              <Link2 className="w-3.5 h-3.5" /> Link
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busyId === c.id || !c.nudgeable}
                              onClick={() =>
                                act(c, '/send', (d) =>
                                  d.deduped
                                    ? 'Already nudged — the event was deduplicated, no second email went out.'
                                    : 'Recovery event sent to Klaviyo with the link.'
                                )
                              }
                              title={
                                c.nudgeable
                                  ? 'Send the Klaviyo recovery event carrying the link'
                                  : `Not sendable: ${c.state_reason?.replace(/_/g, ' ')}`
                              }
                            >
                              <Mail className="w-3.5 h-3.5" />
                              {c.recovery_status === 'Sent' ? 'Resend' : 'Send recovery'}
                            </Button>
                            {c.recovery_status === 'Sent' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === c.id}
                                onClick={() => markStatus(c, 'Recovered')}
                                title="Mark this cart recovered by hand"
                              >
                                <Check className="w-3.5 h-3.5" /> Recovered
                              </Button>
                            )}
                          </>
                        )}
                        {c.recovery_url && (
                          <a
                            href={c.recovery_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-accent-text hover:underline text-xs px-1"
                            title="Open the recovery link"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-sm text-text-muted">
            {stats.total ?? 0} abandoned checkout{stats.total === 1 ? '' : 's'}
            {stats.by_source
              ? ` · ${stats.by_source.funnel ?? 0} funnel · ${stats.by_source.shopify ?? 0} Shopify`
              : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setParam('page', page - 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <button
              disabled={page >= pages}
              onClick={() => setParam('page', page + 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <CartDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        detail={detail}
        loading={detailLoading}
      />
    </div>
  );
}
