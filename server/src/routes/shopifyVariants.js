// SHOPIFY VARIANT SEARCH — read-only typeahead for the page builder's
// product/variant pickers (order_bump, whop_checkout wiring).
// Mounted at /api/v1/shopify-variants (authenticate + funnels:access).
//
// WHY A SERVER PROXY AT ALL: the Shopify Admin token must never reach the
// browser. This route is the ONLY thing it does — a bounded, read-only
// `productVariants(query:)` lookup that returns ids, titles, display prices
// and thumbnails. It cannot mutate anything, and NOTHING it returns is ever
// trusted as a price: the checkout re-prices every variant server-side
// (services/checkoutPricing.js). The `price` field here is a PICKER LABEL.
//
// Credentials are read from env at CALL time, never module-cached — the same
// posture as checkoutPricing.js, so a rotation does not require a redeploy.
// The credential travels in the X-Shopify-Access-Token HEADER and never in a
// URL, an argv, or an error message.
//
// FAILURE SEMANTICS (do not conflate):
//   missing/short q            -> 400 {code:'q_required'}
//   store/token not configured -> 503 {code:'shopify_not_configured'}
//   transport / timeout / 5xx  -> 503 {code:'shopify_unavailable'}
//   graphql errors in body     -> 503 {code:'shopify_unavailable'}
// A Shopify outage must read as an outage, never as "no products found" —
// an empty {variants:[]} is a POSITIVE claim that the catalog has no match.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

// Spec'd bound. Shopify's own limit for this connection is 250; we ask for
// far less because this is a typeahead, not an export.
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const Q_MIN = 2;
export const Q_MAX = 120;
export const FETCH_TIMEOUT_MS = 8_000;

function shopifyCreds() {
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
}

const VARIANT_SEARCH_QUERY = `
query variantSearch($q: String!, $first: Int!) {
  productVariants(first: $first, query: $q) {
    edges {
      node {
        id
        title
        price
        sku
        availableForSale
        image { url }
        product { id title status featuredImage { url } }
      }
    }
  }
}`.trim();

/**
 * Numeric variant id from a Shopify gid. The BUMP CONTRACT stores the numeric
 * form (checkoutPublic re-adds the gid prefix via toVariantGid), so the picker
 * must write the same shape a human would have typed.
 * Returns '' for anything that is not a ProductVariant gid.
 */
export function numericVariantId(gid) {
  const m = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(String(gid || '').trim());
  return m ? m[1] : '';
}

/**
 * Shopify's search syntax treats `:`, `(`, `)` and quotes as operators. An
 * operator smuggled in from the box would silently change WHICH products are
 * searched, so the term is quoted and its quotes/backslashes escaped —
 * the whole box becomes one literal term.
 */
export function buildSearchQuery(raw) {
  const term = String(raw || '').trim().slice(0, Q_MAX).replace(/[\\"]/g, '\\$&');
  return `"${term}"`;
}

/**
 * Pure: GraphQL edges -> the wire shape {variant_id, title, product_title,
 * price, image}. Total function — malformed nodes are DROPPED, never thrown
 * on, and a node without a resolvable numeric id is not addressable by the
 * bump contract so it cannot be offered as a choice.
 */
export function mapVariantNodes(edges) {
  const out = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    const n = edge && typeof edge === 'object' ? edge.node : null;
    if (!n || typeof n !== 'object') continue;
    const variantId = numericVariantId(n.id);
    if (!variantId) continue;
    const product = n.product && typeof n.product === 'object' ? n.product : {};
    out.push({
      variant_id: variantId,
      title: n.title == null ? '' : String(n.title),
      product_title: product.title == null ? '' : String(product.title),
      price: n.price == null ? '' : String(n.price),
      image:
        (n.image && typeof n.image === 'object' && n.image.url ? String(n.image.url) : '') ||
        (product.featuredImage && typeof product.featuredImage === 'object' && product.featuredImage.url
          ? String(product.featuredImage.url)
          : ''),
      sku: n.sku == null ? '' : String(n.sku),
      available: n.availableForSale === true,
      product_status: product.status == null ? '' : String(product.status),
    });
  }
  return out;
}

export class ShopifyUnavailableError extends Error {
  constructor(reason, code = 'shopify_unavailable') {
    super(reason);
    this.name = 'ShopifyUnavailableError';
    this.code = code;
    this.status = 503;
  }
}

async function postGraphql(query, variables) {
  const { store, token, apiVersion } = shopifyCreds();
  // Missing config is an OPS outage, not an empty catalog.
  if (!store || !token) throw new ShopifyUnavailableError('not configured', 'shopify_not_configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`https://${store}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError (our 8s timeout) and DNS/socket failures are the same class
    // to the caller: retryable. err.message never carries the token.
    throw new ShopifyUnavailableError(`fetch_failed ${err.name}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new ShopifyUnavailableError(`http_${resp.status}`);
  let payload;
  try {
    payload = await resp.json();
  } catch {
    throw new ShopifyUnavailableError('bad_json');
  }
  // A GraphQL 200 carrying `errors` is a FAILED call — reading data through it
  // would publish a truncated catalog as if it were the whole one.
  if (payload?.errors) throw new ShopifyUnavailableError('graphql_errors');
  return payload?.data || {};
}

/**
 * GET /search?q=&limit=
 * -> 200 { success:true, data:{ variants:[...] } }
 */
export async function searchHandler(req, res) {
  const raw = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  if (raw.length < Q_MIN) {
    return res.status(400).json({
      success: false,
      error: { code: 'q_required', message: `Search needs at least ${Q_MIN} characters` },
    });
  }
  const asked = parseInt(req.query?.limit, 10);
  const first = Number.isFinite(asked) && asked > 0 ? Math.min(asked, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;

  try {
    const data = await postGraphql(VARIANT_SEARCH_QUERY, { q: buildSearchQuery(raw), first });
    const variants = mapVariantNodes(data?.productVariants?.edges);
    return res.json({ success: true, data: { variants } });
  } catch (err) {
    if (err instanceof ShopifyUnavailableError) {
      console.error('[shopify-variants] search unavailable:', err.code, err.message);
      return res.status(503).json({
        success: false,
        error: {
          code: err.code,
          message:
            err.code === 'shopify_not_configured'
              ? 'Shopify is not configured on this environment'
              : 'Shopify product search is temporarily unavailable — try again',
        },
      });
    }
    console.error('[shopify-variants] search failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'search_failed', message: 'Product search failed' } });
  }
}

router.use(authenticate, requirePermission('funnels', 'access'));
router.get('/search', searchHandler);

export default router;
