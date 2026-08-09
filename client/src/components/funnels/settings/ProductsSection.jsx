// Commerce → PRODUCTS. Three cards, matching the operator's reference tool:
//   1. Product catalog     — Sync Products (pulls the live Shopify catalog)
//   2. Whop product mapping — Map to Whop + "N mapped so far"
//   3. Synced products · N  — read-only, scrollable catalog readout
//
// Wired to routes/funnelCommerce.js (/api/v1/funnel-commerce):
//   GET  /:funnelId/products        -> { products, synced_at }
//   POST /:funnelId/products/sync   -> { synced, removed, products }
//   GET  /:funnelId/whop/mappings   -> { mappings, mapped_count }
//
// NEVER auto-syncs on open: the readout loads the stored snapshot only. A
// settings tab that fires a full catalog walk whenever it is opened is how a
// blank panel and an unbounded Shopify bill arrive together.
//
// PRICES SHOWN HERE ARE LABELS. The checkout re-prices every variant
// server-side before charging (services/checkoutPricing.js) — a stale row can
// misinform an operator but can never mis-charge a buyer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Link2, AlertTriangle } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { SettingsCard } from './ui';
import WhopMappingModal from './WhopMappingModal';

const ERR = {
  shopify_not_configured: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Shopify is temporarily unavailable — try again.',
  rate_limiter_unavailable: 'The rate limiter is down, so the sync is held back to protect live checkout pricing. Try again shortly.',
  rate_limited: 'Too many syncs — wait a moment and try again.',
  funnel_not_found: 'This funnel no longer exists — close and reopen Settings.',
  internal_error: 'Server error — try again.',
};
// `retryable` is only meaningful when the server sent it. A transport failure
// with no body must NOT be read as retryable-by-default on a credential error.
const errOf = (e, fallback) => {
  const err = e?.response?.data?.error;
  return {
    text: ERR[err?.code] || err?.message || fallback,
    retryable: err?.retryable !== false,
  };
};

// Truncation prose keyed on the server's reason. A truncated sync PRUNES
// NOTHING, and saying so is the difference between an operator trusting the
// list and an operator wondering why a product vanished.
const TRUNCATED = {
  cursor_missing: 'Shopify said there were more products but did not return a page cursor',
  page_cap: 'the catalog is larger than this sync walks in one run',
  throttled: 'Shopify throttled us partway through',
};

function money(amount, currency) {
  if (amount == null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export default function ProductsSection({ funnel }) {
  const funnelId = funnel?.id;
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // null = NOT KNOWN (never read, or the read failed). Zero is a claim; an
  // outage must not be allowed to make it. Rendered as '—'.
  const [mappedCount, setMappedCount] = useState(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [warn, setWarn] = useState('');

  // Every in-flight response is stamped with the funnel it was asked for. A
  // response that lands after the operator switched funnels (or closed the
  // modal) is DISCARDED — otherwise funnel A's catalog paints into funnel B.
  const liveRef = useRef(funnelId);
  useEffect(() => {
    liveRef.current = funnelId;
    return () => { liveRef.current = null; };
  }, [funnelId]);
  const stale = (id) => liveRef.current !== id;

  const loadProducts = useCallback(async () => {
    if (!funnelId) return;
    const askedFor = funnelId;
    setLoading(true);
    try {
      const res = await api.get(`/funnel-commerce/${askedFor}/products`);
      if (stale(askedFor)) return;
      setProducts(res.data?.data?.products || []);
      setErr(null);
    } catch (e) {
      if (stale(askedFor)) return;
      setErr({ ...errOf(e, 'Could not load the synced catalog.'), onRetry: 'read' });
      // The stored snapshot is unknown, NOT known-empty — keep whatever the
      // last good read produced rather than claiming the catalog is empty.
    } finally {
      if (!stale(askedFor)) setLoading(false);
    }
  }, [funnelId]);

  const loadMapped = useCallback(async () => {
    if (!funnelId) return;
    const askedFor = funnelId;
    try {
      const res = await api.get(`/funnel-commerce/${askedFor}/whop/mappings`);
      if (stale(askedFor)) return;
      setMappedCount(res.data?.data?.mapped_count ?? null);
    } catch {
      // NOT 0 — "we could not ask" is not "none are mapped".
      if (!stale(askedFor)) setMappedCount(null);
    }
  }, [funnelId]);

  useEffect(() => { loadProducts(); loadMapped(); }, [loadProducts, loadMapped]);

  const sync = async () => {
    const askedFor = funnelId;
    setSyncing(true); setErr(null); setNote(''); setWarn('');
    try {
      const res = await api.post(`/funnel-commerce/${askedFor}/products/sync`);
      if (stale(askedFor)) return;
      const d = res.data?.data || {};
      setProducts(d.products || []);
      setNote(
        `${d.synced} product${d.synced === 1 ? '' : 's'} synced`
        + (d.removed ? ` · ${d.removed} removed (gone from Shopify)` : '')
      );
      // A truncated walk is NOT a completed one, and the server pruned nothing
      // on it. Saying "synced" alone would imply the list is now the catalog.
      if (d.truncated) {
        setWarn(
          `Partial sync — ${TRUNCATED[d.truncated_reason] || 'the catalog walk did not reach the end'}. `
          + 'What was fetched is up to date and nothing was removed; run it again to continue.'
        );
      }
      loadMapped();
    } catch (e) {
      if (stale(askedFor)) return;
      setErr({ ...errOf(e, 'Product sync failed.'), onRetry: 'sync' });
    } finally {
      if (!stale(askedFor)) setSyncing(false);
    }
  };

  if (!funnelId) return <p className="text-sm text-text-muted">No funnel selected.</p>;

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-text-primary">Products</h3>

      {err && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
          <span className="flex items-start gap-2 text-sm text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {err.text}
          </span>
          {/* Retry repeats the action that FAILED. A failed READ used to retry
              by firing a full catalog SYNC — an expensive Shopify walk the
              operator never asked for. No Retry at all against a dead
              credential; it just burns operator time. */}
          {err.retryable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={err.onRetry === 'sync' ? sync : loadProducts}
              loading={err.onRetry === 'sync' ? syncing : loading}
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </Button>
          )}
        </div>
      )}
      {warn && (
        <p className="flex items-start gap-2 text-sm text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {warn}
        </p>
      )}
      {note && !err && <p className="text-sm text-success">{note}</p>}

      <SettingsCard
        title="Product catalog"
        description="Pull the latest catalog so this funnel's checkout, upsell and downsell pages offer up-to-date products and prices."
      >
        <Button onClick={sync} loading={syncing}>
          <RefreshCw className="w-4 h-4" /> Sync Products
        </Button>
      </SettingsCard>

      <SettingsCard
        title="Whop product mapping"
        description="Link each Shopify product to a Whop product so the Whop checkout knows what's being sold. No match yet? Create one with the same name in a click."
      >
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => setMapOpen(true)} disabled={products.length === 0}>
            <Link2 className="w-4 h-4" /> Map to Whop
          </Button>
          <span className="text-xs text-text-faint">
            {mappedCount == null ? 'mapped count unavailable' : `${mappedCount} mapped so far`}
          </span>
        </div>
        {products.length === 0 && (
          <p className="text-xs text-text-faint">Sync the catalog first — there is nothing to map yet.</p>
        )}
      </SettingsCard>

      <SettingsCard
        title={`Synced products${products.length ? ` · ${products.length}` : ''}`}
        description="Read-only view of the catalog snapshot this funnel offers from."
      >
        {loading ? (
          <p className="text-sm text-text-muted">Loading catalog…</p>
        ) : products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-default px-3 py-6 text-center text-sm text-text-muted">
            No products synced yet — run Sync Products to pull the Shopify catalog.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1 pr-1">
            {products.map((p) => (
              <div
                key={p.shopify_product_id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-elevated/50 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-text-primary">{p.title || 'Untitled product'}</div>
                  <div className="truncate text-xs text-text-faint">
                    {['main', `${p.variants_count} variant${p.variants_count === 1 ? '' : 's'}`]
                      .concat(p.status && p.status !== 'ACTIVE' ? [p.status.toLowerCase()] : [])
                      .join(' · ')}
                  </div>
                </div>
                {/* null price = no variant price known. Rendering that as
                    $0.00 would read as a free product. */}
                <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
                  {money(p.price, p.currency)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {mapOpen && (
        <WhopMappingModal
          funnelId={funnelId}
          products={products}
          onClose={() => setMapOpen(false)}
          onChanged={loadMapped}
        />
      )}
    </div>
  );
}
