// Failed payments — the dunning queue.
//
// THE ONE THING THIS SCREEN MUST NEVER IMPLY:
// "Request retry" does not charge a card. It records that a retry was asked
// for and advances the schedule. Every affordance here says so — the button
// label, the confirmation, the row badge — because a button labelled "Retry
// charge" that quietly does nothing is worse than no button at all: an
// operator walks away believing the money is being collected.
//
// The re-charge itself is the integrator's money seam, documented in
// server/src/routes/dunning.js.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CreditCard, RefreshCw, Search, CheckCircle2, Clock, XCircle,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';

const money = (v, cur = 'USD') => {
  if (v == null) return '—';
  try {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: cur || 'USD' });
  } catch {
    return `${cur || ''} ${Number(v).toFixed(2)}`.trim();
  }
};

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

// "in 22h" / "overdue by 3h" — an absolute timestamp makes an operator do
// arithmetic to answer the only question they have, which is "now or later?".
const relative = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((t - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const unit = abs < 60 ? `${abs}m` : abs < 60 * 48 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return mins >= 0 ? `due in ${unit}` : `due ${unit} ago`;
};

// The queue states, in the order an operator triages them.
const STATE_STYLE = {
  scheduled: { label: 'Scheduled', cls: 'bg-sky-500/10 border-sky-500/25 text-sky-300', Icon: Clock },
  exhausted: { label: 'Exhausted', cls: 'bg-rose-500/10 border-rose-500/25 text-rose-300', Icon: XCircle },
  not_retryable: { label: 'Hard decline', cls: 'bg-rose-500/10 border-rose-500/25 text-rose-300', Icon: XCircle },
  stale: { label: 'Too old', cls: 'bg-bg-elevated border-border-default text-text-muted', Icon: Clock },
  recovered: { label: 'Recovered', cls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300', Icon: CheckCircle2 },
  closed: { label: 'Closed', cls: 'bg-bg-elevated border-border-default text-text-muted', Icon: CheckCircle2 },
};

// The bucket is computed SERVER-SIDE and rendered verbatim. The reference
// re-derives it in the client with a cruder rule, so its pill and its "top
// reason" statistic can disagree about the same row.
const BUCKET_TINT = {
  insufficient_funds: 'bg-amber-500/10 border-amber-500/25 text-amber-300',
  expired_card: 'bg-rose-500/10 border-rose-500/25 text-rose-300',
  invalid_payment_method: 'bg-rose-500/10 border-rose-500/25 text-rose-300',
  payment_method_revoked: 'bg-rose-500/10 border-rose-500/25 text-rose-300',
  fraud_suspected: 'bg-rose-500/10 border-rose-500/25 text-rose-300',
  do_not_honor: 'bg-rose-500/10 border-rose-500/25 text-rose-300',
  processing_error: 'bg-sky-500/10 border-sky-500/25 text-sky-300',
  card_declined: 'bg-amber-500/10 border-amber-500/25 text-amber-300',
};

const RETRY_ERRORS = {
  retry_too_soon: 'A retry was just requested for this row. Give it a minute — the ladder spaces attempts out on purpose.',
  attempts_exhausted: 'All three attempts have been used.',
  hard_decline_not_retryable: 'The issuer gave a hard decline. Retrying the same card will not help.',
  'state:exhausted': 'All three attempts have been used.',
  'state:not_retryable': 'The issuer gave a hard decline. Retrying the same card will not help.',
  'state:stale': 'This decline is older than the retry window, so it is no longer scheduled.',
  'state:recovered': 'This one already recovered.',
  'state:closed': 'This row was closed.',
  not_found: 'That queue row no longer exists.',
};

function Stat({ label, value, sub, tint, Icon }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl px-4 py-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-text-faint">{label}</span>
        {Icon && <Icon className={`w-4 h-4 ${tint || 'text-text-faint'}`} />}
      </div>
      <div className={`mt-1 text-xl font-semibold ${tint || 'text-text-primary'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function Pill({ state }) {
  const s = STATE_STYLE[state] || { label: state, cls: 'bg-bg-elevated border-border-default text-text-muted', Icon: null };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${s.cls}`}>
      {s.Icon && <s.Icon className="w-3 h-3" />}
      {s.label}
    </span>
  );
}

export default function FailedPaymentsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState('open');
  const [bucket, setBucket] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: s.data ? 'refreshing' : 'loading' }));
    try {
      const res = await api.get('/dunning/failed-payments', { params: { days, state: filter, bucket: bucket || undefined } });
      setState({ status: 'ready', data: res.data?.data || null, error: null });
    } catch (err) {
      setState({ status: 'ready', data: null, error: err.response?.data?.error || 'Failed to load the queue' });
    }
  }, [days, filter, bucket]);

  useEffect(() => { load(); }, [load]);

  const rows = state.data?.rows || [];
  const stats = state.data?.stats || null;

  const scan = async () => {
    setBusy('scan'); setNotice(null);
    try {
      const res = await api.post('/dunning/scan', { days });
      const d = res.data?.data || {};
      setNotice({
        kind: 'info',
        text: `Scan complete — ${d.queued} newly queued, ${d.updated} refreshed, ${d.skipped} not dunnable, ${d.notified} buyers emailed.`,
      });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'The scan failed' });
    } finally {
      setBusy('');
    }
  };

  const requestRetry = async (row) => {
    setBusy(row.id); setNotice(null);
    try {
      const res = await api.post(`/dunning/failed-payments/${row.id}/retry`);
      const d = res.data?.data || {};
      setNotice({
        kind: 'info',
        // Says what happened AND what did not. Both halves matter.
        text: `Retry ${d.attempt_no} of 3 recorded for ${money(row.amount, row.currency)}. No card was charged — the re-charge is wired separately.`,
      });
      await load();
    } catch (err) {
      const code = err.response?.data?.error;
      setNotice({ kind: 'error', text: RETRY_ERRORS[code] || code || 'The retry could not be recorded' });
    } finally {
      setBusy('');
    }
  };

  const closeRow = async (row) => {
    setBusy(row.id); setNotice(null);
    try {
      await api.post(`/dunning/failed-payments/${row.id}/close`, { state: 'recovered', reason: 'marked recovered by operator' });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Could not close the row' });
    } finally {
      setBusy('');
    }
  };

  const openDetail = async (row) => {
    setDetail({ status: 'loading', id: row.id, data: null });
    try {
      const res = await api.get(`/dunning/failed-payments/${row.id}`);
      setDetail({ status: 'ready', id: row.id, data: res.data?.data || null });
    } catch (err) {
      setDetail({ status: 'ready', id: row.id, data: null, error: err.response?.data?.error || 'Failed to load' });
    }
  };

  const bucketOptions = useMemo(
    () => (stats?.buckets || []).map((b) => b.bucket),
    [stats]
  );

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Failed payments</h1>
          <p className="mt-1 text-sm text-text-muted">
            Declined charges from funnel checkouts and 1-click upsells, with their retry schedule.
            Requesting a retry records the intent — it does not charge a card.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-2.5 py-1.5 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary"
          >
            {[7, 30, 60, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="px-2.5 py-1.5 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary"
          >
            <option value="open">Open</option>
            <option value="scheduled">Scheduled</option>
            <option value="not_retryable">Hard declines</option>
            <option value="exhausted">Exhausted</option>
            <option value="stale">Too old</option>
            <option value="recovered">Recovered</option>
            <option value="all">All</option>
          </select>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="px-2.5 py-1.5 text-sm bg-bg-card border border-border-default rounded-lg text-text-primary"
          >
            <option value="">All reasons</option>
            {bucketOptions.map((b) => <option key={b} value={b}>{b.replace(/_/g, ' ')}</option>)}
          </select>
          <Button variant="secondary" size="md" loading={busy === 'scan'} onClick={scan}>
            <Search className="w-3.5 h-3.5" /> Scan for failures
          </Button>
        </div>
      </div>

      {notice && (
        <div
          className={`px-4 py-2.5 text-sm rounded-lg border ${
            notice.kind === 'error'
              ? 'text-danger bg-danger/10 border-danger/20'
              : 'text-text-primary bg-bg-elevated border-border-default'
          }`}
        >
          {notice.text}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            label={`Failures · ${state.data.days} days`} value={stats.total}
            sub={`${money(stats.at_risk)} still at risk`}
            tint="text-rose-300" Icon={AlertTriangle}
          />
          <Stat
            label="Scheduled to retry" value={stats.scheduled}
            sub={`${stats.exhausted} exhausted · ${stats.not_retryable} hard`}
            tint="text-sky-300" Icon={Clock}
          />
          <Stat
            label="Recovered" value={stats.recovered}
            sub={`${money(stats.recovered_amount)} captured`}
            tint="text-emerald-300" Icon={RefreshCw}
          />
          <Stat
            label="Top reason"
            value={stats.top_bucket ? stats.top_bucket.replace(/_/g, ' ') : '—'}
            sub={stats.total ? `${stats.top_bucket_pct}% of failures` : 'nothing in this window'}
            Icon={CreditCard}
          />
        </div>
      )}

      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[980px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                {['Order', 'Failed', 'Customer', 'What failed', 'Amount', 'Reason', 'Tries', 'Next retry', 'Status', ''].map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2.5 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.status === 'loading' && (
                <tr><td colSpan={10} className="px-3 py-12 text-center text-text-muted">Loading…</td></tr>
              )}
              {state.error && (
                <tr><td colSpan={10} className="px-3 py-12 text-center text-danger">{state.error}</td></tr>
              )}
              {state.status !== 'loading' && !state.error && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-12 text-center text-text-muted">
                    No failed payments in this window. Run a scan if you expected some — the queue is
                    built from the money path's own records, not maintained live.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border-subtle last:border-0 hover:bg-bg-hover/40">
                  <td className="px-3 py-2.5 font-mono text-xs text-text-muted whitespace-nowrap">
                    <button
                      onClick={() => openDetail(r)}
                      className="hover:text-text-primary cursor-pointer underline decoration-dotted"
                    >
                      {String(r.session_id).slice(-10)}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-text-muted whitespace-nowrap">{fmt(r.first_failed_at)}</td>
                  <td className="px-3 py-2.5 text-text-primary truncate max-w-[180px]">{r.customer_email || '—'}</td>
                  <td className="px-3 py-2.5 text-text-muted whitespace-nowrap">
                    {r.source === 'session' ? 'Base order' : `Upsell${r.offer_id ? ` · ${r.offer_id}` : ''}`}
                  </td>
                  <td className="px-3 py-2.5 text-text-primary whitespace-nowrap">{money(r.amount, r.currency)}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-block px-1.5 py-0.5 text-[11px] rounded border ${
                        BUCKET_TINT[r.decline_bucket] || 'bg-bg-elevated border-border-default text-text-muted'
                      }`}
                      title={r.decline_reason || ''}
                    >
                      {(r.decline_bucket || 'unknown').replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-text-muted whitespace-nowrap">{r.attempts}/3</td>
                  <td className="px-3 py-2.5 text-text-muted whitespace-nowrap text-xs">
                    {r.next_retry_at ? relative(r.next_retry_at) : '—'}
                  </td>
                  <td className="px-3 py-2.5"><Pill state={r.state} /></td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-right">
                    {/* Gate on the SERVER's retry_possible, not on state alone:
                        a scheduled row on a session with no vaulted card cannot
                        be retried, and the write path now refuses it. When the
                        row is scheduled but has no saved card, show WHY rather
                        than a dead button. */}
                    {r.state === 'scheduled' && r.retry_possible && (
                      <Button
                        variant="secondary" size="sm"
                        loading={busy === r.id}
                        disabled={Boolean(busy)}
                        onClick={() => requestRetry(r)}
                        title="Records a retry request and advances the schedule. Does not charge the card."
                      >
                        Request retry
                      </Button>
                    )}
                    {r.state === 'scheduled' && !r.retry_possible && (
                      <span
                        className="text-[11px] text-text-faint"
                        title="This session has no saved card, so a retry would be a certain decline."
                      >
                        no saved card
                      </span>
                    )}
                    {['scheduled', 'exhausted', 'not_retryable', 'stale'].includes(r.state) && (
                      <Button
                        variant="ghost" size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => closeRow(r)}
                        className="ml-1"
                        title="Mark this as resolved outside the queue"
                      >
                        Resolved
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── detail drawer ── */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}
        >
          <div className="w-full max-w-md h-full bg-bg-card border-l border-border-default overflow-y-auto p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-semibold text-text-primary">Failed payment</h2>
              <button onClick={() => setDetail(null)} className="text-text-muted hover:text-text-primary cursor-pointer text-sm">
                Close
              </button>
            </div>
            {detail.status === 'loading' && <p className="text-sm text-text-muted">Loading…</p>}
            {detail.error && <p className="text-sm text-danger">{detail.error}</p>}
            {detail.data && (
              <>
                <div className="space-y-1.5 text-sm">
                  <Row k="Amount" v={money(detail.data.queue.amount, detail.data.queue.currency)} />
                  <Row k="State" v={<Pill state={detail.data.queue.state} />} />
                  <Row k="Reason (verbatim)" v={<code className="text-[11px] text-amber-300 break-all">{detail.data.queue.decline_reason || '—'}</code>} />
                  <Row k="Bucket" v={(detail.data.queue.decline_bucket || '').replace(/_/g, ' ')} />
                  <Row k="Attempts" v={`${detail.data.queue.attempts} of 3`} />
                  <Row k="Next retry" v={detail.data.queue.next_retry_at ? `${fmt(detail.data.queue.next_retry_at)} (${relative(detail.data.queue.next_retry_at)})` : 'none scheduled'} />
                  <Row k="Buyer emailed" v={detail.data.queue.notified_at ? fmt(detail.data.queue.notified_at) : 'no'} />
                  <Row k="Saved card on session" v={detail.data.session?.has_saved_pm ? 'yes' : 'no'} />
                </div>

                {/* The integrator's precondition, said plainly rather than
                    discovered at the gateway. */}
                {!detail.data.retry_possible && (
                  <div className="px-3 py-2 text-xs rounded-lg bg-bg-elevated border border-border-default text-text-muted">
                    Retry is not available: <strong>{detail.data.retry_blocked_reason}</strong>
                    {detail.data.retry_blocked_reason === 'no_saved_payment_method' && (
                      <span> — there is no vaulted card on this session, so any retry would be a certain decline.</span>
                    )}
                  </div>
                )}

                <div>
                  <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1.5">Retry requests</div>
                  {detail.data.retry_requests.length === 0 ? (
                    <p className="text-sm text-text-muted">None yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {detail.data.retry_requests.map((q) => (
                        <div key={q.id} className="text-sm text-text-muted">
                          Attempt {q.attempt_no} · {q.requested_by || 'system'} · {q.origin} · {fmt(q.created_at)}
                        </div>
                      ))}
                      <p className="text-[11px] text-text-faint pt-1">
                        These are recorded intentions. No card was charged by any of them.
                      </p>
                    </div>
                  )}
                </div>

                {detail.data.session && (
                  <Button
                    variant="secondary" size="md"
                    onClick={() => navigate(`/app/orders?search=${encodeURIComponent(detail.data.session.customer_email || '')}`)}
                  >
                    Find this customer's orders
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-text-muted shrink-0">{k}</span>
      <span className="text-text-primary text-right break-all">{v}</span>
    </div>
  );
}
