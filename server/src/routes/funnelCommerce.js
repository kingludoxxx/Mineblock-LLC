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
import { pgQuery } from '../db/pg.js';
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
// Shopify Admin bucket with LIVE CHECKOUT PRICING, so both are capped per
// user, well below the typeahead's 30/min (shopifyVariants.SEARCH_RATE_MAX).
export const SYNC_RATE_MAX = 6;
export const SYNC_RATE_WINDOW_SEC = 300;
export const MAP_RATE_MAX = 6;
export const MAP_RATE_WINDOW_SEC = 300;
export const ZONES_RATE_MAX = 20;
export const ZONES_RATE_WINDOW_SEC = 60;

export const FETCH_TIMEOUT_MS = 8_000;
export const PRODUCT_PAGE_SIZE = 100;   // Shopify caps products(first:) at 250
export const PRODUCT_MAX_PAGES = 10;    // hard stop: 1000 products
export const ZONE_PAGE_SIZE = 15;       // keeps the zones query under the cost cap
export const ZONE_MAX_PAGES = 12;

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
        variants(first: 50) {
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
    throw err;
  }
  return payload?.data || {};
}

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
              const amt = Number((provider.price || {}).amount);
              price = Number.isFinite(amt) ? Math.round(amt * 100) / 100 : null;
              currency = (provider.price || {}).currencyCode || '';
            } else if (provider.__typename === 'DeliveryParticipant') {
              carrier = ((provider.carrierService || {}).formattedName) || 'carrier';
            }
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
 * A `rest_of_world` zone covers everything, so it empties the list. This is
 * the "you sell to BD but ship nowhere near it" signal — the single most
 * useful thing the zones view can tell an operator.
 */
export function uncoveredCountries(zones, allowed) {
  const wanted = Array.isArray(allowed) ? allowed : [];
  if (!wanted.length) return [];
  const covered = new Set();
  for (const z of Array.isArray(zones) ? zones : []) {
    if (!z || typeof z !== 'object') continue;
    if (z.rest_of_world) return [];
    for (const c of Array.isArray(z.countries) ? z.countries : []) {
      if (c && c.code) covered.add(String(c.code).toUpperCase());
    }
  }
  return wanted.filter((c) => !covered.has(String(c).toUpperCase()));
}

// ── shared helpers ─────────────────────────────────────────────────────────

const SHOPIFY_MESSAGES = {
  shopify_not_configured: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Shopify is temporarily unavailable — try again.',
};
const WHOP_MESSAGES = {
  whop_not_configured: 'Whop is not configured for this funnel — add the API key and company ID in Payments first.',
  whop_auth_error: 'Whop rejected our credentials — the API key is missing, expired or revoked. This needs operator attention; retrying will not help.',
  whop_invalid_name: 'That product has no name, so it cannot be created in Whop.',
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

async function limited(req, res, key, max, windowSec) {
  // Fail-OPEN on a limiter outage: a Redis blip must not take Settings down.
  // The upstream's own budget is the real backstop.
  const rl = await checkRateLimit(`${key}:${req.user?.id || req.ip}`, max, windowSec)
    .catch(() => ({ allowed: true }));
  if (rl.allowed) return false;
  res.status(429).json({
    success: false,
    error: { code: 'rate_limited', message: 'Too many requests — wait a moment and try again', retry_after: rl.retryAfter },
  });
  return true;
}

const funnelIdOf = (req) => String(req.params.funnelId || '').trim();

async function loadFunnel(funnelId) {
  const rows = await pgQuery(`SELECT id, settings FROM funnels WHERE id = $1`, [funnelId]);
  return rows.length ? rows[0] : null;
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

// POST /:funnelId/products/sync -> 200 { data: { synced, removed, products } }
// Walks the Shopify catalog and REPLACES this funnel's snapshot. Products that
// vanished from Shopify are deleted here too — a catalog readout that keeps
// showing a deleted product is worse than an empty one.
export async function syncProductsHandler(req, res) {
  if (await limited(req, res, 'funnel-commerce-sync', SYNC_RATE_MAX, SYNC_RATE_WINDOW_SEC)) return undefined;
  const funnelId = funnelIdOf(req);
  try {
    await ensureCommerceTables();

    const seen = [];
    let after = null;
    for (let page = 0; page < PRODUCT_MAX_PAGES; page += 1) {
      const data = await postGraphql(PRODUCTS_QUERY, { first: PRODUCT_PAGE_SIZE, after });
      const conn = data?.products || {};
      seen.push(...mapProductNodes(conn.edges));
      const info = conn.pageInfo || {};
      if (!info.hasNextPage || !info.endCursor) break;
      after = info.endCursor;
    }

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

    // Prune what Shopify no longer has. An EMPTY sync result is only reachable
    // through a 200 with zero edges (an outage threw above), so this cannot
    // wipe the snapshot on a blip.
    const keep = seen.map((p) => p.shopify_product_id);
    const removed = await pgQuery(
      `DELETE FROM co_funnel_products
        WHERE funnel_id = $1 AND NOT (shopify_product_id = ANY($2::text[]))
        RETURNING shopify_product_id`,
      [funnelId, keep]
    );

    const products = await readProducts(funnelId);
    return res.json({
      success: true,
      data: { synced: seen.length, removed: removed.length, products },
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
export async function mapToWhopHandler(req, res) {
  if (await limited(req, res, 'funnel-commerce-whopmap', MAP_RATE_MAX, MAP_RATE_WINDOW_SEC)) return undefined;
  const funnelId = funnelIdOf(req);
  try {
    await ensureCommerceTables();
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

    const plan = planWhopMapping(products, existing, catalog);
    const written = [];
    const failed = [];

    for (const { product, whop } of plan.match) {
      written.push(await upsertMapping(funnelId, {
        shopify_product_id: product.shopify_product_id,
        shopify_title: product.title,
        shopify_price: product.price,
        whop_product_id: whop.id,
        whop_product_name: whop.name,
        source: 'matched',
      }));
    }

    for (const product of plan.create) {
      try {
        const made = await createWhopProduct(creds, { name: product.title, mode: 'live' });
        written.push(await upsertMapping(funnelId, {
          shopify_product_id: product.shopify_product_id,
          shopify_title: product.title,
          shopify_price: product.price,
          whop_product_id: made.id,
          whop_product_name: made.name,
          source: 'created',
        }));
      } catch (err) {
        // ONE product failing must not abandon the rest, but it must be
        // REPORTED — a partial run that claims success is how an operator
        // ships a funnel with an unmapped product.
        if (!(err instanceof WhopUnavailableError)) throw err;
        failed.push({ shopify_product_id: product.shopify_product_id, title: product.title, code: err.code });
        // A dead key or a hard outage will fail identically for every
        // remaining product — stop hammering Whop.
        if (err.code !== 'whop_invalid_name') break;
      }
    }

    const mappings = await readMappings(funnelId);
    return res.json({
      success: true,
      data: {
        matched: plan.match.length,
        created: written.length - plan.match.length,
        already: plan.already.length,
        skipped: plan.skipped.length,
        failed,
        mappings,
        mapped_count: mappings.filter((m) => m.status === 'mapped').length,
      },
    });
  } catch (err) {
    const sent = sendUpstreamError(res, err, 'whop map');
    if (sent) return sent;
    console.error('[funnelCommerce] whop map failed:', err.message);
    return res.status(500).json({ success: false, error: { code: 'map_failed', message: 'Whop mapping failed' } });
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

// GET /:funnelId/shipping/zones -> 200 { data: { zones, allowed_countries, uncovered_countries } }
// READ-ONLY. An outage answers 503 — never {zones:[]}, which would read as
// "you have configured no shipping anywhere" and send an operator to fix a
// setting that is not broken.
export async function shippingZonesHandler(req, res) {
  if (await limited(req, res, 'funnel-commerce-zones', ZONES_RATE_MAX, ZONES_RATE_WINDOW_SEC)) return undefined;
  const funnelId = funnelIdOf(req);
  try {
    const payloads = [];
    let zonesAfter = null;
    for (let page = 0; page < ZONE_MAX_PAGES; page += 1) {
      const data = await postGraphql(ZONES_QUERY, { zonesAfter });
      payloads.push(data);
      // Zones are a paged connection — walk every page or the overview
      // silently hides countries.
      let cursor = null;
      for (const prof of data?.deliveryProfiles?.nodes || []) {
        for (const grp of prof?.profileLocationGroups || []) {
          const info = grp?.locationGroupZones?.pageInfo || {};
          if (info.hasNextPage && info.endCursor) cursor = info.endCursor;
        }
      }
      if (!cursor) break;
      zonesAfter = cursor;
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
        allowed_countries: allowed,
        uncovered_countries: uncoveredCountries(zones, allowed),
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
