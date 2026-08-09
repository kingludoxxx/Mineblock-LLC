import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { CustomerAvatar } from '../orders/OrdersPage';
import { customerLabel } from './CustomersPage';
import { StatusPill } from '../orders/OrdersPage';

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

function addressLines(addr) {
  if (!addr) return null;
  const parts = [
    addr.address1,
    addr.address2,
    [addr.city, addr.province_code || addr.province, addr.zip].filter(Boolean).join(', '),
    addr.country_code || addr.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function SectionCard({ title, children }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-5">
      {title && <h3 className="text-sm font-semibold text-text-primary mb-3">{title}</h3>}
      {children}
    </div>
  );
}

export default function CustomerDetailPage() {
  const { email } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/customers/${encodeURIComponent(email)}`);
      setData(res.data?.data || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  const addNote = async () => {
    const body = note.trim();
    if (!body) return;
    setSaving(true);
    try {
      await api.post(`/customers/${encodeURIComponent(email)}/notes`, { body });
      setNote('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="py-24 text-center text-text-muted text-sm">Loading customer...</div>;
  }
  if (error || !data?.customer) {
    return (
      <div className="py-24 text-center">
        <p className="text-danger text-sm">{error || 'Customer not found'}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() => navigate('/app/customers')}
        >
          <ArrowLeft className="w-4 h-4" /> Back to customers
        </Button>
      </div>
    );
  }

  const { customer: c, orders, notes, shipping_address: ship, billing_address: bill } = data;
  const sameAddress = ship && bill ? JSON.stringify(ship) === JSON.stringify(bill) : !bill;
  // total_spent is GATEWAY revenue, so the divisor must be GATEWAY orders.
  // Dividing collected revenue by every order, manual ones included, would
  // understate AOV by exactly the share of orders that were recorded by hand.
  const gatewayOrders = Number(c.orders_count || 0) - Number(c.manual_orders_count || 0);
  const aov = gatewayOrders > 0 ? Number(c.total_spent) / gatewayOrders : 0;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => navigate('/app/customers')}
          className="mt-1.5 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-3">
          <CustomerAvatar
            order={{
              customer_first_name: c.first_name,
              customer_last_name: c.last_name,
              customer_email: c.customer_email,
            }}
          />
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{customerLabel(c)}</h1>
            <p className="mt-0.5 text-sm text-text-muted">
              Customer since {fmtDate(c.first_order_at)}
            </p>
          </div>
        </div>
      </div>

      {/* Stat strip */}
      <div className="flex bg-bg-card border border-border-default rounded-xl overflow-hidden">
        {[
          { label: 'Orders', value: String(c.orders_count) },
          // Gateway revenue only — manual orders are recorded, not collected,
          // so they get their own cell instead of inflating this one.
          { label: 'Total spent', value: money(c.total_spent) },
          ...(Number(c.manual_spent) > 0
            ? [
                {
                  label: `Manual (${c.manual_orders_count})`,
                  value: money(c.manual_spent),
                },
              ]
            : []),
          { label: 'Avg order value', value: money(aov) },
          {
            label: 'Refunded',
            value: Number(c.total_refunded) > 0 ? money(c.total_refunded) : '—',
          },
          { label: 'Last order', value: fmtDate(c.last_order_at) },
        ].map((cell, i) => (
          <div
            key={cell.label}
            className={`flex-1 px-5 py-3.5 min-w-0 ${i > 0 ? 'border-l border-border-subtle' : ''}`}
          >
            <div className="text-[11px] uppercase tracking-wider text-text-faint truncate">
              {cell.label}
            </div>
            <div className="mt-1 text-lg font-semibold text-text-primary truncate">
              {cell.value}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {/* Order history */}
        <div className="xl:col-span-2">
          <SectionCard title={`Order history (${orders.length})`}>
            <div className="overflow-x-auto -mx-5 -mb-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-text-faint border-y border-border-subtle">
                    <th className="text-left font-medium px-5 py-2.5">Order</th>
                    <th className="text-left font-medium px-4 py-2.5">Date</th>
                    <th className="text-right font-medium px-4 py-2.5">Total</th>
                    <th className="text-left font-medium px-4 py-2.5">Payment</th>
                    <th className="text-left font-medium px-4 py-2.5">Fulfillment</th>
                    <th className="text-right font-medium px-5 py-2.5">Items</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.order_id}
                      onClick={() => navigate(`/app/orders/${o.order_id}`)}
                      className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-text-primary">
                        {o.order_number}
                        {o.source === 'manual' && (
                          <span
                            title="Recorded by an operator — no gateway confirmed this payment, and it is excluded from Total spent"
                            className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-bg-elevated border border-border-default text-text-muted align-middle"
                          >
                            Manual
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                        {fmtDate(o.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-text-primary">
                        {money(o.total_price)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill kind="payment" value={o.financial_status} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill kind="fulfillment" value={o.fulfillment_status} />
                      </td>
                      <td className="px-5 py-3 text-right text-text-muted">{o.item_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <SectionCard title="Contact information">
            <div className="space-y-1.5">
              <div className="text-sm text-accent-text break-all">{c.customer_email}</div>
              <div className="text-sm text-text-muted">{c.phone || 'No phone number'}</div>
            </div>
          </SectionCard>

          <SectionCard title="Addresses">
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">
                  Shipping address
                </div>
                <div className="text-sm text-text-primary">
                  {addressLines(ship) ||
                    [c.city, c.state, c.country].filter(Boolean).join(', ') ||
                    '—'}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">
                  Billing address
                </div>
                <div className="text-sm text-text-primary">
                  {sameAddress ? 'Same as shipping address' : addressLines(bill) || '—'}
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Notes">
            <div className="flex gap-2 mb-3">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
                placeholder="Add a note about this customer"
                className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
              <Button
                variant="secondary"
                size="md"
                loading={saving}
                onClick={addNote}
                disabled={!note.trim()}
              >
                <Plus className="w-3.5 h-3.5" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {notes.length === 0 ? (
                <span className="text-xs text-text-faint">No notes yet</span>
              ) : (
                notes.map((n) => (
                  <div
                    key={n.id}
                    className="px-3 py-2 bg-bg-elevated border border-border-default rounded-lg"
                  >
                    <div className="text-sm text-text-primary">{n.body}</div>
                    <div className="mt-0.5 text-[11px] text-text-faint">
                      {n.author} · {fmtDate(n.created_at)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
