// Shopify product ↔ Whop product mapper — opened from Commerce → Products.
// Layout follows the reference tool (search bar, one row per Shopify product,
// a status chip and a target <select> per row, a footer with the auto-map
// action); colours follow OUR dark theme, not the reference's light one.
//
// SERVER CONTRACT (routes/funnelCommerce.js, /api/v1/funnel-commerce):
//   GET    /:funnelId/whop/mappings                -> { mappings, mapped_count }
//   PUT    /:funnelId/whop/mappings                <- { shopify_product_id, … }
//   DELETE /:funnelId/whop/mappings/:mappingId
//   POST   /:funnelId/whop/map                     -> auto-map every unmapped
//
// The <select>'s options are the Whop products this funnel ALREADY knows about
// (from any existing mapping) — so several Shopify products can point at one
// Whop product (a bundle). Discovering NEW Whop products is what "Map to Whop"
// does; this popup is for hand-corrections on top of it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Link2, Unlink, Loader2, Wand2 } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { makeSerialQueue } from './serialQueue';

const CLEAR_VALUE = '';

// Server error codes -> operator prose. Anything unknown falls through to its
// own message, never a blank toast.
const ERR = {
  no_products: 'Sync the Shopify catalog first — there is nothing to map yet.',
  whop_not_configured: 'Whop is not configured for this funnel — add the API key and company ID in Payments first.',
  whop_auth_error: 'Whop rejected our credentials. This needs operator attention; retrying will not help.',
  whop_unavailable: 'Whop is temporarily unavailable — try again.',
  internal_error: 'Server error — try again.',
};
const errText = (e, fallback) => {
  const err = e?.response?.data?.error;
  return ERR[err?.code] || err?.message || fallback;
};

export default function WhopMappingModal({ funnelId, products, onClose, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [mapping, setMapping] = useState(false);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const enqueueRef = useRef(makeSerialQueue()); // one write at a time

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/funnel-commerce/${funnelId}/whop/mappings`);
      setRows(res.data?.data?.mappings || []);
      setErr('');
    } catch (e) {
      setErr(errText(e, 'Could not load the mappings.'));
    } finally {
      setLoading(false);
    }
  }, [funnelId]);

  useEffect(() => { load(); }, [load]);

  const byProduct = useMemo(
    () => Object.fromEntries(rows.map((m) => [String(m.shopify_product_id), m])),
    [rows]
  );

  // Every distinct Whop product this funnel already links to — lets several
  // Shopify products share one Whop target.
  const knownWhop = useMemo(() => {
    const seen = new Map();
    for (const m of rows) {
      if (m.whop_product_id && !seen.has(m.whop_product_id)) {
        seen.set(m.whop_product_id, { id: m.whop_product_id, name: m.whop_product_name || m.whop_product_id });
      }
    }
    return [...seen.values()];
  }, [rows]);

  const mappedCount = rows.filter((m) => m.status === 'mapped').length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => (p.title || '').toLowerCase().includes(q));
  }, [products, search]);

  const select = (product, value) => enqueueRef.current(async () => {
    setBusyId(product.shopify_product_id);
    setErr('');
    try {
      if (value === CLEAR_VALUE) {
        const existing = byProduct[String(product.shopify_product_id)];
        // Clearing removes the ROW, not just the link — an unmapped row carries
        // no information the product list does not already show.
        if (existing) await api.delete(`/funnel-commerce/${funnelId}/whop/mappings/${existing.id}`);
      } else {
        const whop = knownWhop.find((w) => w.id === value);
        await api.put(`/funnel-commerce/${funnelId}/whop/mappings`, {
          shopify_product_id: product.shopify_product_id,
          shopify_title: product.title || '',
          shopify_price: product.price,
          whop_product_id: value,
          whop_product_name: whop?.name || '',
        });
      }
      await load();
      onChanged?.();
    } catch (e) {
      setErr(errText(e, 'Mapping failed.'));
    } finally {
      setBusyId(null);
    }
  });

  const autoMap = () => enqueueRef.current(async () => {
    setMapping(true); setErr(''); setNote('');
    try {
      const res = await api.post(`/funnel-commerce/${funnelId}/whop/map`);
      const d = res.data?.data || {};
      const parts = [];
      if (d.matched) parts.push(`${d.matched} matched by name`);
      if (d.created) parts.push(`${d.created} created in Whop`);
      if (d.already) parts.push(`${d.already} already mapped`);
      if (d.skipped) parts.push(`${d.skipped} skipped (no product name)`);
      setNote(parts.length ? parts.join(' · ') : 'Nothing left to map.');
      // A partial run must never read as a clean one.
      if (Array.isArray(d.failed) && d.failed.length) {
        setErr(`${d.failed.length} product${d.failed.length === 1 ? '' : 's'} could not be mapped (${d.failed[0].code}). Fix the cause and run it again.`);
      }
      setRows(d.mappings || []);
      onChanged?.();
    } catch (e) {
      setErr(errText(e, 'Whop mapping failed.'));
    } finally {
      setMapping(false);
    }
  });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-3xl h-[80vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-3.5 border-b border-border-subtle">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-text-primary">Map products to Whop</h3>
            <p className="mt-0.5 text-xs text-text-faint">
              Link each Shopify product to a Whop product so the Whop checkout knows what&apos;s being sold.
              {' '}{mappedCount} of {products.length} mapped.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-5 py-3 border-b border-border-subtle">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search synced products…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
          </div>
        </div>

        {err && <p className="shrink-0 px-5 pt-3 text-sm text-danger">{err}</p>}
        {note && !err && <p className="shrink-0 px-5 pt-3 text-sm text-success">{note}</p>}

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {loading ? (
            <p className="text-sm text-text-muted py-8 text-center">Loading mappings…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-default px-3 py-10 text-center text-sm text-text-muted">
              {products.length === 0
                ? 'No synced products yet — run Sync Products first.'
                : 'No products match that search.'}
            </div>
          ) : (
            visible.map((p) => {
              const m = byProduct[String(p.shopify_product_id)];
              const mapped = m?.status === 'mapped';
              return (
                <div
                  key={p.shopify_product_id}
                  className="flex items-center gap-3 rounded-lg border border-border-default bg-bg-elevated/50 px-3 py-2"
                >
                  {p.image
                    ? <img src={p.image} alt="" className="w-9 h-9 shrink-0 rounded-md object-cover border border-border-default" />
                    : <div className="w-9 h-9 shrink-0 rounded-md bg-bg-elevated border border-border-default" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-primary">{p.title || 'Untitled product'}</div>
                    <div className="truncate text-xs text-text-faint">
                      {[p.vendor || null, `${p.variants_count} variant${p.variants_count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>

                  {mapped ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                      <Link2 className="w-3 h-3" />
                      <span className="max-w-[140px] truncate normal-case tracking-normal">{m.whop_product_name || m.whop_product_id}</span>
                      {m.source === 'created' && <span className="opacity-70">new</span>}
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/20">
                      <Unlink className="w-3 h-3" /> Not mapped
                    </span>
                  )}

                  <select
                    value={mapped ? m.whop_product_id : CLEAR_VALUE}
                    disabled={busyId === p.shopify_product_id || mapping}
                    onChange={(e) => select(p, e.target.value)}
                    className="w-44 shrink-0 px-2 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50 cursor-pointer"
                  >
                    <option value={CLEAR_VALUE}>— Not mapped —</option>
                    {knownWhop.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                  {busyId === p.shopify_product_id && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-faint" />}
                </div>
              );
            })
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-border-subtle">
          <p className="text-xs text-text-faint max-w-md">
            No match yet? Map to Whop creates one with the same name in a click.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={autoMap} loading={mapping}>
              <Wand2 className="w-3.5 h-3.5" /> Map to Whop
            </Button>
            <Button size="sm" onClick={onClose}>Done</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
