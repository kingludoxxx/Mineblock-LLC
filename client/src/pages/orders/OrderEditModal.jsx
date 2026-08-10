// Edit a settled order — line items and shipping address, after purchase.
//
// THE DIFFERENCE FROM THE REFERENCE, AND WHY IT MATTERS:
// funnel-os's OrderEditModal shows no money at all. The operator changes
// quantities, clicks Save, and learns the financial impact from a toast — or
// from a decline. Every number on this screen exists because that is the wrong
// order to learn things in: the delta is computed SERVER-SIDE (the same code
// path the commit uses, so the number shown is the number recorded) and
// re-computed on every change, before Save is ever enabled.
//
// THE SENTENCE THIS SCREEN MUST NOT LET AN OPERATOR MISREAD:
// saving does NOT charge or refund anything. It corrects the goods and parks
// the difference as a settlement a human resolves. The banner says so in the
// same breath as the amount, because an amount shown without that sentence
// reads as "this will be charged".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info, Minus, Package, Plus, Trash2 } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import api from '../../services/api';

const field =
  'w-full px-2.5 py-1.5 text-sm bg-bg-card border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';

// Intl throws a RangeError on an unknown currency code, and these values come
// straight off the money path — exactly where a malformed code would appear.
// A bad code must degrade to plain text, never blank the screen an operator is
// using to decide what to charge.
const money = (v, cur = 'USD') => {
  if (v == null) return '—';
  try {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: cur || 'USD' });
  } catch {
    return `${cur || ''} ${Number(v).toFixed(2)}`.trim();
  }
};
const signed = (v, cur) => `${Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : ''}${money(Math.abs(Number(v) || 0), cur)}`;

// Operator-facing copy for every error code the server can return. An unmapped
// code is shown RAW rather than replaced by a friendly lie — a debuggable
// slug beats a reassuring sentence that hides the fault.
const SAVE_ERRORS = {
  edit_id_required: 'The edit token went missing — close and reopen this dialog.',
  bad_edit_id: 'The edit token is malformed — close and reopen this dialog.',
  bad_base_version: 'The version this edit was based on is invalid — reopen the dialog.',
  stale_version: 'Someone else edited this order while you were working. Reopen to see their change, then redo yours — nothing here was applied.',
  no_changes: 'Nothing changed, so there is nothing to save.',
  not_editable: 'This order can no longer be edited — its money is being unwound.',
  already_fulfilled: 'This order is already fulfilled. The goods have shipped, so the lines can no longer be changed.',
  invalid_variant: "That variant can't be resolved in Shopify — nothing was changed.",
  currency_mismatch: 'The store currency disagrees with this order. Nothing was changed — check the store currency configuration.',
  unpriced_line: 'A line on this order has no recorded price, so the new total cannot be computed. Nothing was changed.',
  invalid_address: 'The address needs a street line.',
  too_many_lines: 'That would put too many lines on one order.',
  pricing_unavailable: "Shopify didn't answer, so the price could not be confirmed. Nothing was changed — try again in a moment.",
  session_not_found: 'The checkout session behind this order could not be found.',
};

const ADDRESS_FIELDS = [
  ['address1', 'Address'],
  ['address2', 'Apt, suite, etc.'],
  ['city', 'City'],
  ['state', 'State / province'],
  ['zip', 'Postal code'],
  ['country', 'Country'],
];

const emptyAddress = () => ({ address1: '', address2: '', city: '', state: '', zip: '', country: '' });

export default function OrderEditModal({ open, orderId, onClose, onSaved }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [qty, setQty] = useState({});           // variant_id -> quantity
  const [addVariant, setAddVariant] = useState('');
  const [addQty, setAddQty] = useState(1);
  const [pendingAdds, setPendingAdds] = useState([]);
  const [editAddr, setEditAddr] = useState(false);
  const [addr, setAddr] = useState(emptyAddress());
  const [preview, setPreview] = useState({ status: 'idle', data: null, error: null });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // ONE idempotency token per modal-open, reused across every retry. This is
  // the client half of the replay guarantee: a re-clicked Save after a timeout
  // maps to the SAME server-side edit row and replays instead of applying
  // twice. The empty dependency on `open` is load-bearing — regenerating it
  // per render would defeat the whole mechanism.
  const editId = useMemo(() => {
    if (!open) return '';
    const raw = globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`;
    return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  }, [open]);

  const load = useCallback(async () => {
    setState({ status: 'loading', data: null, error: null });
    try {
      const res = await api.get(`/order-edit/by-order/${orderId}`);
      const d = res.data?.data || null;
      setState({ status: 'ready', data: d, error: null });
      if (d?.linked) {
        const next = {};
        for (const li of d.session.line_items || []) next[String(li.variant_id)] = Number(li.quantity) || 0;
        setQty(next);
        setAddr({ ...emptyAddress(), ...(d.session.shipping_address || {}) });
      }
    } catch (err) {
      setState({ status: 'ready', data: null, error: err.response?.data?.error || 'Failed to load this order' });
    }
  }, [orderId]);

  useEffect(() => {
    if (!open) return;
    setQty({}); setAddVariant(''); setAddQty(1); setPendingAdds([]);
    setEditAddr(false); setPreview({ status: 'idle', data: null, error: null });
    setSaveError(null);
    load();
  }, [open, load]);

  const linked = state.data?.linked ? state.data : null;
  const currency = linked?.session?.currency || 'USD';
  const baseVersion = linked?.version ?? 0;
  const original = useMemo(
    () => (linked?.session?.line_items || []).map((li) => ({ ...li, _vid: String(li.variant_id) })),
    [linked]
  );

  // The request body, derived from the form. Only lines whose quantity ACTUALLY
  // changed are sent — submitting every line would make the server record a
  // change for lines nobody touched.
  const body = useMemo(() => {
    const line_edits = original
      .filter((li) => qty[li._vid] !== undefined && qty[li._vid] !== (Number(li.quantity) || 0))
      .map((li) => ({ variant_id: li._vid, quantity: qty[li._vid] }));
    const out = {};
    if (line_edits.length) out.line_edits = line_edits;
    if (pendingAdds.length) out.add_lines = pendingAdds;
    if (editAddr && String(addr.address1 || '').trim()) out.shipping_address = addr;
    return out;
  }, [original, qty, pendingAdds, editAddr, addr]);

  const hasInput = Object.keys(body).length > 0;

  // Debounced server-side preview. Every number the operator sees comes from
  // the SAME computation the commit performs — a client-side estimate would be
  // a second implementation of the money arithmetic, free to disagree.
  useEffect(() => {
    if (!open || !linked || !hasInput) {
      setPreview({ status: 'idle', data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setPreview((p) => ({ ...p, status: 'loading' }));
    const t = setTimeout(async () => {
      try {
        const res = await api.post(`/order-edit/${linked.session.id}/preview`, body);
        if (!cancelled) setPreview({ status: 'ready', data: res.data?.data || null, error: null });
      } catch (err) {
        if (!cancelled) {
          const code = err.response?.data?.error;
          setPreview({ status: 'ready', data: null, error: SAVE_ERRORS[code] || code || 'Preview failed' });
        }
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, linked, hasInput, body]);

  const p = preview.data;
  const dirty = Boolean(p?.dirty);

  const stepQty = (vid, delta) => setQty((q) => ({ ...q, [vid]: Math.max(0, (q[vid] ?? 0) + delta) }));

  const queueAdd = () => {
    const vid = addVariant.trim();
    if (!vid) return;
    setPendingAdds((list) => [...list.filter((a) => a.variant_id !== vid), { variant_id: vid, quantity: Math.max(1, Number(addQty) || 1) }]);
    setAddVariant(''); setAddQty(1);
  };

  const save = async () => {
    if (!linked) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await api.post(`/order-edit/${linked.session.id}/commit`, {
        ...body, edit_id: editId, base_version: baseVersion,
      });
      onSaved?.(res.data?.data || null);
      onClose?.();
    } catch (err) {
      const code = err.response?.data?.error;
      setSaveError(SAVE_ERRORS[code] || (typeof code === 'string' && code) || 'The edit failed — nothing was changed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit order" size="xl">
      <div className="max-h-[70vh] overflow-y-auto -mx-1 px-1 space-y-4">
        {state.status === 'loading' && (
          <div className="py-12 text-center text-sm text-text-muted">Loading order…</div>
        )}

        {state.status === 'ready' && state.error && (
          <div className="py-10 text-center text-sm text-danger">{state.error}</div>
        )}

        {/* An order with no checkout session behind it is a legitimate answer,
            not a bug. Say which of the three reasons it is. */}
        {state.status === 'ready' && !state.error && !linked && (
          <div className="px-4 py-3 text-sm text-text-muted bg-bg-elevated border border-border-default rounded-lg">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-text-faint" />
              <div>
                <p className="text-text-primary font-medium">This order can't be edited here.</p>
                <p className="mt-1">
                  {{
                    manual_order_has_no_checkout_session:
                      'It was recorded by hand, so there is no checkout session behind it. Edit it in Shopify instead.',
                    no_checkout_session_for_this_store_order:
                      'It came straight from Shopify rather than through a funnel checkout, so this dashboard has no line-item snapshot to correct. Edit it in Shopify instead.',
                    order_never_mirrored_to_shopify:
                      'It was never mirrored into the store.',
                    session_row_missing:
                      'The checkout session it points at no longer exists.',
                  }[state.data?.reason] || state.data?.reason}
                </p>
              </div>
            </div>
          </div>
        )}

        {linked && !linked.editable && (
          <div className="px-4 py-3 text-sm bg-amber-500/10 border border-amber-500/25 rounded-lg text-amber-300">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {linked.not_editable_reason === 'already_fulfilled'
                  ? 'This order is already fulfilled — the goods have shipped, so its lines can no longer be changed.'
                  : `This order is not editable (${linked.not_editable_reason}).`}
              </span>
            </div>
          </div>
        )}

        {linked && linked.editable && (
          <>
            {/* ── the standing sentence ── */}
            <div className="px-3 py-2.5 text-xs text-text-muted bg-bg-elevated border border-border-default rounded-lg flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-faint" />
              <span>
                Saving corrects what the buyer <em>receives</em>. It does not charge or refund
                anything — the difference is recorded as a settlement for someone to action.
              </span>
            </div>

            {/* ── line items ── */}
            <div className="border border-border-subtle rounded-lg divide-y divide-border-subtle">
              {original.length === 0 && (
                <div className="px-4 py-6 text-sm text-text-muted">No line items on this order.</div>
              )}
              {original.map((li) => {
                // `??` only, never `||`: a legitimately-zero quantity means
                // "this line is being removed" and must not fall through to
                // the original quantity.
                const current = qty[li._vid] ?? (Number(li.quantity) || 0);
                const removed = current === 0;
                return (
                  <div key={li._vid} className={`flex items-center gap-3 px-3 py-2.5 ${removed ? 'opacity-60' : ''}`}>
                    <div className="w-8 h-8 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center shrink-0">
                      <Package className="w-3.5 h-3.5 text-text-faint" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary truncate">
                        {li.title || li.product_title || 'Item'}
                      </div>
                      <div className="text-[11px] text-text-faint truncate">
                        Variant {li._vid} · {money(li.price, currency)}
                      </div>
                    </div>
                    {removed ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/25">
                        remove
                      </span>
                    ) : null}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => stepQty(li._vid, -1)}
                        className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <input
                        value={current}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setQty((q) => ({ ...q, [li._vid]: Number.isFinite(n) ? Math.max(0, n) : 0 }));
                        }}
                        className="w-12 text-center px-1 py-1 text-sm bg-bg-card border border-border-default rounded-md text-text-primary"
                      />
                      <button
                        type="button"
                        onClick={() => stepQty(li._vid, 1)}
                        className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                        aria-label="Increase quantity"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {pendingAdds.map((a) => (
                <div key={`add-${a.variant_id}`} className="flex items-center gap-3 px-3 py-2.5 bg-emerald-500/5">
                  <div className="w-8 h-8 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center shrink-0">
                    <Plus className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">
                      {(p?.changes || []).find((c) => c.variant_id === a.variant_id)?.title || 'Adding…'}
                    </div>
                    <div className="text-[11px] text-text-faint">
                      Variant {a.variant_id} · × {a.quantity} ·{' '}
                      {/* The price is whatever the SERVER resolved. Showing the
                          operator's own number here would imply they set it. */}
                      {money((p?.changes || []).find((c) => c.variant_id === a.variant_id)?.price, currency)} each
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingAdds((l) => l.filter((x) => x.variant_id !== a.variant_id))}
                    className="p-1 rounded-md text-text-muted hover:text-danger hover:bg-bg-hover cursor-pointer"
                    aria-label="Remove pending line"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* ── add a variant ── */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1.5">Add a variant</div>
              <div className="flex gap-2">
                <input
                  value={addVariant}
                  onChange={(e) => setAddVariant(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && queueAdd()}
                  placeholder="Shopify variant ID"
                  className={field}
                />
                <input
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  className={`${field} w-20 text-center`}
                />
                <Button variant="secondary" size="md" onClick={queueAdd} disabled={!addVariant.trim()}>
                  Add
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                The price comes from Shopify — it is never taken from this screen.
              </p>
            </div>

            {/* ── address ── */}
            <div>
              <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={editAddr}
                  onChange={(e) => setEditAddr(e.target.checked)}
                  className="accent-accent"
                />
                Update the shipping address
              </label>
              {editAddr && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {ADDRESS_FIELDS.map(([key, label]) => (
                    <input
                      key={key}
                      value={addr[key] || ''}
                      onChange={(e) => setAddr((a) => ({ ...a, [key]: e.target.value }))}
                      placeholder={label}
                      className={`${field} ${key === 'address1' ? 'col-span-2' : ''}`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ── THE DELTA SUMMARY ── */}
            <div className="border border-border-default rounded-lg bg-bg-elevated px-4 py-3 space-y-2 text-sm">
              {preview.status === 'loading' && (
                <div className="text-text-muted text-xs">Re-pricing…</div>
              )}
              {preview.error && <div className="text-danger text-xs">{preview.error}</div>}
              {!hasInput && !preview.error && (
                <div className="text-text-muted text-xs">Change a quantity, add a line, or edit the address to see the impact.</div>
              )}
              {p && (
                <>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Goods before</span>
                    <span className="text-text-primary">{money(p.subtotal_before, currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Goods after</span>
                    <span className="text-text-primary">{money(p.subtotal_after, currency)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-text-faint">
                    <span>Shipping, tax and discount are unchanged by an edit</span>
                    <span>
                      {money(p.shipping, currency)} · {money(p.tax, currency)} · −{money(p.discount_amount, currency)}
                    </span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-border-subtle">
                    <span className="text-text-muted">Order value after this edit</span>
                    <span className="text-text-primary font-medium">{money(p.owed_after, currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Already captured</span>
                    <span className="text-text-primary font-medium">{money(p.captured_total, currency)}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-border-subtle">
                    <span className="text-text-primary font-semibold">This edit changes the amount owed by</span>
                    <span
                      className={`font-semibold ${
                        Number(p.total_delta) > 0 ? 'text-emerald-400'
                          : Number(p.total_delta) < 0 ? 'text-rose-300' : 'text-text-primary'
                      }`}
                    >
                      {signed(p.total_delta, currency)}
                    </span>
                  </div>

                  {p.settlement && p.session_paid && (
                    <div className="mt-1 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-200 text-xs flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        Saving records a <strong>{money(p.settlement.amount, currency)}{' '}
                        {p.settlement.direction === 'charge' ? 'charge owed by the buyer' : 'refund owed to the buyer'}</strong>{' '}
                        as an open settlement. <strong>No card is touched by this save.</strong>
                      </span>
                    </div>
                  )}
                  {p.settlement && !p.session_paid && (
                    <div className="mt-1 text-xs text-text-faint">
                      This order has not been captured yet, so there is nothing to settle — the
                      corrected cart is simply what will be charged.
                    </div>
                  )}
                </>
              )}
            </div>

            {saveError && (
              <div className="px-3 py-2.5 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg">
                {saveError}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border-subtle">
        <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          size="md"
          loading={saving}
          onClick={save}
          // Save is gated on a SERVER-confirmed change, not on the form looking
          // touched: a preview that failed, or one that came back clean, means
          // there is nothing safe to record.
          disabled={!linked?.editable || !dirty || preview.status === 'loading' || Boolean(preview.error)}
        >
          Save changes
        </Button>
      </div>
    </Modal>
  );
}
