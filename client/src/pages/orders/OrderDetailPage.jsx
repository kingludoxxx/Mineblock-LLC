import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Archive,
  Package,
  CreditCard,
  Pencil,
  Send,
  Plus,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { CustomerAvatar, StatusPill, customerName } from './OrdersPage';

const money = (v) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

const fmtDay = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

function SectionCard({ title, action, children, className = '' }) {
  return (
    <div className={`bg-bg-card border border-border-default rounded-xl p-5 ${className}`}>
      {title && (
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function DetailField({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div>
      <div className="text-[11px] text-text-faint">{label}</div>
      <div className="text-sm text-text-primary break-all">{value}</div>
    </div>
  );
}

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

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [actionMsg, setActionMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/orders/${id}`);
      setData(res.data?.data || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load order');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="py-24 text-center text-text-muted text-sm">Loading order...</div>;
  }
  if (error || !data?.order) {
    return (
      <div className="py-24 text-center">
        <p className="text-danger text-sm">{error || 'Order not found'}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => navigate('/app/orders')}>
          <ArrowLeft className="w-4 h-4" /> Back to orders
        </Button>
      </div>
    );
  }

  const { order, comments, events, neighbors, customer_order_count: orderCount } = data;
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const utm = order.utm || {};
  const ship = order.shipping_address;
  const bill = order.billing_address;
  const sameAddress =
    ship && bill ? JSON.stringify(ship) === JSON.stringify(bill) : !bill;
  const hasCosts =
    order.cogs != null && Number(order.cogs) > 0;
  const shippingPrice = Number(order.shipping_price || 0);
  const subtotal = Number(order.subtotal_price || 0);

  const doFulfill = async () => {
    try {
      await api.post(`/orders/${id}/fulfill`);
      await load();
    } catch (err) {
      setActionMsg(err.response?.data?.error || 'Failed to mark as fulfilled');
    }
  };

  const doArchive = async () => {
    try {
      await api.post(`/orders/${id}/archive`, { archived: !order.archived });
      await load();
    } catch (err) {
      setActionMsg(err.response?.data?.error || 'Failed to archive');
    }
  };

  const postComment = async () => {
    const body = comment.trim();
    if (!body) return;
    setPosting(true);
    try {
      await api.post(`/orders/${id}/comments`, { body });
      setComment('');
      await load();
    } catch (err) {
      setActionMsg(err.response?.data?.error || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  const addTag = async () => {
    const t = tagInput.trim();
    if (!t) return;
    try {
      await api.put(`/orders/${id}/tags`, { tags: [...(order.tags || []), t] });
      setTagInput('');
      await load();
    } catch (err) {
      setActionMsg(err.response?.data?.error || 'Failed to add tag');
    }
  };

  // Timeline: merge staff comments and system events, newest first, grouped by day
  const timeline = [
    ...comments.map((c) => ({ ...c, _type: 'comment', ts: c.created_at })),
    ...events.map((e) => ({ ...e, _type: 'event', ts: e.created_at })),
    { _type: 'event', kind: 'placed', message: `Order was placed.`, ts: order.created_at, id: 'placed' },
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const timelineByDay = timeline.reduce((acc, entry) => {
    const day = fmtDay(entry.ts);
    (acc[day] = acc[day] || []).push(entry);
    return acc;
  }, {});

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <button
            onClick={() => navigate('/app/orders')}
            className="mt-1 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl font-semibold text-text-primary">
                {order.order_number || order.order_id}
              </h1>
              <StatusPill kind="payment" value={order.financial_status} />
              <StatusPill kind="fulfillment" value={order.fulfillment_status} />
              {order.archived && <StatusPill kind="delivery" value="archived" />}
            </div>
            <p className="mt-1 text-sm text-text-muted">
              {fmtDate(order.created_at)}
              {order.funnel_name ? ` from ${order.funnel_name} · Puure` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="md" title="Refunds arrive with the checkout phase">
            Refund
          </Button>
          <Button variant="secondary" size="md" title="Order editing arrives with the checkout phase">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button variant="secondary" size="md" onClick={doArchive}>
            <Archive className="w-3.5 h-3.5" /> {order.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <div className="flex items-center border border-border-default rounded-lg overflow-hidden">
            <button
              disabled={!neighbors?.newer}
              onClick={() => navigate(`/app/orders/${neighbors.newer}`)}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:pointer-events-none cursor-pointer transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={!neighbors?.older}
              onClick={() => navigate(`/app/orders/${neighbors.older}`)}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:pointer-events-none border-l border-border-default cursor-pointer transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {actionMsg && (
        <div className="px-4 py-2.5 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg">
          {actionMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {/* ── Left column ── */}
        <div className="xl:col-span-2 space-y-5">
          {/* Line items / fulfillment */}
          <SectionCard>
            <div className="flex items-center gap-2 mb-3">
              <StatusPill kind="fulfillment" value={order.fulfillment_status} />
              <span className="px-2 py-0.5 text-xs font-medium rounded-md bg-bg-elevated border border-border-default text-text-muted">
                Puure™
              </span>
            </div>
            <div className="border border-border-subtle rounded-lg">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle text-sm text-text-muted">
                <Package className="w-4 h-4" /> Default
              </div>
              <div className="divide-y divide-border-subtle">
                {items.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-text-muted">No line items recorded.</div>
                ) : (
                  items.map((li, idx) => (
                    <div key={li.id || idx} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-10 h-10 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center shrink-0 overflow-hidden">
                        {li.image_url ? (
                          <img
                            src={li.image_url}
                            alt={li.title || 'Product'}
                            className="w-full h-full object-cover"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          />
                        ) : (
                          <Package className="w-4 h-4 text-text-faint" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">
                          {li.title || li.name || 'Item'}
                        </div>
                        <div className="text-xs text-text-faint truncate">
                          {li.variant_title ? `${li.variant_title} · ` : ''}
                          {li.variant_id ? `Variant ${li.variant_id}` : ''}
                        </div>
                      </div>
                      <div className="text-sm text-text-muted whitespace-nowrap">
                        {money(li.price)} × {li.quantity || 1}
                      </div>
                      <div className="text-sm font-medium text-text-primary whitespace-nowrap w-20 text-right">
                        {money((parseFloat(li.price) || 0) * (parseInt(li.quantity, 10) || 1))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            {(order.fulfillments || []).filter((f) => f.tracking_number).length > 0 && (
              <div className="mt-3 border border-border-subtle rounded-lg divide-y divide-border-subtle">
                {(order.fulfillments || [])
                  .filter((f) => f.tracking_number)
                  .map((f) => (
                    <div key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase tracking-wider text-text-faint">
                          Tracking{f.tracking_company ? ` · ${f.tracking_company}` : ''}
                          {f.shipment_status ? ` · ${String(f.shipment_status).replace(/_/g, ' ')}` : ''}
                        </div>
                        <div className="text-sm font-medium text-text-primary truncate">
                          {f.tracking_number}
                        </div>
                      </div>
                      {f.tracking_url && (
                        <a
                          href={f.tracking_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-accent-text hover:underline shrink-0"
                        >
                          Track package
                        </a>
                      )}
                    </div>
                  ))}
              </div>
            )}
            {order.fulfillment_status !== 'fulfilled' && (
              <div className="flex justify-end mt-3">
                <Button variant="primary" size="md" onClick={doFulfill}>
                  Mark as fulfilled
                </Button>
              </div>
            )}
          </SectionCard>

          {/* Payment summary */}
          <SectionCard>
            <div className="mb-3">
              <StatusPill kind="payment" value={order.financial_status} />
            </div>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Subtotal</span>
                <span className="text-text-muted">
                  {items.length} item{items.length === 1 ? '' : 's'}
                </span>
                <span className="text-text-primary font-medium">{money(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Shipping</span>
                <span className="text-text-primary font-medium">{money(shippingPrice)}</span>
              </div>
              {Number(order.total_discounts) > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Discounts</span>
                  <span className="text-text-primary font-medium">
                    −{money(order.total_discounts)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2.5 border-t border-border-subtle">
                <span className="text-text-primary font-semibold">Total</span>
                <span className="text-text-primary font-semibold">{money(order.total_price)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Paid</span>
                <span className="text-text-primary font-medium">{money(order.total_price)}</span>
              </div>
              {Number(order.refund_amount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-red-400">Refunded</span>
                  <span className="text-red-400 font-medium">−{money(order.refund_amount)}</span>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Cost breakdown */}
          <SectionCard title="Cost breakdown">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">COGS</span>
                <span className="text-text-primary font-medium">
                  {hasCosts ? money(order.cogs) : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Shipping cost</span>
                <span className="text-text-primary font-medium">—</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Processing fees</span>
                <span className="text-text-primary font-medium">
                  {order.processing_fee != null ? money(order.processing_fee) : '—'}
                </span>
              </div>
              <div className="flex justify-between pt-2.5 border-t border-border-subtle">
                <span className="text-text-primary font-semibold">Net after costs</span>
                <span className="text-text-primary font-semibold">
                  {hasCosts && order.net_after_costs != null ? money(order.net_after_costs) : '—'}
                </span>
              </div>
            </div>
            {!hasCosts && (
              <p className="mt-3 text-xs text-text-faint">
                No cost entered for this order's variants yet, so COGS and Net are withheld — a
                $0.00 here would read as 100% margin.
              </p>
            )}
          </SectionCard>

          {/* Attribution */}
          <SectionCard title="Where this order came from">
            {Object.keys(utm).length > 0 ? (
              <div className="space-y-1.5">
                <div className="flex items-start gap-2.5">
                  <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-text-primary">
                      {utm.utm_source ? `${utm.utm_source}` : 'Unknown source'}
                      {utm.utm_campaign ? ` — ${utm.utm_campaign}` : ''}
                    </div>
                    <div className="text-xs text-text-faint">
                      {[utm.utm_medium, utm.utm_content, utm.utm_term]
                        .filter(Boolean)
                        .join(' · ') || 'No further UTM detail'}
                    </div>
                  </div>
                </div>
                <p className="pt-2 text-xs text-text-faint">
                  Full touch journey appears here once funnel tracking is live.
                </p>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                No attribution recorded for this order yet. The full touch journey appears here
                once funnel tracking is live.
              </p>
            )}
          </SectionCard>

          {/* Timeline */}
          <SectionCard title="Timeline">
            <div className="flex items-start gap-2.5 mb-4">
              <span className="mt-1 inline-flex items-center justify-center w-7 h-7 rounded-full bg-accent-muted text-accent-text text-xs font-semibold shrink-0">
                A
              </span>
              <div className="flex-1">
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Leave a comment.."
                  rows={1}
                  className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
                />
                <p className="mt-1 text-[11px] text-text-faint text-right">
                  Only you and other staff can see comments
                </p>
              </div>
              <Button
                variant="secondary"
                size="md"
                loading={posting}
                onClick={postComment}
                disabled={!comment.trim()}
              >
                Post
              </Button>
            </div>
            <div className="space-y-4">
              {Object.entries(timelineByDay).map(([day, entries]) => (
                <div key={day}>
                  <div className="text-xs font-semibold text-text-primary mb-2">{day}</div>
                  <div className="space-y-2.5 border-l border-border-subtle ml-1.5 pl-4">
                    {entries.map((entry) => (
                      <div key={`${entry._type}-${entry.id}`} className="relative">
                        <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-bg-elevated border border-border-strong" />
                        {entry._type === 'comment' ? (
                          <div className="px-3 py-2 bg-bg-elevated border border-border-default rounded-lg">
                            <div className="text-sm text-text-primary">{entry.body}</div>
                            <div className="mt-0.5 text-[11px] text-text-faint">
                              {entry.author} · {fmtDate(entry.ts)}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-text-muted">
                              {entry.kind === 'payment' && (
                                <CreditCard className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" />
                              )}
                              {entry.message}
                            </span>
                            <span className="text-[11px] text-text-faint whitespace-nowrap">
                              {fmtDate(entry.ts)}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>

        {/* ── Right column ── */}
        <div className="space-y-5">
          {/* Notes */}
          <SectionCard title="Notes">
            <p className="text-sm text-text-muted">
              {order.customer_ip ? `CustomerIP: ${order.customer_ip}` : 'No notes yet.'}
            </p>
          </SectionCard>

          {/* Additional details */}
          {(order.client_order_id || order.order_type || Object.keys(utm).length > 0) && (
            <SectionCard title="Additional details">
              <div className="space-y-2.5">
                <DetailField label="clientOrderId" value={order.client_order_id} />
                <DetailField label="orderType" value={order.order_type} />
                {Object.entries(utm).map(([k, v]) => (
                  <DetailField key={k} label={k} value={v} />
                ))}
              </div>
            </SectionCard>
          )}

          {/* Channel information */}
          <SectionCard title="Channel information">
            <div className="space-y-2.5">
              <DetailField label="Channel" value={order.funnel_name || 'Shopify'} />
              <DetailField label="Gateway" value={order.gateway || '—'} />
            </div>
          </SectionCard>

          {/* Customer */}
          <SectionCard title="Customer">
            <div className="flex items-center gap-2.5 mb-3">
              <CustomerAvatar order={order} />
              <span className="text-sm font-medium text-accent-text">{customerName(order)}</span>
              <span className="text-xs text-text-faint underline">
                {orderCount} order{orderCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">
                  Contact information
                </div>
                <div className="text-sm text-accent-text break-all">
                  {order.customer_email || '—'}
                </div>
                <div className="text-sm text-text-muted">
                  {order.customer_phone || 'No phone number'}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">
                  Shipping address
                </div>
                <div className="text-sm text-text-primary">
                  {addressLines(ship) ||
                    [order.destination_city, order.destination_state, order.destination_country]
                      .filter(Boolean)
                      .join(', ') ||
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
              <div className="flex gap-2 pt-1">
                <input
                  placeholder="Text this buyer via Klaviyo SMS..."
                  disabled
                  title="Klaviyo SMS arrives with the messaging phase"
                  className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint disabled:opacity-60"
                />
                <Button variant="secondary" size="md" disabled title="Klaviyo SMS arrives with the messaging phase">
                  <Send className="w-3.5 h-3.5" /> Send
                </Button>
              </div>
            </div>
          </SectionCard>

          {/* Conversion summary */}
          <SectionCard title="Conversion summary">
            <div className="space-y-2">
              {[
                {
                  label: 'First touch',
                  value: utm.utm_source ? `${utm.utm_source} paid` : null,
                },
                { label: 'Last touch', value: null },
                { label: 'Checkout', value: order.funnel_name ? `on ${order.funnel_name}` : null },
                { label: 'Placed order', value: fmtDate(order.created_at), always: true },
              ].map((row) => (
                <div key={row.label} className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                      row.value || row.always ? 'bg-emerald-400' : 'bg-border-strong'
                    }`}
                  />
                  <span className="text-sm text-text-muted">
                    {row.label}
                    {row.value ? ` — ${row.value}` : row.always ? '' : ' — pending tracking'}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Order risk */}
          <SectionCard title="Order risk">
            <div className="flex items-center gap-2 text-sm text-text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Low risk of fraud
            </div>
            <div className="mt-2 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full w-[12%] bg-emerald-400 rounded-full" />
            </div>
          </SectionCard>

          {/* Tags */}
          <SectionCard title="Tags">
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                placeholder="Add tag"
                className="flex-1 px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
              <Button variant="secondary" size="md" onClick={addTag} disabled={!tagInput.trim()}>
                <Plus className="w-3.5 h-3.5" /> Add
              </Button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {(order.tags || []).length === 0 ? (
                <span className="text-xs text-text-faint">No tags yet</span>
              ) : (
                order.tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 text-xs rounded-full bg-bg-elevated border border-border-default text-text-muted"
                  >
                    {t}
                  </span>
                ))
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
