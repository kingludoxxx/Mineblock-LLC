// Checkout pricing — AUTHORITATIVE server-side variant re-pricing (port of
// funnel-os checkout_pricing_service.py).
//
// SECURITY: the public create-session endpoint must NEVER trust a client-sent
// price. Every variant is resolved against the Shopify Admin API (GraphQL
// nodes query — the only call that returns price + product status +
// availableForSale in one batch) and the Shopify price is the one charged.
//
// Failure semantics (do NOT conflate — DECISIONS.md rule 4/5):
//   - transport / GraphQL failure  → throws PricingUnavailableError, mapped by
//     callers to a RETRYABLE 503 {code: "pricing_unavailable"}
//   - unknown / draft / archived / not-availableForSale variant → OMITTED from
//     the result so the caller rejects that line as invalid (422)
// A Shopify blip must never read as cart tampering, and tampering must never
// read as an outage. We never fall back to a client price — fail-closed.
//
// Credentials are read from env at CALL time, never module-cached (DECISIONS
// rule 1: rollback/rotation must not require a redeploy).

// Transport-class failure against the pricing backend. Callers map to 503.
export class PricingUnavailableError extends Error {
  constructor(reason = 'pricing_unavailable') {
    super(reason);
    this.name = 'PricingUnavailableError';
    this.code = 'pricing_unavailable';
    this.status = 503;
  }
}

// Short-lived authoritative-price cache: gid -> { expires, info|null }.
// null = known-bad (unknown/unpurchasable) — cached so a hammered bad cart
// doesn't hammer Shopify. Transport failures are NEVER cached.
const priceCache = new Map();
const PRICE_CACHE_TTL_MS = 60_000; // brief — never mask a real price change for long
const MAX_VARIANTS_PER_QUERY = 100;
const FETCH_TIMEOUT_MS = 6_000;
// Hard bound: the create-session endpoint is public and its variant ids are
// attacker-chosen, so a stream of distinct (mostly known-bad) gids would grow
// this Map without limit. When full we evict expired entries, then the oldest
// insertions, so the cache stays bounded by the ACTIVE catalog, not the
// all-time set of ids ever probed.
const PRICE_CACHE_MAX = 5_000;

function cacheSet(gid, entry) {
  if (priceCache.size >= PRICE_CACHE_MAX && !priceCache.has(gid)) {
    const now = Date.now();
    for (const [k, v] of priceCache) {
      if (v.expires <= now) priceCache.delete(k);
    }
    // Still over budget (a burst of live keys) — drop oldest-first (Map keeps
    // insertion order) until under the cap.
    while (priceCache.size >= PRICE_CACHE_MAX) {
      const oldest = priceCache.keys().next().value;
      if (oldest === undefined) break;
      priceCache.delete(oldest);
    }
  }
  priceCache.set(gid, entry);
}

export function toVariantGid(variantId) {
  const v = String(variantId).trim();
  return v.startsWith('gid://') ? v : `gid://shopify/ProductVariant/${v}`;
}

const VARIANT_PRICE_QUERY = `
query variantPrices($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      title
      price
      compareAtPrice
      availableForSale
      image { url }
      product { id title status featuredImage { url } }
    }
  }
}`.trim();

function shopifyCreds() {
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
}

async function postGraphql(query, variables) {
  const { store, token, apiVersion } = shopifyCreds();
  if (!store || !token) {
    // Missing config is an ops outage, not a bad cart — transport-class.
    throw new PricingUnavailableError('shopify_not_configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`https://${store}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new PricingUnavailableError(`fetch_failed ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new PricingUnavailableError(`http_${resp.status}`);
  }
  let payload;
  try {
    payload = await resp.json();
  } catch {
    throw new PricingUnavailableError('bad_json');
  }
  if (payload?.errors) {
    throw new PricingUnavailableError('graphql_errors');
  }
  return payload?.data || {};
}

/**
 * Resolve authoritative prices for a list of variant ids (numeric or gid).
 *
 * @returns {Promise<Record<string, object>>} map of variant gid ->
 *   { price, compare_at_price, currency, title, product_title, variant_title,
 *     image } for each RESOLVABLE, PURCHASABLE variant. Unknown variants,
 *   DRAFT/ARCHIVED products, and non-availableForSale variants are OMITTED.
 *   ACTIVE and UNLISTED products are both sellable (UNLISTED = hidden from
 *   storefront browsing but purchasable via funnel).
 * @throws {PricingUnavailableError} on any transport/GraphQL failure.
 */
export async function resolveVariantPrices(variantIds) {
  const gids = [];
  const seen = new Set();
  for (const vid of variantIds || []) {
    if (!vid) continue;
    const gid = toVariantGid(vid);
    if (!seen.has(gid)) {
      seen.add(gid);
      gids.push(gid);
    }
  }
  if (!gids.length) return {};

  const now = Date.now();
  const resolved = {};
  const toFetch = [];
  for (const gid of gids) {
    const cached = priceCache.get(gid);
    if (cached && cached.expires > now) {
      if (cached.info !== null) resolved[gid] = { ...cached.info };
      // cached known-bad (null) → intentionally omitted
    } else {
      toFetch.push(gid);
    }
  }
  if (!toFetch.length) return resolved;

  for (let start = 0; start < toFetch.length; start += MAX_VARIANTS_PER_QUERY) {
    const batch = toFetch.slice(start, start + MAX_VARIANTS_PER_QUERY);
    const data = await postGraphql(VARIANT_PRICE_QUERY, { ids: batch });
    const shopCurrency = String(data?.shop?.currencyCode || '').toUpperCase();
    const returnedIds = new Set();
    for (const node of data?.nodes || []) {
      if (!node || typeof node !== 'object' || !node.id) continue;
      const gid = node.id;
      returnedIds.add(gid);
      const product = node.product || {};
      const statusOk = ['ACTIVE', 'UNLISTED'].includes(String(product.status || '').toUpperCase());
      const purchasable = Boolean(node.availableForSale);
      const price = Number(node.price);
      if (!statusOk || !purchasable || !Number.isFinite(price) || price < 0) {
        cacheSet(gid, { expires: now + PRICE_CACHE_TTL_MS, info: null });
        continue;
      }
      // A compare-at at/below the sale price is not a real "was" price.
      let compareAt = Number(node.compareAtPrice);
      compareAt = Number.isFinite(compareAt) && compareAt > price
        ? Math.round(compareAt * 100) / 100
        : null;
      const info = {
        price: Math.round(price * 100) / 100,
        compare_at_price: compareAt,
        currency: shopCurrency,
        title: node.title || product.title || '',
        product_title: product.title || '',
        variant_title: node.title || '',
        image: node.image?.url || product.featuredImage?.url || '',
      };
      cacheSet(gid, { expires: now + PRICE_CACHE_TTL_MS, info });
      resolved[gid] = { ...info };
    }
    // A null node (id not returned at all) = unknown variant → known-bad.
    for (const gid of batch) {
      if (!returnedIds.has(gid)) {
        cacheSet(gid, { expires: now + PRICE_CACHE_TTL_MS, info: null });
      }
    }
  }
  return resolved;
}

/**
 * The authoritative Shopify price is denominated in the SHOP's currency. When
 * a base currency is configured, every payment lane fails closed on a
 * mismatch (the whole store is mispriced) rather than charging a
 * wrong-currency amount. Returns the offending shop currency, or '' when
 * consistent. An empty/unknown currency never mismatches.
 */
export function currencyMismatch(priced, baseCurrency) {
  const base = String(baseCurrency || '').toUpperCase();
  if (!base) return '';
  for (const info of Object.values(priced || {})) {
    const cur = String(info?.currency || '').toUpperCase();
    if (cur && cur !== base) return cur;
  }
  return '';
}

// Test helper — drop the in-process price cache.
export function clearPriceCache() {
  priceCache.clear();
}
