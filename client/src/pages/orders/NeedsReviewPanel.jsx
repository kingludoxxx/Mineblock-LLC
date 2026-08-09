// Needs review — the money path's own distress signals, surfaced read-only.
//
// Every row here was written by checkout, gateway-webhook or settlement code
// that decided a human had to own the outcome. This panel READS those rows and
// links into the existing detail views. It offers NO action: a retry button on
// a half-settled charge is how a customer gets billed twice, and the reason
// strings are verbatim so an operator debugs the real fault rather than a
// prettied-up paraphrase of it.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import api from '../../services/api';

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

// Intl throws a RangeError on an unrecognized currency code. These rows come
// straight off the money path, which is exactly where a malformed currency
// would show up — so a bad code must degrade to plain text, not blank the
// review queue an operator is trying to triage.
const money = (v, cur = 'USD') => {
  if (v == null) return '—';
  try {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: cur || 'USD' });
  } catch {
    return `${cur || ''} ${Number(v).toFixed(2)}`.trim();
  }
};

function Reason({ children }) {
  return (
    <code className="px-1.5 py-0.5 text-[11px] rounded bg-bg-elevated border border-border-subtle text-amber-400 break-all">
      {children}
    </code>
  );
}

function Table({ title, rows, columns, empty }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <span className="text-xs text-text-muted">{rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
              {columns.map((c) => (
                <th key={c.key} className="text-left font-medium px-4 py-2.5">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-text-muted">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={r.id || r.session_id || i} className="border-b border-border-subtle last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 align-top">
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function NeedsReviewPanel() {
  // status is set only from inside async callbacks and event handlers, never
  // synchronously in the effect body — see the same note in OrderJourney.jsx.
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const load = useCallback(() => {
    api
      .get('/orders/needs-review')
      .then((res) => setState({ status: 'ready', data: res.data?.data || null, error: null }))
      .catch((err) =>
        setState({
          status: 'ready',
          data: null,
          error: err.response?.data?.error || 'Failed to load the review queue',
        })
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { status, data, error } = state;
  if (status === 'loading') {
    return <div className="py-16 text-center text-sm text-text-muted">Loading review queue…</div>;
  }
  if (error) return <div className="py-16 text-center text-sm text-danger">{error}</div>;
  if (!data) return null;

  const total =
    (data.counts?.sessions || 0) +
    (data.counts?.upsell_charges || 0) +
    (data.counts?.shopify_creates || 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-2.5">
          <AlertTriangle
            className={`w-4 h-4 shrink-0 mt-0.5 ${total ? 'text-amber-400' : 'text-text-muted'}`}
          />
          <p className="text-xs text-text-muted leading-relaxed max-w-2xl">
            {total === 0
              ? 'Nothing is waiting for review. Rows appear here when checkout, a gateway webhook or settlement gives up and hands the outcome to a person.'
              : 'These were flagged by the money path itself. They are shown read-only on purpose — retrying a half-settled charge from here could double-bill the customer. Fix the underlying cause, then let the normal path re-run.'}
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-text-muted hover:text-text-primary border border-border-default rounded-md cursor-pointer transition-colors shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {data.sources_unavailable?.length > 0 && (
        <div className="px-3 py-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          Not provisioned in this deployment, so they contribute nothing here:{' '}
          {data.sources_unavailable.join(', ')}. That is an absent system, not a clean queue.
        </div>
      )}

      <Table
        title="Checkout sessions needing review"
        rows={data.sessions || []}
        empty="No flagged sessions."
        columns={[
          { key: 'session', label: 'Session', render: (r) => <span className="text-text-primary break-all">{r.session_id}</span> },
          { key: 'reason', label: 'Reason', render: (r) => <Reason>{r.reason}</Reason> },
          { key: 'status', label: 'Status', render: (r) => <span className="text-text-muted">{r.status}</span> },
          { key: 'customer', label: 'Customer', render: (r) => <span className="text-text-muted break-all">{r.customer_email || '—'}</span> },
          { key: 'total', label: 'Total', render: (r) => <span className="text-text-primary">{money(r.total, r.currency)}</span> },
          { key: 'gateway', label: 'Gateway', render: (r) => <span className="text-text-muted">{r.gateway || '—'}</span> },
          { key: 'when', label: 'Created', render: (r) => <span className="text-text-muted whitespace-nowrap">{fmt(r.created_at)}</span> },
          {
            key: 'link',
            label: 'Order',
            render: (r) =>
              r.shopify_order_id ? (
                <a
                  href={`/app/orders/${r.shopify_order_id}`}
                  className="inline-flex items-center gap-1 text-accent-text hover:underline whitespace-nowrap"
                >
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span className="text-text-faint">no order</span>
              ),
          },
        ]}
      />

      <Table
        title="Upsell charges needing review"
        rows={data.upsell_charges || []}
        empty="No flagged upsell charges."
        columns={[
          { key: 'session', label: 'Session', render: (r) => <span className="text-text-muted break-all">{r.session_id}</span> },
          { key: 'offer', label: 'Offer', render: (r) => <span className="text-text-primary">{r.offer_id}</span> },
          { key: 'status', label: 'Status', render: (r) => <Reason>{r.status}</Reason> },
          { key: 'amount', label: 'Amount', render: (r) => <span className="text-text-primary">{money(r.amount, r.currency)}</span> },
          {
            key: 'declined',
            label: 'Declined by customer',
            render: (r) => <span className="text-text-muted">{r.declined_by_user ? 'yes' : 'no'}</span>,
          },
          { key: 'when', label: 'Updated', render: (r) => <span className="text-text-muted whitespace-nowrap">{fmt(r.updated_at)}</span> },
        ]}
      />

      <Table
        title="Shopify order creates needing review"
        rows={data.shopify_creates || []}
        empty="No failed Shopify order creates."
        columns={[
          { key: 'session', label: 'Session', render: (r) => <span className="text-text-muted break-all">{r.session_id}</span> },
          { key: 'error', label: 'Error', render: (r) => <Reason>{r.shopify_error || r.shopify_status}</Reason> },
          { key: 'total', label: 'Total', render: (r) => <span className="text-text-primary">{money(r.total, r.currency)}</span> },
          { key: 'claimed', label: 'Claimed', render: (r) => <span className="text-text-muted whitespace-nowrap">{fmt(r.shopify_claimed_at)}</span> },
          { key: 'when', label: 'Created', render: (r) => <span className="text-text-muted whitespace-nowrap">{fmt(r.created_at)}</span> },
        ]}
      />
    </div>
  );
}
