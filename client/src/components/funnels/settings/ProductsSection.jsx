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
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Link2, AlertTriangle } from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import { SettingsCard } from './ui';
import WhopMappingModal from './WhopMappingModal';

const ERR = {
  shopify_not_configured: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Shopify is temporarily unavailable — try again.',
  rate_limited: 'Too many syncs — wait a moment and try again.',
  internal_error: 'Server error — try again.',
};
const errOf = (e, fallback) => {
  const err = e?.response?.data?.error;
  return { text: ERR[err?.code] || err?.message || fallback, retryable: err?.retryable !== false };
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
  const [mappedCount, setMappedCount] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');

  const loadProducts = useCallback(async () => {
    if (!funnelId) return;
    setLoading(true);
    try {
      const res = await api.get(`/funnel-commerce/${funnelId}/products`);
      setProducts(res.data?.data?.products || []);
      setErr(null);
    } catch (e) {
      setErr(errOf(e, 'Could not load the synced catalog.'));
      // The stored snapshot is unknown, NOT known-empty — keep whatever the
      // last good read produced rather than claiming the catalog is empty.
    } finally {
      setLoading(false);
    }
  }, [funnelId]);

  const loadMapped = useCallback(async () => {
    if (!funnelId) return;
    try {
      const res = await api.get(`/funnel-commerce/${funnelId}/whop/mappings`);
      setMappedCount(res.data?.data?.mapped_count || 0);
    } catch {
      setMappedCount(0);
    }
  }, [funnelId]);

  useEffect(() => { loadProducts(); loadMapped(); }, [loadProducts, loadMapped]);

  const sync = async () => {
    setSyncing(true); setErr(null); setNote('');
    try {
      const res = await api.post(`/funnel-commerce/${funnelId}/products/sync`);
      const d = res.data?.data || {};
      setProducts(d.products || []);
      setNote(
        `${d.synced} product${d.synced === 1 ? '' : 's'} synced`
        + (d.removed ? ` · ${d.removed} removed (gone from Shopify)` : '')
      );
    } catch (e) {
      setErr(errOf(e, 'Product sync failed.'));
    } finally {
      setSyncing(false);
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
          {/* No Retry against a dead credential — it just burns operator time. */}
          {err.retryable && (
            <Button variant="secondary" size="sm" onClick={sync} loading={syncing}>
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </Button>
          )}
        </div>
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
          <span className="text-xs text-text-faint">{mappedCount} mapped so far</span>
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
