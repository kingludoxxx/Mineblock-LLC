// FUNNEL COMMERCE — the admin surface behind Funnel Settings → Commerce →
// Products and → Shipping. Mounted at /api/v1/funnel-commerce
// (authenticate + funnels:access — the same chain every other funnel-settings
// endpoint uses, see trackingAdmin.js / shopifyVariants.js).
//
// WHAT THIS ROUTER OWNS
//   · the funnel's SYNCED Shopify catalog snapshot   (co_funnel_products)
//   · the Shopify ↔ Whop product mapping             (co_whop_product_map)
//   · a READ-ONLY view of the store's live Shopify shipping zones
// It is additive: it edits nothing that already existed. funnels.js,
// funnelRender.js, checkoutPublic.js and checkoutPricing.js are untouched.
//
// PRICES HERE ARE DISPLAY DATA. Every price this router stores or returns is a
// LABEL for an operator, exactly like shopifyVariants.js's `price`. The public
// checkout re-prices every variant server-side against the live Shopify Admin
// API before a card is charged (services/checkoutPricing.js), so a stale row
// here can misinform a human but can never mis-charge a buyer.
//
// ── CHECKOUT-COUNTRIES ENFORCEMENT POINT (documented, NOT wired here) ───────
// `settings.commerce.restrict_countries` + `.allowed_countries` are ADMIN
// CONFIG ONLY today. Nothing in this router — and nothing anywhere — refuses a
// checkout for an unlisted country yet. The public checkout is a single-writer
// lane and this branch does not touch it. To enforce, the owner of that lane
// must add ONE gate:
//
//   FILE      server/src/routes/checkoutPublic.js
//   HANDLER   the create-session / order-create handler, at the point where the
//             buyer's shipping address is first read and BEFORE any pricing,
//             gateway call or order row is written (fail CLOSED: an
//             unenforceable read must reject, not silently allow).
//   CALL      import { readCommerceSettings } from '../services/checkoutCountries.js';
//             const cfg = readCommerceSettings(funnelRow.settings);
//             if (cfg.restrict_countries
//                 && !cfg.allowed_countries.includes(String(addr.country_code || '').toUpperCase()))
//               return 400 { code: 'country_not_supported' }
//   NOTE      readCommerceSettings already degrades `restrict:true` with an
//             EMPTY allow-list to unrestricted, so the gate can never brick a
//             funnel through a half-written settings blob.
//   ALSO      the same check belongs in the rendered checkout's country <select>
//             (services/funnelRender.js) so the buyer never picks a country the
//             server will reject — but the SERVER gate above is the authority;
//             the dropdown is a courtesy.
import { Router } from 'express';
import crypto from 'crypto';
import { pgQuery, client } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureCommerceTables } from '../services/funnelCommerceSchema.js';
import { readCommerceSettings, parseJsonColumn } from '../services/checkoutCountries.js';
import { resolveGatewayCreds } from '../services/gatewayConfigs.js';
import {
  listWhopProducts, createWhopProduct, planWhopMapping, WhopUnavailableError,
} from '../services/whopProducts.js';

const router = Router();

// ── bounds ─────────────────────────────────────────────────────────────────
// A catalog sync and a Whop map both walk a whole catalog and share the
// Shopify Admin bucket with LIVE CHECKOUT PRICING.
//
// THE LIMITER IS KEYED PER SHOP + FUNNEL, NOT PER USER. The budget being
// protected is the SHOP's Shopify leaky bucket, which is a property of the
// store — three operators each getting their own per-user allowance is three
// times the load on one shared bucket, i.e. exactly the starvation the cap
// exists to prevent. Per-user keying would also let a second admin account
// walk straight past the cap.
export const SYNC_RATE_MAX = 6;
export const SYNC_RATE_WINDOW_SEC = 300;
export const MAP_RATE_MAX = 6;
export const MAP_RATE_WINDOW_SEC = 300;
export const ZONES_RATE_MAX = 20;
export const ZONES_RATE_WINDOW_SEC = 60;

export const FETCH_TIMEOUT_MS = 8_000;

// QUERY COST — MEASURED, not estimated. Shopify rejects a single query whose
// requested cost exceeds 1000 and debits a 2000-point bucket that refills at
// 100/s on this shop. This query shape was run read-only against the live
// store (17cca0-2.myshopify.com, API 2024-01) at four page sizes:
//
//   products(first:N) with variants(first:50)   requestedQueryCost
//     N=5                                          35
//     N=100                                       101   <- the shipped query
//     N=250                                       123
//   (with variants(first:25) for comparison: 32 / 62 / 92 / 112 at N=5/25/100/250)
//
// Requested cost grows SUBLINEARLY here — a nested connection is charged at
// its declared size, not once per parent node, so the "N × M ≈ 5k" model is
// simply wrong for this shape. Even Shopify's maximum page (250) costs 115,
// under a tenth of the cap. Nothing about page size was ever a cost hazard.
//
// Given that, a LARGER page is strictly better: fewer round trips, fewer
// chances to hit the page cap, and lower TOTAL cost for a big catalog
// (10 × 101 = 1010 for 1000 products, versus 40 × 62 = 2480 at N=25). 100 it is.
//
// VARIANT_PAGE_SIZE is a real truncation bound: a product with more variants
// than this reports only the ones fetched. 50 is far above anything the live
// catalog carries (its widest product has 3) and is the size the cost above
// was measured with.
export const PRODUCT_PAGE_SIZE = 100;
export const VARIANT_PAGE_SIZE = 50;
export const PRODUCT_MAX_PAGES = 10;    // hard stop: 1000 products
export const ZONE_PAGE_SIZE = 15;       // keeps the zones query under the cost cap
export const ZONE_MAX_PAGES = 12;

// Back off when the shop's leaky bucket is nearly drained. Continuing to walk
// pages at that point is how an admin sync starves the LIVE checkout re-pricer
// that shares the same bucket.
export const THROTTLE_FLOOR_POINTS = 200;

function shopifyCreds() {
  // Read at CALL time, never module-cached — same posture as
  // shopifyVariants.js and checkoutPricing.js, so a rotation needs no redeploy.
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
}

export class ShopifyUnavailableError extends Error {
  constructor(reason, code = 'shopify_unavailable') {
    super(reason);
    this.name = 'ShopifyUnavailableError';
    this.code = code;
    this.status = 503;
  }
}

// ── Shopify GraphQL ────────────────────────────────────────────────────────
export const PRODUCTS_QUERY = `
query funnelCatalog($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: TITLE) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        handle
        status
        vendor
        featuredImage { url }
        variants(first: ${VARIANT_PAGE_SIZE}) {
          edges {
            node { id title price sku availableForSale }
          }
        }
      }
    }
  }
}`.trim();

// deliveryProfiles = the merchant's ACTUAL shipping setup: profiles → zones
// (a named set of countries) → rate options. Requires the read_shipping scope.
export const ZONES_QUERY = `
query deliveryProfilesOverview($zonesAfter: String) {
  deliveryProfiles(first: 3) {
    nodes {
      name
      default
      profileLocationGroups {
        locationGroupZones(first: ${ZONE_PAGE_SIZE}, after: $zonesAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            zone {
              name
              countries { name code { countryCode restOfWorld } }
            }
            methodDefinitions(first: 8) {
              nodes {
                active
                name
                rateProvider {
                  __typename
                  ... on DeliveryRateDefinition { price { amount currencyCode } }
                  ... on DeliveryParticipant { carrierService { formattedName } }
                }
                methodConditions {
                  field
                  operator
                  conditionCriteria {
                    __typename
                    ... on MoneyV2 { amount currencyCode }
                    ... on Weight { unit value }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`.trim();

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
      // The credential travels in this HEADER only — never a URL, never argv.
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ShopifyUnavailableError(`fetch_failed ${err.name}`);
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 401 || resp.status === 403) {
    // A dead credential will not fix itself — never offer Retry against it.
    throw new ShopifyUnavailableError(`http_${resp.status}`, 'shopify_auth_error');
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
  if (payload?.errors) {
    const detail = JSON.stringify(payload.errors);
    const err = new ShopifyUnavailableError('graphql_errors');
    if (/ACCESS_DENIED|read_shipping/i.test(detail)) err.hint = 'missing_read_shipping_scope';
    // THROTTLED / MAX_COST_EXCEEDED are cost problems, not availability
    // problems, and they need different human action: back off vs shrink the
    // query. Naming them is the difference between an operator retrying
    // forever and an operator (or us) fixing the page size.
    if (/MAX_COST_EXCEEDED/i.test(detail)) err.hint = 'query_cost_exceeded';
    else if (/THROTTLED/i.test(detail)) err.hint = 'shopify_throttled';
    throw err;
  }
  // `extensions.cost` is how the shop tells us how much bucket is left. It is
  // ABSENT on some proxies and on older API versions — absent must read as
  // "unknown", never as "empty", or a missing field would stall every sync.
  return { data: payload?.data || {}, extensions: payload?.extensions || null };
}

/**
 * Pure. extensions.cost -> { requested, actual, available, restoreRate } with
 * nulls for anything the shop did not report. Total: never throws.
 */
export function readCostStatus(extensions) {
  const cost = extensions && typeof extensions === 'object' ? extensions.cost : null;
  const t = cost && typeof cost === 'object' ? cost.throttleStatus : null;
  const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);
  return {
    requested: num(cost?.requestedQueryCost),
    actual: num(cost?.actualQueryCost),
    available: num(t?.currentlyAvailable),
    maximum: num(t?.maximumAvailable),
    restoreRate: num(t?.restoreRate),
  };
}

/**
 * How long to wait before the next page, given what the shop just told us.
 * Unknown cost (no extensions) -> 0: we cannot invent a budget, and stalling
 * on a missing field would break every sync against a proxy that strips it.
 */
export function throttleDelayMs(costStatus, nextCost) {
  const available = costStatus?.available;
  const rate = costStatus?.restoreRate;
  if (available == null || rate == null || rate <= 0) return 0;
  const need = Math.max(Number(nextCost) || 0, THROTTLE_FLOOR_POINTS);
  if (available >= need) return 0;
  // Wait only long enough to get back over the floor, capped so a pathological
  // reading can never park a request for minutes.
  return Math.min(Math.ceil(((need - available) / rate) * 1000), 5_000);
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// ── pure shapers ───────────────────────────────────────────────────────────

/** Numeric id out of a Shopify gid, '' for anything else. Total. */
export function numericId(gid, resource) {
  const re = new RegExp(`^gid://shopify/${resource}/(\\d+)$`);
  const m = re.exec(String(gid || '').trim());
  return m ? m[1] : '';
}

/**
 * Pure: products(…) edges -> the row shape co_funnel_products stores and the
 * UI renders. Malformed nodes are DROPPED, never thrown on; a node without a
 * resolvable numeric product id is not addressable so it cannot be offered.
 * `price` is the FIRST variant's price — a display label, never a charge input.
 */
export function mapProductNodes(edges) {
  const out = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    const n = edge && typeof edge === 'object' ? edge.node : null;
    if (!n || typeof n !== 'object') continue;
    const productId = numericId(n.id, 'Product');
    if (!productId) continue;

    const vEdges = n.variants && typeof n.variants === 'object' ? n.variants.edges : null;
    const variants = [];
    for (const vEdge of Array.isArray(vEdges) ? vEdges : []) {
      const v = vEdge && typeof vEdge === 'object' ? vEdge.node : null;
      if (!v || typeof v !== 'object') continue;
      const variantId = numericId(v.id, 'ProductVariant');
      if (!variantId) continue;
      variants.push({
        variant_id: variantId,
        title: v.title == null ? '' : String(v.title),
        price: v.price == null ? '' : String(v.price),
        sku: v.sku == null ? '' : String(v.sku),
        available: v.availableForSale === true,
      });
    }

    const firstPrice = variants.length ? Number(variants[0].price) : NaN;
    out.push({
      shopify_product_id: productId,
      title: n.title == null ? '' : String(n.title),
      handle: n.handle == null ? '' : String(n.handle),
      status: n.status == null ? '' : String(n.status),
      vendor: n.vendor == null ? '' : String(n.vendor),
      image: n.featuredImage && typeof n.featuredImage === 'object' && n.featuredImage.url
        ? String(n.featuredImage.url) : '',
      // null, NOT 0 — "no price known" and "free" must not render identically.
      price: Number.isFinite(firstPrice) ? Math.round(firstPrice * 100) / 100 : null,
      variants_count: variants.length,
      variants,
    });
  }
  return out;
}

/** One human line per rate condition, e.g. 'orders $50.00+' / 'up to 2kg'. */
export function describeCondition(cond) {
  const crit = (cond && typeof cond === 'object' ? cond.conditionCriteria : null) || {};
  const op = String((cond && cond.operator) || '').toUpperCase();
  const atLeast = op.includes('GREATER');
  if (crit.__typename === 'MoneyV2') {
    const amt = Number(crit.amount);
    const label = `$${(Number.isFinite(amt) ? amt : 0).toFixed(2)}`;
    return atLeast ? `orders ${label}+` : `orders under ${label}`;
  }
  if (crit.__typename === 'Weight') {
    const w = `${crit.value}${String(crit.unit || '').toLowerCase()}`;
    return atLeast ? `${w}+` : `up to ${w}`;
  }
  return '';
}

/**
 * Pure: one or more deliveryProfiles payloads -> the zones view shape
 *   [{ profile, zone, countries:[{code,name}], rest_of_world, rates:[
 *      { name, price|null, currency, carrier, conditions:[str] } ]}]
 * Inactive rate options are skipped. A carrier-calculated option carries
 * `carrier` and price null — its real price depends on the buyer's address,
 * which only the checkout quote knows. Total: junk in -> [].
 */
export function shapeZones(payloads) {
  const list = Array.isArray(payloads) ? payloads : [payloads];
  const zones = [];
  for (const payload of list) {
    const nodes = payload && typeof payload === 'object'
      && payload.deliveryProfiles && typeof payload.deliveryProfiles === 'object'
      && Array.isArray(payload.deliveryProfiles.nodes)
      ? payload.deliveryProfiles.nodes : [];
    for (const profile of nodes) {
      if (!profile || typeof profile !== 'object') continue;
      const pname = profile.name || (profile.default ? 'General shipping' : '');
      for (const group of Array.isArray(profile.profileLocationGroups) ? profile.profileLocationGroups : []) {
        const zoneNodes = group && typeof group === 'object'
          && group.locationGroupZones && Array.isArray(group.locationGroupZones.nodes)
          ? group.locationGroupZones.nodes : [];
        for (const z of zoneNodes) {
          const zone = (z && typeof z === 'object' ? z.zone : null) || {};
          const countries = [];
          let restOfWorld = false;
          for (const c of Array.isArray(zone.countries) ? zone.countries : []) {
            const code = (c && typeof c === 'object' ? c.code : null) || {};
            if (code.restOfWorld) { restOfWorld = true; continue; }
            countries.push({ code: code.countryCode || '', name: (c && c.name) || '' });
          }
          const rates = [];
          const methodNodes = z && typeof z === 'object' && z.methodDefinitions
            && Array.isArray(z.methodDefinitions.nodes) ? z.methodDefinitions.nodes : [];
          for (const m of methodNodes) {
            if (!m || typeof m !== 'object') continue;
            if (m.active === false) continue;
            const provider = m.rateProvider || {};
            let price = null;
            let currency = '';
            let carrier = '';
            if (provider.__typename === 'DeliveryRateDefinition') {
              const raw = (provider.price || {}).amount;
              // Number(null) is 0 and Number('') is 0. Coercing here turned an
              // ABSENT amount into a rate the UI rendered as "FREE" — the worst
              // possible lie about a shipping charge. An amount that is not
              // present stays null and renders as unknown.
              const amt = raw == null || raw === '' ? NaN : Number(raw);
              price = Number.isFinite(amt) ? Math.round(amt * 100) / 100 : null;
              currency = (provider.price || {}).currencyCode || '';
            } else if (provider.__typename === 'DeliveryParticipant') {
              carrier = ((provider.carrierService || {}).formattedName) || 'carrier';
            }
            // Any OTHER __typename (a provider kind Shopify adds later) leaves
            // price null AND carrier '' — the client must render that as
            // "price unknown", never as free.
            const conditions = (Array.isArray(m.methodConditions) ? m.methodConditions : [])
              .map(describeCondition).filter(Boolean);
            rates.push({ name: m.name || 'Shipping', price, currency, carrier, conditions });
          }
          zones.push({
            profile: pname,
            zone: zone.name || '',
            countries,
            rest_of_world: restOfWorld,
            rates,
          });
        }
      }
    }
  }
  return zones;
}

/**
 * Pure: which of the operator's allowed checkout countries NO zone covers.
 *
 * A ZONE WITH ZERO RATE OPTIONS COVERS NOTHING. Shopify happily holds a zone
 * that lists countries but offers no shipping method — a buyer there gets no
 * rate and cannot complete checkout. The first cut treated any `rest_of_world`
 * zone as blanket coverage and returned a clean bill of health for a store
 * that could not ship anywhere, which is precisely the failure this signal
 * exists to catch. Coverage now requires at least one rate option.
 */
export function uncoveredCountries(zones, allowed) {
  const wanted = Array.isArray(allowed) ? allowed : [];
  if (!wanted.length) return [];
  const covered = new Set();
  let restOfWorldShips = false;
  for (const z of Array.isArray(zones) ? zones : []) {
    if (!z || typeof z !== 'object') continue;
    const ships = Array.isArray(z.rates) && z.rates.length > 0;
    if (!ships) continue;
    if (z.rest_of_world) { restOfWorldShips = true; continue; }
    for (const c of Array.isArray(z.countries) ? z.countries : []) {
      if (c && c.code) covered.add(String(c.code).toUpperCase());
    }
  }
  if (restOfWorldShips) return [];
  return wanted.filter((c) => !covered.has(String(c).toUpperCase()));
}

// ── shared helpers ─────────────────────────────────────────────────────────

const SHOPIFY_MESSAGES = {
  shopify_not_configured: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Shopify is temporarily unavailable — try again.',
};
const WHOP_MESSAGES = {
  whop_catalog_incomplete: 'Could not read the whole Whop catalog — mapping stopped rather than risk creating duplicates.',
  whop_not_configured: 'Whop is not configured for this funnel — add the API key and company ID in Payments first.',
  whop_auth_error: 'Whop rejected our credentials — the API key is missing, expired or revoked. This needs operator attention; retrying will not help.',
  whop_invalid_name: 'That product has no name, so it cannot be created in Whop.',
  whop_create_no_id: 'Whop accepted the product but returned no id for it, so it could not be linked.',
  whop_unavailable: 'Whop is temporarily unavailable — try again.',
};

// An outage answers 503 with a code and NEVER an empty collection: an empty
// list is a POSITIVE claim ("there is nothing"), and acting on it here would
// make the mapper duplicate products that already exist.
function sendUpstreamError(res, err, tag) {
  const isShopify = err instanceof ShopifyUnavailableError;
  const isWhop = err instanceof WhopUnavailableError;
  if (!isShopify && !isWhop) return null;
  const messages = isShopify ? SHOPIFY_MESSAGES : WHOP_MESSAGES;
  const retryable = err.code === 'shopify_unavailable' || err.code === 'whop_unavailable';
  console.error(`[funnelCommerce] ${tag} unavailable:`, err.code, err.message);
  return res.status(503).json({
    success: false,
    error: {
      code: err.code,
      retryable,
      ...(err.hint ? { hint: err.hint } : {}),
      message: messages[err.code] || messages[isShopify ? 'shopify_unavailable' : 'whop_unavailable'],
    },
  });
}

/**
 * Rate gate.
 *
 * SCOPE: the key is SHOP + FUNNEL, never the user. The budget being defended
 * is the SHOP's Shopify leaky bucket — a property of the store, not of whoever
 * clicked. Per-user keying multiplied the allowance by the number of admins
 * and let a second account walk straight past the cap.
 *
 * FAILURE POSTURE: `failClosed` callers (the admin catalog sync and the Whop
 * map) REFUSE when the limiter store is unreachable. That is the opposite of
 * the serving path's posture and deliberately so: serving must never go down
 * with Redis, but an ADMIN button is not serving — the cost of refusing it is
 * one operator clicking again, and the cost of allowing it is an unmetered
 * catalog walk against the same bucket live checkout pricing needs.
 */
// NOTE ON REACHABILITY: middleware/rateLimiter.js (Platform-owned, not ours to
// edit) already degrades a Redis outage to an in-process Map and therefore
// rarely rejects. The failClosed branch is defence-in-depth for the case where
// it DOES — a limiter that cannot answer must not be read as "allowed" for a
// job that spends the shop's Shopify budget. `check` is injectable so that
// branch is covered by execution rather than by assertion-free hope.
export async function limited(
  req, res, key, max, windowSec,
  { failClosed = false, check = checkRateLimit } = {}
) {
  const scope = `${shopifyCreds().store || 'no-shop'}:${funnelIdOf(req)}`;
  const rl = await check(`${key}:${scope}`, max, windowSec)
    .catch((err) => ({ allowed: !failClosed, storeDown: true, reason: err.message }));
  if (rl.allowed) return false;
  if (rl.storeDown) {
    console.error('[funnelCommerce] rate-limit store unreachable, refusing admin job:', rl.reason);
    res.status(503).json({
      success: false,
      error: {
        code: 'rate_limiter_unavailable',
        retryable: true,
        message: 'The rate limiter is unavailable, so this job is held back to protect live checkout pricing. Try again shortly.',
      },
    });
    return true;
  }
  res.status(429).json({
    success: false,
    error: { code: 'rate_limited', message: 'Too many requests — wait a moment and try again', retry_after: rl.retryAfter },
  });
  return true;
}

function funnelIdOf(req) { return String(req.params.funnelId || '').trim(); }

async function loadFunnel(funnelId) {
  const rows = await pgQuery(`SELECT id, settings FROM funnels WHERE id = $1`, [funnelId]);
  return rows.length ? rows[0] : null;
}

// A funnel id that does not exist must never reach an UPSTREAM WRITE. Without
// this gate a typo'd id fell through to the PLATFORM env Whop credentials and
// minted real products against the company account for a funnel that does not
// exist. Read-only handlers may stay lenient; anything that spends money,
// quota or creates remote objects goes through here first.
async function requireFunnel(req, res) {
  const funnelId = funnelIdOf(req);
  if (!funnelId) {
    res.status(400).json({ success: false, error: { code: 'funnel_required', message: 'A funnel id is required' } });
    return null;
  }
  const funnel = await loadFunnel(funnelId);
  if (!funnel) {
    res.status(404).json({
      success: false,
      error: { code: 'funnel_not_found', message: 'That funnel does not exist.' },
    });
    return null;
  }
  return funnel;
}

// jsonb round-trips as an OBJECT from postgres.js but as a STRING if it was
// ever double-encoded — read side handles both (parseJsonColumn) and never
// throws. The WRITE side passes raw objects: pre-stringifying a jsonb param
// double-encodes it into a jsonb STRING scalar.
function productRow(r) {
  return {
    shopify_product_id: r.shopify_product_id,
    title: r.title,
    handle: r.handle,
    status: r.status,
    vendor: r.vendor,
    image: r.image,
    price: r.price == null ? null : Number(r.price),
    currency: r.currency,
    variants_count: r.variants_count,
    variants: parseJsonColumn(r.variants, []),
    synced_at: r.synced_at,
  };
}

function mappingRow(r) {
  return {
    id: r.id,
    shopify_product_id: r.shopify_product_id,
    shopify_title: r.shopify_title,
    shopify_price: r.shopify_price == null ? null : Number(r.shopify_price),
    whop_product_id: r.whop_product_id,
    whop_product_name: r.whop_product_name,
    source: r.source,
    status: r.status,
    updated_at: r.updated_at,
  };
}

async function readProducts(funnelId) {
  const rows = await pgQuery(
    `SELECT * FROM co_funnel_products WHERE funnel_id = $1 ORDER BY title ASC, shopify_product_id ASC`,
    [funnelId]
  );
  return rows.map(productRow);
}

async function readMappings(funnelId) {
  const rows = await pgQuery(
    `SELECT * FROM co_whop_product_map WHERE funnel_id = $1 ORDER BY updated_at DESC`,
    [funnelId]
  );
  return rows.map(mappingRow);
}

async function upsertMapping(funnelId, m) {
  const rows = await pgQuery(
    `INSERT INTO co_whop_product_map
       (id, funnel_id, shopify_product_id, shopify_title, shopify_price,
        whop_product_id, whop_product_name, source, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (funnel_id, shopify_product_id) DO UPDATE SET
       shopify_title = EXCLUDED.shopify_title,
       shopify_price = EXCLUDED.shopify_price,
       whop_product_id = EXCLUDED.whop_product_id,
       whop_product_name = EXCLUDED.whop_product_name,
       source = EXCLUDED.source,
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING *`,
    [
      `wpm_${crypto.randomBytes(9).toString('hex')}`, funnelId,
      String(m.shopify_product_id), String(m.shopify_title || ''),
      m.shopify_price == null ? null : Number(m.shopify_price),
      String(m.whop_product_id || ''), String(m.whop_product_name || ''),
      String(m.source || 'linked'),
      String(m.whop_product_id || '') ? 'mapped' : 'unmapped',
    ]
  );
  return mappingRow(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.use(authenticate, requirePermission('funnels', 'access'));

// GET /:funnelId/products -> 200 { data: { products:[…], synced_at } }
// The stored snapshot only. NEVER kicks a sync on read: a settings tab that
// silently fires a full catalog walk on open is how a blank panel and an
// unbounded Shopify bill happen at the same time.
export async function listProductsHandler(req, res) {
  try {
    await ensureCommerceTables();
    const products = await readProducts(funnelIdOf(req));
    const syncedAt = products.reduce(
      (acc, p) => (acc && acc > p.synced_at ? acc : p.synced_at), null
    );
    return res.json({ success: true, data: { products, synced_at: syncedAt } });
  } catch (err) {
    console.error('[funnelCommerce] list products failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
}

/**
 * Walk the whole Shopify catalog. Returns { products, complete, reason, cost }.
 *
 * `complete` is the ONLY thing that may authorize a prune, and it is true in
 * exactly one case: a page came back saying hasNextPage is falsy. Every other
 * exit — a page cap, a hasNextPage:true with no cursor, a throttle stop — sets
 * complete:false, because in all of them the set we hold is a PREFIX of the
 * catalog and "not in my prefix" does not mean "deleted from Shopify".
 *
 * A 200 whose body has no `products` connection is an OUTAGE, not an empty
 * catalog. That distinction is the whole ballgame: read as empty, it produced
 * a 200 that deleted every row the funnel had.
 */
export async function walkCatalog() {
  const products = [];
  let after = null;
  let cost = null;
  for (let page = 0; page < PRODUCT_MAX_PAGES; page += 1) {
    const { data, extensions } = await postGraphql(PRODUCTS_QUERY, { first: PRODUCT_PAGE_SIZE, after });
    const conn = data?.products;
    if (!conn || typeof conn !== 'object' || !Array.isArray(conn.edges)) {
      throw new ShopifyUnavailableError('missing_products_connection');
    }
    products.push(...mapProductNodes(conn.edges));
    cost = readCostStatus(extensions);

    const info = conn.pageInfo && typeof conn.pageInfo === 'object' ? conn.pageInfo : {};
    if (!info.hasNextPage) return { products, complete: true, reason: '', cost };
    // Shopify says there IS more but gave us no cursor: we cannot ask for it,
    // so what we hold is a prefix. Breaking here USED to look identical to a
    // finished walk and pruned everything beyond it.
    if (!info.endCursor) return { products, complete: false, reason: 'cursor_missing', cost };
    after = info.endCursor;

    const wait = throttleDelayMs(cost, cost?.requested);
    if (wait > 0) {
      // The bucket is nearly dry. Pause rather than push — the same bucket
      // prices real carts.
      if (wait >= 5_000) return { products, complete: false, reason: 'throttled', cost };
      await sleep(wait);
    }
  }
  return { products, complete: false, reason: 'page_cap', cost };
}

// POST /:funnelId/products/sync
//   -> 200 { data: { synced, removed, truncated, truncated_reason, cost, products } }
// Walks the Shopify catalog and refreshes this funnel's snapshot. Products that
// vanished from Shopify are pruned — but ONLY when the walk provably reached
// the end of the catalog (see walkCatalog). A truncated walk upserts what it
// saw and prunes NOTHING.
export async function syncProductsHandler(req, res) {
  if (await limited(req, res, 'funnel-commerce-sync', SYNC_RATE_MAX, SYNC_RATE_WINDOW_SEC, { failClosed: true })) return undefined;
  if (!(await requireFunnel(req, res))) return undefined;
  const funnelId = funnelIdOf(req);
  try {
    await ensureCommerceTables();

    const walk = await walkCatalog();
    const seen = walk.products;

    for (const p of seen) {
      await pgQuery(
        `INSERT INTO co_funnel_products
           (funnel_id, shopify_product_id, title, handle, status, vendor, image,
            price, currency, variants_count, variants, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (funnel_id, shopify_product_id) DO UPDATE SET
           title = EXCLUDED.title, handle = EXCLUDED.handle, status = EXCLUDED.status,
           vendor = EXCLUDED.vendor, image = EXCLUDED.image, price = EXCLUDED.price,
           currency = EXCLUDED.currency, variants_count = EXCLUDED.variants_count,
           variants = EXCLUDED.variants, synced_at = NOW()`,
        // `p.variants` goes in as a RAW ARRAY: pgQuery (postgres.js) serializes
        // jsonb params itself — pre-stringifying double-encodes it into a jsonb
        // STRING scalar and every later read gets a string back.
        [funnelId, p.shopify_product_id, p.title, p.handle, p.status, p.vendor,
          p.image, p.price, '', p.variants_count, p.variants]
      );
    }

    // ── PRUNE — gated on a PROVEN-COMPLETE walk ──
    // "Not in the set I fetched" only means "deleted from Shopify" if the set
    // I fetched IS the catalog. On a truncated walk it means "past my cursor",
    // and deleting on that is data loss dressed up as a 200.
    let removed = [];
    if (walk.complete) {
      const keep = seen.map((p) => p.shopify_product_id);
      removed = await pgQuery(
        `DELETE FROM co_funnel_products
          WHERE funnel_id = $1 AND NOT (shopify_product_id = ANY($2::text[]))
          RETURNING shopify_product_id`,
        [funnelId, keep]
      );
      // A pruned product's Whop mapping is orphaned — it points at a Shopify
      // product this funnel no longer sells, and leaving it behind inflates
      // mapped_count above the number of products that exist.
      if (removed.length) {
        await pgQuery(
          `DELETE FROM co_whop_product_map
            WHERE funnel_id = $1 AND shopify_product_id = ANY($2::text[])`,
          [funnelId, removed.map((r) => r.shopify_product_id)]
        );
      }
    }

    const products = await readProducts(funnelId);
    return res.json({
      success: true,
      data: {
        synced: seen.length,
        removed: removed.length,
        truncated: !walk.complete,
        truncated_reason: walk.complete ? '' : walk.reason,
        cost: walk.cost,
        products,
      },
    });
  } catch (err) {
    const sent = sendUpstreamError(res, err, 'products sync');
    if (sent) return sent;
    console.error('[funnelCommerce] products sync failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'sync_failed', message: 'Product sync failed' } });
  }
}

// GET /:funnelId/whop/mappings -> 200 { data: { mappings, mapped_count } }
export async function listMappingsHandler(req, res) {
  try {
    await ensureCommerceTables();
    const mappings = await readMappings(funnelIdOf(req));
    return res.json({
      success: true,
      data: { mappings, mapped_count: mappings.filter((m) => m.status === 'mapped').length },
    });
  } catch (err) {
    console.error('[funnelCommerce] list mappings failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
}

// POST /:funnelId/whop/map -> 200 { data: { matched, created, already, skipped, failed, mappings } }
// "Map to Whop": for every synced product WITHOUT a mapping, find a Whop
// product with the same name; if none exists, create one with that name.
// The Whop catalog is read ONCE up front — an outage there throws before a
// single create, so a blip can never mint duplicates.
// Errors that will fail IDENTICALLY for every remaining product — a dead key
// does not become alive on product #4. Hitting one stops further CALLS, but
// every remaining product is still accounted for in `failed`: an operator must
// never read a short report as a clean one.
const FATAL_WHOP_CODES = new Set(['whop_auth_error', 'whop_not_configured', 'whop_unavailable']);

export async function mapToWhopHandler(req, res) {
  if (await limited(req, res, 'funnel-commerce-whopmap', MAP_RATE_MAX, MAP_RATE_WINDOW_SEC, { failClosed: true })) return undefined;
  // A nonexistent funnel must not reach a Whop WRITE (it used to fall through
  // to the PLATFORM env credentials and mint real company products).
  if (!(await requireFunnel(req, res))) return undefined;
  const funnelId = funnelIdOf(req);

  // ── MUTUAL EXCLUSION ──
  // read-plan-create is not atomic: two operators clicking "Map to Whop" at
  // the same moment both read "Serum is unmapped" and both CREATE it, leaving
  // two live Whop products for one Shopify product. The advisory lock makes
  // the whole plan+create one critical section per funnel.
  //
  // DECISION MADE — a SESSION lock on a reserved connection, not
  // pg_advisory_xact_lock: the critical section makes outbound Whop calls, and
  // an xact lock would hold a database transaction open across seconds of
  // third-party network I/O. try_ rather than blocking so the second click
  // gets an immediate, honest 409 instead of silently queueing behind a job it
  // cannot see.
  const lockKey = `funnel-commerce:whop-map:${funnelId}`;
  let reserved = null;
  let held = false;
  try {
    await ensureCommerceTables();
    reserved = await client.reserve();
    const [lock] = await reserved`SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS ok`;
    held = lock?.ok === true;
    if (!held) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'map_in_progress',
          retryable: true,
          message: 'A Whop mapping run is already in progress for this funnel — wait for it to finish.',
        },
      });
    }

    const products = await readProducts(funnelId);
    if (!products.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'no_products', message: 'Sync the Shopify catalog first — there is nothing to map yet.' },
      });
    }
    const existing = await readMappings(funnelId);

    // Per-funnel Whop credentials via the existing gateway store (encrypted at
    // rest, env fallback). Live mode: mapping targets the real catalog.
    const creds = await resolveGatewayCreds(funnelId, 'whop', { mode: 'live' });
    const catalog = await listWhopProducts(creds, { mode: 'live' });

    // A PARTIAL Whop catalog cannot prove a name is absent — the product we
    // are about to "create" may be sitting on a page we never fetched. Refuse
    // rather than mint a duplicate live product.
    if (!catalog.complete) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'whop_catalog_incomplete',
          retryable: true,
          message: 'Could not read the whole Whop catalog, so mapping was stopped before it could create a duplicate product. Try again shortly.',
        },
      });
    }

    const plan = planWhopMapping(products, existing, catalog.products);
    const failed = [];
    let matched = 0;
    let created = 0;

    for (const { product, whop } of plan.match) {
      await upsertMapping(funnelId, {
        shopify_product_id: product.shopify_product_id,
        shopify_title: product.title,
        shopify_price: product.price,
        whop_product_id: whop.id,
        whop_product_name: whop.name,
        source: 'matched',
      });
      matched += 1;
    }

    let fatal = '';
    for (const product of plan.create) {
      if (fatal) {
        // Stop CALLING, keep COUNTING. The old code `break`-ed here and the
        // remaining products vanished from the report entirely, so a run that
        // mapped 1 of 40 rendered as "1 created" with no failures.
        failed.push({ shopify_product_id: product.shopify_product_id, title: product.title, code: fatal });
        continue;
      }
      try {
        const made = await createWhopProduct(creds, { name: product.title, mode: 'live' });
        await upsertMapping(funnelId, {
          shopify_product_id: product.shopify_product_id,
          shopify_title: product.title,
          shopify_price: product.price,
          whop_product_id: made.id,
          whop_product_name: made.name,
          source: 'created',
        });
        created += 1;
      } catch (err) {
        if (!(err instanceof WhopUnavailableError)) throw err;
        failed.push({ shopify_product_id: product.shopify_product_id, title: product.title, code: err.code });
        if (FATAL_WHOP_CODES.has(err.code)) fatal = err.code;
      }
    }

    const mappings = await readMappings(funnelId);
    return res.json({
      success: true,
      data: {
        matched,
        created,
        already: plan.already.length,
        skipped: plan.skipped.length,
        failed,
        // PLAN TOTALS. `created < planned_create` is the client's only reliable
        // shortfall signal — counting outcomes alone cannot distinguish "there
        // was nothing to do" from "we gave up".
        planned_match: plan.match.length,
        planned_create: plan.create.length,
        mappings,
        mapped_count: mappings.filter((m) => m.status === 'mapped').length,
      },
    });
  } catch (err) {
    const sent = sendUpstreamError(res, err, 'whop map');
    if (sent) return sent;
    console.error('[funnelCommerce] whop map failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'map_failed', message: 'Whop mapping failed' } });
  } finally {
    // Release before returning the connection to the pool — a session lock
    // survives on a pooled connection and would wedge every later run.
    if (reserved) {
      if (held) {
        await reserved`SELECT pg_advisory_unlock(hashtext(${lockKey}))`
          .catch((e) => console.error('[funnelCommerce] advisory unlock failed:', e.message));
      }
      reserved.release();
    }
  }
}

// PUT /:funnelId/whop/mappings -> 200 { data: { mapping } }
// Manual link/relink from the popup. whop_product_id '' clears the link
// (status flips to unmapped) without deleting the row's history.
export async function upsertMappingHandler(req, res) {
  const funnelId = funnelIdOf(req);
  const b = req.body || {};
  const productId = String(b.shopify_product_id || '').trim();
  if (!productId) {
    return res.status(400).json({ success: false, error: { code: 'product_required', message: 'shopify_product_id is required' } });
  }
  try {
    await ensureCommerceTables();
    const mapping = await upsertMapping(funnelId, {
      shopify_product_id: productId,
      shopify_title: String(b.shopify_title || '').slice(0, 300),
      shopify_price: Number.isFinite(Number(b.shopify_price)) ? Number(b.shopify_price) : null,
      whop_product_id: String(b.whop_product_id || '').slice(0, 200),
      whop_product_name: String(b.whop_product_name || '').slice(0, 300),
      source: 'linked',
    });
    return res.json({ success: true, data: { mapping } });
  } catch (err) {
    console.error('[funnelCommerce] mapping upsert failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
}

// DELETE /:funnelId/whop/mappings/:mappingId -> 200 { data: { deleted } }
export async function deleteMappingHandler(req, res) {
  try {
    await ensureCommerceTables();
    const rows = await pgQuery(
      `DELETE FROM co_whop_product_map WHERE funnel_id = $1 AND id = $2 RETURNING id`,
      [funnelIdOf(req), String(req.params.mappingId || '')]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { code: 'not_found', message: 'Mapping not found' } });
    }
    return res.json({ success: true, data: { deleted: rows[0].id } });
  } catch (err) {
    console.error('[funnelCommerce] mapping delete failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
}

/**
 * Pure. Every zone connection in a payload that still has a next page, as
 * cursors. `$zonesAfter` is ONE variable shared by every profile's connection,
 * so it can only advance them in lockstep — if two connections are still
 * paging, this query shape cannot page both and the overview is necessarily
 * partial. Returning the whole set (not the last one seen) is what lets the
 * caller detect that and say so instead of quietly using an unrelated
 * profile's cursor.
 */
export function pendingZoneCursors(payload) {
  const out = [];
  const nodes = payload?.deliveryProfiles?.nodes;
  for (const prof of Array.isArray(nodes) ? nodes : []) {
    for (const grp of Array.isArray(prof?.profileLocationGroups) ? prof.profileLocationGroups : []) {
      const info = grp?.locationGroupZones?.pageInfo;
      if (info && info.hasNextPage && info.endCursor) out.push(String(info.endCursor));
    }
  }
  return [...new Set(out)];
}

// GET /:funnelId/shipping/zones
//   -> 200 { data: { zones, truncated, truncated_reason, allowed_countries, uncovered_countries } }
// READ-ONLY. An outage answers 503 — never {zones:[]}, which would read as
// "you have configured no shipping anywhere" and send an operator to fix a
// setting that is not broken.
export async function shippingZonesHandler(req, res) {
  // Read-only and cheap: this one stays FAIL-OPEN on a limiter outage. It
  // creates nothing and its worst case is one extra Shopify read.
  if (await limited(req, res, 'funnel-commerce-zones', ZONES_RATE_MAX, ZONES_RATE_WINDOW_SEC)) return undefined;
  const funnelId = funnelIdOf(req);
  try {
    const payloads = [];
    let zonesAfter = null;
    let truncated = false;
    let truncatedReason = '';
    for (let page = 0; page < ZONE_MAX_PAGES; page += 1) {
      const { data } = await postGraphql(ZONES_QUERY, { zonesAfter });
      payloads.push(data);
      const cursors = pendingZoneCursors(data);
      if (!cursors.length) break;
      if (cursors.length > 1) {
        // Two profiles still paging, one cursor variable. Advancing on either
        // one would silently skip zones in the other, so stop and SAY the view
        // is partial rather than present a lie as complete.
        truncated = true;
        truncatedReason = 'multiple_profile_pages';
        break;
      }
      zonesAfter = cursors[0];
      if (page === ZONE_MAX_PAGES - 1) { truncated = true; truncatedReason = 'page_cap'; }
    }
    const zones = shapeZones(payloads);

    // The funnel's own allow-list, normalized — so the view can name the
    // countries the operator sells to but ships nowhere near.
    const funnel = await loadFunnel(funnelId);
    const cfg = readCommerceSettings(funnel?.settings);
    const allowed = cfg.restrict_countries ? cfg.allowed_countries : [];

    return res.json({
      success: true,
      data: {
        zones,
        truncated,
        truncated_reason: truncatedReason,
        allowed_countries: allowed,
        // A partial zone list cannot prove a country is UNCOVERED — the zone
        // that covers it may be on a page we never fetched.
        uncovered_countries: truncated ? [] : uncoveredCountries(zones, allowed),
      },
    });
  } catch (err) {
    const sent = sendUpstreamError(res, err, 'shipping zones');
    if (sent) return sent;
    console.error('[funnelCommerce] shipping zones failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'zones_failed', message: 'Could not load shipping zones' } });
  }
}

router.get('/:funnelId/products', listProductsHandler);
router.post('/:funnelId/products/sync', syncProductsHandler);
router.get('/:funnelId/whop/mappings', listMappingsHandler);
router.put('/:funnelId/whop/mappings', upsertMappingHandler);
router.post('/:funnelId/whop/map', mapToWhopHandler);
router.delete('/:funnelId/whop/mappings/:mappingId', deleteMappingHandler);
router.get('/:funnelId/shipping/zones', shippingZonesHandler);

export default router;
