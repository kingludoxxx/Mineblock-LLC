// Create order — an OPERATOR-RECORDED order. Bookkeeping only.
//
// WHAT THE REFERENCE DOES: funnel-os's CreateOrderModal posts to
// /orders/manual, whose service mints a hosted Whop payment link through the
// live gateway client and hands the operator a URL to send the buyer. That
// half is a gateway call-site on the money path and is deliberately NOT ported
// here — see the block comment on POST /manual in server/src/routes/orders.js
// for exactly what the integrator would add, and where.
//
// WHAT THIS IS: a record of an order that was taken somewhere else (phone,
// DM, in person, a marketplace). It creates one crm_orders row flagged
// source='manual' that flows into the list, the KPI strip and the CSV export.
// No card is charged, no gateway is called, no checkout session exists. The
// banner says so, because an operator who thinks this took a payment will
// under-collect and never find out from this screen.
import { useMemo, useState } from 'react';
import { Info, Plus, Trash2 } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import api from '../../services/api';

const emptyLine = () => ({ title: '', sku: '', quantity: 1, price: '' });

const money = (v) =>
  Number(v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const field =
  'w-full px-2.5 py-1.5 text-sm bg-bg-card border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';

export default function CreateOrderModal({ open, onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [financialStatus, setFinancialStatus] = useState('paid');
  const [shipping, setShipping] = useState('');
  const [discounts, setDiscounts] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const validLines = lines.filter(
    (l) => l.title.trim() && Number(l.quantity) > 0 && l.price !== '' && Number(l.price) >= 0
  );

  // Mirrors the server's arithmetic exactly (subtotal + shipping − discounts).
  // The server recomputes it regardless — this is a preview, never the source
  // of the stored total.
  const { subtotal, total } = useMemo(() => {
    const sub = validLines.reduce((s, l) => s + Number(l.price) * Number(l.quantity), 0);
    return {
      subtotal: sub,
      total: sub + Number(shipping || 0) - Number(discounts || 0),
    };
  }, [validLines, shipping, discounts]);

  const canSave = email.trim() && validLines.length > 0 && total >= 0 && !saving;

  const setLine = (i, patch) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const reset = () => {
    setEmail('');
    setFirstName('');
    setLastName('');
    setFinancialStatus('paid');
    setShipping('');
    setDiscounts('');
    setNote('');
    setLines([emptyLine()]);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/orders/manual', {
        customer_email: email.trim(),
        customer_first_name: firstName.trim(),
        customer_last_name: lastName.trim(),
        financial_status: financialStatus,
        shipping_price: Number(shipping || 0),
        total_discounts: Number(discounts || 0),
        note: note.trim(),
        line_items: validLines.map((l) => ({
          title: l.title.trim(),
          sku: l.sku.trim() || undefined,
          quantity: Number(l.quantity),
          price: Number(l.price),
        })),
      });
      reset();
      onCreated?.(res.data?.data?.order || null);
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record this order');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record an order" size="xl">
      <div className="space-y-4">
        <div className="flex gap-2.5 px-3 py-2.5 rounded-lg bg-bg-elevated border border-border-default">
          <Info className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />
          <p className="text-xs text-text-muted leading-relaxed">
            This records an order that was taken elsewhere. <strong>No payment is charged</strong>{' '}
            and no gateway is contacted — the row is tagged{' '}
            <span className="text-text-primary">manual</span> and appears in your list, stats and
            exports. To take a real payment, send the customer through a funnel checkout.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          <label className="col-span-3 block">
            <span className="text-[11px] text-text-faint">Customer email *</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-text-faint">First name</span>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-text-faint">Last name</span>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-text-faint">Payment status</span>
            <select
              value={financialStatus}
              onChange={(e) => setFinancialStatus(e.target.value)}
              className={`mt-1 ${field} cursor-pointer`}
            >
              {['paid', 'pending', 'partially_paid', 'refunded', 'voided'].map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider text-text-faint">Line items</div>
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={l.title}
                onChange={(e) => setLine(i, { title: e.target.value })}
                placeholder="Product title *"
                className={`flex-1 ${field}`}
              />
              <input
                value={l.sku}
                onChange={(e) => setLine(i, { sku: e.target.value })}
                placeholder="SKU"
                className={`w-24 ${field}`}
              />
              <input
                value={l.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
                inputMode="numeric"
                placeholder="Qty"
                className={`w-16 text-center ${field}`}
              />
              <input
                value={l.price}
                onChange={(e) => setLine(i, { price: e.target.value })}
                inputMode="decimal"
                placeholder="Price"
                className={`w-20 text-right ${field}`}
              />
              <button
                onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                disabled={lines.length === 1}
                className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary border border-dashed border-border-strong rounded-md cursor-pointer transition-colors"
          >
            <Plus className="w-3 h-3" /> Add line
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <label className="block">
            <span className="text-[11px] text-text-faint">Shipping</span>
            <input
              value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-text-faint">Discounts</span>
            <input
              value={discounts}
              onChange={(e) => setDiscounts(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className={`mt-1 ${field}`}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-[11px] text-text-faint">Internal note</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Where this order came from"
            className={`mt-1 ${field}`}
          />
        </label>

        <div className="flex items-center justify-between pt-3 border-t border-border-subtle text-sm">
          <span className="text-text-muted">
            Subtotal {money(subtotal)}
            {Number(shipping || 0) ? ` + ${money(shipping)} shipping` : ''}
            {Number(discounts || 0) ? ` − ${money(discounts)} discount` : ''}
          </span>
          <span className="text-base font-semibold text-text-primary">{money(total)}</span>
        </div>

        {total < 0 && (
          <p className="text-xs text-danger">
            Discounts exceed the order value — the total cannot be negative.
          </p>
        )}
        {error && (
          <div className="px-3 py-2 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={save} loading={saving} disabled={!canSave}>
            Record order
          </Button>
        </div>
      </div>
    </Modal>
  );
}
